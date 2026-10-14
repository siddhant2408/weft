import assert from 'node:assert/strict';
import {buildIndex, findCandidates, indexMatches} from '../thread-index.js';
const pages = [
 {urlKey:'current',title:'Current',highlights:[{id:'h',exact:'An old snapshot prevents cleanup',concepts:['MVCC'],messages:[{role:'user',content:'Why does this matter?'}]}]},
 {urlKey:'postgres',title:'Postgres',highlights:[{id:'pg',exact:'Vacuum removes dead tuples',context:'Readers retain snapshots',concepts:['MVCC'],status:'resolved',takeaway:'Long readers delay vacuum',messages:[{role:'user',content:'Why does vacuum stall?'},{role:'assistant',content:'Old snapshots still need those tuples.'}]}]},
 {urlKey:'other',title:'Backups',highlights:[{id:'backup',exact:'Snapshots are used for backups',concepts:['Snapshots'],messages:[{role:'assistant',content:'Protect against disk failure'}]}]},
 {urlKey:'untagged',title:'Storage',highlights:[{id:'u',exact:'Cleanup waits for active readers',messages:[{role:'user',content:'Why retain old data?'}]}]},
];
let index = buildIndex(pages);
assert.equal(index.length,4);
const query = {urlKey:'current',id:'h',passage:'An old snapshot prevents cleanup',context:'Readers cannot see removed data',question:'Why does this matter?',concepts:['MVCC'],recent:[]};
const candidates=findCandidates(index,query);
assert.equal(candidates[0].id,'pg');
assert.deepEqual(candidates.map(c=>c.id),['pg'],'only threads sharing a tag: untagged and other-tag threads are left out');
assert.deepEqual(findCandidates(index,{...query,concepts:[]}),[],'an untagged thread has no candidates');
assert.ok(!candidates.some(c=>c.urlKey==='current'));
assert.equal(new Set(candidates.map(c=>c.urlKey+'#'+c.id)).size,candidates.length);
assert.ok(candidates.length<=20);
assert.deepEqual(findCandidates(index,{urlKey:'x',question:'What is a pineapple?',recent:[]}),[]);
assert.ok(indexMatches(index.find(e=>e.id==='pg'),'MVCC vacuum'));
assert.ok(indexMatches(index.find(e=>e.id==='pg'),'dead tuples'));
assert.ok(!indexMatches(index.find(e=>e.id==='pg'),'pineapple'));
// The index is a projection of current records, not stale concepts or a second persistent database.
pages[1].highlights[0].messages.push({role:'user',content:'What about replication lag?'});
pages[1].highlights[0].status='open';
index=buildIndex(pages);
assert.match(index.find(e=>e.id==='pg').question,/replication lag/);
assert.equal(index.find(e=>e.id==='pg').approvedTakeaway,'');
assert.ok(findCandidates(index,{urlKey:'current',question:'Why lag?',concepts:['mvcc'],recent:[{role:'user',content:'We were discussing replication'}]}).some(e=>e.id==='pg'));
pages[1].highlights=[];
assert.ok(!buildIndex(pages).some(e=>e.id==='pg'),'deletion removes index entries on the next projection');
const sameId=[{urlKey:'a',highlights:[{id:'same',exact:'vacuum',messages:[]}]},{urlKey:'b',highlights:[{id:'same',exact:'vacuum',messages:[]}]}];
assert.equal(buildIndex(sameId).length,2,'identity includes page and thread');
console.log('thread index: fresh projection, discovery, conversation updates, UI search and deletion passed');
