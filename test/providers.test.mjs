// Streaming parser and request shape for OpenRouter, with fetch and chrome.storage stubbed. Run: node test/providers.test.mjs
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
const { ask, judge, replierName, getSettings, openrouterSignIn, openrouterRedirect, APP_URL, OR_CALLBACK } = await import('../providers.js');
const chunk = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

// [DONE], comment lines, partials, cache_control only for anthropic/ models
settings = { openrouter: { apiKey: 'or', model: 'anthropic/claude-x' } };
serve(': OPENROUTER PROCESSING\n\n' + chunk('Hi ') + chunk('there') + 'data: [DONE]\n\n');
const partials = [];
let r = await ask({ system: 'SYS', prompt: 'P' }, (t) => partials.push(t));
assert.deepEqual(r, { ok: true, text: 'Hi there' });
assert.deepEqual(partials, ['Hi ', 'Hi there']);
assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/chat/completions');
assert.equal(lastReq.init.headers.authorization, 'Bearer or');
assert.equal(lastReq.body.model, 'anthropic/claude-x');
assert.deepEqual(lastReq.body.messages[0].content, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);

// Reader notes: a second, uncached block after the cached article for Claude; appended to the string otherwise
serve('data: [DONE]\n\n');
await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' });
assert.deepEqual(lastReq.body.messages[0].content[1], { type: 'text', text: 'NOTES' });
settings.openrouter.model = 'openai/gpt-x';
serve(chunk('a') + 'data: [DONE]\n\n');
await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' });
assert.equal(lastReq.body.messages[0].content, 'SYS\n\nNOTES');

// Small jobs → small model; defaults when unset
serve('data: [DONE]\n\n');
await ask({ small: true, system: 'S', prompt: 'P' });
assert.equal(lastReq.body.model, 'openrouter/free');
settings.openrouter.smallModel = 'google/gemini-3.8-flash';
serve('data: [DONE]\n\n');
await ask({ small: true, system: 'S', prompt: 'P' });
assert.equal(lastReq.body.model, 'google/gemini-3.8-flash');
settings = { openrouter: { apiKey: 'k' } };
serve('data: [DONE]\n\n');
await ask({ system: 'S', prompt: 'P' });
assert.equal(lastReq.body.model, 'openrouter/free');
assert.equal(lastReq.body.messages[0].content, 'S', 'free router gets a plain system string');
assert.equal(replierName(await getSettings()), 'AI');
assert.equal(replierName({ openrouter: { model: 'anthropic/claude-sonnet-5.5' } }), 'claude-sonnet-5.5');

// Older settings with an OpenRouter key under "openai" keep working
settings = { provider: 'openai', openai: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'old', model: 'openai/gpt-x' } };
serve('data: [DONE]\n\n');
await ask({ system: 'S', prompt: 'P' });
assert.deepEqual([lastReq.init.headers.authorization, lastReq.body.model], ['Bearer old', 'openai/gpt-x']);
settings = { provider: 'openai', openai: { baseUrl: 'http://localhost:11434/v1', model: 'llama' } };
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NO_KEY', 'non-OpenRouter settings are not reused');

// A schema becomes a strict json_schema response_format; without one there is none.
settings = { openrouter: { apiKey: 'k' } };
const schema = { name: 'pick', schema: { type: 'object', properties: { ids: { type: 'array' } } } };
serve('data: [DONE]\n\n');
await ask({ small: true, system: 'S', prompt: 'P', schema });
assert.deepEqual(lastReq.body.response_format, { type: 'json_schema', json_schema: { name: 'pick', strict: true, schema: schema.schema } });
serve('data: [DONE]\n\n');
await ask({ system: 'S', prompt: 'P' });
assert.equal(lastReq.body.response_format, undefined);

// CRLF line endings; mid-stream error; HTTP errors; missing key; network failure
settings = { openrouter: { apiKey: 'k', model: 'openai/gpt-x' } };
serve(chunk('x').replace(/\n/g, '\r\n') + 'data: [DONE]\r\n\r\n');
assert.deepEqual(await ask({ system: 'S', prompt: 'P' }), { ok: true, text: 'x' });
serve(`data: ${JSON.stringify({ error: { message: 'provider overloaded' } })}\n\n`);
r = await ask({ system: 'S', prompt: 'P' });
assert.equal(r.code, 'API_ERROR'); assert.match(r.detail, /overloaded/);
serve(JSON.stringify({ error: { message: 'No auth credentials found' } }), 401);
r = await ask({ system: 'S', prompt: 'P' });
assert.equal(r.code, 'BAD_KEY'); assert.match(r.detail, /No auth/);
serve(JSON.stringify({ error: { message: 'No endpoints found matching your data policy (Free model publication)' } }), 404);
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'DATA_POLICY');
for (const [status, code] of [[402, 'NO_CREDITS'], [404, 'BAD_MODEL'], [429, 'RATE_LIMIT'], [502, 'API_DOWN']]) {
  serve('x', status);
  assert.equal((await ask({ system: 'S', prompt: 'P' })).code, code);
}
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NETWORK');
settings.openrouter.apiKey = '';
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NO_KEY');

// Jev: one POST to TypeSafe with the key from settings.typesafe; answers come back keyed by question id.
const q = { helps: { type: 'noul', instructions: 'Helps?' } };
settings = { typesafe: { apiKey: 'ts' } };
serve(JSON.stringify({ model: 'jev-1.13.0', answers: { helps: { type: 'noul', noul: 0.73 } } }));
assert.deepEqual(await judge({ a: 1 }, q), { ok: true, answers: { helps: { type: 'noul', noul: 0.73 } } });
assert.equal(lastReq.url, 'https://api.typesafe.ai/v1/systemone');
assert.equal(lastReq.init.headers.authorization, 'Bearer ts');
assert.deepEqual(lastReq.body, { model: 'jev-latest', state: { a: 1 }, questions: q });
serve(JSON.stringify({ detail: 'Invalid API key' }), 401);
assert.equal((await judge({}, q)).code, 'BAD_KEY');
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
assert.equal((await judge({}, q)).code, 'NETWORK');
// No TypeSafe key: the same request goes to OpenRouter on the OpenRouter key, with Weft's attribution
settings = { openrouter: { apiKey: 'or' } };
serve(JSON.stringify({ answers: { helps: { type: 'noul', noul: 0.5 } } }));
assert.equal((await judge({ a: 1 }, q)).ok, true);
assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/systemone');
assert.equal(lastReq.init.headers.authorization, 'Bearer or');
assert.equal(lastReq.init.headers['HTTP-Referer'], APP_URL);
assert.equal(lastReq.body.model, '~typesafe/jev-latest');
// An explicit choice wins over a saved key either way
settings = { judge: 'openrouter', typesafe: { apiKey: 'ts' }, openrouter: { apiKey: 'or' } };
serve(JSON.stringify({ answers: {} }));
await judge({}, q);
assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/systemone');
settings = { judge: 'typesafe', openrouter: { apiKey: 'or' } };
assert.equal((await judge({}, q)).code, 'NO_KEY', 'TypeSafe chosen but no key: no silent switch to OpenRouter');
settings = {};
assert.equal((await judge({}, q)).code, 'NO_KEY');

// OpenRouter sign-in: the sign-in tab's redirect to OR_CALLBACK is swapped for a key, saved as the OpenRouter key
const session = {}, removed = [];
let saved;
chrome.storage.session = { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, o), remove: async (k) => { delete session[k]; } };
chrome.storage.local.set = async (o) => { saved = o.settings; };
chrome.tabs = { create: async ({ url }) => ({ id: 7, url }), remove: async (id) => removed.push(id) };
settings = { provider: 'chatgpt', openrouter: { model: 'openai/gpt-x' } };
assert.deepEqual(await openrouterSignIn(), { ok: true });
const { state, verifier } = session['openrouter.pending'];
assert.equal(await openrouterRedirect(8, `${OR_CALLBACK}?code=c&state=${state}`), null, 'other tabs ignored');
assert.equal(await openrouterRedirect(7, 'https://openrouter.ai/auth?x'), null, 'other URLs ignored');
serve(JSON.stringify({ key: 'sk-or-new' }));
assert.deepEqual(await openrouterRedirect(7, `${OR_CALLBACK}?code=c&state=${state}`), { ok: true });
assert.equal(lastReq.url, 'https://openrouter.ai/api/v1/auth/keys');
assert.deepEqual(lastReq.body, { code: 'c', code_verifier: verifier, code_challenge_method: 'S256' });
assert.deepEqual(saved, { provider: 'openrouter', openrouter: { model: 'openai/gpt-x', apiKey: 'sk-or-new' } });
assert.deepEqual(removed, [7]);
assert.equal(session['openrouter.pending'], undefined, 'one use');
// From Related threads: connects without switching who replies
await openrouterSignIn({ forReplies: false });
serve(JSON.stringify({ key: 'sk-or-2' }));
await openrouterRedirect(7, `${OR_CALLBACK}?code=c&state=${session['openrouter.pending'].state}`);
assert.equal(saved.provider, 'chatgpt');
assert.equal(saved.openrouter.apiKey, 'sk-or-2');
// Denied (no code), wrong state, failed exchange
for (const [q2, code, status] of [['', 'OR_SIGNIN_DECLINED'], ['code=c&state=bad', 'OR_SIGNIN_FAILED'], ['code=c&STATE', 'OR_SIGNIN_FAILED', 403]]) {
  await openrouterSignIn();
  const s2 = session['openrouter.pending'].state;
  serve(JSON.stringify({ error: { message: 'Invalid code' } }), status || 200);
  assert.equal((await openrouterRedirect(7, `${OR_CALLBACK}?${q2.replace('STATE', 'state=' + s2)}`)).code, code);
}
console.log('providers: all passed');
