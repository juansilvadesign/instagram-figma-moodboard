// Turns a capture FOLDER into an ordered placement manifest for the Figma IG-UI template.
//
// This is the deterministic half of v2's placement engine: which file lands in which grid slot,
// in what order, and what still needs a poster frame. Driving Figma is the agent's job — see
// PLACEMENT.md for the MCP recipe that consumes this manifest.
//
// The pure half (parse / group / order / cap) has no I/O so test/run-tests.cjs can exercise it
// under Node — keep it that way. The CLI at the bottom does the file listing.
//
// Run: node placement/manifest.cjs <capture-folder> [--handle x] [--date YYYY-MM-DD] [--slots 24]

'use strict';

const path = require('node:path');

// The template's post grid holds 24 uniform square slots (verified live 2026-07-17 against node
// "grid" 11:136 — 24 same-size IMAGE-fill leaf frames). One capture = the most recent 24 posts.
const SLOT_COUNT = 24;

// Instagram shortcodes are base64 of the media pk in this alphabet, big-endian. Decoding one
// yields a monotonically increasing id, so a folder of hand-captured files can be ordered
// newest-first with no network call and no metadata sidecar. Anchor: this project's own gotcha
// #14 pair — DYw5KdMDH6a => 3904872284116778650 (locked in test/run-tests.cjs).
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov']);

/** Decode an Instagram shortcode to its media pk. Returns null for anything off-alphabet. */
function shortcodeToPk(shortcode) {
  const s = String(shortcode || '');
  if (!s) return null;
  let v = 0n;
  for (const ch of s) {
    const i = IG_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    v = v * 64n + BigInt(i);
  }
  return v;
}

// resolver.js planDownloads writes `<user>-<code>[-NN].<ext>`. Usernames are lowercased and
// Instagram only allows [a-z0-9._] in them, while a shortcode MAY contain '-' — so the FIRST
// hyphen is the only unambiguous username/shortcode boundary. Splitting on the LAST one silently
// corrupts every shortcode that contains a hyphen (~1 in 64).
function parseCaptureFilename(filename) {
  const base = path.basename(String(filename || ''));
  const m = /^(.+)\.([A-Za-z0-9]{2,4})$/.exec(base);
  if (!m) return null;
  const stem = m[1];
  const ext = m[2].toLowerCase();
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return null;

  const dash = stem.indexOf('-');
  if (dash <= 0 || dash === stem.length - 1) return null;

  const username = stem.slice(0, dash);
  const rest = stem.slice(dash + 1);
  const idx = /^(.+)-(\d{2})$/.exec(rest);
  return {
    username,
    shortcode: idx ? idx[1] : rest,
    index: idx ? Number(idx[2]) : null,
    ext,
    type: VIDEO_EXT.has(ext) ? 'video' : 'image',
    filename: base,
  };
}

function makePost(shortcode, items) {
  // -NN is 1-indexed and the cover is always -01; a non-indexed single file is its own cover.
  const sorted = items.slice().sort((a, b) => (a.index || 1) - (b.index || 1));
  const cover = sorted[0];
  return {
    shortcode,
    username: cover.username,
    cover,
    items: sorted,
    type: sorted.length > 1 ? 'carousel' : cover.type,
    pk: shortcodeToPk(shortcode),
  };
}

// planDownloads suffixes -NN ONLY for a multi-item carousel, so indexed files always arrive in
// groups of 2+. A LONE indexed file is therefore pathological: it means the '-NN' we stripped was
// really the tail of the shortcode (the charset includes '-' and digits). Fold it back rather
// than invent a 1-slide carousel. A partial carousel download can't be confused with this — a
// 1-item resolution takes the no-suffix branch in planDownloads.
function groupPosts(filenames) {
  const byCode = new Map();
  for (const p of (filenames || []).map(parseCaptureFilename).filter(Boolean)) {
    if (!byCode.has(p.shortcode)) byCode.set(p.shortcode, []);
    byCode.get(p.shortcode).push(p);
  }

  const posts = [];
  for (const [code, items] of byCode) {
    if (items.length === 1 && items[0].index !== null) {
      const only = items[0];
      const real = `${code}-${String(only.index).padStart(2, '0')}`;
      posts.push(makePost(real, [{ ...only, index: null, shortcode: real }]));
      continue;
    }
    posts.push(makePost(code, items));
  }
  return posts;
}

/** Newest first, matching Instagram's grid. Unorderable codes sink to the bottom, name-stable. */
function orderPosts(posts) {
  return posts.slice().sort((a, b) => {
    if (a.pk !== null && b.pk !== null) return a.pk > b.pk ? -1 : a.pk < b.pk ? 1 : 0;
    if (a.pk !== null) return -1;
    if (b.pk !== null) return 1;
    return a.shortcode.localeCompare(b.shortcode);
  });
}

// The top-right grid glyph Instagram overlays on a tile, or null for a plain photo. The template
// carries three white vector sources (named `badge-reel` / `badge-carousel` / `badge-pinned`);
// placement clones the matching one into the tile's corner (PLACEMENT.md → Type badges). Real IG
// shows only ONE glyph per tile, so this picks one: a PIN outranks the media-type glyph (a pinned
// post is usually also a carousel — live: @solarity.studio's pinned post is an 8-slide carousel —
// and the pin is the more useful signal on a moodboard). `type` is the FINAL type: in covers mode
// a video's cover is a .jpg so the filename reads 'image', and only capture.json restores 'video'
// — which is why the CLI recomputes this after applying the sidecar's type/pinned override.
function badgeFor(slot) {
  if (!slot) return null;
  if (slot.pinned) return 'pinned';
  if (slot.type === 'video') return 'reel';
  if (slot.type === 'carousel') return 'carousel';
  return null;
}

/**
 * @param {object} opts
 * @param {string[]} opts.files      filenames in the capture folder (basenames or paths)
 * @param {string}  [opts.handle]    profile handle; inferred from the files when omitted
 * @param {string}  [opts.date]      capture date, YYYY-MM-DD
 * @param {number}  [opts.slotCount] grid capacity (default 24 — the template's grid)
 * @param {object}  [opts.profile]   header text (display_name, bio, link, counts…)
 * @param {string[]} [opts.feedOrder] shortcodes in true feed order, from the crawler's capture.json
 */
function buildManifest(opts) {
  const o = opts || {};
  const slotCount = o.slotCount == null ? SLOT_COUNT : o.slotCount;
  const posts = orderPosts(groupPosts(o.files || []));

  // capture.json (written by the v2 crawler) is AUTHORITATIVE when present: Instagram lets a
  // profile PIN posts to the top, so the real grid order is not chronological. pk-order is the
  // fallback for a hand-captured folder, which carries no feed metadata at all.
  let ordered = posts;
  if (o.feedOrder && o.feedOrder.length) {
    const rank = new Map(o.feedOrder.map((code, i) => [code, i]));
    const known = posts.filter((p) => rank.has(p.shortcode));
    const unknown = posts.filter((p) => !rank.has(p.shortcode));
    known.sort((a, b) => rank.get(a.shortcode) - rank.get(b.shortcode));
    ordered = known.concat(unknown);
  }

  const placed = ordered.slice(0, slotCount);
  const handle = o.handle || (placed[0] && placed[0].username) || (posts[0] && posts[0].username) || null;

  return {
    handle,
    date: o.date || null,
    // The dedup key: a Section with this name existing already BLOCKS the capture (no duplicate
    // same-day capture of the same profile).
    sectionName: handle && o.date ? `@${handle} · ${o.date}` : null,
    slotCount,
    slots: placed.map((p, i) => ({
      slot: i,
      shortcode: p.shortcode,
      type: p.type,
      file: p.cover.filename,
      // A video cover can't be an image fill — the poster frame gets extracted with ffmpeg.
      needsPoster: p.cover.type === 'video',
      items: p.items.length,
      // Overlay glyph. pinned isn't known here (it comes from capture.json), so this is the
      // best-effort value from type; the CLI recomputes it after the sidecar override.
      badge: badgeFor({ type: p.type }),
    })),
    overflow: ordered.slice(slotCount).map((p) => p.shortcode),
    unfilled: Math.max(0, slotCount - placed.length),
    profile: o.profile || null,
  };
}

module.exports = {
  SLOT_COUNT,
  IG_ALPHABET,
  shortcodeToPk,
  parseCaptureFilename,
  groupPosts,
  orderPosts,
  badgeFor,
  buildManifest,
};

// ---- CLI ----------------------------------------------------------------

if (require.main === module) {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');

  // A video cover can't be an image fill, so its poster frame is extracted with ffmpeg into the
  // project's gitignored captures/ scratch — the user's Downloads folder stays exactly as the
  // extension wrote it. `-vf thumbnail` picks a representative frame instead of frame 0, which on
  // a reel is often black. The v2 crawler can skip all of this: Instagram's own JSON already
  // carries the poster URL in image_versions2 (gotcha #9), so only hand-captured folders — which
  // hold just the .mp4 — need the extraction.
  const POSTER_DIR = path.join(__dirname, '..', 'captures', '.posters');
  function ensurePoster(videoPath) {
    const out = path.join(POSTER_DIR, path.basename(videoPath).replace(/\.[^.]+$/, '') + '.jpg');
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(POSTER_DIR, { recursive: true });
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath,
      '-vf', 'thumbnail', '-frames:v', '1', '-q:v', '2', out]);
    return r.status === 0 && fs.existsSync(out) ? out : null;
  }

  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const flag = (name, fallback) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  if (!dir) {
    console.error('usage: node placement/manifest.cjs <capture-folder> [--handle x] [--date YYYY-MM-DD] [--slots 24] [--no-posters]');
    process.exit(2);
  }
  // capture.json is the crawler's sidecar and is AUTHORITATIVE for order — Instagram pins posts,
  // so the pk fallback would bury a pinned post (live: @solarity.studio's pinned post is its
  // OLDEST). Its recorded `cover` filenames are only advisory: Chrome renames a download when the
  // CDN's Content-Type contradicts the URL's extension (IG serves JPEG bytes from a '.heic' path),
  // so files are always matched by parsing the folder, never by that field.
  let capture = null;
  try {
    capture = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
  } catch { /* hand-captured folder — no sidecar, fall back to pk order */ }

  const postMeta = capture && Array.isArray(capture.posts)
    ? new Map(capture.posts.map((p) => [p.shortcode, p]))
    : null;

  const manifest = buildManifest({
    files: fs.readdirSync(dir),
    handle: flag('handle', (capture && capture.handle) || null),
    date: flag('date', (capture && capture.captured_at) || new Date().toISOString().slice(0, 10)),
    slotCount: Number(flag('slots', SLOT_COUNT)),
    feedOrder: capture && Array.isArray(capture.posts) ? capture.posts.map((p) => p.shortcode) : null,
    profile: (capture && capture.profile) || null,
  });
  manifest.orderedBy = postMeta ? 'capture.json feedOrder' : 'shortcode pk (no capture.json)';

  // In covers mode the folder holds ONE file per carousel, so the filenames alone can't say a post
  // was a carousel of 8 — take type/slides/pinned from the sidecar where it exists.
  if (postMeta) {
    for (const s of manifest.slots) {
      const p = postMeta.get(s.shortcode);
      if (!p) continue;
      s.type = p.type || s.type;
      s.items = p.items == null ? s.items : p.items;
      if (p.pinned) s.pinned = true;
      s.badge = badgeFor(s); // finalize after the type/pinned override (covers-mode video → reel)
    }
  }

  // Absolute paths so the agent can hand them straight to set_image_fill — the MCP server reads
  // the file itself and runs in this same WSL filesystem, so a Windows Downloads path works with
  // no copy step.
  for (const s of manifest.slots) {
    s.path = path.resolve(dir, s.file);
    if (s.needsPoster && !argv.includes('--no-posters')) {
      const poster = ensurePoster(s.path);
      if (poster) {
        s.poster = poster;
        s.path = poster; // what actually gets placed
      } else {
        s.error = 'poster extraction failed — slot left at its template placeholder';
      }
    }
  }
  console.log(JSON.stringify(manifest, null, 2));
}
