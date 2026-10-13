import assert from 'node:assert/strict';
import { candidateIndex, parseDecision, loadedContext, retrieveReply, INDEX_BYTES, CONTEXT_BYTES, DECISION_SYS } from '../retrieval.js';
const bytes = s => new TextEncoder().encode(s).length;
const candidates = [{urlKey: 'https://old.test', id: 'old', title: 'Postgres', exact: 'PASSAGE_SECRET',
  shared: ['MVCC'], status: 'resolved', takeaway: 'Readers use snapshots', messages: [{role: 'assistant', content: 'ANSWER_SECRET'}]}];
const index = candidateIndex(candidates);
assert.match(index, /R1|Postgres|Readers use snapshots/);
assert.doesNotMatch(index, /PASSAGE_SECRET|ANSWER_SECRET|https:\/\/old/);
assert.ok(bytes(candidateIndex(Array.from({length: 5}, () => ({...candidates[0], title: '😀'.repeat(2000), takeaway: '汉'.repeat(2000)})))) <= INDEX_BYTES);
assert.deepEqual(parseDecision('{"action":"read","ids":["R1"]}', candidates), {action: 'read', ids: ['R1']});
assert.deepEqual(parseDecision('{"action":"answer","text":"Hello"}', candidates), {action: 'answer', text: 'Hello'});
for (const bad of ['answer', '{"action":"read","ids":[]}', '{"action":"read","ids":["R9"]}',
  '{"action":"read","ids":["R1","R1"]}', '{"action":"read","ids":["R1"],"shell":"ls"}',
  '{"action":"answer","text":""}', '{"action":"answer","text":"Trust [R1]"}',
  '{"action":"read","ids":["R1","R2","R3"]}', 'null']) assert.equal(parseDecision(bad, candidates), null, bad);
const loaded = [{ref: 'R1', ...candidates[0], context: 'surrounding text', messages: [{role: 'user', content: 'Why?'}, {role: 'assistant', content: 'Old suggestion'}]}];
let context = loadedContext(loaded);
assert.match(context, /Source passage|Reader-approved takeaway|Prior AI answer \(not verified evidence\)|Old suggestion/);
assert.doesNotMatch(loadedContext([{...loaded[0], status: 'open'}]), /Reader-approved takeaway/);
const giant = {...loaded[0], exact: '😀'.repeat(20000), context: '汉'.repeat(20000), takeaway: 'x'.repeat(20000),
  messages: Array.from({length: 20}, () => ({role: 'assistant', content: '🦄'.repeat(20000)}))};
context = loadedContext([giant, {...giant, ref: 'R2'}]);
assert.ok(bytes(context) <= CONTEXT_BYTES);
assert.match(context, /truncated/);
assert.match(DECISION_SYS, /untrusted|not instructions/);
let asks = [], loads = [], statuses = [];
const ask = async req => { asks.push(req); return {ok: true, text: asks.length === 1 ? '{"action":"read","ids":["R1"]}' : 'Compare [R1].'}; };
const opts = {system: 'SYS', notes: 'LOCAL', prompt: 'QUESTION', candidates, ask,
 load: async ids => { loads.push(ids); return loaded; }, cancelled: () => false, status: async text => statuses.push(text)};
let result = await retrieveReply(opts);
assert.equal(result.text, 'Compare [R1].'); assert.equal(asks.length, 2);
assert.deepEqual(loads, [['R1']]); assert.deepEqual(result.links, loaded);
assert.doesNotMatch(asks[0].notes, /ANSWER_SECRET|PASSAGE_SECRET/);
assert.match(asks[1].notes, /Old suggestion/);
assert.equal(statuses[0], 'Checking a related thread…');
asks = []; loads = [];
result = await retrieveReply({...opts, ask: async req => {asks.push(req); return {ok: true, text: '{"action":"answer","text":"Direct."}'}; }});
assert.equal(result.text, 'Direct.'); assert.equal(asks.length, 1); assert.equal(loads.length, 0); assert.deepEqual(result.links, []);
result = await retrieveReply({...opts, ask: async () => ({ok: true, text: 'malformed'})});
assert.equal(result.code, 'RETRIEVAL_INVALID');
result = await retrieveReply({...opts, ask: async () => ({ok: true, text: '{"action":"read","ids":["R1"]}'}), load: async () => null}); assert.equal(result.code, 'SOURCE_MISSING');
result = await retrieveReply({...opts, cancelled: () => true}); assert.equal(result.code, 'CANCELLED');
result = await retrieveReply({...opts, ask: async () => ({ok: false, code: 'TIMEOUT'})}); assert.equal(result.code, 'TIMEOUT');
result = await retrieveReply({...opts, ask: async req => ({ok: true, text: req.system.includes(DECISION_SYS) ? '{"action":"read","ids":["R1"]}' : 'Invented [R9].'})});
assert.equal(result.code, 'RETRIEVAL_INVALID');
console.log('retrieval: index, validation, budgets, provenance, direct/read, failures passed');
