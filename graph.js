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

// The graph view's data: concepts shared by at least two of the given threads, and the threads that touch them.
// items: [{page, h}]. Returns {concepts: [{key, label, n}], threads: [{page, h}], edges: [[threadIndex, conceptIndex]]}.
export function graphData(items) {
  const byKey = new Map();
  for (const it of items) for (const k of new Set((it.h.concepts || []).map(norm))) {
    const label = it.h.concepts.find((c) => norm(c) === k);
    byKey.get(k)?.items.push(it) ?? byKey.set(k, { key: k, label, items: [it] });
  }
  const concepts = [...byKey.values()].filter((c) => c.items.length >= 2);
  const threads = [...new Set(concepts.flatMap((c) => c.items))];
  const ix = new Map(threads.map((t, i) => [t, i]));
  const edges = concepts.flatMap((c, ci) => c.items.map((t) => [ix.get(t), ci]));
  return { concepts: concepts.map(({ key, label, items }) => ({ key, label, n: items.length })), threads, edges };
}

// Force-directed layout (Fruchterman–Reingold with a pull to the centre), deterministic: same input, same picture.
// ponytail: O(n²) per step; fine to ~1,500 nodes, switch to a quadtree (d3-force) beyond that.
// mass[i] scales how hard node i pushes others away; hubs get more so their labels don't collide.
export function layout(n, edges, iterations = 300, mass = []) {
  const k = 55;
  const p = Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * 2.4) * 12 * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * 12 * Math.sqrt(i + 1) }));
  let t = 40;
  for (let it = 0; it < iterations; it++) {
    const d = p.map((q) => ({ x: -q.x * 0.04 * k, y: -q.y * 0.04 * k }));  // gravity keeps islands near
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = p[i].x - p[j].x, dy = p[i].y - p[j].y, dist = Math.hypot(dx, dy) || 0.01, f = (k * k * (mass[i] || 1) * (mass[j] || 1)) / dist;
      d[i].x += (dx / dist) * f; d[i].y += (dy / dist) * f; d[j].x -= (dx / dist) * f; d[j].y -= (dy / dist) * f;
    }
    for (const [a, b] of edges) {
      const dx = p[a].x - p[b].x, dy = p[a].y - p[b].y, dist = Math.hypot(dx, dy) || 0.01, f = (dist * dist) / k;
      d[a].x -= (dx / dist) * f; d[a].y -= (dy / dist) * f; d[b].x += (dx / dist) * f; d[b].y += (dy / dist) * f;
    }
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(d[i].x, d[i].y) || 1, step = Math.min(len, t);
      p[i].x += (d[i].x / len) * step; p[i].y += (d[i].y / len) * step;
    }
    t = Math.max(1, t * 0.985);
  }
  return p;
}
