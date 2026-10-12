// Text-quote anchoring (W3C TextQuoteSelector + position hint, spec D4). Reads the DOM, never mutates it.
// Plain script (content scripts can't be modules): exposes the MarginAnchor global.
var MarginAnchor = (() => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'TEMPLATE', 'IFRAME']);
  const BLOCK = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,tr,table,section,article,header,footer,aside,nav,main,figure,figcaption,dd,dt';
  const WS = /\s/;
  const CTX = 32;   // prefix/suffix length
  const EDGE = 20;  // head/tail length for the edited-passage fallback

  // Flat, whitespace-collapsed text of the visible page, with a map from each char back to (node, offset).
  // Block boundaries become one space so "end.Next" doesn't fuse across paragraphs.
  function buildIndex(root = document.body) {
    const nodes = [], idxNode = [], idxOff = [], vis = new Map();
    const visible = (el) => {
      let v = vis.get(el);
      if (v === undefined) vis.set(el, (v = el.checkVisibility ? el.checkVisibility() : true));
      return v;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        return p && !SKIP.has(p.tagName) && visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let text = '', prevBlock = null;
    for (let n; (n = walker.nextNode()); ) {
      const i = nodes.push(n) - 1;
      const block = n.parentElement.closest(BLOCK);
      if (block !== prevBlock && text && text[text.length - 1] !== ' ') {
        text += ' '; idxNode.push(i); idxOff.push(0);
      }
      prevBlock = block;
      const s = n.data;
      for (let k = 0; k < s.length; k++) {
        let c = s[k];
        if (WS.test(c)) {
          if (!text || text[text.length - 1] === ' ') continue;
          c = ' ';
        }
        text += c; idxNode.push(i); idxOff.push(k);
      }
    }
    return { text, nodes, idxNode, idxOff };
  }

  // First index position whose char sits at/after a DOM boundary point. Works for element containers too.
  function pointToIndex(ix, node, offset) {
    const r = document.createRange();
    r.setStart(node, offset);
    let lo = 0, hi = ix.text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.comparePoint(ix.nodes[ix.idxNode[mid]], ix.idxOff[mid]) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function trim(t, s, e) {
    while (s < e && t[s] === ' ') s++;
    while (e > s && t[e - 1] === ' ') e--;
    return [s, e];
  }

  function selectorFromRange(ix, range) {
    const [s, e] = trim(ix.text,
      pointToIndex(ix, range.startContainer, range.startOffset),
      pointToIndex(ix, range.endContainer, range.endOffset));
    if (s >= e) return null;
    const t = ix.text;
    return { exact: t.slice(s, e), prefix: t.slice(Math.max(0, s - CTX), s), suffix: t.slice(e, e + CTX), start: s, end: e };
  }

  function toRange(ix, s, e) {
    const r = document.createRange();
    r.setStart(ix.nodes[ix.idxNode[s]], ix.idxOff[s]);
    r.setEnd(ix.nodes[ix.idxNode[e - 1]], ix.idxOff[e - 1] + 1);
    return r;
  }

  const commonSuffix = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++; return k; };
  const commonPrefix = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++; return k; };

  function occurrences(t, s, max = 1000) {
    const out = [];
    for (let p = t.indexOf(s); p !== -1 && out.length < max; p = t.indexOf(s, p + 1)) out.push(p);
    return out;
  }

  // Returns [start, end) in ix.text, or null (orphaned).
  function anchor(ix, sel) {
    const t = ix.text, ex = sel.exact, len = ex.length;
    if (t.substr(sel.start, len) === ex) return [sel.start, sel.start + len];

    const hits = occurrences(t, ex);
    if (hits.length) {
      // context match decides between duplicates; distance to the old position breaks ties
      const score = (p) => commonSuffix(t.slice(Math.max(0, p - CTX), p), sel.prefix)
        + commonPrefix(t.slice(p + len, p + len + CTX), sel.suffix) - Math.abs(p - sel.start) / 1e7;
      const p = hits.reduce((a, b) => (score(b) > score(a) ? b : a));
      return [p, p + len];
    }

    // ponytail: passage edited in the middle → match its unchanged head and tail. Edits at the
    // very start/end still orphan; vendor approx-string-match if R2 fixtures show too many orphans.
    if (len >= 2 * EDGE) {
      const head = ex.slice(0, EDGE), tail = ex.slice(-EDGE);
      let best = null;
      for (const h of occurrences(t, head)) {
        const te = t.indexOf(tail, h + EDGE);
        if (te === -1) continue;
        const e = te + EDGE;
        if (e - h < len * 0.5 || e - h > len * 1.5) continue;
        if (!best || Math.abs(h - sel.start) < Math.abs(best[0] - sel.start)) best = [h, e];
      }
      if (best) return best;
    }
    return null;
  }

  return { buildIndex, selectorFromRange, anchor, toRange };
})();
