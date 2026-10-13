# On-demand reading-thread context

Approved scope: replace automatic cross-page excerpt injection for Claude CLI with a bounded answer-or-read protocol. Base: concepts PR #5, dbacfed29641f0864189f367a5b75dd399df2689. Separate stacked PR; do not merge either branch.

## Behavior and boundaries
- Reuse existing relatedFor candidate discovery (at most five candidates).
- CLI receives bounded candidate metadata, never prior AI answers before requesting them.
- First CLI result is strict JSON: {"action":"answer","text":"..."} or {"action":"read","ids":["R1"]}. Validate all fields and IDs; malformed results fail visibly, never execute arbitrary operations.
- At most two unique shortlist IDs and one retrieval round. Fetch fresh records only from the shortlist's exact page/thread identities. No shell, filesystem or MCP access.
- Loaded context labels original passage, reader-approved resolved takeaway, open question, and prior AI answer separately. Truncation is explicit. UTF-8 serialized context cap: 6,000 bytes (a conservative size bound, not an exact token count). Candidate index cap: 3,000 bytes.
- Final answer cites loaded references. Store only final answer and citation metadata, not control output or retrieved excerpts. Show retrieval status in existing UI; links remain.
- No candidates: ordinary reply path, no extra decision call. API-provider behavior stays unchanged for this CLI-first experiment.
- Missing requested record: visible retryable failure, not an invented comparison. Deleting current or loaded source thread/page cancels the dependent request. Locks, pending and phase flags must clear without affecting new requests.
- No Jev, concept synthesis, fuzzy matching, OAuth, new dependencies or automatic question resolution.

## Implementation
Pure retrieval.js owns index formatting, protocol validation, budgeted content formatting and orchestration. background.js owns lookup, request lifetime and storage writes. providers.js adds no general tool capabilities. content.js / sidepanel.js display a phase flag beside existing pending state.

## Commands and style
ES modules and plain JavaScript, no build step; follow existing compact functions. Tests use node:assert and fake Chrome storage/native messaging only at boundaries.
- Focused: node test/retrieval.test.mjs; node test/retrieval-background.test.mjs
- Full: for t in test/*.test.mjs; do node "$t" || exit; done
- Host: python3 native-host/test_host.py; python3 native-host/test_mirror.py
- Syntax: node --check retrieval.js; node --check background.js; node --check content.js; node --check sidepanel.js

## Acceptance
Direct response without source loading; requested source included and cited; metadata IDs cannot authorize arbitrary records; content/index caps hold with Unicode; missing/deleted records and malformed protocol fail safely; no partial control output in UI; current/source deletion and recreation cannot persist a late answer; unchanged API behavior remains tested.

## Verification boundaries
Offline tests establish control flow, budgets, serialization and lifecycle safety, not model selection accuracy or prompt-injection immunity. Live Claude CLI tests and installed-extension browser tests require a logged-in local Claude installation/native host. Record unavailable prerequisites rather than fabricate results. Live quality/latency/token comparisons are pending unless actually executed.
