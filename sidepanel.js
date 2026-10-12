// The notebook for the active tab's page. The margin (comment cards on the page) holds the conversations;
// this panel holds what they add up to: the gist, what you've concluded, what's still open, and a thread
// about the page as a whole. It also shows what the model is told about your reading.
// Storage is the source of truth; this panel re-renders from it and sends writes through the background worker.
let tabId = null, urlKey = null, page = null, orphans = [];
let replier = 'Claude';             // who answers, from settings
const pending = new Set();          // pending keys waiting on the model (storage.session)
const streams = {};                 // pending key → partial reply while an API provider streams
// A worker killed mid-request leaves its flag behind; past the 120 s timeout it's stale.
const live = (startedAt) => Date.now() - startedAt < 150000;
const errors = {};                  // 'summary' | 'page' → {code, hint}
const changed = {};                 // urlKey → page text differs from when the summary was made
let showFull = false;               // full summary bullets expanded
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
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  done: '<path d="m3.5 8.5 3 3 6-7" stroke-width="1.6"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
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
    body.innerHTML = md(m.content);
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

// While waiting: the streamed partial reply if the provider streams, else a placeholder.
function thinking(key, label) {
  const partial = streams[key];
  return partial ? messageView({ role: 'assistant', content: partial }, true)
    : el('div', { className: 'msg' }, el('div', { className: 'av ai', textContent: '✦' }), el('div', { className: 'thinking', textContent: label }));
}

const label = (text, n, ...extra) => el('h2', { className: 'label' }, text, n != null && el('span', { className: 'n', textContent: n }), el('span', { className: 'spacer' }), ...extra);
const quote = (h, n = 110) => el('span', { className: 'hl', textContent: h.exact.length > n ? h.exact.slice(0, n - 1) + '…' : h.exact });

function gistView() {
  const s = page?.summary;
  const busy = pending.has(pk('summary'));
  const sec = el('section', { className: 'block gist', ariaLabel: 'Gist' });
  sec.append(label('✦ Gist', null, s && iconBtn('refresh', 'Summarise again', summarise, { disabled: busy })));
  if (busy) {
    const partial = streams[pk('summary')];
    if (partial) { const d = el('div', { className: 'full' }); d.innerHTML = md(partial); d.append(el('span', { className: 'caret' })); sec.append(d); }
    else sec.append(el('p', { className: 'thinking', textContent: 'Summarising the page…' }));
    return sec;
  }
  if (errors.summary) {
    sec.append(el('div', { className: 'error', role: 'alert' }, errors.summary.hint, ' ',
      el('button', { type: 'button', className: 'btn plain', textContent: 'Retry', onclick: summarise })));
  }
  if (!s) {
    sec.append(el('div', { className: 'empty-gist' },
      el('p', { textContent: `A one-line gist and the key points. ${replier} also gets the gist with every question you ask here.` }),
      Object.assign(el('button', { type: 'button', className: 'btn', onclick: summarise }), { innerHTML: `${svg('spark')} Summarise page` })));
    return sec;
  }
  const tldr = MarginNotes.tldr(s.text);
  const p = el('p', { className: 'tldr' });
  p.innerHTML = DOMPurify.sanitize(marked.parseInline(tldr || s.text.split('\n')[0]));
  sec.append(p);
  if (showFull) { const d = el('div', { className: 'full' }); d.innerHTML = md(s.text); sec.append(d); }
  sec.append(el('button', { type: 'button', className: 'btn plain more', textContent: showFull ? 'Hide key points' : 'Show key points',
    ariaExpanded: String(showFull), onclick: () => { showFull = !showFull; render(); } }));
  if (changed[urlKey]) sec.append(el('div', { className: 'warn', textContent: 'The page has changed since this was made. Summarise again to update it.' }));
  return sec;
}

function learnedView(hs) {
  const done = hs.filter((h) => h.status === 'resolved');
  if (!done.length) return null;
  return el('section', { className: 'block', ariaLabel: 'What you learned' },
    label('What you learned', done.length),
    ...done.map((h) => el('button', { type: 'button', className: 'item', title: 'Jump to this passage', onclick: () => jump(h.id) },
      el('div', { className: 'line' },
        el('span', { className: 'mark', textContent: '✓', ariaHidden: 'true' }),
        el('div', { className: 'main', textContent: h.takeaway || 'Resolved without a takeaway' }),
        el('div', { className: 'src' }, quote(h))))));
}

function openView(hs) {
  const open = hs.filter((h) => h.status !== 'resolved');
  const sec = el('section', { className: 'block', ariaLabel: 'Still open' }, label('Still open', open.length));
  if (!open.length) {
    sec.append(el('p', { className: 'hint', textContent: hs.length ? 'Nothing open. Every thread has a takeaway.' : 'Select text on the page to comment on a passage.' }));
    return sec;
  }
  for (const h of open) {
    const q = h.messages.filter((m) => m.role === 'user').at(-1);
    const orphan = orphans.includes(h.id);
    const busy = pending.has(h.id);
    sec.append(el('button', { type: 'button', className: 'item', title: orphan ? 'Show this thread' : 'Jump to this passage',
      ariaExpanded: orphan ? String(openOrphan === h.id) : null,
      onclick: () => (orphan ? (openOrphan = openOrphan === h.id ? null : h.id, confirmOrphanDelete = false, render()) : jump(h.id)) },
    el('div', { className: 'line' },
      el('span', { className: 'mark q', textContent: '?', ariaHidden: 'true' }),
      el('div', { className: 'main' }, q ? el('span', { className: 'q-text', textContent: q.content }) : el('span', { className: 'faint', textContent: h.messages.length ? 'Notes only' : 'No comments yet' })),
      el('div', { className: 'src' }, quote(h)),
      busy && el('div', { className: 'status', textContent: `${replier} is replying…` }),
      orphan && el('div', { className: 'status warn', textContent: 'Text not found on the page. Click to see the thread.' }))));
    if (orphan && openOrphan === h.id) sec.append(orphanView(h));
  }
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

// What the model is told on every question here and in the margin: made visible so it's never a mystery.
function contextLine(hs) {
  const parts = ['the article'];
  if (page?.summary) parts.push('the gist');
  const t = hs.filter((h) => h.takeaway).length;
  const o = hs.filter((h) => h.status !== 'resolved' && h.messages.some((m) => m.role === 'user')).length;
  if (t) parts.push(plural(t, 'takeaway'));
  if (o) parts.push(plural(o, 'open question'));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return el('p', { className: 'context' }, Object.assign(el('span'), { innerHTML: svg('eye') }), `Every question includes ${list}.`);
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
  return { box: el('div', { className: 'composer' }, ta, noteBtn, sendBtn), ta, noteBtn, sendBtn, autosize };
})();

function footer() {
  const busy = pending.has(pk('page'));
  composer.ta.disabled = composer.sendBtn.disabled = busy;
  composer.ta.placeholder = noteMode ? 'Add a note about this page…' : `Ask ${replier} about the whole page…`;
  composer.noteBtn.ariaPressed = String(noteMode);
  composer.sendBtn.title = composer.sendBtn.ariaLabel = noteMode ? 'Save note' : `Ask ${replier}`;
  composer.autosize();
  const del = !page ? null : confirmPageDelete
    ? el('div', { className: 'confirm' }, 'Delete every comment and the gist for this page?',
      el('button', { type: 'button', className: 'btn', textContent: 'Cancel', onclick: () => { confirmPageDelete = false; render(); } }),
      el('button', { type: 'button', className: 'btn danger', textContent: 'Delete', onclick: () => { confirmPageDelete = false; bg({ type: 'page.delete', urlKey }); } }))
    : el('div', { className: 'page-del' }, el('button', { type: 'button', className: 'btn plain', textContent: 'Delete this page\'s comments',
      onclick: () => { confirmPageDelete = true; render(); } }));
  $('foot').replaceChildren(...kids([
    errors.page && el('div', { className: 'error', role: 'alert' }, errors.page.hint, ' ',
      el('button', { type: 'button', className: 'btn plain', textContent: 'Retry', onclick: () => sendPage(true) })),
    composer.box,
    del,
  ]));
}

function header() {
  const hs = page?.highlights || [];
  $('title').textContent = page?.title || (urlKey ? 'This page' : 'Margin');
  let host = '';
  try { host = urlKey ? new URL(urlKey).hostname.replace(/^www\./, '') : ''; } catch {}
  $('host').textContent = [host, hs.length && plural(hs.length, 'comment thread')].filter(Boolean).join(' · ');
  $('tools').replaceChildren(...kids([
    page && (hs.length || page.summary || page.qa) && iconBtn('copy', 'Copy as notes', (e) => copyNotes(e.currentTarget)),
    iconBtn('list', 'All threads', () => chrome.tabs.create({ url: chrome.runtime.getURL('threads.html') })),
    iconBtn('gear', 'Settings', () => chrome.runtime.openOptionsPage()),
  ]));
}

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
  $('list').replaceChildren(...kids([gistView(), learnedView(hs), openView(hs), contextLine(hs), qaView()]));
  footer();
}

// ---------- wiring ----------
function setReplier(settings) {
  const o = settings?.provider === 'openai' && settings.openai?.model;
  replier = o ? o.split('/').pop() : 'Claude';
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
    else if (k.startsWith('pending:')) { newValue && live(newValue) ? pending.add(k.slice(8)) : pending.delete(k.slice(8)); dirty = true; }
  }
  if (dirty) render();
});

chrome.windows.getCurrent().then(({ id: windowId }) => {
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && setTab(info.tabId));
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab && setTab(tab.id));
