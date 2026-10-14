# On-demand reading-thread context

Scope: replace automatic cross-page excerpt injection with shortlist → score → inject, Model calls go through OpenRouter or Sign in with ChatGPT (Claude CLI, direct Anthropic and other OpenAI-compatible providers removed). Base: main (after #5).

## Behavior and boundaries
- A thread is tagged from its first question, before its first reply. thread-index.js projects current records into an index; findCandidates keeps threads from other pages sharing at least one tag, at most ten, ranked by weighted word overlap.
- Jev (TypeSafe, `jev-latest`) scores the whole shortlist in one request: the current thread and every candidate in one state, one Score question per candidate (0 does not help, 1 useful background, 2 bears directly), answered independently. The top three at or above MIN_SCORE (1) are injected, or none. No TypeSafe key, a failed call or an unscored candidate: the shortlist's top three. Jev returns only numbers; it never selects by text or executes operations.
- One retrieval round. Fetch fresh records only for the shortlist's exact page/thread identities. No shell, filesystem or MCP access.
- Loaded context labels original passage, reader-approved resolved takeaway, open question, and prior AI answer separately. Truncation is explicit. UTF-8 serialized context cap: 9,000 bytes (three threads) (a size bound, not a token count).
- The answering model cites loaded references as [Rn]; unknown citations stay as plain text without a link. Store only the final answer, citation metadata and the identities of the threads it was given, never scores or retrieved excerpts. UI shows "Finding relevant context…" then "Answering…".
- No candidates: ordinary reply path, no Jev call. Comment-card "Related threads" lists the threads the latest reply was given, read fresh (graph.js connections); older replies fall back to shared concepts. Page Q&A has no tags, so no related threads.
- Missing requested record: visible retryable failure. Deleting the current or a loaded source thread/page cancels the dependent request. Locks, pending and phase flags must clear without affecting new requests.
- No concept synthesis, fuzzy matching, OAuth, new dependencies or automatic question resolution.

## Implementation
Pure retrieval.js owns the Jev question and state, picking, budgeted content formatting and orchestration. background.js owns lookup, request lifetime and storage writes. providers.js streams OpenRouter Chat Completions or the ChatGPT-plan Responses API (auth in chatgpt.js; tokens in the extension origin's IndexedDB, out of content scripts' reach), each with a main and a small model; no tools. providers.js `judge` posts to TypeSafe's System One API (no SDK). content.js / sidepanel.js display a phase flag beside existing pending state.

## Commands and style
ES modules and plain JavaScript, no build step; follow existing compact functions. Tests use node:assert and fake Chrome storage/native messaging only at boundaries.
- Focused: node test/retrieval.test.mjs; node test/retrieval-background.test.mjs
- Full: for t in test/*.test.mjs; do node "$t" || exit; done
- Host (SQLite mirror only): python3 native-host/test_mirror.py
- Syntax: node --check retrieval.js; node --check background.js; node --check content.js; node --check sidepanel.js

## Acceptance
Jev rejecting all gives a plain answer; picked sources included, best first, and cited; no key or a failed Jev call falls back to the shortlist; content caps hold with Unicode; missing/deleted records fail safely; the card lists what the reply was given; current/source deletion and recreation cannot persist a late answer; small jobs use the small model.

## Verification boundaries
Offline tests establish control flow, budgets, serialization and lifecycle safety, not model selection accuracy or prompt-injection immunity. Live tests need a TypeSafe key (test/eval-related.mjs, which also tunes MIN_SCORE); installed-extension tests need the loaded extension. Record unavailable prerequisites rather than fabricate results. Live quality/latency/token comparisons are pending unless actually executed.
