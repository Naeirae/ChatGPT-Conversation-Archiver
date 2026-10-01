# Development

## Local install

1. Clone or download the repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Load the repository as an unpacked extension.
5. After code changes, click **Reload** on the extension card.

## Static verification

The repository intentionally has no build step yet. The first automated quality gate is dependency-free:

```bash
node scripts/verify.mjs
```

It checks JavaScript syntax, parses `manifest.json`, verifies the extension version format and rejects accidental private/updater artifacts.

GitHub Actions runs the same checks on pushes and pull requests. A Windows job also parses `update.ps1` with PowerShell because updater syntax regressions have previously caused real failures.

## Manual smoke matrix

Before calling a release live-verified, test at least:

- full capture on a short chat;
- full capture on a long virtualized chat;
- current-tab and working-copy capture modes;
- continuation with no new messages;
- continuation with a small delta;
- duplicate protection against an already linked Google Doc;
- Google Doc sync from a multi-tab document;
- text-only export;
- image-only message export;
- mixed text + image export;
- cancellation and one forced failure;
- updater once, then updater again when already current.

Record which layer was actually tested. A green CI run is not a substitute for a browser live test.

## Version discipline

Keep these concepts separate:

- repository source version;
- `manifest.json` version;
- packaged/downloaded version;
- version currently loaded in Chrome;
- behavior actually verified in a live browser.

Bug fixes should not be described as "working" until the relevant live layer has been exercised.

## Update/distribution strategy

The current `update.cmd` + `update.ps1` pair exists for local unpacked development installs.

Long term, the simpler end-user path is:

1. deterministic packaged ZIP/release artifacts;
2. Chrome Web Store (or organization-managed distribution) for automatic browser updates;
3. keep the custom updater only for developer/unpacked builds, or remove it after migration.

Do not add Google/OAuth authentication just to make the updater simpler. Authentication is a separate product decision.

## Authentication

The current product deliberately works through the user's already authenticated browser tabs and therefore does not need Google OAuth.

OAuth becomes useful only if the product moves to direct Google Drive/Docs API operations (for example server-independent document creation/read/write without physical UI automation). That change adds:

- OAuth client configuration;
- token lifecycle/revocation;
- Google scope review;
- privacy-policy and consent-screen work;
- additional security and test surface.

Treat that as a later architecture choice, not a cleanup task.

## License

No license is intentionally selected yet. Do not add one until the commercial/open-source strategy is decided.
