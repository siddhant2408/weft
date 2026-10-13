# Related threads

Before each reply, Margin looks for threads you wrote on other pages that would help answer the current question, and sends up to three of them to the answering model. This page describes how they are found, what each step sees, and what reaches the model.

## The pipeline

```
tag the thread ─▶ shortlist (≤10, shared tag) ─▶ Jev scores each ─▶ top 3 ≥ 0.4 ─▶ re-read fresh ─▶ inject
```

### 0. Tags

A thread is tagged from its first question, before its first reply (`tagThread` in `background.js`). The small model names 2–4 concepts the question is about, reusing existing tags where it can (`CONCEPTS_SYS`). Tags are what connect threads. Without them a thread has no related threads. Page Q&A threads are never tagged, so they get none.

A highlight doesn't need a conversation. **Keep** (the bookmark on a new comment card) saves the highlight with no messages and tags it from the passage itself. A note on an untagged thread tags it from the passage and the note. Either way, the highlight can later be found and sent with replies on other pages, like any thread.

### 1. Shortlist (code, no model)

`findCandidates` in `thread-index.js`:

- Keeps threads on **other pages** that share at least one tag with the current thread.
- Ranks them by `4 × shared tags` plus a weighted word overlap. Words from the question count 3×, from recent messages 2×, and from the passage and context 1×. Words that are rare among the tag-sharing threads score higher.
- Keeps the top **10**.

The word overlap compares against each candidate's **whole** text: page title, passage, context, tags, approved takeaway and every message. It treats that text as a bag of words.

### 2. Scoring (Jev)

`pickRelated` in `retrieval.js` sends each candidate to TypeSafe's Jev model as a separate request, all in parallel. The request is one yes/no question (`HELPS`): *would bringing this candidate into the answer materially improve it?* Jev returns the probability of yes.

Each request holds a short summary of both sides (`judgeState`):

| Current thread | Candidate thread |
|---|---|
| passage (1,500 chars) | page title (100) |
| surrounding context (500) | passage (600) |
| latest question (1,000) | approved takeaway, if resolved (300) |
| last 3 messages (500 each) | its latest question (400) |
| | its latest AI answer (600) |

It also gets the candidate's notes (400) and, for a highlight kept without comment, a line saying so.

Jev never sees a candidate's surrounding context, earlier messages or tags. It judges from what was highlighted, what was last asked and what the AI last answered. As a result, a thread whose useful conclusion sits in an earlier message, and that has no takeaway, can score lower than it should.

### 3. Pick

- Candidates scoring at least **`MIN_NOUL` (0.4)** are kept, best first, up to **3**. They get the refs `R1`–`R3` in that order.
- Jev may keep none. Then the reply has no related context.
- **Fallback:** with no TypeSafe key, or if any Jev call fails, the shortlist's top 3 are used. A reply never fails because of Jev.

### 4. Inject

The picked threads are re-read from storage, so they are current, and formatted by `loadedContext` into a `<related_threads>` block next to the reader notes:

| Field | What | Cap |
|---|---|---|
| `ref` | R1–R3, the id the model cites | — |
| `title` | the other page's title | 100 chars |
| `Source passage` | the highlighted text | 1,200 chars |
| `Surrounding context` | the paragraph around it | 600 chars |
| `Reader-approved takeaway` | only if that thread is resolved | 500 chars |
| `Open question` | only if open: its last question | 500 chars |
| `Recent conversation excerpts` | the last 4 messages, labelled "Reader question", "Reader note" or "Prior AI answer (not verified evidence)" | 800 chars each |
| `Kept highlight` | instead of the conversation, for a highlight kept without comment | — |

Each thread is capped at 2,900 bytes: the longest field is halved until it fits, and the cut is marked `… [truncated]`. The whole block stays under `CONTEXT_BYTES` (9,000). Not included: messages older than the last 4, tags, and the other page's article, summary and reader notes.

If a picked thread was deleted in the meantime, the reply fails with `SOURCE_MISSING` and can be retried.

## What the model does with them

`READER_SYS` tells the model to use a related thread only when it helps, to cite it inline as `[R1]`, and to ignore unhelpful ones silently. So a thread can be injected and not cited. Citations become ↗ links to the original passage (`citedRefs`, stored as `refs` on the message). A citation to a thread that wasn't loaded stays plain text.

## The comment card

Each reply stores which threads it was given, as `{urlKey, id}` pairs in `related` on the message, with no excerpts or scores. "Related threads" on the card lists those for the latest reply, read fresh (`connections` in `graph.js`). Each reply runs the pipeline again, so the list can change from one reply to the next. Replies from before this was stored fall back to threads sharing a tag.

## Tuning

- `MIN_NOUL` was set from 12 synthetic pairs, where every helpful pair scored ≥ 0.47 and every unhelpful one ≤ 0.34. Check it against your own threads:
  ```sh
  TYPESAFE_API_KEY=… node test/eval-related.mjs margin-export.json                       # writes related-labels.json
  TYPESAFE_API_KEY=… node test/eval-related.mjs margin-export.json related-labels.json   # after marking each "helps"
  ```
- Constants: shortlist size `max` in `findCandidates` (10); `MAX_RELATED` (3), `MIN_NOUL` (0.4) and `CONTEXT_BYTES` (9,000) in `retrieval.js`.

What is sent to TypeSafe and the model, and what is stored: [privacy.md](privacy.md).
