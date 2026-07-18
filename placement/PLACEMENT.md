# Placement — template map & gotchas (v2)

The **volatile half** of turning a capture folder into a dated moodboard Section: the live
template map, the earned gotchas, and the `capture.json` contract.

> **The PROCEDURE lives in the `instagram-moodboard-placement` skill**
> (`knowledge/skills/instagram-moodboard-placement/SKILL.md`), with the
> `instagram-moodboard-placer` agent as its isolated runner. Split on purpose: the steps are
> stable, this map is not — the template is hand-edited between sessions and every node id and
> tile size here goes stale (once, mid-session). **Re-read the live file every run; treat the map
> below as a hint, never as truth.**

`manifest.cjs` decides **what goes where** (pure, tested). Verified live end-to-end 2026-07-17.

## The capture folder

Read the extension's output **in place** at
`/mnt/c/Users/<user>/Downloads/instagram-captures/<handle>/<date>/`. WSL mounts the Windows
filesystem, and the MCP server (which reads `imagePath` itself) runs in that same filesystem — so
there is **no copy step and no native host**. The plan's old "Windows→WSL copy mechanism" question
is void.

`captures/` is now scratch for **derived** artifacts only (ffmpeg posters), not a copy target.
It stays gitignored.

## Template map (live 2026-07-17 — re-verify before trusting)

The template was rebuilt with auto-layout, which **reassigned every node id and resized every
tile**; the 2026-06-24 map in the idea note is dead. Ids below are the *template's* — a clone's
differ, so always navigate by name+size.

| What | Name | Size | Notes |
|---|---|---|---|
| Root | `Instagram - Claude Test` | 1350×3214 | at absolute (0,0) |
| Post grid | `grid` | 938×2508 | 24 children, row-major, 4px gap |
| Post slot ×24 | `cover` | **310×310** | `IMAGE`/`FILL` leaf; demo slots 0–2 carry an empty type-marker child (`pinned-post`/`clip-reels-content`/`carousel`) over the baked-in placeholder badge |
| Type-badge source ×3 | `badge-reel` ▶ / `badge-carousel` ⧉ / `badge-pinned` 📌 | **20×20** | **page-level** white `VECTOR`s (siblings of the template, not inside it) — placement clones the right one onto each reel/carousel/pinned tile; see *Type badges* |
| Avatar | `pfp` | **150×150** | in `hero > story > old-ring`; cornerRadius 75 |
| Highlight ×8 | `image` | 76×76 | `highlights-bar` → `highlight` group → `cover` → `image`; filled from `manifest.highlights` (step 11), surplus rings deleted |
| Handle | `username` (TEXT) | — | |
| Stats | `1,861`/`posts`, `4M`/`followers`, `454`/`following` | — | count and label are **separate** nodes |
| Name / bio / link | `Marques Brownlee` / `I promise…` / `mkbhd.com` | — | |

## Gotchas

1. **Two nodes are named `pfp`** — the 150×150 avatar and a **24×24 one in the navbar**. Name
   alone hits the wrong one; match on size (or ancestor `hero`).
2. **`cover` is ambiguous too** — the 24 grid slots *and* the 8 highlight covers (83×86) share
   the name. Reach the grid slots via the `grid` frame's children, never a name scan.
3. **The grid is auto-layout wrap** — resizing tiles reflows it. At 310px + 4px gap it hugged to
   938 and kept 3×8; a wider tile would drop to 2 columns and silently break the 24-slot
   assumption. Re-read the grid after any template edit.
4. **Mixed-font text nodes throw** `loadFontAsync: Cannot unwrap symbol` on
   `set_multiple_text_contents`. This bit the 2026-07-16 rehearsal when one node held
   `"1,861 posts"` (bold number + regular label). The rework **split them into single-font
   nodes**, so all 7 header writes now pass. If a future template merges them again, load each
   run's font per node or re-split.
5. **A video cover can't be an image fill** — the manifest flags `needsPoster` and the CLI
   extracts one with ffmpeg (`-vf thumbnail`, not frame 0 — reels often open black). Only
   hand-captured folders need this: Instagram's JSON already carries the poster URL in
   `image_versions2` (resolver gotcha #9), so the v2 crawler should just save it.
6. **`set_image_fill` reports the IMAGE's dimensions**, not the node's — `"pfp" (720x1280)` is a
   720×1280 source in a 150×150 slot, not a resized node.
7. **Never blank a text node to `—` or `""` inside a hug-width auto-layout frame — it collapses
   the frame and turns its siblings VERTICAL.** Live 2026-07-17: the `bio` frame HUGS its widest
   child; the display-name node is **FILL**-width (so it does not drive the hug) while bio/link are
   HUG. Setting bio+link to `—` shrank the frame to a dash's width (~10px), which squeezed the
   FILL-width name to 10px → **"Seb 👋" rendered one character per line**. Replacement text must
   carry real width. Don't leave the template's placeholder either — that makes the board *assert*
   mkbhd's 4M followers for someone else's profile. Write something true and wide instead: capture
   provenance (`Captured <date> · N posts`) in the bio, and the real `instagram.com/<handle>` in
   the link.
8. **Write nothing you don't know.** `capture.json` leaves `biography`/`external_url`/counts null.
   A wrong value is worse than an empty one — a moodboard that claims another account's follower
   count is a lie you'll later believe.
9. **The fork's `get_node_info` does NOT serialize VECTOR content — a vector-bearing frame reads as
   `children: []`.** Every glyph in the template (nav/tab icons, the `badge-*` sources) shows up as
   an empty `icon`/`Vector` frame in the JSON, so "empty children" ≠ visually empty. Verify with
   pixels (`export_node_as_image`) before concluding a node is blank — this cost a full diagnostic
   round on 2026-07-18: the badge *marker* frames really were empty, but the badges on the demo
   tiles were **baked into the placeholder photos**, and only an export told the two apart. Same
   probe-the-truth discipline the rest of the project runs on. **Second confirmed instance,
   2026-07-18 (`@solarity.studio` placement):** the header's verified-checkmark marker frame
   rendered visibly in the export even though its fill read as invisible in `get_node_info` — same
   trap, different node. `capture.json.profile.is_verified` was `false`, so the honest fix is to
   **`delete_node` the checkmark marker frame outright**, not to trust a hidden/invisible fill
   property. Whenever placing a non-verified profile, check the export for a stray checkmark and
   delete the marker if `is_verified` is false — don't assume an unset fill means it won't render.

## capture.json (written by the crawler, v0.4.0)

A profile crawl writes `capture.json` next to the media. **Read it and pass `posts[].shortcode`
as `feedOrder`** — it is authoritative over the pk fallback, because Instagram pins posts (live:
`@solarity.studio`'s pinned post is its OLDEST, at grid slot 1 — pk order buries it last).

```jsonc
{
  "handle": "solarity.studio",
  "captured_at": "2026-07-17",
  "mode": "covers",            // or "full" (shift-click) — every carousel slide
  "profile": {                 // any field may be null — write only what is non-null
    "username": "solarity.studio", "display_name": "Seb 👋", "is_verified": true,
    "avatar_file": "_avatar.jpg", "avatar_url": "https://…",
    "biography": "…", "external_url": "https://…",
    "posts_count": 27, "followers": 4000000, "following": 454,  // raw ints — format for display
    "highlights": [            // story tray, tray order, ≤8; placement fills the ring row (step 11)
      { "title": "Why CUSTOM?", "cover_file": "_highlight_01.jpg" }
    ]
  },
  "posts": [                   // FEED ORDER, pinned first
    { "shortcode": "DEU1LbwxhF0", "type": "carousel", "items": 8,
      "pinned": true, "cover": "solarity.studio-DEU1LbwxhF0.jpg" }
  ],
  "skipped": []
}
```

- `_avatar.jpg` is the avatar (named so `manifest.cjs` can't parse it as a post — gotcha #20).
- `profile.highlights` is the story-highlights tray (tray order, ≤8), each `{title, cover_file}`;
  covers are `_highlight_NN.jpg` — underscore, **no hyphen**, skipped by the parser like the avatar.
  Absent/empty → placement deletes the highlights row (the pre-2026-07-18 default).
- `type`/`items` come from here, not the filenames: in `covers` mode a carousel leaves one file
  behind, so the folder alone can't tell you it was a carousel of 8.

## The header (v0.4.3 — fully captured, verified live 2026-07-17)

`capture.json`'s `profile` now carries the real thing, at **zero extra requests** — the tap reads
the payload the page fetches for itself over `/api/graphql`. Verified on `@solarity.studio`:
`biography` (multi-line, emoji), `followers: 27692`, `following: 360`, `posts_count: 27` — the
numbers cross-checked exactly against an independent `web_profile_info` call.

- **Format the counts** as Instagram does (`crawler.js` `formatCount`): `27692` → **27.7K**. A raw
  int will not fit the 21px slot.
- **`external_url: ""` is a real answer** (the profile has no link), distinct from `null` (we never
  saw the payload). Writing `""` is correct and the line simply disappears — safe here only because
  a real multi-line bio keeps the hug-width frame open (gotcha 7).
- A **multi-line bio** (`\n`, emoji) reflows the single-line slot cleanly — verified.

## Type badges (built 2026-07-17)

Instagram overlays a small white glyph on the grid — **▶ on reels, ⧉ on carousels, 📌 on a pinned
post**. The template's demo tiles show these baked into the placeholder JPEGs, so they vanish the
moment a real cover replaces the photo; the badge has to be re-added as a node.

- **Sources:** three 20×20 white `VECTOR`s at **page level** — `badge-reel`, `badge-carousel`,
  `badge-pinned` — hand-pasted from [`assets/icons/{reel,carousel,pinned}.svg`](../assets/icons/).
  The fork has **no SVG-insert tool** (only `clone_node`), so the vectors must physically live in
  the file; these three are the clone sources. **Keep them** — deleting them silently disables
  badges. (Slots 0–2 also still hold the original empty *marker* frames `pinned-post` /
  `clip-reels-content` / `carousel`; those are position labels, not artwork — the real glyphs are
  the page-level `badge-*` vectors.)
- **Which tile gets which:** `manifest.cjs` tags every slot with `badge` ∈ `reel` / `carousel` /
  `pinned` / `null` (`badgeFor`, unit-tested). A **pin outranks** the media-type glyph — a pinned
  post is usually also a carousel (live: `@solarity.studio`'s pinned post is an 8-slide carousel) —
  so a pinned reel/carousel shows the pin only. IG's real two-glyph case (pin **+** type) is
  deliberately simplified to one.
- **Placement:** `clone_node(<source>)` → `set_parent(clone, gridChild[i], x: tileW − 28, y: 8)`.
  At the 310px tile that is **`x: 282, y: 8`** (20px glyph, 8px top-right inset). `set_parent`'s x/y
  are parent-relative, so one call both reparents and positions. A `null` badge places nothing.
- **No shadow** — the glyphs are pure white to match IG exactly (user's call). On a light cover a
  white glyph can wash out; that's accepted.
- **Proven end-to-end on a placed board 2026-07-18:** retro-fitted all 24 tiles of the
  `@solarity.studio` Section — cloned each source onto tile `grid.child[i]` at `x:282 y:8`, exported
  the grid, checked tile-by-tile against the manifest (1 pinned + 13 reel + 10 carousel = 24, slot 0
  pinned reel → pin). Earlier: a reel-only smoke test on a template slot.

## Story highlights (built 2026-07-18)

Probed live (`@solarity.studio`, via [`probes/highlights-probe.js`](../probes/highlights-probe.js)),
then built. The tray arrives over `/api/graphql` → `PolarisProfileStoryHighlightsTrayContentQuery`,
which `TAP_URL_RE` already taps — a clean **collector gap**, no matcher change and no extra request
(#25 was the fear, not the reality). Each tray item: `{ id: "highlight:<pk>", title,
cover_media.cropped_image_version.url (150×150 CDN jpg), user: {username, id},
__typename: "XDTReelDict" }`. **The owner is ON the item (`user.username`)**, so highlights key by
username exactly like the profile cache (#22) — safe, no request/response correlation.

- **Capture** (`inject.js` + `crawler.js`): a `collectHighlights` pass — **order-preserving**, unlike
  `collectMedia` which reverses arrays (gotcha #17) — feeds `highlightPut`, a THIRD tap cache keyed
  by `user.username`, wired into BOTH ingest sites (#24). The crawler reads the handle's tray off the
  tap (zero extra requests), downloads the ≤8 covers as **`_highlight_NN.jpg`** — underscore
  separator, **no hyphen** — so `manifest.cjs` skips them (a hyphen → mis-parsed as post
  `_highlight`/`NN`, gotcha #20) — and writes `profile.highlights: [{title, cover_file}]` to
  `capture.json`. The CLI resolves each cover by **parsing the folder** for `_highlight_NN.*`, never
  the recorded extension (gotcha #21).
- **Placement** (skill step 11): FILL the `highlights-bar` — `set_image_fill` each **76×76** ring +
  set its label — from `manifest.highlights` (`[{title, path}]`, tray order). Fewer than 8 → fill N,
  **delete the surplus rings**; none → delete the whole bar (the pre-build default).
- **✅ B4 Chrome pass CLEARED 2026-07-18** on the `@solarity.studio` 2026-07-18 capture:
  `capture.json.profile.highlights` came back populated and owner-correct (3 real rings: "My TREND
  🤌", "Happy Clients", "Why CUSTOM?"), and placement filled all 3 covers+labels and deleted the 5
  surplus template rings. Story highlights are now fully verified end-to-end, both halves. **119
  Node tests green.**

## Decided against — do not build

- **Spill past 24 posts (closed 2026-07-17).** ~~A second cloned frame inside the same Section would
  hold posts 25–48.~~ **A capture is 24 posts, full stop.** It was never reachable anyway — the
  crawler caps at 24 (`crawler.js` → `DEFAULT_LIMIT`, pinned to this template's grid capacity), so
  only a hand-captured folder of >24 single clicks (the workflow the crawler replaced) could
  overflow at all. Building it would mean raising that cap → a longer crawl → **more rate-limit
  exposure, which is this tool's main ToS mitigation** — a bad trade for a bigger board. Don't
  re-open it as "easy polish": the placement half *is* easy, and that's the trap; the cost is in the
  crawl. **`manifest.overflow` stays** — it honestly reports "you handed me N, I placed 24" on a
  hand-captured folder. It just never grows a frame.
