// Comment rail: every thread on the active tab's page, in document order. Storage is the source of truth;
// this panel re-renders from it and sends writes through the background worker.
let tabId = null, urlKey = null, page = null, orphans = [], activeId = null;
const pending = new Set();   // highlight ids waiting on Claude (from storage.session)
// A worker killed mid-request leaves its flag behind; past the host's 120 s timeout it's stale.
const live = (startedAt) => Date.now() - startedAt < 150000;
const drafts = {};           // id → unsent composer text
const errors = {};           // id → {code, hint}
const resolving = {};        // id → {loading} | {text} | {error}
const confirmDelete = new Set();
const changed = {};          // urlKey → page text differs from when the summary was made
// The summary's in-flight flag is per page; highlight ids are globally unique.
const pk = (id) => (id === 'summary' ? 'summary:' + urlKey : id);

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: { code: 'INTERNAL', hint: String(e) } }));
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};
const md = (s) => DOMPurify.sanitize(marked.parse(s));  // LLM output is untrusted HTML (spec T4)

async function setTab(id) {
  tabId = id;
  const s = await chrome.storage.session.get(null);
  ({ urlKey = null, orphans = [] } = s['tab:' + id] || {});
  activeId = s['active:' + id] || null;
  pending.clear();
  for (const k in s) if (k.startsWith('pending:') && live(s[k])) pending.add(k.slice(8));
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

function setActive(id) {
  activeId = id;
  chrome.storage.session.set({ ['active:' + tabId]: id });
  chrome.tabs.sendMessage(tabId, { type: 'highlight.scroll', id }).catch(() => {});
  render();
}

// --- actions ---
async function send(h, ask) {
  const text = (drafts[h.id] || '').trim();
  if (!text && !ask) return;
  drafts[h.id] = '';
  delete errors[h.id];
  if (ask) pending.add(pk(h.id));
  render();
  const res = await bg({ type: 'thread.send', urlKey, id: h.id, text, ask, tabId });
  if (res?.error) { errors[h.id] = res.error; pending.delete(pk(h.id)); }
  render();
}

async function summarise() {
  delete errors.summary;
  pending.add(pk('summary'));
  activeId = 'summary';
  render();
  const res = await bg({ type: 'page.summarise', urlKey, tabId });
  if (res?.error) errors.summary = res.error;
  else changed[urlKey] = false;
  pending.delete(pk('summary'));
  render();
}

async function copyNotes(btn) {
  await navigator.clipboard.writeText(MarginNotes.pageMarkdown(page));
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = 'Copy as notes'; }, 1500);
}

async function startResolve(h) {
  resolving[h.id] = { loading: true };
  render();
  const res = await bg({ type: 'thread.resolve', urlKey, id: h.id });
  resolving[h.id] = res?.error ? { error: res.error, text: '' } : { text: res.draft || '' };
  render();
  document.querySelector('.card.active textarea.takeaway-input')?.focus();
}

async function acceptResolve(h, text) {
  delete resolving[h.id];
  await bg({ type: 'thread.resolve', urlKey, id: h.id, takeaway: text });
}

// --- rendering ---
function header() {
  const hs = page?.highlights || [];
  $('title').textContent = page?.title || 'Margin';
  const open = hs.filter((h) => h.status !== 'resolved').length;
  const takeaways = hs.filter((h) => h.takeaway).length;
  $('meta').textContent = hs.length
    ? `${hs.length} thread${hs.length === 1 ? '' : 's'} · ${takeaways} takeaway${takeaways === 1 ? '' : 's'} · ${open} open`
    : '';
  const busy = pending.has(pk('summary'));
  $('tools').replaceChildren(...(urlKey ? [
    !page?.summary && el('button', { textContent: busy ? 'Summarising…' : 'Summarise page', disabled: busy, onclick: summarise }),
    (hs.length || page?.summary) && el('button', { textContent: 'Copy as notes', onclick: (e) => copyNotes(e.target) }),
  ] : []).filter(Boolean),
  el('button', { textContent: 'All threads', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('threads.html') }) }));
}

function messageView(m) {
  const who = { user: 'You', assistant: 'Claude', note: 'Note' }[m.role];
  const body = el('div', { className: 'body' });
  if (m.role === 'assistant') body.innerHTML = md(m.content);
  else body.textContent = m.content;
  return el('div', { className: 'msg ' + m.role }, el('div', { className: 'who' }, who), body);
}

function composer(h) {
  const busy = pending.has(pk(h.id));
  const ta = el('textarea', {
    placeholder: h.id === 'summary' ? 'Ask about the summary or the page…' : 'Ask about this passage, or jot a note…',
    value: drafts[h.id] || '',
    disabled: busy,
    ariaLabel: 'Message',
  });
  ta.addEventListener('input', () => { drafts[h.id] = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    send(h, e.metaKey || e.ctrlKey);  // ⌘↵ asks Claude, ↵ saves a note
  });
  return el('div', {}, ta,
    el('div', { className: 'row' },
      el('span', { className: 'hint' }, '↵ note · ⌘↵ ask · ⇧↵ newline'),
      el('span', { className: 'spacer' }),
      el('button', { textContent: 'Note', disabled: busy, onclick: () => send(h, false) }),
      el('button', { className: 'primary', textContent: 'Ask Claude', disabled: busy,
        onclick: () => (drafts[h.id] || '').trim() && send(h, true) })));
}

function resolveView(h) {
  const r = resolving[h.id];
  if (r.loading) return el('div', { className: 'thinking' }, 'Drafting a takeaway…');
  const input = el('textarea', { className: 'takeaway-input', value: r.text, placeholder: 'One-line takeaway', ariaLabel: 'Takeaway' });
  input.addEventListener('input', () => { r.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); acceptResolve(h, input.value); }
  });
  return el('div', {},
    r.error && el('div', { className: 'error' }, r.error.hint),
    input,
    el('div', { className: 'row' },
      el('span', { className: 'hint' }, 'Edit if needed, then accept'),
      el('span', { className: 'spacer' }),
      el('button', { textContent: 'Cancel', onclick: () => { delete resolving[h.id]; render(); } }),
      el('button', { className: 'primary', textContent: 'Accept', onclick: () => acceptResolve(h, input.value) })));
}

function actions(h) {
  if (confirmDelete.has(h.id)) {
    return el('div', { className: 'row' },
      el('span', {}, 'Delete this highlight and its thread?'),
      el('span', { className: 'spacer' }),
      el('button', { textContent: 'Keep', onclick: () => { confirmDelete.delete(h.id); render(); } }),
      el('button', { className: 'danger', textContent: 'Delete', onclick: () => {
        confirmDelete.delete(h.id);
        bg({ type: 'highlight.delete', urlKey, id: h.id });
      } }));
  }
  const resolved = h.status === 'resolved';
  return el('div', { className: 'row' },
    el('span', { className: 'spacer' }),
    resolved
      ? el('button', { textContent: 'Reopen', onclick: () => bg({ type: 'thread.reopen', urlKey, id: h.id }) })
      : el('button', { textContent: 'Resolve', disabled: pending.has(pk(h.id)) || !!resolving[h.id], onclick: () => startResolve(h) }),
    el('button', { className: 'danger', textContent: 'Delete', onclick: () => { confirmDelete.add(h.id); render(); } }));
}

function card(h) {
  const active = h.id === activeId;
  const resolved = h.status === 'resolved';
  const c = el('section', {
    className: `card${active ? ' active' : ''}${resolved ? ' resolved' : ''}`,
    tabIndex: active ? -1 : 0,
    ariaLabel: `Thread on: ${h.exact.slice(0, 80)}`,
  });
  if (!active) {
    c.addEventListener('click', () => setActive(h.id));
    c.addEventListener('keydown', (e) => e.key === 'Enter' && setActive(h.id));
  }
  const userMsgs = h.messages.length;
  c.append(
    el('div', { className: 'quote' }, h.exact),
    el('div', { className: 'badges' },
      orphans.includes(h.id) && el('span', { className: 'badge warn' }, 'text not found on page'),
      resolved && el('span', { className: 'badge' }, 'resolved'),
      !active && userMsgs > 0 && el('span', {}, `${userMsgs} message${userMsgs === 1 ? '' : 's'}`),
      !active && pending.has(pk(h.id)) && el('span', {}, 'Claude is replying…')),
    resolved && h.takeaway && el('div', { className: 'takeaway' }, h.takeaway));

  if (active) {
    if (!resolved || h.messages.length) c.append(el('div', { className: 'msgs' }, ...h.messages.map(messageView)));
    if (pending.has(pk(h.id))) c.append(el('div', { className: 'thinking' }, 'Claude is thinking…'));
    if (errors[h.id]) {
      c.append(el('div', { className: 'error' }, errors[h.id].hint,
        el('div', {}, el('button', { textContent: 'Retry', onclick: () => send(h, true) }))));
    }
    if (resolving[h.id]) c.append(resolveView(h));
    else if (!resolved) c.append(composer(h));
    c.append(actions(h));
  }
  return c;
}

// Pinned at the top: the page summary (or its placeholder while it is generated) with its own thread (spec D11).
function summaryCard() {
  const s = page?.summary;
  const busy = pending.has(pk('summary'));
  if (!s && !busy && !errors.summary) return null;
  const active = activeId === 'summary';
  const t = { id: 'summary', messages: s?.messages || [] };
  const c = el('section', { className: `card summary${active ? ' active' : ''}`, tabIndex: active ? -1 : 0, ariaLabel: 'Page summary' });
  if (!active) {
    c.addEventListener('click', () => setActive('summary'));
    c.addEventListener('keydown', (e) => e.key === 'Enter' && setActive('summary'));
  }
  c.append(el('div', { className: 'label' }, 'Page summary'));
  if (!s) {
    c.append(busy ? el('div', { className: 'thinking' }, 'Summarising…') : null,
      errors.summary && el('div', { className: 'error' }, errors.summary.hint,
        el('div', {}, el('button', { textContent: 'Retry', onclick: summarise }))));
    return c;
  }
  const body = el('div', { className: 'msg' }, el('div', { className: 'body' }));
  body.firstChild.innerHTML = MarginNotes.tldr(s.text) && !active ? DOMPurify.sanitize(marked.parseInline(MarginNotes.tldr(s.text))) : md(s.text);
  c.append(body, el('div', { className: 'badges' },
    changed[urlKey] && el('span', { className: 'badge warn' }, 'page changed since summary'),
    !active && t.messages.length > 0 && el('span', {}, `${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`)));
  if (active) {
    if (t.messages.length) c.append(el('div', { className: 'msgs' }, ...t.messages.map(messageView)));
    if (busy) c.append(el('div', { className: 'thinking' }, s ? 'Claude is thinking…' : 'Summarising…'));
    if (errors.summary) {
      c.append(el('div', { className: 'error' }, errors.summary.hint,
        el('div', {}, el('button', { textContent: 'Retry', onclick: () => (t.messages.at(-1)?.role === 'user' ? send(t, true) : summarise()) }))));
    }
    c.append(composer(t), el('div', { className: 'row' }, el('span', { className: 'spacer' }),
      el('button', { textContent: 'Regenerate', disabled: busy, title: 'Re-summarise the current page; clears this thread', onclick: summarise })));
  }
  return c;
}

function render() {
  // keep focus and caret in the active composer across re-renders
  const focused = document.activeElement;
  const refocus = focused?.tagName === 'TEXTAREA' ? { cls: focused.className, pos: focused.selectionStart } : null;

  header();
  const list = $('list');
  if (!urlKey) {
    list.replaceChildren(el('p', { className: 'empty' }, 'Margin isn\'t running on this tab. Open an article, or reload the page if you just installed Margin.'));
    return;
  }
  const hs = [...(page?.highlights || [])].sort((a, b) => a.start - b.start);
  list.replaceChildren(...[
    summaryCard(),
    ...hs.map(card),
    !hs.length && el('p', { className: 'empty' }, 'Select text on the page and click Ask to start a thread.'),
  ].filter(Boolean));

  const ta = document.querySelector('.card.active textarea');
  if (ta && (refocus || !ta.value)) {
    ta.focus();
    if (refocus) ta.setSelectionRange(refocus.pos, refocus.pos);
  }
  document.querySelector('.card.active')?.scrollIntoView({ block: 'nearest' });
}

// --- wiring ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && urlKey && changes['page:' + urlKey]) {
    page = changes['page:' + urlKey].newValue || null;
    render();
  }
  if (area !== 'session') return;
  let dirty = false;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (k === 'tab:' + tabId) { ({ urlKey = null, orphans = [] } = newValue || {}); loadPage(); }
    else if (k === 'active:' + tabId) { activeId = newValue || null; dirty = true; }
    else if (k.startsWith('pending:')) { newValue && live(newValue) ? pending.add(k.slice(8)) : pending.delete(k.slice(8)); dirty = true; }
  }
  if (dirty) render();
});

chrome.windows.getCurrent().then(({ id: windowId }) => {
  chrome.tabs.onActivated.addListener((info) => info.windowId === windowId && setTab(info.tabId));
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab && setTab(tab.id));
