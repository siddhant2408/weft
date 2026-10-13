// A fresh, local search projection over the reading record. No duplicate database or model-generated index.
import {norm} from './graph.js';
const STOP = new Set('a an and are as at be been but by can could do does for from had has have how i if in is it its me my of on or our should so that the their them then there these they this those to was we were what when where which who why will with would you your passage question context article'.split(' '));
const words = text => new Set(norm(String(text || '')).split(' ').filter(w => w.length > 2 && !STOP.has(w)));
export const threadKey = (urlKey, id) => JSON.stringify([urlKey,id]);

export function buildIndex(pages) {
  return pages.flatMap(page => (page.highlights || []).map(h => {
    const messages = h.messages || [];
    const question = messages.filter(m => m.role === 'user').at(-1)?.content || '';
    const lastAnswer = messages.filter(m => m.role === 'assistant').at(-1)?.content || '';
    const approvedTakeaway = h.status === 'resolved' ? h.takeaway || '' : '';
    const searchText = [page.title,h.exact,h.context,...(h.concepts || []),approvedTakeaway,...messages.map(m=>m.content)].join('\n');
    return {urlKey:page.urlKey,id:h.id,title:page.title || '',exact:h.exact || '',context:h.context || '',concepts:h.concepts || [],
      status:h.status,takeaway:h.takeaway,approvedTakeaway,question,lastAnswer,searchText,
      createdAt:h.createdAt,updatedAt:page.updatedAt,messages:messages.slice(-4)};
  }));
}

export function indexMatches(entry, query) {
  const hay = norm(entry.searchText);
  return norm(query).split(' ').filter(Boolean).every(w=>hay.includes(w));
}

// Threads on other pages sharing at least one of the query's tags, best lexical match first. A shortlist, not a
// relevance decision: Jev scores each one (retrieval.js pickRelated) and may reject all.
export function findCandidates(index, query, max = 10) {
  const mine = new Set((query.concepts || []).map(norm));
  if (!mine.size) return [];
  const weighted = new Map();
  for (const [part,weight] of [[query.question,3],[(query.recent || []).map(m=>m.content).join(' '),2],[query.passage,1],[query.context,1]]) {
    for (const word of words(part)) weighted.set(word,Math.max(weighted.get(word) || 0,weight));
  }
  // Tag filter first: only threads sharing a tag are split into words, and word rarity is measured among them.
  const pool = index.flatMap(entry=>{
    if (entry.urlKey===query.urlKey) return [];
    const seen = new Set();
    const shared = entry.concepts.filter(c=>{const k=norm(c); if (seen.has(k) || !mine.has(k)) return false; seen.add(k); return true;});
    return shared.length ? [{entry,shared,terms:words(entry.searchText)}] : [];
  });
  const frequency = new Map();
  for (const {terms} of pool) for (const word of weighted.keys()) if (terms.has(word)) frequency.set(word,(frequency.get(word) || 0)+1);
  return pool.map(({entry,shared,terms})=>{
    const matched = [...weighted.keys()].filter(w=>terms.has(w));
    const score = shared.length*4 + matched.reduce((sum,w)=>sum + weighted.get(w)*Math.log(1 + pool.length/(frequency.get(w) || 1)),0);
    return {...entry,shared,matched,score};
  }).sort((a,b)=>b.score-a.score || (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '') || threadKey(a.urlKey,a.id).localeCompare(threadKey(b.urlKey,b.id))).slice(0,max);
}
