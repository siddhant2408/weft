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

// The comment card's "Related threads": the ones the latest reply was given (stored on it as identities, read fresh
// here), so the card shows what the model saw. Threads answered before that was stored fall back to shared concepts,
// most shared then newest first.
// ponytail: scans every thread per call; fine to thousands, index by concept if it ever lags.
export function connections(pages, urlKey, id, max = 5) {
  const h = pages.find((p) => p.urlKey === urlKey)?.highlights.find((x) => x.id === id);
  if (!h) return [];
  const mine = new Map((h.concepts || []).map((c) => [norm(c), c]));
  const link = (p, x) => {
    const theirs = new Set((x.concepts || []).map(norm));
    const shared = [...mine].filter(([k]) => theirs.has(k)).map(([, c]) => c);
    return { urlKey: p.urlKey, title: p.title, id: x.id, exact: x.exact, takeaway: x.takeaway, status: x.status, createdAt: x.createdAt, messages: x.messages, shared };
  };
  const given = h.messages?.findLast((m) => m.role === 'assistant' && m.related)?.related;
  if (given) return given.flatMap((r) => {
    const p = pages.find((p) => p.urlKey === r.urlKey), x = p?.highlights.find((x) => x.id === r.id);
    return x ? [link(p, x)] : [];
  });
  if (!mine.size) return [];
  const out = [];
  for (const p of pages) {
    if (p.urlKey === urlKey) continue;
    for (const x of p.highlights) {
      const l = link(p, x);
      if (l.shared.length) out.push(l);
    }
  }
  return out.sort((a, b) => b.shared.length - a.shared.length || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, max);
}

// The graph view's data: every tagged thread is a node; two threads are linked when they share concepts.
// items: [{page, h}]. Returns {threads: [{page, h}], edges: [[i, j, sharedLabels]]}.
// ponytail: compares every pair; fine to a few thousand threads.
export function graphData(items) {
  const threads = items.filter((it) => it.h.concepts?.length);
  const keys = threads.map((it) => new Map(it.h.concepts.map((c) => [norm(c), c])));
  const edges = [];
  for (let i = 0; i < threads.length; i++) for (let j = i + 1; j < threads.length; j++) {
    const shared = [...keys[i]].filter(([k]) => keys[j].has(k)).map(([, c]) => c);
    if (shared.length) edges.push([i, j, shared]);
  }
  return { threads, edges };
}

// Force-directed layout (Fruchterman–Reingold with a pull to the centre), deterministic: same input, same picture.
// ponytail: O(n²) per step; fine to ~1,500 nodes, switch to a quadtree (d3-force) beyond that.
// mass[i] scales how hard node i pushes others away; hubs get more so their labels don't collide.
export function layout(n, edges, iterations = 300, mass = []) {
  const k = 110;
  const p = Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * 2.4) * 12 * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * 12 * Math.sqrt(i + 1) }));
  let t = 40;
  for (let it = 0; it < iterations; it++) {
    const d = p.map((q) => ({ x: -q.x * 0.003 * k, y: -q.y * 0.003 * k }));  // gravity keeps islands near
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = p[i].x - p[j].x, dy = p[i].y - p[j].y, dist = Math.hypot(dx, dy) || 0.01, f = (k * k * (mass[i] || 1) * (mass[j] || 1)) / dist;
      d[i].x += (dx / dist) * f; d[i].y += (dy / dist) * f; d[j].x -= (dx / dist) * f; d[j].y -= (dy / dist) * f;
    }
    for (const [a, b] of edges) {
      const dx = p[a].x - p[b].x, dy = p[a].y - p[b].y, dist = Math.hypot(dx, dy) || 0.01, f = (dist * dist) / k / 6;
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
