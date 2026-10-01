# Changelog

This project is pre-1.0. Entries describe repository changes; browser behavior is considered verified only after an explicit live test.

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
