/* IGFM STORIES PROBE v2 — paste this whole classic script into a logged-in Instagram console.
 * Zero network requests: it only reads page fetch/XHR responses and embedded JSON.
 *
 * API: IGFM_STORY.arm() installs the tap and scans inline JSON (auto-runs on paste).
 *      IGFM_STORY.mark('label') snapshots the viewer/post DOM and current caches.
 *      IGFM_STORY.report() prints a short table and returns the JSON report.
 *      IGFM_STORY.save() locally downloads igfm-stories-probe-<YYYYMMDD-HHMMSS>.json.
 *
 * Owner run script:
 * 1. Open instagram.com home, open DevTools Console, paste this file, Enter ("armed").
 * 2. Open an account story with 2+ items (ideally a video); on item 1 run
 *    IGFM_STORY.mark('story-1'), advance, then mark('story-2').
 * 3. Open a profile highlight; mark('highlight-1'), advance, mark('highlight-2').
 * 4. Return to feed or a carousel post, move to slide 3, mark('carousel-3').
 * 5. Run IGFM_STORY.save() now (file 1).
 * 6. On a /stories/… URL, press F5, paste this file again, mark('cold'), then
 *    run IGFM_STORY.save() (file 2).
 * A full page reload loses the in-page report; always save before reloading.
 */
(() => {
  'use strict';

  const VERSION = 2;
  const MAX_BODY = 5 * 1024 * 1024;
  const TAP_URL_RE = /\/graphql\/query|\/api\/graphql|\/api\/v1\//;
  const clock = () => typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const object = (v) => v !== null && typeof v === 'object';
  const value = (v) => v === undefined ? null : v;
  const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v) ? value(v) : null;
  const keys = (v, max) => object(v) ? Object.keys(v).sort().slice(0, max || Infinity) : [];

  function reduceUrl(input) {
    if (typeof input !== 'string' || !input) return null;
    if (/^blob:/i.test(input)) return 'blob:';
    if (/^data:/i.test(input)) return 'data:';
    try {
      const u = new URL(input, 'https://www.instagram.com/');
      if (!/^https?:$/.test(u.protocol)) return u.protocol;
      return u.host + '/' + (u.pathname.split('/').pop() || '');
    } catch { return null; }
  }

  function basename(input) {
    const reduced = reduceUrl(input);
    return reduced && !/^(blob:|data:)$/.test(reduced) ? reduced.slice(reduced.lastIndexOf('/') + 1) : null;
  }

  function parseJsonChunks(text) {
    if (typeof text !== 'string' || !text) return [];
    try { return [JSON.parse(text)]; } catch { /* @defer can be newline-delimited */ }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* non-JSON delimiter */ }
    }
    return out;
  }

  const unwrap = (v) => object(v) && object(v.node) ? v.node : v;
  const itemPk = (v) => object(v) ? value(v.pk || v.id) : null;
  const ownerOf = (v) => object(v) ? (v.user && v.user.username) || (v.owner && v.owner.username) || null : null;

  function mediaLike(v) {
    v = unwrap(v);
    return object(v) && !Array.isArray(v) && !!(v.pk || v.id) &&
      !!(v.media_type || v.video_versions || v.image_versions2 || v.display_url || v.video_url);
  }

  function reelWhy(v) {
    if (!object(v) || Array.isArray(v)) return [];
    const why = [];
    const items = v.items;
    if (v.__typename === 'XDTReelDict') why.push('typename');
    if (/^highlight:\d+/.test(String(v.id || ''))) why.push('highlight-id');
    if (v.reel_type !== undefined) why.push('reel_type');
    if (Array.isArray(items) && items.some((x) => mediaLike(x))) why.push('items-array');
    return why;
  }

  function isStandaloneStory(v) {
    return mediaLike(v) && (v.expiring_at != null ||
      /stor(y|ies)/i.test(String(v.product_type || '')) ||
      /StoryItem/i.test(String(v.__typename || '')));
  }

  function isCarouselPost(v) {
    return object(v) && typeof (v.code || v.shortcode) === 'string' &&
      (Array.isArray(v.carousel_media) ||
        !!(v.edge_sidecar_to_children && Array.isArray(v.edge_sidecar_to_children.edges)));
  }

  // One iterative pass per JSON chunk. Reverse pushes restore the source's array order on pop.
  // Item records are attached when their reel is reached, before generic child traversal.
  function walkPayload(root, budget) {
    const b = budget || {};
    const deadline = clock() + (b.ms === undefined ? 120 : b.ms);
    let remaining = b.nodes === undefined ? 150000 : b.nodes;
    const stack = [root], visited = new Set(), itemRecords = new Map();
    const reels = [], items = [], posts = [];
    let complete = true;
    const addItem = (raw, reel, why) => {
      raw = unwrap(raw);
      if (!mediaLike(raw)) return;
      const strongReel = !!(why && why.some((rule) => rule !== 'items-array'));
      const prior = itemRecords.get(raw);
      if (prior) {
        if (reel && !prior.reelIds.includes(value(reel.id))) prior.reelIds.push(value(reel.id));
        if (reel && !prior.reelOwner) prior.reelOwner = ownerOf(reel);
        prior.strongReel = prior.strongReel || strongReel;
        return;
      }
      const record = { item: raw, reelIds: reel ? [value(reel.id)] : [],
        reelOwner: reel ? ownerOf(reel) : null, strongReel };
      itemRecords.set(raw, record);
      items.push(record);
    };
    while (stack.length) {
      if (--remaining <= 0 || clock() > deadline) { complete = false; break; }
      const v = stack.pop();
      if (!object(v) || visited.has(v)) continue;
      visited.add(v);
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
        continue;
      }
      const why = reelWhy(v);
      if (why.length) {
        reels.push(v);
        if (Array.isArray(v.items)) for (const child of v.items) addItem(child, v, why);
      } else if (isStandaloneStory(v)) addItem(v, null);
      if (isCarouselPost(v)) posts.push(v);
      const names = Object.keys(v);
      for (let i = names.length - 1; i >= 0; i--) {
        let child;
        try { child = v[names[i]]; } catch { continue; }
        if (object(child)) stack.push(child);
      }
    }
    return { reels, items, posts, complete };
  }

  function summarizeItemMedia(item) {
    const versions = Array.isArray(item.video_versions) ? item.video_versions : [];
    const candidates = item.image_versions2 && Array.isArray(item.image_versions2.candidates)
      ? item.image_versions2.candidates : [];
    let widest = null;
    for (const c of candidates) if (!widest || Number(c.width || 0) > Number(widest.width || 0)) widest = c;
    return {
      videoVersions: { count: versions.length, entries: versions.map((v) => ({
        width: value(v.width), height: value(v.height), type: value(v.type), url: reduceUrl(v.url),
      })) },
      imageCandidates: { count: candidates.length, maxWidth: widest ? value(widest.width) : null,
        widestBasename: widest ? basename(widest.url) : null },
      videoDashManifest: { present: Object.prototype.hasOwnProperty.call(item, 'video_dash_manifest'),
        length: typeof item.video_dash_manifest === 'string' ? item.video_dash_manifest.length : null },
      hasAudio: value(item.has_audio), videoDuration: value(item.video_duration),
    };
  }

  function closeFriendsSignals(item) {
    const out = [], stack = [{ node: item, path: '' }], seen = new Set();
    let remaining = 1500;
    while (stack.length && --remaining > 0 && out.length < 12) {
      const { node, path } = stack.pop();
      if (!object(node) || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], path: path + '[' + i + ']' });
        continue;
      }
      for (const k of Object.keys(node)) {
        const v = node[k], field = path ? path + '.' + k : k;
        if (/besties|close_friends/i.test(k) ||
          (typeof v === 'string' && /besties|close_friends/i.test(v))) {
          const shown = typeof v === 'string' ? (/^https?:/.test(v) ? reduceUrl(v) : v.slice(0, 80)) :
            (typeof v === 'boolean' || typeof v === 'number' ? v : null);
          out.push({ field, value: shown });
          if (out.length >= 12) break;
        }
        if (object(v)) stack.push({ node: v, path: field });
      }
    }
    return out;
  }

  function summarizeReel(reel) {
    const children = Array.isArray(reel.items) ? reel.items.map((v) => itemPk(unwrap(v))) : [];
    const owner = reel.user || reel.owner || {};
    return {
      id: value(reel.id), typename: value(reel.__typename), reelType: value(reel.reel_type),
      why: reelWhy(reel),
      owner: { username: value(owner.username), pk: value(owner.pk || owner.id) },
      title: value(reel.title), itemCount: children.length,
      firstItemPks: children.slice(0, 3), lastItemPks: children.slice(-3),
      latestReelMediaPresent: Object.prototype.hasOwnProperty.call(reel, 'latest_reel_media'),
      latestReelMedia: scalar(reel.latest_reel_media),
      expiringAtPresent: Object.prototype.hasOwnProperty.call(reel, 'expiring_at'),
      expiringAt: scalar(reel.expiring_at),
      keys: keys(reel),
    };
  }

  function summarizeStoryItem(record) {
    const item = record.item;
    return {
      storyLike: isStandaloneStory(item) || !!record.strongReel,
      pk: value(item.pk), id: value(item.id),
      codePresent: Object.prototype.hasOwnProperty.call(item, 'code'), code: value(item.code),
      takenAt: value(item.taken_at), expiringAt: value(item.expiring_at),
      mediaType: value(item.media_type), productType: value(item.product_type),
      audience: scalar(item.audience), typename: value(item.__typename),
      owner: ownerOf(item) || record.reelOwner || null,
      reelIds: record.reelIds.slice(), keys: keys(item, 80),
      media: summarizeItemMedia(item), closeFriends: closeFriendsSignals(item),
    };
  }

  function selectReels(reels) {
    return reels.filter((r) => r.itemCount > 0).slice(-80)
      .concat(reels.filter((r) => r.itemCount === 0).slice(-20));
  }

  function selectItems(items) {
    return items.filter((e) => e.summary.storyLike).slice(-250)
      .concat(items.filter((e) => !e.summary.storyLike).slice(-20));
  }

  const pure = { parseJsonChunks, walkPayload, summarizeReel, summarizeStoryItem,
    summarizeItemMedia, reduceUrl, basename, selectReels, selectItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.IGFM_STORY) { window.IGFM_STORY.arm(); return; }

  const state = { armed: false, armedAt: null, counters: {}, responses: [], reels: new Map(),
    items: new Map(), posts: new Map(), marks: [], scannedScripts: new WeakSet(), inline: { seen: 0, skipped: 0 } };
  const pathname = (u) => { try { return new URL(u, location.href).pathname; } catch { return null; } };
  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch { return false; } };

  function requestName(body, headers) {
    let name = null;
    try {
      if (headers) {
        if (typeof headers.get === 'function') name = headers.get('x-fb-friendly-name');
        else if (Array.isArray(headers)) {
          const pair = headers.find((x) => String(x[0]).toLowerCase() === 'x-fb-friendly-name');
          name = pair && pair[1];
        } else for (const k of Object.keys(headers)) if (k.toLowerCase() === 'x-fb-friendly-name') name = headers[k];
      }
      if (typeof body === 'string') name = new URLSearchParams(body).get('fb_api_req_friendly_name') || name;
      else if (body && typeof body.get === 'function') name = body.get('fb_api_req_friendly_name') || name;
    } catch { /* diagnostic metadata only */ }
    return name ? String(name).slice(0, 160) : null;
  }

  function fetchRequestName(input, init) {
    try {
      const header = requestName(init && init.body, init && init.headers) ||
        requestName(null, input && input.headers);
      if (header) return Promise.resolve(header);
      if (typeof Request !== 'undefined' && input instanceof Request && input.body && !input.bodyUsed) {
        return input.clone().text().then((body) => requestName(body, null), () => null);
      }
    } catch { /* never affect the request */ }
    return Promise.resolve(null);
  }

  async function readFetchBody(res) {
    try {
      const declared = Number(res.headers && res.headers.get('content-length'));
      if (declared > MAX_BODY) return { skipped: 'over-5MB' };
      const clone = res.clone();
      if (!clone.body || !clone.body.getReader) {
        const text = await clone.text();
        return text.length > MAX_BODY ? { skipped: 'over-5MB' } : { text };
      }
      const reader = clone.body.getReader(), decoder = new TextDecoder();
      const parts = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY) { try { reader.cancel().catch(() => {}); } catch { /* ignore */ } return { skipped: 'over-5MB' }; }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return { text: parts.join('') };
    } catch { return { skipped: 'unreadable' }; }
  }

  function bump(meta) {
    const path = meta.path || '(unknown)';
    if (!state.counters[path]) state.counters[path] = { seen: 0, parsed: 0, storyBearing: 0, skipped: 0 };
    state.counters[path].seen++;
  }

  function remember(map, key, val, max, evictFirst) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    if (map.size > max) {
      let victim = null;
      if (evictFirst) for (const [candidate, entry] of map) {
        if (evictFirst(entry)) { victim = candidate; break; }
      }
      map.delete(victim === null ? map.keys().next().value : victim);
    }
  }

  function ingest(meta, result) {
    try {
      const counter = meta.source === 'inline' ? null : state.counters[meta.path];
      if (result.skipped || typeof result.text !== 'string' || result.text.length > MAX_BODY) {
        if (counter) counter.skipped++;
        if (meta.source === 'inline') state.inline.skipped++;
        return;
      }
      const chunks = parseJsonChunks(result.text);
      if (counter && chunks.length) counter.parsed++;
      const dataKeys = new Set(), reelIds = new Set(), itemIds = new Set();
      let budgetHit = false;
      for (const chunk of chunks) {
        if (object(chunk.data)) for (const k of Object.keys(chunk.data)) dataKeys.add(k);
        const found = walkPayload(chunk, { ms: 120, nodes: 150000 });
        if (!found.complete) budgetHit = true;
        for (const raw of found.reels) {
          const summary = summarizeReel(raw);
          const id = String(summary.id || '(no-id)') + ':' + String(summary.owner.username || '?');
          reelIds.add(id);
          const prev = state.reels.get(id);
          summary.sources = prev && prev.sources ? [...new Set([...prev.sources, meta.source])] : [meta.source];
          summary.why = prev ? [...new Set([...prev.why, ...summary.why])] : summary.why;
          if (!prev || summary.itemCount >= prev.itemCount)
            remember(state.reels, id, summary, 200, (r) => r.itemCount === 0);
          else { prev.sources = summary.sources; prev.why = summary.why; }
        }
        for (const record of found.items) {
          const summary = summarizeStoryItem(record);
          const id = String(summary.owner || '?') + ':' + String(summary.pk || summary.id || '(no-pk)');
          itemIds.add(id);
          const prev = state.items.get(id);
          const richness = (s) => s.media.videoVersions.count * 10 + s.media.imageCandidates.count + s.keys.length / 100;
          const keep = prev && richness(prev.summary) > richness(summary) ? prev.summary : summary;
          keep.sources = prev ? [...new Set([...prev.summary.sources, meta.source])] : [meta.source];
          keep.reelIds = prev ? [...new Set([...prev.summary.reelIds, ...summary.reelIds])] : summary.reelIds;
          keep.storyLike = prev ? prev.summary.storyLike || summary.storyLike : summary.storyLike;
          const imageNames = (record.item.image_versions2 && record.item.image_versions2.candidates || [])
            .map((c) => basename(c.url)).filter(Boolean);
          remember(state.items, id, { summary: keep,
            imageNames: [...new Set([...(prev ? prev.imageNames : []), ...imageNames])] },
          500, (e) => !e.summary.storyLike);
        }
        for (const post of found.posts) {
          const code = post.code || post.shortcode;
          const prev = state.posts.get(code);
          const count = (p) => Array.isArray(p.carousel_media) ? p.carousel_media.length :
            (p.edge_sidecar_to_children && p.edge_sidecar_to_children.edges || []).length;
          if (!prev || count(post) >= count(prev)) remember(state.posts, code, post, 200);
        }
      }
      if (reelIds.size || itemIds.size) {
        if (counter) counter.storyBearing++;
        state.responses.push({ source: meta.source, path: meta.path,
          matchesTapRe: meta.source === 'inline' ? null : TAP_URL_RE.test(meta.path || ''),
          friendlyName: meta.friendlyName || null, dataKeys: [...dataKeys].sort(),
          reelCount: reelIds.size, itemCount: itemIds.size, budgetHit });
        if (state.responses.length > 40) state.responses.shift();
      }
    } catch { /* diagnostic failures must never affect Instagram */ }
  }

  function scanInline() {
    try {
      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        if (state.scannedScripts.has(script)) continue;
        state.scannedScripts.add(script);
        state.inline.seen++;
        try {
          const text = script.textContent || '';
          ingest({ source: 'inline', path: location.pathname, friendlyName: null },
            text.length > MAX_BODY ? { skipped: 'over-5MB' } : { text });
        } catch { state.inline.skipped++; }
      }
    } catch { /* no DOM scan should affect the page */ }
  }

  function installTap() {
    try {
      const originalFetch = window.fetch;
      if (typeof originalFetch === 'function') window.fetch = function () {
        const promise = originalFetch.apply(this, arguments);
        try {
          const input = arguments[0], init = arguments[1];
          const reqUrl = typeof input === 'string' ? input : input && input.url;
          const namePromise = fetchRequestName(input, init);
          promise.then((res) => {
            try {
              const url = res && res.url || reqUrl;
              if (!sameOrigin(url)) return;
              const meta = { source: 'fetch', path: pathname(url), friendlyName: null };
              bump(meta);
              Promise.all([readFetchBody(res), namePromise]).then(
                ([body, name]) => { try { meta.friendlyName = name; ingest(meta, body); } catch { /* ignore */ } },
                () => { try { state.counters[meta.path].skipped++; } catch { /* ignore */ } },
              );
            } catch { /* ignore */ }
          }, () => {});
        } catch { /* never change fetch's return */ }
        return promise;
      };
    } catch { /* fetch hook unavailable */ }
    try {
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (!proto) return;
      const originalOpen = proto.open, originalHeader = proto.setRequestHeader, originalSend = proto.send;
      proto.open = function () {
        try {
          if (this.__igfmStoryListener) this.removeEventListener('load', this.__igfmStoryListener);
          this.__igfmStoryProbe = { url: String(arguments[1] || ''), headerName: null };
          this.__igfmStoryListener = null;
        } catch { /* ignore */ }
        return originalOpen.apply(this, arguments);
      };
      proto.setRequestHeader = function () {
        try {
          if (this.__igfmStoryProbe && String(arguments[0]).toLowerCase() === 'x-fb-friendly-name')
            this.__igfmStoryProbe.headerName = String(arguments[1]);
        } catch { /* ignore */ }
        return originalHeader.apply(this, arguments);
      };
      proto.send = function () {
        try {
          const req = this.__igfmStoryProbe;
          if (req && sameOrigin(req.url)) {
            const name = requestName(arguments[0], null) || req.headerName;
            const listener = () => {
              try {
                const meta = { source: 'xhr', path: pathname(req.url), friendlyName: name };
                bump(meta);
                if (Number(this.getResponseHeader('content-length')) > MAX_BODY) {
                  ingest(meta, { skipped: 'over-5MB' });
                  return;
                }
                let text = null;
                if (!this.responseType || this.responseType === 'text') text = this.responseText;
                else if (this.responseType === 'json') text = JSON.stringify(this.response);
                ingest(meta, typeof text === 'string' ? { text } : { skipped: 'unreadable' });
              } catch { /* ignore */ }
            };
            this.__igfmStoryListener = listener;
            this.addEventListener('load', listener, { once: true });
          }
        } catch { /* never change XHR send */ }
        return originalSend.apply(this, arguments);
      };
    } catch { /* XHR hook unavailable */ }
  }

  function rect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    try {
      const r = el.getBoundingClientRect();
      const n = (x) => Math.round(x * 10) / 10;
      return { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height),
        right: n(r.right), bottom: n(r.bottom) };
    } catch { return null; }
  }

  function intersection(a, b) {
    if (!a || !b) return 0;
    return Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  }

  function visible(el, r) {
    if (!r || r.width < 1 || r.height < 1 || !intersection(r,
      { x: 0, y: 0, right: innerWidth, bottom: innerHeight })) return false;
    try {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
    } catch { return true; }
  }

  function progressRow(card) {
    if (!card) return null;
    const cr = rect(card), choices = [];
    for (const el of card.querySelectorAll('*')) {
      if (choices.length > 80) break;
      const children = [...el.children];
      if (children.length < 2 || children.length > 50) continue;
      const tag = children[0].tagName;
      if (!children.every((c) => c.tagName === tag)) continue;
      const rs = children.map(rect);
      if (!rs.every((r) => r && r.width >= 5 && r.height > 0 && r.height <= 4)) continue;
      if (rs[0].y < cr.y - 2 || rs[0].y > cr.y + cr.height * 0.3) continue;
      if (!rs.every((r, i) => Math.abs(r.y - rs[0].y) <= 5 && (!i || r.x >= rs[i - 1].right - 3))) continue;
      choices.push({ el, rs, score: children.length * 10 + rs.reduce((n, r) => n + r.width, 0) / 100 });
    }
    choices.sort((a, b) => b.score - a.score);
    if (!choices.length) return null;
    const { el, rs } = choices[0];
    const children = [...el.children];
    const segments = children.map((child, i) => {
      const inner = child.firstElementChild, ir = rect(inner);
      const fillWidthPct = ir && rs[i].width ? Math.max(0, Math.min(100,
        Math.round(ir.width / rs[i].width * 100))) : null;
      return { index: i, rect: rs[i], fillWidthPct };
    });
    let activeIndex = segments.findIndex((s) => s.fillWidthPct !== null && s.fillWidthPct > 1 && s.fillWidthPct < 98);
    let reason = 'partial inner fill';
    if (activeIndex < 0) {
      activeIndex = segments.findIndex((s) => s.fillWidthPct !== null && s.fillWidthPct < 98);
      reason = activeIndex < 0 ? 'no partial fill found' : 'first incomplete fill';
    }
    return { rect: rect(el), childCount: children.length, segments, activeIndex: activeIndex < 0 ? null : activeIndex, reason };
  }

  function cardRoot(media) {
    const mr = rect(media);
    let node = media.parentElement, best = media.parentElement, hops = 0;
    while (node && hops++ < 16 && node !== document.body) {
      const r = rect(node);
      if (!r || r.width > Math.min(innerWidth * 0.88, mr.width * 1.8 + 100) ||
        r.height > innerHeight + 80 || r.height < mr.height * 0.7) break;
      best = node;
      node = node.parentElement;
    }
    return best;
  }

  function storyCards() {
    const byNode = new Map();
    for (const media of document.querySelectorAll('img, video')) {
      const mr = rect(media);
      if (!mr || mr.width < 100 || mr.height < 150 || !visible(media, mr)) continue;
      const card = cardRoot(media), cr = rect(card);
      if (!cr || cr.height < 180 || cr.height < cr.width * 1.1) continue;
      if (!byNode.has(card)) byNode.set(card, { node: card, rect: cr, media: [] });
      byNode.get(card).media.push(media);
    }
    return [...byNode.values()].map((c) => {
      const cx = c.rect.x + c.rect.width / 2, cy = c.rect.y + c.rect.height / 2;
      const distance = Math.hypot((cx - innerWidth / 2) / innerWidth, (cy - innerHeight / 2) / innerHeight);
      const playing = c.media.some((m) => m.tagName === 'VIDEO' && !m.paused && m.readyState > 1);
      return { ...c, distance, playing, score: -distance + Math.min(0.3, c.rect.width * c.rect.height / (innerWidth * innerHeight)) + (playing ? 0.2 : 0) };
    }).sort((a, b) => b.score - a.score);
  }

  function profileLink(card, owner) {
    const links = [...card.querySelectorAll('a[href]')].filter((a) => /^\/[A-Za-z0-9._]+\/$/.test(a.getAttribute('href') || ''));
    const link = links.find((a) => a.getAttribute('href') === '/' + owner + '/') || links[0];
    if (!link) return null;
    const lr = rect(link);
    let row = link.parentElement;
    for (let i = 0; row && i < 5; i++, row = row.parentElement) {
      const rr = rect(row);
      if (rr && rr.width > lr.width + 20 && rr.height <= 120) break;
    }
    return { href: link.getAttribute('href'), rect: lr,
      headerRow: row ? { tag: row.tagName.toLowerCase(), rect: rect(row), childCount: row.children.length } : null };
  }

  function actionCandidates(card) {
    const counts = new Map(), out = [];
    let total = 0;
    for (const svg of card.querySelectorAll('svg[aria-label]')) {
      let el = svg.parentElement;
      while (el && card.contains(el)) {
        if (!counts.has(el)) counts.set(el, { count: 0, labels: [] });
        const hit = counts.get(el);
        hit.count++;
        if (hit.labels.length < 20) hit.labels.push(svg.getAttribute('aria-label'));
        if (el === card) break;
        el = el.parentElement;
      }
    }
    for (const el of [card, ...card.querySelectorAll('*')]) {
      const hit = counts.get(el);
      if (!hit || hit.count < 2) continue;
      total++;
      if (out.length < 50) out.push({ tag: el.tagName.toLowerCase(), rect: rect(el),
        labelledSvgCount: hit.count, ariaLabels: hit.labels,
        containsReplyForm: !!el.querySelector('textarea, form') });
    }
    return { total, candidates: out, truncated: total > out.length };
  }

  function storySnapshot() {
    if (!/^\/stories\//.test(location.pathname)) return null;
    const segments = location.pathname.split('/').filter(Boolean);
    const numericSegments = segments.filter((s) => /^\d+$/.test(s));
    const knownPks = new Set([...state.items.values()].map((e) => String(e.summary.pk || e.summary.id)));
    const cards = storyCards(), active = cards[0];
    const report = {
      path: location.pathname, numericSegments,
      matchingKnownItemPks: numericSegments.filter((s) => knownPks.has(s)),
      viewport: { width: innerWidth, height: innerHeight }, mountedCardCount: cards.length,
      cards: cards.slice(0, 15).map((c, i) => ({ index: i, rect: c.rect,
        mediaCount: c.media.length, playingVideo: c.playing, centreDistance: Math.round(c.distance * 1000) / 1000 })),
      activeCardIndex: active ? 0 : null,
      activeReason: active ? (active.playing ? 'playing video plus centre/area score' : 'closest to viewport centre with area score') : 'no visible media card',
      active: null,
    };
    if (!active) return report;
    const images = [...active.node.querySelectorAll('img')].filter((el) => visible(el, rect(el))).slice(0, 30).map((el) => ({
      basename: basename(el.currentSrc || el.src), naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight, rect: rect(el),
    }));
    const videos = [...active.node.querySelectorAll('video')].filter((el) => visible(el, rect(el))).slice(0, 20).map((el) => {
      const src = el.currentSrc || el.src || '';
      return { scheme: /^blob:/i.test(src) ? 'blob:' : /^https:/i.test(src) ? 'https:' :
        /^http:/i.test(src) ? 'http:' : src ? 'other' : null, posterBasename: basename(el.poster), rect: rect(el) };
    });
    const matches = [];
    for (const media of [...images, ...videos.map((v) => ({ basename: v.posterBasename }))])
      for (const e of state.items.values())
        if (media.basename && e.imageNames.includes(media.basename)) matches.push({ basename: media.basename, pk: e.summary.pk });
    const routeOwner = segments[1] && segments[1] !== 'highlights' ? segments[1] : null;
    const owner = matches.length ? [...state.items.values()].find((e) => e.summary.pk === matches[0].pk).summary.owner : routeOwner;
    report.active = { rect: active.rect, images, videos, imageMatches: matches.slice(0, 30),
      progress: progressRow(active.node), actions: actionCandidates(active.node),
      ownerProfileLink: profileLink(active.node, owner), sectionExists: !!active.node.querySelector('section') };
    return report;
  }

  function shortcodeFromUrl(url) {
    const match = String(url || '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return match && match[1] !== 'audio' ? match[1] : null;
  }

  function findShortcode(container) {
    const canonical = document.querySelector('link[rel="canonical"]');
    const og = document.querySelector('meta[property="og:url"]');
    const fromPage = shortcodeFromUrl(location.pathname) ||
      shortcodeFromUrl(canonical && canonical.getAttribute('href')) ||
      shortcodeFromUrl(og && og.getAttribute('content'));
    if (fromPage) return fromPage;
    for (const a of container.querySelectorAll('a[href]')) {
      const code = shortcodeFromUrl(a.getAttribute('href'));
      if (code) return code;
    }
    return null;
  }

  function carouselChildren(post) {
    const raw = Array.isArray(post.carousel_media) ? post.carousel_media :
      post.edge_sidecar_to_children && post.edge_sidecar_to_children.edges || [];
    return raw.map((entry) => {
      const child = unwrap(entry), candidates = child.image_versions2 && child.image_versions2.candidates || [];
      let widest = null;
      for (const c of candidates) if (!widest || Number(c.width || 0) > Number(widest.width || 0)) widest = c;
      return basename(widest && widest.url || child.display_url || child.thumbnail_src ||
        child.video_poster_url || child.image_url);
    });
  }

  function carouselChildNames(post) {
    const raw = Array.isArray(post.carousel_media) ? post.carousel_media :
      post.edge_sidecar_to_children && post.edge_sidecar_to_children.edges || [];
    return raw.map((entry) => {
      const child = unwrap(entry), candidates = child.image_versions2 && child.image_versions2.candidates || [];
      const names = candidates.map((c) => basename(c.url)).filter(Boolean);
      for (const extra of [child.display_url, child.thumbnail_src, child.video_poster_url, child.image_url]) {
        const name = basename(extra);
        if (name && !names.includes(name)) names.push(name);
      }
      return names;
    });
  }

  function ariaAttributes(el) {
    if (!el) return {};
    const out = {};
    for (const a of el.attributes) if (a.name.startsWith('aria-')) out[a.name] = a.value.slice(0, 100);
    return out;
  }

  function clipRect(list, container) {
    let node = list.parentElement;
    while (node && node !== container) {
      try {
        const s = getComputedStyle(node);
        if (/hidden|clip|scroll/.test(s.overflowX) || /hidden|clip|scroll/.test(s.overflowY)) return rect(node);
      } catch { /* ignore */ }
      node = node.parentElement;
    }
    return rect(container);
  }

  function dotRow(container, mediaRect) {
    const choices = [];
    for (const el of container.querySelectorAll('*')) {
      const children = [...el.children];
      if (children.length < 2 || children.length > 30 || !children.every((c) => c.tagName === children[0].tagName)) continue;
      const rs = children.map(rect);
      if (!rs.every((r) => r && r.width > 0 && r.width <= 10 && r.height > 0 && r.height <= 10)) continue;
      if (mediaRect && rs[0].y < mediaRect.bottom - 20) continue;
      if (!rs.every((r, i) => Math.abs(r.width - rs[0].width) <= 2 &&
        Math.abs(r.height - rs[0].height) <= 2 && Math.abs(r.y - rs[0].y) <= 5 &&
        (!i || r.x >= rs[i - 1].right - 2))) continue;
      choices.push({ el, children, distance: mediaRect ? rs[0].y - mediaRect.bottom : 0 });
    }
    choices.sort((a, b) => a.distance - b.distance || b.children.length - a.children.length);
    if (!choices.length) return null;
    const chosen = choices[0];
    const dots = chosen.children.map((el, i) => {
      const s = getComputedStyle(el);
      return { index: i, classList: [...el.classList], opacity: s.opacity, background: s.backgroundColor, rect: rect(el) };
    });
    const signatures = dots.map((d) => JSON.stringify([d.classList, d.opacity, d.background]));
    const counts = new Map(signatures.map((s) => [s, signatures.filter((x) => x === s).length]));
    const differing = Math.max(...counts.values()) < 2 ? -1 :
      signatures.findIndex((signature) => counts.get(signature) === 1);
    return { rect: rect(chosen.el), childCount: dots.length, dots,
      differingIndex: differing < 0 ? null : differing };
  }

  function carouselSnapshot() {
    if (/^\/stories\//.test(location.pathname)) return null;
    const media = [...document.querySelectorAll('article img, article video, div[role="dialog"] img, div[role="dialog"] video')]
      .map((el) => ({ el, r: rect(el) })).filter(({ el, r }) => r && r.width >= 120 && r.height >= 120 && visible(el, r));
    media.sort((a, b) => {
      const distance = (r) => Math.hypot((r.x + r.width / 2 - innerWidth / 2) / innerWidth,
        (r.y + r.height / 2 - innerHeight / 2) / innerHeight);
      return distance(a.r) - distance(b.r);
    });
    if (!media.length) return { found: false };
    const centre = media[0];
    const container = centre.el.closest('div[role="dialog"]') || centre.el.closest('article');
    if (!container) return { found: false };
    const code = findShortcode(container), post = code && state.posts.get(code);
    const childBasenames = post ? carouselChildren(post) : [];
    const lists = [...container.querySelectorAll('ul')].map((el) => ({ el,
      slides: [...el.querySelectorAll(':scope > li')], r: rect(el) }))
      .filter((x) => x.slides.length >= 2 && x.slides.some((li) => li.querySelector('img, video')));
    lists.sort((a, b) => intersection(b.r, centre.r) - intersection(a.r, centre.r));
    const list = lists[0], clip = list ? clipRect(list.el, container) : rect(container);
    const slides = list ? list.slides.map((li, i) => {
      const r = rect(li), style = li.getAttribute('style') || '';
      return { index: i, inlineTransform: li.style.transform || null,
        inlineTranslate: li.style.translate || null,
        translateX: (style.match(/translateX\([^)]*\)/) || [])[0] || null,
        rect: r, insideVisibleRect: !!r && intersection(r, clip) >= r.width * r.height * 0.5,
        aria: ariaAttributes(li) };
    }) : [];
    let visibleSlide = null, bestArea = -1;
    if (list) for (let i = 0; i < list.slides.length; i++) {
      const li = list.slides[i], r = rect(li), area = intersection(r, clip);
      if (area > bestArea) { bestArea = area; visibleSlide = li; }
    }
    const slideMedia = visibleSlide && (visibleSlide.querySelector('video') || visibleSlide.querySelector('img')) || centre.el;
    const visibleBasename = slideMedia.tagName === 'VIDEO' ? basename(slideMedia.poster) :
      basename(slideMedia.currentSrc || slideMedia.src);
    const matchedIndex = visibleBasename && post ? carouselChildNames(post).findIndex((names) => names.includes(visibleBasename)) : -1;
    return { found: true, containerTag: container.tagName.toLowerCase(), containerRole: container.getAttribute('role'),
      containerRect: rect(container), shortcode: code, knownMedia: !!post, childImageBasenames: childBasenames,
      slideList: list ? { rect: list.r, visibleRect: clip, mountedCount: slides.length,
        aria: ariaAttributes(list.el), slides } : null,
      dots: dotRow(container, centre.r), visibleSlideBasename: visibleBasename,
      matchedIndex: matchedIndex < 0 ? null : matchedIndex };
  }

  function mark(label) {
    try {
      scanInline();
      const known = [...state.reels.values()];
      const snapshot = { label: String(label || 'mark-' + (state.marks.length + 1)).slice(0, 80),
        at: new Date().toISOString(), path: location.pathname,
        knownReelCount: known.length,
        knownReels: selectReels(known).map((r) => ({ id: r.id, owner: r.owner.username,
          itemCount: r.itemCount, why: r.why })),
        story: storySnapshot(), carousel: carouselSnapshot() };
      state.marks.push(snapshot);
      if (state.marks.length > 10) state.marks.shift();
      console.log('[IGFM STORY] marked', snapshot.label, 'reels:', known.length, 'items:', state.items.size);
      return snapshot;
    } catch (error) { console.warn('[IGFM STORY] mark failed', error); return null; }
  }

  function report() {
    try {
      scanInline();
      const ext = window.IGFM_INJECT;
      const extCache = ext && ext._mediaCache;
      const allItems = [...state.items.values()], allReels = [...state.reels.values()];
      const counts = { items: allItems.length,
        storyLikeItems: allItems.filter((e) => e.summary.storyLike).length,
        reels: allReels.length, reelsWithItems: allReels.filter((r) => r.itemCount > 0).length };
      const items = selectItems(allItems).map(({ summary }) => {
        const entry = summary.code && extCache && typeof extCache.get === 'function' ? extCache.get(summary.code) : null;
        return { ...summary, extensionCache: { extensionLoaded: !!ext,
          underCode: !!entry, samePk: entry ? String(entry.pk) === String(summary.pk) : null } };
      });
      const out = { version: VERSION, ua: navigator.userAgent, lang: navigator.language,
        armedAt: state.armedAt, counts, counters: { paths: state.counters, inline: state.inline },
        responses: state.responses.slice(-40), reels: selectReels(allReels), items,
        marks: state.marks.slice() };
      console.log('%cIGFM STORIES PROBE v' + VERSION, 'font-weight:bold');
      console.table([{ responsesSeen: Object.values(state.counters).reduce((n, c) => n + c.seen, 0),
        storyResponses: state.responses.length, reels: counts.reels, reelsWithItems: counts.reelsWithItems,
        items: counts.items, storyLikeItems: counts.storyLikeItems,
        inlineScripts: state.inline.seen, marks: state.marks.length }]);
      console.log('[IGFM STORY] report object:', out);
      return out;
    } catch (error) { console.warn('[IGFM STORY] report failed', error); return null; }
  }

  function save() {
    try {
      const out = report();
      if (!out) return null;
      const date = new Date(), pad = (n) => String(n).padStart(2, '0');
      const stamp = String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
        pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
      const filename = 'igfm-stories-probe-' + stamp + '.json';
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return filename;
    } catch (error) { console.warn('[IGFM STORY] save failed', error); return null; }
  }

  function arm() {
    if (state.armed) { scanInline(); return window.IGFM_STORY; }
    state.armed = true;
    state.armedAt = new Date().toISOString();
    installTap();
    scanInline();
    console.log('%c[IGFM STORY] armed — use mark(label), report(), save()', 'color:#0a0;font-weight:bold');
    return window.IGFM_STORY;
  }

  window.IGFM_STORY = { arm, mark, report, save };
  arm();
})();
