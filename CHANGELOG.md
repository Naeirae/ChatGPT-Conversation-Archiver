# Changelog

## 0.3.51

- add a fragment selection panel for existing local chat archives; choose inclusive start/end message numbers or leave either boundary open;
- copy only the selected messages with existing rich-text clipboard export, without altering the saved full archive or its continuation anchor;
- this is the first stage of fragment support: direct partial collection and separately saved fragment archives are not yet implemented.

## 0.3.50

- remove an implementation-note artifact from the walkthrough copy; keep the settings step focused on what the control does;
- manifest -> 0.3.50.

## 0.3.49

- move the walkthrough card into a dedicated side rail so the main 430 px interface remains visible;
- remove the walkthrough dimming layer and keep only the highlighted control outline;
- collapse Help/Settings before the walkthrough starts and stop reopening their popovers during walkthrough steps;
- highlight the Help and Settings buttons themselves instead of controls inside covering popovers;
- manifest -> 0.3.49.

## 0.3.48

- persist an unfinished-pass checkpoint while the chronological walk is running, including the source chat URL and fixed snapshot boundary;
- preserve that checkpoint when the working capture tab closes so the popup can offer **«Продолжить сбор»** instead of only a full retry;
- delete temporary recovery checkpoints after a successful capture;
- close already-open Help/Settings popovers before starting the walkthrough, while still opening the exact panel required by each walkthrough step;
- make the popup update notice explicitly green as well as the Chrome toolbar update badge;
- manifest -> 0.3.48.

## 0.3.47

- remove the blurred onboarding backdrop and keep the interface readable during the walkthrough;
- highlight the real interface control instead of drawing an approximate detached rectangle;
- prefer **«Продолжить сбор»** after a failed pass when a saved unfinished pass exists;
- keep **«Повторить в текущей вкладке»** only as a fallback when there is no resumable unfinished pass;
- manifest -> 0.3.47.

## 0.3.46

- fix the first-run walkthrough so the help card no longer sits under the highlighted interface;
- move the walkthrough card around the current field and spotlight the exact control being explained;
- open Settings and Help during the relevant walkthrough steps so their actual controls can be highlighted;
- keep conceptual steps such as unfinished-pass recovery readable even when the corresponding UI is not currently visible;
- version the walkthrough separately from the extension: ordinary updates do not reopen it, but a materially changed walkthrough can be shown once by increasing its walkthrough revision;
- keep the version on a separate header meta line so the Help button cannot cover it;
- recover saved archives by scanning local archive records even if the archive index is missing or stale, and repair that index automatically;
- show only the numeric count next to **История запусков** instead of repeating **запуск / запуска / запусков**;
- move “saved outside the extension” state into **Сохранённые чаты** instead of duplicating the latest archive card;
- let the user mark a chat as saved elsewhere and attach any http/https link, not only Google Docs;
- automatically mark successful Google Docs exports as saved outside the extension;
- add a compact **Новое в версии** card that appears only after a real extension update; first-use onboarding remains separate;
- rewrite the main popup labels and error states in plainer Russian;
- manifest -> 0.3.46.

## 0.3.45

- rebuild the popup around one clear flow: collect the current chat, then work with the saved archive;
- show version next to the product name and developer **@naeirae** directly under it;
- replace the text gear with a sourced settings icon and keep settings/help popovers inside the visible popup width;
- remove the misleading primary **«Сверить с сохранённым»** action; unfinished captures resume from unfinished passes, completed archives continue from the archive library;
- hide **«Незавершённые сборы»** completely when there are none;
- move Google Docs actions into the completed archive and saved-archive flows instead of a detached export card;
- show whether the current local archive is already linked to Google Docs and keep the local copy available for continuation or reset;
- add **«Скопировать»** to saved archives so rich text can be pasted into other apps without PDF export;
- show run duration in minutes and seconds for longer passes;
- replace the ambiguous system/custom font controls with named font choices;
- add a first-run walkthrough and a help menu with **@naeirae**, copyable contact, GitHub and a formatted local help page;
- keep the canonical Russian user help in **HELP.md**, including the browser-debugger explanation;
- allow Google Docs export and tab planning for a specifically selected saved archive, not only the most recent one;
- update the product-wide proprietary license so the same license can cover free and paid editions;
- manifest -> 0.3.45.

## 0.3.44

- restore the original solid color themes and add four explicit gradient themes instead of applying a subtle gradient to every palette;
- make the capture info **i** open a compact explanation on click instead of relying on a hover/title tooltip;
- tighten Russian interface copy and use **«Не обязательно»** for the ChatGPT-name placeholder;
- collapse the completed local archive into one line, **«Сохранён последний запуск»**, with details on click and a red **«Сбросить»** action;
- remove the standalone continuation card: unfinished captures continue from their recovery alert, while completed chats continue from the saved-archive library;
- add **«Продолжить»** to every saved archive; the extension opens the source chat and resumes from the saved archive anchor;
- keep Google Doc opening next to an archive when that archive has a linked document;
- add update discovery: the extension checks GitHub periodically, shows an **↑** badge on the toolbar icon, and shows a compact **«Доступно обновление»** notice in the popup;
- manifest -> 0.3.44.

## 0.3.43

- rebuild the popup around the capture task: capture location and primary actions stay visible, while appearance/update settings move under a compact gear control;
- rename capture targets to **«В фоновой вкладке»** / **«В текущей вкладке»** and add an inline info hint explaining that the working tab is physically scrolled and saved;
- keep user/assistant naming directly under capture as **special accessibility options** instead of burying them in global settings;
- remove the misleading reasoning checkbox from the popup and force reasoning export off for this release;
- compact unfinished-pass UI into a red recovery alert with **Дособрать / Просмотреть / Удалить**, keep the historical unfinished list collapsed, and remove leaked literal `\\n\\n` markup from the popup;
- add a compact list of archived conversations that have linked Google Docs, with one-click document opening;
- move run log and capture history into a compact technical-information section;
- add soft gradient variants to the existing interface palettes;
- pause now stores a visible-context checkpoint; resume first verifies the checkpoint, otherwise physically searches backward for the saved context before continuing;
- if the paused position cannot be proven, continuation fails closed and the collected part is saved as an unfinished pass instead of guessing;
- unfinished-pass viewer highlights the last saved message and adds **«К последнему сохранённому»**, plus recovery controls when the original working tab is still available;
- add a proprietary source-available license: public visibility is for transparency/update delivery and does not grant general use, modification, redistribution, or commercial reuse rights;
- repository/static verification updated for the compact popup structure;
- manifest -> 0.3.43.

## 0.3.42

- add automatic multi-document export for oversized archives with a safe 850k-character budget per Google Doc;
- name document parts as «[conversation title] — N» when the archive spans multiple documents; if automatic renaming is unavailable, the part title is still inserted in the document header;
- add bidirectional cross-document navigation: each later part links back to the previous part, and each previous part gets a Ctrl+K link to the next part;
- reset Google Docs tab counting inside every new document; the planner now shows automatic document boundaries and total physical tab count across parts;
- persist the linked document chain on the conversation while keeping the final part as the continuation target;
- prevent known exported H2 headings and cross-document navigation labels from contaminating Google Docs baseline message signatures during sync/recovery;
- add pure planning tests for document splitting, local tab-event reset, part titles, and boundary detection.

## 0.3.41

- remove the legacy "slow coverage retry" state from new runs and from the popup; current capture has only the normal navigation pass plus one chronological pass;
- preserve failed background capture tabs correctly so unfinished passes remain recoverable;
- rename the user-facing concept from "draft" to "unfinished pass" while keeping old storage keys internally for compatibility;
- list all saved unfinished passes in the popup and add a dedicated viewer with full saved messages and comparison against the completed local archive;
- store recovery metadata on unfinished passes, including capture phase, navigation high-water mark, and the original lower snapshot boundary;
- add a retry path that returns the preserved working tab to the top without re-counting/re-capturing the first stage, then repeats only the chronological downward pass and merges missing messages into the saved unfinished pass.

## 0.3.40

- keep the automatic slow second full pass removed;
- add a non-destructive content-script version handshake before any capture starts;
- if an already-open ChatGPT tab still contains an older injected archiver script after an extension update, the service worker no longer starts capture through that stale script;
- inject the current content script, verify its exact extension version, and only then send ARCHIVER_START_CAPTURE;
- if the version still cannot be proven, fail closed and ask for a page refresh instead of running old capture logic;
- this specifically prevents a removed legacy behavior such as the 0.3.34 slow coverage retry from reappearing through an old open tab;
- live browser verification is still required;
- manifest -> 0.3.40.

## 0.3.39

- add explicit deletion for the visible incomplete draft and the visible local archive;
- deleting a local archive removes its archive payload, canonical conversation index entry and stale last-archive pointer, but does not delete or unlink the external Google Doc;
- when a **full** background capture fails after a draft exists, keep that exact working ChatGPT tab open instead of closing it;
- show **«Открыть вкладку сбора»** and **«Найти стык и продолжить»** for a recoverable failed full capture;
- recovery reuses the same working tab, finds the last saved draft message, and continues only to the original fixed bottom snapshot marker from the failed run;
- the recovery anchor search can inspect both directions; the user may also open the preserved tab, physically scroll nearer to the failure point, and retry recovery from there;
- a successful recovery promotes the combined draft + recovered tail into a normal indexed archive and removes the draft;
- if recovery fails again, the new draft keeps the previous draft plus newly captured messages and replaces the older recovery draft;
- resetting a failed run now also closes its preserved recovery tab;
- closing a preserved recovery tab manually disables same-tab recovery but keeps the draft available for copy/delete;
- source/static verification is required; live browser verification of the recovery path is still pending;
- manifest -> 0.3.39.

## 0.3.38

- freeze every capture to the exact bottom message visible when collection starts;
- treat that message as the snapshot boundary and stop the chronological walk at it even if the source conversation receives newer messages in parallel;
- never collect messages below the boundary when the final viewport contains both the original marker and newer turns;
- defensively trim the final captured list through the boundary before save and fail closed if the marker cannot be found;
- persist boundary kind/key/role plus the count of any trimmed newer messages for diagnostics;
- this lets the user keep chatting in the same conversation while the working-copy capture runs without moving the archive's endpoint;
- local completed archives remain in chrome.storage.local across in-place updater file replacement and chrome.runtime.reload; removing/re-adding from another folder is still a different extension install;
- manifest -> 0.3.38.

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
