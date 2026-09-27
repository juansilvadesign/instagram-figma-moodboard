# Instagram → Figma Moodboard — Build Task Tracker

> **Open this first, every session.** This file is the running state of the project. Check a box
> only when the corresponding evidence exists; leave a one-line note when work is partial.
> Deferred v3+ scope lives in [`ROADMAP.md`](ROADMAP.md); architecture, invariants, and hard-won
> failure modes live in [`CLAUDE.md`](CLAUDE.md); installation and manual browser checks live in
> [`README.md`](README.md); the volatile Figma template map lives in
> [`placement/PLACEMENT.md`](placement/PLACEMENT.md); the original plan and decision history live
> in [`../../ideas/instagram-figma-moodboard.md`](../../ideas/instagram-figma-moodboard.md).

**Scope of this tracker:** the shared `instagram-figma-moodboard` tool — both Chrome-extension
capture modes and this repo's placement manifest. The Talk-to-Figma fork, placement skill, and
placement agent are dependencies with their own homes; do not silently rebuild or fork them here.

**Three levels of done — do not conflate them:**

- **Single-post MVP — ✅ SHIPPED and Chrome-verified 2026-07-08.** One click saves an image,
  progressive video with audio, or every carousel item from the post the user is viewing.
- **Profile → Figma v2 — ✅ SHIPPED and verified end-to-end 2026-07-17.** One click captures the
  newest 24 profile covers plus truthful profile metadata into a dated folder; an agent places
  that folder into a dated Figma Section.
- **Badges + story highlights — ✅ SHIPPED 2026-07-18.** Type badges were verified tile-by-tile;
  the most recent evidence in [`placement/PLACEMENT.md`](placement/PLACEMENT.md#story-highlights-built-2026-07-18)
  records the highlights Chrome capture and live placement pass as cleared. Some older status text
  still says that pass is pending; fixing that documentation drift is the current open work.

**Current planning frame:** v2 is shipped and there is no committed v3 deadline or active feature
budget. Maintenance is evidence-triggered. When a release is explicitly activated, cap it at one
focused build session by default and flex scope to fit; do not turn a confirmed regression into an
unbounded redesign. Re-plan after the live verification for each release.

---

## ✅ Current baseline (2026-07-28 · code HEAD `0ecd6d8`)

- [x] **119 Node tests pass** — `node test/run-tests.cjs`.
- [x] **All shipped JavaScript parses** — every file under `extension/*.js` and
  `placement/*.cjs` passes `node --check`.
- [x] **The extension remains plain Manifest V3** — no build step, no server, and permissions
  remain exactly `["downloads"]`.
- [x] **The two halves remain decoupled** — capture writes a folder without needing Figma;
  placement later reads that folder in place through WSL.
- [x] **The original outcome is met** — the manual download-and-arrange day has been reduced to a
  user-triggered profile capture plus an agent placement run.

## ▶ Next session — start here

**There is no unfinished product feature. The next work is truth maintenance, then stop unless a
real regression or an explicitly selected roadmap release exists.**

1. [ ] **Reconcile story-highlights status across the docs.** `README.md`, the idea note, and the
   ideas board still say the B4 Chrome/live-placement pass is pending; the newer
   `placement/PLACEMENT.md` evidence says it cleared on 2026-07-18. Make the newest verified state
   consistent everywhere without rewriting the historical build log.
2. [ ] **Reconcile the extension version label.** `extension/manifest.json` still says `0.4.3`,
   while badges and highlights shipped afterward. Decide whether those additions constitute
   `0.4.4` or `0.5.0`, then update all current-version references together. Do not bump it for
   documentation-only edits.
3. [ ] **If Instagram drift is reported, reproduce before changing code.** Capture the exact
   surface, shortcode/handle, resolver trace, and relevant DOM/network shape; then activate
   [`ROADMAP.md` R1](ROADMAP.md#ordered-deferred-releases).
4. [ ] **If no regression exists, choose at most one roadmap release with the user.** Do not build
   speculative resilience, add permissions, or introduce orchestration merely because the core
   project is complete.

**Already settled — do not reopen without new evidence:** a capture is 24 posts; the DOM grid is
the order and owner filter; `capture.json` feed order beats media-pk order; carousels occupy one
grid tile; videos use poster images in Figma; capture does not wait for the Figma socket; media is
read directly from `/mnt/c/...`; and wrong profile data is worse than missing profile data.

**Hard ordering:** a browser-facing change is not done after Node tests — it needs the manual
logged-in Chrome pass. A placement change is not done after manifest tests — it needs a fresh read
of the live template and a Figma export check.

---

## Phase 1 — Single-post capture MVP ✅ DONE 2026-07-08

- [x] **1.1 Plain MV3 extension** — load `extension/` unpacked; no build pipeline or runtime
  dependency.
- [x] **1.2 Structural button injection** — delegated capture-phase click handler survives React
  re-renders and avoids locale-dependent aria-label text.
- [x] **1.3 Media normalization** — images, progressive MP4 video with audio, and complete
  carousels collapse into one download plan.
- [x] **1.4 Thin service worker** — `background.js` only performs `chrome.downloads` writes.
- [x] **1.5 Honest local filenames and feedback** — stable username/shortcode naming, numbered
  carousel items, and partial-result toasts.
- [x] **1.6 Live Chrome pass** — feed, modal, permalink, and ordinary post flows verified.

## Phase 2 — Instagram resolution hardening ✅ DONE 2026-07-14

- [x] **2.1 MAIN-world response tap** — fetch/XHR responses seed an owner-safe, in-memory media
  cache without new harvesting requests.
- [x] **2.2 Deferred carousel support** — newline-delimited `@defer` chunks are parsed and the
  richest exact-shortcode candidate wins.
- [x] **2.3 Escalation chain** — in-page cache → embedded JSON → React fiber → post HTML →
  media-info REST → rotating GraphQL fallback → DOM floor.
- [x] **2.4 Cold masked ad-carousel fix** — an untrusted lone image carrying a media pk is
  confirmed through `/api/v1/media/<pk>/info/`.
- [x] **2.5 Reel shortcode hardening** — audio-attribution decoys and numeric collection ids cannot
  masquerade as post codes.
- [x] **2.6 Fullscreen Reels rail support** — the button is found and seated structurally, survives
  reel swaps, and does not depend on translated Save/Remove text.
- [x] **2.7 Live Chrome regression evidence** — warm and cold carousels, reel audio, and the
  fullscreen rail were verified on real posts.

## Phase 3 — Whole-profile capture ✅ DONE 2026-07-17

- [x] **3.1 Grid enumeration** — the DOM grid supplies both feed order and owner filter; the tap
  supplies complete media data.
- [x] **3.2 Bounded crawl** — 24 posts maximum, covers-only by default, Shift-click for every
  carousel item, randomized 5–10 second pacing.
- [x] **3.3 Dated archive contract** — one capture writes to
  `<handle>/<YYYY-MM-DD>/`, making same-day reruns idempotent without overwriting another day.
- [x] **3.4 Truthful `capture.json`** — feed order, pin/type/item metadata, profile header fields,
  avatar, and later story highlights; fields remain null when owner-matched evidence is absent.
- [x] **3.5 Owner isolation** — media, profile, and highlight caches are keyed/read by the exact
  target; suggested users and the logged-in viewer cannot leak into a board.
- [x] **3.6 First live profile run** — `@solarity.studio`, 24/24 posts, 0 skipped, pinned item at
  slot 0, avatar + sidecar written.
- [x] **3.7 Real header** — display name, bio, link, and counts were captured from
  `/api/graphql` at zero extra requests and cross-checked against the target profile.

## Phase 4 — Agent-side Figma placement ✅ DONE 2026-07-18

- [x] **4.1 Placement manifest** — parses the capture folder, consumes `capture.json`, caps at 24,
  reports overflow/unfilled slots, and flags poster needs.
- [x] **4.2 Honest ordering** — sidecar feed order wins; shortcode→media-pk ordering is only the
  hand-captured-folder fallback.
- [x] **4.3 Dated Section placement** — clone the live template into
  `<handle> · <date>`, fill the 24 structural grid slots, and write only known profile data.
- [x] **4.4 Video posters** — hand-captured MP4s get a representative ffmpeg thumbnail; profile
  crawls normally use Instagram's poster image.
- [x] **4.5 Type badges** — reel, carousel, and pinned glyphs are derived by the manifest and
  cloned from the live template; pin wins when types overlap.
- [x] **4.6 Story highlights** — owner-keyed tray data is captured in order, capped at eight,
  placed into the ring row, and surplus rings are removed.
- [x] **4.7 End-to-end evidence** — the profile board was placed live; all 24 badge assignments
  were export-checked; the highlights capture + placement pass is recorded as cleared in
  `placement/PLACEMENT.md`.

## Phase 5 — Documentation truth & maintenance

- [x] **5.1 Add the running tracker and deferred roadmap** — `TASKS.md` + `ROADMAP.md`
  (2026-07-28).
- [x] **5.2 Re-run the automated baseline before recording the tracker** — 119 passed, 0 failed;
  syntax checks clean (2026-07-28).
- [ ] **5.3 Remove stale highlights-pending claims** — current docs should agree with the newest
  dated verification evidence.
- [ ] **5.4 Decide and apply the post-`0.4.3` version** — one version source, one changelog truth.

---

## Cross-cutting checklist (apply to every change)

- [ ] **Authorized and user-initiated only.** No DMs, login/DRM bypass, unattended mass harvesting,
  or data the logged-in user is not already authorized to view. Stories only through the
  story-viewer button, one click at a time (R9, allowed 2026-09-27).
- [ ] **Permissions stay minimal.** Adding `host_permissions`, cookies, native messaging, storage,
  analytics, or a server requires a newly demonstrated need and an explicit decision.
- [ ] **Data, not pixels.** Resolve media from Instagram's data; do not walk carousel UI or save
  `blob:` video URLs.
- [ ] **Exact owner, exact post.** Wrong data is worse than null; never accept “richest” or “first
  seen” without the target username/shortcode key.
- [ ] **DOM grid controls profile order and membership.** Tap-cache order is reversed and includes
  suggested content; never use it as the board list.
- [ ] **Bytes and disk beat metadata.** Match downloaded files by parsing the folder; Instagram
  URL extensions and `capture.json` advisory filenames can disagree with Chrome's saved files.
- [ ] **Template structure is live state.** Re-read the current file every placement run; node ids,
  sizes, vector serialization, and auto-layout behavior are volatile.
- [ ] **Automated evidence:** `node test/run-tests.cjs` plus `node --check` on every changed JS/CJS
  file.
- [ ] **Runtime evidence:** logged-in Chrome for browser changes; live Figma placement/export for
  placement changes. State clearly when either pass is still pending.
- [ ] New non-obvious failure modes go in `CLAUDE.md`; volatile template findings go in
  `placement/PLACEMENT.md`; deferred ideas go in `ROADMAP.md`.

## Open decisions

- [ ] **Current release number** after the post-`0.4.3` badge and highlights work.
- [ ] **Desktop-only or mobile template variant?** The current board intentionally mirrors the
  existing desktop Instagram profile template.
- [ ] **Which deferred benefit matters next?** No v3 item is approved merely by appearing in the
  roadmap.

## Inputs needed only when work is activated

- **For a live regression:** exact Instagram URL/surface, expected media count, actual result,
  `[IGFM]` resolver trace, and whether the tab was reloaded after reloading the extension.
- **For a placement run:** exact capture-folder path, Figma socket channel, and the currently open
  target file/template.
- **For a new roadmap release:** the user benefit to optimize and the one-session capacity/deadline
  it must fit.
