// Sign in with ChatGPT: spends the user's paid ChatGPT plan (Go, Plus, Pro) through the Responses API (providers.js streams it).
// OAuth code flow with PKCE and dynamic client registration, per developers.openai.com/siwc/token-sharing-open-source.
// The redirect must be an http://127.0.0.1 loopback. Nothing listens there: the background worker watches the
// sign-in tab and reads the code from its URL as the browser heads there, then closes the tab.
// Credentials live in the extension origin's IndexedDB, not chrome.storage: content scripts can read chrome.storage
// from inside every web page, but IndexedDB is per origin, so only Weft's own pages and worker reach it. Chosen over a
// native host so the extension ships alone; OpenAI advises keeping tokens out of browser storage (README says so).
// JSON exports only include pages, so they never contain tokens.
// ponytail: one saved account; add an account picker when someone needs a second ChatGPT account.

const AUTH = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const PENDING = 'chatgpt.pending';  // storage.session: the sign-in attempt in flight (survives the worker sleeping)

export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const without = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const claims = (jwt) => JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

// One record ("chatgpt") in object store "kv" of database "margin".
function idb(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('margin', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode), req = op(tx.objectStore('kv'));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}

export async function getAuth() {
  return (await idb('readonly', (s) => s.get('chatgpt'))) || {};
}
const setAuth = (auth) => idb('readwrite', (s) => s.put(auth, 'chatgpt'));

// An earlier build kept the credentials in chrome.storage.local; move them here once.
export async function moveFromStorage() {
  const { chatgpt: old } = await chrome.storage.local.get('chatgpt');
  if (!old) return;
  if (!(await getAuth()).clientId) await setAuth(old);
  await chrome.storage.local.remove('chatgpt');
}

// Opens the ChatGPT sign-in tab. The rest happens in handleRedirect when the tab heads to REDIRECT.
export async function signIn() {
  const auth = await getAuth();
  const hostId = auth.hostId || 'urn:uuid:' + crypto.randomUUID();  // stable per install, kept across sign-outs
  if (!auth.hostId) await setAuth({ ...auth, hostId });
  const verifier = random(), state = random(), nonce = random();
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const params = {
    client_id: auth.clientId || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code',
    redirect_uri: REDIRECT, resource: RESOURCE, scope: SCOPE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
  };
  if (!auth.clientId) params.agent_name_hint = 'Weft';  // first registration only
  if (auth.idToken) params.id_token_hint = auth.idToken;  // returning account: skips the account picker
  if (auth.email) params.login_hint = auth.email;
  const tab = await chrome.tabs.create({ url: `${AUTH}/api/accounts/authorize?${new URLSearchParams(params)}` });
  await chrome.storage.session.set({ [PENDING]: { tabId: tab.id, state, nonce, verifier, clientId: auth.clientId || null } });
  return { ok: true };
}

// For tabs.onUpdated (registered at the top level of background.js, so it wakes the worker): when the sign-in tab
// heads to REDIRECT, closes it and finishes signing in. Returns the result, or null for any other tab or URL.
export async function handleRedirect(tabId, url) {
  if (!url?.startsWith(REDIRECT)) return null;
  const pending = (await chrome.storage.session.get(PENDING))[PENDING];
  if (!pending || pending.tabId !== tabId) return null;
  await chrome.storage.session.remove(PENDING);
  chrome.tabs.remove(tabId).catch(() => {});
  return finishSignIn(pending, new URL(url).searchParams);
}

export async function finishSignIn(pending, q) {
  if (q.get('state') !== pending.state) return { ok: false, code: 'SIGNIN_FAILED', detail: 'state mismatch' };
  if (q.get('error')) return { ok: false, code: q.get('error') === 'access_denied' ? 'SIGNIN_DECLINED' : 'SIGNIN_FAILED', detail: q.get('error_description') || q.get('error') };
  const clientId = pending.clientId || q.get('client_id');
  if (!clientId) return { ok: false, code: 'SIGNIN_FAILED', detail: 'no client ID issued' };
  if (pending.clientId && q.get('client_id') && q.get('client_id') !== pending.clientId) return { ok: false, code: 'SIGNIN_FAILED', detail: 'unexpected client ID' };
  const tok = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code: q.get('code'), code_verifier: pending.verifier, redirect_uri: REDIRECT });
  if (!tok.ok) return tok;
  // The ID token came straight from the token endpoint over TLS, so its claims are checked without verifying the
  // signature (OIDC Core 3.1.3.7). ponytail: verify against the JWKS if tokens ever arrive any other way.
  let id;
  try { id = claims(tok.id_token); } catch { return { ok: false, code: 'SIGNIN_FAILED', detail: 'unreadable ID token' }; }
  if (id.iss !== AUTH || ![].concat(id.aud).includes(clientId) || id.nonce !== pending.nonce || id.exp * 1000 < Date.now())
    return { ok: false, code: 'SIGNIN_FAILED', detail: 'ID token did not validate' };
  const auth = await getAuth();
  if (auth.sub && auth.clientId === clientId && auth.sub !== id.sub) return { ok: false, code: 'SIGNIN_FAILED', detail: 'a different ChatGPT account signed in' };
  await setAuth({ ...auth, clientId, sub: id.sub, email: id.email || '', ...tokens(tok) });
  return tok.scopes.includes(PLAN_SCOPE) ? { ok: true, email: id.email || '' } : { ok: false, code: 'PLAN_NOT_GRANTED' };
}

const tokens = (tok) => ({ idToken: tok.id_token, accessToken: tok.access_token, refreshToken: tok.refresh_token,
  expiresAt: Date.now() + tok.expires_in * 1000, scopes: tok.scopes });

async function tokenRequest(form) {
  let res, body;
  try {
    res = await fetch(`${AUTH}/api/accounts/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, resource: RESOURCE }) });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, code: 'NETWORK', detail: String(e?.message || e) };
  }
  if (!res.ok) return { ok: false, code: body.error || `HTTP_${res.status}`, detail: body.error_description || body.detail || '' };
  return { ok: true, ...body, scopes: String(body.scope || '').split(' ') };
}

const UNUSABLE = /^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/;
let refreshing = null;  // one refresh at a time: refresh tokens rotate, so a second concurrent refresh would be "reused"

// A valid access token, refreshed a minute before expiry. {ok, token} | {ok: false, code}.
export async function accessToken() {
  const auth = await getAuth();
  if (!auth.refreshToken) return { ok: false, code: 'SIGNED_OUT' };
  if (!auth.scopes?.includes(PLAN_SCOPE)) return { ok: false, code: 'PLAN_NOT_GRANTED' };
  if (auth.expiresAt - 60000 > Date.now()) return { ok: true, token: auth.accessToken };
  refreshing ||= (async () => {
    const tok = await tokenRequest({ grant_type: 'refresh_token', client_id: auth.clientId, refresh_token: auth.refreshToken });
    if (tok.ok) {
      await setAuth({ ...(await getAuth()), ...tokens({ ...tok, id_token: tok.id_token || auth.idToken, refresh_token: tok.refresh_token || auth.refreshToken }) });
      return { ok: true, token: tok.access_token };
    }
    if (UNUSABLE.test(tok.code)) {  // keep the client ID and host ID for the next sign-in
      await setAuth(without(await getAuth(), 'accessToken', 'refreshToken', 'expiresAt'));
      return { ok: false, code: 'SIGNED_OUT', detail: tok.code };
    }
    return tok;  // network or server trouble: keep the credentials and let the user retry
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Revokes the renewable session, then forgets the tokens. Keeps the client ID, host ID and email for the next sign-in.
export async function signOut() {
  const auth = await getAuth();
  let revoked = !auth.refreshToken;
  if (auth.refreshToken) {
    try {
      const config = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json();
      const res = await fetch(config.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: auth.refreshToken, token_type_hint: 'refresh_token', client_id: auth.clientId }) });
      revoked = res.ok;
    } catch { /* signed out locally anyway; the user can disconnect Weft in ChatGPT settings */ }
  }
  await setAuth(without(auth, 'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'scopes'));
  return { ok: true, revoked };
}

// The account's model catalogue, in the server's order: [{slug, name}].
export async function models() {
  const t = await accessToken();
  if (!t.ok) return t;
  try {
    const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${t.token}` } });
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, detail: (await res.text()).slice(0, 300) };
    const list = ((await res.json()).models || []).filter((m) => m.visibility === 'list').map((m) => ({ slug: m.slug, name: m.display_name || m.slug }));
    return { ok: true, models: list };
  } catch (e) {
    return { ok: false, code: 'NETWORK', detail: String(e?.message || e) };
  }
}

// Default for both model slots: the account's first Luna, else its first model. Plans list different models.
export const defaultModel = (list) => (list?.find((m) => /luna/i.test(m.slug)) || list?.[0])?.slug;
