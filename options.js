import { getSettings, DEFAULT_MODEL, DEFAULT_SMALL_MODEL } from './providers.js';

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: { code: 'INTERNAL', hint: String(e) } }));

function setStatus(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = 'status ' + cls;
}

// --- Model ---
async function loadModel() {
  const { openrouter: o } = await getSettings();
  $('o-key').value = o.apiKey || '';
  $('o-model').value = o.model || DEFAULT_MODEL;
  $('o-small').value = o.smallModel || DEFAULT_SMALL_MODEL;
}

async function saveModel() {
  const { settings } = await chrome.storage.local.get('settings');
  const { provider, cli, anthropic, openai, ...rest } = settings || {};  // drop retired provider settings and keys
  await chrome.storage.local.set({ settings: { ...rest, openrouter: {
    apiKey: $('o-key').value.trim(), model: $('o-model').value.trim() || DEFAULT_MODEL, smallModel: $('o-small').value.trim() || DEFAULT_SMALL_MODEL,
  } } });
  setStatus('conn', 'Saved', 'ok');
}

for (const id of ['o-key', 'o-model', 'o-small']) $(id).addEventListener('input', () => setStatus('conn', 'Unsaved changes'));
$('m-save').addEventListener('click', saveModel);

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  $('conn-err').replaceChildren();
  await saveModel();
  setStatus('conn', 'Asking the model…');
  const res = await bg({ type: 'provider.check' });
  if (res?.ok) setStatus('conn', `Connected · replied in ${(res.ms / 1000).toFixed(1)} s`, 'ok');
  else {
    setStatus('conn', 'Not connected', 'err');
    $('conn-err').replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: res?.error?.hint || 'Unknown error' }));
  }
  $('test').disabled = false;
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
  Object.assign(document.createElement('a'), { href: url, download: `margin-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

loadModel();
loadExcluded();
renderData();
