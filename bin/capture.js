// bin/capture.js — injected via `agent-browser --init-script <abs-path>` into the page
// being recorded (NOT runtime `addinitscript` — absent from the 0.27.0 binary). Init
// scripts re-run on every document, so this is idempotent and keeps its buffer in
// sessionStorage to survive the window reset on same-origin navigation (proven by the
// Phase 0 PoC). Locator HARDENING + uniqueness happen in-page here, because agent-browser
// `get count` is CSS-only and cannot count the semantic locators replay `find` uses.
//
// Buffer (sessionStorage, synchronous write-through = durability):
//   __aqa_buf = ordered JSON array of RecordedAction; __aqa_seq = monotonic counter;
//   __aqa_prevurl = last-seen href sentinel (full-doc nav detector).
// RecordedAction: {seq, action_type:'click'|'input'|'select'|'key'|'navigate',
//   url_at_capture, primary:{by,value,name?}|null, candidates:[{by,value,name?,count}],
//   input_value(masked->null), masked?, insufficient?, is_navigation_boundary, from?}
// Security: sensitive fields (password/OTP/card/...) are masked AT CAPTURE — the secret
// is never written to the buffer. The host applies the same mask again (2nd gate).
(function () {
  if (window.__aqaInstalled) return;
  window.__aqaInstalled = true;

  var BUF = '__aqa_buf', SEQ = '__aqa_seq', PREV = '__aqa_prevurl';
  var ss = window.sessionStorage;
  function load() { try { return JSON.parse(ss.getItem(BUF) || '[]'); } catch (e) { return []; } }
  function save(a) { try { ss.setItem(BUF, JSON.stringify(a)); } catch (e) { /* quota: host seq-advance health-check fails loud */ } }
  function nextSeq() { var n = (parseInt(ss.getItem(SEQ) || '0', 10) || 0) + 1; try { ss.setItem(SEQ, String(n)); } catch (e) {} return n; }
  function record(ev) {
    try {
      var a = load();
      ev.seq = nextSeq();
      ev.url_at_capture = location.href;
      a.push(ev); save(a); window.__aqa_buf = a;
    } catch (e) {}
  }

  // --- normalization (shared contract: host must normalize identically) ---
  function normalize(s) {
    if (s == null) return '';
    try { s = String(s).normalize('NFC'); } catch (e) { s = String(s); }
    return s.replace(/\s+/g, ' ').trim();
  }
  function attr(el, n) { try { return el.getAttribute(n) || ''; } catch (e) { return ''; } }
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (e) { return true; }
  }

  // --- deep DOM walk that pierces OPEN shadow roots (closed roots are unreachable) ---
  function walkAll(fn, root) {
    root = root || document;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      fn(els[i]);
      if (els[i].shadowRoot) walkAll(fn, els[i].shadowRoot);
    }
  }

  // --- implicit ARIA role (subset, interactive-focused) ---
  function roleOf(el) {
    var explicit = attr(el, 'role');
    if (explicit) return explicit.split(/\s+/)[0];
    var tag = (el.tagName || '').toLowerCase();
    var type = (attr(el, 'type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  }
  var NAME_FROM_CONTENTS = { button: 1, link: 1, heading: 1, checkbox: 1, radio: 1, option: 1, menuitem: 1, tab: 1, summary: 1 };

  // --- accessible name: trimmed subset of accname-1.2 (open risk: divergence from replay) ---
  function labelText(el) {
    var t = '';
    if (el.id) {
      try {
        var ls = document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]');
        for (var i = 0; i < ls.length; i++) t += ' ' + ls[i].textContent;
      } catch (e) {}
    }
    try { var wrap = el.closest && el.closest('label'); if (wrap) t += ' ' + wrap.textContent; } catch (e) {}
    return normalize(t);
  }
  function accName(el) {
    var lb = attr(el, 'aria-labelledby');
    if (lb) {
      var s = '';
      lb.split(/\s+/).forEach(function (id) { var n = document.getElementById(id); if (n) s += ' ' + n.textContent; });
      if (normalize(s)) return normalize(s);
    }
    var al = attr(el, 'aria-label'); if (normalize(al)) return normalize(al);
    var lt = labelText(el); if (lt) return lt;
    var role = roleOf(el);
    if (NAME_FROM_CONTENTS[role]) { var tc = normalize(el.textContent); if (tc) return tc; }
    var alt = attr(el, 'alt'); if (normalize(alt)) return normalize(alt);
    var ti = attr(el, 'title'); if (normalize(ti)) return normalize(ti);
    var ph = attr(el, 'placeholder'); if (normalize(ph)) return normalize(ph);
    return '';
  }

  // --- dynamic-id / entropy rejection (only ever drops/demotes) ---
  function shannon(s) {
    if (!s) return 0; var m = {}, n = s.length;
    for (var i = 0; i < n; i++) m[s[i]] = (m[s[i]] || 0) + 1;
    var h = 0; for (var k in m) { var p = m[k] / n; h -= p * Math.log(p) / Math.LN2; }
    return h;
  }
  var AUTOPAT = [
    /^\d{4,}$/, /^[0-9a-f-]{16,}$/i, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    /:r[0-9a-z]+:/i, /^radix-/, /^mui-/, /^ember/, /^headlessui-/, /^ng-/, /ext-gen/, /^cdk-/, /^yui_/,
    /^[A-Za-z]+_[A-Za-z0-9]{5,}$/
  ];
  function looksAuto(v) {
    if (!v) return false;
    var token = v.replace(/\s+/g, '');
    for (var i = 0; i < AUTOPAT.length; i++) if (AUTOPAT[i].test(token)) return true;
    if ((token.match(/\d{3,}/g) || []).length >= 2) return true;
    if (token.length >= 8 && shannon(token) > 3.2) return true;
    return false;
  }

  // --- in-page uniqueness count, mirroring how replay `find` matches ---
  function countCandidate(c, target) {
    var n = 0, hit = false;
    function tally(el) {
      if (!isVisible(el)) return;
      var ok = false;
      if (c.by === 'testid') ok = (attr(el, 'data-testid') === c.value || attr(el, 'data-test-id') === c.value || attr(el, 'data-test') === c.value || attr(el, 'data-cy') === c.value);
      else if (c.by === 'role') ok = (roleOf(el) === c.value && accName(el) === c.name);
      else if (c.by === 'label') ok = (!!el.matches && el.matches('input,select,textarea,button,[contenteditable]') && labelText(el) === c.value); // controls only — `find label` resolves to the CONTROL, not the <label> element (which also has labelText)
      else if (c.by === 'text') {
        // Collapse nested same-text chains to the OUTERMOST element (e.g. <button><i>Login</i></button>
        // is ONE match on the button, not two) so the in-page count matches how agent-browser
        // `find text` resolves a single element — otherwise the button falls back to the broken role locator.
        var tx = normalize(el.textContent);
        var pp = el.parentElement;
        var ancestorSame = !!(pp && normalize(pp.textContent) === c.value);
        ok = (tx === c.value) && !ancestorSame && (!!NAME_FROM_CONTENTS[roleOf(el)] || el.children.length === 0);
      }
      else if (c.by === 'placeholder') ok = (attr(el, 'placeholder') === c.value);
      else if (c.by === 'alt') ok = (attr(el, 'alt') === c.value);
      else if (c.by === 'title') ok = (attr(el, 'title') === c.value);
      if (ok) { n++; if (el === target) hit = true; }
    }
    try { walkAll(tally); } catch (e) {}
    return { count: n, matchesTarget: hit };
  }

  // --- candidate ladder (schema by-values only; never css/xpath/@eN) ---
  // Weights are ordered by what agent-browser 0.27.0 `find` ACTUALLY resolves, not by
  // theoretical stability: empirically `find role --name` does NOT match elements on this
  // version (verified on heading+link, even with the exact accessible name from snapshot),
  // while `find text|label|placeholder|testid` work. So role is demoted to a low-priority
  // candidate (kept for human needs_review use), and the engine-supported locators lead.
  // (Robust v2: a verify-repair replay probing each candidate via `find ... hover --json`.)
  var WKIND = { testid: 50, text: 40, label: 38, placeholder: 32, role: 24, alt: 18, title: 12 };
  function pushCand(list, by, value, name) {
    value = normalize(value);
    if (!value) return;
    if (value.length > 80) return;
    for (var i = 0; i < list.length; i++) if (list[i].by === by && list[i].value === value && list[i].name === name) return;
    list.push({ by: by, value: value, name: name });
  }
  function candidatesFor(el) {
    var list = [];
    // P1 testid on element, then ancestors (stop at first testid up to 5 hops)
    var n = el, hops = 0;
    while (n && n.nodeType === 1 && hops <= 5) {
      var tid = attr(n, 'data-testid') || attr(n, 'data-test-id') || attr(n, 'data-test') || attr(n, 'data-cy');
      if (tid) { pushCand(list, 'testid', tid); break; }
      n = n.parentNode; hops++;
    }
    // P2 role+name
    var role = roleOf(el), name = accName(el);
    if (role && name) { var c = { by: 'role', value: role, name: name }; if (!c.value || normalize(name).length > 80) {} else list.push(c); }
    // P3 label (form controls)
    var lt = labelText(el); if (lt) pushCand(list, 'label', lt);
    // P4 exact visible text (name-from-contents)
    if (NAME_FROM_CONTENTS[role]) pushCand(list, 'text', el.textContent);
    // P5 placeholder, P-alt, P6 title
    pushCand(list, 'placeholder', attr(el, 'placeholder'));
    pushCand(list, 'alt', attr(el, 'alt'));
    pushCand(list, 'title', attr(el, 'title'));
    // role-only fallback (low) to help reach >=2 candidates
    if (role && !name) list.push({ by: 'role', value: role });
    return list;
  }
  function score(c) {
    var s = (WKIND[c.by] || 0);
    if (c.by === 'role' && !c.name) s = 8;
    if (looksAuto(c.value) || (c.name && looksAuto(c.name))) s -= 40;
    var L = (c.value || '').length;
    s += (L >= 2 && L <= 40) ? 6 : (L <= 80 ? 0 : -12);
    if (c._count === 1) s += 30;
    else if (c._count > 1) s -= 8 * (Math.log(c._count) / Math.LN2);
    else s -= 1000;
    return s;
  }

  // --- resolve the element the user meant ---
  function realTarget(e) {
    var path = (e.composedPath && e.composedPath()) || [];
    return path[0] || e.target;
  }
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role],[tabindex],[onclick],[contenteditable]';
  function interactiveAncestor(el) {
    var n = el, hops = 0;
    while (n && n.nodeType === 1 && hops <= 4) { if (n.matches && n.matches(INTERACTIVE)) return n; n = n.parentNode; hops++; }
    return el;
  }
  function controlForLabel(el) {
    if (el.tagName === 'LABEL') {
      if (el.control) return el.control;
      var f = el.getAttribute('for'); if (f) { var c = document.getElementById(f); if (c) return c; }
    }
    return el;
  }

  // --- build + push a locator-bearing record ---
  function emit(action_type, el, extra) {
    try {
      var cands = candidatesFor(el);
      for (var i = 0; i < cands.length; i++) { var r = countCandidate(cands[i], el); cands[i].count = r.count; cands[i]._count = r.count; cands[i]._hit = r.matchesTarget; }
      cands.sort(function (a, b) { return score(b) - score(a); });
      var primary = null;
      for (var j = 0; j < cands.length; j++) { if (cands[j]._count === 1 && cands[j]._hit) { primary = { by: cands[j].by, value: cands[j].value }; if (cands[j].name) primary.name = cands[j].name; break; } }
      var top = cands.slice(0, Math.max(2, 0)).map(function (c) { var o = { by: c.by, value: c.value, count: c.count }; if (c.name) o.name = c.name; return o; });
      var insufficient = top.length < 2;
      var rec = { action_type: action_type, primary: primary, candidates: top, is_navigation_boundary: false };
      if (insufficient) rec.insufficient = true;
      if (extra) for (var k in extra) rec[k] = extra[k];
      record(rec);
    } catch (e) {}
  }

  // --- sensitive masking AT CAPTURE ---
  function sensitive(el) {
    var type = (attr(el, 'type') || '').toLowerCase();
    if (type === 'password') return true;
    var ac = (attr(el, 'autocomplete') || '').toLowerCase();
    if (/^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)$/.test(ac)) return true;
    var im = (attr(el, 'inputmode') || '').toLowerCase();
    var hint = (attr(el, 'name') + ' ' + el.id + ' ' + attr(el, 'aria-label')).toLowerCase();
    if ((im === 'numeric' || type === 'tel' || type === 'number') && /otp|cvv|cvc|ssn|card|account|routing|pin|secret|token|one-time/.test(hint)) return true;
    return false;
  }
  function valueOf(el) {
    if (sensitive(el)) return null;
    try { if ('value' in el) return String(el.value).slice(0, 200); } catch (e) {}
    return null;
  }

  // --- input coalescing (one fill per field; IME-safe) ---
  var pendEl = null, pendVal = null;
  function commitPend() {
    if (pendEl == null) return;
    var el = pendEl, val = pendVal; pendEl = null; pendVal = null;
    var masked = sensitive(el);
    emit('input', el, { input_value: masked ? null : val, masked: masked || undefined });
  }
  document.addEventListener('input', function (e) {
    if (e.isComposing) return;                 // ignore mid-IME composition
    var el = realTarget(e);
    if (el !== pendEl) commitPend();            // focus moved -> commit previous
    pendEl = el; pendVal = valueOf(el);
  }, true);
  document.addEventListener('compositionend', function (e) {
    var el = realTarget(e); pendEl = el; pendVal = valueOf(el);
  }, true);
  document.addEventListener('change', function (e) {
    var el = realTarget(e), tag = (el.tagName || '').toUpperCase();
    if (tag === 'SELECT') { commitPend(); var m = sensitive(el); emit('select', el, { input_value: m ? null : valueOf(el), select_text: m ? null : normalize(el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''), masked: m || undefined }); }
    else if (el === pendEl) commitPend();
  }, true);
  document.addEventListener('focusout', function () { commitPend(); }, true);

  // --- clicks (commit pending input first; label dedup; interactive ancestor) ---
  var lastLabelControl = null, lastLabelAt = 0;
  document.addEventListener('click', function (e) {
    var raw = realTarget(e);
    if (pendEl && pendEl !== raw) commitPend();
    var el = controlForLabel(interactiveAncestor(raw));
    var now = Date.now();
    if (lastLabelControl === el && (now - lastLabelAt) < 700) { lastLabelAt = now; return; } // suppress label->control dup
    if (raw.tagName === 'LABEL' || (raw.closest && raw.closest('label'))) { lastLabelControl = el; lastLabelAt = now; }
    emit('click', el);
  }, true);

  // --- Enter key ---
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var el = realTarget(e); emit('key', el, { input_value: 'Enter' }); }
  }, true);

  // --- navigation: A(durable, via record) + B(history) + C(prevUrl sentinel) + D(teardown) ---
  function navMark(from) { record({ action_type: 'navigate', from: from, primary: null, candidates: [], is_navigation_boundary: true }); }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (orig && !orig.__aqa) {
      var wrapped = function () { var from = location.href; var r = orig.apply(this, arguments); if (location.href !== from) navMark(from); return r; };
      wrapped.__aqa = true; history[m] = wrapped;
    }
  });
  window.addEventListener('popstate', function () { navMark(location.href); });
  window.addEventListener('hashchange', function () { navMark(location.href); });
  // C: full-doc nav — this script re-ran on a new document at a different URL
  (function () {
    var prev = ''; try { prev = ss.getItem(PREV) || ''; } catch (e) {}
    if (prev && prev !== location.href) navMark(prev);
    try { ss.setItem(PREV, location.href); } catch (e) {}
  })();
  // D: flush pending input before the context dies
  window.addEventListener('pagehide', commitPend, true);
  window.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') commitPend(); }, true);
  window.addEventListener('beforeunload', commitPend, true);
})();
