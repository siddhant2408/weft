import assert from 'node:assert/strict';
let state = {}, session = {}, listener, calls = [];
const clone = structuredClone;
const storage = obj => ({get: async k => k == null ? clone(obj) : Object.fromEntries((Array.isArray(k) ? k : [k]).filter(x => x in obj).map(x => [x, clone(obj[x])])),
 set: async data => Object.assign(obj, clone(data)), remove: async ks => {for (const k of Array.isArray(ks) ? ks : [ks]) delete obj[k];}, setAccessLevel: async () => {}});
globalThis.chrome = {storage: {local: storage(state), session: storage(session)}, sidePanel: {setPanelBehavior: async () => {}},
 runtime: {id: 'test', onMessage: {addListener: fn => listener = fn}, sendNativeMessage: (host, req, cb) => setTimeout(() => cb({ok: true}))},
 tabs: {onUpdated: {addListener() {}}, sendMessage: async () => ({title: 'Article', text: 'article'})}};
// Fake OpenRouter: each model call waits in `calls` until the test finishes it with the reply text. Tagging replies empty.
const sse = text => new Response(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`);
globalThis.fetch = async (url, init) => {
 const body = JSON.parse(init.body), req = {system: body.messages[0].content, prompt: body.messages[1].content, model: body.model};
 if (req.system.startsWith('You tag')) return sse('');
 return new Promise(resolve => calls.push({req, finish: text => resolve(sse(text))}));
};
await import('../background.js');
const msg = data => new Promise(resolve => listener(data, {id: 'test', tab: {id: 1}}, resolve));
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 1));} throw Error('timeout');};
const key = 'https://current.test', other = 'https://old.test';
function seed() {
 for (const obj of [state, session]) for (const k in obj) delete obj[k]; calls = [];
 state.settings = {openrouter: {apiKey: 'k', model: 'main', smallModel: 'small'}};
 state['page:' + key] = {urlKey: key, title: 'Current', summary: {text: 'gist'}, highlights: [{id: 'h', exact: 'MVCC', context: 'context', concepts: ['MVCC'], messages: [], status: 'open'}]};
 state['page:' + other] = {urlKey: other, title: 'Postgres', highlights: [{id: 'old', exact: 'SOURCE_SECRET', context: 'source context', concepts: ['MVCC'], status: 'resolved', takeaway: 'Snapshot isolation', messages: [{role: 'user', content: 'Why?'}, {role: 'assistant', content: 'ANSWER_SECRET'}]}]};
}
const send = text => msg({type: 'thread.send', urlKey: key, id: 'h', text: text || 'Why does this matter?', ask: true});
const run = async (name, fn) => {seed(); await fn(); console.log('PASS', name);};
await run('ordinary question uses separate small selector; selecting none gives answer no cross-page context', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 assert.match(calls[0].req.system, /thread_index|R1|Postgres/);
 assert.match(calls[0].req.system, /You select/);
 assert.equal(calls[0].req.model, 'small');
 calls[0].finish('{"ids":[]}'); await wait(() => calls.length === 2);
 assert.doesNotMatch(calls[1].req.system, /SOURCE_SECRET|ANSWER_SECRET|<thread_index>\n/);
 assert.equal(calls[1].req.model, 'main');
 calls[1].finish('Direct.'); assert.equal((await pending).ok, true);
 assert.equal(calls.length, 2);
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Why does this matter?', 'Direct.']);
 assert.equal(state['page:' + key].highlights[0].messages.at(-1).refs, undefined);
 assert.deepEqual(session, {});
 assert.equal((await msg({type: 'thread.connections', urlKey: key, id: 'h'})).links[0].id, 'old');
});
await run('selected source is read fresh and saves cited final reply, never protocol or excerpts', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 state['page:' + other].highlights[0].messages.at(-1).content = 'FRESH_SOURCE_ANSWER';
 calls[0].finish('{"ids":["R1"]}'); await wait(() => calls.length === 2);
 assert.equal(session['phase:h'], 'Answering…');
 assert.match(calls[1].req.system, /FRESH_SOURCE_ANSWER|Source passage|Reader-approved takeaway/);
 assert.doesNotMatch(calls[1].req.system, /ANSWER_SECRET/);
 calls[1].finish('Postgres differs [R1].'); assert.equal((await pending).ok, true);
 const m = state['page:' + key].highlights[0].messages.at(-1);
 assert.deepEqual(m.refs, {1: {urlKey: other, exact: 'SOURCE_SECRET', title: 'Postgres'}});
 assert.doesNotMatch(JSON.stringify(state['page:' + key]), /FRESH_SOURCE_ANSWER|action|thread_index/);
 assert.deepEqual(session, {});
});
await run('sparse citation IDs keep their original mapping', async () => {
 state['page:' + other].highlights.push({...clone(state['page:' + other].highlights[0]), id: 'old2', exact: 'SECOND'});
 const pending = send(); await wait(() => calls.length === 1); calls[0].finish('{"ids":["R2"]}'); await wait(() => calls.length === 2);
 calls[1].finish('Second [R2].'); await pending;
 assert.equal(state['page:' + key].highlights[0].messages.at(-1).refs[2].exact, 'SECOND');
});
await run('no candidates uses one ordinary call without the selector', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 assert.doesNotMatch(calls[0].req.system, /<thread_index>\n|Return ONLY one JSON/);
 calls[0].finish('Normal answer.'); assert.equal((await pending).ok, true);
});
await run('replies are saved without leading or trailing blank lines', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 calls[0].finish('\n\nPadded answer.\n'); await pending;
 assert.equal(state['page:' + key].highlights[0].messages.at(-1).content, 'Padded answer.');
});
await run('the answering prompt says to ignore unhelpful related threads silently', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 assert.match(calls[0].req.system, /ignore it silently/);
 calls[0].finish('Ok.'); await pending;
});
for (const bad of ['plain text', '{"ids":["R9"]}', '{"ids":["R1","R1"]}']) {
 await run('invalid protocol fails without loading: ' + bad, async () => {
  const pending = send(); await wait(() => calls.length === 1); calls[0].finish(bad);
  assert.equal((await pending).error.code, 'SELECTION_INVALID'); assert.equal(calls.length, 1);
  assert.equal(state['page:' + key].highlights[0].messages.length, 1); assert.deepEqual(session, {});
 });
}
await run('missing requested source fails instead of using stale candidate snapshot', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 await msg({type: 'page.delete', urlKey: other});
 calls[0].finish('{"ids":["R1"]}'); assert.equal((await pending).error.code, 'SOURCE_MISSING');
 assert.equal(calls.length, 1); assert.deepEqual(session, {});
});
for (const [type, urlKey, id] of [['page.delete', key], ['highlight.delete', key, 'h'], ['data.deleteAll', key], ['page.delete', other], ['highlight.delete', other, 'old']]) {
 await run('deletion during final call cancels retrieval: ' + type + ' ' + urlKey, async () => {
  const pending = send(); await wait(() => calls.length === 1); calls[0].finish('{"ids":["R1"]}'); await wait(() => calls.length === 2);
  await msg({type, urlKey, id}); calls[1].finish('Late [R1].'); assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal(state['page:' + key]?.highlights[0]?.messages.some(m => m.role === 'assistant') || false, false);
  assert.deepEqual(session, {});
 });
}
await run('old completion cannot clear recreated thread pending or phase', async () => {
 const old = send(); await wait(() => calls.length === 1); calls[0].finish('{"ids":["R1"]}'); await wait(() => calls.length === 2);
 await msg({type: 'page.delete', urlKey: key});
 state['page:' + key] = {urlKey: key, title: 'New', highlights: [{id: 'h', exact: 'MVCC', context: '', concepts: ['MVCC'], messages: []}]};
 const fresh = send('Fresh'); await wait(() => calls.length === 3); calls[2].finish('{"ids":["R1"]}'); await wait(() => calls.length === 4);
 calls[1].finish('Old [R1].'); await old;
 assert.ok(session['pending:h']); assert.equal(session['phase:h'], 'Answering…');
 calls[3].finish('New [R1].'); await fresh;
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Fresh', 'New [R1].']); assert.deepEqual(session, {});
});
console.log('retrieval background: all passed');
