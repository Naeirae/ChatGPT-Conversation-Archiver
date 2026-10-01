# Privacy

ChatGPT Conversation Archiver is currently a local-first browser extension.

## Data the extension processes

When the user explicitly starts a capture or sync operation, the extension may process:

- text and formatting visible in the selected ChatGPT conversation;
- images visible in that conversation;
- visible/expandable reasoning UI when the optional setting is enabled;
- the text of a Google Doc selected for continuation/sync matching;
- local run diagnostics such as capture phase, counts and errors.

## Where data is stored

Completed archives, incomplete drafts, linked-document metadata and run state are stored in the browser extension profile through `chrome.storage.local`.

The current project has no application backend and does not upload conversation archives to a project server.

When the user exports to Google Docs, the selected archive/delta is inserted into the user's Google Doc through the browser UI.

## Authentication

The extension uses the user's existing authenticated browser sessions for ChatGPT and Google Docs.

It does not request:

- an OpenAI API key;
- a Google OAuth access token;
- account passwords.

Direct Google Drive/Docs API OAuth is not implemented.

## Network access

The runtime extension interacts with:

- ChatGPT pages selected by the user;
- Google Docs pages used for export/sync.

The optional Windows updater separately downloads public repository files from GitHub over HTTPS.

## Browser permissions

The extension currently requests permissions including `debugger`, clipboard read/write, tabs, scripting and local storage. These permissions support physical scrolling, continuation/sync matching and Google Docs insertion.

See [SECURITY.md](SECURITY.md) for the technical permission boundary.

## Retention and deletion

Archive data remains in the local browser profile until it is overwritten/removed by extension behavior or the user clears extension/site data or removes the extension.

A dedicated archive-management UI is not implemented yet. Until it exists, users should treat the current product as a pre-1.0 local tool rather than encrypted long-term storage.

## Public bug reports

Do not paste private conversation text, Google Docs contents, authentication data or other secrets into public GitHub issues.

## Future changes

If the project later adds a backend, Google OAuth, analytics, crash reporting or cloud sync, this document must be updated before those features are represented as production-ready.
