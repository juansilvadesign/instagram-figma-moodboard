// Node regression tests for the pure half of extension/resolver.js (parsers, normalizers,
// download planning). The browser half (fetch chain, DOM harvest, injection) can only be
// verified manually in a logged-in Chrome — see README.md → Verify in Chrome.
//
// Run: node test/run-tests.cjs

'use strict';

const assert = require('node:assert');

require('../extension/resolver.js'); // classic script — attaches IGFM_RESOLVER to globalThis
const R = globalThis.IGFM_RESOLVER;

let passed = 0;
const failed = [];

function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failed.push(name);
    console.error('  FAIL ' + name + ' — ' + e.message);
  }
}

// Async tests are registered here and awaited after the synchronous suite (see the runner at the
// bottom) — needed for the fetch-chain escalation tests, which mock global.fetch.
const asyncTests = [];
const ta = (name, fn) => asyncTests.push([name, fn]);

// ---- shortcodeFromUrl ----------------------------------------------------

t('shortcode from /p/ path', () => {
  assert.equal(R.shortcodeFromUrl('/p/DAbC-d_123/'), 'DAbC-d_123');
});

t('shortcode from username-prefixed feed href', () => {
  assert.equal(R.shortcodeFromUrl('/studio.xyz/p/C9XyZ12abcd/'), 'C9XyZ12abcd');
});

t('shortcode from full URL', () => {
  assert.equal(R.shortcodeFromUrl('https://www.instagram.com/p/C9XyZ12abcd/?img_index=2'), 'C9XyZ12abcd');
});

t('shortcode from /reel/, /reels/ and /tv/', () => {
  assert.equal(R.shortcodeFromUrl('/reel/Cre3lC0de99/'), 'Cre3lC0de99');
  assert.equal(R.shortcodeFromUrl('/reels/Cre3lC0de99/'), 'Cre3lC0de99');
  assert.equal(R.shortcodeFromUrl('/tv/CtvC0de1234/'), 'CtvC0de1234');
});

t('no shortcode in non-post paths', () => {
  assert.equal(R.shortcodeFromUrl('/explore/'), null);
  assert.equal(R.shortcodeFromUrl('/stories/someuser/3141592653/'), null);
  assert.equal(R.shortcodeFromUrl('/'), null);
  assert.equal(R.shortcodeFromUrl(''), null);
});

// The /reels/audio/<id>/ attribution-link trap (2026-07-14): "audio" matches the code pattern and
// precedes the reel's own link in DOM order, so a naive scan captured shortcode="audio".
t('shortcode: /reels/audio/<id>/ attribution link is rejected (not "audio")', () => {
  assert.equal(R.shortcodeFromUrl('/reels/audio/1975396383375922/'), null);
});

t('shortcode: all-numeric captures (audio/collection ids) are rejected', () => {
  assert.equal(R.shortcodeFromUrl('/reels/12345678901234/'), null);
  assert.equal(R.shortcodeFromUrl('/p/99999/'), null);
});

t('shortcode: real reel + comment-permalink codes still resolve', () => {
  assert.equal(R.shortcodeFromUrl('/bnogmartins/reel/DY_HBkqxebO/'), 'DY_HBkqxebO');
  assert.equal(R.shortcodeFromUrl('/p/DY_HBkqxebO/c/18083708180131695/'), 'DY_HBkqxebO');
});

t('shortcode: a URL with the audio link BEFORE the reel link yields the reel code', () => {
  // scans past the rejected "audio" match to the real code in the same string
  assert.equal(R.shortcodeFromUrl('/reels/audio/1975396383375922/reel/DY_HBkqxebO/'), 'DY_HBkqxebO');
});

// ---- extractJsonBlobs + deepFind ----------------------------------------

const API_V1_IMAGE = {
  code: 'C9XyZ12abcd',
  user: { username: 'Studio.XYZ' },
  image_versions2: {
    candidates: [
      { url: 'https://cdn.example/img-small.jpg?sig=1', width: 640, height: 640 },
      { url: 'https://cdn.example/img-big.jpg?sig=1', width: 1440, height: 1440 },
    ],
  },
};

t('extractJsonBlobs parses only JSON script blobs, deepFind locates nested key', () => {
  const html =
    '<html><head><script type="text/javascript">var x=1;</script>' +
    '<script type="application/json">{"junk":true}</script>' +
    '<script data-sjs type="application/json">{"require":[["X","h",null,[{"__bbox":{"result":{"data":{"xdt_api__v1__media__shortcode__web_info":{"items":[' +
    JSON.stringify(API_V1_IMAGE) +
    ']}}}}}]]]}</script>' +
    '<script type="application/json">not json at all</script></head></html>';
  const blobs = R.extractJsonBlobs(html);
  assert.equal(blobs.length, 2);
  let info;
  for (const b of blobs) {
    info = info || R.deepFind(b, 'xdt_api__v1__media__shortcode__web_info');
  }
  assert.ok(info, 'web_info found');
  assert.equal(info.items[0].code, 'C9XyZ12abcd');
});

t('deepFind returns undefined when absent', () => {
  assert.equal(R.deepFind({ a: { b: [1, 2, { c: 3 }] } }, 'missing'), undefined);
});

// ---- normalizeApiV1Item ---------------------------------------------------

t('api/v1 image: picks the largest candidate', () => {
  const m = R.normalizeApiV1Item(API_V1_IMAGE);
  assert.equal(m.username, 'Studio.XYZ');
  assert.equal(m.shortcode, 'C9XyZ12abcd');
  assert.equal(m.items.length, 1);
  assert.deepEqual(m.items[0], { type: 'image', url: 'https://cdn.example/img-big.jpg?sig=1', width: 1440 });
});

const API_V1_VIDEO = {
  code: 'Cre3lC0de99',
  user: { username: 'reelmaker' },
  // videos also carry image_versions2 (poster frame) — video_versions must win
  image_versions2: { candidates: [{ url: 'https://cdn.example/poster.jpg', width: 1080 }] },
  video_versions: [
    { url: 'https://cdn.example/vid-720.mp4?sig=2', width: 720 },
    { url: 'https://cdn.example/vid-1080.mp4?sig=2', width: 1080 },
  ],
};

t('api/v1 video: prefers video_versions over the poster, largest first — and keeps the poster', () => {
  const m = R.normalizeApiV1Item(API_V1_VIDEO);
  // The video still wins for the FILE (gotcha #9). Since v0.4.0 the poster rides along instead of
  // being discarded, so the profile crawl can place a still without ffmpeg.
  assert.deepEqual(m.items, [{
    type: 'video', url: 'https://cdn.example/vid-1080.mp4?sig=2', width: 1080,
    poster: 'https://cdn.example/poster.jpg',
  }]);
});

t('api/v1 carousel: one item per child, feed order preserved', () => {
  const m = R.normalizeApiV1Item({
    code: 'Ccarousel99',
    user: { username: 'studio' },
    carousel_media: [API_V1_IMAGE, API_V1_VIDEO, API_V1_IMAGE],
  });
  assert.equal(m.items.length, 3);
  assert.deepEqual(
    m.items.map((i) => i.type),
    ['image', 'video', 'image'],
  );
});

t('api/v1 item without media returns null', () => {
  assert.equal(R.normalizeApiV1Item({ code: 'x' }), null);
  assert.equal(R.normalizeApiV1Item(null), null);
});

// ---- normalizeShortcodeMedia ---------------------------------------------

const GQL_IMAGE = {
  shortcode: 'C9XyZ12abcd',
  owner: { username: 'studio.xyz' },
  display_url: 'https://cdn.example/display.jpg',
  display_resources: [
    { src: 'https://cdn.example/gql-640.jpg', config_width: 640 },
    { src: 'https://cdn.example/gql-1080.jpg', config_width: 1080 },
  ],
};

const GQL_VIDEO = {
  shortcode: 'Cre3lC0de99',
  owner: { username: 'reelmaker' },
  is_video: true,
  video_url: 'https://cdn.example/gql-vid.mp4',
  dimensions: { width: 720, height: 1280 },
  display_resources: [{ src: 'https://cdn.example/gql-poster.jpg', config_width: 720 }],
};

t('graphql image: largest display resource', () => {
  const m = R.normalizeShortcodeMedia(GQL_IMAGE);
  assert.equal(m.username, 'studio.xyz');
  assert.deepEqual(m.items, [{ type: 'image', url: 'https://cdn.example/gql-1080.jpg', width: 1080 }]);
});

t('graphql video: video_url wins over poster resources — and keeps the poster', () => {
  const m = R.normalizeShortcodeMedia(GQL_VIDEO);
  assert.deepEqual(m.items, [{
    type: 'video', url: 'https://cdn.example/gql-vid.mp4', width: 720,
    poster: 'https://cdn.example/gql-poster.jpg', // from display_resources, not image_versions2
  }]);
});

t('graphql sidecar: one item per edge node', () => {
  const m = R.normalizeShortcodeMedia({
    shortcode: 'Ccarousel99',
    owner: { username: 'studio' },
    edge_sidecar_to_children: { edges: [{ node: GQL_IMAGE }, { node: GQL_VIDEO }] },
  });
  assert.deepEqual(
    m.items.map((i) => i.type),
    ['image', 'video'],
  );
});

t('graphql image falls back to display_url without display_resources', () => {
  const m = R.normalizeShortcodeMedia({ shortcode: 'x1234', display_url: 'https://cdn.example/only.jpg' });
  assert.equal(m.items[0].url, 'https://cdn.example/only.jpg');
});

t('graphql sidecar with carousel_media instead of edge_sidecar_to_children', () => {
  const m = R.normalizeShortcodeMedia({
    shortcode: 'Ccarousel99',
    owner: { username: 'studio' },
    carousel_media: [
      {
        image_versions2: { candidates: [{ url: 'https://cdn.example/img.jpg', width: 640 }] }
      },
      {
        is_video: true,
        video_url: 'https://cdn.example/vid.mp4',
        dimensions: { width: 720 }
      }
    ]
  });
  assert.equal(m.items.length, 2);
  assert.equal(m.items[0].type, 'image');
  assert.equal(m.items[0].url, 'https://cdn.example/img.jpg');
  assert.equal(m.items[1].type, 'video');
  assert.equal(m.items[1].url, 'https://cdn.example/vid.mp4');
});

t('api/v1 item with edge_sidecar_to_children instead of carousel_media', () => {
  const m = R.normalizeApiV1Item({
    code: 'Ccarousel99',
    user: { username: 'studio' },
    edge_sidecar_to_children: {
      edges: [
        {
          node: {
            display_url: 'https://cdn.example/img.jpg',
            display_resources: [{ src: 'https://cdn.example/img.jpg', config_width: 640 }]
          }
        }
      ]
    }
  });
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].type, 'image');
  assert.equal(m.items[0].url, 'https://cdn.example/img.jpg');
});

// ---- planDownloads ---------------------------------------------------------

t('single item: no index suffix, username lowercased, shortcode case preserved', () => {
  const plan = R.planDownloads({
    username: 'Studio.XYZ',
    shortcode: 'C9XyZ12abcd',
    items: [{ type: 'image', url: 'https://cdn.example/img-big.jpg?sig=1', width: 1440 }],
  });
  assert.deepEqual(plan, [
    { url: 'https://cdn.example/img-big.jpg?sig=1', filename: 'instagram-captures/studio.xyz-C9XyZ12abcd.jpg' },
  ]);
});

t('carousel: zero-padded index per item, per-item extension', () => {
  const plan = R.planDownloads({
    username: 'studio',
    shortcode: 'Ccarousel99',
    items: [
      { type: 'image', url: 'https://cdn.example/a.webp?x=1', width: 1 },
      { type: 'video', url: 'https://cdn.example/b.mp4?x=1', width: 1 },
    ],
  });
  assert.equal(plan[0].filename, 'instagram-captures/studio-Ccarousel99-01.webp');
  assert.equal(plan[1].filename, 'instagram-captures/studio-Ccarousel99-02.mp4');
});

t('extension falls back by type when the URL has none', () => {
  const plan = R.planDownloads({
    username: 'u',
    shortcode: 'Code123',
    items: [
      { type: 'video', url: 'https://cdn.example/stream/media?id=9', width: 1 },
      { type: 'image', url: 'https://cdn.example/stream/media?id=8', width: 1 },
    ],
  });
  assert.ok(plan[0].filename.endsWith('-01.mp4'));
  assert.ok(plan[1].filename.endsWith('-02.jpg'));
});

t('unsafe username characters sanitized, empty falls back to instagram/post', () => {
  const plan = R.planDownloads({
    username: 'Álvaro Café/Estúdio',
    shortcode: null,
    items: [{ type: 'image', url: 'https://cdn.example/a.jpg', width: 1 }],
  });
  assert.equal(plan[0].filename, 'instagram-captures/lvaro-caf-est-dio-post.jpg');
  const anon = R.planDownloads({
    username: null,
    shortcode: 'C9XyZ12abcd',
    items: [{ type: 'image', url: 'https://cdn.example/a.jpg', width: 1 }],
  });
  assert.equal(anon[0].filename, 'instagram-captures/instagram-C9XyZ12abcd.jpg');
});

// ---- fiber extraction engine (extension/inject.js) -------------------------
// inject.js is a MAIN-world browser script, but its search core is pure — it exports itself
// under Node so the traversal contract (ancestor-first, exact-shortcode, budgets) is testable
// without a browser. Synthetic fibers mimic React's {memoizedProps, return, child, sibling}.

const I = require('../extension/inject.js');

const AD_CAROUSEL = {
  code: 'CadPost1234',
  user: { username: 'sponsored.brand' },
  carousel_media: [API_V1_IMAGE, API_V1_VIDEO],
};

function makeFiber(props, extra) {
  return Object.assign(
    { memoizedProps: props || null, pendingProps: props || null, memoizedState: null,
      return: null, child: null, sibling: null, alternate: null, type: { name: 'Comp' } },
    extra || {},
  );
}

t('fiber: media found on an ancestor, nested two levels deep in props', () => {
  const host = makeFiber({ className: 'x' }, { type: 'div' });
  const mid = makeFiber({});
  const post = makeFiber({ item: { media: AD_CAROUSEL } }, { type: { name: 'PostRoot' } });
  host.return = mid;
  mid.return = post;
  const r = I.findMediaFromFiberGraph([host], 'CadPost1234', I.makeState(500, 20000));
  assert.equal(r.media, AD_CAROUSEL);
  assert.equal(r.via, 'ancestors:PostRoot');
});

t('fiber: exact mode rejects an object whose code differs from the shortcode', () => {
  const host = makeFiber({ post: AD_CAROUSEL });
  const r = I.findMediaFromFiberGraph([host], 'OtherCode99', I.makeState(500, 20000));
  assert.equal(r.media, null);
});

t('fiber: generic mode (no shortcode — ad without permalink) finds ancestor media', () => {
  const host = makeFiber({ className: 'x' });
  const post = makeFiber({ media: AD_CAROUSEL });
  host.return = post;
  const r = I.findMediaFromFiberGraph([host], null, I.makeState(500, 20000));
  assert.equal(r.media, AD_CAROUSEL);
});

t('fiber: generic mode never enters arrays (feed lists hold other posts)', () => {
  const host = makeFiber({ className: 'x' });
  const feed = makeFiber({ items: [AD_CAROUSEL] });
  host.return = feed;
  assert.equal(I.findMediaFromFiberGraph([host], null, I.makeState(500, 20000)).media, null);
  // …but exact mode may, since only a code match is accepted
  const r = I.findMediaFromFiberGraph([host], 'CadPost1234', I.makeState(500, 20000));
  assert.equal(r.media, AD_CAROUSEL);
});

t('fiber: media held in a function component hook chain', () => {
  const hook2 = { memoizedState: { post: AD_CAROUSEL }, next: null };
  const hook1 = { memoizedState: 42, next: hook2 };
  const host = makeFiber({ className: 'x' }, { memoizedState: hook1 });
  const r = I.findMediaFromFiberGraph([host], 'CadPost1234', I.makeState(500, 20000));
  assert.equal(r.media, AD_CAROUSEL);
});

t('fiber: BFS phase reaches media on a cousin branch when ancestors have none', () => {
  const start = makeFiber({ className: 'x' });
  const parent = makeFiber({});
  const cousin = makeFiber({ media: AD_CAROUSEL }, { type: { name: 'Sidecar' } });
  start.return = parent;
  parent.child = start;
  start.sibling = cousin;
  const r = I.findMediaFromFiberGraph([start], 'CadPost1234', I.makeState(500, 20000));
  assert.equal(r.media, AD_CAROUSEL);
  assert.ok(r.via.startsWith('graph:'));
});

t('fiber: circular fibers + circular props terminate without hanging', () => {
  const a = makeFiber(null);
  const b = makeFiber(null);
  a.return = b;
  b.return = a; // fiber cycle
  const loopProps = { name: 'loop' };
  loopProps.self = loopProps; // data cycle
  a.memoizedProps = loopProps;
  const state = I.makeState(500, 20000);
  assert.equal(I.findMediaFromFiberGraph([a], 'CadPost1234', state).media, null);
  assert.ok(state.fibersVisited > 0);
});

t('fiber: exhausted budget aborts the search instead of crashing the page', () => {
  const post = makeFiber({ media: AD_CAROUSEL });
  const state = I.makeState(500, 0); // zero property budget
  assert.equal(I.findMediaFromFiberGraph([post], 'CadPost1234', state).media, null);
});

t('fiber: react internals (child/return/stateNode/_keys/$$typeof) are never entered', () => {
  const decoy = makeFiber({
    child: { post: AD_CAROUSEL },        // SKIP_KEYS
    _private: { post: AD_CAROUSEL },     // underscore
    el: { $$typeof: Symbol ? Symbol.for('react.element') : 1, props: { post: AD_CAROUSEL } },
  });
  assert.equal(I.findMediaFromFiberGraph([decoy], 'CadPost1234', I.makeState(500, 20000)).media, null);
});

t('safeJsonStringify: strips functions, cycles and elements; keeps media data intact', () => {
  const raw = Object.assign({}, AD_CAROUSEL, {
    onClick: () => {},
    __typename: 'XDTMediaDict',
    element: { $$typeof: 1, huge: {} },
  });
  raw.selfRef = raw;
  const parsed = JSON.parse(I.safeJsonStringify(raw));
  assert.equal(parsed.code, 'CadPost1234');
  assert.equal(parsed.carousel_media.length, 2);
  assert.equal(parsed.onClick, undefined);
  assert.equal(parsed.__typename, undefined);
  assert.equal(parsed.element, undefined);
  assert.equal(parsed.selfRef, undefined);
});

t('fiber → sanitize → resolver normalize: full v1 ad carousel round-trip', () => {
  const parsed = JSON.parse(I.safeJsonStringify(AD_CAROUSEL));
  const media = R.normalizeShortcodeMedia(parsed) || R.normalizeApiV1Item(parsed);
  assert.equal(media.shortcode, 'CadPost1234');
  assert.equal(media.username, 'sponsored.brand');
  assert.deepEqual(media.items.map((i) => i.type), ['image', 'video']);
  assert.ok(media.items[1].url.endsWith('vid-1080.mp4?sig=2'));
});

// ---- network tap cache + payload scanners (inject.js) ----------------------
// The 2026 feed keeps post data in the Relay store (fiber props are empty) and /p/ embeds are
// cover-only — the network tap is the primary carousel source. Verified live 2026-07-13 on an
// 8-slide carousel (DYw5KdMDH6a): web_info returned 1 item, fiber graph had zero media props.

t('parseJsonChunks: whole body, @defer newline-delimited chunks, garbage lines', () => {
  assert.equal(I.parseJsonChunks('{"a":1}').length, 1);
  const chunks = I.parseJsonChunks('{"a":1}\n{"b":{"c":2}}\nnot json\n');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].b.c, 2);
  assert.deepEqual(I.parseJsonChunks(''), []);
});

t('collectMedia: digs through require/__bbox wrappers and deep timeline nesting', () => {
  const timeline = {
    require: [['RelayPrefetchedStreamCache', 'next', [], ['q', {
      __bbox: { result: { data: { xdt_api__v1__feed__timeline_connection: { edges: [
        { node: { media_or_ad: { media: AD_CAROUSEL } } },
        { node: { media: API_V1_VIDEO } },
      ] } } } },
    }]]],
  };
  const got = [];
  assert.equal(I.collectMedia(timeline, (m) => got.push(m), { ms: 2000 }), true);
  const codes = got.map((m) => m.code);
  assert.ok(codes.includes('CadPost1234'), 'ad carousel harvested');
  assert.ok(codes.includes('Cre3lC0de99'), 'plain video harvested');
});

t('collectMedia: node budget aborts (returns false) without hanging', () => {
  const wide = { arr: Array.from({ length: 5000 }, (_, i) => ({ i })) };
  assert.equal(I.collectMedia(wide, () => {}, { ms: 2000, nodes: 50 }), false);
});

t('cachePut: richer version of the same code wins regardless of arrival order', () => {
  const coverOnly = {
    code: 'DYw5KdMDH6a',
    carousel_media_count: 8,
    image_versions2: API_V1_IMAGE.image_versions2,
  };
  const full = { code: 'DYw5KdMDH6a', carousel_media: [API_V1_IMAGE, API_V1_VIDEO, API_V1_IMAGE] };
  I.cachePut(coverOnly);
  assert.equal(I._mediaCache.get('DYw5KdMDH6a'), coverOnly);
  I.cachePut(full);
  assert.equal(I._mediaCache.get('DYw5KdMDH6a'), full);
  I.cachePut(coverOnly); // downgrade refused
  assert.equal(I._mediaCache.get('DYw5KdMDH6a'), full);
  I._mediaCache.clear();
});

// ---- cover-only embeds + partial carousels (resolver) -----------------------

const jblob = (o) => '<script type="application/json">' + JSON.stringify(o) + '</scri' + 'pt>';
const webInfo = (item) => ({ data: { xdt_api__v1__media__shortcode__web_info: { items: [item] } } });
const COVER_ONLY = {
  code: 'DYw5KdMDH6a',
  user: { username: 'linha.zero' },
  carousel_media_count: 8,
  image_versions2: { candidates: [{ url: 'https://cdn.example/cover.jpg', width: 1080 }] },
};
const EIGHT_CHILDREN = Array.from({ length: 8 }, (_, i) => ({
  image_versions2: { candidates: [{ url: `https://cdn.example/slide-${i + 1}.jpg`, width: 1080 }] },
}));

t('normalize: carousel_media_count without children yields expectedCount (partial marker)', () => {
  const m = R.normalizeApiV1Item(COVER_ONLY);
  assert.equal(m.items.length, 1);
  assert.equal(m.expectedCount, 8);
});

t('pickMediaFromHtml: cover-only embed alone returns the partial candidate', () => {
  const m = R.pickMediaFromHtml('<html>' + jblob(webInfo(COVER_ONLY)) + '</html>', 'DYw5KdMDH6a');
  assert.equal(m.items.length, 1);
  assert.equal(m.expectedCount, 8);
});

t('pickMediaFromHtml: a later full-carousel blob beats the cover-only embed', () => {
  const full = Object.assign({}, COVER_ONLY, { carousel_media: EIGHT_CHILDREN });
  const html = '<html>' + jblob(webInfo(COVER_ONLY)) + jblob(webInfo(full)) + '</html>';
  const m = R.pickMediaFromHtml(html, 'DYw5KdMDH6a');
  assert.equal(m.items.length, 8);
});

t('pickMediaFromHtml: bare deferred carousel_media chunk adopted + username backfilled', () => {
  const deferred = { label: 'q$defer$children', path: ['items', 0], data: { carousel_media: EIGHT_CHILDREN } };
  const html = '<html>' + jblob(webInfo(COVER_ONLY)) + jblob(deferred) + '</html>';
  const m = R.pickMediaFromHtml(html, 'DYw5KdMDH6a');
  assert.equal(m.items.length, 8);
  assert.equal(m.shortcode, 'DYw5KdMDH6a');
  assert.equal(m.username, 'linha.zero');
});

t('pickMediaFromHtml: richer candidates for OTHER posts lose to the target shortcode', () => {
  const other = Object.assign({}, COVER_ONLY, { code: 'OtherPost99', carousel_media: EIGHT_CHILDREN });
  const html = '<html>' + jblob(webInfo(other)) + jblob(webInfo(COVER_ONLY)) + '</html>';
  const m = R.pickMediaFromHtml(html, 'DYw5KdMDH6a');
  assert.equal(m.shortcode, 'DYw5KdMDH6a');
  assert.equal(m.items.length, 1);
});

// ---- pk extraction + type-based partial detection (resolver v0.3.1) ---------
// A cold direct-permalink load can hand us a cover-only carousel whose carousel_media_count is
// ALSO missing — only media_type 8 / product_type carousel_container / GraphSidecar mark it as a
// carousel. Detect partial by TYPE, and carry the media pk so the caller can complete it via
// /api/v1/media/<pk>/info/. Verified live 2026-07-13 on DYw5KdMDH6a.

t('pk: api/v1 pk wins over id, id split fallback, else null', () => {
  assert.equal(R.normalizeApiV1Item(Object.assign({ pk: '3141592653' }, API_V1_IMAGE)).pk, '3141592653');
  assert.equal(R.normalizeApiV1Item(Object.assign({ id: '3141592653_17841400000' }, API_V1_IMAGE)).pk, '3141592653');
  assert.equal(R.normalizeApiV1Item(API_V1_IMAGE).pk, null);
});

t('pk: graphql media carries pk (from id when pk absent)', () => {
  assert.equal(R.normalizeShortcodeMedia(Object.assign({ id: '99_88' }, GQL_IMAGE)).pk, '99');
});

t('partial: api/v1 carousel by media_type 8, no count, lone cover → partial', () => {
  const m = R.normalizeApiV1Item({
    code: 'DYw5KdMDH6a', media_type: 8, pk: '3200', user: { username: 'linha.zero' },
    image_versions2: { candidates: [{ url: 'https://cdn.example/cover.jpg', width: 1080 }] },
  });
  assert.equal(m.items.length, 1);
  assert.equal(m.expectedCount, 1); // count unknown — type is the only signal
  assert.equal(m.partial, true);
  assert.equal(m.pk, '3200');
  assert.equal(R.isPartialCarousel(m), true);
});

t('partial: api/v1 product_type carousel_container also marks a lone cover partial', () => {
  const m = R.normalizeApiV1Item({
    code: 'X', product_type: 'carousel_container',
    image_versions2: { candidates: [{ url: 'https://cdn.example/c.jpg', width: 1080 }] },
  });
  assert.equal(m.partial, true);
});

t('partial: graphql XDTGraphSidecar typename with a lone child → partial', () => {
  const m = R.normalizeShortcodeMedia({
    shortcode: 'X', __typename: 'XDTGraphSidecar', display_url: 'https://cdn.example/c.jpg',
  });
  assert.equal(m.partial, true);
  assert.equal(R.isPartialCarousel(m), true);
});

t('not partial: a plain single image is complete (no carousel signals)', () => {
  const m = R.normalizeApiV1Item(API_V1_IMAGE);
  assert.equal(m.partial, false);
  assert.equal(R.isPartialCarousel(m), false);
});

t('not partial: a full 2+ child carousel is complete even without a count', () => {
  const m = R.normalizeApiV1Item(AD_CAROUSEL); // 2 children, no media_type, no count
  assert.equal(m.partial, false);
  assert.equal(R.isPartialCarousel(m), false);
});

// needsCompletion — the deeper 2026-07-14 finding: a COLD ad-carousel cover LIES (media_type 1,
// null count), so it isn't "partial" by any embedded signal; only its untrusted source + a pk
// betray that it might be a masked carousel worth confirming via media/info.

const withSource = (item, source) => { const m = R.normalizeApiV1Item(item); m.source = source; return m; };
const LONE_IMG = { code: 'X', pk: '9', media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn.example/c.jpg', width: 1080 }] } };

t('needsCompletion: lone image + pk from an untrusted source (embedded_json) must be confirmed', () => {
  const m = withSource(LONE_IMG, 'embedded_json');
  assert.equal(R.isPartialCarousel(m), false); // the cover lies — nothing marks it partial
  assert.equal(R.needsCompletion(m), true);
});

t('needsCompletion: lone image + pk from network_cache (live API) is trusted — no extra call', () => {
  assert.equal(R.needsCompletion(withSource(LONE_IMG, 'network_cache')), false);
});

t('needsCompletion: a media_info-sourced single image is authoritative — not re-checked', () => {
  assert.equal(R.needsCompletion(withSource(LONE_IMG, 'media_info')), false);
});

t('needsCompletion: a single video/reel is never a masked carousel cover', () => {
  const m = withSource({ code: 'R', pk: '9', video_versions: [{ url: 'https://cdn.example/v.mp4', width: 720 }] }, 'embedded_json');
  assert.equal(R.needsCompletion(m), false);
});

t('needsCompletion: a lone image with no pk cannot be completed — not flagged', () => {
  const m = withSource(API_V1_IMAGE, 'embedded_json'); // API_V1_IMAGE has no pk/id
  assert.equal(m.pk, null);
  assert.equal(R.needsCompletion(m), false);
});

t('needsCompletion: a full 2+ item carousel is complete regardless of source', () => {
  assert.equal(R.needsCompletion(withSource(AD_CAROUSEL, 'embedded_json')), false);
});

// ---- fetch-chain escalation with a partial seed (mocked fetch, v0.3.1) ------
// fetchMediaByShortcode(shortcode, seed) drives HTML embed → /api/v1/media/<pk>/info/ → GraphQL,
// each step running only while the best result is still partial, richest wins, full short-circuits.
// The cold direct-permalink case: seed (or HTML embed) is cover-only but carries the pk; the REST
// info endpoint (no doc_id to rot) completes it. Mock global.fetch by URL to test it under Node.

const origFetch = global.fetch;
const origDocument = global.document;
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(url, opts);
    }
    throw new Error('unexpected fetch: ' + url);
  };
  return calls;
}
function restoreFetch() {
  global.fetch = origFetch;
  global.document = origDocument;
}
const htmlRes = (html) => ({ ok: true, status: 200, text: async () => html });
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });
const FULL_EIGHT = { code: 'DYw5KdMDH6a', pk: '3200', user: { username: 'linha.zero' }, carousel_media: EIGHT_CHILDREN };

ta('escalate: a complete seed short-circuits — zero network calls', async () => {
  const calls = mockFetch([]);
  try {
    const seed = R.normalizeApiV1Item({ code: 'Full1', carousel_media: EIGHT_CHILDREN });
    const out = await R.fetchMediaByShortcode('Full1', seed);
    assert.equal(out.items.length, 8);
    assert.equal(calls.length, 0);
  } finally { restoreFetch(); }
});

ta('escalate: partial seed with pk → /api/v1/media/<pk>/info/ completes it, graphql skipped', async () => {
  global.document = { cookie: 'csrftoken=x' };
  const calls = mockFetch([
    ['/p/DYw5KdMDH6a/', () => htmlRes('<html>' + jblob(webInfo(COVER_ONLY)) + '</html>')], // cold embed = cover-only
    ['/api/v1/media/3200/info/', () => jsonRes({ items: [FULL_EIGHT] })],
    ['/graphql/query', () => { throw new Error('graphql should not be reached'); }],
  ]);
  try {
    const seed = R.normalizeApiV1Item(Object.assign({ pk: '3200', media_type: 8 }, COVER_ONLY));
    assert.equal(R.isPartialCarousel(seed), true);
    const out = await R.fetchMediaByShortcode('DYw5KdMDH6a', seed);
    assert.equal(out.items.length, 8);
    assert.equal(out.source, 'media_info');
    assert.ok(calls.some((u) => u.includes('/api/v1/media/3200/info/')), 'pk info fetched');
    assert.ok(!calls.some((u) => u.includes('/graphql/query')), 'graphql skipped once complete');
  } finally { restoreFetch(); }
});

ta('escalate: no seed, cold permalink — HTML cover carries pk → info completes it', async () => {
  global.document = { cookie: 'csrftoken=x' };
  const coverWithPk = Object.assign({ pk: '77', media_type: 8 }, COVER_ONLY);
  const calls = mockFetch([
    ['/p/DYw5KdMDH6a/', () => htmlRes('<html>' + jblob(webInfo(coverWithPk)) + '</html>')],
    ['/api/v1/media/77/info/', () => jsonRes({ items: [Object.assign({}, FULL_EIGHT, { pk: '77' })] })],
  ]);
  try {
    const out = await R.fetchMediaByShortcode('DYw5KdMDH6a', null);
    assert.equal(out.items.length, 8);
    assert.equal(out.source, 'media_info');
    assert.ok(calls.some((u) => u.includes('/api/v1/media/77/info/')));
  } finally { restoreFetch(); }
});

ta('escalate: masked ad-carousel — cover lies (media_type 1, null count) but pk → media/info gives 8', async () => {
  global.document = { cookie: 'csrftoken=x' };
  // The COLD permalink embed for the "Linha Zero" ad (live pk 3904872284116778650): a single
  // image, media_type 1, null count — indistinguishable from a real single post except for the
  // pk. media/info returns the truth (media_type 8, 8 children). This is the exact 2026-07-14 bug.
  const lyingCover = {
    code: 'DYw5KdMDH6a', pk: '3904872284116778650', media_type: 1, carousel_media_count: null,
    user: { username: 'linha.zero' },
    image_versions2: { candidates: [{ url: 'https://cdn.example/cover.jpg', width: 1080 }] },
  };
  const truth = {
    code: 'DYw5KdMDH6a', pk: '3904872284116778650', media_type: 8, product_type: 'ad',
    carousel_media_count: 8, user: { username: 'linha.zero' }, carousel_media: EIGHT_CHILDREN,
  };
  const calls = mockFetch([
    ['/api/v1/media/3904872284116778650/info/', () => jsonRes({ items: [truth] })],
    ['/p/DYw5KdMDH6a/', () => htmlRes('<html><body>bare shell — no web_info</body></html>')],
    ['/graphql/query', () => { throw new Error('graphql should not be reached'); }],
  ]);
  try {
    const seed = R.normalizeApiV1Item(lyingCover);
    seed.source = 'embedded_json';
    assert.equal(seed.partial, false, 'the lying cover does not look partial by any embedded signal');
    assert.equal(R.isPartialCarousel(seed), false);
    assert.equal(R.needsCompletion(seed), true, 'but its untrusted source + pk flag it for media/info');
    const out = await R.fetchMediaByShortcode('DYw5KdMDH6a', seed);
    assert.equal(out.items.length, 8, 'media/info completed the masked carousel');
    assert.equal(out.source, 'media_info');
    assert.ok(calls.some((u) => u.includes('/api/v1/media/3904872284116778650/info/')), 'media/info called');
    assert.ok(!calls.some((u) => u.includes('/p/DYw5KdMDH6a/')), 'useless bare-shell HTML fetch skipped');
    assert.ok(!calls.some((u) => u.includes('/graphql/query')), 'graphql skipped once complete');
  } finally { restoreFetch(); }
});

ta('escalate: pk info fails → graphql attempted → still partial floor kept, no throw', async () => {
  global.document = { cookie: 'csrftoken=x' };
  const calls = mockFetch([
    ['/p/DYw5KdMDH6a/', () => htmlRes('<html>' + jblob(webInfo(Object.assign({ pk: '5', media_type: 8 }, COVER_ONLY))) + '</html>')],
    ['/api/v1/media/5/info/', () => ({ ok: false, status: 560 })],
    ['/graphql/query', () => jsonRes({ data: {} })], // no media in response
  ]);
  try {
    const out = await R.fetchMediaByShortcode('DYw5KdMDH6a', null);
    assert.equal(out.items.length, 1);
    assert.equal(R.isPartialCarousel(out), true); // honest partial, not a crash
    assert.ok(calls.some((u) => u.includes('/api/v1/media/5/info/')), 'pk info attempted');
    assert.ok(calls.some((u) => u.includes('/graphql/query')), 'graphql attempted after pk info failed');
  } finally { restoreFetch(); }
});

// ---- profile crawler (extension/crawler.js, v2) -----------------------------

require('../extension/crawler.js'); // classic script — attaches IGFM_CRAWLER to globalThis
const C = globalThis.IGFM_CRAWLER;
const P = require('../placement/manifest.cjs'); // crawler↔manifest handoff is asserted below

const vid = (over) => ({
  username: 'studio.xyz', shortcode: 'DY_HBkqxebO', expectedCount: 1, pinned: false,
  items: [{ type: 'video', url: 'https://cdn/x/v.mp4', poster: 'https://cdn/x/p.jpg' }], ...over,
});
const carousel = (n) => ({
  username: 'studio.xyz', shortcode: 'DYw5KdMDH6a', expectedCount: n, pinned: false,
  items: Array.from({ length: n }, (_, i) => ({ type: 'image', url: `https://cdn/x/${i + 1}.jpg` })),
});

t('codesFromHrefs keeps DOM order and dedups', () => {
  assert.deepEqual(
    C.codesFromHrefs(['/p/AAAAAAAAAAA/', '/studio.xyz/p/BBBBBBBBBBB/', '/p/AAAAAAAAAAA/', '/reel/CCCCCCCCCCC/']),
    ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'],
  );
});

t('codesFromHrefs rejects the /reels/audio/ decoys (gotcha #15)', () => {
  assert.deepEqual(C.codesFromHrefs(['/reels/audio/1975396383375922/', '/p/AAAAAAAAAAA/']), ['AAAAAAAAAAA']);
});

t('profileHandleFromPath accepts a profile and rejects everything else', () => {
  assert.equal(C.profileHandleFromPath('/solarity.studio/'), 'solarity.studio');
  assert.equal(C.profileHandleFromPath('/p/DYw5KdMDH6a/'), null);       // a post
  assert.equal(C.profileHandleFromPath('/explore/'), null);             // reserved
  assert.equal(C.profileHandleFromPath('/solarity.studio/reels/'), null); // tab, not the grid
  assert.equal(C.profileHandleFromPath('/'), null);
});

t('planPost covers-only takes the cover and NO -NN suffix', () => {
  // A '-01' here would be re-read by manifest.cjs as a post whose shortcode ends in an index.
  const plan = C.planPost(carousel(8), { full: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].filename, 'instagram-captures/studio.xyz-DYw5KdMDH6a.jpg');
});

t('planPost covers-only uses a video POSTER, never the .mp4', () => {
  // A Figma image fill can't hold an .mp4; the poster is already in the data, so no ffmpeg.
  const plan = C.planPost(vid(), { full: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].url, 'https://cdn/x/p.jpg');
  assert.equal(plan[0].filename, 'instagram-captures/studio.xyz-DY_HBkqxebO.jpg');
});

t('planPost --full keeps every slide, suffixed', () => {
  const plan = C.planPost(carousel(3), { full: true });
  assert.equal(plan.length, 3);
  assert.equal(plan[0].filename, 'instagram-captures/studio.xyz-DYw5KdMDH6a-01.jpg');
  assert.equal(plan[2].filename, 'instagram-captures/studio.xyz-DYw5KdMDH6a-03.jpg');
});

t('planPost --full on a video keeps the .mp4', () => {
  assert.equal(C.planPost(vid(), { full: true })[0].url, 'https://cdn/x/v.mp4');
});

t('intoHandleFolder nests one capture per handle+DATE folder', () => {
  const plan = C.intoHandleFolder(C.planPost(carousel(2), { full: false }), 'solarity.studio', '2026-07-17');
  assert.equal(plan[0].filename, 'instagram-captures/solarity.studio/2026-07-17/studio.xyz-DYw5KdMDH6a.jpg');
  // Dated folders make overwrite safe (same handle+day = same content) and stop a re-capture
  // from accumulating ' (1)' duplicates — 25 of them appeared on the second live run.
  assert.equal(plan[0].conflictAction, 'overwrite');
});

t('a later capture of the same profile cannot overwrite the earlier one', () => {
  // The whole point of the tool is an ACCUMULATING archive; a date-less folder would have let
  // tomorrow's capture silently replace today's.
  const a = C.intoHandleFolder(C.planPost(carousel(2), { full: false }), 'solarity.studio', '2026-07-17');
  const b = C.intoHandleFolder(C.planPost(carousel(2), { full: false }), 'solarity.studio', '2026-07-18');
  assert.notEqual(a[0].filename, b[0].filename);
});

t('planAvatar cannot be mistaken for a post by the placement parser', () => {
  const plan = C.planAvatar('https://cdn/x/avatar.jpg?ig_cache=1', 'solarity.studio', '2026-07-17');
  assert.equal(plan[0].filename, 'instagram-captures/solarity.studio/2026-07-17/_avatar.jpg');
  // The load-bearing half: manifest.cjs must SKIP it. '<handle>-avatar.jpg' would parse as a
  // post with shortcode "avatar" and take a grid slot.
  assert.equal(P.parseCaptureFilename('_avatar.jpg'), null);
});

t('captureEntry records type/slides/pinned even when only the cover is saved', () => {
  const m = { ...carousel(8), pinned: true };
  const e = C.captureEntry(m, C.planPost(m, { full: false }));
  assert.equal(e.type, 'carousel'); // still a carousel though 1 file landed
  assert.equal(e.items, 8);
  assert.equal(e.pinned, true);
  assert.equal(e.cover, 'studio.xyz-DYw5KdMDH6a.jpg');
});

t('buildCaptureJson emits posts in feed order for buildManifest({feedOrder})', () => {
  const cap = C.buildCaptureJson({
    handle: 'solarity.studio', date: '2026-07-17', full: false,
    entries: [{ shortcode: 'DEU1LbwxhF0', pinned: true }, { shortcode: 'DXWTEl3Gvky', pinned: false }],
  });
  assert.equal(cap.handle, 'solarity.studio');
  assert.equal(cap.mode, 'covers');
  assert.deepEqual(cap.posts.map((p) => p.shortcode), ['DEU1LbwxhF0', 'DXWTEl3Gvky']);
});

t('the pinned post survives the crawler → manifest handoff (live @solarity.studio case)', () => {
  // DEU1LbwxhF0 is the OLDEST of the two (pk rank 12/12 live) but sits at grid slot 1 because it
  // is pinned. pk order would bury it; capture.json's feedOrder must win.
  const cap = C.buildCaptureJson({
    handle: 'solarity.studio', date: '2026-07-17',
    entries: [{ shortcode: 'DEU1LbwxhF0', pinned: true }, { shortcode: 'DXWTEl3Gvky', pinned: false }],
  });
  const m = P.buildManifest({
    files: ['solarity.studio-DXWTEl3Gvky.jpg', 'solarity.studio-DEU1LbwxhF0.jpg', '_avatar.jpg', 'capture.json'],
    handle: cap.handle, date: cap.captured_at,
    feedOrder: cap.posts.map((p) => p.shortcode),
  });
  assert.equal(m.slots.length, 2); // _avatar.jpg + capture.json ignored
  assert.equal(m.slots[0].shortcode, 'DEU1LbwxhF0'); // pinned, oldest, still slot 0
});

t('nextDelayMs stays inside the 5–10s band', () => {
  assert.equal(C.nextDelayMs(() => 0), 5000);
  assert.equal(C.nextDelayMs(() => 1), 10000);
  assert.equal(C.nextDelayMs(() => 0.5), 7500);
});

t('profileFromMedia degrades to nulls rather than inventing header text', () => {
  assert.equal(C.profileFromMedia(null, null), null);
  // media.user alone (no profile payload cached) — name/avatar only, never a guessed count.
  const p = C.profileFromMedia({ username: 'solarity.studio', full_name: 'Solarity' }, null);
  assert.equal(p.display_name, 'Solarity');
  assert.equal(p.biography, null);
  assert.equal(p.followers, null);
});

t('profileFromMedia merges the profile payload — web (edge_*) shape', () => {
  const p = C.profileFromMedia(
    { username: 'solarity.studio', full_name: 'Seb', profile_pic_url: 'https://cdn/thumb.jpg' },
    {
      username: 'solarity.studio', biography: 'design studio', external_url: 'https://solarity.studio',
      profile_pic_url_hd: 'https://cdn/hd.jpg',
      edge_followed_by: { count: 4000000 }, edge_follow: { count: 454 },
      edge_owner_to_timeline_media: { count: 1861 },
    },
  );
  assert.equal(p.biography, 'design studio');
  assert.equal(p.external_url, 'https://solarity.studio');
  assert.equal(p.followers, 4000000);
  assert.equal(p.following, 454);
  assert.equal(p.posts_count, 1861);
  assert.equal(p.avatar_url, 'https://cdn/hd.jpg'); // HD from the payload beats the media thumb
});

t('profileFromMedia merges the profile payload — mobile (*_count) shape', () => {
  // We never assume WHICH query delivered the payload.
  const p = C.profileFromMedia(null, {
    username: 'solarity.studio', biography: 'x',
    follower_count: 1234, following_count: 56, media_count: 27,
  });
  assert.equal(p.followers, 1234);
  assert.equal(p.following, 56);
  assert.equal(p.posts_count, 27);
});

t('profileFromMedia keeps an empty bio as "" and a missing one as null', () => {
  // "" is a real answer (the profile has no bio); null means we never saw the payload. Placement
  // must be able to tell them apart — writing a template placeholder over "" would be a lie.
  assert.equal(C.profileFromMedia(null, { username: 'a', biography: '' }).biography, '');
  assert.equal(C.profileFromMedia({ username: 'a' }, null).biography, null);
});

t('formatCount matches how Instagram renders counts', () => {
  assert.equal(C.formatCount(1861), '1,861');
  assert.equal(C.formatCount(4000000), '4M');
  assert.equal(C.formatCount(4200000), '4.2M');
  assert.equal(C.formatCount(12300), '12.3K');
  assert.equal(C.formatCount(999), '999');   // IG only abbreviates from 10k
  assert.equal(C.formatCount(9999), '9,999');
  assert.equal(C.formatCount(null), null);   // never invent a number
  assert.equal(C.formatCount(undefined), null);
});

// ---- inject.js profile tap (v0.4.1) ----------------------------------------

t('the tap watches /api/graphql — the profile route fires 5 POSTs there', () => {
  // Probe-verified 2026-07-17: this URL matched NEITHER original branch, so the tap never saw the
  // profile payload. The matcher was fine all along; it was being starved.
  assert.ok(I.TAP_URL_RE.test('https://www.instagram.com/api/graphql'), '/api/graphql must be tapped');
  assert.ok(I.TAP_URL_RE.test('https://www.instagram.com/graphql/query'));
  assert.ok(I.TAP_URL_RE.test('https://www.instagram.com/api/v1/users/web_profile_info/?username=x'));
  assert.ok(I.TAP_URL_RE.test('https://www.instagram.com/api/v1/media/123/info/'));
  assert.ok(!I.TAP_URL_RE.test('https://www.instagram.com/static/bundle.js'));
});

t('looksLikeProfile matches the REAL web_profile_info shape (probe-verified)', () => {
  // Verbatim shape from the live 2026-07-17 probe of @solarity.studio.
  const real = {
    username: 'solarity.studio', full_name: 'Seb 👋', biography: 'design studio',
    external_url: 'https://solarity.studio',
    edge_followed_by: { count: 27692 }, edge_follow: { count: 360 },
    edge_owner_to_timeline_media: { count: 27 },
  };
  assert.equal(I.looksLikeProfile(real), true);
  const p = C.profileFromMedia(null, real);
  assert.equal(p.followers, 27692);
  assert.equal(p.following, 360);
  assert.equal(p.posts_count, 27);
  assert.equal(C.formatCount(p.followers), '27.7K'); // what the header will actually render
});

t('the ad/deeplink blob carries a username but is NOT a profile', () => {
  // The probe found this on the page: username matches the handle, but it's tracking metadata.
  assert.equal(I.looksLikeProfile({
    username: 'solarity.studio', campaign_id: '123', igshid: 'x', gclid: 'y',
  }), false);
});

t('the VIEWER\'s own profile is cached separately and never answers for another handle', () => {
  // The load-bearing one. The probe proved the only profile-shaped object SSR'd into
  // @solarity.studio's page is jaypy06 — Juan's OWN account, bio and all. A "first seen" or
  // "richest wins" cache would have written HIS bio onto HER moodboard. Keying by username is
  // what makes that impossible (gotcha #22).
  I._profileCache.clear();
  I.profilePut({ username: 'jaypy06', full_name: 'Juan Pablo', biography: 'viewer session ctx' });
  assert.equal(I._profileCache.get('solarity.studio'), undefined); // miss, not Juan's bio
  assert.equal(I._profileCache.get('jaypy06').full_name, 'Juan Pablo');
});

t('looksLikeProfile accepts a profile payload, rejects a media author object', () => {
  assert.equal(I.looksLikeProfile({ username: 'a', biography: 'x' }), true);
  assert.equal(I.looksLikeProfile({ username: 'a', edge_followed_by: { count: 1 } }), true);
  assert.equal(I.looksLikeProfile({ username: 'a', follower_count: 1 }), true);
  // the thin author riding on a media item is NOT a profile payload
  assert.equal(I.looksLikeProfile({ username: 'a', full_name: 'A', profile_pic_url: 'u' }), false);
  assert.equal(I.looksLikeProfile({ biography: 'x' }), false); // no username to key on
  assert.equal(I.looksLikeProfile({}), false);
});

t('the profile tap keys by username and keeps the richest payload', () => {
  I._profileCache.clear();
  I.profilePut({ username: 'solarity.studio', biography: 'x' });
  I.profilePut({ username: 'solarity.studio', biography: 'x', follower_count: 9, media_count: 27 });
  I.profilePut({ username: 'solarity.studio', biography: 'thin' }); // poorer — must not win
  assert.equal(I._profileCache.get('solarity.studio').follower_count, 9);
  // A suggested user on the same page is cached separately and can never be handed back for
  // another handle — the crawler looks up its exact username.
  I.profilePut({ username: 'someone.else', biography: 'stranger', follower_count: 1 });
  assert.equal(I._profileCache.get('solarity.studio').biography, 'x');
  assert.equal(I._profileCache.size, 2);
});

t('collectMedia harvests media and profiles in ONE walk', () => {
  const media = [];
  const profiles = [];
  I.collectMedia(
    {
      data: {
        user: { username: 'solarity.studio', biography: 'design studio', follower_count: 10 },
        edges: [{ node: { code: 'DYw5KdMDH6a', image_versions2: { candidates: [] } } }],
      },
    },
    (m) => media.push(m), { ms: 200 }, (p) => profiles.push(p),
  );
  assert.equal(media.length, 1);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].username, 'solarity.studio');
});

t('collectMedia without putProfile still works (existing callers unaffected)', () => {
  const media = [];
  I.collectMedia({ code: 'DYw5KdMDH6a', image_versions2: { candidates: [] } }, (m) => media.push(m), { ms: 200 });
  assert.equal(media.length, 1);
});

// ---- resolver: poster + pinned (v0.4.0, feeds the crawler) ------------------

t('normalizeApiV1Item carries a video POSTER (no ffmpeg needed on the crawl path)', () => {
  const m = R.normalizeApiV1Item({
    code: 'DW3hRN6iXAK', media_type: 2, product_type: 'clips',
    user: { username: 'solarity.studio', full_name: 'Solarity' },
    video_versions: [{ url: 'https://cdn/v.mp4', width: 720 }],
    image_versions2: { candidates: [{ url: 'https://cdn/poster.jpg', width: 640 }] },
  });
  assert.equal(m.items[0].type, 'video');
  assert.equal(m.items[0].url, 'https://cdn/v.mp4');   // gotcha #9: video still wins for the file
  assert.equal(m.items[0].poster, 'https://cdn/poster.jpg');
  assert.equal(m.user.full_name, 'Solarity');
});

t('normalizeApiV1Item reads timeline_pinned_user_ids (probe-verified field)', () => {
  const base = { code: 'DEU1LbwxhF0', media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/i.jpg', width: 9 }] } };
  assert.equal(R.normalizeApiV1Item({ ...base, timeline_pinned_user_ids: ['62804501366'] }).pinned, true);
  assert.equal(R.normalizeApiV1Item({ ...base, timeline_pinned_user_ids: [] }).pinned, false); // key present, empty
  assert.equal(R.normalizeApiV1Item(base).pinned, false);                                      // key absent
});

t('normalizeShortcodeMedia carries poster + pinned too', () => {
  const m = R.normalizeShortcodeMedia({
    shortcode: 'DW3hRN6iXAK', is_video: true, video_url: 'https://cdn/v.mp4',
    display_url: 'https://cdn/poster.jpg', timeline_pinned_user_ids: ['1'],
  });
  assert.equal(m.items[0].poster, 'https://cdn/poster.jpg');
  assert.equal(m.pinned, true);
});

// ---- placement manifest (placement/manifest.cjs, v2) ------------------------

t('shortcodeToPk matches the pk documented in gotcha #14', () => {
  // The one shortcode/pk pair this project verified LIVE against /api/v1/media/<pk>/info/.
  assert.equal(P.shortcodeToPk('DYw5KdMDH6a'), 3904872284116778650n);
});

t('shortcodeToPk is monotonic (newer post => bigger pk)', () => {
  assert.ok(P.shortcodeToPk('DYw5KdMDH6a') > P.shortcodeToPk('C9XyZ12abcd'));
});

t('shortcodeToPk rejects off-alphabet input', () => {
  assert.equal(P.shortcodeToPk('not a code!'), null);
  assert.equal(P.shortcodeToPk(''), null);
});

t('parseCaptureFilename reads a single-item post', () => {
  assert.deepEqual(P.parseCaptureFilename('bnogmartins-DY_HBkqxebO.mp4'), {
    username: 'bnogmartins', shortcode: 'DY_HBkqxebO', index: null,
    ext: 'mp4', type: 'video', filename: 'bnogmartins-DY_HBkqxebO.mp4',
  });
});

t('parseCaptureFilename reads a carousel item', () => {
  const p = P.parseCaptureFilename('studio.xyz-DYw5KdMDH6a-03.jpg');
  assert.equal(p.username, 'studio.xyz');
  assert.equal(p.shortcode, 'DYw5KdMDH6a');
  assert.equal(p.index, 3);
  assert.equal(p.type, 'image');
});

t('parseCaptureFilename splits on the FIRST hyphen — shortcodes may contain one', () => {
  // Usernames can't contain '-' (IG allows [a-z0-9._]); shortcodes can. Splitting on the last
  // hyphen would yield username 'user.name-DY' and shortcode 'HBkqxebO'.
  const p = P.parseCaptureFilename('user.name-DY-HBkqxebO.jpg');
  assert.equal(p.username, 'user.name');
  assert.equal(p.shortcode, 'DY-HBkqxebO');
});

t('parseCaptureFilename ignores non-media and malformed names', () => {
  assert.equal(P.parseCaptureFilename('capture.json'), null);
  assert.equal(P.parseCaptureFilename('notes.txt'), null);
  assert.equal(P.parseCaptureFilename('no-extension'), null);
  assert.equal(P.parseCaptureFilename('nohyphen.jpg'), null);
});

t('groupPosts folds a carousel into ONE post keyed on its cover', () => {
  const posts = P.groupPosts([
    'studio.xyz-AAAAAAAAAAA-02.jpg',
    'studio.xyz-AAAAAAAAAAA-01.jpg',
    'studio.xyz-AAAAAAAAAAA-03.mp4',
  ]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].type, 'carousel');
  assert.equal(posts[0].items.length, 3);
  assert.equal(posts[0].cover.filename, 'studio.xyz-AAAAAAAAAAA-01.jpg'); // -01 is the cover
});

t('groupPosts folds a LONE indexed file back into its shortcode', () => {
  // planDownloads only suffixes -NN for a 2+ item carousel, so a lone indexed file means the
  // '-NN' we stripped was really the shortcode's tail — not a 1-slide carousel.
  const posts = P.groupPosts(['studio.xyz-ABCdefgh-12.jpg']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].shortcode, 'ABCdefgh-12');
  assert.equal(posts[0].type, 'image');
  assert.equal(posts[0].items.length, 1);
});

t('orderPosts sorts newest-first and sinks unorderable codes', () => {
  const posts = P.groupPosts([
    'u-C9XyZ12abcd.jpg',   // older
    'u-DYw5KdMDH6a.jpg',   // newer
    'u-bad code!!.jpg',    // unparseable name -> dropped entirely
  ]);
  const ordered = P.orderPosts(posts);
  assert.equal(ordered[0].shortcode, 'DYw5KdMDH6a');
  assert.equal(ordered[1].shortcode, 'C9XyZ12abcd');
});

t('buildManifest caps at the grid size and reports the overflow', () => {
  const files = [];
  for (let i = 0; i < 30; i++) files.push(`u-C9XyZ12abc${P.IG_ALPHABET[i]}.jpg`);
  const m = P.buildManifest({ files, handle: 'u', date: '2026-07-17' });
  assert.equal(m.slots.length, 24);
  assert.equal(m.overflow.length, 6);
  assert.equal(m.unfilled, 0);
  assert.deepEqual(m.slots.map((s) => s.slot), [...Array(24).keys()]); // contiguous 0..23
});

t('buildManifest reports unfilled slots for a short capture', () => {
  const m = P.buildManifest({ files: ['u-DYw5KdMDH6a.jpg'], handle: 'u', date: '2026-07-17' });
  assert.equal(m.slots.length, 1);
  assert.equal(m.unfilled, 23);
  assert.equal(m.overflow.length, 0);
});

t('buildManifest names the Section as the dedup key', () => {
  const m = P.buildManifest({ files: ['u-DYw5KdMDH6a.jpg'], handle: 'studio.xyz', date: '2026-07-17' });
  assert.equal(m.sectionName, '@studio.xyz · 2026-07-17');
});

t('buildManifest infers the handle from the files', () => {
  const m = P.buildManifest({ files: ['bnogmartins-DY_HBkqxebO.mp4'], date: '2026-07-17' });
  assert.equal(m.handle, 'bnogmartins');
});

t('buildManifest flags a video cover as needing a poster frame', () => {
  const m = P.buildManifest({ files: ['u-DY_HBkqxebO.mp4'], handle: 'u', date: '2026-07-17' });
  assert.equal(m.slots[0].needsPoster, true);
  assert.equal(m.slots[0].type, 'video');
});

t('buildManifest lets capture.json feed order beat pk order (pinned posts)', () => {
  // A pinned post sits at the top of the grid while being chronologically older — so the
  // crawler's recorded feed order must win over the shortcode-derived pk order.
  const files = ['u-C9XyZ12abcd.jpg', 'u-DYw5KdMDH6a.jpg'];
  const pk = P.buildManifest({ files, handle: 'u', date: '2026-07-17' });
  assert.equal(pk.slots[0].shortcode, 'DYw5KdMDH6a'); // newest first by default
  const feed = P.buildManifest({ files, handle: 'u', date: '2026-07-17', feedOrder: ['C9XyZ12abcd', 'DYw5KdMDH6a'] });
  assert.equal(feed.slots[0].shortcode, 'C9XyZ12abcd'); // pinned older post takes slot 0
});

t('buildManifest places a carousel COVER once, not every slide', () => {
  const m = P.buildManifest({
    files: ['u-DYw5KdMDH6a-01.jpg', 'u-DYw5KdMDH6a-02.jpg', 'u-DYw5KdMDH6a-03.jpg'],
    handle: 'u', date: '2026-07-17',
  });
  assert.equal(m.slots.length, 1);
  assert.equal(m.slots[0].file, 'u-DYw5KdMDH6a-01.jpg');
  assert.equal(m.slots[0].items, 3); // all 3 stay on disk, only the cover is placed
});

// ---- summary ---------------------------------------------------------------

(async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed++;
      console.log('  ok  ' + name);
    } catch (e) {
      failed.push(name);
      console.error('  FAIL ' + name + ' — ' + e.message);
    }
  }
  console.log('\n' + passed + ' passed, ' + failed.length + ' failed');
  if (failed.length) {
    console.error('Failed: ' + failed.join(', '));
    process.exit(1);
  }
})();
