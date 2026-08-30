(function exposePhimorAppShell(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhimorAppShell = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAppShellRuntime() {
  'use strict';

  function normalizeDestinations(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
  }

  function resolveDestination(value, { destinations = [], aliases = {}, fallback } = {}) {
    const allowed = normalizeDestinations(destinations);
    const requested = String(value || '').trim();
    const resolved = aliases[requested] || requested;
    return allowed.includes(resolved) ? resolved : (allowed.includes(fallback) ? fallback : allowed[0]);
  }

  function createDestinationRouter({
    doc, destinations, initial, aliases = {}, queryKey = 'section', onNavigate = async () => {},
  } = {}) {
    if (!doc) throw new TypeError('doc is required');
    const allowed = normalizeDestinations(destinations);
    if (!allowed.length) throw new TypeError('destinations are required');
    const buttons = Array.from(doc.querySelectorAll('[data-shell-destination]'));
    const panels = Array.from(doc.querySelectorAll('[data-shell-panel]'));
    let current = null;
    let navigationRevision = 0;
    let destroyed = false;

    const fromLocation = () => {
      try { return new URL(doc.defaultView.location.href).searchParams.get(queryKey); } catch (_) { return null; }
    };

    function updateUrl(destination, mode) {
      const view = doc.defaultView;
      if (!view?.history || mode === 'none') return;
      const url = new URL(view.location.href);
      url.searchParams.set(queryKey, destination);
      view.history[mode === 'replace' ? 'replaceState' : 'pushState']({ phimorDestination:destination }, '', url);
    }

    async function navigate(value, { history = 'push', focus = false, source = 'app' } = {}) {
      if (destroyed) return { ignored:true };
      const destination = resolveDestination(value, { destinations:allowed, aliases, fallback:initial });
      const previous = current;
      const revision = ++navigationRevision;
      current = destination;
      buttons.forEach((button) => {
        const active = button.dataset.shellDestination === destination;
        if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
      });
      panels.forEach((panel) => { panel.hidden = panel.dataset.shellPanel !== destination; });
      if (history !== 'none' && destination !== previous) updateUrl(destination, history);
      const result = await onNavigate({ destination, previous, revision, source });
      if (revision !== navigationRevision) return { ignored:true, stale:true, destination };
      if (focus) {
        const panel = panels.find((item) => item.dataset.shellPanel === destination);
        const target = panel?.querySelector('h1,h2,[data-shell-focus]');
        if (target) { target.tabIndex = -1; target.focus({ preventScroll:true }); }
      }
      return { destination, result };
    }

    const clickHandler = (event) => {
      const button = event.target.closest?.('[data-shell-destination]');
      if (!button || !buttons.includes(button) || button.disabled) return;
      navigate(button.dataset.shellDestination, { history:'push', focus:true, source:'navigation' }).catch(() => {});
    };
    const popHandler = () => navigate(fromLocation(), { history:'none', focus:true, source:'history' }).catch(() => {});
    doc.addEventListener('click', clickHandler);
    doc.defaultView?.addEventListener('popstate', popHandler);

    return Object.freeze({
      start(value = fromLocation()) { return navigate(value || initial, { history:'replace', source:'start' }); },
      navigate,
      current:() => current,
      revision:() => navigationRevision,
      destroy() {
        destroyed = true;
        doc.removeEventListener('click', clickHandler);
        doc.defaultView?.removeEventListener('popstate', popHandler);
      },
    });
  }

  return Object.freeze({ normalizeDestinations, resolveDestination, createDestinationRouter });
}));
