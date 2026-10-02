# Security

## Scope

This is a local Chrome extension for archiving an already open ChatGPT conversation and transferring it to Google Docs.

The extension does not ask for an OpenAI API key and does not send new ChatGPT messages. The current architecture has no project backend.

## Browser permissions

### Debugger

The extension uses `chrome.debugger` for controlled browser interaction:

- physical scrolling of ChatGPT during capture;
- focus/keyboard/mouse interaction with Google Docs during export.

Chrome therefore shows a debugger-related permission warning.

The extension attaches the debugger only to tabs involved in the active operation and detaches it afterward. In the current architecture this permission is a deliberate runtime dependency, not optional store-only baggage: physical ChatGPT scrolling hydrates virtualized history and attachments, and controlled Google Docs interaction is required for binary-image insertion. Do not remove it unless a replacement path is implemented and live-verified with equivalent guarantees.

### Clipboard

The extension uses clipboard read/write permissions to preserve rich document content and to read Google Docs text for continuation/sync matching.

From 0.3.14 image export also uses real image clipboard data when possible instead of asking Google Docs to fetch private ChatGPT image URLs.

## Local data

Captured conversations, drafts, job logs, linked-document metadata and prepared image data are stored in `chrome.storage.local` in the browser profile.

Do not treat browser local storage as encrypted archival storage. Users should avoid leaving sensitive archives in a shared browser profile.

## Google and ChatGPT authentication

The extension currently relies on the user's existing logged-in browser sessions. It does not request Google OAuth tokens or read account passwords.

Direct Google Drive/Docs API authentication is not implemented.

## Reasoning

The optional reasoning setting only captures reasoning blocks exposed by the current ChatGPT page and expandable through the visible interface. Current ChatGPT can render the disclosure/status (for example, “Обработка заняла 7s”) between the previous message and the final assistant text, so the adapter associates visible interstitial reasoning with the following assistant reply. It does not parse hidden chain-of-thought, hidden browser state or authentication data.

## Local updater

`update.cmd` + `update.ps1` are a development convenience for unpacked Windows installs.

The updater:

- registers the per-user `chatgpt-archiver:` URI scheme under `HKCU\Software\Classes` so the extension popup can launch the local VBS updater without elevated privileges;
- binds that URI to the absolute local path of `Update ChatGPT Archiver.vbs`; the passed URI argument is not executed as a command or interpreted as updater input;
- reads the public GitHub repository over HTTPS without a GitHub token;
- compares Git blob SHA values;
- stores a local update baseline;
- stops before overwriting files that differ from the saved baseline;
- creates a first-run backup for files it replaces;
- records the latest run in `updater-last.log`.

Updater state, logs and backups are excluded from Git.

The long-term end-user distribution path should prefer deterministic release artifacts and browser-managed updates rather than growing a custom updater into a security-sensitive subsystem.

## Reporting

Do not include passwords, authentication tokens, private conversation content, Google Docs content or other secrets in public bug reports.
