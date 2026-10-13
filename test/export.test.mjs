import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../notes.js', import.meta.url), 'utf8'), ctx);
const data = ctx.MarginNotes.exportData({
  settings: { openrouter: { apiKey: 'FAKE-SECRET' } },
  chatgpt: { refreshToken: 'FAKE-SECRET', accessToken: 'FAKE-SECRET' },
  unrelated: 'private',
  'page:https://example.com': { urlKey: 'https://example.com', title: 'Article',
    highlights: [{ id: 'h', exact: 'passage', messages: [{ role: 'user', content: 'question', ts: 'now' }] }],
    qa: { messages: [{ role: 'note', content: 'note' }] },
    article: { text: 'Article text', hash: 'hash' }, summary: { text: 'gist' },
    unexpected: 'FAKE-SECRET',
  },
});
const out = JSON.parse(JSON.stringify(data));
assert.equal(out.version, 1);
assert.equal(out.pages.length, 1);
assert.equal(out.pages[0].highlights[0].messages[0].content, 'question');
assert.equal(out.pages[0].qa.messages[0].content, 'note');
assert.equal(out.pages[0].article.text, 'Article text');
assert.ok(!JSON.stringify(out).includes('FAKE-SECRET'));
for (const file of ['options.js', 'threads.js']) {
  assert.match(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /MarginNotes\.exportData\(/);
}
console.log('export: all passed');
