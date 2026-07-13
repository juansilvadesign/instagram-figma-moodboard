# CLAUDE.md — Instagram → Figma Moodboard Capture

Operating contract for Claude Code sessions in this project. Read [`README.md`](README.md) for
install + the manual verification checklist. The captured idea/spec history (v2 architecture,
blockers, Figma placement contract) lives at
[`knowledge/ideas/instagram-figma-moodboard.md`](../../ideas/instagram-figma-moodboard.md).

## Product in one paragraph

A personal Manifest V3 Chrome extension used **inside a logged-in Chrome profile**. The shipped
MVP is **single-post capture**: an injected button on any Instagram post downloads that post's
media — image, video, or every item of a carousel — to `Downloads/instagram-captures/`, named
`<username>-<shortcode>[-NN].<ext>`. The v2 (full-profile → Figma moodboard via the talk-to-figma
MCP) is the tool's real differentiator and is **not built**; it stays gated on blocker **B1**
(talk-to-figma cannot insert bitmaps) — see the idea note before touching any Figma work.

## Decisions (2026-07-07 build)

- **Download path = client-side `chrome.downloads`** (twitter-video-downloader shape), **not** the
  one-click-video-downloader native host. Instagram serves post images as direct CDN JPG/WebP URLs
  and post/reel videos as **progressive MP4s with muxed audio** (`video_versions`) — nothing to
  remux or merge, so yt-dlp/ffmpeg buy nothing here. If a video ever lands without audio, that
  post was DASH-only: that is the trigger to consider the native-host path, not before.
- **Plain MV3, no build step** (sibling pattern) — load the `extension/` folder unpacked as-is.
- **Resolution = data, not pixels.** The post's media list comes from Instagram's own JSON
  (embedded page data → GraphQL fallback), never from screenshotting or scraping rendered media.
- Single-post Instagram support lives **here**, not bolted onto a downloader sibling — both modes
  (MVP + v2 profile crawl) share this one codebase.

## Hard constraints (never violate)

- **Authorized, user-initiated, single-post per click.** Media the user is already viewing as a
  logged-in follower. No bulk/timeline harvesting in the MVP, no login-wall or DRM bypass, no DMs,
  no stories. (v2's full-profile mode is the considered exception, spec'd in the idea note with a
  safe delay.)
- **Client-side only for the MVP.** No server, no native messaging, no analytics.
- **Clone sibling patterns, never couple** to any workspace runtime (no psiativa n8n/Postgres, no
  juansilva portfolio). This is a shared `knowledge/` tool.
- **`captures/` stays local and gitignored** (it's the v2 hand-off folder; the MVP doesn't use it).
- **No transcode.** Direct CDN files only.

## Architecture

```
extension/
  manifest.json    permissions: ["downloads"] only — no host_permissions needed (see Gotchas #5)
  resolver.js      media resolution + pure helpers (global: IGFM_RESOLVER)
  content.js       button injection + delegated click flow (all IG-DOM heuristics live here)
  content.css      button/toast styles
  background.js    thin SW: chrome.downloads only
  inject.js        in-page media resolver (MAIN world, standalone): fetch/XHR tap → embedded
                   JSON scan → fiber walk; exports for Node tests
test/run-tests.cjs Node tests: resolver's pure half + the in-page resolver engines
```

Flow: click → shortcode (container links, else URL; may be null for ads) → chain, first
non-partial hit wins:

1. **In-page resolution (MAIN-world `inject.js`)** — content.js marks the container with
   `data-igfm-req` and sends `igfm-request-react` (JSON-string detail); inject.js answers from
   (a) its **network-response cache** — a `window.fetch`/XHR tap on `/graphql/query` +
   `/api/v1/` installed at document_start (in-memory LRU keyed by shortcode, never persisted),
   (b) a lazy scan of server-embedded `<script type="application/json">` blobs, then
   (c) the **fiber walk** — `fiber.return` ancestors first, budgeted BFS second, exact
   shortcode match, hooks included (still needed for surfaces with fat props / ads with no
   permalink). This is the PRIMARY source for feed + sponsored carousels: the 2026 feed keeps
   post data in the Relay store, not fiber props, and `/p/` embeds are cover-only (both
   verified live 2026-07-13).
2. **Post-page HTML embed** — fetch `/p/<shortcode>/` with session cookies; pick the RICHEST
   candidate across ALL JSON blobs (`pickMediaFromHtml`): the first `web_info` may be
   cover-only with `carousel_media_count` declared while a deferred chunk carries the
   children. A partial carousel (`expectedCount > items.length`) is not accepted as final.
3. **GraphQL `doc_id` query** — POST `/graphql/query` (`X-IG-App-ID` + csrf cookie) →
   `xdt_shortcode_media`; also fired when #2 came back partial — the richer result wins.
4. **DOM harvest** — largest `srcset` candidates in the clicked container; images only; last
   resort (a carousel only has 3–4 slides mounted at any instant).

Normalized media → `planDownloads()` → SW saves each URL via `chrome.downloads`
(`conflictAction: 'uniquify'`).

## Gotchas (already learned — do not relearn)

1. **Event delegation on Instagram, not per-button listeners** (TVD lesson): one capture-phase
   `document` click listener; React re-renders orphan per-button listeners and IG's own handlers
   swallow bubbled events. The MutationObserver only (re)inserts buttons.
2. **Never select by aria-label text.** Labels follow the profile's UI language (this user's
   Chrome runs PT-BR: "Curtir", "Salvar"). The action bar is found structurally: innermost
   `section` with ≥2 `svg[aria-label]` and no `form`/`textarea`.
3. **Never download the `<video>` element's URL** — it's a `blob:` MSE URL, useless outside the
   page. Videos must come from `video_versions` / `video_url` in the JSON.
4. **`GRAPHQL_DOC_ID` rots.** Instagram rotates persisted query ids. Symptom: fallback #2 dies
   ("graphql returned no media") while fallback #1 keeps working. Fix: grab the current
   PolarisPostActionLoadPostQuery doc_id from DevTools → Network on a post page.
5. **Resolution must stay in the content script.** Its fetches ride the page's logged-in
   same-origin session; the MV3 service worker has no DOMParser and would need
   `host_permissions` + cookie juggling to do the same. The signed CDN media URLs need neither
   cookies nor host permissions, so the SW only calls `chrome.downloads`.
6. **Resolve the shortcode at click time, not inject time.** On SPA navigation a permalink
   `<main>` persists across posts — anything cached on the button goes stale.
7. **Feed permalinks may be username-prefixed** (`/<user>/p/<code>/`) — the shortcode regex
   matches the `/p/`segment anywhere in the path, and also `/reel/`, `/reels/`, `/tv/`.
8. **Carousel items come from the API data, never the DOM** — the DOM only renders the current
   slide ± neighbors; `carousel_media` / `edge_sidecar_to_children` has all of them.
9. **Videos also carry `image_versions2`** (poster frame) — check `video_versions` first or every
   video downloads as a JPG.
10. **Append the button to the action-bar section's END, never into its first svg-bearing child**
    — each action sits in its own span, so "first child with an svg" = *inside the Like button*
    (bit us 2026-07-08). The section is the flex row; appending to it lands right of Save.
11. **Fiber traversal direction: the post's data props live on ANCESTOR component fibers** of
    the `<article>` host fiber — climb `fiber.return` first (tens of hops), and only then BFS
    the local graph. A downward `child`/`sibling` DFS capped at a few hundred nodes starves in
    the header subtree and finds nothing (the 2026-07-13 bug: 4 fix attempts searched the wrong
    direction). Guard with a time deadline + property budget + visited sets — not tiny node
    caps — and, when the shortcode is known, accept only an object whose `code`/`shortcode`
    EQUALS it so deep searches can't return a neighboring post. Generic (no-shortcode) matching
    is allowed only on the ancestor chain and never enters arrays (feed lists hold other posts).
12. **MAIN↔ISOLATED bridge**: React fibers (`__reactFiber$`) are only visible in the `MAIN`
    world. CustomEvent details must be JSON **strings** (primitives cross every Chrome's world
    boundary; object details depend on structured-clone behavior and can arrive null). The
    target container is handed over via a `data-igfm-req` attribute — DOM is shared across
    worlds, JS heaps are not. Raw media returns as sanitized JSON; the content script
    normalizes it (`inject.js` is standalone — resolver.js no longer loads in MAIN). Debug
    handle in the page console: `window.IGFM_INJECT`.
13. **A cover-only carousel is a data-routing problem, not a fiber-tuning problem.** Verified
    live 2026-07-13 on an 8-slide carousel (`DYw5KdMDH6a`): fiber graph = 2660 fibers, ZERO
    media props (Relay-store era); `/p/<code>/` = HTTP 200 with only the cover +
    `carousel_media_count: 8`. The full `carousel_media` reaches the client ONLY in network
    responses (timeline/modal GraphQL, sometimes @defer newline-chunked — parse per line).
    Capture at the network layer (fetch/XHR tap). Do NOT "fix" this by programmatically
    walking the carousel DOM — images-only, 3–4 mounted slides, violates resolution-from-data.
    Consequence: after (re)loading the extension the Instagram TAB must be reloaded too, or
    the tap misses the feed responses.

## Validate / test

```bash
node --check extension/*.js
node test/run-tests.cjs        # 41 tests: pure resolver half + in-page resolver engines
```

Browser-facing changes also require the manual unpacked-extension pass in a real logged-in Chrome
(`README.md` → Verify in Chrome). **This WSL env has no GUI Chrome** — separate automated evidence
from pending in-Chrome verification, and say which is which when reporting status.

## Definition of done

- `node test/run-tests.cjs` passes; changed JS files pass `node --check`.
- MVP stays single-post, user-initiated, client-side; permissions stay `["downloads"]`.
- New non-obvious failure modes land in **Gotchas** above; status changes on the ideas board
  (`knowledge/ideas/README.md`) only after they're actually true (in-Chrome verification for
  runtime claims).
- v2/Figma work is **not** started unless blocker B1 (talk-to-figma bitmap insertion) is cleared.

## Common mistakes

- Binding click listeners per injected button instead of delegating (gotcha #1).
- Matching IG chrome by English aria-labels on a PT-BR profile (gotcha #2).
- Downloading `blob:` video URLs (gotcha #3).
- Adding host_permissions/cookies to move resolution into the SW (gotcha #5).
- Bolting the profile crawl onto the MVP "while we're here" — v2 is gated on B1 and on a safe
  crawl delay design; capture the idea, don't build it inline.
