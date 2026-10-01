# Architecture

ChatGPT Conversation Archiver is a Manifest V3 Chrome extension that captures an already-open ChatGPT conversation into a local archive and exports that archive to Google Docs.

The current codebase deliberately avoids a backend. Conversation content stays in the browser profile unless the user explicitly exports it.

## Runtime components

### `content-chatgpt.js`

ChatGPT-page adapter.

Responsibilities:

- discovers user/assistant message units in a virtualized conversation;
- performs full or continuation capture in chronological order;
- expands visible truncation/reasoning controls when enabled;
- captures rich HTML, plain text, stable message identifiers and image metadata;
- fetches image binaries while the authenticated ChatGPT page is still available;
- writes completed archives and incomplete drafts to `chrome.storage.local`.

This file contains site-specific DOM knowledge. DOM selectors and traversal rules should not leak into Google Docs/export code.

### `service-worker.js`

Orchestration and integration layer.

Responsibilities:

- validates the active ChatGPT/Google Docs tab;
- owns capture jobs, run logs and failure state;
- drives physical scrolling through Chrome DevTools Protocol;
- starts full, continue and sync flows;
- manages archive-to-Google-Doc links and continuation anchors;
- prepares export data;
- drives Google Docs focus, clipboard paste and image insertion;
- prevents unverified full-archive re-insertion into an already-linked document.

### `offscreen.js` / `offscreen.html`

Clipboard bridge for operations that cannot be performed safely from the service worker.

Responsibilities:

- rich HTML + plain-text copy;
- plain-text clipboard reads used by Google Docs baseline matching.

### `popup.js` / `popup.html` / `popup.css`

User-facing control plane.

Responsibilities:

- starts capture/continue/sync;
- exposes current run state and diagnostics;
- exposes archive/image counters;
- triggers copy and Google Docs export;
- stores presentation/user preferences.

The popup is not the owner of long-running state. Closing it must not cancel a running job.

## Persistent state

The extension currently stores:

- completed archives;
- incomplete capture drafts;
- active capture job metadata;
- archive index by conversation;
- linked Google Docs metadata;
- updater state outside Chrome storage.

A Google Doc is an export target/baseline, not the canonical in-browser archive. Continuation must be fail-closed: when the saved splice cannot be verified, the extension must stop rather than duplicate old messages.

## Main data flow

### Full capture

`ChatGPT tab -> content adapter -> local archive -> optional manual export`

A full rebuild refreshes the local archive only. It must not silently append the rebuilt archive to a previously linked Google Doc.

### Continue

`existing local archive -> verified last anchor -> capture delta -> merge -> linked Google Doc delta`

Only messages after the verified anchor may be appended.

### Sync

`Google Doc tail -> multi-message fingerprint -> ChatGPT verified splice -> capture delta -> local archive -> same Google Doc`

Unverified external baseline data must never replace the last good local archive.

## Image pipeline

Images are treated as data, not as remote URLs:

1. detect images in the ChatGPT message unit;
2. fetch image bytes while the ChatGPT session is available;
3. store a clipboard-friendly representation in the archive;
4. paste text without remote `<img src>` dependencies;
5. insert each image separately through the Google Docs tab.

The archive keeps separate counters for detected, prepared and inserted images because those are different failure stages.

## Trust and permission boundary

The extension requests broad browser capabilities because it physically drives pages:

- `debugger` for controlled scrolling and Google Docs interaction;
- `clipboardRead` / `clipboardWrite` for rich document transfer;
- ChatGPT and Google Docs host permissions;
- local storage.

No project server, OpenAI API key or Google API token is currently required.

See [SECURITY.md](SECURITY.md) for user-facing security notes.

## Known technical debt

The project is still pre-1.0.

The largest debt items are:

- `service-worker.js` and `content-chatgpt.js` are too large and should later be split into testable modules;
- DOM adapters are necessarily sensitive to ChatGPT/Google Docs UI changes;
- current automated checks are mostly static/smoke checks; regression fixtures should be added for real capture bugs;
- reasoning capture remains best-effort against visible DOM;
- the local ZIP updater is a development distribution mechanism, not the desired long-term user update channel.

These are intentionally documented instead of being hidden behind a "production ready" claim.
