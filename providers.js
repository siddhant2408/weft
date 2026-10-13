// The model provider: OpenRouter's Chat Completions API with the user's key, streamed. Returns {ok, text} | {ok: false, code, detail}.
// system (instructions + article) is the stable, cached prefix; notes (the reader's notes) follow it uncached,
// because they change as the user reads; prompt is the per-call part.
// Raw fetch rather than SDKs: the extension has no build step (spec D1).

export const HOST = 'com.margin.host';  // native host: SQLite mirror only
const TIMEOUT_MS = 120000;
const BASE = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
// Small jobs (concept tags, takeaways, context selection) never include the article, so a fast cheap model loses no cache.
export const DEFAULT_SMALL_MODEL = 'anthropic/claude-haiku-5.5';

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

function httpError(status, detail) {
  const code = status === 401 || status === 403 ? 'BAD_KEY' : status === 402 ? 'NO_CREDITS' : status === 429 ? 'RATE_LIMIT'
    : status === 404 ? 'BAD_MODEL' : status >= 500 ? 'API_DOWN' : 'API_ERROR';
  return { ok: false, code, detail: `HTTP ${status}: ${detail}`.slice(0, 500) };
}

async function readError(res) {
  const t = await res.text().catch(() => '');
  try { const j = JSON.parse(t); return j.error?.message || j.message || t; } catch { return t; }
}

// Shared fetch + stream loop. `onDelta(json)` returns text to append, or throws {code, detail} to fail.
async function streamRequest(url, init, onData, onText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return httpError(res.status, await readError(res));
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

function openrouter({ system, notes, prompt }, { apiKey, model }, onText) {
  // Anthropic models on OpenRouter cache only with an explicit breakpoint; other models cache automatically.
  const content = /^anthropic\//.test(model)
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }, ...(notes ? [{ type: 'text', text: notes }] : [])]
    : (notes ? `${system}\n\n${notes}` : system);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'X-Title': 'Margin' };
  const body = { model, stream: true, messages: [{ role: 'system', content }, { role: 'user', content: prompt }] };
  return streamRequest(`${BASE}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, ({ data }) => {
    if (data === '[DONE]') return null;
    const j = JSON.parse(data);
    if (j.error) throw { code: 'API_ERROR', detail: j.error.message || JSON.stringify(j.error) };
    if (j.choices?.some((c) => c.finish_reason === 'length')) throw { code: 'INCOMPLETE', detail: 'The reply reached the output token limit.' };
    const text = j.choices?.[0]?.delta?.content || '';
    return j.choices?.[0]?.finish_reason === 'stop' ? { text, done: true } : text;
  }, onText);
}

// settings.openrouter = {apiKey, model, smallModel}. Older settings kept an OpenRouter key under "openai".
export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const legacy = /openrouter\.ai/.test(settings.openai?.baseUrl || '') ? settings.openai : {};
  return { ...settings, openrouter: { model: legacy.model, apiKey: legacy.apiKey, ...settings.openrouter } };
}

// What the UI should call the replier: the model's short name.
export const replierName = (s) => (s?.openrouter?.model || DEFAULT_MODEL).split('/').pop();

// onText(fullTextSoFar) is called while streaming. req.small: a short job that goes to the small model.
export async function ask(req, onText) {
  const { apiKey, model, smallModel } = (await getSettings()).openrouter;
  if (!apiKey) return { ok: false, code: 'NO_KEY', detail: 'No OpenRouter API key set.' };
  return openrouter(req, { apiKey, model: (req.small ? smallModel || DEFAULT_SMALL_MODEL : model) || DEFAULT_MODEL }, onText);
}
