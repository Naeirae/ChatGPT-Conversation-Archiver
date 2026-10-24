# Scroll architecture cleanup

Status: in progress. Branch: `scroll-architecture-cleanup-2026-10-24`. Draft PR: #33.

## Current stop point

The current production source is 0.4.45. Full capture was patched so a verified load error / `Retry` window cannot be mistaken for the real conversation start. The cleanup now starts by extracting shared scroll primitives without changing the proven 0.4.17 full-capture cadence.

## Requirements

| ID | Requirement | Source | Status |
| --- | --- | --- | --- |
| R001 | Scrolling must reach the real beginning/end of a virtualized ChatGPT conversation without treating a frozen viewport as an edge. | Current live regression | In progress |
| R002 | A visible `Попробовать снова / Try again / Retry` tied to a real load error must not count toward idle/stable edge confirmation. | Current live regression | In progress |
| R003 | Full capture, continuation, draft recovery and reconciliation must share one scroll transport / settle / retry / edge implementation. | Architecture cleanup request | In progress |
| R004 | Full capture may keep fast upward navigation because that phase does not commit canonical messages. Chronological downward capture must use granular movement and prove overlap between neighbouring virtualized windows before accepting progress. | Live regression + history review | Active constraint |
| R005 | Image hydration/export must not run inside the scroll transport layer. | Architecture cleanup request | Active constraint |
| R006 | Scroll behavior must be distinguishable from capture policy: transport moves; traversal policy decides what boundary is being sought. | Architecture cleanup request | In progress |
| R007 | Source fixes, packaged extension and live Chrome behavior remain separate verification layers. | Project discipline | Active constraint |

## Target layers

1. **Scroll runtime (page-side)** — scroll container discovery, physical edge metrics, verified load-error detection, settle detection and worker scroll request.
2. **Scroll transport (worker)** — CDP wheel dispatch only. It must not know whether the caller is doing full capture, continuation or reconciliation.
3. **Traversal policy (content adapter)** — full/top, chronological/down, anchor search and draft recovery. Policies may choose cadence and boundary rules, but must use the same runtime primitives.
4. **Capture** — reads visible turns and stores messages. It must not reimplement scrolling.
5. **Images/export** — consume captured messages; never define traversal completion.

## Tasks

| ID | Task | Requirements | Status | Verification |
| --- | --- | --- | --- | --- |
| T001 | Inventory current scroll paths and duplicated rules. | R001-R007 | Verified | Full/continue/reconcile/draft paths and worker CDP transport inspected. |
| T002 | Extract shared page-side scroll primitives from `content-chatgpt.js`. | R001-R003,R005-R006 | Done, not live-verified | `content-chatgpt-scroll.js` now owns container/edge/retry/settle/physical-scroll request. |
| T003 | Route existing full/rich/resume code through the extracted primitives without changing policy. | R001-R004,R006 | Done, not live-verified | `content-chatgpt.js` now uses thin wrappers; full cadence remains 7-burst up / one request down. |
| T004 | Make retry/stall state explicit and common across traversal policies. | R001-R003,R006 | Done, not live-verified | Full up/down, rich up/down, top-only continuation and resume-anchor search use shared observations/stability state. |
| T005 | Separate traversal policies from capture/image work. | R003-R006 | Not started | No image hydration calls in scroll runtime; policy-specific tests. |
| T006 | Consolidate worker CDP transport behind one helper with bounded command behavior and transport diagnostics. | R003,R006-R007 | Not started | Static check + long-chat live test. |
| T007 | Run scroll-only live regression matrix before touching image architecture. | R001-R007 | Not started | short/long/full/continue/retry/error/manual pause. |

## Progress

Verified checklist points: 1/7 (14%). Source implementation is complete for T002/T003/T004 but not counted as live-verified. Static syntax passes, all 46 dependency-free tests pass, and scroll-specific guards pass. No browser live behavior on this branch is claimed yet.

## Next operation

Run T007 before further architecture changes: live-test long full capture, forced Retry/load stall, continuation from a saved tail, resume-draft, and pause/resume. Keep images/export frozen until this scroll matrix is stable.


## CI note — 2026-10-24

Draft PR #33 triggers CI. The new scroll file parses and all 46 dependency-free tests pass, but the extension job is still red because the current `main` baseline is already red on two stale/unrelated static guards:

- verifier still requires `reachLiveBottomForSnapshot`, which is absent from current `main`;
- verifier still requires an older Google Docs debugger/clipboard timeout contract, also absent from current `main`.

The same `main` head (`d25b2f95...`, 0.4.45) fails CI independently. Do not mix those baseline repairs into the scroll refactor unless explicitly taken as a separate task.


## T004 result

The shared observation now records visible-window signature, first/last visible message keys, visible count, captured count, verified load-error/retry state, and physical edge metrics. One shared stability state tracks repeated windows.

Applied without changing established motion cadence to:

- legacy full-capture upward navigation;
- legacy full-capture chronological downward pass, now reduced from implicit 7-wheel requests to one wheel event per step with mandatory overlap verification;
- rich upward traversal;
- rich downward traversal;
- top-only navigation used before retrying a chronological pass;
- saved continuation-anchor search, including its downward fallback.

A single `physicalScrollStartVisible()` result no longer aborts continuation-anchor search. The search requires repeated unchanged observations without a verified load error; when downward fallback is allowed, a confirmed top transitions into that fallback instead of throwing immediately.

CI run 709 on commit `1581c565...` reports no scroll/static/test failures. All 46 tests pass. The only extension-job error is the pre-existing Google Docs timeout guard also present on current `main`; it remains outside this scroll task.


## Speed / gap regression finding

History review confirms that the project explicitly introduced faster top navigation in 0.3.87, while warning that chronological downward capture must remain granular and verify overlap. The restored legacy full path later used `physicalScroll('down')` without an explicit burst count. In the current transport, that means seven wheel events of `deltaY=860` per request, not one wheel event.

That full-down path also lacked the overlap proof already present in the richer traversal. This creates a direct silent-gap failure mode: the virtualized window can jump past messages, the collector sees a valid later window, and the archive continues without ever observing the skipped turns.

The branch now changes only chronological full capture:

- upward navigation remains fast;
- downward full capture uses `physicalScroll('down', 1)`;
- current viewport is captured before movement and again after movement;
- neighbouring windows must overlap by stable ID or adjacent text signatures;
- loss of overlap triggers upward continuity recovery;
- failure to re-establish overlap aborts instead of saving a holey archive.

This is now a stronger invariant than preserving the old 0.4.17 downward request shape.
