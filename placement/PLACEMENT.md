# Placement engine — agent recipe (v2)

How a capture folder becomes a dated moodboard Section in the Figma IG-UI template.

`manifest.cjs` decides **what goes where** (pure, tested). This file is the **how** — the
talk-to-figma MCP sequence the agent runs, because talk-to-figma is agent-driven and can't be
called from a script. Verified live end-to-end 2026-07-17.

## Runtime preconditions

1. The **bun socket server** on port 3055 (`ss -ltn | grep 3055`). It has no channel-listing
   endpoint and no log — **ask the user for the channel name**, you cannot discover it.
2. The **fork's dev plugin** open in Figma — "Talk to Figma (fork)". The fork and the community
   plugin share a manifest id and look identical in the plugin list; only the fork has
   `set_image_fill`. If it's the wrong one, the grid step fails and nothing before it does.
3. `join_channel(<name>)`.

## The capture folder

Read the extension's output **in place** at `/mnt/c/Users/<user>/Downloads/instagram-captures/`.
WSL mounts the Windows filesystem, and the MCP server (which reads `imagePath` itself) runs in
that same filesystem — so there is **no copy step and no native host**. The plan's old
"Windows→WSL copy mechanism" question is void.

`captures/` is now scratch for **derived** artifacts only (ffmpeg posters), not a copy target.
It stays gitignored.

## Steps

```
node placement/manifest.cjs <capture-folder> --date YYYY-MM-DD   # → JSON on stdout
```

Then, per the manifest:

1. **Dedup** — `get_document_info`; if a Section named `manifest.sectionName`
   (`@<handle> · <date>`) exists, **BLOCK** — no duplicate same-day capture of a profile.
2. **`create_section`** at a free spot, `name = manifest.sectionName`. Size the clone + ~40px
   margin (template is 1350×3214 at absolute 0,0 → e.g. 1430×3294).
3. **`clone_node(<template>)`** at section origin + 40. Never recreate the UI.
4. **`set_parent(clone, section)`** — preserves absolute position.
5. **`rename_node(clone, manifest.sectionName)`** — the clone inherits the template's name.
6. **`scan_nodes_by_types(clone, ["FRAME"])`** — cloning reassigns every descendant id, so
   locate slots *inside the clone*:
   - the frame named **`grid`** → its **children are the 24 slots, already in feed order**
     (row-major). No geometry sort needed.
   - the frame named **`pfp`** **sized 150×150** → the avatar. ⚠️ see gotcha 1.
7. **`set_image_fill(gridChild[i], manifest.slots[i].path, scaleMode: "FILL")`** — `slot` is the
   child index. FILL center-crops a non-square source into the square tile, like Instagram.
   Parallel calls are fine (verified 24 at once, no races).
8. **`set_image_fill(pfp, <avatar>, "FILL")`**.
9. **`set_multiple_text_contents(clone, [...])`** for the header — ids from
   `scan_nodes_by_types(<clone hero>, ["TEXT"])`. Write from `capture.json`'s `profile`, and see
   gotchas 7–8: **never leave a placeholder, never invent a value, never blank to `—`**. Counts are
   pre-formatted the way Instagram renders them (`4M`, `12.3K`, `1,861`) — a raw `4000000` will not
   fit the 21px slot. If `biography`/`external_url` are null (the page never fetched the payload),
   write capture provenance + `instagram.com/<handle>` instead of mkbhd's copy.
10. **`delete_node(<clone's highlights-bar>)`** — we capture no highlights, so the 8 rings would
    otherwise show the template's mkbhd placeholders on someone else's board. Deleting the row is
    honest and the auto-layout closes the gap (the grid moves up). Verified live 2026-07-17.
    ⚠️ Target the **clone's** row, not the template's — check the `absoluteBoundingBox` is inside
    the new Section's x-range before deleting.

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

## Not built yet

- **The ▶ badge on video tiles** (blocker B3's other half) — the poster lands, the badge doesn't.
  Belongs in the template as a component, not as agent-created nodes.
- **Highlights** — deliberately **deleted** rather than filled (step 10). Wiring them for real
  means the highlights tray, a different API surface the tap may never see — it would need its own
  probe first, like the profile crawl did.
- **The `Followed by` row** — still the template's `kurzgesagt`. Low-salience, but it is
  placeholder data; blank or delete it if it ever reads as fact.
- **Overflow past 24 posts** — reported in `manifest.overflow`, not placed. A second cloned frame
  inside the same Section would hold posts 25–48.
