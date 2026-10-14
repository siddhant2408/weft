import assert from 'node:assert/strict';
import { connections, graphData, layout, mergeTags, parseConcepts, replyTags, vocabulary } from '../graph.js';

assert.deepEqual(parseConcepts('1. MVCC\n- Row locking.\n* "Postgres"\nmvcc\n\n' + 'x'.repeat(61) + '\nA\nB\nC'), ['MVCC', 'Row locking', 'Postgres', 'A', 'B']);

// Tags at the end of a reply are cut from it; a [[need-page]] after them still ends the reply.
assert.deepEqual(replyTags('Try the V&A.\n[[tags: Art museums | London]]'), { text: 'Try the V&A.', tags: ['Art museums', 'London'] });
assert.deepEqual(replyTags('Need more.\n[[tags: none]]\n[[need-page]]'), { text: 'Need more.\n[[need-page]]', tags: [] });
assert.deepEqual(replyTags('  No tags here. '), { text: 'No tags here.', tags: [] });
// Tags only grow, without duplicates, up to the cap.
assert.deepEqual(mergeTags(['MVCC', 'Databases'], ['databases', 'VACUUM']), ['MVCC', 'Databases', 'VACUUM']);
assert.deepEqual(mergeTags(undefined, ['A']), ['A']);
assert.equal(mergeTags(['1', '2', '3', '4', '5', '6', '7'], ['8', '9', '10']).length, 8);

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
// Once a reply records which threads it was given, the card lists exactly those, read fresh, in that order.
const answered = structuredClone(pages);
answered[0].highlights[0].messages = [{ role: 'assistant', content: 'old', related: [{ urlKey: 'b', id: 'b3' }] },
  { role: 'user', content: 'q' }, { role: 'assistant', content: 'new', related: [{ urlKey: 'b', id: 'b1' }, { urlKey: 'b', id: 'gone' }, { urlKey: 'b', id: 'b2' }] }];
assert.deepEqual(connections(answered, 'a', 'a1').map((l) => [l.id, l.shared]), [['b1', []], ['b2', ['MVCC', 'Row locking']]], 'latest reply wins; deleted threads drop out');
answered[0].highlights[0].messages.push({ role: 'assistant', content: 'none helped', related: [] });
assert.deepEqual(connections(answered, 'a', 'a1'), [], 'a reply given no related threads shows none');
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
