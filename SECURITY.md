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

The extension attaches the debugger only to tabs involved in the active operation and detaches it afterward. A future refactor should continue to keep debugger use narrow and observable.

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

The optional reasoning setting only attempts to capture reasoning blocks exposed by the current ChatGPT page and expandable through the visible interface. It does not attempt to access hidden browser state or authentication data.

## Local updater

`update.cmd` + `update.ps1` are a development convenience for unpacked Windows installs.

The updater:

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
