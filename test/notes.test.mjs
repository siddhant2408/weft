// Run: node test/notes.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.runInNewContext(readFileSync(new URL('../notes.js', import.meta.url), 'utf8') + ';this.N = MarginNotes;', ctx);
const N = ctx.N;

assert.equal(N.fragmentUrl('https://a.com/p', 'short self-contained claim'), 'https://a.com/p#:~:text=short%20self%2Dcontained%20claim');
assert.equal(N.fragmentUrl('https://a.com/p', 'one two three four five six seven eight nine ten eleven'),
  'https://a.com/p#:~:text=one%20two%20three%20four%20five,seven%20eight%20nine%20ten%20eleven', 'long passage → start,end');
assert.equal(N.fragmentUrl('https://a.com/p', 'a, b & c'), 'https://a.com/p#:~:text=a%2C%20b%20%26%20c', 'fragment syntax chars escaped');

assert.equal(N.tldr('- one\n- two\n\n**TL;DR:** It is fine.'), 'It is fine.');
assert.equal(N.tldr('TL;DR: plain'), 'plain');
assert.equal(N.tldr('no line'), '');

const md = N.pageMarkdown({
  urlKey: 'https://a.com/p', title: 'Post', summary: { text: '- s\n**TL;DR:** t' },
  highlights: [
    { start: 50, exact: 'second', takeaway: null, messages: [{ role: 'user', content: 'why?' }, { role: 'note', content: 'n1' }] },
    { start: 10, exact: 'first\nline', takeaway: 'got it', messages: [] },
  ],
});
assert.ok(md.startsWith('# [Post](https://a.com/p)'), md);
assert.ok(md.indexOf('> first\n> line') < md.indexOf('> second'), 'document order, multi-line quote');
assert.ok(md.includes('**Takeaway:** got it') && md.includes('**Open question:** why?') && md.includes('- Note: n1'));
assert.ok(md.includes('## Summary'));
console.log('notes: all passed');
