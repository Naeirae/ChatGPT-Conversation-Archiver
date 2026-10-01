# Changelog

This project is pre-1.0. Entries describe repository changes; browser behavior is considered verified only after an explicit live test.

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
