// Sign in with ChatGPT: spends the user's Plus/Pro plan through the Responses API (providers.js streams it).
// The native host does the OAuth flow and keeps the credentials in the macOS Keychain (native-host/chatgpt.py), so the
// 30-day refresh token never enters the browser. The extension only holds a 1-hour access token, in worker memory.

export const RESOURCE = 'https://api.openai.com/v1';
const HOST = 'com.margin.host';

// One request to the native host. A port rather than sendNativeMessage: an open native port keeps the worker alive
// while sign-in waits for the user (up to 5 minutes).
function host(req) {
  return new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(HOST); } catch (e) { return resolve({ ok: false, code: 'HOST_MISSING', detail: String(e?.message || e) }); }
    let done = false;
    port.onMessage.addListener((res) => { done = true; port.disconnect(); resolve(res); });
    port.onDisconnect.addListener(() => {
      if (done) return;
      const err = chrome.runtime.lastError?.message || 'native host exited';
      resolve({ ok: false, code: /not found|forbidden/i.test(err) ? 'HOST_MISSING' : 'HOST_ERROR', detail: err });
    });
    port.postMessage(req);
  });
}

let cached = null;  // {token, expiresAt}: saves a host round-trip per call within the hour

// Opens the ChatGPT sign-in in the default browser and resolves when it finishes: {ok, email} | {ok: false, code}.
export async function signIn() {
  cached = null;
  return host({ chatgpt: 'signin' });
}

// A valid access token: {ok, token} | {ok: false, code}. The host refreshes it when it's about to expire.
export async function accessToken() {
  if (cached && cached.expiresAt - 60000 > Date.now()) return { ok: true, token: cached.token };
  const res = await host({ chatgpt: 'token' });
  if (!res.ok) { cached = null; return res; }
  cached = { token: res.token, expiresAt: res.expiresAt };
  return { ok: true, token: res.token };
}

export const forgetToken = () => { cached = null; };  // after a 401: the next call asks the host again

// {ok, signedIn, email, plan}
export const status = () => host({ chatgpt: 'status' });

export async function signOut() {
  cached = null;
  return host({ chatgpt: 'signout' });
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

// Earlier builds kept the tokens in chrome.storage.local under "chatgpt". Revoke and remove them once.
export async function dropBrowserTokens() {
  const { chatgpt: old } = await chrome.storage.local.get('chatgpt');
  if (!old) return;
  if (old.refreshToken && old.clientId) {
    await fetch('https://auth.openai.com/api/accounts/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: old.refreshToken, token_type_hint: 'refresh_token', client_id: old.clientId }) }).catch(() => {});
  }
  await chrome.storage.local.remove('chatgpt');
}
