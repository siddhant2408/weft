// Sign in with ChatGPT, extension side: the native host is faked (its own test is native-host/test_chatgpt.py).
// Covers host messaging, access-token caching, the Responses stream, plan errors and dropping old browser-held tokens.
// Run: node test/chatgpt.test.mjs
import assert from 'node:assert/strict';

const local = {};
const area = (obj) => ({ get: async (k) => (k in obj ? { [k]: structuredClone(obj[k]) } : {}), set: async (d) => Object.assign(obj, structuredClone(d)),
  remove: async (k) => { delete obj[k]; } });
let hostReply = () => ({ ok: true }), hostCalls = [], hostMissing = false;
globalThis.chrome = { storage: { local: area(local) }, runtime: {
  lastError: undefined,
  connectNative(name) {
    if (hostMissing) throw new Error('Specified native messaging host not found.');
    const on = { msg: [], disc: [] };
    return { onMessage: { addListener: (f) => on.msg.push(f) }, onDisconnect: { addListener: (f) => on.disc.push(f) }, disconnect() {},
      postMessage(req) {
        hostCalls.push({ name, req });
        const res = hostReply(req);
        setTimeout(() => (res === null ? on.disc.forEach((f) => f()) : on.msg.forEach((f) => f(res))));
      } };
  } } };

let routes = {}, seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), route = Object.keys(routes).find((r) => u.startsWith(r));
  seen.push({ url: u, init, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null, json: typeof init.body === 'string' ? JSON.parse(init.body) : null });
  if (!route) throw new TypeError('Failed to fetch ' + u);
  return routes[route](init);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const G = await import('../chatgpt.js');
const { ask } = await import('../providers.js');

// 1. Access tokens come from the host and are cached until a minute before expiry.
hostReply = (req) => (req.chatgpt === 'token' ? { ok: true, token: 'A1', expiresAt: Date.now() + 3600000 } : { ok: true });
assert.deepEqual(await G.accessToken(), { ok: true, token: 'A1' });
assert.deepEqual(await G.accessToken(), { ok: true, token: 'A1' });
assert.equal(hostCalls.length, 1, 'cached within the hour');
assert.deepEqual(hostCalls[0], { name: 'com.margin.host', req: { chatgpt: 'token' } });
G.forgetToken();
hostReply = () => ({ ok: true, token: 'A2', expiresAt: Date.now() + 30000 });  // expires within the minute: not cached
await G.accessToken(); await G.accessToken();
assert.equal(hostCalls.length, 3);

// Host errors pass through; a missing host is HOST_MISSING; a host that dies is HOST_ERROR.
G.forgetToken();
hostReply = () => ({ ok: false, code: 'SIGNED_OUT' });
assert.equal((await G.accessToken()).code, 'SIGNED_OUT');
hostMissing = true;
assert.equal((await G.accessToken()).code, 'HOST_MISSING');
hostMissing = false;
hostReply = () => null;
assert.equal((await G.accessToken()).code, 'HOST_ERROR');
hostReply = (req) => ({ ok: true, signedIn: true, email: 'me@example.com', plan: true, req });
assert.equal((await G.status()).email, 'me@example.com');
assert.deepEqual(hostCalls.at(-1).req, { chatgpt: 'status' });
await G.signIn(); assert.deepEqual(hostCalls.at(-1).req, { chatgpt: 'signin' });
await G.signOut(); assert.deepEqual(hostCalls.at(-1).req, { chatgpt: 'signout' });

// 2. Responses API: instructions + input, store false, stream true; text deltas until response.completed.
hostReply = () => ({ ok: true, token: 'A3', expiresAt: Date.now() + 3600000 });
const sse = (...events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
local.settings = { provider: 'chatgpt', chatgpt: { model: 'gpt-6-luna', smallModel: 'gpt-5.6-luna' } };
routes = { 'https://api.openai.com/v1/responses': () => sse({ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' }, { type: 'response.completed' }) };
const partials = [];
let res = await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' }, (t) => partials.push(t));
assert.deepEqual(res, { ok: true, text: 'Hello' });
assert.deepEqual(partials, ['Hel', 'Hello']);
assert.deepEqual(seen.at(-1).json, { model: 'gpt-6-luna', instructions: 'SYS\n\nNOTES', input: [{ role: 'user', content: 'P' }], store: false, stream: true });
assert.equal(seen.at(-1).init.headers.authorization, 'Bearer A3');
await ask({ small: true, system: 'S', prompt: 'P' });
assert.equal(seen.at(-1).json.model, 'gpt-5.6-luna');

// Plan errors before the stream (HTTP) and mid-stream; a stream that never completes is incomplete.
routes['https://api.openai.com/v1/responses'] = () => json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }, 429);
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'PLAN_LIMIT');
routes['https://api.openai.com/v1/responses'] = () => sse({ type: 'response.output_text.delta', delta: 'x' },
  { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'PLAN_LIMIT');
routes['https://api.openai.com/v1/responses'] = () => sse({ type: 'response.output_text.delta', delta: 'x' });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'INCOMPLETE');
// A 401 means the token is dead: report signed out and ask the host again next time.
routes['https://api.openai.com/v1/responses'] = () => json({ detail: 'Unauthorized' }, 401);
const before = hostCalls.length;
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'SIGNED_OUT');
await G.accessToken();
assert.equal(hostCalls.length, before + 1, 'cached token dropped after a 401');

// Not signed in explains a missing model better than "pick a model".
local.settings.chatgpt = {};
G.forgetToken();
hostReply = () => ({ ok: false, code: 'SIGNED_OUT' });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'SIGNED_OUT');
hostReply = () => ({ ok: true, token: 'A4', expiresAt: Date.now() + 3600000 });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'NO_MODEL');

// 3. Model catalogue: listed models only, server order.
routes['https://api.openai.com/v1/models'] = () => json({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
  { slug: 'hidden', visibility: 'hide' }, { slug: 'gpt-5.6-luna', visibility: 'list' }] });
assert.deepEqual(await G.models(), { ok: true, models: [{ slug: 'gpt-6-luna', name: 'GPT-6 Luna' }, { slug: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }] });

// 4. Tokens an earlier build left in extension storage are revoked and removed; nothing else happens without them.
local.chatgpt = { clientId: 'oaiapp_1', refreshToken: 'OLD', accessToken: 'x' };
routes['https://auth.openai.com/api/accounts/oauth/revoke'] = () => new Response('', { status: 200 });
await G.dropBrowserTokens();
assert.deepEqual(seen.at(-1).form, { token: 'OLD', token_type_hint: 'refresh_token', client_id: 'oaiapp_1' });
assert.equal(local.chatgpt, undefined);
const n = seen.length;
await G.dropBrowserTokens();
assert.equal(seen.length, n);
console.log('chatgpt: all passed');
