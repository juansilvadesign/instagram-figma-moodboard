// content.js — injects a download button into each Instagram post's action bar and runs the
// capture flow on click. Loaded after resolver.js (classic scripts, shared via globalThis).
//
// Uses EVENT DELEGATION — a single capture-phase click listener on `document` — instead of
// per-button listeners. Instagram is a recycling React SPA: a per-button listener dies whenever
// React re-renders the action bar subtree, and IG's own click handling can swallow the event.
// A delegated capture-phase listener survives re-renders and fires before IG's handlers.
// (Proven pattern from the twitter-video-downloader sibling.)
//
// DOM heuristics live in this file and are the part most likely to drift when Instagram changes
// its markup. NEVER match by aria-label text — labels follow the profile's UI language (this
// user's Chrome runs PT-BR: "Curtir", "Comentar", "Salvar"), so only structural selectors are safe.

console.log('[IGFM] content script loaded on', location.href);

const R = globalThis.IGFM_RESOLVER;

// Download glyph (same asset as the twitter-video-downloader sibling), fills follow currentColor.
const DL_PATHS =
  '<path fill="currentColor" d="M11.2419 15.1531L5.83239 9.86407L7.17053 8.54645L10.2929 11.6085V2.70996H12.1909V11.6085L15.3227 8.54645L16.6609 9.86407L11.2419 15.1531Z"/>' +
  '<path fill="currentColor" d="M19.7926 14.2249L19.7736 17.4818C19.7736 18.7623 18.7107 19.7923 17.401 19.7923H5.08255C3.76339 19.7923 2.70996 18.753 2.70996 17.4725V14.2249H4.60803V17.4725C4.60803 17.7323 4.81682 17.9365 5.08255 17.9365H17.401C17.6668 17.9365 17.8756 17.7323 17.8756 17.4725L17.8945 14.2249H19.7926Z"/>';

const dlSvg = (size) =>
  `<svg viewBox="0 0 23 23" width="${size}" height="${size}" fill="none" aria-hidden="true">${DL_PATHS}</svg>`;

function findShortcode(container) {
  // Prefer canonical page signals over scanning DOM links. On a permalink/reel the clicked
  // container can be a broad <main> holding unrelated links, and a reel's /reels/audio/<id>/
  // attribution link sits BEFORE its own link — a link scan grabbed "audio" and the download
  // failed (2026-07-14). The address bar + <link rel=canonical> / og:url carry the post's OWN
  // code with no DOM-order fragility.
  const canonical = document.querySelector('link[rel="canonical"]');
  const og = document.querySelector('meta[property="og:url"]');
  const fromPage =
    R.shortcodeFromUrl(location.pathname) ||
    (canonical && R.shortcodeFromUrl(canonical.getAttribute('href'))) ||
    (og && R.shortcodeFromUrl(og.getAttribute('content')));
  if (fromPage) return fromPage;
  // Feed / multi-post surfaces have no single canonical post — scan THIS container's links
  // (scoped to the clicked card; shortcodeFromUrl skips the audio-attribution trap).
  for (const a of container.querySelectorAll('a[href]')) {
    const code = R.shortcodeFromUrl(a.getAttribute('href'));
    if (code) return code;
  }
  return null;
}

const hasPostMedia = (container) => !!container.querySelector('video, img');

// Action bar = innermost <section> holding ≥2 aria-labelled svg icons (like/comment/share/save
// in any locale) and no comment form. The form check also rejects page-level wrapper sections.
function findActionBar(container) {
  const matches = [...container.querySelectorAll('section')].filter((s) => {
    if (s.querySelector('textarea, form')) return false;
    let labeledSvgs = 0;
    for (const svg of s.querySelectorAll('svg')) {
      let curr = svg;
      while (curr && curr !== s) {
        if (curr.hasAttribute('aria-label')) {
          labeledSvgs++;
          break;
        }
        curr = curr.parentElement;
      }
    }
    return labeledSvgs >= 2;
  });
  return matches.find((s) => !matches.some((o) => o !== s && s.contains(o))) || null;
}

function inject(container) {
  if (container.querySelector('.igfm-btn')) return; // self-healing: re-inject only if missing
  if (!hasPostMedia(container) || !findShortcode(container)) return; // not a post card

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'igfm-btn';
  btn.title = 'Download post media';
  btn.setAttribute('aria-label', 'Download post media');
  btn.innerHTML = dlSvg(24);

  const bar = findActionBar(container);
  const rail = bar ? null : findReelRail(container);
  if (bar) {
    // Append as the section's LAST child: the action-bar section IS the flex row (Like/Comment/
    // Repost/Share left, Save pushed right — live DOM 2026-07-08), so this lands right of Save.
    // Do NOT append into "the first child holding an svg" — that nests it inside the Like span.
    const wrap = document.createElement('div');
    wrap.className = 'igfm-wrap';
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  } else if (rail) {
    injectIntoRail(rail, btn);
  } else {
    btn.classList.add('igfm-overlay');
    container.classList.add('igfm-anchor');
    container.appendChild(btn);
  }
}

// The fullscreen Reels viewer renders its actions as a VERTICAL rail (a <div>, not a <section>),
// so findActionBar misses it and the button never appears (reported 2026-07-14 on /reel/<code>/).
// Find the rail STRUCTURALLY — never by aria-label TEXT (gotcha #2, locale) — as the element that
// is the common grandparent of the most icon action buttons (each item is wrapper > [role=button]
// > svg[aria-label], per the live DOM). Majority-vote so a differently-nested item can't fool it.
function findReelRail(container) {
  const counts = new Map();
  for (const b of container.querySelectorAll('[role="button"]')) {
    if (!b.querySelector('svg[aria-label]')) continue;
    const railEl = b.parentElement && b.parentElement.parentElement; // button → item wrapper → rail
    if (railEl) counts.set(railEl, (counts.get(railEl) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [railEl, n] of counts) {
    if (n > bestN) {
      best = railEl;
      bestN = n;
    }
  }
  return bestN >= 3 ? best : null; // Like/Comment/Share/Save/More — a real action rail
}

function injectIntoRail(rail, btn) {
  // Place before the LAST icon item (the "…" more menu). The trailing audio-thumb/spacer has no
  // svg[aria-label], so it's excluded — this lands us right after Save without naming any label,
  // and is naturally immune to the Save→Remove label flip. Inherit the item's spacing from a live
  // sibling's class (the x… classes are build-hashed and rotate between IG deploys — copy, never
  // hard-code), then re-anchor fresh each scan (React swaps the whole column between reels).
  const items = [...rail.children].filter((c) => c.querySelector('svg[aria-label]'));
  const anchor = items[items.length - 1] || null; // the "…" menu, or end if none
  const wrap = document.createElement('div');
  if (anchor) wrap.className = anchor.className;
  wrap.classList.add('igfm-wrap', 'igfm-rail-item');
  wrap.appendChild(btn);
  rail.insertBefore(wrap, anchor); // before the "…" menu → right after Save
}

// Feed + modal posts render as <article> (modals contain one). Fallbacks: a post modal without
// an <article>, then a permalink page whose URL carries the shortcode. Profile grids get nothing
// by design — clicking a tile opens the modal, which gets the button.
function postContainers() {
  const found = [...document.querySelectorAll('article')];
  for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
    if (!dialog.querySelector('article')) found.push(dialog);
  }
  if (!found.length) {
    const main = document.querySelector('main');
    if (main && R.shortcodeFromUrl(location.pathname)) found.push(main);
  }
  return found;
}

function scan() {
  for (const c of postContainers()) inject(c);
  try {
    injectProfileButton(); // v2: adds/removes the fixed profile-capture control on SPA nav
  } catch (e) {
    console.warn('[IGFM] profile button injection failed:', e);
  }
}

function toast(text, kind = '') {
  let el = document.getElementById('igfm-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'igfm-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'igfm-toast' + (kind ? ' igfm-toast-' + kind : '') + ' igfm-show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('igfm-show'), 4500);
}

// Ask the MAIN-world inject.js to pull this post's media object out of the page — its
// network-response cache first (feed/modal GraphQL carries the full carousel), then embedded
// JSON blobs, then React fiber props. Details are JSON STRINGS both ways (object details don't
// reliably cross Chrome's isolated/MAIN world boundary); the container is handed over via a
// data-igfm-req attribute because the DOM is shared across worlds even though JS objects are
// not. The raw media object comes back as plain JSON and is normalized HERE (inject.js has no
// resolver).
function fetchMediaFromReact(container, shortcode) {
  return new Promise((resolve) => {
    const reqId = 'igfm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (media) => {
      if (done) return;
      done = true;
      document.removeEventListener('igfm-response-react', onResponse);
      clearTimeout(timer);
      try {
        container.removeAttribute('data-igfm-req');
      } catch {
        // container may be `document` or already gone
      }
      resolve(media);
    };
    const onResponse = (e) => {
      let d = e && e.detail;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch {
          d = null;
        }
      }
      if (!d || d.reqId !== reqId) return;
      // stats logged as a JSON string so console-scraping tools capture them fully
      if (d.error) console.warn('[IGFM] page extraction error:', d.error, JSON.stringify(d.stats || {}));
      else console.log('[IGFM] page extraction:', d.via || 'no-hit', JSON.stringify(d.stats || {}));
      if (!d.media) return finish(null);
      let media = null;
      try {
        media = R.normalizeShortcodeMedia(d.media) || R.normalizeApiV1Item(d.media);
      } catch (err) {
        console.warn('[IGFM] page media normalization failed:', err);
      }
      if (media) {
        const via = d.via || '';
        media.source = via === 'network_cache' || via === 'embedded_json' ? via : 'react_fiber';
        if (!media.shortcode) media.shortcode = shortcode || null;
      }
      finish(media);
    };
    document.addEventListener('igfm-response-react', onResponse);
    const timer = setTimeout(() => finish(null), 1600);
    try {
      container.setAttribute('data-igfm-req', reqId);
    } catch {
      // non-element container — inject.js will fall back to a shortcode search
    }
    document.dispatchEvent(
      new CustomEvent('igfm-request-react', {
        detail: JSON.stringify({ reqId, shortcode: shortcode || null }),
      }),
    );
  });
}

async function runDownload(btn) {
  if (btn.dataset.busy) return;
  // Resolve at CLICK time from the button's current container — on SPA navigation a permalink
  // <main> persists across posts, so anything captured at inject time can go stale.
  const container = btn.closest('article, div[role="dialog"], main') || document;
  // May be null: some sponsored posts carry no /p/ permalink — the fiber path still works
  // (it matches by container, and the found media object brings its own code).
  const shortcode = findShortcode(container);
  // single-string log (not multi-arg) so console-scraping tools capture the shortcode reliably
  console.log(`[IGFM] button clicked — shortcode=${shortcode || '(none — sponsored post?)'}`);
  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  toast('Resolving post media…');
  try {
    let media = null;
    let notice = '';

    // First attempt: resolve inside the page (network-response cache → embedded JSON → React
    // fibers). Instant, no extra requests; the only path that works for sponsored posts and
    // deferred feed carousels — /p/<code>/ embeds are cover-only for those.
    try {
      media = await fetchMediaFromReact(container, shortcode);
    } catch (e) {
      console.warn('[IGFM] React Fiber extraction failed:', e);
    }

    // Second attempt: the API escalation chain (post HTML → /api/v1/media/<pk>/info/ →
    // GraphQL). Runs when there's no in-page hit OR the hit still needs completing — a partial
    // carousel, OR a lone image from an untrusted source that could be a masked ad-carousel
    // cover (cold permalink embeds lie: media_type 1 + null count on a real 8-slide carousel).
    // The in-page result seeds the chain — it contributes the pk and stays as the floor.
    if (shortcode && (!media || R.needsCompletion(media))) {
      try {
        const fetched = await R.fetchMediaByShortcode(shortcode, media || null);
        if (fetched) media = fetched;
      } catch (e) {
        console.warn('[IGFM] API resolution failed:', (e && e.message) || e);
      }
    }

    // Last resort: harvest rendered images from the clicked container.
    if (!media) {
      media = R.mediaFromDom(container, shortcode);
      if (media) notice = ' — DOM fallback, images only';
    }

    if (!media) throw new Error('no downloadable media found');
    if (R.isPartialCarousel(media)) {
      const total = media.expectedCount > media.items.length ? media.expectedCount : '?';
      notice = ` — ${media.items.length} of ${total} slides (Instagram withheld the rest)`;
    }
    const items = R.planDownloads(media);
    console.log(`[IGFM] media resolved via ${media.source}:`, items);
    const res = await chrome.runtime.sendMessage({ type: 'igfm-download', items });
    console.log('[IGFM] background response:', res);
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response from background (service worker alive?)');
    const skipped = res.failed ? ` (${res.failed} failed)` : '';
    btn.classList.add('igfm-done');
    toast(`Saved ${res.saved} file${res.saved === 1 ? '' : 's'} → Downloads/${R.CAPTURE_FOLDER}/${skipped}${notice}`, 'ok');
    setTimeout(() => btn.classList.remove('igfm-done'), 2500);
  } catch (e) {
    console.error('[IGFM] capture error:', e);
    btn.classList.add('igfm-error');
    toast('Capture failed: ' + ((e && e.message) || e), 'err');
    setTimeout(() => btn.classList.remove('igfm-error'), 4500);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('igfm-loading');
  }
}

// ---- v2: whole-profile crawl ------------------------------------------------

// The profile button is FIXED-POSITION, not injected into Instagram's header. The header is
// another bespoke surface whose structure would need its own archaeology (findActionBar missed
// the Reels rail entirely — gotcha #16 — and cost a round of live debugging). A fixed control
// has no DOM heuristic to drift, and it reads as OUR tool rather than as Instagram chrome.
function injectProfileButton() {
  const C = globalThis.IGFM_CRAWLER;
  const onProfile = !!C.profileHandleFromPath(location.pathname);
  const existing = document.querySelector('.igfm-profile-btn');
  if (!onProfile) {
    if (existing) existing.remove(); // SPA nav away from a profile
    return;
  }
  if (existing) return;
  const btn = document.createElement('button');
  btn.className = 'igfm-profile-btn';
  btn.type = 'button';
  btn.title = 'Capture this profile into Downloads/instagram-captures/<handle>/ (shift-click: every carousel slide)';
  btn.innerHTML = `${dlSvg(16)}<span>Capture profile</span>`;
  document.body.appendChild(btn);
}

async function sendPlan(items) {
  if (!items.length) return { ok: true, saved: 0, failed: 0 };
  const res = await chrome.runtime.sendMessage({ type: 'igfm-download', items });
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response from background');
  return res;
}

async function runProfileCrawl(btn, full) {
  if (btn.dataset.busy) return;
  const C = globalThis.IGFM_CRAWLER;
  const handle = C.profileHandleFromPath(location.pathname);
  if (!handle) return toast('Not a profile page', 'err');

  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  const limit = C.DEFAULT_LIMIT;
  console.log(`[IGFM] profile crawl start — handle=${handle} limit=${limit} mode=${full ? 'full' : 'covers'}`);
  try {
    // 1. Scroll the grid. This both reveals the links we read ORDER from and makes the PAGE issue
    //    its own pagination requests, which inject.js's tap caches — so resolution below is free.
    toast(`Reading @${handle}'s grid…`);
    const all = await C.scrollUntil(limit, (n, t) => toast(`Reading grid… ${n}/${t}`));
    const codes = all.slice(0, limit);
    if (!codes.length) throw new Error('no posts found on this grid');

    const entries = [];
    const skipped = [];
    let saved = 0;
    let profile = null;

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      // The tap already holds this post (probe 2026-07-17: 27/27 grid posts cached, carousels
      // complete). fetchMediaFromReact hits mediaCache first and returns without a request; the
      // hardened escalation chain only runs if this specific post was somehow missed.
      let media = null;
      try {
        media = await fetchMediaFromReact(document, code);
      } catch (e) {
        console.warn('[IGFM] in-page lookup failed for', code, e);
      }
      if (!media || R.needsCompletion(media)) {
        try {
          const fetched = await R.fetchMediaByShortcode(code, media || null);
          if (fetched) media = fetched;
        } catch (e) {
          console.warn('[IGFM] escalation failed for', code, (e && e.message) || e);
        }
      }
      if (!media || !media.items.length) {
        skipped.push({ shortcode: code, reason: 'unresolved' });
        toast(`${i + 1}/${codes.length} — skipped ${code}`);
        continue;
      }
      if (!media.shortcode) media.shortcode = code;
      if (!profile) profile = C.profileFromMedia(media.user);

      const plan = C.intoHandleFolder(C.planPost(media, { full }), handle);
      const res = await sendPlan(plan);
      saved += res.saved || 0;
      entries.push(C.captureEntry(media, plan));
      toast(`Captured ${i + 1} of ${codes.length}…`);

      // Randomized 5–10s. Paces the media downloads AND the page's own pagination traffic.
      if (i < codes.length - 1) await C.sleep(C.nextDelayMs());
    }

    // 2. Avatar (one image, no delay — a single CDN file).
    if (profile && profile.avatar_url) {
      try {
        const aplan = C.planAvatar(profile.avatar_url, handle);
        await sendPlan(aplan);
        profile.avatar_file = aplan[0].filename.split('/').pop();
        saved += 1;
      } catch (e) {
        console.warn('[IGFM] avatar download failed:', e);
      }
    }

    // 3. capture.json — the placement engine's contract. `posts` is in FEED ORDER (grid order),
    //    which buildManifest({feedOrder}) trusts over its pk fallback. Overwrites so a re-capture
    //    can't leave a stale 'capture (1).json' the CLI would ignore.
    const capture = C.buildCaptureJson({
      handle, date: new Date().toISOString().slice(0, 10), full, limit,
      profile, entries, skipped,
    });
    await sendPlan([{
      url: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(capture, null, 2)),
      filename: `${R.CAPTURE_FOLDER}/${handle}/capture.json`,
      conflictAction: 'overwrite',
    }]);

    btn.classList.add('igfm-done');
    const miss = skipped.length ? ` (${skipped.length} skipped)` : '';
    toast(`Captured ${entries.length} posts → Downloads/${R.CAPTURE_FOLDER}/${handle}/${miss}`, 'ok');
    console.log('[IGFM] profile crawl done:', JSON.stringify({ handle, posts: entries.length, saved, skipped: skipped.length }));
    setTimeout(() => btn.classList.remove('igfm-done'), 3000);
  } catch (e) {
    console.error('[IGFM] profile crawl error:', e);
    btn.classList.add('igfm-error');
    toast('Profile capture failed: ' + ((e && e.message) || e), 'err');
    setTimeout(() => btn.classList.remove('igfm-error'), 4500);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('igfm-loading');
  }
}

// One delegated, capture-phase handler — robust to React re-renders and IG's own click handlers.
document.addEventListener(
  'click',
  (e) => {
    const profileBtn = e.target.closest?.('.igfm-profile-btn');
    if (profileBtn) {
      e.preventDefault();
      e.stopPropagation();
      runProfileCrawl(profileBtn, e.shiftKey); // shift = every carousel slide, not just covers
      return;
    }
    const btn = e.target.closest?.('.igfm-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    runDownload(btn);
  },
  true,
);

const debounce = (fn, ms) => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
};
new MutationObserver(debounce(scan, 300)).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
scan();
console.log('[IGFM] content script initialized (delegated click + observer active)');
