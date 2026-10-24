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
| R004 | Full capture must keep the historically working 0.4.17 cadence until a live regression proves a replacement: 7-burst upward navigation, one physical downward request per chronological step. | 0.4.43 restoration | Active constraint |
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
| T004 | Make retry/stall state explicit and common across traversal policies. | R001-R003,R006 | Not started | Fixtures + long-chat live test with forced load stall. |
| T005 | Separate traversal policies from capture/image work. | R003-R006 | Not started | No image hydration calls in scroll runtime; policy-specific tests. |
| T006 | Consolidate worker CDP transport behind one helper with bounded command behavior and transport diagnostics. | R003,R006-R007 | Not started | Static check + long-chat live test. |
| T007 | Run scroll-only live regression matrix before touching image architecture. | R001-R007 | Not started | short/long/full/continue/retry/error/manual pause. |

## Progress

Verified checklist points: 1/7 (14%). Source implementation is complete for T002/T003 but not counted as verified until browser/runtime checks. No live behavior on this branch is claimed yet.

## Next operation

Start T004: introduce one explicit scroll observation/stall state shared by full/top, full/down, rich traversal and continuation search. Do not change the historical full-capture wheel cadence yet. Then run a scroll-only live regression matrix before touching image architecture.


## CI note — 2026-10-24

Draft PR #33 triggers CI. The new scroll file parses and all 46 dependency-free tests pass, but the extension job is still red because the current `main` baseline is already red on two stale/unrelated static guards:

- verifier still requires `reachLiveBottomForSnapshot`, which is absent from current `main`;
- verifier still requires an older Google Docs debugger/clipboard timeout contract, also absent from current `main`.

The same `main` head (`d25b2f95...`, 0.4.45) fails CI independently. Do not mix those baseline repairs into the scroll refactor unless explicitly taken as a separate task.
