# Margin

Comment threads on anything you read, where the replies come from AI. Spec: Notion → Tech → "Margin — … Technical Specification".

## Setup (macOS)
1. Chrome → `chrome://extensions` → Developer mode → Load unpacked → this folder.
2. Settings → Model: paste an [OpenRouter](https://openrouter.ai/keys) API key. Both the main model and the small model (concept tags, takeaways, picking related threads) default to `openrouter/free`, which routes each call to a random free model: $0, but rate-limited, quality varies call to call, and free providers may log or train on prompts (your passages and threads). Free models may also need "free endpoints" allowed in OpenRouter's privacy settings. Both fields accept any OpenRouter model ID, e.g. `anthropic/claude-sonnet-5.5` and `anthropic/claude-haiku-5.5`.
3. Optional: `./native-host/install.sh` registers the native host that backs up notes to SQLite (extension ID is pinned by `key` in manifest.json).

## Checks
- `for t in test/*.test.mjs; do node $t; done` and `test/run-anchor.sh` (plus `test/run-anchor.sh item.test.html` for highlight context): unit + anchoring tests.
- `python3 native-host/test_mirror.py`: SQLite mirror save/overwrite/delete, and rejection of anything else.
- Host log: `~/Library/Logs/margin-host.log` (no page contents).

Browser export smoke test: serve this folder with `python3 -m http.server 8000 --bind 127.0.0.1`, then open `http://127.0.0.1:8000/test/export-browser.test.html` in Chrome. It exercises both export buttons with fake storage and checks that notes survive while credentials do not. Serve over HTTP; file URLs do not reliably execute this module-based test.

Retrieval UI smoke test: with the same server, open `http://127.0.0.1:8000/test/retrieval-browser.test.html`. It runs the real comment-card and side-panel code with fake Chrome APIs and OpenRouter replies and checks that the first call is the small selector, phase labels, locked/unlocked composers, hidden selection output and source links. It is not an installed-extension/live-model test.

Opt-in live check (spends OpenRouter credits): `OPENROUTER_API_KEY=sk-or-… node test/live-retrieval.mjs`, optionally with `MODEL=` / `SMALL_MODEL=`. Synthetic definition/comparison/irrelevant-match cases report which threads the selector loaded, call durations, provider usage and actual answers. A passing selection check is not proof of answer quality: inspect the comparisons and citations. It uses the default models unless overridden.

## Data safety
- Threads send only the highlighted passage, its enclosing paragraph/section/post (≤2,000 chars), the page title, and the page summary if you made one. The full page is sent only to summarise it: when you press Summarise, ask in the page Q&A thread, or press "Share page and retry" on a reply that needed it.
- After a thread's first reply, a second small call sends the same passage and thread to the same model to name 3–5 concepts it's about (plus the list of concepts you already use, so it reuses them). Threads on different pages that share a concept show up under "Related threads" on the comment card. Threads from before this feature are tagged the first time a card asks for related threads. All threads → Graph draws every thread as a dot, linked to the threads it shares a concept with; hovering one shows what it links to and why.
- **On-demand cross-page context.** Before a reply, Margin finds up to five candidate threads from other pages: shared concepts plus word overlap with the passage, question and recent conversation. A call to the small model sees a short index of them (title, concepts, ~100-char hints of the passage, question, takeaway and last AI reply) and returns `{"ids":[...]}`: at most two threads, or none. Margin then reads those threads fresh and sends them to the answering model, with source passages, reader-approved takeaways and unverified prior AI answers labelled separately. The UI shows "Finding relevant context…" then "Answering…". Citations like [R1] become ↗ links to the original passage; a citation to a thread that wasn't loaded is left as plain text. An invalid selection fails visibly and can be retried. With no candidates there is no extra call. Trade-off: whenever candidates exist, a reply costs two model calls instead of one.
- The candidate index is capped at 3,000 UTF-8 bytes, and loaded cross-page context at 6,000 bytes including JSON escaping (size bounds, not token counts or a total-prompt limit). Truncation is marked. Retrieved excerpts and the selection output are not saved; only the final answer and its citation links are. Deleting a loaded source or the current page/thread cancels the pending reply locally; it cannot retract what was already sent to the provider.
- "Related threads" on the comment card still lists threads sharing a concept; the word-overlap matching is only used to find candidates for replies.
- Every page save and delete is also copied to `~/Library/Application Support/Margin/notes.db` (SQLite, table `pages(key, json, updated_at)`) through the native host, so notes survive uninstalling the extension and are covered by Time Machine. It's best-effort: without the host installed, Margin works as before and nothing is copied. Deleting in Margin deletes the copy too. Search it with e.g. `sqlite3 notes.db "select key from pages where json like '%term%'"`.
- JSON exports use `{version: 1, pages: [...]}` and include notes, conversations, summaries and article snapshots—not settings or API keys. Previously exported files may contain keys; revoke/rotate those keys if a file was shared.
- Only one AI reply per thread (or page summary) runs at a time; different threads can run concurrently.
- Deleting a page or all data invalidates outstanding replies, so late completions cannot recreate deleted records or alter a new request. This suppresses local results; it does not cancel or refund the OpenRouter call.
- Interrupted or output-limited API streams report an error and are not saved as complete answers. The original question remains available for retry.
