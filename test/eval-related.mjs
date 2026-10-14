// Opt-in eval for picking related threads: Jev's score (0-2) on labelled (current thread, candidate) pairs, and how each
// cut-off would do. Spends TypeSafe credits (one call per current thread, scoring all its candidates, as in replies). No Chrome or extension storage required.
//   TYPESAFE_API_KEY=… node test/eval-related.mjs                      built-in synthetic pairs
//   TYPESAFE_API_KEY=… node test/eval-related.mjs export.json          real threads: scores each tagged thread's shortlist
//     and writes related-labels.json; set each "helps" to true/false, then
//   TYPESAFE_API_KEY=… node test/eval-related.mjs export.json related-labels.json   scores the labelled pairs
//   LIMIT=15  how many tagged threads, newest first (export mode)
import { readFileSync, writeFileSync } from 'node:fs';
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error('Set TYPESAFE_API_KEY'); process.exit(1); }
globalThis.chrome = { storage: { local: { get: async () => ({ settings: { typesafe: { apiKey } } }) } } };
const { judge } = await import('../providers.js');
const { scoreRelated, MIN_SCORE } = await import('../retrieval.js');
const { buildIndex, findCandidates, threadKey } = await import('../thread-index.js');

const thread = (title, exact, question, lastAnswer = '', approvedTakeaway = '') => ({ title, exact, question, lastAnswer, approvedTakeaway });
const SYNTHETIC = [
  [{ passage: 'Postgres keeps old row versions until no transaction can see them.', question: 'Why would a long report query make the table bloat?' },
    thread('Postgres MVCC', 'VACUUM reclaims dead tuples once no snapshot needs them.', 'Why does vacuum stall?', 'An old open snapshot pins dead tuples, so vacuum cannot remove them.', 'Long-running readers block vacuum.'), true],
  [{ passage: 'MVCC lets readers see a consistent snapshot.', question: 'What does MVCC stand for?' },
    thread('Postgres MVCC', 'VACUUM reclaims dead tuples once no snapshot needs them.', 'Why does vacuum stall?', 'An old open snapshot pins dead tuples.'), false],
  [{ passage: 'CRDTs merge concurrent edits without coordination.', question: 'How is this different from what Google Docs does?' },
    thread('Operational transforms', 'Google Docs uses operational transformation with a central server ordering edits.', 'Why does OT need a server?', 'OT transforms each op against concurrent ones; a server gives a single order.'), true],
  [{ passage: 'CRDTs merge concurrent edits without coordination.', question: 'Explain this sentence. Do not bring in other articles.' },
    thread('Operational transforms', 'Google Docs uses operational transformation.', 'Why does OT need a server?', 'A server gives a single order.'), false],
  [{ passage: 'Raft elects a leader with randomized election timeouts.', question: 'Why randomize the timeouts?' },
    thread('Paxos made simple', 'Proposers can duel forever if they keep pre-empting each other.', 'How does Paxos avoid livelock?', 'It does not guarantee progress; implementations add a distinguished proposer and random backoff.'), true],
  [{ passage: 'Raft elects a leader with randomized election timeouts.', question: 'Why randomize the timeouts?' },
    thread('Kubernetes leases', 'A lease object records the current holder and renew time.', 'What happens when the API server is down?', 'Holders cannot renew, so leadership lapses after the lease duration.'), false],
  [{ passage: 'Index-only scans skip the heap when the visibility map says a page is all-visible.', question: 'Why did my index-only scan still hit the heap?' },
    thread('Postgres MVCC', 'VACUUM reclaims dead tuples and sets visibility map bits.', 'What else does vacuum do?', 'It also marks pages all-visible in the visibility map, which index-only scans rely on.'), true],
  [{ passage: 'Rust moves values by default; a moved-from variable cannot be used.', question: 'Why does this compile when I pass an i32?' },
    thread('C++ move semantics', 'std::move casts to an rvalue reference; the source is left valid but unspecified.', 'Is the source empty after a move?', 'Not necessarily; it is valid but unspecified.'), false],
  [{ passage: 'Rust moves values by default; a moved-from variable cannot be used.', question: 'How does this compare with C++ moves, which I looked at before?' },
    thread('C++ move semantics', 'std::move casts to an rvalue reference; the source is left valid but unspecified.', 'Is the source empty after a move?', 'Not necessarily; it is valid but unspecified.', 'C++ moved-from objects stay usable.'), true],
  [{ passage: 'Transformers use attention to weigh tokens.', question: 'Why is attention quadratic in sequence length?' },
    thread('FlashAttention', 'FlashAttention tiles the attention matrix to stay in SRAM.', 'Does FlashAttention change the complexity?', 'No: still O(n²) compute, but far less memory traffic.'), true],
  [{ passage: 'Transformers use attention to weigh tokens.', question: 'Who wrote the original transformer paper?' },
    thread('FlashAttention', 'FlashAttention tiles the attention matrix to stay in SRAM.', 'Does FlashAttention change the complexity?', 'No: still O(n²) compute.'), false],
  [{ passage: 'Bloom filters can return false positives but never false negatives.', question: 'Could I use this to skip disk reads in my LSM tree?' },
    thread('LSM trees', 'Each SSTable lookup may need a disk read.', 'Why are LSM point reads slow?', 'A key may be in any level, so a read can probe several SSTables.', 'Point reads probe many SSTables.'), true],
].map(([current, candidate, helps], i) => ({ name: `synthetic ${i + 1}`, query: { context: '', recent: [], ...current }, candidate, helps }));

const [exportFile, labelsFile] = process.argv.slice(2);
let pairs = SYNTHETIC;
if (exportFile) {
  const { pages } = JSON.parse(readFileSync(exportFile, 'utf8'));
  const index = buildIndex(pages), byKey = new Map(index.map((e) => [threadKey(e.urlKey, e.id), e]));
  const queryFor = (e) => { const h = pages.find((p) => p.urlKey === e.urlKey).highlights.find((x) => x.id === e.id), m = h.messages || [];
    const q = m.filter((x) => x.role === 'user').at(-1);
    return { urlKey: e.urlKey, id: e.id, passage: e.exact, context: e.context, concepts: e.concepts, question: q?.content || '', recent: m.slice(0, m.lastIndexOf(q)).slice(-3) }; };
  if (labelsFile) {
    pairs = JSON.parse(readFileSync(labelsFile, 'utf8')).filter((l) => typeof l.helps === 'boolean' && byKey.has(l.thread) && byKey.has(l.candidate))
      .map((l) => ({ name: `${byKey.get(l.thread).title} → ${byKey.get(l.candidate).title}`, query: queryFor(byKey.get(l.thread)), candidate: byKey.get(l.candidate), helps: l.helps }));
  } else {
    const items = index.filter((e) => e.concepts.length && e.question).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, Number(process.env.LIMIT) || 15);
    pairs = items.flatMap((e) => findCandidates(index, queryFor(e)).map((c) => ({ name: `${e.title} → ${c.title}`, query: queryFor(e), candidate: c, helps: null,
      label: { thread: threadKey(e.urlKey, e.id), candidate: threadKey(c.urlKey, c.id), question: queryFor(e).question.slice(0, 160), candidate_question: c.question.slice(0, 160), helps: null } })));
  }
}

const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 90);
console.log(`# Related-thread eval: ${pairs.length} pairs\n\n| pair | question | candidate | helps | score |\n|---|---|---|---|---|`);
// Pairs with the same current thread share one request, as the extension scores a reply's whole shortlist at once.
for (const group of Map.groupBy(pairs, (p) => JSON.stringify(p.query)).values()) {
  const scores = await scoreRelated({ query: group[0].query, candidates: group.map((p) => p.candidate), judge });
  if (!scores) { console.error('Jev call failed (check the key)'); process.exit(1); }
  group.forEach((p, i) => { p.score = scores[i]; });
}
for (const p of pairs) console.log(`| ${cell(p.name)} | ${cell(p.query.question)} | ${cell(p.candidate.question || p.candidate.exact)} | ${p.helps ?? '?'} | ${p.score.toFixed(2)} |`);
if (pairs.some((p) => p.helps === null)) {
  writeFileSync('related-labels.json', JSON.stringify(pairs.map((p) => ({ ...p.label, score: Number(p.score.toFixed(2)) })), null, 2));
  console.log('\nWrote related-labels.json: set each "helps" to true or false, then rerun with it as the second argument.');
  process.exit(0);
}
console.log(`\n## Cut-offs (current: ${MIN_SCORE})\n\n| cut-off | precision | recall | wrongly injected | missed |\n|---|---|---|---|---|`);
for (const t of [0.5, 0.75, 1, 1.25, 1.5, 1.75]) {
  const tp = pairs.filter((p) => p.helps && p.score >= t).length, fp = pairs.filter((p) => !p.helps && p.score >= t).length;
  const pos = pairs.filter((p) => p.helps).length;
  console.log(`| ${t} | ${tp + fp ? Math.round((100 * tp) / (tp + fp)) + '%' : '—'} | ${pos ? Math.round((100 * tp) / pos) + '%' : '—'} | ${fp} | ${pos - tp} |`);
}
