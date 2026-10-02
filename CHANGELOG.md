# Changelog

This project is pre-1.0. Entries describe repository changes; browser behavior is considered verified only after an explicit live test.

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
