# Контрольная точка — аудит копии и границ, PR #44 (2026-10-28)

**Источник:** пользователь показал установленную 0.4.65: «Собирается архив по отметкам», этап 3/3 с одним сообщением, одним изображением и проходом 7 в копии переписки. Это свидетельствует об ошибке/риске полноты, но не доказывает точное число реплик в заданном диапазоне. Не смешивать копию переписки, открытую пользователем, с технической рабочей копией вкладки (`captureTarget: copy`).

**Проверенные исходники:** `content-chatgpt.js`, `service-worker.js`, `scripts/verify.mjs`; в ветке `fix/boundary-after-continuity-0.4.66` исправлены:

- R222: `collect()` не прерывается на DOM-смонтированной, но невидимой конечной отметке;
- R223: `walkDown()` и `walkDownFullLegacy()` после движения сначала подтверждают перекрытие соседних физических окон и лишь затем принимают конец;
- R224: `visibleNavigationRefsLightweight()` использует только физически видимые реплики, иначе невидимые DOM-узлы создают ложное перекрытие;
- R225: worker метрики скролла привязывает к реально видимым узлам, а после fallback заново снимает метрики для проверки края.

**Дополнение R226–R227 (2026-10-28):** обнаружено, что в режиме `fragment` видимая отметка начала подтверждалась, но итоговая последовательность не обрезалась по ней: при присутствии более ранних DOM-реплик в первом окне они попадали в архив. Теперь перед обрезкой по концу проверяется и удаляется префикс до исходной отмеченной реплики. Неоднозначная или потерянная начальная метка блокирует завершение, не публикуя ложный архив. Отдельно `trimMessagesThroughBoundary()` раньше выбирала первое совпадение слабой конечной метки; теперь неоднозначные совпадения отклоняются, а сохранённый соседний контекст может однозначно выделить нужное. Сильные ID остаются самостоятельным доказательством.

**Новые регрессионные тесты:** исключение префикса до старта, два одинаковых слабых конца, разрешение слабого конца контекстом, одинаковые тексты при разных сильных ID. CI коммита `23599d7`, run `40601092734`: extension job успешен; полный статус двух jobs проверять отдельно.

**Поведенческие регрессии:** `tests/capture-traversal.test.mjs` вызывает реальную функцию `collect()` и методы window evidence с виртуализованными DOM-фикстурами: невидимая/видимая конечная отметка, ложное/реальное перекрытие. Подключено к `scripts/verify.mjs`. Дополнительно есть source guards транспорта; они не заменяют поведенческие Chrome-проверки.

**Публикация:** draft PR https://github.com/Naeirae/ChatGPT-Conversation-Archiver/pull/44. Состояние CI последнего коммита проверять отдельно; `main` и установленная 0.4.65 не менялись.

**Следующий обязательный шаг:** дождаться CI текущего head, устранить выявленные failures, испытать длинную копию и ручные отметки в установленном Chrome; затем проверить картинки, локальный архив, продолжение и экспорт Docs. Релиз не объявлять рабочим до live-подтверждения. Отдельно исследовать начало, которое может быть ошибочно принято за реальное при виртуализированном списке, и источник единственного сообщения в наблюдаемом случае.

---

# Текущая контрольная точка — 0.4.65 (2026-10-28)

**Источник:** пользователь показал Chrome 0.4.64, где сбор основного архива по отметкам дошёл до этапа 3/3 «Забираю изображения: 2/2», сохранил/считал только 3 сообщения на 13-м проходе и завис без завершения. Уточнение пользователя: прокрутка вниз началась с начала, но покрыла лишь маленький участок. Это не подтверждает полноту выделенного диапазона.

**R217:** достижение конечной отметки доказывается физическим пересечением видимого viewport/scrollport, а не наличием виртуализованного узла в DOM. Этим же способом проверяется пользовательский старт.
**R218:** совпавший устойчивый ID реплики не зависит от соседей, которые могли исчезнуть при виртуализации; слабая текстовая метка должна подтверждаться исходным контекстом при финальной обрезке и не может неоднозначно совпасть.
**R219:** обработка изображений, запись архива и подтверждение worker — разные наблюдаемые этапы; зависание worker ACK не должно держать окно бесконечно на «Загружаю картинки». Ошибки worker нельзя подавлять.
**R220:** lastArchiveId и индекс публикует только worker после проверки. Отклонённая запись остаётся отдельным просматриваемым draft и не удаляет прежний успешный архив.
**R221:** тесты на offscreen end marker, физическое пересечение viewport, уникальный устойчивый ID и отклонённую копию с изображениями; CI и реальный Chrome проверяются отдельно.

**Изменения:** `content-chatgpt.js` (физическая отметка, финализация, таймауты, подтверждение), `service-worker.js` (транзакционная публикация, возврат статуса, черновик ошибки), `lib/capture-viewport.mjs`, `lib/capture-recovery.mjs`, новые тесты, `scripts/verify.mjs`. Исходные завершённые архивы сохраняются.

**Состояние:** версия 0.4.65 опубликована в `main` через PR #43, merge commit `24ffdf74a1cf1a1f49f4f0a57116e29979707dfd`. GitHub Actions run `40594518134`: обе сборки успешны; пакет расширения создан; 85/85 Node-тестов прошли. Из пяти требований R217–R221 кодом и CI подтверждены 5/5; сквозные проверки в пользовательском Chrome — 0/4. Обязательные следующие действия: проверить физический проход по длинному отмеченному диапазону, совпадение конечной отметки с реальным viewport, полный локальный архив с изображениями, просмотр и экспорт в Google Docs. Без этого считать регрессию устранённой в Chrome нельзя.

---

# Текущая контрольная точка — 0.4.64 (2026-10-28)

**Зарегистрированная регрессия:** пользователь в Chrome 0.4.63 запустил сохранение рабочей копии. Сбор не совершил наблюдаемого прохода и показал «Готово: 7 сообщений». Число 7 само по себе не доказывает дефект: маленький чат может состоять из 7 сообщений. Дефект — не подтверждён реальный старт и конец снимка, но статус успешного полного сбора выдан.

**R211:** полная автоматическая копия сначала подтверждает физическую нижнюю границу, а не использует последнюю видимую реплику первого окна.
**R212:** повторение статического viewport не доказывает верх; нужны первый turn, ручное подтверждение либо наблюдаемый реальный подъём + устойчивое окно.
**R213:** транспорт возвращает evidence движения/края и не выдаёт успех при безрезультатной прокрутке.
**R214:** ручной диапазон идёт только вниз от отмеченного начала до отмеченного конца; короткий диапазон с обоими видимыми маркерами допустим без прокрутки.
**R215:** «Готово» требует доказательства обеих границ в page-script и worker; старые бездоказательные архивы сохраняются, но маркируются «полнота не подтверждена».
**R216:** регрессии зафиксированы тестами, включая короткую переписку, неверный полный сбор и слабые ID.

**Статус:** код исправлений готов в ветке fix/verified-capture-frontiers-0.4.64. GitHub Actions run 40591419445: extension + updater — успех; 75 из 75 Node-тестов; пакет расширения собран. По шести требованиям R211–R216 исходный код и регрессии проверены CI (6/6). Сквозные проверки Chrome/Docs остаются открытыми (0/4): ручной диапазон, полный сбор в копии, короткий чат и действительный длинный чат. Следующий шаг — слияние PR #42 и живая проверка.

**Ограничение:** автоматическая прокрутка на пользовательской версии ChatGPT в этой среде напрямую не исполнялась; тесты исходного алгоритма не заменяют её.

---

# Текущая контрольная точка — 0.4.63 (2026-10-27)

**Цель:** исправить оставшиеся регрессии 0.4.62: ошибочное объединение повторов, тяжёлое открытие popup, неверные счётчики и устаревание изображений синтетического архива.

**R207:** сливать только уникально подтверждённые хронологические перекрытия с общим устойчивым ID; одни совпадающие тексты недостаточны.
**R208:** загружать полные черновики и проверять перекрытия только по явному действию; список готовых архивов не должен ждать.
**R209:** показывать количество сообщений и изображений по объединённой проверенной последовательности.
**R210:** пересобирать синтетическую копию из текущих исходников, предпочитать более новую сохранённую контрольную точку при разном содержимом изображения; источники сохранять.

**Файлы:** lib/draft-overlap.mjs, service-worker.js, popup.js, popup.html, tests/draft-overlap.test.mjs, scripts/verify.mjs, manifest.json.
**Статус:** 0.4.63 перенесена в main через PR #41, merge commit 4fb2b49cf3852e9c48cc9ce1a0daefa83b05227e. GitHub Actions run 40584773761: extension и updater успешно завершены, пакет расширения создан, 67/67 Node-тестов пройдены. Четыре кодовые проверки выполнены (4/4), четыре сквозные пользовательские проверки Chrome/Google Docs ещё не подтверждены (0/4). Следующий шаг: обновить установленное расширение и проверить большой готовый архив, ручную загрузку черновиков, объединённые счётчики, сохранение изменённых изображений и экспорт в Google Docs. До этого архитектурную ревизию не считать полностью закрытой.

---

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


## 2026-10-27 — partial-overlap draft recovery (0.4.62)

**User requirement:** multiple versions of one saved capture must be assembled by verified content overlap; same-titled but distinct ChatGPT conversations must never be conflated. Already captured archives/drafts must survive until the generated result is verified.

**R201:** Compare identity by source conversation key, fixed lower snapshot boundary and manual range; title never establishes identity.
**R202:** Allow contiguous, uniquely anchored chronological overlaps even when draft windows have different starts.
**R203:** Reject conflicting strong IDs, ambiguous repeated content and one-turn/weak-only overlaps.
**R204:** Preserve source snapshots while composing a new merged recovery draft, with explicit source provenance and repeatable ID.
**R205:** Group overlapping versions as a single user-facing recovery card, and make preview/export/resume consume the same assembled material.
**R206:** Package the unfinished viewer and run behavioral unit tests, not only textual source guards.

**Implementation:** `lib/draft-overlap.mjs`, `tests/draft-overlap.test.mjs`, `service-worker.js`, `unfinished.js`, `scripts/package.mjs`, `scripts/verify.mjs`. The safe merge only follows one uniquely verified alignment; the source draft records are not overwritten or deleted. The popup's normal read-only load does not materialize a merged archive.

**Verification:** GitHub Actions run `40578741997` passed both extension and updater jobs; 63 Node.js behavioral/unit tests passed, including the new partial-overlap cases. This is source/build verification only. Live Chrome validation is not claimed. Required browser checks: (1) reopen overlapping versions; (2) inspect grouped card and combined content; (3) export and confirm Google Docs body; (4) resume from the rightmost saved frontier; (5) delete a synthetic merged snapshot without losing the source attempts; (6) confirm equal-titled distinct conversations stay separated.

**Next operation:** merge the source-verified PR to `main`; then perform the browser checklist against a long saved chat. If a real archive reveals ambiguous overlap, preserve both source drafts and inspect the exact conflicting ID/role/text sequences before changing the matcher. Earlier live scroll validation remains pending.
