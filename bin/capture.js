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
// RecordedAction: {seq, action_type:'click'|'input'|'select'|'key'|'navigate'|'dom_settle',
//   url_at_capture, primary:{by,value,name?}|null, candidates:[{by,value,name?,count}],
//   input_value(masked->null), masked?, insufficient?, is_navigation_boundary, from?}
// A 'dom_settle' marker is emitted after a click that swapped a large DOM subtree WITHOUT changing
// the URL (a pure client-side SPA route) — build-flow turns it into an explicit settle wait.
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
  // looksAutoName: the STRUCTURAL subset of looksAuto for human-readable NAMES (aria-labels). It keeps
  // the explicit dynamic-id patterns + the multi-number heuristic but DROPS the Shannon-entropy check,
  // which is tuned for opaque ids and false-positives on legitimate multi-word / camelCase labels
  // (e.g. "Toggle navigation menu"). A truly-dynamic label that slips past here at worst flakes red at
  // replay (the --exact name won't match) — never a false-green — so erring readable here is correct.
  function looksAutoName(v) {
    if (!v) return false;
    var token = v.replace(/\s+/g, '');
    for (var i = 0; i < AUTOPAT.length; i++) if (AUTOPAT[i].test(token)) return true;
    if ((token.match(/\d{3,}/g) || []).length >= 2) return true;
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
  // C1: a locator whose value/name exceeds 80 chars is KEPT in the candidate ladder (so a
  // needs_review step always offers a reviewable option — the engine empirically matches long
  // exact text) but is BARRED from auto-primary selection in emit() below: long exact text/labels
  // are too fragile to promote unattended, so such a step stays needs_review for a human or
  // verify-repair to accept. (Previously pushCand dropped them entirely, leaving an empty ladder.)
  function overLong(c) { return ((c.value || '').length > 80) || (!!c.name && c.name.length > 80); }
  function pushCand(list, by, value, name) {
    value = normalize(value);
    if (!value) return;
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
    // P2 role+name (long names stay in the ladder for review; overLong() bars them from auto-primary)
    var role = roleOf(el), name = accName(el);
    if (role && name) list.push({ by: 'role', value: role, name: name });
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

  // --- engine-reliability gate for a role+name PRIMARY (agent-browser 0.27.0) ---
  // `find role <r> --name <n>` resolution is element-shape specific (probe-verified): it reliably
  // matches an aria-label BUTTON (a native <button> or an explicit role="button"), but NOT a native
  // <a>/<input>/<heading> (implicit role), and NOT a name sourced from aria-labelledby. So ONLY an
  // aria-label button may become a role PRIMARY; every other role+name stays a needs_review candidate
  // rather than a primary that would silently fail replay. (Native <input type=button> / <summary> map
  // to role button via roleOf() but are unverified, so they are conservatively excluded here.)
  function roleAriaLabelButton(el, c) {
    if (c.by !== 'role' || c.value !== 'button' || !c.name) return false;
    if (looksAutoName(c.name)) return false;   // a structurally auto-generated / dynamic aria-label is fragile -> needs_review
    var explicit = (attr(el, 'role').split(/\s+/)[0] === 'button');
    if (el.tagName !== 'BUTTON' && !explicit) return false;
    if (attr(el, 'aria-labelledby')) return false;
    return normalize(attr(el, 'aria-label')) === c.name;
  }

  // --- build + push a locator-bearing record ---
  function emit(action_type, el, extra) {
    try {
      var cands = candidatesFor(el);
      for (var i = 0; i < cands.length; i++) { var r = countCandidate(cands[i], el); cands[i].count = r.count; cands[i]._count = r.count; cands[i]._hit = r.matchesTarget; }
      cands.sort(function (a, b) { return score(b) - score(a); });
      var primary = null;
      // Primary = the first capture-time-UNIQUE (count==1), on-target, non-overLong candidate whose
      // locator the engine RESOLVES at replay. C1: overLong (>80c) text/name is too fragile to auto-
      // accept (stays a needs_review candidate). A `role` candidate is engine-reliable ONLY as an
      // aria-label button (roleAriaLabelButton); any other role+name is skipped here so it never
      // becomes a primary that would silently fail replay.
      for (var j = 0; j < cands.length; j++) {
        var c = cands[j];
        if (c._count === 1 && c._hit && !overLong(c)) {
          if (c.by === 'role' && !roleAriaLabelButton(el, c)) continue;
          primary = { by: c.by, value: c.value }; if (c.name) primary.name = c.name; break;
        }
      }
      var top = cands.slice(0, Math.max(2, 0)).map(function (c) { var o = { by: c.by, value: c.value, count: c.count }; if (c.name) o.name = c.name; return o; });
      var rec = { action_type: action_type, primary: primary, candidates: top, is_navigation_boundary: false };
      // needs_review (insufficient) keeps the conservative "<2 candidates" backstop, with ONE exception:
      // a lone aria-label-BUTTON role+name primary is engine-resolvable (compiled with --exact), unique,
      // and non-auto (roleAriaLabelButton gate), so it is sufficient by itself. Every OTHER single-
      // candidate step still goes needs_review so a fragile lone guess is never auto-promoted. A
      // primary-less step is needs_review via build-flow's `!p`; the ladder (top) stays non-empty (C1).
      if (!primary || ((top.length < 2) && primary.by !== 'role')) rec.insufficient = true;
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
    // contenteditable has no .value, but the typed text lives in textContent. Without this it is
    // captured as null -> build-flow treats null like a masked field and emits a {{input_N}} fill that
    // silently no-ops at replay (false-green). `find <loc> fill <text>` is probe-verified to work on a
    // contenteditable, so capture it faithfully (the value still goes to the gitignored values sidecar).
    // normalize() (NFC + collapse whitespace + trim) — same contract as select_text/labels: textContent
    // concatenates block markup with NO separators (<p>A</p><p>B</p> -> "AB") and carries structural
    // indentation, so raw capture would replay a string the user never typed. Normalized capture is
    // therefore single-line plain text (a documented limitation for rich/multi-line contenteditable).
    try { if (el.isContentEditable) return normalize(String(el.textContent == null ? '' : el.textContent)).slice(0, 200); } catch (e) {}
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
    if (checkableType(el)) return;             // checkbox/radio fire input+change on toggle, but they are
                                               // captured as `check` by the click handler — never as a fill
    if (el !== pendEl) commitPend();            // focus moved -> commit previous
    pendEl = el; pendVal = valueOf(el);
  }, true);
  document.addEventListener('compositionend', function (e) {
    var el = realTarget(e); pendEl = el; pendVal = valueOf(el);
  }, true);
  document.addEventListener('change', function (e) {
    var el = realTarget(e), tag = (el.tagName || '').toUpperCase();
    if (tag === 'SELECT') {
      commitPend();
      var m = sensitive(el);
      var x = { input_value: m ? null : valueOf(el), select_text: m ? null : normalize(el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''), masked: m || undefined };
      // <select multiple>: el.value / el.selectedIndex expose only the FIRST selected option, so a
      // single-value `select` step would silently drop the rest at replay (a false-green — only
      // option#1 is reached). Flag needs_review so a human resolves the multi-selection explicitly;
      // the single-value capture path cannot faithfully represent it.
      if (el.multiple) x.insufficient = true;
      emit('select', el, x);
    }
    else if (el === pendEl) commitPend();
  }, true);
  document.addEventListener('focusout', function () { commitPend(); }, true);

  // --- pure DOM-swap detector (C2): SPA routers that swap the view WITHOUT changing the URL emit
  // no nav gate, so replay would race the next locator. A MutationObserver accumulates the size of
  // added/removed element subtrees; after each click, once the settle window elapses, if the URL
  // did NOT change yet a significant swap occurred, we record a 'dom_settle' marker. URL-changing
  // navs (pushState/hash/full-doc) are already gated by navMark and skipped here (href changed).
  // Best-effort: a missed detection just falls back to the next locator's implicit wait. ---
  var DOM_SWAP_MIN = 12;          // accumulated added+removed element count that counts as a swap
  var DOM_SWAP_SETTLE_MS = 350;   // window after a click in which the swap must register
  var mutAcc = 0, mutConsumed = 0;  // mutConsumed = high-water mark already attributed to a dom_settle
  function subtreeCount(node) {
    if (!node || node.nodeType !== 1) return 0;
    try { return 1 + node.querySelectorAll('*').length; } catch (e) { return 1; }
  }
  try {
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var m = recs[i], j;
        for (j = 0; j < m.addedNodes.length; j++) mutAcc += subtreeCount(m.addedNodes[j]);
        for (j = 0; j < m.removedNodes.length; j++) mutAcc += subtreeCount(m.removedNodes[j]);
      }
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) {}
  function armDomSwap() {
    var urlBefore = location.href, mutBefore = mutAcc;
    setTimeout(function () {
      if (location.href !== urlBefore) return;          // a real navigation already emitted a gate
      // Count only mutation NOT already attributed to an earlier dom_settle: when several clicks
      // land inside one settle window over a single swap, this records the marker exactly once
      // (no duplicates) while still never missing a genuinely fresh swap.
      var base = mutBefore > mutConsumed ? mutBefore : mutConsumed;
      if ((mutAcc - base) < DOM_SWAP_MIN) return;       // no fresh significant swap -> rely on implicit wait
      mutConsumed = mutAcc;
      record({ action_type: 'dom_settle', primary: null, candidates: [], is_navigation_boundary: false });
    }, DOM_SWAP_SETTLE_MS);
  }

  // --- explicit PAGE scroll (coalesced; #2) ---
  // Only window.scrollY/X (page scroll) is tracked, so a scrollable CONTAINER's scroll never changes
  // it and is inherently ignored (containers need a selector = out of scope). A gesture is debounced
  // into ONE record: on settle, the net delta from the last committed position becomes a `scroll`
  // action (dominant axis, |Δ| >= SCROLL_MIN). commitScroll() flushes any pending INPUT first so the
  // buffer seq matches the journey, and it is called before every recorded click/key/nav so a
  // scroll-then-action never reorders. Replay re-issues `scroll <dir> <px>` BY the delta (composes).
  var SCROLL_SETTLE_MS = 250, SCROLL_MIN = 80;
  var scrollTimer = null, scrollBaseY = 0, scrollBaseX = 0, scrollPending = false;
  function _scrollY() { try { return Math.round(window.scrollY || window.pageYOffset || 0); } catch (e) { return 0; } }
  function _scrollX() { try { return Math.round(window.scrollX || window.pageXOffset || 0); } catch (e) { return 0; } }
  scrollBaseY = _scrollY(); scrollBaseX = _scrollX();
  function commitScroll() {
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    if (!scrollPending) return;
    scrollPending = false;
    commitPend();                              // commit any pending input BEFORE the scroll (seq order)
    var y = _scrollY(), x = _scrollX(), dy = y - scrollBaseY, dx = x - scrollBaseX;
    scrollBaseY = y; scrollBaseX = x;
    var ay = Math.abs(dy), ax = Math.abs(dx);
    if (Math.max(ay, ax) < SCROLL_MIN) return;  // jitter / trivial scroll -> drop
    var dir, px;
    if (ay >= ax) { dir = dy > 0 ? 'down' : 'up'; px = ay; } else { dir = dx > 0 ? 'right' : 'left'; px = ax; }
    record({ action_type: 'scroll', dir: dir, px: px, primary: null, candidates: [], is_navigation_boundary: false });
  }
  window.addEventListener('scroll', function () {
    scrollPending = true;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(commitScroll, SCROLL_SETTLE_MS);
  });
  // flushAll: commit a pending INPUT and then a pending scroll, in that order. Bound to the Enter key
  // and to teardown so a typed value is NEVER lost when the form submits / the context dies with no
  // intervening focusout/change (commitScroll alone early-returns past its commitPend when no scroll
  // is pending — that was a regression vs the prior unconditional commitPend teardown).
  function flushAll() { commitPend(); commitScroll(); }
  // resetScrollBase: re-anchor the scroll delta to the CURRENT page offset at a navigation boundary.
  // The init-script does NOT re-run on SPA nav, so without this a stale pre-nav base would make the
  // first post-nav scroll record a wrong direction/magnitude (a route change often resets scroll).
  function resetScrollBase() { scrollBaseY = _scrollY(); scrollBaseX = _scrollX(); scrollPending = false; if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; } }

  // checkableType: native <input type=checkbox|radio> only (el.checked is reliable; a custom
  // role=checkbox/switch div uses aria-checked and the engine's check/uncheck don't apply to it, so it
  // stays a plain click). Used to record an ABSOLUTE check instead of a toggling click.
  function checkableType(el) {
    if (!el || el.tagName !== 'INPUT') return '';
    var t = (attr(el, 'type') || '').toLowerCase();
    return (t === 'checkbox' || t === 'radio') ? t : '';
  }

  // --- clicks (commit pending input first; label dedup; interactive ancestor) ---
  var lastLabelControl = null, lastLabelAt = 0;
  document.addEventListener('click', function (e) {
    var raw = realTarget(e);
    if (pendEl && pendEl !== raw) commitPend();
    var el = controlForLabel(interactiveAncestor(raw));
    var now = Date.now();
    if (lastLabelControl === el && (now - lastLabelAt) < 700) { lastLabelAt = now; return; } // suppress label->control dup
    if (raw.tagName === 'LABEL' || (raw.closest && raw.closest('label'))) { lastLabelControl = el; lastLabelAt = now; }
    commitScroll();   // flush a pending scroll BEFORE this click so the buffer order matches the journey
    // checkbox/radio: a bare click TOGGLES, so a differing initial state at replay silently lands the
    // WRONG final state (false-green). Record the absolute desired post-state and emit `check`, which
    // replay sets absolutely. el is read at the RECORDED click — for a label/ancestor click (raw!==el)
    // the control toggles AFTER this handler, so el.checked is still PRE-toggle and must be flipped
    // (probe-verified); a radio always ends checked. UNCHECK stays a `click`: agent-browser 0.27.0
    // `uncheck` is broken (probe: success=false), so an absolute uncheck is unavailable — a click is the
    // documented best-effort residual (works when the page's initial state matches capture).
    var cbType = checkableType(el);
    var cbChecked = cbType && ((cbType === 'radio') || ((raw === el) ? el.checked : !el.checked));
    emit(cbChecked ? 'check' : 'click', el);
    armDomSwap();   // C2: watch for a no-URL-change DOM swap caused by this click
  }, true);

  // --- Enter key ---
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var el = realTarget(e); flushAll(); emit('key', el, { input_value: 'Enter' }); }
  }, true);

  // --- navigation: A(durable, via record) + B(history) + C(prevUrl sentinel) + D(teardown) ---
  function navMark(from) { commitScroll(); resetScrollBase(); record({ action_type: 'navigate', from: from, primary: null, candidates: [], is_navigation_boundary: true }); }
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
  // D: flush pending input + scroll before the context dies. MUST be flushAll (commitPend THEN
  // commitScroll): commitScroll alone early-returns past its commitPend when no scroll is pending,
  // which would drop a typed-but-uncommitted value at teardown (type-then-Enter-submit).
  window.addEventListener('pagehide', flushAll, true);
  window.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushAll(); }, true);
  window.addEventListener('beforeunload', flushAll, true);
})();
