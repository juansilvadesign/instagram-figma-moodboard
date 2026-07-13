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
    return {
      username: (item.user && item.user.username) || (item.owner && item.owner.username) || null,
      shortcode: item.code || item.shortcode || null,
      items,
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
    return {
      username: (media.owner && media.owner.username) || (media.user && media.user.username) || null,
      shortcode: media.shortcode || media.code || null,
      items,
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

  // ---- browser-only from here down (fetch/document/location) ----

  async function fetchPostHtmlMedia(shortcode) {
    const res = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`post page HTTP ${res.status}`);
    const blobs = extractJsonBlobs(await res.text());
    for (const blob of blobs) {
      const info = deepFind(blob, 'xdt_api__v1__media__shortcode__web_info');
      const media = info && info.items && normalizeApiV1Item(info.items[0]);
      if (media) return media;
    }
    // some renders embed the GraphQL shape instead
    for (const blob of blobs) {
      const gMedia = deepFind(blob, 'xdt_shortcode_media') || deepFind(blob, 'shortcode_media');
      const media = normalizeShortcodeMedia(gMedia);
      if (media) return media;
    }
    throw new Error('no media JSON in post page HTML (login wall or markup change?)');
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

  async function fetchMediaByShortcode(shortcode) {
    const errors = [];
    for (const attempt of [fetchPostHtmlMedia, fetchGraphqlMedia]) {
      try {
        const media = await attempt(shortcode);
        if (!media.shortcode) media.shortcode = shortcode;
        return media;
      } catch (e) {
        errors.push(`${attempt.name}: ${(e && e.message) || e}`);
      }
    }
    throw new Error(errors.join(' | '));
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
    planDownloads,
    fetchMediaByShortcode,
    mediaFromDom,
  };
})();

globalThis.IGFM_RESOLVER = IGFM_RESOLVER;
