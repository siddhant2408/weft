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
  btn.title = btn.ariaLabel = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => { btn.title = btn.ariaLabel = 'Copy as notes'; btn.classList.remove('copied'); }, 1500);
}

// One thread as a card, like the side panel's: yellow spine while open, green once resolved.
const day = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function item(h, page) {
  const lastQ = h.messages.filter((m) => m.role === 'user').at(-1);
  const n = h.messages.length, last = h.messages.at(-1)?.ts || h.createdAt;
  const resolved = h.status === 'resolved';
  return el('article', { className: 'card' + (resolved ? ' done' : '') },
    el('a', { className: 'passage', href: MarginNotes.fragmentUrl(page.urlKey, h.exact), target: '_blank', rel: 'noopener',
      title: 'Open this passage on its page', textContent: h.exact }),
    h.takeaway ? el('p', { className: 'learned', textContent: h.takeaway })
      : lastQ && el('p', { className: 'ask' }, el('span', { className: 'who', textContent: 'You asked' }), lastQ.content),
    h.concepts?.length && el('div', { className: 'chips' }, ...h.concepts.map((c) =>
      el('button', { className: 'chip', textContent: c, title: `Show threads about ${c}`, onclick: () => showConcept(norm(c)) }))),
    el('div', { className: 'meta-line', textContent: `${n ? `${n} comment${n === 1 ? '' : 's'}` : 'No comments yet'} · ${day(last)}` }));
}

const COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';

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
    return [el('div', { className: 'graph-card' }, el('div', { className: 'empty' }, el('b', { textContent: 'No connections yet' }),
      'Two threads link when they share a concept. Comment on a few related pages and they appear here.'),
      note && el('p', { className: 'graph-note', textContent: note }))];
  }
  const T = g.threads.length;
  const pos = layout(T + g.concepts.length, g.edges.map(([t, c]) => [t, T + c]), 300, [...Array(T).fill(1), ...g.concepts.map(() => 2.5)]);
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
  const legend = el('div', { className: 'graph-legend' },
    el('span', {}, el('span', { className: 'ring' }), `${g.concepts.length} shared concept${g.concepts.length === 1 ? '' : 's'}`),
    el('span', {}, el('span', { className: 'dot o' }), 'Open thread'),
    el('span', {}, el('span', { className: 'dot d' }), 'Resolved thread'));
  return [el('div', { className: 'graph-card' }, legend, svg,
    el('p', { className: 'graph-note', textContent: ['Click a concept to list its threads, or a dot to open its passage.', note].filter(Boolean).join(' ') }))];
}

function setView(v) {
  view = v;
  document.querySelectorAll('.view button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
  render();
}

function render() {
  const total = pages.reduce((n, p) => n + p.highlights.length, 0);
  const resolved = pages.reduce((n, p) => n + p.highlights.filter((h) => h.status === 'resolved').length, 0);
  $('meta').textContent = `${total} thread${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}`;
  const o = total - resolved;
  $('progress').hidden = !total;
  $('progress').replaceChildren(...(total ? [
    el('div', { className: 'bar', role: 'img', ariaLabel: `${resolved} of ${total} threads resolved` },
      resolved > 0 && el('span', { className: 'd', style: `flex-grow:${resolved}` }), o > 0 && el('span', { className: 'o', style: `flex-grow:${o}` })),
    el('div', { className: 'legend' },
      el('span', {}, el('span', { className: 'dot d' }), `${resolved} resolved`),
      el('span', {}, el('span', { className: 'dot o' }), `${o} open`)),
  ] : []));

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
    const copyBtn = el('button', { className: 'icon-btn', title: 'Copy as notes', ariaLabel: 'Copy as notes' });
    copyBtn.innerHTML = COPY;
    copyBtn.addEventListener('click', () => copy(copyBtn, MarginNotes.pageMarkdown(page, hs)));
    sections.push(el('section', { className: 'page' },
      el('div', { className: 'page-head' },
        el('div', { className: 'page-title' },
          el('h2', {}, el('a', { href: page.urlKey, target: '_blank', rel: 'noopener', textContent: page.title || page.urlKey })),
          el('span', { className: 'host', textContent: `${host} · ${hs.length} thread${hs.length === 1 ? '' : 's'}` })),
        copyBtn),
      el('div', { className: 'cards' }, ...hs.map((h) => item(h, page)))));
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
