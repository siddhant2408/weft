import { getSettings, PRESETS, DEFAULT_ANTHROPIC_MODEL, DEFAULT_EFFORT } from './providers.js';

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: { code: 'INTERNAL', hint: String(e) } }));

function setStatus(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = 'status ' + cls;
}

// --- Model provider ---
const radios = () => [...document.querySelectorAll('input[name=provider]')];
const provider = () => radios().find((r) => r.checked)?.value || 'cli';
function showFields() {
  document.querySelectorAll('.fields').forEach((f) => { f.hidden = f.dataset.for !== provider(); });
}

function presetFor(base) {
  return Object.entries(PRESETS).find(([, p]) => p.baseUrl === base)?.[0] || 'custom';
}

async function loadModel() {
  const s = await getSettings();
  radios().forEach((r) => { r.checked = r.value === s.provider; });
  $('c-model').value = s.cli.model || 'opus';
  $('c-effort').value = s.cli.effort || DEFAULT_EFFORT;
  $('a-effort').value = s.anthropic.effort || DEFAULT_EFFORT;
  $('a-key').value = s.anthropic.apiKey || '';
  $('a-model').value = s.anthropic.model || DEFAULT_ANTHROPIC_MODEL;
  const base = s.openai.baseUrl || PRESETS.openrouter.baseUrl;
  $('o-preset').value = presetFor(base);
  $('o-base').value = base;
  $('o-key').value = s.openai.apiKey || '';
  $('o-model').value = s.openai.model || '';
  $('o-base').readOnly = $('o-preset').value !== 'custom';
  showFields();
}

radios().forEach((r) => r.addEventListener('change', () => { showFields(); setStatus('conn', 'Unsaved changes'); }));
$('o-preset').addEventListener('change', () => {
  const p = PRESETS[$('o-preset').value];
  $('o-base').readOnly = !p;
  if (p) $('o-base').value = p.baseUrl;
  else { $('o-base').value = ''; $('o-base').focus(); }
});

// Custom endpoints need a host permission, requested while we still hold the click's user gesture.
async function ensureOrigin(base) {
  let origin;
  try { origin = new URL(base).origin; } catch { return false; }
  if (!/^https?:$/.test(new URL(base).protocol)) return false;
  return chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
}

async function saveModel() {
  const p = provider();
  if (p === 'openai' && !(await ensureOrigin($('o-base').value.trim()))) {
    setStatus('conn', 'Base URL must be http(s) and access must be allowed', 'err');
    return false;
  }
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: {
    ...settings,
    provider: p,
    cli: { model: $('c-model').value, effort: $('c-effort').value },
    anthropic: { apiKey: $('a-key').value.trim(), model: $('a-model').value.trim() || DEFAULT_ANTHROPIC_MODEL, effort: $('a-effort').value },
    openai: { baseUrl: $('o-base').value.trim().replace(/\/+$/, ''), apiKey: $('o-key').value.trim(), model: $('o-model').value.trim() },
  } });
  setStatus('conn', 'Saved', 'ok');
  return true;
}

$('m-save').addEventListener('click', saveModel);

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  $('conn-err').replaceChildren();
  if (await saveModel()) {
    setStatus('conn', 'Asking the model…');
    const res = await bg({ type: 'provider.check' });
    if (res?.ok) setStatus('conn', `Connected · replied in ${(res.ms / 1000).toFixed(1)} s`, 'ok');
    else {
      setStatus('conn', 'Not connected', 'err');
      $('conn-err').replaceChildren(Object.assign(document.createElement('div'), { className: 'error', textContent: res?.error?.hint || 'Unknown error' }));
    }
  }
  $('test').disabled = false;
});

// "Load models" fills the model field's suggestions from the provider's /models endpoint.
async function loadModels(btn, url, headers, list) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Loading…';
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = ((await res.json()).data || []).map((m) => m.id).filter(Boolean).sort();
    $(list).replaceChildren(...ids.map((id) => Object.assign(document.createElement('option'), { value: id })));
    btn.textContent = `${ids.length} models`;
  } catch (e) {
    btn.textContent = `Failed: ${e.message}`;
  }
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
}

$('a-load').addEventListener('click', () => loadModels($('a-load'), 'https://api.anthropic.com/v1/models?limit=100', {
  'x-api-key': $('a-key').value.trim(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
}, 'a-models'));

$('o-load').addEventListener('click', async () => {
  const base = $('o-base').value.trim().replace(/\/+$/, '');
  if (!(await ensureOrigin(base))) return setStatus('conn', 'Base URL must be http(s) and access must be allowed', 'err');
  const key = $('o-key').value.trim();
  loadModels($('o-load'), `${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, 'o-models');
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
