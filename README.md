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

After code changes: `chrome://extensions` → reload the extension → reload the Instagram tab.

## Use

Click the arrow on any post — feed, profile-grid modal, or `/p/…` / `/reel/…` permalink. A toast
reports progress and the saved file count. Carousels download every item, numbered `-01, -02, …`.
Videos save as progressive MP4 (audio included).

## Verify in Chrome (manual pass — pending)

This WSL env has no GUI Chrome, so the automated tests below can't click the real page. The MVP
counts as **verified** when, in a logged-in Chrome:

- [ ] Feed **single image** post → 1 correctly-named `.jpg`/`.webp` in `Downloads/instagram-captures/`
- [ ] Feed **carousel** → all items land, `-01…-NN`, mixed image/video types correct
- [ ] **Video/Reel** post → `.mp4` that plays **with audio**
- [ ] **Profile grid → modal** → button present in the modal, download works
- [ ] **Permalink page** (`/p/<code>/`) → button present, download works
- [ ] Button survives scrolling far down the feed and back (React re-renders)
- [ ] Service-worker console (`chrome://extensions` → Inspect views) shows `[IGFM]` trace, no errors

If the button lands in a weird spot or doesn't appear, grab the failing page's DOM context and fix
the heuristics in `content.js` (`findActionBar` / `postContainers`) — that's the expected drift
point, same as the twitter-video-downloader sibling.

## Automated tests (run in WSL)

```bash
node test/run-tests.cjs   # pure resolver: parsers, normalizers, filename plan — 19 tests
node --check extension/*.js
```

## How it resolves media (short version)

Shortcode from the post's links (or the URL) → fetch `/p/<shortcode>/` with the session's cookies
and parse Instagram's own embedded JSON (`xdt_api__v1__media__shortcode__web_info`) → fallback to
the GraphQL `doc_id` query → last-resort DOM `srcset` harvest (images only). Media URLs are direct
CDN files (signed), saved by the service worker via `chrome.downloads`. Details + failure modes:
[`CLAUDE.md`](CLAUDE.md) → Architecture / Gotchas.

## Not in the MVP (v2, see the idea note)

Full-profile crawl · Windows→WSL `captures/` copy · Claude agent placement into the Figma
IG-UI template · talk-to-figma server detection · stories/DMs (never).
