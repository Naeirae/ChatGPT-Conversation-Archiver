# Scroll traversal forensic recovery

Status: forensic candidate, not production. Branch: `forensics/debugger-traversal-candidate`.

## Current stop point

The investigation no longer treats debugger/CDP wheel as the regression. Historical evidence shows that debugger wheel was already the working transport while traversal regressions accumulated around top detection, recovery, reconciliation and later restore cycles.

Current candidate commit restores the **0.3.87 full-capture traversal policy** on top of modern DOM/identity protections:

- full ascent is navigation-only and uses debugger wheel;
- ascent uses 16 bursts, `5000/550ms` settle parameters and five unchanged-window confirmations;
- the 0.3.98 `physicalScrollStartVisible()` shortcut is explicitly excluded from full top confirmation;
- full chronological descent captures before and after each debugger movement;
- descent uses the 0.3.87 three-burst cadence plus neighbouring-window overlap verification;
- modern strong-ID/context-aware identity logic remains in place.

Nothing on this forensic branch is claimed live-verified yet. Do not merge to `main` until a long-chat browser run proves upward motion, automatic top completion, downward motion and no message gaps.

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

## Forensic findings

| Finding | Evidence | Status |
| --- | --- | --- |
| Debugger/CDP wheel is not itself the early regression. | It is already present from commit `175867fa` and remains the transport through later working/restore states. | Confirmed |
| First explicit top-detection slowdown appears in `7ba0ae0` (`Harden top detection against delayed ChatGPT loading`). | Settle grows to 8s/1.4s quiet, upward bursts increase, an extra 2.6s wait is added, and five idle confirmations are required. | Confirmed |
| Full capture becomes fast again in 0.3.87 by bypassing rich upward capture. | Commit `6a09d0a3` introduces navigation-only full ascent, 16-burst debugger movement and overlap-verified chronological descent. | Confirmed |
| 0.3.98 introduces a known traversal regression. | Code commit `0010e832` adds `physicalScrollStartVisible()` as a top shortcut; later commit `3203f82d` explicitly says “Restore conservative full-chat traversal after 0.3.98 regression”. | Confirmed |
| 0.3.87 is not safe as a whole-file rollback. | Its navigation/reconciliation layer still allows standalone text equality in `sameNavigationRef()`; modern identity hardening must be retained. | Confirmed |
| Earlier `5f4f7d8` virtualized-unit change is not currently identified as the source of gaps. | Its diff primarily prevents a `data-turn-key` wrapper containing user+assistant from being treated as one message. | Not established as regression |

## Active requirements

| ID | Requirement | Status |
| --- | --- | --- |
| R001 | Preserve debugger/CDP wheel as the primary full-capture movement transport. | Active |
| R002 | Full ascent must be navigation-only; no canonical message accumulation while moving upward. | Implemented, not live-verified |
| R003 | Do not use `physicalScrollStartVisible()` as proof of global conversation top. | Implemented, not live-verified |
| R004 | Capture the visible viewport before and after every chronological downward movement. | Implemented, not live-verified |
| R005 | Do not accept a downward jump unless neighbouring virtualized windows overlap. | Implemented, not live-verified |
| R006 | Standalone repeated text or weak wrapper identity must not merge/deduplicate distinct messages. | Implemented, statically guarded |
| R007 | Do not publish more `main` releases from this investigation until a browser run validates the candidate. | Active constraint |

## Candidate verification checklist

- [ ] Debugger scroll starts in current-tab mode.
- [ ] Debugger scroll starts in background-copy mode.
- [ ] Long chat moves upward at practical speed.
- [ ] Real top is recognized automatically without the 0.3.98 physical-top heuristic.
- [ ] Downward chronological traversal physically moves from the top.
- [ ] Repeated short messages survive identity/deduplication.
- [ ] No viewport gap is silently accepted.
- [ ] Retry/load-error UI does not cause an endless traversal loop.
- [ ] Snapshot lower boundary is reached without adding messages created after run start.

Confirmed progress: 0/9 live-behavior checks. Static/history analysis does not count as browser verification.

Static candidate verification: GitHub Actions run 792 passed both jobs. The extension source verifier, package step, artifact upload and updater smoke tests all succeeded. Artifact: `chatgpt-conversation-archiver`, run `40252397356`, head `06d9999b8e2f09d4b7c50127beb4153dfb79b09d`. The known unrelated Google Docs timeout guard is downgraded to a warning only on this forensic branch so it cannot block packaging; Google Docs runtime code was not changed for that purpose.

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


## Identity / deduplication hardening

A second silent-loss class was confirmed independently of scrolling: weak virtualized IDs and standalone text signatures were being used as if they proved message identity.

Changes on this branch:

- `data-message-id` / `data-turn-id` are the only single-message strong identities;
- virtual wrapper/text IDs remain useful capture keys, but collisions are checked against neighbouring message context;
- if the same weak ID reappears with incompatible neighbours, both occurrences are preserved;
- `sameNavigationRef()` now accepts strong IDs only;
- weak text matches are allowed only inside an ordered 2–4 message sequence and only when that contextual match is unique;
- navigation reconciliation, archive reconciliation and image recovery use contextual matching instead of standalone text equality;
- continuation cross-boundary deduplication now filters only by strong IDs;
- image scan pooling no longer groups different repeated messages by text/weak ID alone;
- rebuilding the capture map preserves weak-ID collisions rather than silently dropping the second entry;
- automatic snapshot boundaries carry up to three preceding message signatures, so repeated boundary text cannot stop the pass early by itself;
- scroll settle signatures now include every visible turn rather than only the first/last three.

Remaining live validation must include deliberately repeated short messages (`Да`, `Окей`, identical assistant replies) across several virtualized windows.


## Additional runtime regression found

During identity review, `reachResumeAnchor()` was found calling `hasStableResumeAnchor()` even though that helper was absent from the current content script. This is a runtime-only failure: JavaScript syntax checks do not detect an undefined function until the continuation path executes.

The helper is restored with stricter semantics: only `data-message-id` / `data-turn-id` qualify as a stable one-message resume anchor. Legacy weak IDs fall through to multi-turn tail/context matching.


## Long-top / persistent-gap regression findings

Further review against the 0.3.87 fast-navigation implementation found several regressions that can explain both multi-hour top navigation and persistent silent message loss:

- full capture had reverted to `reachTopFullLegacy()`, which parses and collects the viewport twice on every upward step; full capture now uses navigation-only ascent again;
- top confirmation used wrapper-qualified keys, so recyclable virtual wrapper IDs could keep the viewport looking "changed" forever even when the oldest text was stable; top confirmation now uses the text signatures of the oldest visible turns;
- physical wheel events were always sent to a fixed viewport point (68% / 48%) even though the content script already knew the real scroll container; the runtime now sends a point inside the detected scroller to the worker;
- top navigation is bounded and aborts a non-moving transport instead of allowing a two-hour idle loop;
- `orderedTurns()` previously treated ambiguous outer shells as one message and only considered `data-turn-key` wrappers when no normal turn was found at all; mixed rollout DOM can therefore hide visible messages. Logical turns now prefer role-bearing nodes, ambiguous shells are split, and unambiguous wrappers can coexist with ordinary shells;
- chronological overlap proof is now directional: the suffix of the previous viewport must match the prefix of the next viewport. Arbitrary repeated pairs elsewhere in both windows no longer prove continuity.


## Transport-distance regression

A further root cause linked the two observed symptoms — skipped turns and multi-hour runs — to one transport mistake.

The code treated "one burst" as a granular chronological step, but every wheel event still used a fixed `deltaY=860`. Therefore:

- one supposedly granular downward step could still jump nearly a viewport;
- load-error recovery during the downward pass used two such events, pushing another ~1720 px past the problematic region;
- continuity recovery then spent many reverse steps trying to re-find overlap;
- repeated overshoot/recovery cycles could both miss turns and make a run take hours.

The branch now separates wheel distance by traversal purpose:

- fast top navigation keeps the large default wheel distance;
- chronological capture uses one 320 px wheel event;
- load-error retry during chronological capture uses one 220 px step;
- overlap recovery moves upward by 180 px;
- continuity recovery is bounded to six attempts;
- rich chronological traversal defaults to one small burst instead of three large bursts.

This makes "fast navigation" and "safe capture" physically different transports rather than only different burst counts.


## Exact pre-CDP restoration

The previous "direct scroll" reconstruction was not behaviorally equivalent to the early working implementation. The actual pre-`175867fa` mechanics were recovered from commit history and restored for full capture:

- scroller selection is ancestor-only, with `overflow-y` and `scrollHeight > clientHeight + 20`;
- top loading uses `scrollTo(0)`, then a small `140px` nudge down, then `scrollTo(0)` again while watching `scrollHeight + turn count`;
- chronological traversal uses absolute `scrollTo(next)` positions within the same scroller;
- full capture no longer relies on generic `physicalScroll()` for either ascent or chronological descent;
- CDP wheel remains available only as fallback/other-mode infrastructure.

This distinction matters because `scrollBy(-delta)` at a virtualized local top can be a no-op and may fail to trigger older-message loading, even though the old `scrollTo(0) + nudge` sequence did.


## 0.4.56 primary workflow decision

The primary user-facing capture path no longer attempts automatic full-chat navigation.

Authoritative workflow:
1. mark the end message;
2. manually move to the desired start;
3. mark the start and leave it visible;
4. start manual-range capture;
5. capture moves only downward until the marked end.

Manual-range invariants:
- both markers are required;
- capture runs in the current positioned tab;
- no `reachTopWithoutCapture()`, `reachTop()` or lower-boundary pre-navigation is allowed before the chronological pass;
- no navigation reconciliation is used for the manual range;
- no automatic Retry/load-error click recovery is used inside the range walk;
- the marked end is mandatory and must be reached;
- the final archive is sliced exactly from marked start through marked end.

Legacy full-navigation, continuation and reconciliation code may remain for technical/archive recovery operations, but it is no longer the primary capture UX.


## 2026-10-27 — manual-range recovery isolation audit

The default branch already contains 0.4.56's manual end → manual start → current-tab downward traversal. A separate follow-up branch `fix/manual-range-recovery-isolation-2026-10-27` isolates it from legacy transport and auto-recovery choices.

Verified source-level problems and fixes:
- `startCapture()` still accepted a `copy` target from non-popup callers for `fragment`. The worker now forces `current`, preserving the user's physically positioned start viewport.
- `finishJobWithError()` could schedule automatic recovery for `fragment`, despite its single-pass/no-auto-retry contract. Manual ranges no longer become auto-recovery eligible.
- `resumeNavigationOnlyFromWorkingTab()` could restart a `fragment` as a legacy top-navigation recovery. Its allowed modes now exclude `fragment`.
- `attemptAutomaticRecovery()` now skips stale persisted alarms for failed manual-range jobs, including alarms created by an earlier release.
- `scripts/verify.mjs` adds guards for these contracts.

Preserved intentionally: unfinished draft persistence, explicit manual recovery controls, legacy full/reconcile/image maintenance paths, and physical overlap checking during downward capture.

Verification: source content and six targeted pattern assertions confirmed via the GitHub connector. A local clone for `node --check` / `node scripts/verify.mjs` failed because this runtime could not resolve github.com; **no automated test pass or installed Chrome/live validation is claimed**.

Remaining P0: perform full browser regression for current-tab end/start marking, valid downward range, stable repeated messages, forced stall/error with retained draft but no auto-restart, manual resume, and exported archive boundaries. Separately inspect manual draft resume semantics; do not silently re-enable automatic top navigation.


## 2026-10-27 — restoration of manual-range resume and archive planner

Further source audit discovered that restoring a fragment draft through `resume-draft` dropped its `isFragment` archive identity, could replace `lastArchiveId`, and could invoke legacy upward-navigation recovery. Changes on the same feature branch:
- `resumeFailedCaptureFromWorkingTab` and `resumeSavedUnfinishedPass` route fragment drafts through frontier-based `resume-draft`, never the original `fragment` top-navigation branch.
- `startCapture` forces current-tab capture for fragment draft restoration.
- Content capture preserves `isFragment`, original range markers, `fragmentLatestId` and separate canonical archive pointer through successful resume.
- Worker completion indexes and clears markers based on completed archive identity rather than the temporary `resume-draft` mode.

The user also reported lost saved-archive preview and tab placement. Root cause in the inspected code: `selectSavedArchive` overwrote `lastArchiveId`, while `GET_STATE` preferred the current conversation's archive from URL, ignoring the selected library row. The planner itself (`planner.html` / `planner.js`) still existed and accepted an explicit `archiveId`.
- Selection now uses independent `selectedArchiveId`.
- `GET_STATE` resolves explicit selection for the popup; completion selects the freshly created archive.
- Saved-archive rows now have a direct **Просмотр и вкладки** action that opens `planner.html?archiveId=...`, independent of the current chat.
- The main archive panel has an explicit **Просмотр архива и вкладки** action.
- `scripts/verify.mjs` contains new static guards for these paths.

Evidence: exact GitHub source sections and targeted source assertions, plus JavaScript parse success for `popup.js` and `content-chatgpt.js`. Full `node scripts/verify.mjs` and Chrome behavior remain **unverified**: container git clone failed DNS resolution for github.com. Do not mark runtime regressions green.

Next tests: library selection from an open different chat; view/mark/save tab plan for a full archive and fragment; resume a failed fragment draft; verify `lastArchiveId` remains intact and fragment export does not adopt canonical chat identity; test missing/weak markers and repeated messages.
