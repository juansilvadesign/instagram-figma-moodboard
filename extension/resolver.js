// resolver.js — Instagram media resolution for the moodboard capture MVP.
//
// Resolution chain (first success wins):
//   1. Post-page HTML embed — fetch /p/<shortcode>/ with the logged-in session's cookies and
//      parse the server-rendered <script type="application/json"> Relay blobs for
//      xdt_api__v1__media__shortcode__web_info. One code path covers image, video, and carousel,
//      and works no matter how the user is viewing the post (feed, modal, permalink).
//   2. GraphQL doc_id query — POST /graphql/query with the public web app id + csrf cookie.
//      doc_id values rot when Instagram rotates persisted queries (see CLAUDE.md).
//   3. DOM harvest (images only) — largest srcset candidates inside the clicked container.
//
// Runs as a classic content script (no ES modules in MV3 content_scripts); exposes one global,
// IGFM_RESOLVER, consumed by content.js. The pure helpers (parsers, normalizers, planDownloads)
// have no browser dependencies so test/run-tests.cjs can exercise them under Node — keep them that way.

const IGFM_RESOLVER = (() => {
  const SHORTCODE_RE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;
  const IG_APP_ID = '936619743392459'; // Instagram web client's public app id (stable for years)
  const GRAPHQL_DOC_ID = '8845758582119845'; // PolarisPostActionLoadPostQuery — rots; fallback path only
  const CAPTURE_FOLDER = 'instagram-captures';
  const FETCH_TIMEOUT_MS = 20000;

  const shortcodeFromUrl = (url) => {
    const m = SHORTCODE_RE.exec(url || '');
    return m ? m[1] : null;
  };

  function extractJsonBlobs(html) {
    const blobs = [];
    const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
      try {
        blobs.push(JSON.parse(m[1]));
      } catch {
        // not a JSON blob we care about
      }
    }
    return blobs;
  }

  // First value of `key` anywhere in a parsed JSON tree (Relay blobs nest it unpredictably).
  function deepFind(root, key) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key)) return node[key];
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return undefined;
  }

  const largest = (arr, widthOf) =>
    arr && arr.length ? arr.reduce((a, b) => (widthOf(b) > widthOf(a) ? b : a)) : null;

  // api/v1 shape (xdt_api__v1__media__shortcode__web_info.items[0]).
  // video_versions is checked first: video items also carry image_versions2 (the poster frame).
  function normalizeApiV1Item(item) {
    if (!item) return null;
    const leaf = (m) => {
      if (m.video_versions && m.video_versions.length) {
        const v = largest(m.video_versions, (x) => x.width || 0);
        return { type: 'video', url: v.url, width: v.width || 0 };
      }
      const candidates = m.image_versions2 && m.image_versions2.candidates;
      if (candidates && candidates.length) {
        const i = largest(candidates, (x) => x.width || 0);
        return { type: 'image', url: i.url, width: i.width || 0 };
      }
      // fallback to graphql fields just in case they are mixed
      if (m.is_video && m.video_url) {
        return { type: 'video', url: m.video_url, width: (m.dimensions && m.dimensions.width) || 0 };
      }
      const r = largest(m.display_resources, (x) => x.config_width || 0);
      const url = (r && r.src) || m.display_url;
      return url ? { type: 'image', url, width: (r && r.config_width) || 0 } : null;
    };
    const leaves = item.carousel_media && item.carousel_media.length
      ? item.carousel_media
      : (item.edge_sidecar_to_children && item.edge_sidecar_to_children.edges
        ? item.edge_sidecar_to_children.edges.map((e) => e.node)
        : [item]);
    const items = leaves.map(leaf).filter(Boolean);
    if (!items.length) return null;
    // Cover-only payloads (permalink embeds, some cache entries) null the children but keep
    // carousel_media_count AND media_type 8 / product_type carousel_container — either marks
    // the result PARTIAL so the caller keeps resolving instead of accepting the cover.
    const declared = Number(item.carousel_media_count) || 0;
    const isCarouselType =
      item.media_type === 8 || item.product_type === 'carousel_container' ||
      !!(item.carousel_media && item.carousel_media.length) || !!item.edge_sidecar_to_children;
    return {
      username: (item.user && item.user.username) || (item.owner && item.owner.username) || null,
      shortcode: item.code || item.shortcode || null,
      pk: (item.pk && String(item.pk)) || (item.id && String(item.id).split('_')[0]) || null,
      items,
      expectedCount: Math.max(declared, items.length),
      partial: items.length < declared || (isCarouselType && items.length < 2 && !declared),
      source: 'web_info',
    };
  }

  // GraphQL shape (xdt_shortcode_media / shortcode_media).
  function normalizeShortcodeMedia(media) {
    if (!media) return null;
    const leaf = (n) => {
      // support api/v1 style version keys if they are mixed into graphql nodes
      if (n.video_versions && n.video_versions.length) {
        const v = largest(n.video_versions, (x) => x.width || 0);
        return { type: 'video', url: v.url, width: v.width || 0 };
      }
      const candidates = n.image_versions2 && n.image_versions2.candidates;
      if (candidates && candidates.length) {
        const i = largest(candidates, (x) => x.width || 0);
        return { type: 'image', url: i.url, width: i.width || 0 };
      }
      // standard graphql fields
      if (n.is_video && n.video_url) {
        return { type: 'video', url: n.video_url, width: (n.dimensions && n.dimensions.width) || 0 };
      }
      const r = largest(n.display_resources, (x) => x.config_width || 0);
      const url = (r && r.src) || n.display_url;
      return url ? { type: 'image', url, width: (r && r.config_width) || 0 } : null;
    };
    const edges = media.edge_sidecar_to_children && media.edge_sidecar_to_children.edges;
    const nodes = edges && edges.length
      ? edges.map((e) => e.node)
      : (media.carousel_media && media.carousel_media.length ? media.carousel_media : [media]);
    const items = nodes.map(leaf).filter(Boolean);
    if (!items.length) return null;
    const declared = Number(media.carousel_media_count) || 0;
    const isCarouselType =
      media.__typename === 'GraphSidecar' || media.__typename === 'XDTGraphSidecar' ||
      media.media_type === 8 || media.product_type === 'carousel_container' ||
      !!(edges && edges.length) || !!(media.carousel_media && media.carousel_media.length);
    return {
      username: (media.owner && media.owner.username) || (media.user && media.user.username) || null,
      shortcode: media.shortcode || media.code || null,
      pk: (media.pk && String(media.pk)) || (media.id && String(media.id).split('_')[0]) || null,
      items,
      expectedCount: Math.max(declared, items.length),
      partial: items.length < declared || (isCarouselType && items.length < 2 && !declared),
      source: 'graphql',
    };
  }

  const safeSegment = (s) =>
    String(s || '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80);

  function extFromUrl(url, type) {
    let path = url || '';
    try {
      path = new URL(url).pathname;
    } catch {
      // keep raw string; the regex below anchors on the end anyway
    }
    const m = /\.([A-Za-z0-9]{2,4})$/.exec(path);
    const ext = m ? m[1].toLowerCase() : null;
    const known = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'mp4', 'm4v', 'mov'];
    return known.includes(ext) ? ext : type === 'video' ? 'mp4' : 'jpg';
  }

  // Normalized media → chrome.downloads plan. Usernames are case-insensitive on IG (lowercase
  // them); shortcodes are case-SENSITIVE (preserve, so a file can be traced back to its post URL).
  function planDownloads(media) {
    const user = safeSegment(media.username).toLowerCase() || 'instagram';
    const code = safeSegment(media.shortcode) || 'post';
    const many = media.items.length > 1;
    return media.items.map((item, i) => ({
      url: item.url,
      filename: `${CAPTURE_FOLDER}/${user}-${code}${many ? '-' + String(i + 1).padStart(2, '0') : ''}.${extFromUrl(item.url, item.type)}`,
    }));
  }

  // A post page embeds several JSON blobs; with deferred rendering the FIRST web_info can be
  // cover-only (carousel_media_count declared, children absent) while a LATER chunk carries
  // the children — so collect every candidate and keep the richest one for the target
  // shortcode. Pure (html in, media out) so tests can cover the cover-only permutations.
  const mediaScore = (m) => (m ? m.items.length * 10 + (m.items.some((i) => i.type === 'video') ? 1 : 0) : -1);

  function pickMediaFromHtml(html, shortcode) {
    const candidates = [];
    for (const blob of extractJsonBlobs(html)) {
      const before = candidates.length;
      const info = deepFind(blob, 'xdt_api__v1__media__shortcode__web_info');
      if (info && info.items) {
        for (const it of info.items) {
          const m = normalizeApiV1Item(it);
          if (m) candidates.push(m);
        }
      }
      const gm = normalizeShortcodeMedia(deepFind(blob, 'xdt_shortcode_media') || deepFind(blob, 'shortcode_media'));
      if (gm) candidates.push(gm);
      // Deferred patch chunks carry bare carousel children with no wrapping item. Only adopt
      // them for the target when the blob produced NO candidate of its own — a blob with its
      // own code-bearing media owns its carousel_media (could be a different post's).
      if (shortcode && candidates.length === before) {
        const cm = deepFind(blob, 'carousel_media');
        if (Array.isArray(cm) && cm.length >= 2) {
          const m = normalizeApiV1Item({ code: shortcode, carousel_media: cm });
          if (m) candidates.push(m);
        }
      }
    }
    const matching = shortcode ? candidates.filter((m) => m.shortcode === shortcode) : candidates;
    const pool = matching.length ? matching : candidates;
    let best = null;
    for (const m of pool) if (mediaScore(m) > mediaScore(best)) best = m;
    if (best && !best.username) {
      const withUser = pool.find((m) => m.username);
      if (withUser) best.username = withUser.username;
    }
    return best;
  }

  const isPartialCarousel = (m) => !!m && (!!m.partial || m.expectedCount > m.items.length);

  // ---- browser-only from here down (fetch/document/location) ----

  async function fetchPostHtmlMedia(shortcode) {
    const res = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`post page HTTP ${res.status}`);
    const media = pickMediaFromHtml(await res.text(), shortcode);
    if (!media) throw new Error('no media JSON in post page HTML (login wall or markup change?)');
    return media;
  }

  function csrfToken() {
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function fetchGraphqlMedia(shortcode) {
    const body = new URLSearchParams({
      variables: JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      }),
      doc_id: GRAPHQL_DOC_ID,
      server_timestamps: 'true',
    });
    const res = await fetch('https://www.instagram.com/graphql/query', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRFToken': csrfToken(),
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`graphql HTTP ${res.status}`);
    const json = await res.json();
    const media = normalizeShortcodeMedia(
      deepFind(json, 'xdt_shortcode_media') || deepFind(json, 'shortcode_media'),
    );
    if (!media) throw new Error('graphql returned no media (doc_id rotted? see CLAUDE.md)');
    return media;
  }

  // Completion fetch for a cover-only carousel: the app's own REST endpoint returns the FULL
  // item (all carousel children) given the media pk — which the cover payload carries. No
  // doc_id involved, so it survives persisted-query rotation.
  async function fetchMediaInfoByPk(pk) {
    const res = await fetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
      credentials: 'same-origin',
      headers: { 'X-IG-App-ID': IG_APP_ID, 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`media info HTTP ${res.status}`);
    const json = await res.json();
    const media = json && json.items && normalizeApiV1Item(json.items[0]);
    if (!media) throw new Error('media info returned no items');
    media.source = 'media_info';
    return media;
  }

  // Escalation chain for one shortcode. `seed` is an already-resolved (possibly partial)
  // in-page result: it contributes the pk and acts as the floor. Each step only runs while the
  // best result is still missing/partial; the richest wins; a full result short-circuits.
  async function fetchMediaByShortcode(shortcode, seed) {
    const errors = [];
    let best = seed || null;
    const consider = (m) => {
      if (!m) return;
      if (
        !best ||
        m.items.length > best.items.length ||
        (m.items.length === best.items.length && isPartialCarousel(best) && !isPartialCarousel(m))
      ) {
        best = m;
      }
    };
    if (!best || isPartialCarousel(best)) {
      try {
        consider(await fetchPostHtmlMedia(shortcode));
      } catch (e) {
        errors.push(`fetchPostHtmlMedia: ${(e && e.message) || e}`);
      }
    }
    if (best && isPartialCarousel(best) && best.pk) {
      try {
        consider(await fetchMediaInfoByPk(best.pk));
      } catch (e) {
        errors.push(`fetchMediaInfoByPk: ${(e && e.message) || e}`);
      }
    }
    if (!best || isPartialCarousel(best)) {
      try {
        consider(await fetchGraphqlMedia(shortcode));
      } catch (e) {
        errors.push(`fetchGraphqlMedia: ${(e && e.message) || e}`);
      }
    }
    if (best) {
      if (!best.shortcode) best.shortcode = shortcode;
      if (errors.length && isPartialCarousel(best)) {
        console.warn('[IGFM] resolution degraded — kept partial result:', errors.join(' | '));
      }
      return best;
    }
    throw new Error(errors.join(' | ') || 'no resolution source succeeded');
  }

  // Last resort, images only. Size filter skips avatars, highlight rings, and emoji images.
  function mediaFromDom(container, shortcode) {
    const picks = [];
    for (const img of container.querySelectorAll('img[srcset], img[src]')) {
      const r = img.getBoundingClientRect();
      if (r.width < 180 && r.height < 180) continue;
      let best = img.currentSrc || img.src;
      let bestW = 0;
      for (const part of (img.getAttribute('srcset') || '').split(',')) {
        const [u, w] = part.trim().split(/\s+/);
        const width = parseInt(w, 10) || 0;
        if (u && width >= bestW) {
          best = u;
          bestW = width;
        }
      }
      if (best && !picks.includes(best)) picks.push(best);
    }
    if (!picks.length) return null;
    const seg = (location.pathname.split('/')[1] || '').replace(/[^A-Za-z0-9._]/g, '');
    const username =
      seg && !['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts'].includes(seg)
        ? seg
        : null;
    return {
      username,
      shortcode,
      items: picks.map((url) => ({ type: 'image', url, width: 0 })),
      source: 'dom',
      partial: true,
    };
  }

  return {
    SHORTCODE_RE,
    CAPTURE_FOLDER,
    shortcodeFromUrl,
    extractJsonBlobs,
    deepFind,
    normalizeApiV1Item,
    normalizeShortcodeMedia,
    pickMediaFromHtml,
    isPartialCarousel,
    planDownloads,
    fetchMediaByShortcode,
    mediaFromDom,
  };
})();

globalThis.IGFM_RESOLVER = IGFM_RESOLVER;
