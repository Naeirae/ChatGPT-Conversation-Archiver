# Security

## Scope

This is a local, unpacked Chrome extension for archiving an already open ChatGPT conversation and transferring it to Google Docs.

The extension does not ask for an OpenAI API key and does not send new ChatGPT messages.

## Debugger permission

The extension uses `chrome.debugger` for controlled interaction with Google Docs during export. Chrome therefore shows a debugger-related permission warning.

The debugger is attached only for the short Google Docs paste operation and is detached afterward.

## Clipboard

The extension writes rich HTML and plain text to the clipboard in order to preserve formatting during paste into Google Docs.

## Reasoning

The optional reasoning setting only attempts to capture reasoning blocks that are exposed by the current ChatGPT page and can be expanded through its visible interface. It does not attempt to access hidden browser state or authentication data.

## GitHub updater

The included updater reads the public repository over HTTPS and uses Git fast-forward updates. It does not require a GitHub token for reading this public repository and does not download an update when the local commit is already current.

## Reporting

Do not include passwords, authentication tokens, private conversation content, or other secrets in public bug reports.
