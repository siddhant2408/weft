import assert from 'node:assert/strict';
import { connections, graphData, layout, parseConcepts, vocabulary } from '../graph.js';

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
console.log('graph: all passed');

// Graph view: only concepts shared by two or more threads; threads touching none are left out.
const items = pages.flatMap((page) => page.highlights.map((h) => ({ page, h })));
const g = graphData(items);
assert.deepEqual(g.concepts.map((c) => [c.label, c.n]), [['MVCC', 3], ['Row locking', 2]]);
assert.deepEqual(g.threads.map((t) => t.h.id), ['a1', 'a2', 'b2']);
assert.equal(g.edges.length, 5);
const pos = layout(g.threads.length + g.concepts.length, g.edges.map(([t, c]) => [t, g.threads.length + c]));
assert.deepEqual(pos, layout(5, g.edges.map(([t, c]) => [t, 3 + c])), 'deterministic');
assert.ok(pos.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)));
console.log('graph view: all passed');
