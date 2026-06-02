// Phase 0 PoC capture listener — proves an init-script-injected DOM listener
// (a) captures a real (CDP) click and (b) survives a same-origin navigation via
// sessionStorage. Buffer key __agentqa_cap holds an ordered JSON array of events.
(function () {
  if (window.__agentqa_installed) return;
  window.__agentqa_installed = true;
  function load() {
    try { return JSON.parse(sessionStorage.getItem('__agentqa_cap') || '[]'); }
    catch (e) { return []; }
  }
  function save(a) {
    try { sessionStorage.setItem('__agentqa_cap', JSON.stringify(a)); } catch (e) {}
  }
  function rec(type, t) {
    var a = load();
    a.push({
      type: type,
      tag: (t && t.tagName) || '',
      id: (t && t.id) || '',
      text: ((t && t.textContent) || '').trim().slice(0, 40),
      url: location.href,
    });
    save(a);
    window.__agentqa_cap = a;
  }
  document.addEventListener('click', function (e) { rec('click', e.target); }, true);
})();
