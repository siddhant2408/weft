# Contributing

Weft is a Chrome extension written in plain JavaScript with no build step and no dependencies to install. Load the folder in Chrome and edit files directly. How it fits together: [docs/architecture.md](docs/architecture.md).

## Setup

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. After changing a file, click reload on Weft in `chrome://extensions`. Content scripts pick up changes when you reload the page.

## Conventions

- **Modules.** The service worker and extension pages (`background.js`, `sidepanel.js`, `threads.js`, `options.js` and what they import) are ES modules. Content scripts can't be modules, so `anchor.js`, `notes.js` and `settings.js` are plain scripts that expose one global each (`MarginAnchor`, `MarginNotes`, `MarginSettings`).
- **Internal names.** `MarginAnchor`, `MarginNotes`, `MarginSettings`, the `margin` IndexedDB and highlight name, `com.margin.host` and its `Margin/notes.db` path come from the project's earlier name. They stay as they are so existing notes, sign-ins and backups keep working.
- **Style.** Two-space indent, single quotes, semicolons, `{ a, b }` with spaces, arrow parameters in parentheses (`(x) => …`). Lines up to about 150 characters. Match the file you're in.
- **Storage.** Only `background.js` writes page records, through `updatePage`/`updateThread`. Other contexts read `chrome.storage` and send messages for writes.
- **Comments** say what something is for or why it isn't obvious, not what the next line does.
- **No new dependencies.** Third-party code goes in `vendor/` as a single file with its license header kept.
- **Model output and page text are untrusted.** Render through DOMPurify; keep untrusted text inside its prompt tags.
- **Tests.** Logic with branches (parsing, ranking, storage, sign-in) gets a check in `test/*.test.mjs` using `node:assert`, with Chrome APIs stubbed at the boundary.

## Checks before a PR

```sh
for t in test/*.test.mjs; do node "$t" || exit; done
for f in *.js; do node --check "$f" || exit; done
test/run-anchor.sh                    # if you touched anchor.js
python3 native-host/test_mirror.py    # if you touched native-host/
```

Then try the change in the loaded extension.
