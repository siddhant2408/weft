// The reader's notes that follow the article in every thread prompt. Run: node test/reader-notes.test.mjs
import assert from 'node:assert/strict';

const noop = () => {};
globalThis.chrome = {
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { session: { setAccessLevel: async () => {} }, local: {} },
  runtime: { onMessage: { addListener: noop } },
};
const { readerNotes } = await import('../background.js');

const q = (content) => ({ role: 'user', content });
const page = {
  summary: { text: '- a\n- b\n\n**TL;DR:** Work on what you are curious about.' },
  highlights: [
    { id: 'late', start: 90, exact: 'Curiosity is the best guide.', status: 'resolved', takeaway: 'Curiosity beats strategy early on.', messages: [q('why?')] },
    { id: 'early', start: 10, exact: 'The way to figure out what to work on is by working.', status: 'open', takeaway: null, messages: [q('circular?'), { role: 'assistant', content: 'no' }, q('research too?')] },
    { id: 'notes', start: 50, exact: 'Develop a habit.', status: 'open', takeaway: null, messages: [{ role: 'note', content: 'mine' }] },
  ],
};

const n = readerNotes(page, null);
assert.ok(n.startsWith('<reader_notes>') && n.endsWith('</reader_notes>'), n);
assert.ok(!n.includes('Gist'), 'the summary is in the system prompt, not repeated here');
assert.match(n, /Already concluded:\n- Curiosity beats strategy early on\. \(on "Curiosity is the best guide\."\)/);
assert.match(n, /Still open:\n- research too\? \(on "The way to figure/, 'latest question per thread');
assert.ok(!n.includes('circular?'), 'only the latest question');
assert.ok(!n.includes('mine'), 'threads with only notes have no open question');

assert.ok(!readerNotes(page, 'early').includes('research too?'), 'the thread being answered is left out');
assert.equal(readerNotes({ highlights: [] }, null), '', 'nothing to say → no block');
assert.equal(readerNotes(null, null), '');
console.log('reader-notes: all passed');
