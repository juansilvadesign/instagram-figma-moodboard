// inject.js — MAIN-world script: resolves Instagram media straight out of React fiber memory.
//
// Why MAIN world: __reactFiber$ keys on DOM nodes are only visible to page-context scripts.
// Why fibers at all: sponsored/ad posts and private-account posts can't be re-fetched via
// /p/<code>/ or GraphQL — but the raw media JSON (video_versions, carousel_media, …) is already
// sitting in the props of the React components that rendered the post.
//
// Traversal contract (2026-07-13 rewrite — see CLAUDE.md Gotcha #11):
//   • The post's data props live on ANCESTOR component fibers of the <article> host fiber.
//     Climb fiber.return FIRST — that chain is tens of fibers, not thousands. A downward
//     child/sibling DFS with a small node cap dies inside the post header before reaching any
//     media-bearing component (the old bug: 4 fix attempts searched the wrong direction).
//   • Safety comes from a time deadline + property budget + visited sets — NOT from starving
//     the traversal with tiny node caps.
//   • When the shortcode is known, only an object whose code/shortcode EQUALS it is accepted,
//     so deep searches can never return a neighboring post. Generic matching (no shortcode —
//     some ads have no permalink) is allowed only on the ancestor chain of the clicked
//     container, and never enters arrays (feed lists hold other posts).
//
// Bridge with content.js (ISOLATED world): CustomEvents with JSON-STRING details — primitive
// strings cross Chrome's world boundary on every version, object details depend on
// structured-clone behavior. The target container is handed over via a data-igfm-req attribute:
// the DOM is shared across worlds even though JS heaps are not. Raw media is returned as
// sanitized JSON; normalization happens in the content script (resolver.js no longer loads in
// the MAIN world).

(() => {
  'use strict';

  const MEDIA_KEYS = [
    'carousel_media',
    'edge_sidecar_to_children',
    'video_versions',
    'image_versions2',
    'display_resources',
    'video_url',
    'display_url',
  ];

  // Keys that lead back into React/Relay internals or linked lists — never into post data.
  const SKIP_KEYS = new Set([
    'children', 'child', 'sibling', 'return', 'stateNode', 'alternate', 'ref', 'key',
    'type', 'elementType', 'updateQueue', 'dependencies', 'memoizedProps', 'memoizedState',
    'pendingProps', 'baseState', 'baseQueue', 'queue', 'next', 'firstEffect', 'lastEffect',
  ]);

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // One budget object per request: wall-clock deadline + total property-visit budget +
  // a shared visited set so re-scans from sibling fibers are near-free.
  const makeState = (budgetMs, propBudget) => ({
    deadline: now() + (budgetMs === undefined ? 350 : budgetMs),
    propsLeft: propBudget === undefined ? 60000 : propBudget,
    visited: new Set(),
    fibersVisited: 0,
    deadlineHit: false,
  });

  function expired(state) {
    if (state.propsLeft <= 0) return true;
    if (now() > state.deadline) {
      state.deadlineHit = true;
      return true;
    }
    return false;
  }

  function looksLikeMedia(obj, shortcode) {
    let code;
    try {
      code = obj.code || obj.shortcode;
    } catch {
      return false;
    }
    if (typeof code !== 'string' || code.length < 5) return false;
    if (shortcode && code !== shortcode) return false;
    for (const k of MEDIA_KEYS) {
      try {
        if (obj[k]) return true;
      } catch {
        // getter threw — not our object
      }
    }
    return false;
  }

  // Bounded recursive search for a media-shaped object inside arbitrary page data.
  // Exact mode (shortcode given) may enter arrays; generic mode may not, so a feed list can
  // never hand back a neighboring post.
  function searchData(value, shortcode, state, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 5 || expired(state)) return null;
    if (!value || typeof value !== 'object') return null;
    if (state.visited.has(value)) return null;
    state.visited.add(value);
    state.propsLeft--;

    try {
      if (value.nodeType || (typeof window !== 'undefined' && value === window)) return null;
      if (value.$$typeof) return null; // react elements / portals
    } catch {
      return null;
    }

    if (Array.isArray(value)) {
      if (!shortcode) return null;
      const n = Math.min(value.length, 100);
      for (let i = 0; i < n; i++) {
        const found = searchData(value[i], shortcode, state, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (looksLikeMedia(value, shortcode)) return value;

    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return null;
    }
    const n = Math.min(keys.length, 96);
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (SKIP_KEYS.has(k) || k.charCodeAt(0) === 95 /* '_' */) continue;
      let v;
      try {
        v = value[k];
      } catch {
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      const found = searchData(v, shortcode, state, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // memoizedProps / pendingProps / alternate props, then hook chain (function components) or
  // the plain state object (class components).
  function scanFiber(fiber, shortcode, state) {
    state.fibersVisited++;
    const sources = [];
    try {
      if (fiber.memoizedProps) sources.push(fiber.memoizedProps);
    } catch { /* detached fiber */ }
    try {
      if (fiber.pendingProps) sources.push(fiber.pendingProps);
    } catch { /* detached fiber */ }
    try {
      if (fiber.alternate && fiber.alternate.memoizedProps) sources.push(fiber.alternate.memoizedProps);
    } catch { /* detached fiber */ }
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      const found = searchData(src, shortcode, state, 0);
      if (found) return found;
    }

    let h;
    try {
      h = fiber.memoizedState;
    } catch {
      h = null;
    }
    if (h && typeof h === 'object') {
      let isHookChain = false;
      try {
        isHookChain = 'memoizedState' in h && 'next' in h;
      } catch { /* proxy */ }
      if (!isHookChain) {
        const found = searchData(h, shortcode, state, 0);
        if (found) return found;
      } else {
        let i = 0;
        while (h && typeof h === 'object' && i++ < 48 && !expired(state)) {
          let hv;
          try {
            hv = h.memoizedState;
          } catch {
            hv = null;
          }
          const found = searchData(hv, shortcode, state, 0);
          if (found) return found;
          try {
            h = h.next;
          } catch {
            h = null;
          }
        }
      }
    }
    return null;
  }

  function componentName(fiber) {
    try {
      const t = fiber.type || fiber.elementType;
      if (typeof t === 'string') return t;
      if (t) return t.displayName || t.name || '(anon)';
    } catch { /* ignore */ }
    return '(unknown)';
  }

  // Phase A: climb the return chain from each start fiber — cheap, surgical, and where the
  // data actually lives. Phase B (exact-shortcode only): BFS across child/sibling/return for
  // layouts where the data sits on a cousin branch (e.g. modal wrappers).
  function findMediaFromFiberGraph(startFibers, shortcode, state) {
    const starts = startFibers.filter(Boolean);
    for (const start of starts) {
      let f = start;
      let hops = 0;
      while (f && hops++ < 80 && !expired(state)) {
        const found = scanFiber(f, shortcode, state);
        if (found) return { media: found, via: 'ancestors:' + componentName(f) };
        try {
          f = f.return;
        } catch {
          f = null;
        }
      }
    }
    if (shortcode) {
      const seen = new Set();
      const queue = [...starts];
      while (queue.length && seen.size < 2500 && !expired(state)) {
        const f = queue.shift();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const found = scanFiber(f, shortcode, state);
        if (found) return { media: found, via: 'graph:' + componentName(f) };
        for (const edge of ['child', 'sibling', 'return']) {
          let nf;
          try {
            nf = f[edge];
          } catch {
            nf = null;
          }
          if (nf && !seen.has(nf)) queue.push(nf);
        }
      }
    }
    return { media: null, via: null };
  }

  // Strips functions, DOM nodes, react elements, `_`-prefixed keys, and repeated/circular
  // object references so the payload is plain JSON (cross-world safe by construction).
  function safeJsonStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, function (k, v) {
      if (k && k.charCodeAt(0) === 95) return undefined;
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') {
        try {
          if (v.nodeType || (typeof window !== 'undefined' && v === window) || v.$$typeof) return undefined;
        } catch {
          return undefined;
        }
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    });
  }

  function getFiber(el) {
    if (!el) return null;
    try {
      const key = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
      );
      return key ? el[key] : null;
    } catch {
      return null;
    }
  }

  function findFiberedDescendant(container) {
    if (!container || !container.querySelectorAll) return null;
    const descendants = container.querySelectorAll('*');
    const limit = Math.min(descendants.length, 300);
    for (let i = 0; i < limit; i++) {
      const f = getFiber(descendants[i]);
      if (f) return f;
    }
    return null;
  }

  function resolveContainer(reqId, shortcode) {
    try {
      const el = document.querySelector('[data-igfm-req="' + reqId + '"]');
      if (el) return el;
    } catch { /* bad reqId */ }
    if (shortcode) {
      for (const article of document.querySelectorAll('article')) {
        if (article.innerHTML.includes(shortcode)) return article;
      }
      for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
        if (dialog.innerHTML.includes(shortcode)) return dialog;
      }
      if (location.pathname.includes(shortcode)) return document.querySelector('main');
    }
    return null;
  }

  if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
    document.addEventListener('igfm-request-react', (e) => {
      let req = e && e.detail;
      if (typeof req === 'string') {
        try {
          req = JSON.parse(req);
        } catch {
          req = null;
        }
      }
      if (!req || !req.reqId) return;
      const reqId = String(req.reqId);
      const shortcode = req.shortcode ? String(req.shortcode) : null;
      const respond = (payload) => {
        payload.reqId = reqId;
        let detail;
        try {
          detail = JSON.stringify(payload);
        } catch {
          detail = JSON.stringify({ reqId, media: null, error: 'payload not serializable' });
        }
        document.dispatchEvent(new CustomEvent('igfm-response-react', { detail }));
      };
      try {
        const container = resolveContainer(reqId, shortcode);
        if (!container) {
          respond({ media: null, error: 'container not found' });
          return;
        }
        const t0 = now();
        const state = makeState(350, 60000);
        const containerFiber = getFiber(container);
        const mediaEl = container.querySelector('img[srcset], video, img');
        const result = findMediaFromFiberGraph(
          [getFiber(mediaEl), containerFiber, containerFiber ? null : findFiberedDescendant(container)],
          shortcode,
          state,
        );
        const stats = {
          ms: Math.round(now() - t0),
          fibers: state.fibersVisited,
          propBudgetLeft: state.propsLeft,
          deadlineHit: state.deadlineHit,
        };
        console.log(
          '[IGFM-Inject]',
          result.media ? 'media found via ' + result.via : 'no media in fiber graph',
          stats,
          'shortcode=' + shortcode,
        );
        let media = null;
        if (result.media) {
          try {
            media = JSON.parse(safeJsonStringify(result.media));
          } catch (err) {
            respond({ media: null, error: 'media not serializable: ' + err.message, stats });
            return;
          }
        }
        respond({ media, via: result.via, stats });
      } catch (err) {
        console.error('[IGFM-Inject] extraction error:', err);
        respond({ media: null, error: String((err && err.message) || err) });
      }
    });
  }

  const api = {
    getFiber,
    looksLikeMedia,
    searchData,
    scanFiber,
    findMediaFromFiberGraph,
    safeJsonStringify,
    makeState,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // node tests
  } else if (typeof globalThis !== 'undefined') {
    globalThis.IGFM_INJECT = api; // page-console debug handle
  }
})();
