// The notebook for the active tab's page. The margin (comment cards on the page) holds the conversations;
// this panel holds what they add up to: the gist, what you've concluded, what's still open, and a thread
// about the page as a whole. It also shows what the model is told about your reading.
// Storage is the source of truth; this panel re-renders from it and sends writes through the background worker.
let tabId = null, urlKey = null, page = null, orphans = [];
let replier = 'AI';                   // who answers, from settings
const pending = new Set();          // pending keys waiting on the model (storage.session)
const streams = {};                 // pending key → partial reply while the model streams
const phases = {};                  // pending key → retrieval status
// A worker killed mid-request leaves its flag behind; past the 120 s timeout it's stale.
const live = (startedAt) => Date.now() - startedAt < 150000;
const errors = {};                  // 'summary' | 'page' → {code, hint}
const changed = {};                 // urlKey → page text differs from when the summary was made
let showFull = false;               // full summary bullets expanded
const expanded = new Set();        // thread ids whose long passage is shown in full
let openOrphan = null;              // orphaned thread shown inline (it has no passage to jump to)
let confirmOrphanDelete = false, confirmPageDelete = false;
let noteMode = false;               // page composer saves a note instead of asking
const pk = (id) => (id === 'summary' ? 'summary:' + urlKey : id === 'page' ? 'qa:' + urlKey : id);

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: { code: 'INTERNAL', hint: String(e) } }));
const kids = (list) => list.filter((k) => k != null && k !== false && k !== '');
const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids(children));
  return n;
};
const md = (s) => DOMPurify.sanitize(marked.parse(s));  // model output is untrusted HTML (spec T4)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ICON = {
  note: '<path d="M10.8 2.7a1.4 1.4 0 0 1 2 2L6 11.5l-2.7.7.7-2.7Z"/>',
  up: '<path d="M8 12.5v-9m-4 4 4-4 4 4" stroke-width="1.7"/>',
  spark: '<path d="M8 2.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4ZM12.5 10.5c.2 1 .6 1.4 1.5 1.5-1 .2-1.3.6-1.5 1.5-.2-1-.6-1.3-1.5-1.5 1-.1 1.3-.5 1.5-1.5Z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" stroke-width="1.6"/>',
  gear: '<g transform="scale(.6667)" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>',
  done: '<path d="m3.5 8.5 3 3 6-7" stroke-width="1.6"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
};
const svg = (name) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const iconBtn = (name, label, onclick, extra = {}) => {
  const b = el('button', { type: 'button', className: 'icon-btn', title: label, ariaLabel: label, onclick, ...extra });
  b.innerHTML = svg(name);
  return b;
};

// ---------- data ----------
async function setTab(id) {
  tabId = id;
  const s = await chrome.storage.session.get(null);
  ({ urlKey = null, orphans = [] } = s['tab:' + id] || {});
  pending.clear();
  for (const k in s) if (k.startsWith('pending:') && live(s[k])) pending.add(k.slice(8));
  for (const k in s) if (k.startsWith('stream:')) streams[k.slice(7)] = s[k];
  for (const k in s) if (k.startsWith('phase:')) phases[k.slice(6)] = s[k];
  openOrphan = null;
  showFull = false;
  await loadPage();
}

async function loadPage() {
  page = urlKey ? (await chrome.storage.local.get('page:' + urlKey))['page:' + urlKey] || null : null;
  render();
  if (page?.summary && !(urlKey in changed)) checkChanged();
}

async function checkChanged() {
  const key = urlKey;
  changed[key] = false;
  const res = await bg({ type: 'page.changed', urlKey: key, tabId });
  changed[key] = !!res?.changed;
  if (key === urlKey) render();
}

// ---------- actions ----------
const jump = (id) => chrome.tabs.sendMessage(tabId, { type: 'highlight.scroll', id }).catch(() => {});

async function summarise() {
  delete errors.summary;
  pending.add(pk('summary'));
  render();
  const res = await bg({ type: 'page.summarise', urlKey, tabId });
  if (res?.error) errors.summary = res.error;
  else changed[urlKey] = false;
  pending.delete(pk('summary'));
  render();
}

async function sendPage(retry = false) {
  const ta = composer.ta;
  const text = retry ? '' : ta.value.trim();
  const ask = retry || !noteMode;
  if (!text && !retry) return;
  ta.value = '';
  composer.autosize();
  delete errors.page;
  if (ask) pending.add(pk('page'));
  render();
  const res = await bg({ type: 'thread.send', urlKey, id: 'page', text, ask, tabId });
  if (res?.error) { errors.page = res.error; pending.delete(pk('page')); }
  render();
}

async function copyNotes(btn) {
  await navigator.clipboard.writeText(MarginNotes.pageMarkdown(page));
  btn.innerHTML = svg('done');
  btn.title = btn.ariaLabel = 'Copied as notes';
  setTimeout(() => { btn.innerHTML = svg('copy'); btn.title = btn.ariaLabel = 'Copy as notes'; }, 1500);
}

// ---------- views ----------
const ago = (ts) => {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function messageView(m, partial = false) {
  const ai = m.role === 'assistant';
  const body = el('div', { className: 'body' });
  if (ai) {
    body.innerHTML = md(MarginNotes.linkRefs(m.content, m.refs));
    for (const a of body.querySelectorAll('a')) Object.assign(a, { target: '_blank', rel: 'noopener' });
    if (partial) (body.lastElementChild || body).append(el('span', { className: 'caret' }));
  } else body.textContent = m.content;
  return el('div', { className: 'msg' + (m.role === 'note' ? ' note' : '') },
    el('div', { className: 'av' + (ai ? ' ai' : ''), textContent: ai ? '✦' : 'Y', ariaHidden: 'true' }),
    el('div', { className: 'meta' },
      el('span', { className: 'name', textContent: ai ? (m.by || replier) : 'You' }),
      m.role === 'note' && el('span', { className: 'tag', textContent: 'note' }),
      !partial && m.ts && el('span', { className: 'time', textContent: ago(m.ts) })),
    body);
}

// While waiting: the streamed partial reply, else a placeholder.
function thinking(key, label) {
  const partial = streams[key];
  return partial ? messageView({ role: 'assistant', content: partial }, true)
    : el('div', { className: 'msg' }, el('div', { className: 'av ai', textContent: '✦' }), el('div', { className: 'thinking', textContent: phases[key] || label }));
}

const label = (text, n, ...extra) => el('h2', { className: 'label' }, text, n != null && el('span', { className: 'n', textContent: n }), el('span', { className: 'spacer' }), ...extra);

function gistView() {
  const s = page?.summary;
  const busy = pending.has(pk('summary'));
  const outer = el('section', { className: 'block gist', ariaLabel: 'Gist' },
    label('✦ Gist', null, s && iconBtn('refresh', 'Summarise again', summarise, { disabled: busy })));
  const sec = el('div', { className: 'gist-card' });
  outer.append(sec);
  if (busy) {
    const partial = streams[pk('summary')];
    if (partial) { const d = el('div', { className: 'full' }); d.innerHTML = md(partial); d.append(el('span', { className: 'caret' })); sec.append(d); }
    else sec.append(el('p', { className: 'thinking', textContent: 'Summarising the page…' }));
    return outer;
  }
  if (errors.summary) {
    sec.append(el('div', { className: 'error', role: 'alert' }, errors.summary.hint, ' ',
      el('button', { type: 'button', className: 'btn plain', textContent: 'Retry', onclick: summarise })));
  }
  if (!s) {
    sec.append(el('div', { className: 'empty-gist' },
      el('p', { textContent: `A one-line gist and the key points. ${replier} also gets the gist with every question you ask here.` }),
      Object.assign(el('button', { type: 'button', className: 'btn', onclick: summarise }), { innerHTML: `${svg('spark')} Summarise page` })));
    return outer;
  }
  const tldr = MarginNotes.tldr(s.text);
  const p = el('p', { className: 'tldr' });
  p.innerHTML = DOMPurify.sanitize(marked.parseInline(tldr || s.text.split('\n')[0]));
  sec.append(p);
  if (showFull) { const d = el('div', { className: 'full' }); d.innerHTML = md(s.text); sec.append(d); }
  sec.append(el('button', { type: 'button', className: 'btn plain more', textContent: showFull ? 'Hide key points' : 'Show key points',
    ariaExpanded: String(showFull), onclick: () => { showFull = !showFull; render(); } }));
  if (changed[urlKey]) sec.append(el('div', { className: 'warn', textContent: 'The page has changed since this was made. Summarise again to update it.' }));
  return outer;
}

// One thread as a card showing its passage: yellow while open, green once resolved.
const LONG = 180;  // passages past this many characters start clamped, with Show more
function card(h, ...extra) {
  const done = h.status === 'resolved';
  const n = h.messages.length, last = h.messages.at(-1)?.ts;
  const long = h.exact.length > LONG, full = expanded.has(h.id);
  return el('div', { className: 'card' + (done ? ' done' : '') },
    el('button', { type: 'button', title: 'Jump to this passage', onclick: () => jump(h.id) },
      el('div', { className: 'passage' + (long && !full ? ' clamp' : ''), textContent: h.exact }),
      ...extra),
    long && el('button', { type: 'button', className: 'btn plain more', textContent: full ? 'Show less' : 'Show more', ariaExpanded: String(full),
      onclick: () => { full ? expanded.delete(h.id) : expanded.add(h.id); render(); } }),
    n > 0 && el('div', { className: 'meta-line', textContent: plural(n, 'comment') + (last ? ` · ${ago(last)}` : '') }));
}

function learnedView(hs) {
  const done = hs.filter((h) => h.status === 'resolved');
  if (!done.length) return null;
  return el('section', { className: 'block', ariaLabel: 'Resolved' },
    label('Resolved', done.length),
    el('div', { className: 'cards' }, ...done.map((h) => card(h))));
}

function openView(hs) {
  const open = hs.filter((h) => h.status !== 'resolved');
  const sec = el('section', { className: 'block', ariaLabel: 'Open' }, label('Open', open.length));
  if (!open.length) {
    sec.append(el('p', { className: 'hint', textContent: hs.length ? 'Nothing open. Every thread has a takeaway.' : 'Select text on the page to comment on a passage.' }));
    return sec;
  }
  sec.append(el('div', { className: 'cards' }, ...open.map((h) => {
    const orphan = orphans.includes(h.id);
    const c = card(h,
      pending.has(h.id) && el('div', { className: 'status', textContent: `${replier} is replying…` }),
      orphan && el('div', { className: 'status warn', textContent: 'Text not found on the page. Click to see the thread.' }));
    if (orphan) {
      const b = c.firstChild;
      b.title = 'Show this thread';
      b.ariaExpanded = String(openOrphan === h.id);
      b.onclick = () => { openOrphan = openOrphan === h.id ? null : h.id; confirmOrphanDelete = false; render(); };
      if (openOrphan === h.id) c.append(orphanView(h));
    }
    return c;
  })));
  return sec;
}

function orphanView(h) {
  return el('div', { className: 'orphan' },
    ...h.messages.map((m) => messageView(m)),
    el('div', { className: 'row' }, confirmOrphanDelete
      ? el('span', {}, el('button', { type: 'button', className: 'btn', textContent: 'Cancel', onclick: () => { confirmOrphanDelete = false; render(); } }), ' ',
        el('button', { type: 'button', className: 'btn danger', textContent: 'Delete thread', onclick: () => bg({ type: 'highlight.delete', urlKey, id: h.id }) }))
      : el('button', { type: 'button', className: 'btn plain', textContent: 'Delete thread…', onclick: () => { confirmOrphanDelete = true; render(); } })));
}

function qaView() {
  const msgs = page?.qa?.messages || [];
  const busy = pending.has(pk('page'));
  if (!msgs.length && !busy) return null;
  return el('section', { className: 'block qa', ariaLabel: 'About this page' },
    label('About this page', null),
    el('div', { className: 'msgs' }, ...msgs.map((m) => messageView(m)), busy && thinking(pk('page'), `${replier} is thinking…`)));
}

// The page composer is built once so typing survives re-renders (streaming elsewhere re-renders often).
const composer = (() => {
  const ta = el('textarea', { rows: 1, ariaLabel: 'Ask about this page' });
  const noteBtn = iconBtn('note', 'Note only: save without asking', () => { noteMode = !noteMode; render(); ta.focus(); });
  const sendBtn = iconBtn('up', 'Send', () => sendPage());
  sendBtn.className = 'send';
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    sendBtn.classList.toggle('ready', !!ta.value.trim());
  };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPage(); }
  });
  const box = el('div', { className: 'composer' }, ta, noteBtn, sendBtn);
  const err = el('div'), del = el('div');
  $('foot').append(err, box, del);  // mounted once: re-attaching the textarea on every render would steal focus
  return { box, err, del, ta, noteBtn, sendBtn, autosize };
})();

function footer() {
  const busy = pending.has(pk('page'));
  composer.ta.disabled = composer.sendBtn.disabled = busy;
  composer.ta.placeholder = noteMode ? 'Add a note about this page…' : `Ask ${replier} about the whole page…`;
  composer.noteBtn.ariaPressed = String(noteMode);
  composer.sendBtn.title = composer.sendBtn.ariaLabel = noteMode ? 'Save note' : `Ask ${replier}`;
  composer.autosize();
  const del = !page ? '' : confirmPageDelete
    ? el('div', { className: 'confirm' }, 'Delete every comment and the gist for this page?',
      el('button', { type: 'button', className: 'btn', textContent: 'Cancel', onclick: () => { confirmPageDelete = false; render(); } }),
      el('button', { type: 'button', className: 'btn danger', textContent: 'Delete', onclick: () => { confirmPageDelete = false; bg({ type: 'page.delete', urlKey }); } }))
    : el('div', { className: 'page-del' }, el('button', { type: 'button', className: 'btn plain', textContent: 'Delete this page\'s comments',
      onclick: () => { confirmPageDelete = true; render(); } }));
  composer.err.replaceChildren(...kids([errors.page && el('div', { className: 'error', role: 'alert' }, errors.page.hint, ' ',
    el('button', { type: 'button', className: 'btn plain', textContent: 'Retry', onclick: () => sendPage(true) }))]));
  composer.del.replaceChildren(...kids([del]));
}

function header() {
  const hs = page?.highlights || [];
  $('title').textContent = page?.title || (urlKey ? 'This page' : '');
  let host = '';
  try { host = urlKey ? new URL(urlKey).hostname.replace(/^www\./, '') : ''; } catch {}
  $('host').textContent = host;
  const d = hs.filter((h) => h.status === 'resolved').length, o = hs.length - d;
  $('progress').hidden = !hs.length;
  $('progress').replaceChildren(...(hs.length ? [
    el('div', { className: 'bar', role: 'img', ariaLabel: `${d} of ${hs.length} threads resolved` },
      d > 0 && el('span', { className: 'd', style: `flex-grow:${d}` }), o > 0 && el('span', { className: 'o', style: `flex-grow:${o}` })),
    el('div', { className: 'legend' },
      el('span', {}, el('span', { className: 'dot d' }), `${d} resolved`),
      el('span', {}, el('span', { className: 'dot o' }), `${o} open`)),
  ] : []));
  $('tools').replaceChildren(...kids([
    page && (hs.length || page.summary || page.qa) && iconBtn('copy', 'Copy as notes', (e) => copyNotes(e.currentTarget)),
  ]));
}

// Global: not about this page, so they sit in the top bar above it.
$('global').append(
  iconBtn('list', 'All threads', () => chrome.tabs.create({ url: chrome.runtime.getURL('threads.html') })),
  iconBtn('gear', 'Settings', () => chrome.runtime.openOptionsPage()));

function render() {
  header();
  if (!urlKey) {
    $('list').replaceChildren(el('div', { className: 'empty' }, el('b', { textContent: 'Margin isn\'t running on this tab' }),
      'Open an article, or reload the page if you just installed or updated Margin.'));
    $('foot').hidden = true;
    return;
  }
  $('foot').hidden = false;
  const hs = [...(page?.highlights || [])].sort((a, b) => a.start - b.start);
  $('list').replaceChildren(...kids([gistView(), learnedView(hs), openView(hs), qaView()]));
  footer();
}

// ---------- wiring ----------
function setReplier(settings) {
  const m = settings?.openrouter?.model;
  replier = settings?.provider === 'chatgpt' ? settings.chatgpt?.model || 'ChatGPT' : !m || m === 'openrouter/free' ? 'AI' : m.split('/').pop();
}
chrome.storage.local.get('settings').then(({ settings }) => { setReplier(settings); render(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { setReplier(changes.settings.newValue); render(); }
  if (area === 'local' && urlKey && changes['page:' + urlKey]) {
    page = changes['page:' + urlKey].newValue || null;
    render();
  }
  if (area !== 'session') return;
  let dirty = false;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (k === 'tab:' + tabId) { ({ urlKey = null, orphans = [] } = newValue || {}); loadPage(); }
    else if (k.startsWith('stream:')) { if (newValue) streams[k.slice(7)] = newValue; else delete streams[k.slice(7)]; dirty = true; }
    else if (k.startsWith('phase:')) { if (newValue) phases[k.slice(6)] = newValue; else delete phases[k.slice(6)]; dirty = true; }
    else if (k.startsWith('pending:')) { newValue && live(newValue) ? pending.add(k.slice(8)) : pending.delete(k.slice(8)); dirty = true; }
  }
  if (dirty) render();
});

chrome.windows.getCurrent().then(({ id: windowId }) => {
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && setTab(info.tabId));
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab && setTab(tab.id));
