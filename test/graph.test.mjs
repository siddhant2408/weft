import assert from 'node:assert/strict';
import { connections, parseConcepts, vocabulary } from '../graph.js';

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
