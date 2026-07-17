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
MCP) is the tool's real differentiator. The **agent-side placement engine works end-to-end**
(verified live 2026-07-17 — see [`placement/PLACEMENT.md`](placement/PLACEMENT.md)), and the
**profile crawler is written (v0.4.0) but NOT yet verified in Chrome** (blocker B4): a fixed
"Capture profile" button crawls the grid and writes covers + `capture.json` into
`Downloads/instagram-captures/<handle>/`. Treat the crawl as unproven until the README's profile
checklist passes on a real profile.

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
  crawler.js       v2 profile crawl: grid enumeration, cover planning, capture.json
                   (global: IGFM_CRAWLER). Pure half is Node-tested; scrolling is not.
  content.js       button injection + delegated click flow (all IG-DOM heuristics live here)
  content.css      button/toast styles
  background.js    thin SW: chrome.downloads only
  inject.js        in-page media resolver (MAIN world, standalone): fetch/XHR tap → embedded
                   JSON scan → fiber walk; exports for Node tests
placement/
  manifest.cjs     v2, agent-side: capture folder → ordered placement manifest (which file lands
                   in which grid slot). Pure half exported for tests; CLI does the I/O + ffmpeg
                   posters. Runs in Node, never in the browser.
  PLACEMENT.md     the talk-to-figma MCP recipe + the live template map + placement gotchas
captures/          gitignored scratch for DERIVED artifacts (ffmpeg posters) — not a copy target
test/run-tests.cjs Node tests: resolver's pure half + in-page engines + the placement manifest
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
   A partial in-page result (cover-only carousel) is not accepted as final — it is passed as
   the **seed** into the escalation chain below, contributing its media `pk`.
2. **Post-page HTML embed** — fetch `/p/<shortcode>/` with session cookies; pick the RICHEST
   candidate across ALL JSON blobs (`pickMediaFromHtml`): the first `web_info` may be
   cover-only with `carousel_media_count` declared while a deferred chunk carries the
   children.
3. **Media-info REST completion** — `GET /api/v1/media/<pk>/info/` (`X-IG-App-ID`), fired when
   the best result so far still `needsCompletion` AND carries a `pk`. Returns the FULL item
   (all `carousel_media`) and, unlike GraphQL, has **no `doc_id` to rot** — this is what closes
   the cold direct-permalink case, including the masked ad-carousel whose embed cover lies about
   its type (see Gotcha #14).
4. **GraphQL `doc_id` query** — POST `/graphql/query` (`X-IG-App-ID` + csrf cookie) →
   `xdt_shortcode_media`; last network attempt, fired only while still partial — the richer
   result wins.
5. **DOM harvest** — largest `srcset` candidates in the clicked container; images only; last
   resort (a carousel only has 3–4 slides mounted at any instant).

A result **needs completing** (`needsCompletion`, the escalation trigger) when it is a partial
carousel — `isPartialCarousel`: `expectedCount > items.length`, or typed a carousel (`media_type
8` / `product_type carousel_container` / `__typename` GraphSidecar) with < 2 children — **OR** it
is a lone **image** carrying a `pk` from an *untrusted* source (server-embedded blob / permalink
HTML / fiber), which could be a masked ad-carousel cover (Gotcha #14). A lone image from a LIVE
API response (`network_cache` / `graphql` / `media_info`) is trusted and needs no extra call.

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
14. **On a COLD direct permalink, an ad-carousel COVER LIES about its type** — the load-bearing
    2026-07-14 finding. Opening `/p/<code>/` fresh (not via feed/modal) fires no in-app fetch, so
    the tap is empty and the only in-page data is the server-embedded cover. For a sponsored
    carousel (`product_type: ad`) that cover advertises **`media_type: 1` and
    `carousel_media_count: null`** — i.e. it looks *exactly* like a genuine single-image post.
    So you **cannot** detect the masked carousel by type or count (that was the v0.3.1 mistake);
    `isPartialCarousel` returns false and the 1-of-8 cover gets accepted. The tell is the
    **source + a pk**: a lone image is only trustworthy when it came from a LIVE API response
    (the network tap, or our own graphql/media-info calls); a lone image from an *untrusted*
    source (server-embedded blob / permalink HTML / fiber) that carries a `pk` must be confirmed.
    Fix (v0.3.2) = `needsCompletion(m)`: partial OR (lone **image** + `pk` + untrusted `source`)
    → escalate to **`GET /api/v1/media/<pk>/info/`** (Instagram's own REST endpoint, no `doc_id`
    to rot), which returns the true `media_type 8` + all children. Verified live: `media/info`
    for pk `3904872284116778650` → HTTP 200, 8 children, while the permalink embed showed 1. The
    in-page result is passed as a `seed` into `fetchMediaByShortcode(shortcode, seed)` so the pk
    survives the (bare-shell) HTML embed, which is skipped for a lone-image seed. Note a plain
    `fetch('/p/<code>/')` of an ad often returns a bare HTML shell with **no `web_info` at all** —
    another reason the pk (from the in-page cover) is the load-bearing handle. Still
    data-not-pixels — no carousel-UI walking. A `network_cache` lone image is trusted (it *is*
    the live API response), so genuine single-image feed downloads take no extra request; only
    untrusted lone images do. If `media/info` genuinely fails, a masked carousel is
    indistinguishable from a real single post, so it saves 1 file (best effort) — a *known*
    partial (count/type from a warm source) still reports `N of M slides` honestly.
15. **A reel's `/reels/audio/<id>/` attribution link is a shortcode DECOY** — verified live
    2026-07-14 on reel `DY_HBkqxebO`. On a reel page the audio/music-attribution link
    (`/reels/audio/1975396383375922/`) sits BEFORE the reel's own link in DOM order, and `audio`
    (5 chars) matches the code pattern — so a first-match `<a>`-scan captured `shortcode="audio"`,
    every lookup missed (`via:null` despite a warm cache holding the real .mp4), and it collapsed
    to the images-only DOM fallback (6 stray poster JPGs, no video). Two-part fix: (a) resolve the
    shortcode from **canonical page signals first** — `location.pathname` → `<link rel=canonical>`
    → `og:url` — and only scan container `<a>` links as the feed/multi-post fallback (a permalink
    `container` can be a broad `<main>` full of unrelated links); (b) harden `shortcodeFromUrl` to
    scan ALL matches and reject `audio` + all-numeric captures (audio/collection ids are numeric;
    real shortcodes always contain letters). Match by `/reel/` (singular) and `/p/`; `/reels/`
    (plural) is the reels feed / audio pages, never a post code — accept `/reels/<code>/` only
    after the reject filter. Also made the DOM fallback video-aware (a direct http(s)
    `<video>`/`<source>` src), but it still refuses `blob:` MSE URLs (gotcha #3) — the reel's real
    .mp4 comes from the network tap once the shortcode is correct, not from the DOM.
16. **The fullscreen Reels viewer's action bar is a VERTICAL rail (`<div>`, not `<section>`)** —
    reported 2026-07-14 on `/reel/<code>/`. `findActionBar` only matches an innermost `<section>`
    with ≥2 `svg[aria-label]`, so it misses the rail entirely and no button appears. `findReelRail`
    handles it: the rail is the element that is the common grandparent of the most icon action
    buttons (each item = `wrapper > [role="button"] > svg[aria-label]`), found by **majority vote**
    over `button → wrapper → rail`, requiring ≥3 (Like/Comment/Share/Save/More). Do this
    **structurally — never by aria-label TEXT** (gotcha #2: locale — `Save`/`Salvar`/`Guardar`… —
    AND the Save label flips to `Remove`/`Remover` once bookmarked). Placement: insert before the
    **last `svg[aria-label]` item** (the "…" menu); the trailing audio-thumb/spacer has no labelled
    svg so it's excluded, landing the button right after Save without naming any label. Inherit the
    rail's spacing by **copying a live sibling item's `className`** — the `x…` classes are
    build-hashed and rotate between IG deploys, so the structural walk + copied class is durable
    where hard-coded classes are not. The rail re-renders (React swaps the whole column) when
    scrolling between reels; the existing MutationObserver + `.igfm-btn` self-heal re-injects. Only
    tried when `findActionBar` returns null, so it never competes with the feed/modal bar.
    **Chrome-verified 2026-07-14** (`/reel/DY_HBkqxebO/`): the button seats at rail child index 5
    (= Save+1 = More−1), white icon, matching 52px rhythm; survives reel-swap in both directions
    with no duplicate; still present with the Save→`Remove` label flipped; rail = 8 direct children
    and `section` count = 1 (nothing for `findActionBar` to grab first).

17. **The tap's cache order is NOT feed order — our own ingest reverses it.** `collectMedia` is a
    stack DFS: it pushes an array's items `0..N` then `pop()`s, so **every array it walks comes
    out reversed**. Probed live 2026-07-17 on `@solarity.studio`: `cache_order` was **exactly
    `reverse(grid_order)`** (verified element-by-element). Instagram returns the profile's posts
    in correct feed order, pinned first — we scramble them on ingest. **Read order from the DOM
    grid, never from `_mediaCache`.** Do NOT "fix" `collectMedia` to preserve order: it is
    hardened resolution code where order is irrelevant, and the DOM already has the answer.
18. **The tap caches MORE than the grid** — 31 media objects vs 27 grid posts on the same probe.
    The extras come from suggested/related rails, i.e. **other people's posts**. Dumping the cache
    into a capture would put strangers' media on the moodboard. The DOM grid list is therefore
    both the ORDER and the FILTER.
19. **A pinned post breaks shortcode/pk ordering — this is not hypothetical.** `@solarity.studio`'s
    grid slot 1 (`DEU1LbwxhF0`) is the **OLDEST** of its first 12 posts (pk rank 12/12): pk order
    buries it last, the grid shows it first. So `capture.json`'s `feedOrder` is **mandatory**, not
    a nicety — pk order is only the fallback for a hand-captured folder with no sidecar. The pin
    itself is readable: **`timeline_pinned_user_ids`** (probe-verified) exists on every item but is
    non-empty only on the pinned one.
20. **Covers-only must NOT write a `-NN` suffix, and the avatar must not look like a post.**
    `planDownloads` only suffixes multi-item posts, so `placement/manifest.cjs` folds a **lone
    `-01`** back into the shortcode (it reads it as a code whose tail looks like an index) — a
    cover saved as `<user>-<code>-01.jpg` would be placed as post `<code>-01`. Same trap for the
    avatar: `<handle>-avatar.jpg` parses as a post with shortcode `"avatar"` and would take a grid
    slot, so it is written as **`_avatar.jpg`** (no hyphen → the parser skips it).

## Validate / test

```bash
node --check extension/*.js placement/*.cjs
node test/run-tests.cjs        # resolver's pure half + in-page engines + placement + crawler
```

Browser-facing changes also require the manual unpacked-extension pass in a real logged-in Chrome
(`README.md` → Verify in Chrome). **This WSL env has no GUI Chrome** — separate automated evidence
from pending in-Chrome verification, and say which is which when reporting status.

## Definition of done

- `node test/run-tests.cjs` passes; changed JS files pass `node --check`.
- MVP stays single-post, user-initiated, client-side; permissions stay `["downloads"]`.
- New non-obvious failure modes land in **Gotchas** above; status changes on the ideas board
  (`knowledge/ideas/README.md`) only after they're actually true (in-Chrome verification for
  runtime claims, a live Figma pass for placement claims).
- Placement changes: **re-read the live template first** — it is hand-edited between sessions and
  every rework reassigns node ids (see PLACEMENT.md → Template map).

## Common mistakes

- Binding click listeners per injected button instead of delegating (gotcha #1).
- Matching IG chrome by English aria-labels on a PT-BR profile (gotcha #2).
- Downloading `blob:` video URLs (gotcha #3).
- Adding host_permissions/cookies to move resolution into the SW (gotcha #5).
- Trusting a recorded template node id or slot size — the template is hand-edited between
  sessions; the 2026-06-24 map was fully stale by 2026-07-17 (ids AND tile sizes).
- Copying media into `captures/` before placing it — unnecessary: WSL reads the Windows
  Downloads folder directly and the MCP server resolves `imagePath` in that same filesystem.
- Taking post ORDER from the tap's cache (gotcha #17) or from pk order when a `capture.json`
  exists (gotcha #19) — the DOM grid is the only source of feed order.
- Guessing at Instagram's data shape instead of probing it live. Every expensive round in this
  project (#11–#14, #17–#19) ended with a probe correcting an assumption; the probes are cheap.
