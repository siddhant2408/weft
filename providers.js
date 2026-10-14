// Model providers, both streamed. Each returns {ok, text} | {ok: false, code, detail}.
//   openrouter → OpenRouter's Chat Completions API with the user's key
//   chatgpt    → the Responses API on the user's ChatGPT plan (Sign in with ChatGPT, see chatgpt.js)
// system (instructions + article) is the stable, cached prefix; notes (the reader's notes) follow it uncached,
// because they change as the user reads; prompt is the per-call part.
// Raw fetch rather than SDKs: the extension has no build step (spec D1).

import { RESOURCE, accessToken } from './chatgpt.js';

export const HOST = 'com.margin.host';  // native host: SQLite mirror only
const TIMEOUT_MS = 120000;
const BASE = 'https://openrouter.ai/api/v1';
// openrouter/free routes each call to one of OpenRouter's free models ($0, rate-limited, model varies per call).
export const DEFAULT_MODEL = 'openrouter/free';
// Small jobs (concept tags, takeaways) never include the article, so a fast cheap model loses no cache.
export const DEFAULT_SMALL_MODEL = 'openrouter/free';

// Server-sent events → {event, data} objects.
async function* sse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

function httpError(status, body) {
  const detail = errorText(body);
  const code = status === 401 || status === 403 ? 'BAD_KEY' : status === 402 ? 'NO_CREDITS' : status === 429 ? 'RATE_LIMIT'
    : status === 404 ? (/data policy/i.test(detail) ? 'DATA_POLICY' : 'BAD_MODEL') : status >= 500 ? 'API_DOWN' : 'API_ERROR';
  return { ok: false, code, detail: `HTTP ${status}: ${detail}`.slice(0, 500) };
}

function errorText(t) {
  try { const j = JSON.parse(t); return j.error?.message || j.message || j.detail || t; } catch { return t; }
}

// Shared fetch + stream loop. `onDelta(json)` returns text to append, or throws {code, detail} to fail.
async function streamRequest(url, init, onData, onText, toError = httpError) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return toError(res.status, await res.text().catch(() => ''));
    let text = '', complete = false;
    for await (const ev of sse(res.body)) {
      const delta = onData(ev);
      if (delta === null) { complete = true; break; }
      const t = delta?.text ?? delta;  // { text, done } ends the reply on a final chunk that still carries text
      if (t) { text += t; onText?.(text); }
      if (delta?.done) { complete = true; break; }
    }
    return complete ? { ok: true, text } : { ok: false, code: 'INCOMPLETE', detail: 'The stream ended before the reply completed.' };
  } catch (e) {
    if (e?.code) return { ok: false, ...e };
    if (e?.name === 'AbortError') return { ok: false, code: 'TIMEOUT', detail: 'no reply in 120 s' };
    return { ok: false, code: 'NETWORK', detail: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// req.schema = {name, schema}: ask for JSON matching it. Models that don't support structured output may still ignore
// it (the free router picks models at random), so callers keep validating the reply.
function openrouter({ system, notes, prompt, schema }, { apiKey, model }, onText) {
  // Anthropic models on OpenRouter cache only with an explicit breakpoint; other models cache automatically.
  const content = /^anthropic\//.test(model)
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }, ...(notes ? [{ type: 'text', text: notes }] : [])]
    : (notes ? `${system}\n\n${notes}` : system);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'X-Title': 'Margin' };
  const body = { model, stream: true, messages: [{ role: 'system', content }, { role: 'user', content: prompt }] };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } };
  return streamRequest(`${BASE}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, ({ data }) => {
    if (data === '[DONE]') return null;
    const j = JSON.parse(data);
    if (j.error) throw { code: 'API_ERROR', detail: j.error.message || JSON.stringify(j.error) };
    if (j.choices?.some((c) => c.finish_reason === 'length')) throw { code: 'INCOMPLETE', detail: 'The reply reached the output token limit.' };
    const text = j.choices?.[0]?.delta?.content || '';
    return j.choices?.[0]?.finish_reason === 'stop' ? { text, done: true } : text;
  }, onText);
}

// ChatGPT plan errors carry a code (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
const PLAN_ERRORS = {
  subscription_sharing_usage_limit_exceeded: 'PLAN_LIMIT', subscription_sharing_user_not_eligible: 'PLAN_INELIGIBLE',
  subscription_sharing_invalid_user: 'SIGNED_OUT', subscription_sharing_usage_unavailable: 'API_DOWN', subscription_sharing_user_unavailable: 'API_DOWN',
};
function planError(status, body) {
  let code;
  try { code = JSON.parse(body).error?.code; } catch { /* {"detail": …} or plain text */ }
  if (PLAN_ERRORS[code]) return { ok: false, code: PLAN_ERRORS[code], detail: errorText(body).slice(0, 500) };
  if (status === 401) return { ok: false, code: 'SIGNED_OUT', detail: errorText(body).slice(0, 500) };
  return httpError(status, body);
}

// Responses API rules for plan usage: store false, stream true, system text as `instructions`, no system items,
// no temperature, max_output_tokens, top_logprobs or service_tier (fast mode). Prompt caching is automatic.
// req.quick: reasoning effort "none", the plan's only speed setting, for calls a reader waits on that need no thinking
// (not tags: they run after the reply and decide what related threads can find). A model that rejects it is retried without.
async function chatgpt(req, model, onText, quick = !!req.quick) {
  const { system, notes, prompt, schema } = req;
  const t = await accessToken();
  if (!t.ok) return t;
  const body = { model, instructions: notes ? `${system}\n\n${notes}` : system, input: [{ role: 'user', content: prompt }], store: false, stream: true };
  if (schema) body.text = { format: { type: 'json_schema', name: schema.name, strict: true, schema: schema.schema } };
  if (quick) body.reasoning = { effort: 'none' };
  const res = await chatgptStream(body, t.token, onText);
  return quick && res.code === 'API_ERROR' && /reasoning|effort/i.test(res.detail) ? chatgpt(req, model, onText, false) : res;
}

function chatgptStream(body, token, onText) {
  return streamRequest(`${RESOURCE}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, ({ data }) => {
    const j = JSON.parse(data);
    if (j.type === 'response.output_text.delta') return j.delta;
    if (j.type === 'response.completed') return null;
    if (j.type === 'response.incomplete') throw { code: 'INCOMPLETE', detail: j.response?.incomplete_details?.reason || 'The reply was cut short.' };
    if (j.type === 'response.failed' || j.type === 'error') {
      const e = j.response?.error || j.error || j;
      throw { code: PLAN_ERRORS[e.code] || 'API_ERROR', detail: e.message || e.code || 'stream error' };
    }
    return '';
  }, onText, planError);
}

// settings.provider: 'openrouter' (default) | 'chatgpt'. settings.openrouter = {apiKey, model, smallModel};
// settings.chatgpt = {model, smallModel}, slugs from the account's catalogue. Older settings kept an OpenRouter key under "openai".
export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const legacy = /openrouter\.ai/.test(settings.openai?.baseUrl || '') ? settings.openai : {};
  return { ...settings, provider: settings.provider === 'chatgpt' ? 'chatgpt' : 'openrouter',
    openrouter: { model: legacy.model, apiKey: legacy.apiKey, ...settings.openrouter }, chatgpt: { ...settings.chatgpt } };
}

// What the UI should call the replier: the model's short name.
// The free router picks a different model each call, so it gets a generic name.
export const replierName = (s) => {
  if (s?.provider === 'chatgpt') return s.chatgpt?.model || 'ChatGPT';
  const m = s?.openrouter?.model || DEFAULT_MODEL;
  return m === 'openrouter/free' ? 'AI' : m.split('/').pop();
};

// Jev (TypeSafe System One): typed judgments over `state`, e.g. a noul (probability of yes) per question.
// Not streamed. settings.typesafe = {apiKey}; without one, callers fall back to code (docs.typesafe.ai/api).
export const JUDGE_MODEL = 'jev-latest';
export async function judge(state, questions) {
  const apiKey = (await getSettings()).typesafe?.apiKey;
  if (!apiKey) return { ok: false, code: 'NO_KEY', detail: 'No TypeSafe API key set.' };
  try {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: JUDGE_MODEL, state, questions }) });
    if (!res.ok) return httpError(res.status, await res.text().catch(() => ''));
    return { ok: true, answers: (await res.json()).answers || {} };
  } catch (e) {
    return { ok: false, code: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', detail: String(e?.message || e) };
  }
}

// onText(fullTextSoFar) is called while streaming. req.small: a short job that goes to the small model. req.quick: see chatgpt().
export async function ask(req, onText) {
  const s = await getSettings();
  if (s.provider === 'chatgpt') {
    const model = (req.small && s.chatgpt.smallModel) || s.chatgpt.model;
    if (model) return chatgpt(req, model, onText);
    const t = await accessToken();  // not signed in explains a missing model better than "pick a model"
    return t.ok ? { ok: false, code: 'NO_MODEL', detail: 'Pick a ChatGPT model in Settings.' } : t;
  }
  const { apiKey, model, smallModel } = s.openrouter;
  if (!apiKey) return { ok: false, code: 'NO_KEY', detail: 'No OpenRouter API key set.' };
  return openrouter(req, { apiKey, model: (req.small ? smallModel || DEFAULT_SMALL_MODEL : model) || DEFAULT_MODEL }, onText);
}
