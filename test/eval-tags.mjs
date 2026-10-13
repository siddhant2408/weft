// Opt-in tagging eval: re-tags real threads from a notes export and prints the tags side by side. Spends API credits.
// Run: OPENROUTER_API_KEY=sk-or-… node test/eval-tags.mjs margin-export.json > tags.md
//   provider and model env vars: see test/eval-env.mjs
//   MODEL=… SMALL_MODEL=…  the two models compared (both default to openrouter/free, which varies per call: set them)
//   ALT_PROMPT=file.txt     also runs both models with this system prompt in place of CONCEPTS_SYS
//   LIMIT=20                how many threads, newest first
// Each thread is tagged as production tags it: transcript up to its first reply, known concepts from every other thread.
import { readFileSync } from 'node:fs';
import { norm, parseConcepts, vocabulary } from '../graph.js';
import { env, models, ask, FATAL } from './eval-env.mjs';
const file = process.argv[2];
if (!file) { console.error('Usage: OPENROUTER_API_KEY=… node test/eval-tags.mjs <export.json>'); process.exit(1); }
const { CONCEPTS_SYS, conceptsPrompt } = await import('../background.js');

const { pages } = JSON.parse(readFileSync(file, 'utf8'));
const items = pages.flatMap((page) => page.highlights.filter((h) => h.messages.some((m) => m.role === 'assistant')).map((h) => ({page, h})))
  .sort((a, b) => (b.h.createdAt || '').localeCompare(a.h.createdAt || '')).slice(0, Number(env.LIMIT) || 20);

const variants = [{name: 'small', small: true, system: CONCEPTS_SYS}, {name: 'main', small: false, system: CONCEPTS_SYS}];
if (env.ALT_PROMPT) {
  const system = readFileSync(env.ALT_PROMPT, 'utf8');
  variants.push({name: 'small+alt', small: true, system}, {name: 'main+alt', small: false, system});
}
const stats = Object.fromEntries(['stored', ...variants.map((v) => v.name)].map((n) => [n, {tags: 0, reused: 0, labels: new Set(), failed: 0}]));
const count = (name, tags, known) => {
  const s = stats[name];
  s.tags += tags.length; s.reused += tags.filter((t) => known.has(norm(t))).length;
  for (const t of tags) s.labels.add(norm(t));
};
const cell = (s) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

console.log(`# Tag eval: ${items.length} threads, small=${models.smallModel || 'default'}, main=${models.model || 'default'}\n`);
for (const [i, {page, h}] of items.entries()) {
  // vocabulary as it would be without this thread's own tags (a fair stand-in for "at tag time")
  const known = vocabulary(pages.map((p) => ({...p, highlights: p.highlights.filter((x) => x !== h)})));
  const knownKeys = new Set(known.map(norm));
  const first = {...h, messages: h.messages.slice(0, h.messages.findIndex((m) => m.role === 'assistant') + 1)};
  const row = {stored: h.concepts || []};
  count('stored', row.stored, knownKeys);
  for (const v of variants) {
    const res = await ask({small: v.small, system: v.system,
      notes: known.length ? `<known_concepts>\n${known.join('\n')}\n</known_concepts>` : '', prompt: conceptsPrompt(first)});
    if (!res.ok && FATAL.includes(res.code)) { console.error(res); process.exit(1); }
    row[v.name] = res.ok ? parseConcepts(res.text) : [];
    if (!res.ok) stats[v.name].failed++;
    count(v.name, row[v.name], knownKeys);
  }
  const question = first.messages.find((m) => m.role === 'user')?.content || '(note only)';
  console.log(`## ${i + 1}. ${cell(clip(page.title || page.urlKey, 80))}\n\n> ${cell(clip(h.exact, 200))}\n\n**Q:** ${cell(clip(question, 200))}\n`);
  console.log('| variant | tags (★ = existing concept) |\n|---|---|');
  for (const [name, tags] of Object.entries(row)) console.log(`| ${name} | ${tags.map((t) => cell(t) + (knownKeys.has(norm(t)) ? ' ★' : '')).join(', ') || '—'} |`);
  console.log();
}
console.log('## Summary\n\n| variant | tags/thread | reused existing | distinct labels | failed calls |\n|---|---|---|---|---|');
for (const [name, s] of Object.entries(stats)) {
  console.log(`| ${name} | ${(s.tags / items.length || 0).toFixed(1)} | ${s.tags ? Math.round((100 * s.reused) / s.tags) : 0}% | ${s.labels.size} | ${s.failed} |`);
}
