import assert from 'node:assert/strict';
let state = {}, session = {}, listener, calls = [], mirrored = [];
const clone = x => structuredClone(x);
const storage = obj => ({
  get: async k => k == null ? clone(obj) : Object.fromEntries((Array.isArray(k) ? k : [k]).filter(x => x in obj).map(x => [x, clone(obj[x])])),
  set: async data => Object.assign(obj, clone(data)),
  remove: async ks => { for (const k of Array.isArray(ks) ? ks : [ks]) delete obj[k]; },
  setAccessLevel: async () => {},
});
globalThis.chrome = {
  storage: { local: storage(state), session: storage(session) },
  sidePanel: { setPanelBehavior: async () => {} },
  runtime: { id: 'test', onMessage: { addListener: f => listener = f },
    sendNativeMessage: (host, m, cb) => { mirrored.push(m.mirror); setTimeout(() => cb({ok: true})); } },
  tabs: { sendMessage: async () => ({title: 'Article', text: 'LIVE ARTICLE'}) },
};
const tagCalls = [];
let tagReply = '';  // empty → no concepts, no write: keeps other tests' storage and mirror order untouched
const sse = text => new Response(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`);
globalThis.fetch = (url, init) => JSON.parse(init.body).messages[0].content.startsWith('You tag')
  ? (tagCalls.push(JSON.parse(init.body)), Promise.resolve(sse(tagReply)))
  : new Promise(resolve => calls.push({
  body: JSON.parse(init.body),
  finish: () => resolve(new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n')),
}));
await import('../background.js');
const msg = data => new Promise(resolve => listener(data, {id: 'test', tab: {id: 1}}, resolve));
const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); } throw Error('timeout'); };
const key = 'https://example.com/article';
const seed = () => {
  for (const k of Object.keys(state)) delete state[k];
  state.settings = {provider: 'openai', openai: {model: 'test', baseUrl: 'https://example.com/v1'}};
  state['page:' + key] = {urlKey: key, title: 'Article', article: {text: 'OLD ARTICLE'}, summary: {text: 'GIST'},
    highlights: [{id: 'h', exact: 'passage', context: 'context', start: 0, messages: [], status: 'open'}]};
  calls.length = 0; mirrored.length = 0; tagCalls.length = 0; tagReply = '';
};
const send = (id = 'page', text = 'question') => msg({type: 'thread.send', urlKey: key, id, text, ask: true, tabId: 1});
const run = async (name, fn) => { seed(); await fn(); console.log('PASS', name); };
await run('duplicate request is rejected before writing another question', async () => {
  const first = send('h'); await wait(() => calls.length === 1);
  // Observe a wrongly started second call without hanging on its network response.
  let secondResult;
  const second = send('h', 'second').then(r => secondResult = r);
  await wait(() => secondResult || calls.length === 2);
  if (calls.length === 2) calls[1].finish();
  await second;
  calls[0].finish(); await first;
  assert.equal(secondResult?.error?.code, 'BUSY');
  assert.equal(calls.length, 1);
  assert.deepEqual(state['page:' + key].highlights[0].messages.map(x => x.role), ['user', 'assistant']);
});
for (const type of ['page.delete', 'data.deleteAll']) {
  await run(type + ' prevents a late Q&A reply resurrecting data', async () => {
    const first = send(); await wait(() => calls.length === 1);
    await msg({type, urlKey: key});
    assert.equal(state['page:' + key], undefined);
    calls[0].finish(); await first;
    assert.equal(state['page:' + key], undefined);
    assert.equal(session['pending:qa:' + key], undefined);
  });
}
await run('late old completion cannot affect a recreated page or its new pending flag', async () => {
  const old = send(); await wait(() => calls.length === 1);
  await msg({type: 'page.delete', urlKey: key});
  const fresh = send('page', 'new question'); await wait(() => calls.length === 2);
  calls[1].finish(); await wait(() => calls.length === 3);  // the recreated page has no summary: summarise first
  calls[0].finish(); await old;
  assert.ok(session['pending:qa:' + key]);
  assert.deepEqual(state['page:' + key].qa.messages.map(x => x.content), ['new question']);
  calls[2].finish(); await fresh;
  assert.deepEqual(state['page:' + key].qa.messages.map(x => x.content), ['new question', 'answer']);
});
await run('deleting during summary returns cancellation, not an internal error', async () => {
  const summary = msg({type: 'page.summarise', urlKey: key, tabId: 1}); await wait(() => calls.length === 1);
  await msg({type: 'page.delete', urlKey: key});
  calls[0].finish(); const result = await summary;
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(state['page:' + key], undefined);
});
await run('separate threads may run concurrently', async () => {
  const a = send('h'); const b = send(); await wait(() => calls.length === 2);
  calls.forEach(c => c.finish()); await Promise.all([a, b]);
  assert.equal(state['page:' + key].qa.messages.length, 2);
  assert.equal(state['page:' + key].highlights[0].messages.length, 2);
});
await run('highlight deletion cancels only its own request', async () => {
  const a = send('h'); const b = send(); await wait(() => calls.length === 2);
  await msg({type: 'highlight.delete', urlKey: key, id: 'h'});
  assert.equal(session['pending:h'], undefined);
  assert.ok(session['pending:qa:' + key]);
  calls.forEach(c => c.finish()); await Promise.all([a, b]);
  assert.deepEqual(state['page:' + key].highlights, []);
  assert.equal(state['page:' + key].qa.messages.length, 2);
});
await run('failed calls release the lock so retry succeeds', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('offline'); };
  const failed = await send();
  assert.equal(failed.error.code, 'NETWORK');
  assert.equal(session['pending:qa:' + key], undefined);
  globalThis.fetch = original;
  const retry = send('page', ''); await wait(() => calls.length === 1);
  calls[0].finish(); await retry;
  assert.deepEqual(state['page:' + key].qa.messages.map(x => x.role), ['user', 'assistant']);
});
await run('new requests and notes are rejected while delete-all drains writes', async () => {
  const original = chrome.storage.local.remove;
  let unblock;
  chrome.storage.local.remove = async keys => { await new Promise(r => unblock = r); return original(keys); };
  const deletion = msg({type: 'data.deleteAll'}); await wait(() => unblock);
  assert.equal((await send()).error.code, 'CANCELLED');
  assert.equal((await msg({type: 'thread.send', urlKey: key, id: 'page', text: 'note', ask: false})).error.code, 'CANCELLED');
  assert.equal(calls.length, 0);
  unblock(); await deletion;
  chrome.storage.local.remove = original;
  assert.equal(state['page:' + key], undefined);
});
await run('threads send the title, never the page, and the summary only once made', async () => {
  state['page:' + key].summary = null;
  let extracted = 0;
  const original = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (...a) => { extracted++; return original(...a); };
  const first = send('h'); await wait(() => calls.length === 1);
  const sys = calls[0].body.messages[0].content;
  assert.match(sys, /<title>Article<\/title>/);
  assert.doesNotMatch(sys, /OLD ARTICLE|LIVE ARTICLE|<summary>\n/);
  assert.match(calls[0].body.messages.at(-1).content, /<context>context<\/context>/);
  calls[0].finish(); await first;
  assert.equal(extracted, 0);
  state['page:' + key].summary = {text: 'THE GIST'};
  const second = send(); await wait(() => calls.length === 2);
  assert.match(calls[1].body.messages[0].content, /<summary>\nTHE GIST/);
  calls[1].finish(); await second;
  chrome.tabs.sendMessage = original;
});
await run('every page write is mirrored to the native host, in order', async () => {
  await msg({type: 'thread.reopen', urlKey: key, id: 'h'});
  await msg({type: 'page.delete', urlKey: key});
  await wait(() => mirrored.at(-1)?.page === null);  // earlier tests' mirrors may still be draining
  const [save, del] = mirrored.slice(-2);
  assert.equal(save.key, 'page:' + key);
  assert.equal(save.page.highlights[0].status, 'open');
  assert.ok(save.page.updatedAt);
  assert.deepEqual(del, {key: 'page:' + key, page: null});
});
await run('page Q&A without a summary summarises first, then answers with it', async () => {
  state['page:' + key].summary = null;
  const q = send(); await wait(() => calls.length === 1);
  assert.match(calls[0].body.messages[0].content, /LIVE ARTICLE/, 'first call is the summary, reading the live page');
  calls[0].finish(); await wait(() => calls.length === 2);
  assert.match(calls[1].body.messages[0].content, /<summary>\nanswer/);
  calls[1].finish(); await q;
  assert.deepEqual(state['page:' + key].qa.messages.map(x => x.role), ['user', 'assistant']);
});
await run('a "need the page" reply becomes a share button; sharing summarises and re-answers', async () => {
  state['page:' + key].summary = null;
  const original = globalThis.fetch;
  let reply = 'Need the rest.\n[[need-page]]';
  globalThis.fetch = (url, init) => JSON.parse(init.body).messages[0].content.startsWith('You tag') ? original(url, init) : new Promise(resolve => calls.push({ body: JSON.parse(init.body),
    finish: () => resolve(new Response(`data: ${JSON.stringify({choices: [{delta: {content: reply}}]})}\n\ndata: [DONE]\n\n`)) }));
  const first = send('h'); await wait(() => calls.length === 1);
  calls[0].finish(); await first;
  let h = state['page:' + key].highlights[0];
  assert.deepEqual(h.messages.at(-1), {...h.messages.at(-1), content: 'Need the rest.', needsPage: true});
  reply = 'Full answer.';
  const shared = msg({type: 'thread.send', urlKey: key, id: 'h', text: '', ask: true, share: true});
  await wait(() => calls.length === 2); calls[1].finish();  // summary
  await wait(() => calls.length === 3);
  assert.match(calls[2].body.messages[0].content, /<summary>\nFull answer/);
  calls[2].finish(); await shared;
  h = state['page:' + key].highlights[0];
  assert.deepEqual(h.messages.map(x => x.content), ['question', 'Full answer.'], 'the need-page reply is replaced');
  globalThis.fetch = original;
});
await run('first reply tags the thread with concepts, reusing known ones; page Q&A is not tagged', async () => {
  state['page:https://other.com/x'] = {urlKey: 'https://other.com/x', title: 'Other', highlights: [
    {id: 'o', exact: 'other passage', start: 0, messages: [{role: 'assistant', content: 'a'}], concepts: ['MVCC'], status: 'open', createdAt: '2026-01-01'}]};
  tagReply = '- MVCC\n2. Row locking\nmvcc\n';
  const first = send('h'); await wait(() => calls.length === 1); calls[0].finish(); await first;
  await wait(() => state['page:' + key].highlights[0].concepts);
  assert.deepEqual(state['page:' + key].highlights[0].concepts, ['MVCC', 'Row locking']);
  assert.match(tagCalls[0].messages[0].content, /<known_concepts>\nMVCC\n<\/known_concepts>/);
  const res = await msg({type: 'thread.connections', urlKey: key, id: 'h'});
  assert.deepEqual(res.links.map(l => [l.id, l.shared]), [['o', ['MVCC']]]);
  const qa = send(); await wait(() => calls.length === 2); calls[1].finish(); await qa;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(tagCalls.length, 1);
});
console.log('background lifecycle: all passed');
