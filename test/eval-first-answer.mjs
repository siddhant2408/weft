// Opt-in eval: how often does a thread's first answer miss related threads that later messages would get? Spends API credits (small model only).
// Run: OPENROUTER_API_KEY=sk-or-… node test/eval-first-answer.mjs margin-export.json > first-answer.md
//   provider and model env vars: see test/eval-env.mjs.  LIMIT=40  how many tagged threads, newest first.
// For each tagged thread, its first question is replayed against every other thread in the export:
//   first = findCandidates without the thread's own concepts (what the first answer sees: it's tagged after replying)
//   later = findCandidates with them (what every later message sees)
// When the sets differ, the real selector picks from `later`. A pick outside `first` is useful context the first answer missed.
// ponytail: the index is today's export, including threads written after this one; it measures "asked now", not history.
import { readFileSync } from 'node:fs';
import { buildIndex, findCandidates, threadKey } from '../thread-index.js';
import { selectContext } from '../retrieval.js';
import { env, ask, FATAL } from './eval-env.mjs';
const file = process.argv[2];
if (!file) { console.error('Usage: OPENROUTER_API_KEY=… node test/eval-first-answer.mjs <export.json>'); process.exit(1); }

const { pages } = JSON.parse(readFileSync(file, 'utf8'));
const index = buildIndex(pages);
const items = pages.flatMap((page) => page.highlights.filter((h) => h.concepts?.length && h.messages.some((m) => m.role === 'user')).map((h) => ({page, h})))
  .sort((a, b) => (b.h.createdAt || '').localeCompare(a.h.createdAt || '')).slice(0, Number(env.LIMIT) || 40);
const cell = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const label = (c) => cell(clip(`${c.title || c.urlKey}: ${c.question || c.exact}`, 90));

let differed = 0, missed = 0, failed = 0;
console.log(`# First-answer context eval: ${items.length} tagged threads\n`);
for (const {page, h} of items) {
  const upTo = h.messages.slice(0, h.messages.findIndex((m) => m.role === 'user') + 1);  // the thread as of its first question
  const query = {urlKey: page.urlKey, id: h.id, passage: h.exact || '', context: h.context || '',
    question: upTo.at(-1).content, recent: upTo.slice(-4, -1), concepts: []};
  const first = findCandidates(index, query), later = findCandidates(index, {...query, concepts: h.concepts});
  const inFirst = new Set(first.map((c) => threadKey(c.urlKey, c.id)));
  const added = later.filter((c) => !inFirst.has(threadKey(c.urlKey, c.id)));
  if (!added.length) continue;
  differed++;
  const res = await selectContext({query, candidates: later, ask});
  if (!res.ok && FATAL.includes(res.code)) { console.error(res); process.exit(1); }
  if (!res.ok) { failed++; continue; }
  const lost = res.ids.map((ref) => later[Number(ref.slice(1)) - 1]).filter((c) => !inFirst.has(threadKey(c.urlKey, c.id)));
  if (lost.length) missed++;
  console.log(`## ${cell(clip(page.title || page.urlKey, 80))}${lost.length ? ' — missed' : ''}\n\n> ${cell(clip(h.exact || '', 200))}\n\n**Q:** ${cell(clip(query.question, 200))}\n\n**Tags:** ${h.concepts.join(', ')}\n`);
  console.log('| | thread | via |\n|---|---|---|');
  for (const c of added) console.log(`| ${lost.includes(c) ? 'missed (selector picked it)' : 'new candidate'} | ${label(c)} | ${cell(c.shared.join(', '))} |`);
  console.log();
}
const pct = (n) => (items.length ? Math.round((100 * n) / items.length) : 0);
console.log('## Summary\n\n| tagged threads | tags changed the candidates | first answer missed useful context | selector failed |\n|---|---|---|---|');
console.log(`| ${items.length} | ${differed} (${pct(differed)}%) | ${missed} (${pct(missed)}%) | ${failed} |`);
