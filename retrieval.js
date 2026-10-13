// Tag-sharing shortlist (thread-index.js) -> Jev scores each candidate -> top 3 injected, bounded. The answering model only writes the answer.
export const CONTEXT_BYTES = 9000;
export const MAX_RELATED = 3;
// ponytail: fixed cut-off from 12 synthetic pairs (helpful ≥0.47, unhelpful ≤0.34); retune on labelled real threads
// with test/eval-related.mjs.
export const MIN_NOUL = 0.4;
const bytes = s => new TextEncoder().encode(s).length;
const clip = (s, n) => { const chars = Array.from(String(s || '')); return chars.length > n ? chars.slice(0, n).join('') + '… [truncated]' : chars.join(''); };
const json = record => JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
const block = (name, records) => `<${name}>\n${json(records)}\n</${name}>`;
function boundedRecord(record, limit) {
  const out = {...record};
  while (bytes(json(out)) > limit) {
    const key = Object.keys(out).filter(k => k !== 'ref').sort((a, b) => out[b].length - out[a].length)[0];
    const core = out[key].replace(/… \[truncated\]$/, '');
    out[key] = clip(core, Math.floor(Array.from(core).length / 2));
  }
  return out;
}

// One yes/no question, asked of each (current thread, candidate) pair on its own.
export const HELPS = {type: 'noul',
  instructions: 'The reader is asking `current.question` about `current.passage` (recent conversation in `current.recent`). `candidate` is an earlier thread of theirs on another page. Would bringing `candidate` into the answer materially improve it?',
  criteria: {
    true: 'The candidate holds a conclusion, explanation, fact or open question that bears directly on what the reader is asking now, so the answer can build on it, connect to it or resolve it.',
    false: 'The candidate only shares a topic or keywords; or the passage alone answers the question (what a word or acronym means, what a sentence says); or the reader asks not to compare or bring in other material.'}};

export function judgeState(query, c) {
  return {
    current: {passage: clip(query.passage, 1500), context: clip(query.context, 500), question: clip(query.question, 1000),
      recent: (query.recent || []).slice(-3).map(m => `${m.role}: ${clip(m.content, 500)}`)},
    candidate: {page_title: clip(c.title, 100), passage: clip(c.exact, 600), reader_takeaway: clip(c.approvedTakeaway, 300),
      reader_question: clip(c.question, 400), prior_AI_answer: clip(c.lastAnswer, 600),
      reader_notes: clip((c.messages || []).filter(m => m.role === 'note').map(m => m.content).join('\n'), 400),
      ...(!c.messages?.length && {note: 'The reader highlighted this passage and kept it without discussing it.'})},
  };
}

// Candidates in shortlist order -> the ones worth injecting, best first, with refs R1.. in that order.
// Without Jev (no key, or any call fails) it falls back to the shortlist's own top 3.
export async function pickRelated({query, candidates, judge}) {
  const answers = await Promise.all(candidates.map(c => judge(judgeState(query, c), {helps: HELPS})));
  const nouls = answers.map(a => a.ok ? a.answers.helps?.noul : null);
  const picked = nouls.every(n => typeof n === 'number')
    ? candidates.map((c, i) => ({...c, noul: nouls[i]})).filter(c => c.noul >= MIN_NOUL).sort((a, b) => b.noul - a.noul)
    : candidates;
  return picked.slice(0, MAX_RELATED).map((c, i) => ({...c, ref: `R${i + 1}`}));
}

export function loadedContext(links) {
  const records = links.slice(0, MAX_RELATED).map(l => {
    const record = {ref:l.ref,title:clip(l.title,100),'Source passage':clip(l.exact,1200),'Surrounding context':clip(l.context,600)};
    if (l.status==='resolved' && l.takeaway) record['Reader-approved takeaway']=clip(l.takeaway,500);
    const q=l.messages?.filter(m=>m.role==='user').at(-1);
    if (l.status!=='resolved' && q) record['Open question']=clip(q.content,500);
    if (!l.messages?.length) record['Kept highlight']='The reader highlighted this passage without discussing it.';
    else record['Recent conversation excerpts']=l.messages.slice(-4).map(m=>`${m.role==='assistant' ? 'Prior AI answer (not verified evidence)' : m.role==='note' ? 'Reader note' : 'Reader question'}: ${clip(m.content,800)}`).join('\n');
    return boundedRecord(record,2900);
  });
  return records.length ? block('related_threads',records) : '';
}

// load(picked) re-reads each picked thread fresh and returns them with their refs, or null if one is gone.
export async function answerWithContext({system,notes,prompt,query,candidates,judge,ask,load,cancelled,status,onText}) {
  if (cancelled()) return {ok:false,code:'CANCELLED'};
  let links=[];
  if (candidates.length) {
    await status('Finding relevant context…');
    const picked=await pickRelated({query,candidates,judge});
    if (cancelled()) return {ok:false,code:'CANCELLED'};
    if (picked.length) {
      links=await load(picked);
      if (cancelled()) return {ok:false,code:'CANCELLED'};
      if (!links || links.length!==picked.length) return {ok:false,code:'SOURCE_MISSING'};
    }
    await status('Answering…');
  }
  if (cancelled()) return {ok:false,code:'CANCELLED'};
  const answer=await ask({system,notes:[notes,loadedContext(links)].filter(Boolean).join('\n\n'),prompt},onText);
  if (cancelled()) return {ok:false,code:'CANCELLED'};
  if (answer.ok && !answer.text.trim()) return {ok:false,code:'INCOMPLETE'};
  return {...answer,links};
}
