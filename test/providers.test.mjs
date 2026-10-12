// Streaming parsers and request shapes, with fetch and chrome.storage stubbed. Run: node test/providers.test.mjs
import assert from 'node:assert/strict';

let settings, lastReq;
globalThis.chrome = { storage: { local: { get: async () => ({ settings }) } }, runtime: {} };
// Serve `body` split into awkward chunks (mid-line, mid-event) to exercise the SSE buffer.
const serve = (body, status = 200) => {
  globalThis.fetch = async (url, init) => {
    lastReq = { url, init, body: init.body && JSON.parse(init.body) };
    const enc = new TextEncoder();
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += 7) c.enqueue(enc.encode(body.slice(i, i + 7))); c.close(); } });
    return new Response(stream, { status });
  };
};
const { ask } = await import('../providers.js');
const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;

// Anthropic: text deltas joined, thinking ignored, partials reported, cache_control + fallbacks on the request
settings = { provider: 'anthropic', anthropic: { apiKey: 'k', model: 'claude-opus-5-5' } };
serve(ev('message_start', { message: {} }) + ev('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'x' } })
  + ev('content_block_delta', { delta: { type: 'text_delta', text: 'Hel' } }) + ': ping\n\n'
  + ev('content_block_delta', { delta: { type: 'text_delta', text: 'lo' } }) + ev('message_delta', { delta: { stop_reason: 'end_turn' } })
  + ev('message_stop', {}));
const partials = [];
let r = await ask({ system: 'SYS', prompt: 'P' }, (t) => partials.push(t));
assert.deepEqual(r, { ok: true, text: 'Hello' });
assert.deepEqual(partials, ['Hel', 'Hello']);
assert.equal(lastReq.url, 'https://api.anthropic.com/v1/messages');
assert.deepEqual(lastReq.body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
assert.equal(lastReq.body.fallbacks, 'default');
assert.equal(lastReq.init.headers['anthropic-dangerous-direct-browser-access'], 'true');

// Anthropic: no fallbacks for models that don't accept it
settings.anthropic.model = 'claude-haiku-5-5';
serve(ev('message_stop', {}));
await ask({ system: 'S', prompt: 'P' });
assert.equal(lastReq.body.fallbacks, undefined);
assert.equal(lastReq.init.headers['anthropic-beta'], undefined);

// Anthropic: refusal, mid-stream error, HTTP errors, missing key
serve(ev('message_delta', { delta: { stop_reason: 'refusal' } }));
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'REFUSED');
serve(ev('error', { error: { type: 'overloaded_error', message: 'busy' } }));
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'API_DOWN');
serve(JSON.stringify({ error: { message: 'invalid x-api-key' } }), 401);
r = await ask({ system: 'S', prompt: 'P' });
assert.equal(r.code, 'BAD_KEY'); assert.match(r.detail, /invalid x-api-key/);
settings.anthropic.apiKey = '';
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NO_KEY');

// OpenAI-compatible via OpenRouter: [DONE], comment lines, cache_control only for anthropic/ models
settings = { provider: 'openai', openai: { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'or', model: 'anthropic/claude-x' } };
const chunk = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
serve(': OPENROUTER PROCESSING\n\n' + chunk('Hi ') + chunk('there') + 'data: [DONE]\n\n');
r = await ask({ system: 'SYS', prompt: 'P' });
assert.deepEqual(r, { ok: true, text: 'Hi there' });
assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/chat/completions');
assert.equal(lastReq.init.headers.authorization, 'Bearer or');
assert.deepEqual(lastReq.body.messages[0].content, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);

settings.openai.model = 'openai/gpt-x';
serve(chunk('a') + 'data: [DONE]\n\n');
await ask({ system: 'SYS', prompt: 'P' });
assert.equal(lastReq.body.messages[0].content, 'SYS', 'plain string system for non-Anthropic models');

// Local server: no key → no auth header; CRLF line endings; mid-stream error object
settings = { provider: 'openai', openai: { baseUrl: 'http://localhost:11434/v1', model: 'llama' } };
serve(chunk('x').replace(/\n/g, '\r\n') + 'data: [DONE]\r\n\r\n');
r = await ask({ system: 'S', prompt: 'P' });
assert.deepEqual(r, { ok: true, text: 'x' });
assert.equal(lastReq.init.headers.authorization, undefined);
serve(`data: ${JSON.stringify({ error: { message: 'model not loaded' } })}\n\n`);
r = await ask({ system: 'S', prompt: 'P' });
assert.equal(r.code, 'API_ERROR'); assert.match(r.detail, /not loaded/);
serve('nope', 404);
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'BAD_MODEL');
settings.openai.model = '';
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NO_MODEL');

// Network failure
settings = { provider: 'anthropic', anthropic: { apiKey: 'k' } };
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NETWORK');
// Reader notes: a second, uncached system block after the cached article (Anthropic, OpenRouter+Claude);
// appended to the system string everywhere else.
settings = { provider: 'anthropic', anthropic: { apiKey: 'k', model: 'claude-opus-5-5' } };
serve(ev('message_stop', {}));
await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' });
assert.deepEqual(lastReq.body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: 'NOTES' }]);
settings = { provider: 'openai', openai: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'anthropic/claude-x' } };
serve('data: [DONE]\n\n');
await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' });
assert.equal(lastReq.body.messages[0].content[1].text, 'NOTES');
assert.equal(lastReq.body.messages[0].content[1].cache_control, undefined);
settings.openai.model = 'openai/gpt-x';
serve('data: [DONE]\n\n');
await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' });
assert.equal(lastReq.body.messages[0].content, 'SYS\n\nNOTES');
// Model settings: effort only on 5.x models, 1-hour cache, small jobs → Haiku at low effort
settings = { provider: 'anthropic', anthropic: { apiKey: 'k', model: 'claude-opus-5-5', effort: 'high' } };
serve(ev('message_stop', {}));
await ask({ system: 'S', prompt: 'P' });
assert.deepEqual(lastReq.body.output_config, { effort: 'high' });
assert.equal(lastReq.body.system[0].cache_control.ttl, '1h');
serve(ev('message_stop', {}));
await ask({ small: true, system: 'S', prompt: 'P' });
assert.equal(lastReq.body.model, 'claude-haiku-5-5');
assert.deepEqual(lastReq.body.output_config, { effort: 'low' });
settings.anthropic.model = 'claude-haiku-4-5';
serve(ev('message_stop', {}));
await ask({ system: 'S', prompt: 'P' });
assert.equal(lastReq.body.output_config, undefined, 'no effort for pre-5 models');
settings = { provider: 'anthropic', anthropic: { apiKey: 'k' } };
serve(ev('message_stop', {}));
await ask({ system: 'S', prompt: 'P' });
assert.equal(lastReq.body.model, 'claude-opus-5-5');
assert.deepEqual(lastReq.body.output_config, { effort: 'medium' }, 'defaults');

// Claude Code: model + effort go to the native host; small jobs → haiku/low
let hostReq;
chrome.runtime.sendNativeMessage = (host, req, cb) => { hostReq = req; cb({ ok: true, text: 'x' }); };
chrome.runtime.lastError = undefined;
settings = { provider: 'cli' };
await ask({ system: 'S', notes: 'N', prompt: 'P' });
assert.deepEqual([hostReq.model, hostReq.effort, hostReq.system], ['opus', 'medium', 'S\n\nN']);
settings = { provider: 'cli', cli: { model: 'sonnet', effort: 'high' } };
await ask({ system: 'S', prompt: 'P' });
assert.deepEqual([hostReq.model, hostReq.effort], ['sonnet', 'high']);
await ask({ small: true, system: 'S', prompt: 'P' });
assert.deepEqual([hostReq.model, hostReq.effort], ['haiku', 'low']);
console.log('providers: all passed');
