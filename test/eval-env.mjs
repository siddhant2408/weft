// Shared setup for the opt-in evals: picks the provider from env vars and loads Margin's real prompts. Spends API credits.
//   OPENROUTER_API_KEY=sk-or-…  (optional MODEL=…, SMALL_MODEL=…; both default to openrouter/free, which varies per call)
//   or OPENAI_API_KEY=sk-… MODEL=gpt-… SMALL_MODEL=gpt-… (same Chat Completions request, sent to api.openai.com)
//   or CHATGPT_TOKEN=… MODEL=… SMALL_MODEL=… (your ChatGPT plan, as the extension's ChatGPT provider; MODELS=1 lists the plan's models).
//      Token: Margin's Settings page → DevTools console → copy((await (await import('./chatgpt.js')).accessToken()).token)
//      It expires (about an hour) and isn't refreshed here; copy a fresh one if calls fail with SIGNED_OUT.
export const env = process.env;
const token = env.CHATGPT_TOKEN, apiKey = env.OPENAI_API_KEY || env.OPENROUTER_API_KEY;
if (!(token || apiKey)) { console.error('Set OPENROUTER_API_KEY, OPENAI_API_KEY or CHATGPT_TOKEN (see test/eval-env.mjs).'); process.exit(1); }
export const models = {...(env.MODEL && {model: env.MODEL}), ...(env.SMALL_MODEL && {smallModel: env.SMALL_MODEL})};
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
// Just enough of chrome for background.js to load, so evals use Margin's real prompts.
globalThis.chrome = {storage: {local: {get: async (k) => (k === 'settings' ? {settings} : {})}, session: {setAccessLevel: async () => {}}},
 sidePanel: {setPanelBehavior: async () => {}}, runtime: {onMessage: {addListener() {}}}, tabs: {onUpdated: {addListener() {}}}};
if (env.MODELS) {
  const res = await (await import('../chatgpt.js')).models();
  console.log(res.ok ? res.models.map((m) => `${m.slug}\t${m.name}`).join('\n') : res);
  process.exit(0);
}
export const { ask } = await import('../providers.js');
// Codes that fail every later call too: stop instead of scoring a run of failures.
export const FATAL = ['NO_KEY', 'BAD_KEY', 'NO_CREDITS', 'NETWORK', 'SIGNED_OUT', 'PLAN_LIMIT', 'PLAN_INELIGIBLE'];
