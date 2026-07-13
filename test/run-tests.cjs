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

t('api/v1 video: prefers video_versions over the poster, largest first', () => {
  const m = R.normalizeApiV1Item(API_V1_VIDEO);
  assert.deepEqual(m.items, [{ type: 'video', url: 'https://cdn.example/vid-1080.mp4?sig=2', width: 1080 }]);
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

t('graphql video: video_url wins over poster resources', () => {
  const m = R.normalizeShortcodeMedia(GQL_VIDEO);
  assert.deepEqual(m.items, [{ type: 'video', url: 'https://cdn.example/gql-vid.mp4', width: 720 }]);
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

// ---- summary ---------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed.length + ' failed');
if (failed.length) {
  console.error('Failed: ' + failed.join(', '));
  process.exit(1);
}
