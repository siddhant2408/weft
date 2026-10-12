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
globalThis.fetch = (url, init) => new Promise(resolve => calls.push({
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
  state['page:' + key] = {urlKey: key, title: 'Article', article: {text: 'OLD ARTICLE'}, summary: null,
    highlights: [{id: 'h', exact: 'passage', context: 'context', start: 0, messages: [], status: 'open'}]};
  calls.length = 0; mirrored.length = 0;
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
  calls[0].finish(); await old;
  assert.ok(session['pending:qa:' + key]);
  assert.deepEqual(state['page:' + key].qa.messages.map(x => x.content), ['new question']);
  calls[1].finish(); await fresh;
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
console.log('background lifecycle: all passed');
