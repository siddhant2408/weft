import assert from 'node:assert/strict';
import { connections, graphData, layout, parseConcepts, relatedFor, vocabulary } from '../graph.js';

assert.deepEqual(parseConcepts('1. MVCC\n- Row locking.\n* "Postgres"\nmvcc\n\n' + 'x'.repeat(61) + '\nA\nB\nC'), ['MVCC', 'Row locking', 'Postgres', 'A', 'B']);

const h = (id, concepts, createdAt = '2026-01-01') => ({ id, exact: id, concepts, createdAt, messages: [] });
const pages = [
  { urlKey: 'a', title: 'A', highlights: [h('a1', ['MVCC', 'Row locking']), h('a2', ['mvcc'])] },
  { urlKey: 'b', title: 'B', highlights: [h('b1', ['M.V.C.C.']), h('b2', ['row locking', 'MVCC', 'mvcc'], '2026-02-01'), h('b3', ['Other']), h('b4')] },
];
assert.deepEqual(vocabulary(pages, 2), ['MVCC', 'Row locking']);
// Same page excluded; most shared first; duplicates on the other side don't double-count.
assert.deepEqual(connections(pages, 'a', 'a1').map((l) => [l.id, l.shared]), [['b2', ['MVCC', 'Row locking']]]);
assert.deepEqual(connections(pages, 'b', 'b4'), []);
assert.deepEqual(connections(pages, 'a', 'missing'), []);
// Before a thread has concepts, related threads come from known concepts mentioned in its text (whole words only).
const fresh = [...pages, { urlKey: 'c', title: 'C', highlights: [{ id: 'c1', exact: 'new', messages: [] }] }];
assert.deepEqual(relatedFor(fresh, 'c', 'c1', 'How does MVCC relate to row-locking?').map((l) => [l.id, l.shared]),
  [['b2', ['row locking', 'MVCC']], ['a1', ['MVCC', 'Row locking']], ['a2', ['mvcc']]]);
assert.deepEqual(relatedFor(fresh, 'c', 'c1', 'mvccx'), []);
assert.deepEqual(relatedFor(pages, 'a', 'a1', '').map((l) => l.id), ['b2'], 'tagged threads use their concepts');
console.log('graph: all passed');

// Graph view: every tagged thread is a node; pairs sharing concepts are linked, untagged threads left out.
const items = pages.flatMap((page) => page.highlights.map((h) => ({ page, h })));
const g = graphData(items);
assert.deepEqual(g.threads.map((t) => t.h.id), ['a1', 'a2', 'b1', 'b2', 'b3']);
assert.deepEqual(g.edges.map(([i, j, s]) => [g.threads[i].h.id, g.threads[j].h.id, s]),
  [['a1', 'a2', ['MVCC']], ['a1', 'b2', ['MVCC', 'Row locking']], ['a2', 'b2', ['mvcc']]]);
const pos = layout(g.threads.length, g.edges);
assert.deepEqual(pos, layout(5, g.edges), 'deterministic');
assert.ok(pos.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)));
console.log('graph view: all passed');
