# Instagram → Figma Moodboard — Roadmap (post-v2 / v3+)

> Deliberately **outside the shipped build** tracked in [`TASKS.md`](TASKS.md). The original
> single-post MVP and full-profile → Figma v2 already deliver the intended benefit. Items below
> stay deferred until evidence or an explicit user choice activates one; being inexpensive is not
> itself a reason to build it.

## Fixed frame

- **Outcome:** preserve or improve the time saved when turning Instagram inspiration into a
  truthful, dated Figma moodboard.
- **Deadline:** no v3 release is currently committed. Once an item is activated, its default
  deadline is the end of one focused build session.
- **Capacity:** one maintainer, local tooling, and no new paid service or persistent runtime by
  default.
- **Scope:** the only flexible variable. Cut an activated release to a complete end-to-end benefit;
  return leftovers here.
- **Release gate:** Node tests are necessary but not sufficient. Browser work needs a logged-in
  Chrome pass; placement work needs a current-template Figma pass.

## Ordered deferred releases

| # | Benefit-delivering release | Extends | Activation trigger / assumption retired |
|---|---|---|---|
| R1 | **Restore a broken capture surface after Instagram drift** — reproduce one real failure, add the smallest regression coverage available, repair it without expanding permissions, and re-verify the exact surface in Chrome. | `content.js`, `inject.js`, `resolver.js`, or `crawler.js` | **Trigger only:** a reproducible failure on feed, modal, permalink, Reels rail, or profile crawl. Retires the assumption that the observed break can be fixed inside the current client-only architecture. Do not pre-build speculative selector or endpoint fallbacks. |
| R2 | **Mobile-profile moodboard variant** — place the same capture into a mobile Instagram-profile template while preserving feed order, truthful header data, badges, and highlights. | Placement manifest + a new live template contract | Activate when the desktop board is demonstrably the wrong reference for a real design task. Retires the assumption that one capture contract can safely drive both layouts without duplicating crawler logic. |
| R3 | **Searchable inspiration archive** — attach compact style/category tags to a placed capture so an accumulated board can be found by visual intent rather than memory. | `capture.json` and/or agent placement output | Activate only after enough dated captures exist that retrieval is a real problem. Retires the assumption that tagging saves more time than it costs and that derived AI labels can remain clearly separate from source facts. |
| R4 | **Capture notes and rationale** — add user-authored or agent-assisted notes beside a dated Section, recording what is worth reusing without altering the source profile representation. | Figma placement output | Activate when boards are being revisited but the reason for saving them is getting lost. Retires the assumption that notes belong at capture level rather than post level. |
| R5 | **Per-workspace Figma routing** — route an explicitly named capture to the correct workspace page/file while keeping the capture extension workspace-neutral. | Placement skill/agent configuration | Activate when repeated manual routing across PsiAtiva, juansilva.design, Locuz, or Newcar becomes measurable friction. Retires the assumption that routing can stay agent-side without coupling this shared repo to business runtimes. |
| R6 | **Cross-capture duplicate report** — identify identical downloaded bytes across dated captures and report them before placement; never silently delete source media. | New local manifest/index | Activate when archive size or repeated tiles becomes a visible cost. Retires the assumption that content hashes are sufficient and that repeated media should be reported rather than intentionally preserved as historical evidence. |
| R7 | **Resumable profile capture** — resume a genuinely interrupted 24-post run without re-downloading completed files, while retaining dated-folder honesty and owner isolation. | Profile crawler + capture sidecar | Activate only after a real stall makes the existing cheap, idempotent same-day rerun painful. Retires the assumption that resume state is safer/simpler than rerunning a bounded 2–4 minute crawl. |
| R8 | **Optional local orchestration** — detect a completed capture and offer placement without making Figma availability a precondition for capture. | New local watcher or n8n alternative | Activate only if capture volume makes the current manual “place this capture” handoff the dominant cost. Retires the assumption that a persistent runtime is worth its operational and privacy surface. |
| R9 | **Story and highlight download from the viewer** — while a story or highlight is on screen, a download button inside the story viewer (the same pattern as the reel/carousel button) saves it, from public accounts and from private ones this login follows. The full profile capture is unchanged: highlight covers only, never stories. | `content.js` (a story-viewer anchor, and the carousel slide on screen), `inject.js` (a media lookup keyed on the story item id, since a story has no shortcode), `resolver.js` (story URLs + filenames) | **Requested and activated 2026-09-27** (the user's go, the same day; the build-box starts with a probe). **Built the same day; v0.5.1 Chrome-verified 2026-09-27** (the button in the Like/Share row, stories plain + Shift, a carousel plain + Shift). Still to confirm: a highlight item and a story video's audio. Known limitation: a click before the story loads can't identify the item. Stories were allowed the same day (`CLAUDE.md` hard constraints). Retires the assumption that stories sit outside the authorization boundary: one click on a story the user is already watching is the same consent as the post button. **Decided at activation:** a plain click saves the item on screen and Shift-click the whole story or highlight. **Carousels switch to the same rule:** a plain click saves the slide on screen, and Shift-click every slide. Close Friends stories are allowed. Files are `<user>-story-<YYYY-MM-DD>-<pk>.<ext>` or `<user>-highlight-<YYYY-MM-DD>-<pk>.<ext>`, dated by posting day. Still open: whether story videos carry audio, which the probe and the Chrome pass answer. Detail in the [idea note](../../ideas/instagram-stories-highlights-download.md). |

## Next increment when activated — R1 drift recovery

R1 is first because continuity of the shipped benefit outranks new scope, but it remains dormant
until a real regression exists.

1. Record the failing surface, target shortcode/handle, expected count/type, actual output, and
   `[IGFM]` trace.
2. Classify the failure before editing: button placement, shortcode selection, response ingestion,
   normalization/completion, crawler enumeration, download, or placement.
3. Probe the live data path. Prove the relevant payload reaches the matcher before changing the
   matcher; do not infer Instagram's shape from the DOM alone.
4. Add a failing pure-logic fixture when the defect crosses a testable boundary, then make the
   smallest fix that preserves `["downloads"]`.
5. Run all Node tests and syntax checks, reload the extension **and** Instagram tab, and repeat the
   exact live case. If placement changed, re-read the current template and export-check the result.
6. Record the new failure mode in the correct memory file, close the task in `TASKS.md`, and
   re-order this roadmap only if the incident changed the evidence.

## Contingency items — build only when the trigger occurs

| Trigger | Smallest justified response | Why not now |
|---|---|---|
| A downloaded video is DASH-only or has no audio | Re-evaluate a local native-host/remux path for that proven media shape. | Every verified Instagram video so far is a progressive MP4 with muxed audio; a native host would add permissions and runtime weight without a current benefit. |
| Chrome saves a **real** HEIC file that Figma cannot place | Add a local conversion step for the placement manifest and preserve the original. | The observed `.heic` URLs produced JPEG bytes; URL metadata lied, but no real HEIC has landed. |
| The rotating GraphQL `doc_id` fallback becomes load-bearing and fails | Refresh the query id or replace that last fallback using a newly observed stable page endpoint. | Media-info REST currently closes the hard cold-carousel case without a rotating query id. |
| A hand-captured folder exceeds 24 files | Keep reporting `overflow`; ask the user which 24 belong in the board. | Raising the profile crawl cap was explicitly rejected because longer crawls increase rate-limit exposure. |

## Out of scope / decided against

- **DMs.** A private surface, outside the authorization boundary. Stories left this list on
  2026-09-27: they are allowed through the story-viewer button only (R9).
- **Unattended bulk or competitor harvesting.** Capture remains user-triggered and bounded to the
  media/profile the logged-in user is intentionally viewing.
- **More than 24 profile posts per capture.** The template has 24 slots and the shorter crawl is
  the project's primary rate-limit posture. `manifest.overflow` remains an honest report, not a
  prompt to grow the crawl.
- **Figma socket detection as a capture gate.** Capture and placement are deliberately decoupled;
  Figma being closed must never block writing a valid capture folder.
- **Playable video inside Figma.** A representative poster plus a reel badge is the intentional
  board representation; the original MP4 remains on disk.
- **Recreating the Instagram UI from scratch.** This project fills the user's live template.
- **A server, analytics, accounts, or cloud media archive by default.** The shipped tool is local
  and client-side.
- **Coupling to a business workspace runtime.** Workspace routing, if justified, belongs in the
  agent-side boundary rather than the extension.

## Retrospective and re-plan cadence

After every activated release or live incident:

1. compare the delivered user benefit with the failure/request that activated it;
2. record browser and/or Figma evidence separately from automated evidence;
3. move newly discovered invariants to `CLAUDE.md` or `placement/PLACEMENT.md`;
4. re-rank the deferred releases using the new evidence; and
5. leave later releases coarse until one is explicitly selected.

The roadmap is a queue of hypotheses, not a promise to ship all of them.
