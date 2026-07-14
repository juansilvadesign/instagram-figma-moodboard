# Instagram Moodboard Capture — single-post MVP

One-click download of an Instagram post's media from a **logged-in Chrome profile**. An injected
button on each post saves its image, video, or full carousel to
`Downloads/instagram-captures/<username>-<shortcode>[-NN].<ext>`.

This is the **MVP** of the [Instagram → Figma moodboard idea](../../ideas/instagram-figma-moodboard.md)
— the v2 (capture a whole profile → auto-place into the Figma Instagram-UI template via
talk-to-figma) is spec'd there and gated on its B1 blocker. Working conventions + gotchas for
sessions in this repo: [`CLAUDE.md`](CLAUDE.md).

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

> First pass ✅ 2026-07-08 — confirmed working on live posts. Re-run this list after any change to
> the DOM heuristics in `content.js`.

This WSL env has no GUI Chrome, so the automated tests can't click the real page. A change counts
as **verified** when, in a logged-in Chrome:

- [ ] Feed **single image** post → 1 correctly-named `.jpg`/`.webp` in `Downloads/instagram-captures/`
- [ ] Feed **carousel** → all items land, `-01…-NN`, mixed image/video types correct
- [ ] **Video/Reel** post → `.mp4` that plays **with audio**
- [ ] **Profile grid → modal** → button present in the modal, download works
- [ ] **Permalink page** (`/p/<code>/`) → button present, download works
- [ ] **Feed carousel with deferred data, WARM tap** (open via feed → modal, e.g.
      `DYw5KdMDH6a`) → ALL N slides land via `network_cache` (or `embedded_json`)
- [ ] **Same carousel via DIRECT permalink, COLD tap** (paste `/p/DYw5KdMDH6a/` into a fresh
      tab, click) → ALL N slides still land; `[IGFM] media resolved via media_info` — the
      cover-only embed is completed from the media `pk` (the v0.3.1 fix for the cold case)
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
node test/run-tests.cjs   # resolver + in-page engines (tap cache, payload scan, fiber walk) — 52 tests
node --check extension/*.js
```

## How it resolves media (short version)

Shortcode from the post's links (or the URL) → resolve inside the page (MAIN-world
`inject.js`): a fetch/XHR **tap cache** of the page's own feed/graphql responses (the only
place full carousel + sponsored data still exists client-side), then server-embedded JSON
blobs, then React fiber props. A cover-only in-page result seeds the escalation chain → fetch
`/p/<shortcode>/` and pick the richest embedded JSON across all blobs → if still a partial
carousel, complete it from the media `pk` via `/api/v1/media/<pk>/info/` (Instagram's own REST
endpoint — no `doc_id` to rot; this covers a cold direct-permalink load) → GraphQL `doc_id`
query → last-resort DOM `srcset` harvest (images only). Media URLs are direct CDN files
(signed), saved by the service worker via `chrome.downloads`. Details + failure modes:
[`CLAUDE.md`](CLAUDE.md) → Architecture / Gotchas.

## Not in the MVP (v2, see the idea note)

Full-profile crawl · Windows→WSL `captures/` copy · Claude agent placement into the Figma
IG-UI template · talk-to-figma server detection · stories/DMs (never).
