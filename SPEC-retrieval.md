# On-demand reading-thread context

Scope: replace automatic cross-page excerpt injection with index → select → inject, Model calls go through OpenRouter only (Claude CLI, direct Anthropic and other OpenAI-compatible providers removed). Base: main (after #5).

## Behavior and boundaries
- thread-index.js projects current records into an index; findCandidates picks at most five threads from other pages by shared concepts plus weighted word overlap.
- A separate small-model selector call sees a bounded index (≤3,000 bytes; ~100-char hints including the last AI reply) and the bounded query, and returns strict JSON {"ids":[...]}: at most two distinct shortlist IDs, or none. Any other shape fails visibly as SELECTION_INVALID; it never executes operations.
- One retrieval round. Fetch fresh records only for the shortlist's exact page/thread identities. No shell, filesystem or MCP access.
- Loaded context labels original passage, reader-approved resolved takeaway, open question, and prior AI answer separately. Truncation is explicit. UTF-8 serialized context cap: 6,000 bytes (a size bound, not a token count).
- The answering model cites loaded references as [Rn]; unknown citations stay as plain text without a link. Store only the final answer and citation metadata, never selection output or retrieved excerpts. UI shows "Finding relevant context…" then "Answering…".
- No candidates: ordinary reply path, no selector call. Comment-card "Related threads" stays concept-only (graph.js connections).
- Missing requested record: visible retryable failure. Deleting the current or a loaded source thread/page cancels the dependent request. Locks, pending and phase flags must clear without affecting new requests.
- No concept synthesis, fuzzy matching, OAuth, new dependencies or automatic question resolution.

## Implementation
Pure retrieval.js owns index formatting, selection validation, budgeted content formatting and orchestration. background.js owns lookup, request lifetime and storage writes. providers.js is a single OpenRouter Chat Completions client with a main and a small model; no tools. content.js / sidepanel.js display a phase flag beside existing pending state.

## Commands and style
ES modules and plain JavaScript, no build step; follow existing compact functions. Tests use node:assert and fake Chrome storage/native messaging only at boundaries.
- Focused: node test/retrieval.test.mjs; node test/retrieval-background.test.mjs
- Full: for t in test/*.test.mjs; do node "$t" || exit; done
- Host (SQLite mirror only): python3 native-host/test_mirror.py
- Syntax: node --check retrieval.js; node --check background.js; node --check content.js; node --check sidepanel.js

## Acceptance
Selector picking none gives a plain answer; selected source included and cited; IDs cannot authorize arbitrary records; content/index caps hold with Unicode; missing/deleted records and malformed selection fail safely; no selection output in UI; current/source deletion and recreation cannot persist a late answer; small jobs use the small model.

## Verification boundaries
Offline tests establish control flow, budgets, serialization and lifecycle safety, not model selection accuracy or prompt-injection immunity. Live tests need an OpenRouter key (test/live-retrieval.mjs); installed-extension tests need the loaded extension. Record unavailable prerequisites rather than fabricate results. Live quality/latency/token comparisons are pending unless actually executed.
