// Model providers. Every provider takes {system, notes?, prompt} and returns {ok, text} | {ok: false, code, detail}.
// system (instructions + article) is the stable, cached prefix; notes (the reader's notes) follow it uncached,
// because they change as the user reads; prompt is the per-call part.
// Raw fetch rather than SDKs: the extension has no build step (spec D1).
//   cli       → Claude Code on this Mac via the native host (subscription, no streaming)
//   anthropic → Anthropic Messages API with the user's key (streaming, cache_control on the system prompt)
//   openai    → any OpenAI-compatible Chat Completions API: OpenRouter, OpenAI, Ollama, LM Studio… (streaming)

export const HOST = 'com.margin.host';
const TIMEOUT_MS = 120000;

export const PRESETS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
  openai: { baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
};
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'medium';
// Small jobs (one-line takeaways) never include the article, so a fast cheap model costs no cache reuse.
const SMALL = { cli: 'haiku', anthropic: 'claude-haiku-5-5' };
// Effort (output_config.effort) exists on the 5.x families; older models reject it.
const EFFORT_MODELS = /^claude-(opus|sonnet|haiku|fable|mythos)-5/;
// Server-side refusal fallback: only these models accept fallbacks: "default".
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

const joined = (system, notes) => (notes ? `${system}\n\n${notes}` : system);

function cli({ system, notes, prompt }, cfg) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { system: joined(system, notes), prompt, model: cfg.model, effort: cfg.effort }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, code: /not found|forbidden/i.test(err.message) ? 'HOST_MISSING' : 'HOST_ERROR', detail: err.message });
      else resolve(res);
    });
  });
}

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
  const code = status === 401 || status === 403 ? 'BAD_KEY' : status === 429 ? 'RATE_LIMIT'
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

function anthropic({ system, notes, prompt }, cfg, onText) {
  const model = cfg.model || DEFAULT_ANTHROPIC_MODEL;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    // Extension pages send an Origin header; without this the API rejects it as a browser request.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 16000,
    stream: true,
    // 1-hour cache: reading is slow, and the default 5 minutes would re-send the article after every pause.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }, ...(notes ? [{ type: 'text', text: notes }] : [])],
    messages: [{ role: 'user', content: prompt }],
  };
  if (cfg.effort && EFFORT_MODELS.test(model)) body.output_config = { effort: cfg.effort };
  if (FALLBACK_MODELS.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  return streamRequest('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) }, ({ data }) => {
    const j = JSON.parse(data);
    if (j.type === 'error') throw { code: j.error?.type === 'overloaded_error' ? 'API_DOWN' : 'API_ERROR', detail: j.error?.message || 'stream error' };
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') return j.delta.text;
    if (j.type === 'message_delta' && j.delta?.stop_reason === 'refusal') throw { code: 'REFUSED', detail: j.delta.stop_details?.explanation || '' };
    if (j.type === 'message_delta' && ['max_tokens', 'model_context_window_exceeded'].includes(j.delta?.stop_reason)) throw { code: 'INCOMPLETE', detail: 'The reply reached the output token limit.' };
    if (j.type === 'message_stop') return null;
    return '';
  }, onText);
}

function openai({ system, notes, prompt }, cfg, onText) {
  const base = (cfg.baseUrl || PRESETS.openrouter.baseUrl).replace(/\/+$/, '');
  // Anthropic models via OpenRouter cache only with an explicit breakpoint; other providers cache automatically.
  const systemContent = /openrouter\.ai/.test(base) && /^anthropic\//.test(cfg.model)
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }, ...(notes ? [{ type: 'text', text: notes }] : [])]
    : joined(system, notes);
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (/openrouter\.ai/.test(base)) headers['X-Title'] = 'Margin';
  const body = {
    model: cfg.model,
    stream: true,
    messages: [{ role: 'system', content: systemContent }, { role: 'user', content: prompt }],
  };
  return streamRequest(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, ({ data }) => {
    if (data === '[DONE]') return null;
    const j = JSON.parse(data);
    if (j.error) throw { code: 'API_ERROR', detail: j.error.message || JSON.stringify(j.error) };
    if (j.choices?.some((c) => c.finish_reason === 'length')) throw { code: 'INCOMPLETE', detail: 'The reply reached the output token limit.' };
    const text = j.choices?.[0]?.delta?.content || '';
    // Some compatible servers close after finish_reason "stop" without sending [DONE].
    return j.choices?.[0]?.finish_reason === 'stop' ? { text, done: true } : text;
  }, onText);
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { provider: 'cli', cli: {}, anthropic: {}, openai: {}, ...settings };
}

// What the UI should call the replier.
export function replierName(s) {
  if (s.provider === 'openai' && s.openai?.model) return s.openai.model.split('/').pop();
  return 'Claude';
}

// onText(fullTextSoFar) is called while streaming (API providers only).
// req.small: a short job (takeaways) that goes to the provider's small model at low effort.
export async function ask(req, onText) {
  const s = await getSettings();
  const small = (p) => (req.small ? { model: SMALL[p], effort: 'low' } : {});
  if (s.provider === 'anthropic') {
    if (!s.anthropic.apiKey) return { ok: false, code: 'NO_KEY', detail: 'No Anthropic API key set.' };
    return anthropic(req, { effort: DEFAULT_EFFORT, ...s.anthropic, ...small('anthropic') }, onText);
  }
  if (s.provider === 'openai') {
    if (!s.openai.model) return { ok: false, code: 'NO_MODEL', detail: 'No model set.' };
    return openai(req, s.openai, onText);
  }
  return cli(req, { model: 'opus', effort: DEFAULT_EFFORT, ...s.cli, ...small('cli') });
}
