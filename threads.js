// Every thread across every page, newest page first, as a list or as a graph of shared concepts.
// Read-only view over chrome.storage.local.
import { graphData, layout, norm } from './graph.js';

let pages = [], filter = 'all', query = '', view = 'list', concept = null;  // concept: norm key filtering the list
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false && k !== ''));
  return n;
};

async function load() {
  const all = await chrome.storage.local.get(null);
  pages = Object.entries(all).filter(([k]) => k.startsWith('page:')).map(([, v]) => v)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  render();
}

const showConcept = (key) => { concept = key; setView('list'); };
const matches = (h, page) => {
  if (concept && !(h.concepts || []).some((c) => norm(c) === concept)) return false;
  if (filter === 'open' && h.status === 'resolved') return false;
  if (filter === 'resolved' && h.status !== 'resolved') return false;
  if (!query) return true;
  const hay = [h.exact, h.takeaway, page.title, ...h.messages.map((m) => m.content)].join('\n').toLowerCase();
  return query.split(/\s+/).every((w) => hay.includes(w));
};

async function copy(btn, text) {
  await navigator.clipboard.writeText(text);
  const label = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = label; }, 1500);
}

function item(h, page) {
  const lastQ = h.messages.filter((m) => m.role === 'user').at(-1);
  const n = h.messages.length;
  const resolved = h.status === 'resolved';
  return el('article', { className: 'item' + (resolved ? ' resolved' : '') },
    el('p', { className: 'quote' }, el('span', { className: 'hl', textContent: h.exact })),
    h.takeaway ? el('div', { className: 'takeaway' }, el('b', { textContent: 'Takeaway' }), h.takeaway)
      : lastQ && el('div', { className: 'msg open-q' }, el('div', { className: 'av', textContent: 'Y', ariaHidden: 'true' }),
        el('div', { className: 'meta' }, el('span', { className: 'name', textContent: 'You' })), el('div', { className: 'body', textContent: lastQ.content })),
    el('div', { className: 'foot' },
      el('span', { textContent: resolved ? 'Resolved' : 'Open' }),
      el('span', { textContent: `${n} comment${n === 1 ? '' : 's'}` }),
      el('span', { textContent: new Date(h.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }),
      el('a', { href: MarginNotes.fragmentUrl(page.urlKey, h.exact), target: '_blank', rel: 'noopener', textContent: 'Open passage ↗' })),
    h.concepts?.length && el('div', { className: 'chips' }, ...h.concepts.map((c) =>
      el('button', { className: 'chip', textContent: c, title: `Threads about ${c}`, onclick: () => showConcept(norm(c)) }))));
}

// Concepts are labelled hubs; threads are dots (yellow open, green resolved) joined to the concepts they share.
const NS = 'http://www.w3.org/2000/svg';
const s_ = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids.filter(Boolean));
  return n;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function graphView(items) {
  const g = graphData(items);
  const untagged = items.filter((it) => !it.h.concepts).length;
  const note = [
    untagged && `${untagged} thread${untagged === 1 ? '' : 's'} not tagged yet (open one's card to tag older threads).`,
    items.length - untagged - g.threads.length > 0 && `${items.length - untagged - g.threads.length} share no concept with another thread yet.`,
  ].filter(Boolean).join(' ');
  if (!g.concepts.length) {
    return [el('div', { className: 'empty' }, el('b', { textContent: 'No connections yet' }),
      'Threads link when two of them share a concept. Keep reading and commenting.'), note && el('p', { className: 'graph-note', textContent: note })];
  }
  const T = g.threads.length;
  const pos = layout(T + g.concepts.length, g.edges.map(([t, c]) => [t, T + c]));
  const xs = pos.map((p) => p.x), ys = pos.map((p) => p.y), pad = 70;
  const box = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
  const svg = s_('svg', { viewBox: box.join(' '), class: 'graph', role: 'img', 'aria-label': `${g.concepts.length} concepts linking ${T} threads` });
  const lines = g.edges.map(([t, c]) => s_('line', { x1: pos[t].x, y1: pos[t].y, x2: pos[T + c].x, y2: pos[T + c].y, 'data-t': t, 'data-c': c }));
  svg.append(s_('g', { class: 'edges' }, ...lines));
  const dots = g.threads.map(({ page, h }, i) => s_('a', { href: MarginNotes.fragmentUrl(page.urlKey, h.exact), target: '_blank', class: 'thread', 'data-t': i },
    s_('title', {}, `${clip(h.takeaway || h.exact, 160)}\n${page.title || page.urlKey}`),
    s_('circle', { cx: pos[i].x, cy: pos[i].y, r: 5, class: h.status === 'resolved' ? 'done' : 'open' })));
  svg.append(s_('g', {}, ...dots));
  const labels = [];  // drawn above every circle so no hub hides another's name
  const hubs = g.concepts.map((c, ci) => {
    const p = pos[T + ci], r = 6 + 3 * Math.sqrt(c.n);
    const hub = s_('g', { class: 'concept', tabindex: 0, role: 'button', 'aria-label': `${c.label}: ${c.n} threads` }, s_('circle', { cx: p.x, cy: p.y, r }));
    const text = s_('text', { x: p.x, y: p.y - r - 5, class: 'label' }, clip(c.label, 28));
    labels.push(text);
    text.addEventListener('click', () => showConcept(c.key));
    hub.addEventListener('click', () => showConcept(c.key));
    hub.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showConcept(c.key); } });
    // Hovering a concept dims everything it isn't joined to.
    const near = new Set(g.edges.filter(([, x]) => x === ci).map(([t]) => t));
    const focus = (on) => {
      svg.classList.toggle('focusing', on);
      for (const l of lines) l.classList.toggle('lit', on && +l.dataset.c === ci);
      for (const d of dots) d.classList.toggle('lit', on && near.has(+d.dataset.t));
      hub.classList.toggle('lit', on);
      text.classList.toggle('lit', on);
    };
    for (const n of [hub, text]) { n.addEventListener('mouseenter', () => focus(true)); n.addEventListener('mouseleave', () => focus(false)); }
    hub.addEventListener('focus', () => focus(true));
    hub.addEventListener('blur', () => focus(false));
    return hub;
  });
  svg.append(s_('g', {}, ...hubs), s_('g', {}, ...labels));
  return [svg, el('p', { className: 'graph-note', textContent: ['Click a concept to see its threads, a dot to open its passage.', note].filter(Boolean).join(' ') })];
}

function setView(v) {
  view = v;
  document.querySelectorAll('.view button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
  render();
}

function render() {
  const total = pages.reduce((n, p) => n + p.highlights.length, 0);
  const resolved = pages.reduce((n, p) => n + p.highlights.filter((h) => h.status === 'resolved').length, 0);
  $('meta').textContent = `${total} thread${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'} · ${resolved} resolved`;

  const filtered = pages.flatMap((page) => page.highlights.filter((h) => matches(h, page)).map((h) => ({ page, h })));
  const label = concept && filtered.flatMap((it) => it.h.concepts || []).find((c) => norm(c) === concept);
  $('concept').replaceChildren(...(concept ? [el('button', { className: 'chip on', title: 'Clear concept filter', textContent: `${label || concept} ×`,
    onclick: () => { concept = null; render(); } })] : []));
  if (view === 'graph') { $('list').replaceChildren(...graphView(filtered).filter(Boolean)); return; }

  const sections = [];
  for (const page of pages) {
    const hs = page.highlights.filter((h) => matches(h, page)).sort((a, b) => a.start - b.start);
    if (!hs.length) continue;
    let host = '';
    try { host = new URL(page.urlKey).hostname.replace(/^www\./, ''); } catch {}
    const copyBtn = el('button', { className: 'btn plain', textContent: 'Copy as notes' });
    copyBtn.addEventListener('click', () => copy(copyBtn, MarginNotes.pageMarkdown(page, hs)));
    sections.push(el('section', { className: 'page' },
      el('div', { className: 'page-head' },
        el('h2', {}, el('a', { href: page.urlKey, target: '_blank', rel: 'noopener', textContent: page.title || page.urlKey }),
          el('span', { className: 'host' }, host)),
        copyBtn),
      ...hs.map((h) => item(h, page))));
  }
  $('list').replaceChildren(...(sections.length ? sections
    : [el('div', { className: 'empty' }, el('b', { textContent: total ? 'No threads match' : 'No comments yet' }), total ? 'Try another word, or switch the filter.' : 'Select text on any page to start a comment thread.')]));
}

$('q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
document.querySelectorAll('.seg[aria-label=Filter] button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('.seg[aria-label=Filter] button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
document.querySelectorAll('.view button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
$('export').addEventListener('click', async () => {
  const data = MarginNotes.exportData(await chrome.storage.local.get(null));
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `margin-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_, area) => area === 'local' && load());
load();
