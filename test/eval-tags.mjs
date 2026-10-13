// Opt-in tagging eval: re-tags real threads from a notes export and prints the tags side by side. Spends API credits.
// Run: OPENROUTER_API_KEY=sk-or-… node test/eval-tags.mjs margin-export.json > tags.md
//   or OPENAI_API_KEY=sk-… MODEL=gpt-… SMALL_MODEL=gpt-… (same Chat Completions request, sent to api.openai.com)
//   or CHATGPT_TOKEN=… MODEL=… SMALL_MODEL=… (your ChatGPT plan, as the extension's ChatGPT provider; MODELS=1 lists the plan's models).
//      Token: Margin's Settings page → DevTools console → copy((await (await import('./chatgpt.js')).accessToken()).token)
//      It expires (about an hour) and isn't refreshed here; copy a fresh one if calls fail with SIGNED_OUT.
//   MODEL=… SMALL_MODEL=…  the two models compared (both default to openrouter/free, which varies per call: set them)
//   ALT_PROMPT=file.txt     also runs both models with this system prompt in place of CONCEPTS_SYS
//   LIMIT=20                how many threads, newest first
// Each thread is tagged as production tags it: transcript up to its first reply, known concepts from every other thread.
import { readFileSync } from 'node:fs';
import { norm, parseConcepts, vocabulary } from '../graph.js';
const env = process.env, file = process.argv[2];
const token = env.CHATGPT_TOKEN, apiKey = env.OPENAI_API_KEY || env.OPENROUTER_API_KEY;
if (!(token || apiKey) || !(file || env.MODELS)) { console.error('Usage: OPENROUTER_API_KEY=… | OPENAI_API_KEY=… | CHATGPT_TOKEN=… node test/eval-tags.mjs <export.json>'); process.exit(1); }
const models = {...(env.MODEL && {model: env.MODEL}), ...(env.SMALL_MODEL && {smallModel: env.SMALL_MODEL})};
const settings = token ? {provider: 'chatgpt', chatgpt: models} : {openrouter: {apiKey, ...models}};
if ((token || env.OPENAI_API_KEY) && !env.MODELS && !(env.MODEL && env.SMALL_MODEL)) { console.error('Set MODEL and SMALL_MODEL (MODELS=1 lists your plan\'s models).'); process.exit(1); }
if (env.OPENAI_API_KEY) {
  const realFetch = fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace('https://openrouter.ai/api/v1', 'https://api.openai.com/v1'), init);
}
// The ChatGPT provider reads its token from the extension's IndexedDB: hand it the copied one instead (never refreshed).
const auth = {accessToken: token, refreshToken: '-', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Infinity};
globalThis.indexedDB = {open() {
  const open = {result: {close() {}, transaction() {
    const tx = {objectStore: () => ({get: () => ({result: auth})})};
    setTimeout(() => tx.oncomplete());
    return tx;
  }}};
  setTimeout(() => open.onsuccess());
  return open;
}};
// Just enough of chrome for background.js to load, so the eval uses Margin's real tagging prompt.
globalThis.chrome = {storage: {local: {get: async (k) => (k === 'settings' ? {settings} : {})}, session: {setAccessLevel: async () => {}}},
 sidePanel: {setPanelBehavior: async () => {}}, runtime: {onMessage: {addListener() {}}}, tabs: {onUpdated: {addListener() {}}}};
if (env.MODELS) {
  const res = await (await import('../chatgpt.js')).models();
  console.log(res.ok ? res.models.map((m) => `${m.slug}\t${m.name}`).join('\n') : res);
  process.exit(0);
}
const { ask } = await import('../providers.js');
const { CONCEPTS_SYS, conceptsPrompt } = await import('../background.js');

const { pages } = JSON.parse(readFileSync(file, 'utf8'));
const items = pages.flatMap((page) => page.highlights.filter((h) => h.messages.some((m) => m.role === 'assistant')).map((h) => ({page, h})))
  .sort((a, b) => (b.h.createdAt || '').localeCompare(a.h.createdAt || '')).slice(0, Number(process.env.LIMIT) || 20);

const variants = [{name: 'small', small: true, system: CONCEPTS_SYS}, {name: 'main', small: false, system: CONCEPTS_SYS}];
if (process.env.ALT_PROMPT) {
  const system = readFileSync(process.env.ALT_PROMPT, 'utf8');
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
    if (!res.ok && ['NO_KEY', 'BAD_KEY', 'NO_CREDITS', 'NETWORK', 'SIGNED_OUT', 'PLAN_LIMIT', 'PLAN_INELIGIBLE'].includes(res.code)) { console.error(res); process.exit(1); }
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
