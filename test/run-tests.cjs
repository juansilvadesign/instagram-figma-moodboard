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

// ---- summary ---------------------------------------------------------------

console.log('\n' + passed + ' passed, ' + failed.length + ' failed');
if (failed.length) {
  console.error('Failed: ' + failed.join(', '));
  process.exit(1);
}
