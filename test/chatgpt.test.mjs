// Sign in with ChatGPT: sign-in URL, redirect capture, token checks, refresh, sign-out and the Responses stream.
// Fake chrome storage/tabs and a fake auth.openai.com / api.openai.com. Run: node test/chatgpt.test.mjs
import assert from 'node:assert/strict';

const local = {}, session = {}, closed = [], opened = [];
// Minimal IndexedDB: one database, one object store, backed by `vault` (values cloned like the real thing).
const vault = {};
globalThis.indexedDB = { open() {
  const db = { close() {}, transaction() {
    const tx = { objectStore: () => ({
      get: (k) => { const r = { result: structuredClone(vault[k]) }; setTimeout(() => tx.oncomplete()); return r; },
      put: (v, k) => { vault[k] = structuredClone(v); setTimeout(() => tx.oncomplete()); return {}; } }) };
    return tx;
  } };
  const req = { result: db };
  setTimeout(() => req.onsuccess());
  return req;
} };
const area = (obj) => ({ get: async (k) => (k in obj ? { [k]: structuredClone(obj[k]) } : {}), set: async (d) => Object.assign(obj, structuredClone(d)),
  remove: async (k) => { delete obj[k]; } });
globalThis.chrome = { storage: { local: area(local), session: area(session) },
  tabs: { create: async ({ url }) => (opened.push(url), { id: 7 }), remove: async (id) => { closed.push(id); } } };

let routes = {}, seen = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), route = Object.keys(routes).find((r) => u.startsWith(r));
  seen.push({ url: u, init, form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null, json: typeof init.body === 'string' ? JSON.parse(init.body) : null });
  if (!route) throw new TypeError('Failed to fetch ' + u);
  return routes[route](init);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `h.${b64(claims)}.sig`;

const G = await import('../chatgpt.js');
const { ask } = await import('../providers.js');
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';

// 1. First sign-in: dynamic registration URL with PKCE; the pending attempt survives in storage.session.
await G.signIn();
const authUrl = new URL(opened[0]);
const p = Object.fromEntries(authUrl.searchParams);
assert.equal(authUrl.origin + authUrl.pathname, 'https://auth.openai.com/api/accounts/authorize');
assert.equal(p.client_id, 'dynamic_agent_client');
assert.equal(p.agent_name_hint, 'Margin');
assert.equal(p.redirect_uri, 'http://127.0.0.1:1455/auth/callback');
assert.equal(p.resource, 'https://api.openai.com/v1');
assert.match(p.scope, /chatgpt\.tokens\.use\.direct/);
assert.equal(p.code_challenge_method, 'S256');
assert.match(p.ext_agent_host_id, /^urn:uuid:/);
const pending = session['chatgpt.pending'];
assert.equal(pending.tabId, 7);
const { createHash } = await import('node:crypto');
assert.equal(p.code_challenge, createHash('sha256').update(pending.verifier).digest('base64url'), 'challenge is S256 of the verifier');

// 2. Other tabs and URLs are ignored; a wrong state is rejected without a token request.
assert.equal(await G.handleRedirect(8, 'http://127.0.0.1:1455/auth/callback?code=c&state=' + pending.state), null);
assert.equal(await G.handleRedirect(7, 'https://auth.openai.com/u/login'), null);
assert.equal((await G.finishSignIn(pending, new URLSearchParams({ code: 'c', state: 'nope', client_id: 'oaiapp_1' }))).code, 'SIGNIN_FAILED');
assert.equal((await G.finishSignIn(pending, new URLSearchParams({ error: 'access_denied', state: pending.state }))).code, 'SIGNIN_DECLINED');
assert.equal(seen.length, 0);

// 3. Callback: closes the tab, exchanges the code with the issued client ID, checks the ID token, stores the tokens.
const now = Math.floor(Date.now() / 1000);
let idClaims = { iss: 'https://auth.openai.com', aud: 'oaiapp_1', nonce: pending.nonce, exp: now + 3600, sub: 'user-1', email: 'me@example.com' };
const grant = (over = {}) => json({ access_token: 'A1', refresh_token: 'R1', id_token: jwt(idClaims), expires_in: 3600,
  scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke', ...over });
routes = { [TOKEN]: () => grant() };
let res = await G.handleRedirect(7, `http://127.0.0.1:1455/auth/callback?code=CODE&state=${pending.state}&client_id=oaiapp_1`);
assert.deepEqual(res, { ok: true, email: 'me@example.com' });
assert.deepEqual(closed, [7]);
assert.equal(session['chatgpt.pending'], undefined);
assert.deepEqual(seen[0].form, { grant_type: 'authorization_code', client_id: 'oaiapp_1', code: 'CODE', code_verifier: pending.verifier,
  redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1' });
assert.equal(vault.chatgpt.clientId, 'oaiapp_1');
assert.equal(vault.chatgpt.refreshToken, 'R1');
assert.equal(vault.chatgpt.email, 'me@example.com');

// A bad nonce or audience fails; no plan scope signs in but cannot reply.
for (const bad of [{ nonce: 'x' }, { aud: 'someone-else' }, { iss: 'https://evil.example' }]) {
  const saved = idClaims; idClaims = { ...idClaims, ...bad };
  assert.equal((await G.finishSignIn({ ...pending, clientId: null }, new URLSearchParams({ code: 'c', state: pending.state, client_id: 'oaiapp_1' }))).code, 'SIGNIN_FAILED', JSON.stringify(bad));
  idClaims = saved;
}
const before = structuredClone(vault.chatgpt);
routes = { [TOKEN]: () => grant({ scope: 'openid email profile offline_access' }) };
assert.equal((await G.finishSignIn({ ...pending, clientId: 'oaiapp_1' }, new URLSearchParams({ code: 'c', state: pending.state }))).code, 'PLAN_NOT_GRANTED');
assert.equal((await G.accessToken()).code, 'PLAN_NOT_GRANTED');
vault.chatgpt = before;

// 4. Returning sign-in reuses the issued client ID and hints, and drops the registration name.
opened.length = 0;
await G.signIn();
const again = Object.fromEntries(new URL(opened[0]).searchParams);
assert.equal(again.client_id, 'oaiapp_1');
assert.equal(again.agent_name_hint, undefined);
assert.equal(again.login_hint, 'me@example.com');
assert.equal(again.ext_agent_host_id, p.ext_agent_host_id, 'host ID is stable');

// 5. Fresh token is used as is; an expiring one is refreshed once even when asked concurrently.
assert.deepEqual(await G.accessToken(), { ok: true, token: 'A1' });
vault.chatgpt.expiresAt = Date.now() + 30000;
seen = [];
let refreshes = 0;
routes = { [TOKEN]: async () => (refreshes++, await new Promise((r) => setTimeout(r, 5)), grant({ access_token: 'A2', refresh_token: 'R2', id_token: undefined })) };
const both = await Promise.all([G.accessToken(), G.accessToken()]);
assert.deepEqual(both, [{ ok: true, token: 'A2' }, { ok: true, token: 'A2' }]);
assert.equal(refreshes, 1, 'refresh tokens rotate, so only one refresh may run');
assert.deepEqual(seen[0].form, { grant_type: 'refresh_token', client_id: 'oaiapp_1', refresh_token: 'R1', resource: 'https://api.openai.com/v1' });
assert.equal(vault.chatgpt.refreshToken, 'R2');
assert.ok(vault.chatgpt.idToken, 'ID token kept when a refresh omits it');

// 6. Responses API: instructions + input, store false, stream true; text deltas until response.completed.
const sse = (...events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
local.settings = { provider: 'chatgpt', chatgpt: { model: 'gpt-6-luna', smallModel: 'gpt-5.6-luna' } };
routes = { 'https://api.openai.com/v1/responses': () => sse({ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' }, { type: 'response.completed' }) };
seen = [];
const partials = [];
res = await ask({ system: 'SYS', notes: 'NOTES', prompt: 'P' }, (t) => partials.push(t));
assert.deepEqual(res, { ok: true, text: 'Hello' });
assert.deepEqual(partials, ['Hel', 'Hello']);
assert.deepEqual(seen[0].json, { model: 'gpt-6-luna', instructions: 'SYS\n\nNOTES', input: [{ role: 'user', content: 'P' }], store: false, stream: true });
assert.equal(seen[0].init.headers.authorization, 'Bearer A2');
assert.equal(seen[0].json.reasoning, undefined, 'replies keep the model\'s default reasoning');
await ask({ small: true, system: 'S', prompt: 'P' });
assert.equal(seen.at(-1).json.model, 'gpt-5.6-luna');
assert.equal(seen.at(-1).json.text, undefined);
assert.equal(seen.at(-1).json.reasoning, undefined, 'small jobs (tags) keep reasoning');
await ask({ small: true, quick: true, system: 'S', prompt: 'P' });
assert.deepEqual(seen.at(-1).json.reasoning, { effort: 'none' }, 'quick jobs skip reasoning');
// A model that rejects effort "none" is retried once with its default reasoning.
const ok = routes['https://api.openai.com/v1/responses'];
routes['https://api.openai.com/v1/responses'] = (init) => JSON.parse(init.body).reasoning
  ? json({ detail: "Unsupported value: 'none' for reasoning.effort" }, 400) : ok(init);
seen = [];
assert.deepEqual(await ask({ small: true, quick: true, system: 'S', prompt: 'P' }), { ok: true, text: 'Hello' });
assert.deepEqual(seen.map((r) => r.json.reasoning), [{ effort: 'none' }, undefined]);
routes['https://api.openai.com/v1/responses'] = ok;
const schema = { name: 'pick', schema: { type: 'object' } };
await ask({ small: true, system: 'S', prompt: 'P', schema });
assert.deepEqual(seen.at(-1).json.text, { format: { type: 'json_schema', name: 'pick', strict: true, schema: { type: 'object' } } });

// Plan errors: before the stream (HTTP) and mid-stream (response.failed); a stream without completion is incomplete.
routes['https://api.openai.com/v1/responses'] = () => json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }, 429);
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'PLAN_LIMIT');
routes['https://api.openai.com/v1/responses'] = () => json({ detail: 'Unauthorized' }, 401);
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'SIGNED_OUT');
routes['https://api.openai.com/v1/responses'] = () => sse({ type: 'response.output_text.delta', delta: 'x' },
  { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'PLAN_LIMIT');
routes['https://api.openai.com/v1/responses'] = () => sse({ type: 'response.output_text.delta', delta: 'x' });
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'INCOMPLETE');

// 7. Model catalogue: listed models only, server order.
routes['https://api.openai.com/v1/models'] = () => json({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
  { slug: 'hidden', visibility: 'hide' }, { slug: 'gpt-5.6-luna', visibility: 'list' }] });
assert.deepEqual(await G.models(), { ok: true, models: [{ slug: 'gpt-6-luna', name: 'GPT-6 Luna' }, { slug: 'gpt-5.6-luna', name: 'gpt-5.6-luna' }] });
assert.equal(G.defaultModel([{ slug: 'gpt-5.6-terra' }, { slug: 'gpt-6-luna' }]), 'gpt-6-luna');
assert.equal(G.defaultModel([{ slug: 'gpt-5.6-terra' }]), 'gpt-5.6-terra');
assert.equal(G.defaultModel([]), undefined);

// 8. A dead refresh token signs out but keeps the client and host IDs; a network failure keeps everything.
vault.chatgpt.expiresAt = 0;
routes = { [TOKEN]: () => { throw new TypeError('offline'); } };
assert.equal((await G.accessToken()).code, 'NETWORK');
assert.equal(vault.chatgpt.refreshToken, 'R2');
routes = { [TOKEN]: () => json({ error: 'refresh_token_reused' }, 400) };
assert.equal((await G.accessToken()).code, 'SIGNED_OUT');
assert.equal(vault.chatgpt.refreshToken, undefined);
assert.equal(vault.chatgpt.clientId, 'oaiapp_1');
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'SIGNED_OUT');
local.settings.chatgpt = {};
assert.equal((await ask({ system: 'S', prompt: 'P' })).code, 'SIGNED_OUT', 'signed out beats "pick a model"');

// 9. Sign-out revokes the refresh token, then forgets tokens but keeps client/host IDs and email.
vault.chatgpt = { ...vault.chatgpt, refreshToken: 'R3', accessToken: 'A3', idToken: 'I3', expiresAt: Date.now() + 3600000 };
seen = [];
routes = { 'https://auth.openai.com/.well-known/openid-configuration': () => json({ revocation_endpoint: 'https://auth.openai.com/oauth/revoke' }),
  'https://auth.openai.com/oauth/revoke': () => new Response('', { status: 200 }) };
assert.deepEqual(await G.signOut(), { ok: true, revoked: true });
assert.deepEqual(seen[1].form, { token: 'R3', token_type_hint: 'refresh_token', client_id: 'oaiapp_1' });
assert.deepEqual(Object.keys(vault.chatgpt).sort(), ['clientId', 'email', 'hostId', 'sub']);

// 10. Nothing lands in chrome.storage.local, which content scripts can read from inside web pages.
assert.equal(local.chatgpt, undefined);
assert.doesNotMatch(JSON.stringify(local), /R1|R2|R3|A1|A2|A3/);

// 11. Credentials an earlier build kept in chrome.storage.local move to IndexedDB once, then leave storage.
delete vault.chatgpt;
local.chatgpt = { clientId: 'oaiapp_9', refreshToken: 'OLD' };
await G.moveFromStorage();
assert.deepEqual(vault.chatgpt, { clientId: 'oaiapp_9', refreshToken: 'OLD' });
assert.equal(local.chatgpt, undefined);
local.chatgpt = { clientId: 'stale' };
await G.moveFromStorage();
assert.equal(vault.chatgpt.clientId, 'oaiapp_9', 'an existing IndexedDB record wins over a stale copy');
assert.equal(local.chatgpt, undefined);
console.log('chatgpt: all passed');
