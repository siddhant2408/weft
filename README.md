# Margin

Comment threads on anything you read, where the replies come from AI. Spec: Notion → Tech → "Margin — … Technical Specification".

## Setup (macOS)
1. `./native-host/install.sh` registers the native host (extension ID is pinned by `key` in manifest.json).
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. Default model is Claude Code (`~/.local/bin/claude`, logged in). Or Settings → Model: Anthropic API key, or any OpenAI-compatible API (OpenRouter, OpenAI, Ollama, LM Studio).

## Checks
- `for t in test/*.test.mjs; do node $t; done` and `test/run-anchor.sh` (plus `test/run-anchor.sh item.test.html` for highlight context): unit + anchoring tests.
- `python3 native-host/test_host.py`: host round-trip, prompt-injection (no tools), bad request.
- `python3 native-host/test_mirror.py`: SQLite mirror save/overwrite/delete (no Claude needed).
- Host log: `~/Library/Logs/margin-host.log` (no prompt text).

Browser export smoke test: serve this folder with `python3 -m http.server 8000 --bind 127.0.0.1`, then open `http://127.0.0.1:8000/test/export-browser.test.html` in Chrome. It exercises both export buttons with fake storage and checks that notes survive while credentials do not. Serve over HTTP; file URLs do not reliably execute this module-based test.

## Data safety
- Threads send only the highlighted passage, its enclosing paragraph/section/post (≤2,000 chars), the page title, and the page summary if you made one. The full page is sent only to summarise it: when you press Summarise, ask in the page Q&A thread, or press "Share page and retry" on a reply that needed it.
- After a thread's first reply, a second small call sends the same passage and thread to the same model to name 3–5 concepts it's about (plus the list of concepts you already use, so it reuses them). Threads on different pages that share a concept show up under "Related threads" on the comment card. Threads from before this feature are tagged the first time a card asks for related threads. All threads → Graph draws every thread as a dot, linked to the threads it shares a concept with; hovering one shows what it links to and why.
- **Claude CLI: on-demand cross-page context.** A reply receives a small index of up to five concept-matched threads (title, concepts and a short question/takeaway description), not their passages or prior AI replies. It can answer directly or request at most two indexed threads. Margin reads fresh records, then makes one final CLI call with bounded source/conversation excerpts. The UI shows "Checking a related thread…" and citations link to the original passage. There are no CLI tools, MCP servers, shell access, or additional providers. A malformed request fails visibly and can be retried. With no candidates, the ordinary single-call reply path is unchanged. This is an experiment: concept matching can miss relevant threads, and model selection accuracy/latency must be validated live.
- **API providers retain the existing behavior:** replies automatically receive up to five related excerpts: takeaway/open question, latest AI reply snippet, short passage snippet and source title. Citations appear as [R1] links. Extending on-demand retrieval to these providers is out of scope for this first version.
- The CLI candidate index is capped at 3,000 UTF-8 bytes, and loaded cross-page context at 6,000 bytes including JSON escaping (size bounds, not exact token counts). Excerpts explicitly mark truncation and distinguish source passages, reader-approved takeaways and unverified prior AI answers. The current conversation, page summary and same-page reader notes have their own existing behavior; these caps are not a total-prompt limit. Retrieved excerpts and control responses are not copied into saved conversation history; only the final answer and citation metadata are saved. Deleting a loaded source or the current page/thread cancels the pending reply locally; it cannot retract content already sent to the provider.
- Every page save and delete is also copied to `~/Library/Application Support/Margin/notes.db` (SQLite, table `pages(key, json, updated_at)`) through the native host, so notes survive uninstalling the extension and are covered by Time Machine. It's best-effort: without the host installed, Margin works as before and nothing is copied. Deleting in Margin deletes the copy too. Search it with e.g. `sqlite3 notes.db "select key from pages where json like '%term%'"`.
- JSON exports use `{version: 1, pages: [...]}` and include notes, conversations, summaries and article snapshots—not provider settings or API keys. Previously exported files may contain keys; revoke/rotate those keys if a file was shared.
- Only one AI reply per thread (or page summary) runs at a time; different threads can run concurrently.
- Deleting a page or all data invalidates outstanding replies, so late completions cannot recreate deleted records or alter a new request. This suppresses local results; it does not guarantee cancellation or a refund from the provider.
- Interrupted or output-limited API streams report an error and are not saved as complete answers. The original question remains available for retry.
