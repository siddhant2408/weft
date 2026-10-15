# Related threads

Before each reply, Margin looks for threads you wrote on other pages that would help answer the current question, and sends up to three of them to the answering model. This page describes how they are found, what each step sees, and what reaches the model.

## The pipeline

```
tag the thread ─▶ shortlist (≤20, shared tag) ─▶ Jev scores all in one request ─▶ top 3 ≥ 0.75 ─▶ re-read fresh ─▶ inject
```

### 0. Tags

A thread is tagged from its first question, before its first reply (`tagThread` in `background.js`). The small model names 3–5 tags the question is about, reusing existing tags where it can (`CONCEPTS_SYS`): 1 or 2 specific ones (`MVCC`, `Holland Park`) and 2 or 3 broader subjects one step up (`Databases`, `London parks`, `Plant protein`), never the kind of request (`Recipes`) and never so broad they match everything (`Travel`). Tags are what connect threads. Without them a thread has no related threads. Page Q&A threads are never tagged, so they get none.

Tags are generous on purpose: they decide which threads *can* be considered (recall), and Jev decides which ones help this question (precision). A thread missing from the shortlist can't be recovered later; a weak one is dropped by Jev or ignored by the answering model.

**Tags follow the conversation, at no extra call.** Every reply on a passage thread is sent with the thread's current tags and the known tags (`tagsNote`). When the latest message moves to a topic those don't cover, the answering model adds a last line `[[tags: Art museums | London]]`; Margin hides it while it streams, cuts it before saving (`replyTags` in `graph.js`) and adds the tags to the thread (`mergeTags`: only grows, no duplicates, at most 8). New tags count from the next reply on: this reply's related threads were picked before it was written.

A highlight doesn't need a conversation. **Save without asking** (the bookmark on a new comment card) saves the highlight without calling the answering model. With the box empty it is a kept highlight, tagged from the passage itself. With text typed, the text is saved as a note, and the highlight is tagged from the passage and the note, so the note steers which later questions it matches. Either way, the highlight can later be found and sent with replies on other pages, like any thread. (There is no separate note mode any more. Notes saved before this change still display and are used.)

### 1. Shortlist (code, no model)

`findCandidates` in `thread-index.js`:

- Keeps threads on **other pages** that share at least one tag with the current thread.
- Ranks them by `4 × shared tags` plus a weighted word overlap. Words from the question count 3×, from recent messages 2×, and from the passage and context 1×. Words that are rare among the tag-sharing threads score higher.
- Keeps the top **20**. Broad tags bring in more threads than this; ranking puts the ones that also share a specific tag first.

The word overlap compares against each candidate's **whole** text: page title, passage, context, tags, approved takeaway and every message. It treats that text as a bag of words.

### 2. Scoring (Jev)

`pickRelated` in `retrieval.js` sends the whole shortlist to TypeSafe's Jev model in **one request**. The request asks one Score question per candidate (`helps(i)`, pointing at `candidates[i]`): *how much would bringing this candidate into the answer improve it?* Each Score has three levels (`HELPS_LEVELS`): 0 does not help (only shares a topic, the passage alone answers it, or the reader asked not to bring in other material), 1 useful background, 2 bears directly on the question. Jev answers each question on its own and returns a score from 0 to 2, the level numbers weighted by their probabilities.

The request holds a short summary of the current thread and of every candidate (`judgeState`):

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

- Candidates scoring at least **`MIN_SCORE` (0.75, a little under useful background)** are kept, best first, up to **3**. They get the refs `R1`–`R3` in that order.
- Jev may keep none. Then the reply has no related context.
- **Key:** Settings → Related threads picks the OpenRouter connection (same API at `openrouter.ai/api/v1/systemone`, model `~typesafe/jev-latest`, paid from OpenRouter credits) or, under Advanced, a TypeSafe key. Older settings with a TypeSafe key and no choice keep TypeSafe.
- **Fallback:** without the chosen key, or if the Jev call fails or leaves a candidate unscored, the shortlist's top 3 are used. A reply never fails because of Jev.
- **Why not the ChatGPT model as the judge?** Tried and dropped (Oct 2026). Plan usage returns only the chosen token's logprob (no `top_logprobs`), which is enough for a yes/no: P(yes) = e^logprob after "yes", 1 − e^logprob after "no". On the same 43 real pairs, run twice: Jev's scores moved 0.04 on average (1 flip across the cut-off); Luna answering every candidate in one call moved 0.38 (12 flips), because each answer after the first is conditioned on words already sampled; one call per candidate, with the answer as the first token, moved 0.13 (3 flips) at one call per candidate, and agreed with Jev's picks in 2 of 12 replies. So without a key, the shortlist's top 3 it is.

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

Each thread is capped at 2,900 bytes: the longest field is halved until it fits, and the cut is marked `… [truncated]`. The whole block stays under `CONTEXT_BYTES` (9,000) only because 3 × 2,900 fits: nothing enforces it at runtime (a test checks it), so raising `MAX_RELATED` grows the block past it. Not included: messages older than the last 4, tags, and the other page's article, summary and reader notes.

If a picked thread was deleted in the meantime, the reply fails with `SOURCE_MISSING` and can be retried.

## What the model does with them

`READER_SYS` tells the model to use a related thread only when it helps, to cite it inline as `[R1]`, and to ignore unhelpful ones silently. So a thread can be injected and not cited. Citations become ↗ links to the original passage (`citedRefs`, stored as `refs` on the message). A citation to a thread that wasn't loaded stays plain text.

## The comment card

Each reply stores which threads it was given, as `{urlKey, id}` pairs in `related` on the message, with no excerpts or scores. "Related threads" on the card lists those for the latest reply, read fresh (`connections` in `graph.js`). Each reply runs the pipeline again, so the list can change from one reply to the next. Replies from before this was stored fall back to threads sharing a tag.

## Tuning

- `MIN_SCORE` (0.75) was lowered from 1 by eye (Oct 2026): on 33 real pairs, 7 scored 0.8–1.0, so a cut at 1 flipped from run to run (a Holland Park highlight scored 1.01 in the eval and just under 1 in the real reply). A missed thread loses the memory; an extra one costs input and is ignored by the answering model. It is not yet set on labels. Check it against the synthetic pairs (`node test/eval-related.mjs` with no file) and your own threads:
  ```sh
  TYPESAFE_API_KEY=… node test/eval-related.mjs margin-export.json                       # writes related-labels.json
  TYPESAFE_API_KEY=… node test/eval-related.mjs margin-export.json related-labels.json   # after marking each "helps"
  ```
- Constants: shortlist size `max` in `findCandidates` (20); `MAX_TAGS` (8) in `graph.js`; `MAX_RELATED` (3), `MIN_SCORE` (0.75) and `CONTEXT_BYTES` (9,000) in `retrieval.js`.

What is sent to TypeSafe and the model, and what is stored: [privacy.md](privacy.md).
