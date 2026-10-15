# Margin

Comment threads on anything you read, where the replies come from AI. Highlight a passage, ask about it, and Margin links the thread to related threads on other pages.

## Install (macOS)

1. Open `chrome://extensions`, turn on Developer mode, and load this folder with **Load unpacked**.
2. In Settings → Model, sign in with ChatGPT (Go, Plus or Pro) or connect OpenRouter (one click, or paste a [key](https://openrouter.ai/keys)).
3. Optional: run `./native-host/install.sh` to back up notes to SQLite.

What gets sent where, and how tokens and backups are stored: [docs/privacy.md](docs/privacy.md).

How related threads are found, scored and sent with a reply: [docs/related-threads.md](docs/related-threads.md).

## Develop

```sh
for t in test/*.test.mjs; do node $t; done   # unit tests
test/run-anchor.sh                           # anchoring (add item.test.html for highlight context)
python3 native-host/test_mirror.py           # SQLite backup (host log: ~/Library/Logs/margin-host.log)
```

Browser smoke tests: `python3 -m http.server 8000 --bind 127.0.0.1`, then open `test/export-browser.test.html` or `test/retrieval-browser.test.html` from it.

Opt-in evals that spend API credits (usage in each file's header): `test/eval-related.mjs` (TypeSafe key; tunes the related-thread cut-off), `test/eval-tags.mjs`.

Spec: Notion → Tech → "Margin — … Technical Specification".
