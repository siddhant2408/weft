// Turning a page's threads into notes you take elsewhere. Shared by the side panel and the All threads page.
var MarginNotes = (() => {
  // Text fragment link (#:~:text=) opens the page scrolled to the passage, natively in Chrome.
  const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
  function fragmentUrl(url, exact) {
    const w = exact.split(' ');
    const frag = w.length > 10 ? `${enc(w.slice(0, 5).join(' '))},${enc(w.slice(-5).join(' '))}` : enc(exact);
    return `${url}#:~:text=${frag}`;
  }

  const tldr = (summary) => (summary.match(/^.*TL;DR:?\**\s*(.+)$/im)?.[1] || '').replace(/\*+/g, '').trim();
  const quote = (s) => s.split('\n').map((l) => '> ' + l).join('\n');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function threadMarkdown(h, url) {
    const out = [quote(clip(h.exact, 400)), ''];
    if (h.takeaway) out.push(`**Takeaway:** ${h.takeaway}`);
    else {
      const q = h.messages.filter((m) => m.role === 'user').at(-1);
      if (q) out.push(`**Open question:** ${q.content}`);
    }
    for (const m of h.messages) if (m.role === 'note') out.push(`- Note: ${m.content}`);
    out.push(`[Jump to passage](${fragmentUrl(url, h.exact)})`);
    return out.join('\n');
  }

  function pageMarkdown(page, highlights = page.highlights) {
    const url = page.urlKey;
    const parts = [`# [${page.title || url}](${url})`];
    if (page.summary) parts.push('## Summary\n\n' + page.summary.text);
    const hs = [...highlights].sort((a, b) => a.start - b.start);
    if (hs.length) parts.push('## Threads\n\n' + hs.map((h) => threadMarkdown(h, url)).join('\n\n'));
    const qa = page.qa?.messages || [];
    if (qa.length) parts.push('## Questions about the page\n\n' + qa.map((m) => (m.role === 'assistant' ? m.content : `**${m.role === 'note' ? 'Note' : 'Q'}:** ${m.content}`)).join('\n\n'));
    return parts.join('\n\n') + '\n';
  }

  // Notes exports must never include provider credentials or unrelated extension state.
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
  const messages = (ms = []) => ms.map((m) => pick(m, ['role', 'content', 'by', 'ts']));
  function exportData(storage) {
    const pages = Object.entries(storage).filter(([k, p]) => k.startsWith('page:') && p).map(([, p]) => ({
      ...pick(p, ['urlKey', 'title', 'updatedAt']),
      highlights: (p.highlights || []).map((h) => ({
        ...pick(h, ['id', 'exact', 'prefix', 'suffix', 'start', 'end', 'context', 'status', 'takeaway', 'concepts', 'createdAt']),
        messages: messages(h.messages),
      })),
      ...(p.qa ? { qa: { messages: messages(p.qa.messages) } } : {}),
      ...(p.summary ? { summary: pick(p.summary, ['text', 'createdAt', 'contentHash']) } : {}),
      ...(p.article ? { article: pick(p.article, ['title', 'text', 'truncated', 'hash']) } : {}),
    }));
    return { version: 1, pages };
  }

  return { fragmentUrl, pageMarkdown, tldr, exportData };
})();
