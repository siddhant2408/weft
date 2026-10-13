import assert from 'node:assert/strict';
let state = {}, session = {}, listener, calls = [];
const clone = structuredClone;
const storage = obj => ({get: async k => k == null ? clone(obj) : Object.fromEntries((Array.isArray(k) ? k : [k]).filter(x => x in obj).map(x => [x, clone(obj[x])])),
 set: async data => Object.assign(obj, clone(data)), remove: async ks => {for (const k of Array.isArray(ks) ? ks : [ks]) delete obj[k];}, setAccessLevel: async () => {}});
globalThis.chrome = {storage: {local: storage(state), session: storage(session)}, sidePanel: {setPanelBehavior: async () => {}},
 runtime: {id: 'test', onMessage: {addListener: fn => listener = fn}, sendNativeMessage: (host, req, cb) => {
  if (req.mirror || req.system.startsWith('You tag')) return setTimeout(() => cb({ok: true, text: ''}));
  calls.push({req, finish: text => cb({ok: true, text})});
 }}, tabs: {sendMessage: async () => ({title: 'Article', text: 'article'})}};
await import('../background.js');
const msg = data => new Promise(resolve => listener(data, {id: 'test', tab: {id: 1}}, resolve));
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 1));} throw Error('timeout');};
const key = 'https://current.test', other = 'https://old.test';
function seed() {
 for (const obj of [state, session]) for (const k in obj) delete obj[k]; calls = [];
 state.settings = {provider: 'cli'};
 state['page:' + key] = {urlKey: key, title: 'Current', summary: {text: 'gist'}, highlights: [{id: 'h', exact: 'MVCC', context: 'context', concepts: ['MVCC'], messages: [], status: 'open'}]};
 state['page:' + other] = {urlKey: other, title: 'Postgres', highlights: [{id: 'old', exact: 'SOURCE_SECRET', context: 'source context', concepts: ['MVCC'], status: 'resolved', takeaway: 'Snapshot isolation', messages: [{role: 'user', content: 'Why?'}, {role: 'assistant', content: 'ANSWER_SECRET'}]}]};
}
const send = text => msg({type: 'thread.send', urlKey: key, id: 'h', text: text || 'Compare MVCC', ask: true});
const run = async (name, fn) => {seed(); await fn(); console.log('PASS', name);};
await run('CLI direct reply sees only index; saves only text; leaves related links available', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 assert.match(calls[0].req.system, /thread_index|R1|Postgres/);
 assert.doesNotMatch(calls[0].req.system, /SOURCE_SECRET|ANSWER_SECRET/);
 calls[0].finish('{"action":"answer","text":"Direct."}'); assert.equal((await pending).ok, true);
 assert.equal(calls.length, 1);
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Compare MVCC', 'Direct.']);
 assert.equal(state['page:' + key].highlights[0].messages.at(-1).refs, undefined);
 assert.deepEqual(session, {});
 assert.equal((await msg({type: 'thread.connections', urlKey: key, id: 'h'})).links[0].id, 'old');
});
await run('CLI read loads fresh source and saves cited final reply, never protocol or excerpts', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 state['page:' + other].highlights[0].messages.at(-1).content = 'FRESH_SOURCE_ANSWER';
 calls[0].finish('{"action":"read","ids":["R1"]}'); await wait(() => calls.length === 2);
 assert.equal(session['phase:h'], 'Checking a related thread…');
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
 const pending = send(); await wait(() => calls.length === 1); calls[0].finish('{"action":"read","ids":["R2"]}'); await wait(() => calls.length === 2);
 calls[1].finish('Second [R2].'); await pending;
 assert.equal(state['page:' + key].highlights[0].messages.at(-1).refs[2].exact, 'SECOND');
});
await run('no candidates uses ordinary CLI call without JSON protocol', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 assert.doesNotMatch(calls[0].req.system, /<thread_index>\n|Return ONLY one JSON/);
 calls[0].finish('Normal answer.'); assert.equal((await pending).ok, true);
});
for (const bad of ['plain text', '{"action":"read","ids":["R9"]}', '{"action":"read","ids":["R1","R1"]}']) {
 await run('invalid protocol fails without loading: ' + bad, async () => {
  const pending = send(); await wait(() => calls.length === 1); calls[0].finish(bad);
  assert.equal((await pending).error.code, 'RETRIEVAL_INVALID'); assert.equal(calls.length, 1);
  assert.equal(state['page:' + key].highlights[0].messages.length, 1); assert.deepEqual(session, {});
 });
}
await run('missing requested source fails instead of using stale candidate snapshot', async () => {
 const pending = send(); await wait(() => calls.length === 1);
 await msg({type: 'page.delete', urlKey: other});
 calls[0].finish('{"action":"read","ids":["R1"]}'); assert.equal((await pending).error.code, 'SOURCE_MISSING');
 assert.equal(calls.length, 1); assert.deepEqual(session, {});
});
for (const [type, urlKey, id] of [['page.delete', key], ['highlight.delete', key, 'h'], ['data.deleteAll', key], ['page.delete', other], ['highlight.delete', other, 'old']]) {
 await run('deletion during final call cancels retrieval: ' + type + ' ' + urlKey, async () => {
  const pending = send(); await wait(() => calls.length === 1); calls[0].finish('{"action":"read","ids":["R1"]}'); await wait(() => calls.length === 2);
  await msg({type, urlKey, id}); calls[1].finish('Late [R1].'); assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal(state['page:' + key]?.highlights[0]?.messages.some(m => m.role === 'assistant') || false, false);
  assert.deepEqual(session, {});
 });
}
await run('old completion cannot clear recreated thread pending or phase', async () => {
 const old = send(); await wait(() => calls.length === 1); calls[0].finish('{"action":"read","ids":["R1"]}'); await wait(() => calls.length === 2);
 await msg({type: 'page.delete', urlKey: key});
 state['page:' + key] = {urlKey: key, title: 'New', highlights: [{id: 'h', exact: 'MVCC', context: '', concepts: ['MVCC'], messages: []}]};
 const fresh = send('Fresh'); await wait(() => calls.length === 3); calls[2].finish('{"action":"read","ids":["R1"]}'); await wait(() => calls.length === 4);
 calls[1].finish('Old [R1].'); await old;
 assert.ok(session['pending:h']); assert.equal(session['phase:h'], 'Checking a related thread…');
 calls[3].finish('New [R1].'); await fresh;
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Fresh', 'New [R1].']); assert.deepEqual(session, {});
});
console.log('CLI retrieval background: all passed');
