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
| Post slot ×24 | `cover` | **310×310** | leaf frame, `IMAGE`/`FILL` fill, no children |
| Avatar | `pfp` | **150×150** | in `hero > story > old-ring`; cornerRadius 75 |
| Highlight ×8 | `image` | 76×76 | in `highlights-bar`; **not placed yet** |
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
    "posts_count": 27, "followers": 4000000, "following": 454   // raw ints — format for display
  },
  "posts": [                   // FEED ORDER, pinned first
    { "shortcode": "DEU1LbwxhF0", "type": "carousel", "items": 8,
      "pinned": true, "cover": "solarity.studio-DEU1LbwxhF0.jpg" }
  ],
  "skipped": []
}
```

- `_avatar.jpg` is the avatar (named so `manifest.cjs` can't parse it as a post — gotcha #20).
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

## Not built yet

- **The ▶ badge on video tiles** (blocker B3's other half) — the poster lands, the badge doesn't.
  Belongs in the template as a component, not as agent-created nodes (those would reflow the
  auto-layout grid). **Build it subtractively:** there is **no visibility setter in the fork** —
  `visible` appears only as a read-side guard in the plugin's scan code, so "hide the badge in the
  template, reveal it per video tile" would need a new tool. Instead carry the badge on **all 24**
  template tiles and `delete_node` it from the non-video ones — the same subtractive move placement
  already makes for the highlights row, the `Followed by` row, and the uncaptured rows. The manifest
  already knows which: `slots[].type` is `video` / `carousel` / `image`, taken from `capture.json`
  and **not** from the filename (in covers mode a video is saved as a poster `.jpg`, so the
  extension says `image` — see the sidecar override in `manifest.cjs`). IG's real grid badges
  carousels too (⧉), and that same `type` already distinguishes them, so both badges come free if
  the template carries both.
- **Highlights** — deliberately **deleted** at placement rather than filled. Wiring them for real
  means the highlights tray, a different API surface the tap may never see — it would need its own
  probe first, like the profile crawl did. Gotchas #22/#26 set the bar: a page SSR-embeds the
  **viewer**, so a sloppy read of a new surface puts *your own* highlights on someone else's board.
- **Overflow past 24 posts** — reported in `manifest.overflow`, not placed. A second cloned frame
  inside the same Section would hold posts 25–48. **Unreachable from the shipped pipeline:** the
  crawler caps at 24 (`crawler.js` → `DEFAULT_LIMIT`, itself pinned to this template's grid
  capacity), so only a hand-captured folder of >24 single clicks — the workflow the crawler
  replaced — can overflow at all. Building the spill is therefore **not polish on top of what
  exists**; it starts by reversing the 2026-07-17 decision that a capture is 24 posts, which was
  taken for grid capacity **and** the shortest crawl — i.e. the least rate-limit exposure, which is
  this tool's main ToS mitigation. Decide you want bigger captures first; the placement half is the
  easy part.
