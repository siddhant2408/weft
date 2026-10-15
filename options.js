import { getSettings, judgeBy, DEFAULT_MODEL, DEFAULT_SMALL_MODEL, JUDGE_MODEL_OPENROUTER } from './providers.js';
import { getAuth, defaultModel } from './chatgpt.js';

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: { code: 'INTERNAL', hint: String(e) } }));

function setStatus(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = 'status ' + cls;
}

// --- Model ---
const radios = () => [...document.querySelectorAll('input[name=provider]')];
const provider = () => radios().find((r) => r.checked)?.value || 'openrouter';
function showFields() {
  document.querySelectorAll('.fields[data-for]').forEach((f) => { f.hidden = f.dataset.for !== provider(); });
  $('m-save').textContent = provider() === 'chatgpt' ? 'Use ChatGPT' : 'Use OpenRouter';
}

async function loadModel() {
  const s = await getSettings();
  radios().forEach((r) => { r.checked = r.value === s.provider; });
  const o = s.openrouter;
  $('o-key').value = o.apiKey || '';
  showOpenRouter(o.apiKey);
  $('o-model').value = o.model || DEFAULT_MODEL;
  $('o-small').value = o.smallModel || DEFAULT_SMALL_MODEL;
  $('t-key').value = s.typesafe?.apiKey || '';
  showFields();
  loadRelated(s);
  await loadChatGPT(s.chatgpt);
}

// Connected (a saved key, from sign-in or pasted): Disconnect. Not connected: the sign-in button, and a key can be pasted.
function showOpenRouter(key) {
  $('o-signin').hidden = !!key;
  $('o-signout').hidden = !key;
  $('o-paste').hidden = !!key;
  setStatus('o-who', key ? 'Connected' : 'Not connected', key ? 'ok' : '');
  $('j-signin').hidden = !!key;  // Related threads shows the same connection
  setStatus('j-who', key ? 'Connected' : 'Not connected', key ? 'ok' : '');
}

// Signed in: who, plus model pickers filled from the account's catalogue. Signed out: just the sign-in button.
async function loadChatGPT(chosen) {
  const auth = await getAuth();  // same extension origin as the worker, so the same IndexedDB
  const signedIn = !!auth.refreshToken;
  $('g-signin').hidden = signedIn;
  $('g-signout').hidden = !signedIn;
  $('g-models').hidden = true;
  setStatus('g-who', signedIn ? `Signed in as ${auth.email || 'your ChatGPT account'}` : 'Not signed in');
  if (!signedIn) return;
  const res = await bg({ type: 'chatgpt.models' });
  if (!res?.ok) return setStatus('g-who', res?.error?.hint || 'Couldn\'t load your models', 'err');
  for (const [id, value] of [['g-model', chosen.model], ['g-small', chosen.smallModel]]) {
    $(id).replaceChildren(...res.models.map((m) => Object.assign(document.createElement('option'), { value: m.slug, textContent: m.name })));
    $(id).value = res.models.some((m) => m.slug === value) ? value : defaultModel(res.models) || '';
  }
  $('g-models').hidden = false;
}

async function saveModel() {
  const { settings } = await chrome.storage.local.get('settings');
  const { cli, anthropic, openai, ...rest } = settings || {};  // drop retired provider settings and keys
  const next = { ...rest, provider: provider(), openrouter: {
    apiKey: $('o-key').value.trim(), model: $('o-model').value.trim() || DEFAULT_MODEL, smallModel: $('o-small').value.trim() || DEFAULT_SMALL_MODEL,
  } };
  if (!$('g-models').hidden) next.chatgpt = { model: $('g-model').value, smallModel: $('g-small').value };
  await chrome.storage.local.set({ settings: next });
  showOpenRouter(next.openrouter.apiKey);
  setStatus('conn', 'Saved', 'ok');
}

radios().forEach((r) => r.addEventListener('change', () => { showFields(); setStatus('conn', 'Unsaved changes'); }));
for (const id of ['o-key', 'o-model', 'o-small', 'g-model', 'g-small']) $(id).addEventListener('input', () => setStatus('conn', 'Unsaved changes'));

// One sign-in, two buttons: Model and Related threads share the OpenRouter connection.
for (const [btn, who, forReplies] of [['o-signin', 'o-who', true], ['j-signin', 'j-who', false]]) $(btn).addEventListener('click', async () => {
  await chrome.storage.session.remove('openrouter.result');
  const res = await bg({ type: 'openrouter.signin', forReplies });
  setStatus(who, res?.ok ? 'Finish connecting in the OpenRouter tab…' : res?.error?.hint || 'Couldn\'t start sign-in', res?.ok ? '' : 'err');
});
// Forgets the key here. It stays valid at OpenRouter until deleted at openrouter.ai/settings/keys.
$('o-signout').addEventListener('click', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, openrouter: { ...settings?.openrouter, apiKey: '' } } });
  await loadModel();
  setStatus('o-who', 'Disconnected. To revoke the key too, delete it at openrouter.ai/settings/keys.');
});
$('g-signin').addEventListener('click', async () => {
  await chrome.storage.session.remove('chatgpt.result');
  const res = await bg({ type: 'chatgpt.signin' });
  setStatus('g-who', res?.ok ? 'Finish signing in in the ChatGPT tab…' : res?.error?.hint || 'Couldn\'t start sign-in', res?.ok ? '' : 'err');
});
$('g-signout').addEventListener('click', async () => {
  const res = await bg({ type: 'chatgpt.signout' });
  await loadModel();
  if (res?.ok && !res.revoked) setStatus('g-who', 'Signed out here. Couldn\'t confirm with OpenAI: disconnect Weft in ChatGPT settings if needed.', 'err');
});
// The background worker finishes sign-in when the ChatGPT or OpenRouter tab redirects, then reports here.
chrome.storage.onChanged.addListener(async (changes, area) => {
  const o = area === 'session' && changes['openrouter.result']?.newValue;
  if (o) {
    await loadModel();
    if (!o.ok) for (const who of ['o-who', 'j-who']) setStatus(who, o.error?.hint || 'Sign-in failed', 'err');
    return;
  }
  const r = area === 'session' && changes['chatgpt.result']?.newValue;
  if (!r) return;
  await loadModel();
  if (!r.ok) setStatus('g-who', r.error?.hint || 'Sign-in failed', 'err');
});

// One button: saves the choice, then checks it with a short call. A failed check keeps the choice (a free model may
// just be rate-limited for a minute) and says why.
$('m-save').addEventListener('click', async () => {
  $('m-save').disabled = true;
  $('conn-err').replaceChildren();
  await saveModel();
  setStatus('conn', 'Saved · checking the model…');
  const res = await bg({ type: 'provider.check' });
  if (res?.ok) setStatus('conn', `Saved · connected, replied in ${(res.ms / 1000).toFixed(1)} s`, 'ok');
  else {
    setStatus('conn', 'Saved, but the model didn\'t reply', 'err');
    $('conn-err').replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: res?.error?.hint || 'Unknown error' }));
  }
  $('m-save').disabled = false;
});

// "Load models" fills both model fields' suggestions from OpenRouter's public model list.
$('o-load').addEventListener('click', async () => {
  const btn = $('o-load'), label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()).data || []).map((m) => m.id).filter(Boolean).sort();
    $('o-models').replaceChildren(...ids.map((id) => Object.assign(document.createElement('option'), { value: id })));
    btn.textContent = `${ids.length} models`;
  } catch (e) {
    btn.textContent = `Failed: ${e.message}`;
  }
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
});

// --- Related threads ---
const judgeRadios = () => [...document.querySelectorAll('input[name=judge]')];
const judgeChoice = () => judgeRadios().find((r) => r.checked)?.value || 'openrouter';
function showJudge() {
  document.querySelectorAll('.fields[data-judge]').forEach((f) => { f.hidden = f.dataset.judge !== judgeChoice(); });
  $('t-save').textContent = judgeChoice() === 'typesafe' ? 'Use TypeSafe' : 'Use OpenRouter';
}
function loadRelated(s) {
  judgeRadios().forEach((r) => { r.checked = r.value === judgeBy(s); });
  $('j-model').textContent = JUDGE_MODEL_OPENROUTER;
  showJudge();
}
judgeRadios().forEach((r) => r.addEventListener('change', () => { showJudge(); setStatus('t-status', 'Unsaved changes'); }));
$('t-key').addEventListener('input', () => setStatus('t-status', 'Unsaved changes'));

// Like Model: saves the choice, then checks it with one tiny Jev call, and keeps the choice if the check fails.
$('t-save').addEventListener('click', async () => {
  $('t-save').disabled = true;
  $('t-err').replaceChildren();
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, judge: judgeChoice(), typesafe: { apiKey: $('t-key').value.trim() } } });
  setStatus('t-status', 'Saved · checking Jev…');
  const res = await bg({ type: 'judge.check' });
  if (res?.ok) setStatus('t-status', `Saved · Jev replied in ${(res.ms / 1000).toFixed(1)} s`, 'ok');
  else {
    setStatus('t-status', 'Saved, but Jev didn\'t reply', 'err');
    $('t-err').replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: res?.error?.hint || 'Unknown error' }));
  }
  $('t-save').disabled = false;
});

// --- Excluded sites ---
async function loadExcluded() {
  $('excluded').value = (await MarginSettings.get()).excluded.join('\n');
}

$('save').addEventListener('click', async () => {
  const lines = $('excluded').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const excluded = [...new Set(lines.map(MarginSettings.normaliseDomain).filter(Boolean))];
  const bad = lines.filter((l) => !MarginSettings.normaliseDomain(l));
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, excluded } });
  $('excluded').value = excluded.join('\n');
  setStatus('ex-status', bad.length ? `Saved. Skipped ${bad.length} invalid: ${bad.join(', ')}` : `Saved ${excluded.length} sites`, bad.length ? 'err' : 'ok');
});

$('reset').addEventListener('click', () => {
  $('excluded').value = MarginSettings.DEFAULT_EXCLUDED.join('\n');
  setStatus('ex-status', 'Defaults restored. Save to apply.');
});

$('excluded').addEventListener('input', () => setStatus('ex-status', 'Unsaved changes'));

// --- Data ---
async function renderData() {
  const all = await chrome.storage.local.get(null);
  const pages = Object.keys(all).filter((k) => k.startsWith('page:')).map((k) => all[k]);
  const threads = pages.reduce((n, p) => n + p.highlights.length, 0);
  $('counts').textContent = `Currently ${threads} thread${threads === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}.`;
  renderDelete(false, pages.length);
}

function renderDelete(confirming, pageCount) {
  const b = (text, cls, onclick) => Object.assign(document.createElement('button'), { textContent: text, className: `btn ${cls}`, onclick });
  if (!confirming) {
    const del = b('Delete all data…', 'danger', () => renderDelete(true, pageCount));
    del.disabled = !pageCount;
    return $('del').replaceChildren(del);
  }
  $('del').replaceChildren(
    Object.assign(document.createElement('span'), { textContent: 'Delete every highlight, thread and summary? ' }),
    b('Keep', '', () => renderDelete(false, pageCount)),
    b('Delete everything', 'danger', async () => { await bg({ type: 'data.deleteAll' }); renderData(); }));
}

$('export').addEventListener('click', async () => {
  const data = MarginNotes.exportData(await chrome.storage.local.get(null));
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: `weft-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

loadModel();
loadExcluded();
renderData();
