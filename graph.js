// The knowledge graph: threads link when they share a concept. Pure functions over stored pages.
// Concepts come from the model (background.js); matching ignores case and punctuation.
export const norm = (c) => c.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Model output → up to 5 concepts: one per line, bullets and numbering stripped, deduped.
export function parseConcepts(text) {
  const seen = new Set(), out = [];
  for (const line of String(text).split('\n')) {
    const c = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'`]|["'`.]$/g, '').trim();
    const k = norm(c);
    if (!k || c.length > 60 || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length === 5) break;
  }
  return out;
}

// Concepts already in use, most used first: given to the model so it reuses them instead of inventing variants.
export function vocabulary(pages, max = 100) {
  const counts = new Map();
  for (const p of pages) for (const h of p.highlights) for (const c of h.concepts || []) {
    const k = norm(c), e = counts.get(k);
    e ? e.n++ : counts.set(k, { label: c, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).slice(0, max).map((e) => e.label);
}

// Threads on other pages that share a concept with this one, most shared then newest first.
// ponytail: scans every thread per call; fine to thousands, index by concept if it ever lags.
export function connections(pages, urlKey, id, max = 5) {
  const h = pages.find((p) => p.urlKey === urlKey)?.highlights.find((x) => x.id === id);
  if (!h?.concepts?.length) return [];
  const mine = new Map(h.concepts.map((c) => [norm(c), c]));
  const out = [];
  for (const p of pages) {
    if (p.urlKey === urlKey) continue;
    for (const x of p.highlights) {
      const theirs = new Set((x.concepts || []).map(norm));
      const shared = [...mine].filter(([k]) => theirs.has(k)).map(([, c]) => c);
      if (shared.length) out.push({ urlKey: p.urlKey, title: p.title, id: x.id, exact: x.exact, takeaway: x.takeaway, status: x.status, createdAt: x.createdAt, shared });
    }
  }
  return out.sort((a, b) => b.shared.length - a.shared.length || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, max);
}
