# Forensic audit: legacy 0.3.x collector vs 0.4.x regressions (2026-10-31)

## Current state
- Production branch `main`: v0.4.93.
- Last known reproducible symptom: marked-range collection stopped after 15 turns in v0.4.92 with `Хронологический проход потерял перекрытие между соседними участками`.
- Verified source cause: `captureConversation` sent `mode === 'fragment'` to `walkDown`, while the v0.4.92 restoration of 0.3.x traversal applied only to `walkDownFullLegacy` (`mode === 'full'`). The fragment `walkDown` continued to call `watchdog.beforeRecovery`, `recoverDownwardContinuity`, then throw on missing overlap.
- v0.4.93 removes this fatal seam gate specifically from `walkDown`. It retains downward capture, checkpoints, image hydration, and mandatory marked end confirmation. **No successful real Chrome end-to-end verification yet**.

## Source-based historical comparison
- 0.3.36 (`3c6536642765`): `walkDown` performs `collect`, `physicalScroll('down', bursts)`, `collect`; stops on the fixed lower boundary or genuine stall. `reconcileNavigationCoverage` and `hydrateMessageImages` already exist. No `createContinuityWatchdog`.
- 0.3.65 (`eba4d3b0dc7b`): same general forward-walk principle, with partial archive work; no `createContinuityWatchdog`.
- 0.3.87 (`6a09d0a3f4ab`): granular forward traversal with overlap recovery and saved checkpoints; no `createContinuityWatchdog`. Overlap restoration reverses only to re-find previous window.
- 0.4.53 (`97bea6d16dde`): reintroduces a separate `walkDownFullLegacy` debugger traversal, while `walkDown` continues to serve fragments and resumes.
- v0.4.84–0.4.92: stricter watchdog and repeated-seam assertions were still active on `walkDown`, which explains why repeated fixes to `walkDownFullLegacy` did not cure the user's marked-range runs.
- v0.4.86+: full capture has an independent second pass and binary image hydration. Marked-range capture does **not** yet have an equivalent independently verified post-pass.
- v0.4.91+: incremental visible image binary hydration in `walkDownFullLegacy`; fragment `walkDown` has its own `hydrateImages` pipeline.

## Outstanding regressions / acceptance criteria
1. **Physical traversal** — Chrome test on long marked-range chat: forward movement must reach the immutable end marker without repeated same-seam failure. Distinguish wheel steps from unique turns.
2. **Missing messages** — independently check ordering and repeated weak identities, with contextual matching. Do not count total `Map.size` as proof of completeness; do not silently accept missing turns.
3. **Images** — verify binaries are saved while visible; a later final pass must retry failures and discover previously missing references.
4. **Resume** — failing/interrupted fragment must resume from its existing draft without resetting first prefix, changing boundary, or duplicating messages.
5. **Long turns** — verify 20-screen messages, image-rich turns, changing DOM virtualization, and loaded/unloaded neighbouring messages. Merely seeing the ChatGPT copy button does not mean the archiver uses it; source code needs an explicit integration if required.
6. **Queue** — two independent chat jobs must not share a frontier, draft, tab, or retry budget.
7. **Tests** — execute syntax + `scripts/verify.mjs` + real Chrome integration. Structural tests alone do not establish correct physical scrolling; older split-chat tests may still be stale.

## Next technical work
- Run a repeatable DOM virtualization fixture + browser end-to-end test and capture first failure at source, not only final UI error.
- Analyze `collect` fallback message identity and resumed `rebuildCaptureMap` for duplicate weak IDs; preserve truly repeated identical turns.
- Add coverage-reconciliation post-pass for `fragment` and fragment resume, scoped exactly to marked endpoints.
- Check the old 0.3.x image-retry lifecycle against current attempt-state cooldown and source extraction.

## Evidence limitation
These conclusions are from archived GitHub source revisions and user-provided screenshots. Current branch was published by the GitHub connector, but Chrome runtime results, CI verification, and full test outcomes were not obtained.
