// crawler.js — v2 profile crawl (ISOLATED world; loaded after resolver.js, before content.js).
//
// Enumerates a profile's most recent posts and downloads their grid COVERS into
// Downloads/instagram-captures/<handle>/, plus a capture.json the placement engine consumes
// (placement/PLACEMENT.md). Attaches IGFM_CRAWLER to globalThis.
//
// The pure half (link parsing, ordering, download planning, capture.json shaping) has no browser
// dependencies so test/run-tests.cjs can exercise it under Node — keep it that way. The DOM half
// (scrolling, the header read) can only be verified in a real logged-in Chrome (blocker B4).
//
// WHY THIS MAKES ALMOST NO REQUESTS OF ITS OWN (probe-verified 2026-07-17 on @solarity.studio):
// the page fetches its own post data as you scroll, and inject.js's tap already caches it — all
// 27 of 27 grid posts were present, carousels complete (children == count_declared) and every
// video carrying a poster. So the crawl reads media from the tap via the existing bridge and the
// ONLY network it performs is the media downloads themselves.

const IGFM_CRAWLER = (() => {
  const R = globalThis.IGFM_RESOLVER;
  const DEFAULT_LIMIT = 24; // the Figma template's grid capacity (placement/PLACEMENT.md)
  const DELAY_MIN_MS = 5000; // randomized 5–10s: fixed intervals are themselves a bot signal
  const DELAY_MAX_MS = 10000;
  const SCROLL_SETTLE_MS = 1200;
  const MAX_SCROLL_ROUNDS = 60;

  const POST_HREF_RE = /\/(?:p|reel)\/([A-Za-z0-9_-]{5,})/;

  // ---- pure helpers ------------------------------------------------------

  // Feed order comes from the DOM grid and NOTHING ELSE.
  //  - Not the tap's cache: collectMedia is a stack DFS (push 0..N then pop), so it REVERSES every
  //    array it walks — verified 2026-07-17, cache order was exactly reverse(grid). Instagram
  //    returns feed order correctly; our ingest scrambles it.
  //  - Not shortcode/pk order: a PINNED post is chronologically old but visually FIRST. Live proof
  //    on @solarity.studio — the pinned post was the OLDEST of 12 (pk rank 12/12) at grid slot 1.
  // The grid list is therefore both the ORDER and the FILTER: the cache also holds media from
  // suggested/related rails (31 cached vs 27 on the grid), which must never reach the moodboard.
  function codesFromHrefs(hrefs) {
    const out = [];
    const seen = new Set();
    for (const h of hrefs || []) {
      const m = POST_HREF_RE.exec(String(h || ''));
      if (!m) continue;
      const code = m[1];
      // gotcha #15 decoys: /reels/audio/<numericId>/ attribution links, never a post
      if (code === 'audio' || /^\d+$/.test(code)) continue;
      if (seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
    return out;
  }

  /** `/solarity.studio/` -> `solarity.studio`; null for non-profile paths (/p/, /reel/, /explore…). */
  const RESERVED = new Set([
    'p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts',
    'about', 'legal', 'developer', 'api', 'graphql', 'your_activity',
  ]);
  function profileHandleFromPath(pathname) {
    const segs = String(pathname || '').split('/').filter(Boolean);
    if (segs.length !== 1) return null; // /<handle>/ only — /<handle>/reels/ etc. is not the grid
    const h = segs[0];
    if (RESERVED.has(h.toLowerCase())) return null;
    return /^[A-Za-z0-9._]+$/.test(h) ? h : null;
  }

  // Covers-only names the file WITHOUT a -NN suffix, and that is load-bearing rather than
  // cosmetic: planDownloads only suffixes a multi-item post, so placement/manifest.cjs folds a
  // LONE '-01' back into the shortcode (it reads it as a code whose tail looks like an index).
  // A cover saved as '<user>-<code>-01.jpg' would therefore be placed as post '<code>-01'.
  // Reusing planDownloads with a single synthetic item gives the plain name for free.
  function planPost(media, opts) {
    const full = !!(opts && opts.full);
    if (full) return R.planDownloads(media);
    const first = media.items[0];
    if (!first) return [];
    // A video's cover is its POSTER — a Figma image fill can't hold an .mp4, and the poster is
    // already in the data (resolver `poster`), so no ffmpeg is needed on this path.
    const cover = first.type === 'video' && first.poster
      ? { type: 'image', url: first.poster, width: 0 }
      : first;
    return R.planDownloads({ ...media, items: [cover] });
  }

  const seg = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);

  // planDownloads writes into `instagram-captures/`; a profile crawl nests one level deeper so
  // that ONE FOLDER = ONE CAPTURE, which is what the placement engine reads.
  function intoHandleFolder(plan, handle) {
    const dir = `${R.CAPTURE_FOLDER}/${seg(handle)}/`;
    return (plan || []).map((p) => ({
      ...p,
      filename: String(p.filename).replace(`${R.CAPTURE_FOLDER}/`, dir),
    }));
  }

  // The avatar is deliberately named with a LEADING UNDERSCORE and no hyphen. placement/
  // manifest.cjs parses post files as '<user>-<code>[-NN].<ext>' and skips any name without a
  // username/shortcode hyphen split — so '_avatar.jpg' can never be mistaken for a post and
  // placed on the grid. '<handle>-avatar.jpg' WOULD parse, as a post with shortcode "avatar".
  function planAvatar(url, handle) {
    if (!url) return [];
    let ext = 'jpg';
    try {
      const m = /\.([A-Za-z0-9]{2,4})$/.exec(new URL(url, 'https://x/').pathname);
      if (m && ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(m[1].toLowerCase())) ext = m[1].toLowerCase();
    } catch { /* keep jpg */ }
    return [{ url, filename: `${R.CAPTURE_FOLDER}/${seg(handle)}/_avatar.${ext}` }];
  }

  /** One capture.json entry. `pinned` is informational — feed order already encodes the position. */
  function captureEntry(media, plan) {
    return {
      shortcode: media.shortcode || null,
      type: media.expectedCount > 1 ? 'carousel' : (media.items[0] && media.items[0].type) || 'image',
      items: media.expectedCount || media.items.length,
      pinned: !!media.pinned,
      partial: !!media.partial,
      cover: (plan[0] && plan[0].filename.split('/').pop()) || null,
      files: plan.map((p) => p.filename.split('/').pop()),
    };
  }

  /**
   * The crawler's contract with the placement engine. `posts` is in FEED ORDER, which
   * buildManifest({feedOrder}) treats as authoritative over its pk fallback.
   */
  function buildCaptureJson(o) {
    const opts = o || {};
    return {
      handle: opts.handle || null,
      captured_at: opts.date || null,
      source: 'profile-crawl',
      mode: opts.full ? 'full' : 'covers',
      limit: opts.limit == null ? DEFAULT_LIMIT : opts.limit,
      profile: opts.profile || null,
      // Feed order, pinned-first — read off the DOM grid, not the cache and not pk order.
      posts: opts.entries || [],
      skipped: opts.skipped || [],
    };
  }

  /** Randomized pacing. `rnd` is injectable so tests aren't flaky. */
  function nextDelayMs(rnd) {
    const r = typeof rnd === 'function' ? rnd() : Math.random();
    return Math.round(DELAY_MIN_MS + r * (DELAY_MAX_MS - DELAY_MIN_MS));
  }

  // What the profile header offers without any extra request. full_name / avatar ride along on
  // the media the tap already cached (`item.user`); bio, external_url and the follower/following
  // counts do NOT — they live in the profile payload, which the tap discards (it only keeps
  // objects that looksLikeMedia). Those stay null and the placement agent simply skips them,
  // leaving the template's own text in place. See PLACEMENT.md → Not built yet.
  function profileFromMedia(rawUser) {
    if (!rawUser) return null;
    return {
      username: rawUser.username || null,
      display_name: rawUser.full_name || null,
      avatar_url: rawUser.profile_pic_url_hd || rawUser.profile_pic_url || null,
      is_verified: !!rawUser.is_verified,
      biography: null,
      external_url: null,
      posts_count: null,
      followers: null,
      following: null,
    };
  }

  // ---- DOM half (not Node-testable — verify in Chrome, blocker B4) -------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gridCodes() {
    return codesFromHrefs(
      [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')]
        .map((a) => a.getAttribute('href')),
    );
  }

  /**
   * Scroll until `limit` unique post links are mounted or the grid stops growing. Instagram
   * virtualizes the grid, so this both TRIGGERS the page's own pagination (which the tap then
   * caches) and reveals the links we read order from.
   */
  async function scrollUntil(limit, onProgress) {
    let codes = gridCodes();
    let stalls = 0;
    for (let i = 0; i < MAX_SCROLL_ROUNDS && codes.length < limit; i++) {
      const before = codes.length;
      window.scrollBy(0, window.innerHeight * 2);
      await sleep(SCROLL_SETTLE_MS);
      codes = gridCodes();
      if (onProgress) onProgress(Math.min(codes.length, limit), limit);
      // The grid can legitimately be shorter than the limit — stop rather than spin.
      if (codes.length === before) {
        if (++stalls >= 3) break;
      } else {
        stalls = 0;
      }
    }
    return codes;
  }

  return {
    DEFAULT_LIMIT,
    DELAY_MIN_MS,
    DELAY_MAX_MS,
    POST_HREF_RE,
    codesFromHrefs,
    profileHandleFromPath,
    intoHandleFolder,
    planAvatar,
    planPost,
    captureEntry,
    buildCaptureJson,
    nextDelayMs,
    profileFromMedia,
    gridCodes,
    scrollUntil,
    sleep,
  };
})();

globalThis.IGFM_CRAWLER = IGFM_CRAWLER;
