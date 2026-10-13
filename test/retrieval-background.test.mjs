import assert from 'node:assert/strict';
let state = {}, session = {}, listener, calls = [], jevCalls = [], noul = 0.9, holdJev = false, tagReply = '';
const clone = structuredClone;
const storage = obj => ({get: async k => k == null ? clone(obj) : Object.fromEntries((Array.isArray(k) ? k : [k]).filter(x => x in obj).map(x => [x, clone(obj[x])])),
 set: async data => Object.assign(obj, clone(data)), remove: async ks => {for (const k of Array.isArray(ks) ? ks : [ks]) delete obj[k];}, setAccessLevel: async () => {}});
globalThis.chrome = {storage: {local: storage(state), session: storage(session)}, sidePanel: {setPanelBehavior: async () => {}},
 runtime: {id: 'test', onMessage: {addListener: fn => listener = fn}, sendNativeMessage: (host, req, cb) => setTimeout(() => cb({ok: true}))},
 tabs: {onUpdated: {addListener() {}}, sendMessage: async () => ({title: 'Article', text: 'article'})}};
// Fake OpenRouter: each model call waits in `calls` until the test finishes it with the reply text. Tagging replies `tagReply`.
// Fake TypeSafe: answers `noul` (or a function of the candidate), or waits in `jevCalls` while `holdJev`.
const sse = text => new Response(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`);
const jevReply = (body, n) => typeof n === 'number' ? Response.json({answers: {helps: {type: 'noul', noul: n}}}) : new Response('down', {status: 500});
globalThis.fetch = async (url, init) => {
 const body = JSON.parse(init.body);
 if (String(url).startsWith('https://api.typesafe.ai/')) {
  const call = {url, body, headers: init.headers};
  if (holdJev) return new Promise(resolve => jevCalls.push({...call, finish: n => resolve(jevReply(body, n))}));
  jevCalls.push(call);
  return jevReply(body, typeof noul === 'function' ? noul(body.state.candidate) : noul);
 }
 const req = {system: body.messages[0].content, prompt: body.messages[1].content, model: body.model};
 if (req.system.startsWith('You tag')) return sse(tagReply);
 return new Promise(resolve => calls.push({req, finish: text => resolve(sse(text))}));
};
await import('../background.js');
const msg = data => new Promise(resolve => listener(data, {id: 'test', tab: {id: 1}}, resolve));
const wait = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 1));} throw Error('timeout');};
const key = 'https://current.test', other = 'https://old.test';
function seed() {
 for (const obj of [state, session]) for (const k in obj) delete obj[k]; calls = []; jevCalls = []; noul = 0.9; holdJev = false; tagReply = '';
 state.settings = {openrouter: {apiKey: 'k', model: 'main', smallModel: 'small'}, typesafe: {apiKey: 'ts-key'}};
 state.conceptsVersion = 2;
 state['page:' + key] = {urlKey: key, title: 'Current', summary: {text: 'gist'}, highlights: [{id: 'h', exact: 'MVCC', context: 'context', concepts: ['MVCC'], messages: [], status: 'open'}]};
 state['page:' + other] = {urlKey: other, title: 'Postgres', highlights: [{id: 'old', exact: 'SOURCE_SECRET', context: 'source context', concepts: ['MVCC'], status: 'resolved', takeaway: 'Snapshot isolation', messages: [{role: 'user', content: 'Why?'}, {role: 'assistant', content: 'ANSWER_SECRET'}]}]};
}
const send = text => msg({type: 'thread.send', urlKey: key, id: 'h', text: text || 'Why does this matter?', ask: true});
const lastReply = () => state['page:' + key].highlights[0].messages.at(-1);
const run = async (name, fn) => {seed(); await fn(); console.log('PASS', name);};
await run('Jev rejecting every candidate gives one plain answer with no cross-page context', async () => {
 noul = 0.1;
 const pending = send(); await wait(() => calls.length === 1);
 assert.equal(jevCalls.length, 1);
 assert.doesNotMatch(calls[0].req.system, /SOURCE_SECRET|ANSWER_SECRET|<related_threads>\n/);
 assert.equal(calls[0].req.model, 'main');
 calls[0].finish('Direct.'); assert.equal((await pending).ok, true);
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Why does this matter?', 'Direct.']);
 assert.equal(lastReply().refs, undefined); assert.deepEqual(lastReply().related, []);
 assert.deepEqual(session, {});
 assert.deepEqual((await msg({type: 'thread.connections', urlKey: key, id: 'h'})).links, [], 'the card shows what the reply was given');
});
await run('Jev sees one candidate per request; the picked source is read fresh and the cited reply saved', async () => {
 holdJev = true;
 const pending = send(); await wait(() => jevCalls.length === 1);
 const j = jevCalls[0];
 assert.equal(j.body.model, 'jev-latest'); assert.equal(j.headers.authorization, 'Bearer ts-key');
 assert.equal(j.body.state.candidate.passage, 'SOURCE_SECRET'); assert.equal(j.body.state.current.question, 'Why does this matter?');
 assert.equal(j.body.questions.helps.type, 'noul');
 assert.equal(session['phase:h'], 'Finding relevant context…');
 state['page:' + other].highlights[0].messages.at(-1).content = 'FRESH_SOURCE_ANSWER';
 j.finish(0.8); await wait(() => calls.length === 1);
 assert.equal(session['phase:h'], 'Answering…');
 assert.match(calls[0].req.system, /FRESH_SOURCE_ANSWER|Source passage|Reader-approved takeaway/);
 assert.doesNotMatch(calls[0].req.system, /ANSWER_SECRET/);
 calls[0].finish('Postgres differs [R1].'); assert.equal((await pending).ok, true);
 assert.deepEqual(lastReply().refs, {1: {urlKey: other, exact: 'SOURCE_SECRET', title: 'Postgres'}});
 assert.deepEqual(lastReply().related, [{urlKey: other, id: 'old'}]);
 assert.doesNotMatch(JSON.stringify(state['page:' + key]), /FRESH_SOURCE_ANSWER|noul/);
 assert.deepEqual((await msg({type: 'thread.connections', urlKey: key, id: 'h'})).links.map(l => [l.id, l.shared]), [['old', ['MVCC']]]);
 assert.deepEqual(session, {});
});
await run('refs follow Jev\'s order, best first, and cap at three', async () => {
 for (const n of [2, 3, 4]) state['page:' + other].highlights.push({...clone(state['page:' + other].highlights[0]), id: 'old' + n, exact: 'SOURCE_' + n});
 noul = c => ({SOURCE_SECRET: 0.6, SOURCE_2: 0.2, SOURCE_3: 0.95, SOURCE_4: 0.7})[c.passage];
 const pending = send(); await wait(() => calls.length === 1);
 assert.equal(jevCalls.length, 4);
 calls[0].finish('Best [R1], third [R3].'); await pending;
 assert.deepEqual(lastReply().related.map(r => r.id), ['old3', 'old4', 'old']);
 assert.equal(lastReply().refs[1].exact, 'SOURCE_3'); assert.equal(lastReply().refs[3].exact, 'SOURCE_SECRET');
});
for (const [name, setup] of [['no TypeSafe key', () => { delete state.settings.typesafe; }], ['a failed Jev call', () => { noul = null; }]]) {
 await run(`${name} falls back to the shortlist's top three`, async () => {
  setup();
  const pending = send(); await wait(() => calls.length === 1);
  assert.match(calls[0].req.system, /SOURCE_SECRET/);
  calls[0].finish('Fallback [R1].'); assert.equal((await pending).ok, true);
  assert.deepEqual(lastReply().related, [{urlKey: other, id: 'old'}]);
 });
}
await run('no thread sharing a tag means no Jev call', async () => {
 state['page:' + other].highlights[0].concepts = ['Raft'];
 const pending = send(); await wait(() => calls.length === 1);
 assert.equal(jevCalls.length, 0); assert.doesNotMatch(calls[0].req.system, /<related_threads>\n/);
 calls[0].finish('Normal answer.'); assert.equal((await pending).ok, true);
});
await run('an untagged thread is tagged from its question before its first reply, then finds related threads', async () => {
 delete state['page:' + key].highlights[0].concepts; tagReply = 'MVCC';
 const pending = send(); await wait(() => calls.length === 1);
 assert.deepEqual(state['page:' + key].highlights[0].concepts, ['MVCC']);
 assert.equal(jevCalls.length, 1); assert.match(calls[0].req.system, /SOURCE_SECRET/);
 calls[0].finish('Tagged first.'); assert.equal((await pending).ok, true);
});
await run('replies are saved without leading or trailing blank lines', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 calls[0].finish('\n\nPadded answer.\n'); await pending;
 assert.equal(lastReply().content, 'Padded answer.');
});
await run('the answering prompt says to ignore unhelpful related threads silently', async () => {
 delete state['page:' + other]; const pending = send(); await wait(() => calls.length === 1);
 assert.match(calls[0].req.system, /ignore it silently/);
 calls[0].finish('Ok.'); await pending;
});
await run('a source deleted while Jev scores fails instead of using a stale snapshot', async () => {
 holdJev = true;
 const pending = send(); await wait(() => jevCalls.length === 1);
 await msg({type: 'page.delete', urlKey: other});
 jevCalls[0].finish(0.9); assert.equal((await pending).error.code, 'SOURCE_MISSING');
 assert.equal(calls.length, 0); assert.deepEqual(session, {});
});
for (const [type, urlKey, id] of [['page.delete', key], ['highlight.delete', key, 'h'], ['data.deleteAll', key], ['page.delete', other], ['highlight.delete', other, 'old']]) {
 await run('deletion during final call cancels retrieval: ' + type + ' ' + urlKey, async () => {
  const pending = send(); await wait(() => calls.length === 1);
  await msg({type, urlKey, id}); calls[0].finish('Late [R1].'); assert.equal((await pending).error.code, 'CANCELLED');
  assert.equal(state['page:' + key]?.highlights[0]?.messages.some(m => m.role === 'assistant') || false, false);
  assert.deepEqual(session, {});
 });
}
await run('old completion cannot clear recreated thread pending or phase', async () => {
 const old = send(); await wait(() => calls.length === 1);
 await msg({type: 'page.delete', urlKey: key});
 state['page:' + key] = {urlKey: key, title: 'New', highlights: [{id: 'h', exact: 'MVCC', context: '', concepts: ['MVCC'], messages: []}]};
 const fresh = send('Fresh'); await wait(() => calls.length === 2);
 calls[0].finish('Old [R1].'); await old;
 assert.ok(session['pending:h']); assert.equal(session['phase:h'], 'Answering…');
 calls[1].finish('New [R1].'); await fresh;
 assert.deepEqual(state['page:' + key].highlights[0].messages.map(m => m.content), ['Fresh', 'New [R1].']); assert.deepEqual(session, {});
});
console.log('retrieval background: all passed');
