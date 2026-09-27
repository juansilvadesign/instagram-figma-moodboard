// resolver.js — Instagram media resolution for the moodboard capture MVP.
//
// Escalation chain (fetchMediaByShortcode; richest / most-complete result wins), seeded by the
// in-page result content.js already resolved:
//   1. Post-page HTML embed — fetch /p/<shortcode>/ and parse the server-rendered
//      <script type="application/json"> Relay blobs for xdt_api__v1__media__shortcode__web_info.
//      Skipped when the seed is already a usable single media that just needs pk-confirmation.
//   2. Media-info REST completion — GET /api/v1/media/<pk>/info/. Authoritative: an ad-carousel
//      viewed cold advertises media_type 1 + null carousel_media_count in its EMBEDDED cover
//      (the cover lies), so a lone image from an untrusted source (embed/HTML/fiber) must be
//      confirmed here — media/info returns the true media_type 8 + all children. No doc_id to rot.
//   3. GraphQL doc_id query — POST /graphql/query with the public web app id + csrf cookie.
//      doc_id values rot when Instagram rotates persisted queries (see CLAUDE.md).
//   4. DOM harvest (images only) — largest srcset candidates inside the clicked container.
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
  const RESERVED_HANDLES = new Set([
    'p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts',
    'about', 'legal', 'developer', 'api', 'graphql', 'your_activity', 'highlights',
  ]);

  // /reels/audio/<numericId>/ is an AUDIO-attribution link, NOT a post — its "audio" slug (5
  // chars, matches the code pattern) and numeric audio/collection ids must never be taken as a
  // shortcode. This bit reel pages 2026-07-14: the audio link precedes the reel's own link in DOM
  // order, so a naive first-match link scan captured "audio" and every lookup missed → images-only
  // DOM fallback, no .mp4. Scan ALL matches and skip the traps; real shortcodes are mixed
  // alphanumeric (they always contain letters).
  const shortcodeFromUrl = (url) => {
    const re = new RegExp(SHORTCODE_RE.source, 'g'); // local copy — never mutate the exported const's lastIndex
    let m;
    while ((m = re.exec(url || ''))) {
      const code = m[1];
      if (code === 'audio' || /^\d+$/.test(code)) continue;
      return code;
    }
    return null;
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

  function basenameFromUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try { return new URL(url).pathname.split('/').pop() || null; } catch { return null; }
  }

  function imageNames(m) {
    const urls = [];
    const candidates = m.image_versions2 && m.image_versions2.candidates;
    if (Array.isArray(candidates)) for (const c of candidates) urls.push(c.url);
    if (Array.isArray(m.display_resources)) for (const r of m.display_resources) urls.push(r.src);
    urls.push(m.display_url, m.thumbnail_src);
    return [...new Set(urls.map(basenameFromUrl).filter(Boolean))];
  }

  // api/v1 shape (xdt_api__v1__media__shortcode__web_info.items[0]).
  // The poster frame that accompanies a video (image_versions2 / display_resources). Carried on
  // video items as `poster` so a caller that needs a PLACEABLE still — the v2 profile crawl saves
  // grid covers, and a Figma image fill can't hold an .mp4 — never has to re-derive it or fall
  // back to ffmpeg. Verified live 2026-07-17: every video on a profile grid ships a poster.
  const posterOf = (m) => {
    const candidates = m.image_versions2 && m.image_versions2.candidates;
    if (candidates && candidates.length) return largest(candidates, (x) => x.width || 0).url || null;
    const r = largest(m.display_resources, (x) => x.config_width || 0);
    return (r && r.src) || m.display_url || m.thumbnail_src || null;
  };

  // A post pinned to the top of a profile grid. Field name verified live 2026-07-17 (probe on
  // @solarity.studio): the key exists on every item but is only NON-EMPTY on the pinned one.
  const isPinned = (m) =>
    Array.isArray(m.timeline_pinned_user_ids) && m.timeline_pinned_user_ids.length > 0;

  // video_versions is checked first: video items also carry image_versions2 (the poster frame).
  function normalizeApiV1Item(item) {
    if (!item) return null;
    const leaf = (m) => {
      if (m.video_versions && m.video_versions.length) {
        const v = largest(m.video_versions, (x) => x.width || 0);
        return { type: 'video', url: v.url, width: v.width || 0, poster: posterOf(m), names: imageNames(m) };
      }
      const candidates = m.image_versions2 && m.image_versions2.candidates;
      if (candidates && candidates.length) {
        const i = largest(candidates, (x) => x.width || 0);
        return { type: 'image', url: i.url, width: i.width || 0, names: imageNames(m) };
      }
      // fallback to graphql fields just in case they are mixed
      if (m.is_video && m.video_url) {
        return { type: 'video', url: m.video_url, width: (m.dimensions && m.dimensions.width) || 0,
          poster: posterOf(m), names: imageNames(m) };
      }
      const r = largest(m.display_resources, (x) => x.config_width || 0);
      const url = (r && r.src) || m.display_url;
      return url ? { type: 'image', url, width: (r && r.config_width) || 0, names: imageNames(m) } : null;
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
      // The raw author object rides along so the v2 profile crawl can read the display name and
      // avatar from media the tap ALREADY cached, instead of scraping the header DOM or spending
      // a request. Consumers must treat every field as optional — shape not probe-verified.
      user: item.user || item.owner || null,
      shortcode: item.code || item.shortcode || null,
      pk: (item.pk && String(item.pk)) || (item.id && String(item.id).split('_')[0]) || null,
      items,
      expectedCount: Math.max(declared, items.length),
      partial: items.length < declared || (isCarouselType && items.length < 2 && !declared),
      pinned: isPinned(item),
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
        return { type: 'video', url: v.url, width: v.width || 0, poster: posterOf(n), names: imageNames(n) };
      }
      const candidates = n.image_versions2 && n.image_versions2.candidates;
      if (candidates && candidates.length) {
        const i = largest(candidates, (x) => x.width || 0);
        return { type: 'image', url: i.url, width: i.width || 0, names: imageNames(n) };
      }
      // standard graphql fields
      if (n.is_video && n.video_url) {
        return { type: 'video', url: n.video_url, width: (n.dimensions && n.dimensions.width) || 0,
          poster: posterOf(n), names: imageNames(n) };
      }
      const r = largest(n.display_resources, (x) => x.config_width || 0);
      const url = (r && r.src) || n.display_url;
      return url ? { type: 'image', url, width: (r && r.config_width) || 0, names: imageNames(n) } : null;
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
      user: media.owner || media.user || null, // see normalizeApiV1Item — optional, unverified shape
      shortcode: media.shortcode || media.code || null,
      pk: (media.pk && String(media.pk)) || (media.id && String(media.id).split('_')[0]) || null,
      items,
      expectedCount: Math.max(declared, items.length),
      partial: items.length < declared || (isCarouselType && items.length < 2 && !declared),
      pinned: isPinned(media),
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

  function storyRouteFromPath(pathname) {
    const segments = String(pathname || '').split('?')[0].split('/').filter(Boolean);
    if (segments[0] !== 'stories' || segments.length < 2 || segments.length > 3) return null;
    if (segments[1] === 'highlights') {
      return segments.length === 3 && /^\d+$/.test(segments[2])
        ? { kind: 'highlight', highlightId: segments[2] } : null;
    }
    const username = segments[1];
    if (!/^[A-Za-z0-9._]+$/.test(username) || RESERVED_HANDLES.has(username.toLowerCase())) return null;
    if (segments.length === 3 && !/^\d+$/.test(segments[2])) return null;
    return { kind: 'story', username, pk: segments[2] || null };
  }

  function normalizeStoryItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const video = Array.isArray(raw.video_versions) ? raw.video_versions.filter((v) => v && /^https?:/i.test(v.url || '')) : [];
    const candidates = raw.image_versions2 && Array.isArray(raw.image_versions2.candidates)
      ? raw.image_versions2.candidates.filter((c) => c && /^https?:/i.test(c.url || '')) : [];
    let chosen = null;
    let type = 'image';
    if (video.length) {
      const withWidth = video.filter((v) => v.width != null && Number.isFinite(Number(v.width)));
      const typeRank = (v) => v.type != null && Number.isFinite(Number(v.type)) ? Number(v.type) : Infinity;
      chosen = withWidth.length ? largest(withWidth, (v) => Number(v.width)) :
        video.reduce((best, v) => typeRank(v) < typeRank(best) ? v : best);
      type = 'video';
    } else if (Number(raw.media_type) === 2) {
      return null; // a video poster is not the video file
    } else if (candidates.length) {
      chosen = largest(candidates, (c) => Number(c.width) || 0);
    }
    if (!chosen || !chosen.url) return null;
    const pk = raw.pk != null ? String(raw.pk) : raw.id ? String(raw.id).split('_')[0] : null;
    return { pk, username: (raw.user && raw.user.username) || (raw.owner && raw.owner.username) || null,
      takenAt: raw.taken_at == null ? null : Number(raw.taken_at), type, url: chosen.url,
      width: chosen.width == null ? null : Number(chosen.width),
      height: chosen.height == null ? null : Number(chosen.height),
      hasAudio: raw.has_audio == null ? null : !!raw.has_audio,
      names: [...new Set(candidates.map((c) => basenameFromUrl(c.url)).filter(Boolean))] };
  }

  function storyDate(takenAtSeconds) {
    const seconds = Number(takenAtSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function planStoryDownloads(items, kind) {
    if (kind !== 'story' && kind !== 'highlight') return [];
    return items.filter(Boolean).flatMap((item) => {
      const user = safeSegment(item.username).toLowerCase();
      const pk = String(item.pk || '');
      const date = storyDate(item.takenAt);
      if (!user || !/^\d+$/.test(pk) || !date || !/^https?:/i.test(item.url || '')) return [];
      return [{ url: item.url,
        filename: `${CAPTURE_FOLDER}/${user}-${kind}-${date}-${pk}.${extFromUrl(item.url, item.type)}`,
        conflictAction: 'overwrite' }];
    });
  }

  function pickStoryItem(route, reel, items, signals) {
    if (!route || !reel || !Array.isArray(items)) return null;
    const s = signals || {};
    if (route.kind === 'story' && route.pk) {
      const found = items.findIndex((item) => item && String(item.pk) === String(route.pk));
      return found < 0 ? null : found;
    }
    if (s.imageBasename) {
      const matches = items.flatMap((item, i) => item && item.names && item.names.includes(s.imageBasename) ? [i] : []);
      if (matches.length === 1) return matches[0];
    }
    const p = s.progress;
    return p && p.count === items.length && Number.isInteger(p.index) && p.index >= 0 &&
      p.index < items.length && items[p.index] ? p.index : null;
  }

  function pickCarouselIndex(items, signals) {
    if (!Array.isArray(items)) return null;
    const s = signals || {};
    if (s.imageBasename) {
      const matches = items.flatMap((item, i) => {
        if (!item) return [];
        const names = item.names && item.names.length ? item.names : [basenameFromUrl(item.url)];
        return names.includes(s.imageBasename) ? [i] : [];
      });
      if (matches.length === 1) return matches[0];
    }
    return Number.isInteger(s.translateIndex) && s.translateIndex >= 0 && s.translateIndex < items.length
      ? s.translateIndex : null;
  }

  // Normalized media → chrome.downloads plan. Usernames are case-insensitive on IG (lowercase
  // them); shortcodes are case-SENSITIVE (preserve, so a file can be traced back to its post URL).
  function planDownloads(media, opts) {
    const user = safeSegment(media.username).toLowerCase() || 'instagram';
    const code = safeSegment(media.shortcode) || 'post';
    const many = media.items.length > 1;
    const index = opts && Number.isInteger(opts.index) && opts.index >= 0 && opts.index < media.items.length
      ? opts.index : null;
    const selected = index === null ? media.items.map((item, i) => ({ item, i })) :
      [{ item: media.items[index], i: index }];
    return selected.map(({ item, i }) => ({
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

  // A single IMAGE can secretly be an ad-carousel COVER: viewed cold (direct permalink), the
  // server-embedded blob / permalink HTML / fiber props advertise media_type 1 + null
  // carousel_media_count for what is really an 8-slide carousel (verified live 2026-07-14 on
  // DYw5KdMDH6a — the cover lies). So a lone image is only trustworthy when it came from a LIVE
  // API response — the network tap, or our own graphql/media-info calls; otherwise, given a pk,
  // confirm/complete it via media/info. (A single video/reel is never a masked carousel; a real
  // carousel already has ≥2 items; a partial is caught by isPartialCarousel.)
  const TRUSTED_LONE_IMAGE = new Set(['network_cache', 'graphql', 'media_info']);
  const needsCompletion = (m) =>
    !!m &&
    (isPartialCarousel(m) ||
      (!!m.pk &&
        m.items.length < 2 &&
        m.items[0] &&
        m.items[0].type === 'image' &&
        !TRUSTED_LONE_IMAGE.has(m.source)));

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
        (m.items.length === best.items.length && needsCompletion(best) && !needsCompletion(m))
      ) {
        best = m;
      }
    };
    // HTML embed: only when we have no usable seed or it's a flagged partial. A lone-image cover
    // that just needs pk-confirmation skips this (its permalink HTML is a bare shell anyway) and
    // goes straight to media/info.
    if (!best || isPartialCarousel(best)) {
      try {
        consider(await fetchPostHtmlMedia(shortcode));
      } catch (e) {
        errors.push(`fetchPostHtmlMedia: ${(e && e.message) || e}`);
      }
    }
    // Media-info completion: whenever the best result still needs confirming AND carries a pk.
    // This is what completes the cold masked ad-carousel — the cover lies about its media_type,
    // media/info tells the truth.
    if (best && best.pk && needsCompletion(best)) {
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

  function usernameFromLocation() {
    const seg = (location.pathname.split('/')[1] || '').replace(/[^A-Za-z0-9._]/g, '');
    return seg && !['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts'].includes(seg)
      ? seg
      : null;
  }

  // Last resort. Video-aware, but NEVER the <video> element's own src: IG streams video via MSE, so
  // that's a useless `blob:` URL (gotcha #3) — only a direct http(s) <video>/<source> src is
  // downloadable (rare). The real .mp4 comes from the network tap once the shortcode is right; this
  // fallback exists for when every data path missed. Images filtered by size (skips avatars/rings).
  function mediaFromDom(container, shortcode) {
    for (const v of container.querySelectorAll('video')) {
      const cands = [v.currentSrc, v.getAttribute('src')].concat(
        [...v.querySelectorAll('source')].map((s) => s.getAttribute('src')),
      );
      const direct = cands.find((u) => u && /^https?:/i.test(u)); // reject blob:/data:
      if (direct) {
        return {
          username: usernameFromLocation(),
          shortcode,
          items: [{ type: 'video', url: direct, width: 0 }],
          source: 'dom',
          partial: true,
        };
      }
    }
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
    return {
      username: usernameFromLocation(),
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
    storyRouteFromPath,
    normalizeStoryItem,
    storyDate,
    planStoryDownloads,
    pickStoryItem,
    pickCarouselIndex,
    pickMediaFromHtml,
    isPartialCarousel,
    needsCompletion,
    planDownloads,
    fetchMediaByShortcode,
    mediaFromDom,
  };
})();

globalThis.IGFM_RESOLVER = IGFM_RESOLVER;
