// Every thread across every page, newest page first. Read-only view over chrome.storage.local.
let pages = [], filter = 'all', query = '';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};

async function load() {
  const all = await chrome.storage.local.get(null);
  pages = Object.entries(all).filter(([k]) => k.startsWith('page:')).map(([, v]) => v)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  render();
}

const matches = (h, page) => {
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
  return el('article', { className: 'item' },
    el('div', { className: 'quote' }, h.exact),
    h.takeaway ? el('div', { className: 'takeaway' }, h.takeaway)
      : lastQ && el('div', { className: 'open-q' }, lastQ.content),
    el('div', { className: 'foot' },
      el('span', {}, h.status === 'resolved' ? 'resolved' : 'open'),
      el('span', {}, `${n} message${n === 1 ? '' : 's'}`),
      el('span', {}, new Date(h.createdAt).toLocaleDateString()),
      el('a', { href: MarginNotes.fragmentUrl(page.urlKey, h.exact), target: '_blank', rel: 'noopener', textContent: 'Open passage ↗' })));
}

function render() {
  const total = pages.reduce((n, p) => n + p.highlights.length, 0);
  const resolved = pages.reduce((n, p) => n + p.highlights.filter((h) => h.status === 'resolved').length, 0);
  $('meta').textContent = `${total} thread${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'} · ${resolved} resolved`;

  const sections = [];
  for (const page of pages) {
    const hs = page.highlights.filter((h) => matches(h, page)).sort((a, b) => a.start - b.start);
    if (!hs.length) continue;
    let host = '';
    try { host = new URL(page.urlKey).hostname.replace(/^www\./, ''); } catch {}
    const copyBtn = el('button', { textContent: 'Copy as notes' });
    copyBtn.addEventListener('click', () => copy(copyBtn, MarginNotes.pageMarkdown(page, hs)));
    sections.push(el('section', { className: 'page' },
      el('div', { className: 'page-head' },
        el('h2', {}, el('a', { href: page.urlKey, target: '_blank', rel: 'noopener', textContent: page.title || page.urlKey }),
          el('span', { className: 'host' }, host)),
        copyBtn),
      ...hs.map((h) => item(h, page))));
  }
  $('list').replaceChildren(...(sections.length ? sections
    : [el('p', { className: 'empty' }, total ? 'No threads match.' : 'No threads yet. Highlight something on a page and click Ask.')]));
}

$('q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  render();
}));
$('export').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(null);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `margin-export-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_, area) => area === 'local' && load());
load();
