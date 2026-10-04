# Changelog

## 0.3.37

- keep the 0.3.36 removal of the destructive automatic second full capture pass;
- add an explicit **«Добрать картинки»** fallback for poor-network cases: it is manual only, does not run during normal capture, re-walks the conversation, unions image sightings from the upward and downward passes, and merges only newly found images into the existing local archive without replacing message text;
- add an explicit **«Довставить добранные картинки»** action for a linked Google Doc; it inserts only recovered image binaries and refuses to paste when a unique message anchor cannot be proven;
- keep a per-document image-patch ledger so the same recovered image is not inserted twice by the repair action;
- fix a reasoning-copy loss mode: when the clickable disclosure wrapper contains both **«Обработка заняла …»** and the expanded reasoning text, strip only the status line instead of treating the whole wrapper text as the label and deleting the captured reasoning;
- harden multi-tab Google Docs export: count the implicit first tab as tab 1, verify the physical tab count before every new section, require each creation step to increase the count by exactly one, switch to the proven new tab before pasting, and verify final physical tab count equals the planned section count;
- make the planner explicitly show message #1 as **«Первая вкладка уже есть»**; the implicit first Google Docs tab is never created by the exporter, while every later **«Вкладка перед»** marker must produce exactly one new physical tab; a heading for the first tab can still be placed at message #1;
- source/browser live verification is still required for image recovery, reasoning capture, and the new physical-tab count checks;
- manifest -> 0.3.37.

## 0.3.36

- remove the automatic destructive second full downward pass added in 0.3.34;
- keep the first chronological pass intact instead of clearing `map/order` and starting over;
- expand completeness checking from count-only retry logic to message-level reconciliation between the upward navigation pass and the chronological downward pass;
- record ordered navigation windows while moving upward and reconstruct a navigation sequence from their overlaps;
- if a message seen during navigation is missing from the chronological pass, insert the captured navigation copy only when its position can be proven from neighbouring messages;
- preserve richer reasoning/image data from the navigation copy when the chronological copy is poorer;
- if placement cannot be proven, fail closed without another full pass and keep the best reconciled first-pass result as the draft;
- report how many messages were restored and how many remain unresolved;
- this directly addresses the live failure where a safety repeat ran after a usable first pass and the repeat failure discarded the previously collected result;
- browser/live verification is still required;
- manifest -> 0.3.36.

This project is pre-1.0. Entries describe repository changes; browser behavior is considered verified only after an explicit live test.

## 0.3.35

- fix the reasoning-disclosure association bug seen in live 0.3.34: visible status labels such as **«Обработка заняла …»** could be found globally but then rejected by the older previous-turn-window heuristic before any physical click was attempted;
- associate each visible reasoning status label with the nearest following visible assistant reply instead of requiring it to live inside the previous/next turn wrapper geometry;
- allow strong reasoning status labels to bypass the legacy window filter after that association step;
- search farther up the DOM tree for a real clickable ancestor and keep the tightest visible status wrapper as a physical-click fallback when ChatGPT exposes no semantic button;
- after expansion, physically copy reasoning from an aria-controlled body, sibling reasoning body, content expanded inside the same disclosure wrapper, or the interstitial range before the final assistant message;
- strip the disclosure label from copied reasoning text when the wrapper itself had to be selected;
- this is a targeted live-failure fix; Ctrl+F/keyboard navigation remains the next fallback if the current ChatGPT rollout still does not expose a physically clickable disclosure target;
- live behavior remains unverified until the next reasoning-enabled capture test;
- manifest -> 0.3.35.

## 0.3.34

- treat the stage-1 message count as a hard completeness signal for full captures instead of ignoring it after rewinding to the top;
- record the stage-1 navigation high-water count and the earliest observed turn before clearing the navigation map;
- make the chronological downward pass deliberately granular (3 wheel bursts by default instead of the previous coarse 7-burst step);
- if the first chronological pass collects fewer messages than were already observed while going upward, automatically rewind and repeat the full downward pass with single-burst scrolling;
- refuse to replace the completed archive when the final chronological result is still smaller than the navigation high-water mark or misses the earliest observed turn; keep the incomplete result only as a draft;
- expose navigation-minimum vs chronological-count progress in the popup so a 200 -> 100 discrepancy is visible instead of silently accepted;
- physically click visible reasoning disclosures through Chrome debugger input rather than DOM `.click()`;
- physically copy the expanded reasoning selection with Ctrl+C and use that copied text as the reasoning payload; preserve richer reasoning/image data if virtualization later recreates a poorer copy of the same turn;
- detect visible ChatGPT **«Попробовать снова» / Try again / Retry** controls during both upward and downward capture passes, physically click them, wait for the local chunk to settle, and continue;
- use a physical retry click during initial working-tab hydration too;
- Ctrl+F-based keyboard navigation remains a fallback candidate if physical selection + Ctrl+C is not sufficient in live testing;
- live behavior remains unverified until an explicit long-chat test;
- manifest -> 0.3.34.

## 0.3.33

- add explicit capture lifecycle controls: **Пауза**, **Продолжить сбор**, **Остановить**, **Сбросить запуск**;
- pause/resume now suspends the existing capture loop instead of cancelling and restarting it;
- keep manual pause distinct from Chrome's frozen-tab state so browser unfreeze does not silently override a user pause;
- add persistent capture-run history with status, mode, target, counts, timestamps and result messages; keep the latest 20 runs and show the latest 10 in the popup;
- add a separate history-clear action; resetting a run does not delete the completed archive or run history;
- restructure the popup around the primary workflow: current capture state and controls first, then local archive, continuation, export, history, archive formatting, interface appearance and updater;
- rename the old archive-continuation action in the UI to **Добрать новое** so it is not confused with resuming a paused capture;
- move capture mode, Google Doc continuation details, diagnostics and secondary settings behind progressive disclosure;
- keep existing element IDs and workflows where possible to reduce regression risk;
- live UX and pause/resume behavior still require explicit browser verification;
- manifest -> 0.3.33.

## 0.3.32

- harden the full-capture top-detection path against slow or temporarily stalled ChatGPT lazy loading;
- replace the short ~1.6 s settle heuristic with a longer quiet-window settle check;
- push farther upward while probing for older virtualized turns;
- require the first visible turn, visible-turn signature and collected-message count to remain unchanged across repeated delayed probes before declaring the beginning reached;
- add an explicit loading window between idle confirmations so a frozen DOM is less likely to be mistaken for the true start of the conversation;
- increase the safety cap for upward iterations and fail explicitly instead of silently accepting an unconfirmed beginning;
- browser/live behavior remains unverified until the next long-conversation capture test;
- manifest -> 0.3.32.

## 0.3.31

- fix the advertised reasoning-capture path after inspection of a real ChatGPT technical export;
- recognize visible reasoning recap/status labels such as **«Обработка заняла 7s»** as strong UI markers;
- stop assuming reasoning controls are descendants of the final assistant message;
- associate a visible reasoning disclosure in the DOM interval between neighbouring turns with the following assistant reply;
- click the disclosure, wait for its visible content, and capture the interstitial DOM up to the final assistant text;
- preserve the old aria/state-based in-turn detector as a fallback for other ChatGPT rollouts;
- store `reasoningStatus`, `reasoningText`, `reasoningHtml` and aggregate reasoning counts;
- document that `chrome.debugger` remains a required dependency of the current capture/export architecture;
- do not ingest or publish the private technical dump used for diagnosis;
- manifest -> 0.3.31.

## 0.3.30

- stabilization pass after the updater/icon regressions;
- include `updater.html`, `updater.css` and `updater.js` in the deterministic packaged extension artifact;
- add `updater.js` to JavaScript syntax verification;
- validate PNG signatures and exact icon dimensions in CI, not only file presence;
- verify the GitHub host permissions required by the browser updater;
- verify the package script cannot silently omit the updater files again;
- no capture/export behavior changed in this release;
- manifest -> 0.3.30.

## 0.3.29

- fix the first live 0.3.28 updater-entry failure: clicking **Обновить** in the popup did not open the updater page;
- remove the JavaScript `chrome.tabs.create()` dependency for this entry point;
- make **Обновить** a direct extension-page link to `updater.html` with `target="_blank"`, so Chrome handles navigation natively from the popup;
- keep the in-browser updater implementation itself unchanged pending its next live test;
- manifest -> 0.3.29.

## 0.3.28

- replace the popup custom-protocol/VBS updater launch with an in-browser updater page that shows progress and a live log;
- use Chromium File System Access so the user explicitly chooses the unpacked extension folder;
- compare local Git blob SHA-1 values against the public GitHub repository, download changed/missing files, and back up overwritten local files before writing;
- keep `update.cmd` as the supported external fallback;
- turn `Update ChatGPT Archiver.vbs` into a non-executing informational stub so it no longer launches hidden PowerShell;
- add GitHub API/raw host permissions required by the updater page;
- repair corrupted 32/64/128 PNG icon assets so Chrome can load the toolbar/action icon correctly;
- manifest -> 0.3.28.

## 0.3.27

- separate **Сверить с архивом** from **Продолжить** in the popup;
- keep **Продолжить** visible whenever the popup is open; disable it instead of hiding it when the current chat has no local archive;
- add a non-mutating compare mode that counts messages newer than the current local archive and reports the count without changing that archive;
- let **Продолжить** append its verified delta to an explicitly supplied Google Doc as a one-off destination without replacing the chat's canonical linked document;
- prevent one-off document exports from being recovered later as the canonical linked document;
- keep blank-target continuation behavior: use the linked document when present, otherwise update only the local archive;
- preserve the previous Google-Doc-baseline recovery path under **Восстановить точку продолжения из Google Doc**;
- add regression coverage for one-off document exports not stealing the canonical link.

## 0.3.26

- replace the extension icon set with the new blue abstract wave mark;
- restructure the popup without removing capture, continuation, sync, planner, export, archive, updater or diagnostic actions;
- keep service/error status at the top in a sticky status block;
- separate archive formatting from interface appearance settings;
- move interface appearance settings near the top of the popup;
- add more built-in interface palettes plus a free custom color mode for accent, background, panels and text;
- add interface font selection, including an arbitrary locally installed font name;
- preserve the old `palette` setting as a compatibility mirror while storing richer appearance data under `interfaceAppearance`;
- add verification guards for the popup structure, appearance layer and icon assets.

## 0.3.25

- add **Обновить** directly to the extension popup;
- register a per-user Windows `chatgpt-archiver:` URI handler from `Update ChatGPT Archiver.vbs`, so the popup can launch the existing quiet updater;
- add **Перезагрузить** in the popup to call `chrome.runtime.reload()` after the updater finishes;
- show the currently loaded extension version in the update block;
- add verification guards for the popup updater controls and VBS protocol registration;
- migration note: after 0.3.25 is downloaded by the older launcher, run the new VBS once manually to register the protocol; later updates can start from the popup.

## 0.3.24

- fix the first live multi-tab export defect: a three-section plan could leave only two physical Google Docs tabs;
- track every Google Docs tab token already visited during one export and require each new tab creation to produce a genuinely unseen token;
- retry physical tab creation up to three times when Google Docs bounces to an existing tab instead of silently treating that navigation as a new tab;
- fail closed before pasting the next section if a unique new tab cannot be proven;
- add a regression test for existing-token vs new-token detection.

## 0.3.23

- roll the default capture path back to the last live-proven 0.3.10 background architecture instead of continuing the failed 0.3.22 foreground-copy experiment;
- open a fresh dedicated ChatGPT capture tab, hydrate it in the foreground, start the collector, then restore focus to the source chat while collection continues in the working tab;
- restore the user-facing “Фоновый режим — рабочая копия” terminology and the README description of the background workflow;
- keep the later archive, Google Docs, planner, updater, CI and portfolio layers intact;
- 0.3.22 is explicitly treated as a failed live experiment, not as the new product architecture.

## 0.3.22

- keep the duplicated ChatGPT working-copy tab active during physical wheel traversal instead of returning focus to the source chat immediately;
- restore the source ChatGPT tab after successful completion, cancellation or capture failure;
- rename the popup wording from misleading “background mode” to an explicit separate working-copy tab;
- this responds to a live stall where stage 1/3 stayed at 9 collected messages after the working copy lost foreground visibility; browser live verification is still required.

## 0.3.21

- restore the service-worker runtime helpers for active-tab lookup, capture-job state, badge/title updates and run-log formatting that were accidentally removed during the archive-store extraction;
- add a repository verification guard so these required runtime helpers cannot disappear while syntax checks still pass;
- keep popup status/errors visible in a sticky status panel instead of placing them below the export controls;
- this fixes the reported `getActiveTab is not defined` / `getJob is not defined` startup failures in source; browser live verification is still required after updating and reloading the extension.

## 0.3.20

- add a quiet Windows updater launcher, `Update ChatGPT Archiver.vbs`, as the user-facing entry point;
- keep the proven `update.ps1` engine and `update.cmd` diagnostic fallback unchanged;
- run the launcher without a visible console, show a short start notification and a final success/error dialog;
- offer to open `updater-last.log` automatically when the hidden updater fails;
- smoke-test the VBS launcher on the Windows CI job.

## 0.3.19

- replace the copied message-map/text-plan workflow with a dedicated full-page visual archive planner;
- allow scrolling the saved conversation and placing tab/heading markers directly on messages;
- persist markers per archive and migrate the temporary 0.3.18 text plan once;
- show image thumbnails and collapsible long messages to make topic boundaries easier to identify;
- package and verify the new planner page while keeping the existing deterministic tab-plan export engine.

## 0.3.18

- add a manual Google Docs tab export plan based on archive message numbers;
- create additional Google Docs document tabs through physical UI interaction;
- allow topic subheadings inside a tab with `N | подзаголовок | Тема`;
- add a numbered message-map clipboard helper so tab boundaries can be chosen without guessing;
- keep later continuation linked to the final tab of the exported document;
- add pure parser/section-planner regression tests.

## 0.3.17

- extract archive/link persistence into an injected storage adapter;
- add regressions for archive indexing, legacy linked-document recovery and export-tail persistence;
- extract Google Docs baseline parsing into a pure module;
- add multi-tab baseline regressions, including empty trailing tabs and tails that cross a tab boundary;
- keep browser/UI orchestration in the service worker while reducing direct storage/parser responsibilities.

## 0.3.16

- extract browser-independent text/signature and URL helpers from the service worker;
- add regression tests for continuation tail recovery and URL parsing;
- run regression tests as part of the repository verification gate;
- add clean extension packaging to `dist/extension`;
- publish a verified extension package as a GitHub Actions artifact.

## 0.3.15

- fail closed when continuation splice disappears during the chronological pass;
- never auto-append a full rebuild to a linked Google Doc;
- prevent manual linked-document export from falling back to a full duplicate when the previous anchor cannot be verified;
- preserve continuation tail signatures for safer re-linking after rebuilds.

## 0.3.14

- capture image binaries while ChatGPT session access is available;
- paste images separately into Google Docs through the browser clipboard/debugger path;
- expose detected/prepared/inserted image counters.

## 0.3.13

- add background working-copy and visible current-tab capture modes;
- add current-tab fallback after working-copy load failure.

## 0.3.12

- add local continuation + Google Doc sync/baseline flow;
- support multi-tab Google Docs continuation semantics.

## Earlier 0.3.x

- background capture jobs;
- structured run logs and incomplete drafts;
- Windows ZIP updater iterations;
- rich clipboard export and Google Docs physical paste.
