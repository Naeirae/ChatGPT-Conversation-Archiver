# ChatGPT Conversation Archiver

Chrome extension for archiving complete ChatGPT conversations — including rich text formatting and images where possible — and exporting them to Google Docs.

> Work in progress. No license has been selected yet.

## Goal

Save a ChatGPT conversation as an editable document rather than a screenshot:

- capture complete user messages and ChatGPT replies;
- expand truncated messages before capture;
- preserve semantic formatting: headings, bold, italics, lists, links, code blocks and tables;
- keep image positions and try to carry images into Google Docs;
- collect the conversation locally first, then export it to Google Docs in one separate step.

The project does **not** use the ChatGPT API and is not part of another extension family. It is a standalone browser extension.

## Current MVP

The first prototype does the following:

1. Opens the current ChatGPT conversation.
2. Scrolls from the beginning to the end and tries to click local `Show more` / `Развернуть` controls inside messages.
3. Captures each `[data-message-author-role]` turn as rich HTML + plain text.
4. Stores the captured conversation locally in extension IndexedDB.
5. Builds one rich clipboard fragment with `Пользователь` / `ChatGPT` separators.
6. Opens `docs.new` or uses an already-open Google Doc.
7. Focuses the Google Docs editor through Chrome DevTools Protocol and performs a physical paste.

### Images

Image URLs and their positions are captured. In `0.1.0`, Google Docs receives them through the rich HTML clipboard, so image insertion is **best effort**. Authenticated/blob images may not survive the paste yet. A dedicated image-blob pipeline is planned after the basic text/formatting round-trip is proven.

## Install locally

1. Download or clone the repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.

## First test

1. Open a ChatGPT conversation.
2. Click the extension icon.
3. Click **Собрать текущий чат**.
4. Check the reported message/image count.
5. Click **Сохранить в новый Google Doc**.
6. Verify:
   - first and last messages are present;
   - long messages are complete;
   - user/assistant order is correct;
   - headings/lists/links/code/table formatting survived;
   - images either survived or are the only missing layer.

## Privacy

The MVP stores the captured conversation locally in the browser extension profile. It does not send conversation content to a project server.

## Known risks

- ChatGPT DOM selectors can change.
- Very long conversations may be virtualized/lazy-loaded differently and need additional traversal logic.
- Google Docs is not a normal contenteditable DOM; export intentionally uses physical UI interaction rather than a private Docs API.
- Rich clipboard image behavior differs by image URL/authentication method.

## License

No license selected yet.
