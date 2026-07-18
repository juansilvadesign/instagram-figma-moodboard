# Instagram → Figma Moodboard Capture

Capture Instagram inspiration from a **logged-in Chrome profile**, two ways:

- **Single post** — an injected button on any post saves its image, video, or full carousel to
  `Downloads/instagram-captures/<username>-<shortcode>[-NN].<ext>`.
- **Whole profile (v2)** — a "Capture profile" button saves the grid's most recent 24 covers +
  `capture.json` to `Downloads/instagram-captures/<handle>/<date>/`, which a Claude agent then
  auto-places into a Figma Instagram-UI template as a dated moodboard Section.

**Both halves ran end-to-end 2026-07-17.** Idea/spec history:
[the idea note](../../ideas/instagram-figma-moodboard.md). Working conventions + the hard-won
gotchas: [`CLAUDE.md`](CLAUDE.md). Figma recipe: [`placement/PLACEMENT.md`](placement/PLACEMENT.md).

## Install (Windows Chrome, extension folder lives in WSL)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → `\\wsl$\Ubuntu\home\jaypy\GitHub-Projects\Notes\ai-synthesizer\knowledge\projects\instagram-figma-moodboard\extension`
3. Open (or reload) an `instagram.com` tab. A download-arrow button appears in each post's action
   bar (next to Save); if the action bar isn't found, a dark round fallback button appears at the
   post's top-right.

After code changes: `chrome://extensions` → reload the extension → **reload the Instagram tab**
(required: the network tap that feeds carousel/sponsored downloads installs at page load).

## Use

Click the arrow on any post — feed, profile-grid modal, or `/p/…` / `/reel/…` permalink. A toast
reports progress and the saved file count. Carousels download every item, numbered `-01, -02, …`.
Videos save as progressive MP4 (audio included).

## Verify in Chrome (manual regression checklist)

> First pass ✅ 2026-07-08 — confirmed working on live posts. Carousel resolution ✅ 2026-07-14 —
> both the warm feed→modal path (`network_cache`) and the cold direct ad-permalink path
> (`media_info`, `DYw5KdMDH6a`) verified 8/8 in live Chrome. Reel with audio-attribution ✅ and the
> fullscreen Reels-viewer rail button ✅ 2026-07-14 (`DY_HBkqxebO` → correct shortcode → single
> `.mp4`; button seats between Save and "…", survives reel-swap, shows when bookmarked). Re-run this
> list after any change to the DOM heuristics in `content.js`.

This WSL env has no GUI Chrome, so the automated tests can't click the real page. A change counts
as **verified** when, in a logged-in Chrome:

- [ ] Feed **single image** post → 1 correctly-named `.jpg`/`.webp` in `Downloads/instagram-captures/`
- [ ] Feed **carousel** → all items land, `-01…-NN`, mixed image/video types correct
- [ ] **Video/Reel** post → `.mp4` that plays **with audio**
- [ ] **Reel with a music/audio attribution** (e.g. `/reel/DY_HBkqxebO/`) → saves the `.mp4`, not
      6 poster JPGs; console `shortcode=<realcode>` (never `audio`) and `resolved via network_cache`
- [ ] **Fullscreen Reels viewer** (`/reel/<code>/` vertical rail) → button appears IN the right-side
      rail, between Save and the "…" menu; survives scrolling to the next reel; icon is white and
      still shows when the post is already bookmarked (Save→Remove label flip must not hide it)
- [ ] **Profile grid → modal** → button present in the modal, download works
- [ ] **Permalink page** (`/p/<code>/`) → button present, download works
- [ ] **Feed carousel with deferred data, WARM tap** (open via feed → modal, e.g.
      `DYw5KdMDH6a`) → ALL N slides land via `network_cache` (or `embedded_json`)
- [ ] **Ad/sponsored carousel via DIRECT permalink, COLD tap** (paste `/p/DYw5KdMDH6a/` into a
      fresh tab, click) → ALL N slides still land; `[IGFM] media resolved via media_info` — the
      embedded cover lies (single image, `media_type 1`), so it's confirmed/completed from the
      media `pk` (v0.3.2 fix for the cold masked-carousel case)
- [ ] **Sponsored/ad post — carousel** → ALL slides land (any of `network_cache` /
      `embedded_json` / `ancestors:…`)
- [ ] Regular posts resolve in-page (instant) or fall back to `web_info`/`graphql` — check the
      `[IGFM] media resolved via …` console line; no click may freeze the page (>0.5 s jank);
      a partial download must SAY so in the toast (`N of M slides`)
- [ ] Button survives scrolling far down the feed and back (React re-renders)
- [ ] Service-worker console (`chrome://extensions` → Inspect views) shows `[IGFM]` trace, no errors

If the button lands in a weird spot or doesn't appear, grab the failing page's DOM context and fix
the heuristics in `content.js` (`findActionBar` / `postContainers`) — that's the expected drift
point, same as the twitter-video-downloader sibling.

## Automated tests (run in WSL)

```bash
node test/run-tests.cjs   # resolver + in-page engines (tap cache, payload scan, fiber walk)
                          # + the v2 placement manifest + the profile crawler — 110 tests
node --check extension/*.js placement/*.cjs
```

## How it resolves media (short version)

Shortcode from the post's links (or the URL) → resolve inside the page (MAIN-world
`inject.js`): a fetch/XHR **tap cache** of the page's own feed/graphql responses (the only
place full carousel + sponsored data still exists client-side), then server-embedded JSON
blobs, then React fiber props. The in-page result seeds the escalation chain → fetch
`/p/<shortcode>/` and pick the richest embedded JSON across all blobs → if it still needs
completing, finish it from the media `pk` via `/api/v1/media/<pk>/info/` (Instagram's own REST
endpoint — no `doc_id` to rot). That last step is what covers a **cold direct-permalink ad
carousel**, whose embedded cover lies (advertises a single image) — so a lone image from an
untrusted source is confirmed by pk, while a trusted live-API single image is not → GraphQL
`doc_id` query → last-resort DOM `srcset` harvest (images only). Media URLs are direct CDN files
(signed), saved by the service worker via `chrome.downloads`. Details + failure modes:
[`CLAUDE.md`](CLAUDE.md) → Architecture / Gotchas.

## v2 — profile → Figma moodboard

### Profile crawl (v0.4.0 — ✅ verified in Chrome 2026-07-17)

> First real run: `@solarity.studio` → **24/24 posts, 0 skipped**, covers only, pinned post first,
> `capture.json` + `_avatar.jpg` written, no ffmpeg needed — then placed into Figma. The whole
> pipeline works end-to-end.

On a profile page a fixed **"Capture profile"** button appears (top-right). It scrolls the grid,
saves the most recent **24** posts' **covers** into `Downloads/instagram-captures/<handle>/<date>/`, and
writes a **`capture.json`** the placement engine reads. **Shift-click** to save every carousel
slide instead of covers only. Pacing is randomized 5–10s per post.

It makes almost no requests of its own: scrolling makes *Instagram's own page* fetch the post data,
which the extension's tap already caches — so media is read from the cache, and the only network
the tool performs is the downloads themselves.

**Profile-crawl checklist (run once in a real logged-in Chrome — none of this is Node-testable):**

- [ ] Button appears on `/<handle>/`, and **disappears** when you SPA-navigate to a post/feed
- [ ] Toast counts up (`Reading grid… n/24` → `Captured n of 24…`); ~2–4 min at 5–10s pacing
- [ ] `Downloads/instagram-captures/<handle>/<date>/` holds ~24 covers + `_avatar.jpg` + `capture.json`
- [ ] **Covers only** — a carousel contributes exactly ONE file, and a reel's file is a **`.jpg`
      poster, not an `.mp4`**
- [ ] `capture.json` → `posts[0]` is the **pinned** post if the grid shows one, with
      `"pinned": true`, and `posts[]` order matches the grid top-to-bottom
- [ ] `capture.json` → `profile.display_name` / `avatar_url` populated ✅ verified 07-17 ("Seb 👋")
- [ ] **`capture.json` → `profile.biography` / `followers` / `following` / `posts_count`
      populated** ✅ verified 07-17 on v0.4.3 (27692 / 360 / 27, cross-checked against an
      independent `web_profile_info` call). Console logs `[IGFM] profile payload: hit (N cached)`.
      A `miss` means the tap didn't see it — **check `TAP_URL_RE` covers the endpoint before
      touching the matcher** (gotcha #25 — that was the bug for two rounds). **Cross-check the
      numbers against the real profile**: they must be that handle's, not the logged-in viewer's,
      whose profile IS embedded in every page (gotchas #22/#26). `external_url: ""` is a real
      answer (no link); `null` means the payload never arrived
- [ ] No file from a profile you didn't capture (gotcha #18 — the tap also caches suggested posts)
- [ ] **Shift-click** → every carousel slide lands, suffixed `-01…-NN`
- [ ] Re-running overwrites `capture.json` (not `capture (1).json`) — data: URL downloads are the
      likeliest thing to be blocked here; check the SW console if it's missing
- [ ] Then place it: `node placement/manifest.cjs /mnt/c/Users/<user>/Downloads/instagram-captures/<handle>/<date>`

### Agent placement engine (built + live-verified 2026-07-17)

A capture folder becomes a dated Section holding a filled clone of the Figma IG-UI template.
**Just ask** — "place the solarity capture" — and the `instagram-moodboard-placement` skill runs,
via the `instagram-moodboard-placer` agent (it absorbs ~35 MCP calls and reports back tight).
You'll be asked for the socket channel; an agent can't discover it.

Preconditions: the **bun socket server** on 3055 + the **fork's** dev plugin open in Figma
("Talk to Figma (fork)" — the community one lacks `set_image_fill`).

By hand, the manifest half is:

```bash
node placement/manifest.cjs /mnt/c/Users/<user>/Downloads/instagram-captures/<handle>/<date>
```

Posts follow `capture.json`'s feed order (pinned first), falling back to shortcode→pk order for a
hand-captured folder; capped at the template's 24 slots; a carousel places its cover only; a video
places its poster. No copy step — WSL reads the Windows Downloads folder in place. Map + gotchas:
[`placement/PLACEMENT.md`](placement/PLACEMENT.md).

**Type badges (▶ reel · ⧉ carousel · 📌 pinned) — BUILT 2026-07-17.** `manifest.cjs` tags each slot
with a `badge` (`badgeFor`, unit-tested; a pin outranks the media-type glyph); placement clones the
matching white-vector source — `badge-reel` / `badge-carousel` / `badge-pinned`, hand-pasted into
Figma from [`assets/icons/`](assets/icons/) — into the tile's top-right corner. Verified end-to-end on the
placed `@solarity.studio` board — all 24 tiles retro-fitted 2026-07-18, badges match the manifest
tile-by-tile. Recipe: [`PLACEMENT.md`](placement/PLACEMENT.md) → Type badges.

**Still open — optional polish, nothing blocking.** Both halves of v2 shipped and are
Chrome-verified; the crawler and `capture.json` feed order are **built**, not pending.

- **Highlights** — deleted at placement today, which is honest. Wiring them for real needs its own
  probe first: the tray is a surface the tap may never see.

**Decided against (2026-07-17) — spill past 24 posts.** A capture is 24 posts, full stop. It was
never reachable anyway (the crawl caps at 24), and building it would mean raising that cap → a
longer crawl → more rate-limit exposure, which is this tool's main ToS mitigation. Not worth it for
a bigger board. **`manifest.overflow` stays** — it honestly reports "you handed me N, I placed 24"
for a hand-captured folder; it just never grows a second frame.

**Closed as void:** talk-to-figma **server detection**. The old plan gated the capture button on the
socket server being up, back when capture and placement were one flow. The shipped design decouples
them — the crawl writes a folder and never touches Figma, so gating it on Figma would block a
capture that doesn't need it. Reaching the socket would also need `host_permissions`, which this
extension deliberately doesn't take (permissions stay `["downloads"]`).

**Never:** stories · DMs.
