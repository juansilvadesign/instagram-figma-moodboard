// inject.js — MAIN-world script: resolves Instagram media from what the page already loaded.
//
// Why MAIN world: window.fetch/XHR wrapping and __reactFiber$ keys are only reachable from the
// page context. Sponsored/ad posts and deferred carousels can't be re-fetched via /p/<code>/
// or GraphQL — but the raw media JSON (video_versions, carousel_media, …) already reached the
// page in its own feed/graphql responses and server-embedded JSON blobs.
//
// Source order on a request (first hit wins):
//   1. network-response cache — fetch/XHR tap on /graphql/query + /api/v1/ (installed at
//      document_start, before any page script). PRIMARY for feed carousels & sponsored posts:
//      verified live 2026-07-13 that feed fiber props no longer carry post data (Relay store
//      era — 2660 fibers walked, zero media objects), and the /p/ embed is cover-only.
//   2. server-embedded <script type="application/json"> blobs, scanned lazily on first miss.
//   3. React fiber props/hooks walk — kept for surfaces that still pass fat props and for
//      no-permalink ads (generic ancestor match needs no shortcode).
// The cache is in-page memory only (LRU, never persisted) and is consulted strictly on the
// user's explicit click — no bulk harvesting.
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

  // A profile payload (bio + counts), as opposed to the thin `user` object that rides on a media
  // item (username/full_name/profile_pic only). The profile page fetches this for itself while you
  // browse, so the tap already sees it — it was simply discarded because it isn't media.
  // Both the web (`edge_*`) and mobile (`*_count`) shapes are accepted; we never assume which
  // query delivered it.
  const PROFILE_KEYS = [
    'biography', 'edge_followed_by', 'edge_follow', 'edge_owner_to_timeline_media',
    'follower_count', 'following_count', 'media_count',
  ];

  function looksLikeProfile(obj) {
    let name;
    try {
      name = obj.username;
    } catch {
      return false;
    }
    if (typeof name !== 'string' || !name) return false;
    for (const k of PROFILE_KEYS) {
      try {
        if (obj[k] !== undefined) return true;
      } catch {
        // getter threw — not our object
      }
    }
    return false;
  }

  const profileRichness = (o) => {
    let n = 0;
    for (const k of PROFILE_KEYS) {
      try {
        if (o[k] !== undefined) n++;
      } catch { /* proxy */ }
    }
    return n;
  };

  // Keyed by USERNAME on purpose: a page also carries suggested/related users, so the caller looks
  // up its exact handle and can never be handed a stranger's bio.
  const profileCache = new Map();

  function profilePut(obj) {
    let name;
    try {
      name = obj.username;
    } catch {
      return;
    }
    if (typeof name !== 'string' || !name) return;
    const prev = profileCache.get(name);
    if (prev && profileRichness(prev) >= profileRichness(obj)) return; // keep the richest seen
    if (profileCache.size > 50 && !prev) profileCache.clear(); // bounded; profiles are tiny
    profileCache.set(name, obj);
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

  // ---- network-response tap + media cache -----------------------------------------------

  // `/api/graphql` is NOT covered by the other two branches and was missing until 2026-07-17:
  // a profile route fires FIVE POSTs to it (probe on @solarity.studio, route
  // comet.igweb.PolarisProfilePostsTabRoute) and the tap was deaf to every one. That — not the
  // matcher — is why the v0.4.1/0.4.2 profile header came back null: the payload never reached
  // profilePut. Add an endpoint here before ever "fixing" a matcher that isn't being fed.
  const TAP_URL_RE = /\/graphql\/query|\/api\/graphql|\/api\/v1\//;
  const MEDIA_CACHE_MAX = 400;
  const mediaCache = new Map(); // shortcode -> richest raw media object seen

  const childCount = (m) => {
    try {
      if (m.carousel_media && m.carousel_media.length) return m.carousel_media.length;
      const e = m.edge_sidecar_to_children;
      if (e && e.edges && e.edges.length) return e.edges.length;
    } catch { /* proxy */ }
    return 0;
  };

  const richness = (m) => {
    let r = childCount(m) * 10;
    try {
      if (m.video_versions || m.video_url) r += 2;
      if (m.image_versions2 || m.display_resources || m.display_url) r += 1;
    } catch { /* proxy */ }
    return r;
  };

  // Keep the richest version per code (feed responses carry full carousel_media; the /p/ embed
  // may be cover-only). Map insertion order doubles as the LRU order.
  function cachePut(media) {
    let code;
    try {
      code = media.code || media.shortcode;
    } catch {
      return;
    }
    if (typeof code !== 'string' || code.length < 5) return;
    const prev = mediaCache.get(code);
    const keep = prev && richness(prev) >= richness(media) ? prev : media;
    mediaCache.delete(code);
    mediaCache.set(code, keep);
    if (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value);
  }

  // GraphQL @defer streams arrive as newline-delimited JSON chunks — a plain JSON.parse of the
  // body fails, but each line parses on its own. The deferred chunks are exactly where carousel
  // children land.
  function parseJsonChunks(text) {
    if (typeof text !== 'string' || !text) return [];
    try {
      return [JSON.parse(text)];
    } catch { /* multi-chunk body */ }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch { /* not a JSON line */ }
    }
    return out;
  }

  // Harvest every media-shaped object out of a parsed payload (timeline, graphql, embedded
  // blob). Unlike the fiber search this must NOT skip underscore keys — Relay wraps results in
  // __bbox — and must go deep (timeline nests media ~10 levels down). Iterative, budgeted.
  // `putProfile` is optional so existing callers/tests are unaffected. Collecting both in ONE walk
  // keeps the single 120ms budget — a second traversal would double the cost of every response.
  function collectMedia(root, put, budget, putProfile) {
    const deadline = now() + (budget && budget.ms !== undefined ? budget.ms : 120);
    let nodes = budget && budget.nodes !== undefined ? budget.nodes : 150000;
    const visited = new Set();
    const stack = [root];
    while (stack.length) {
      if (--nodes <= 0 || now() > deadline) return false; // budget hit — partial harvest
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (visited.has(v)) continue;
      visited.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
        continue;
      }
      if (looksLikeMedia(v, null)) put(v);
      if (putProfile && looksLikeProfile(v)) putProfile(v);
      let keys;
      try {
        keys = Object.keys(v);
      } catch {
        continue;
      }
      for (let i = 0; i < keys.length; i++) {
        let val;
        try {
          val = v[keys[i]];
        } catch {
          continue;
        }
        if (val && typeof val === 'object') stack.push(val);
      }
    }
    return true;
  }

  function ingestResponseText(text) {
    for (const payload of parseJsonChunks(text)) collectMedia(payload, cachePut, { ms: 120 }, profilePut);
  }

  // Wrap fetch + XHR before any page script runs. Ingestion is deferred off the response's
  // critical path; every layer is try/caught so a tap failure can never break Instagram.
  function installNetworkTap() {
    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input) {
          const p = origFetch.apply(this, arguments);
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (TAP_URL_RE.test(url)) {
              p.then((res) => {
                try {
                  if (res && res.ok) {
                    res.clone().text().then(
                      (t) => setTimeout(() => {
                        try { ingestResponseText(t); } catch { /* never break the page */ }
                      }, 0),
                      () => {},
                    );
                  }
                } catch { /* opaque/locked body */ }
              }, () => {});
            }
          } catch { /* never break the page */ }
          return p;
        };
      }
      const XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          try {
            this.__igfmUrl = String(url || '');
          } catch { /* never break the page */ }
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          try {
            if (this.__igfmUrl && TAP_URL_RE.test(this.__igfmUrl)) {
              this.addEventListener('load', () => {
                try {
                  const rt = this.responseType;
                  const text =
                    rt === '' || rt === 'text'
                      ? this.responseText
                      : rt === 'json'
                        ? JSON.stringify(this.response)
                        : null;
                  if (text) {
                    setTimeout(() => {
                      try { ingestResponseText(text); } catch { /* never break the page */ }
                    }, 0);
                  }
                } catch { /* never break the page */ }
              });
            }
          } catch { /* never break the page */ }
          return origSend.apply(this, arguments);
        };
      }
    } catch { /* never break the page */ }
  }

  // Server-embedded Relay payloads (first feed posts, permalink pages) live in
  // <script type="application/json"> blobs. Scanned lazily on the first cache miss; each
  // element only once (SPA navs add new ones).
  const scannedScripts = typeof WeakSet !== 'undefined' ? new WeakSet() : new Set();
  function scanInlineScripts() {
    let scanned = 0;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      if (scannedScripts.has(s)) continue;
      scannedScripts.add(s);
      scanned++;
      try {
        // profilePut MUST be passed here too, not just on the network tap: a freshly-loaded
        // profile page server-EMBEDS its own profile payload instead of fetching it, so this is
        // the only path that ever sees bio/counts on a cold load. Missing it here is why the
        // v0.4.1 header came back null on the first real run (2026-07-17).
        for (const payload of parseJsonChunks(s.textContent)) collectMedia(payload, cachePut, { ms: 150 }, profilePut);
      } catch { /* skip blob */ }
    }
    return scanned;
  }

  // ---- fiber access ----------------------------------------------------------------------

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
    if (typeof window !== 'undefined') installNetworkTap();
    // Profile payload lookup (v2 crawl header). Answers ONLY from what the page already fetched —
    // it issues no request of its own. Looked up by exact username, so a page full of suggested
    // users can't leak a stranger's bio onto the board.
    document.addEventListener('igfm-request-profile', (e) => {
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
      let detail;
      try {
        const handle = req.handle ? String(req.handle) : null;
        let raw = handle ? profileCache.get(handle) : null;
        if (!raw && handle) {
          scanInlineScripts(); // the profile page server-embeds its own payload on first paint
          raw = profileCache.get(handle) || null;
        }
        detail = safeJsonStringify({ reqId, profile: raw || null, cached: profileCache.size });
      } catch (err) {
        detail = JSON.stringify({ reqId, profile: null, error: String((err && err.message) || err) });
      }
      document.dispatchEvent(new CustomEvent('igfm-response-profile', { detail }));
    });

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
        const t0 = now();
        let raw = null;
        let via = null;
        let scriptsScanned = 0;
        // 1. network-response cache (primary: feed/modal GraphQL has the full carousel)
        if (shortcode && mediaCache.has(shortcode)) {
          raw = mediaCache.get(shortcode);
          via = 'network_cache';
        }
        // 2. server-embedded JSON blobs (first feed posts, permalink pages)
        if (!raw) {
          scriptsScanned = scanInlineScripts();
          if (shortcode && mediaCache.has(shortcode)) {
            raw = mediaCache.get(shortcode);
            via = 'embedded_json';
          }
        }
        // 3. fiber props/hooks walk (surfaces that still pass fat props; no-permalink ads)
        let state = null;
        if (!raw) {
          const container = resolveContainer(reqId, shortcode);
          if (container) {
            state = makeState(350, 60000);
            const containerFiber = getFiber(container);
            const mediaEl = container.querySelector('img[srcset], video, img');
            const result = findMediaFromFiberGraph(
              [getFiber(mediaEl), containerFiber, containerFiber ? null : findFiberedDescendant(container)],
              shortcode,
              state,
            );
            raw = result.media;
            via = result.via;
          }
        }
        const stats = {
          ms: Math.round(now() - t0),
          via,
          cacheSize: mediaCache.size,
          scriptsScanned,
          fibers: state ? state.fibersVisited : 0,
          deadlineHit: state ? state.deadlineHit : false,
        };
        console.log(
          '[IGFM-Inject]',
          raw ? 'media found via ' + via : 'no media found in page',
          JSON.stringify(stats),
          'shortcode=' + shortcode,
        );
        let media = null;
        if (raw) {
          try {
            media = JSON.parse(safeJsonStringify(raw));
          } catch (err) {
            respond({ media: null, error: 'media not serializable: ' + err.message, stats });
            return;
          }
        }
        respond({ media, via, stats });
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
    parseJsonChunks,
    collectMedia,
    cachePut,
    TAP_URL_RE,
    looksLikeProfile,
    profilePut,
    _mediaCache: mediaCache,
    _profileCache: profileCache,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // node tests
  } else if (typeof globalThis !== 'undefined') {
    globalThis.IGFM_INJECT = api; // page-console debug handle
  }
})();
