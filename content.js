// Selection → Ask pill → saved highlight; repaint on load and SPA navigation; margin icons open threads.
(() => {
  // Content script stays inert here (spec T5). ponytail: hardcoded until the settings page exists.
  const EXCLUDED = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com', 'app.slack.com'];
  const host0 = location.hostname;
  if (EXCLUDED.some((h) => host0 === h || host0.endsWith('.' + h))) return;

  const A = MarginAnchor;
  const reg = new Highlight(), regActive = new Highlight();
  CSS.highlights.set('margin', reg);
  CSS.highlights.set('margin-active', regActive);
  let urlKey = null, highlights = [], activeId = null;
  const ranges = new Map();  // highlight id → live Range
  let lastHref = location.href;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);  // null if the extension was reloaded
  const pageInfo = () => ({
    url: location.href,
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    title: document.title,
  });

  function paint() {
    reg.clear();
    regActive.clear();
    ranges.clear();
    if (highlights.length) {
      const ix = A.buildIndex();
      for (const h of highlights) {
        const se = A.anchor(ix, h);
        if (!se) continue;  // orphaned: stays in storage, flagged in the panel
        const r = A.toRange(ix, se[0], se[1]);
        ranges.set(h.id, r);
        (h.id === activeId ? regActive : reg).add(r);
      }
    }
    layoutIcons();
    if (urlKey) send({ type: 'page.anchored', urlKey, orphans: highlights.filter((h) => !ranges.has(h.id)).map((h) => h.id) });
  }

  async function load() {
    const res = await send({ type: 'page.load', ...pageInfo() });
    urlKey = res?.urlKey || null;
    highlights = res?.highlights || [];
    paint();
  }

  function setActive(id) {
    activeId = id;
    reg.clear();
    regActive.clear();
    for (const [hid, r] of ranges) (hid === id ? regActive : reg).add(r);
  }

  function openThread(id) {
    setActive(id);
    send({ type: 'highlight.open', id });
  }

  // --- Overlay: one closed shadow root holds the Ask pill and margin icons (spec D14, R3) ---
  let root = null, pill = null, icons = null;
  function ensureRoot() {
    if (root) return;
    root = document.createElement('margin-root');
    root.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647';
    const shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      button { position: absolute; font: 600 12px/1 system-ui, sans-serif; cursor: pointer; color: #222; }
      .pill { padding: 6px 10px; border-radius: 999px; border: 1px solid #d4b200; background: #fff3b0;
        box-shadow: 0 2px 6px rgb(0 0 0 / .2); white-space: nowrap; }
      .pill:hover { background: #ffe680; }
      .icon { min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px 11px 11px 2px; border: 1px solid #d4b200;
        background: #ffe680; font-size: 11px; box-shadow: 0 1px 3px rgb(0 0 0 / .15); }
      .icon:hover, .icon.active { background: #ffc800; }
      .icon.resolved { opacity: .45; background: #eee; border-color: #bbb; }
    </style><button type="button" class="pill" hidden>Ask</button><div class="icons"></div>`;
    pill = shadow.querySelector('.pill');
    icons = shadow.querySelector('.icons');
    pill.addEventListener('mousedown', (e) => e.preventDefault());  // keep the page selection alive
    pill.addEventListener('click', create);
    document.documentElement.append(root);
  }
  const hidePill = () => pill && (pill.hidden = true);

  // One icon per anchored highlight, in the right margin of its paragraph, nudged down if two collide.
  function layoutIcons() {
    if (!ranges.size && !root) return;
    ensureRoot();
    icons.replaceChildren();
    const maxX = document.documentElement.clientWidth - 30;
    const taken = [];
    for (const h of highlights) {
      const r = ranges.get(h.id);
      const rect = r?.getClientRects()[0];
      if (!rect) continue;
      const block = (r.startContainer.parentElement || document.body).closest('p,li,blockquote,pre,td,dd,figcaption,h1,h2,h3,h4,h5,h6,div');
      const right = block ? block.getBoundingClientRect().right : rect.right;
      const x = Math.min(right + 12, maxX) + scrollX;
      let y = rect.top + scrollY;
      while (taken.some((t) => Math.abs(t - y) < 26)) y += 26;
      taken.push(y);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon' + (h.status === 'resolved' ? ' resolved' : '') + (h.id === activeId ? ' active' : '');
      const n = h.messages.length;
      b.textContent = n ? String(n) : '+';
      b.title = h.status === 'resolved' ? `Resolved: ${h.takeaway || ''}` : `${n} message${n === 1 ? '' : 's'}`;
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.addEventListener('click', () => openThread(h.id));
      icons.append(b);
    }
  }

  function editable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el && (el.isContentEditable || !!el.closest('input,textarea,select'));
  }

  function showPillForSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !sel.toString().trim() || editable(sel.anchorNode)) return hidePill();
    const rects = sel.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1];
    if (!last) return hidePill();
    ensureRoot();
    pill.style.left = `${last.right + scrollX + 4}px`;
    pill.style.top = `${last.bottom + scrollY + 4}px`;
    pill.hidden = false;
  }

  // Enclosing paragraph at creation time; sent to the LLM later and survives page edits.
  function contextFor(range, exact) {
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    el = el.closest('p,li,blockquote,pre,td,dd,figcaption,h1,h2,h3,h4,h5,h6') || el;
    const text = el.innerText.replace(/\s+/g, ' ').trim();
    if (text.length <= 1500) return text;
    const i = Math.max(0, text.indexOf(exact.slice(0, 50)));
    return text.slice(Math.max(0, i - 700), Math.max(0, i - 700) + 1500);
  }

  async function create() {
    const sel = getSelection();
    hidePill();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const ix = A.buildIndex();
    const selector = A.selectorFromRange(ix, range);
    if (!selector) return;
    const res = await send({ type: 'highlight.create', ...pageInfo(), selector, context: contextFor(range, selector.exact) });
    if (!res?.highlight) return;
    highlights.push(res.highlight);
    ranges.set(res.highlight.id, A.toRange(ix, selector.start, selector.end));
    setActive(res.highlight.id);
    layoutIcons();
    sel.removeAllRanges();
  }

  function extractArticle() {
    let art = null;
    try { art = new Readability(document.cloneNode(true)).parse(); } catch {}
    const raw = art?.textContent || document.body.innerText;
    return { title: art?.title || document.title, text: raw.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim() };
  }

  document.addEventListener('mouseup', (e) => {
    if (root && e.composedPath().includes(root)) return;
    setTimeout(showPillForSelection, 0);  // selection settles after mouseup
  });
  document.addEventListener('keyup', (e) => e.shiftKey && showPillForSelection());
  document.addEventListener('mousedown', (e) => {
    if (!root || !e.composedPath().includes(root)) hidePill();
  });

  // Clicking highlighted text opens its thread.
  document.addEventListener('click', (e) => {
    if (!ranges.size || !getSelection().isCollapsed || (root && e.composedPath().includes(root))) return;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    for (const [id, r] of ranges) {
      try { if (r.isPointInRange(pos.offsetNode, pos.offset)) return openThread(id); } catch {}
    }
  });

  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutIcons, 200); });

  // Storage is the source of truth: the panel's writes (messages, resolve, delete) flow back here.
  chrome.storage.onChanged.addListener((changes, area) => {
    const c = area === 'local' && urlKey && changes['page:' + urlKey];
    if (!c) return;
    const next = c.newValue?.highlights || [];
    const sameIds = next.length === highlights.length && next.every((h, i) => h.id === highlights[i].id);
    highlights = next;
    if (sameIds) layoutIcons();
    else paint();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === 'page.extract') sendResponse(extractArticle());
    if (msg.type === 'highlight.scroll') {
      setActive(msg.id);
      layoutIcons();
      const rect = ranges.get(msg.id)?.getBoundingClientRect();
      if (rect) scrollTo({ top: rect.top + scrollY - innerHeight / 3, behavior: 'smooth' });
    }
  });

  // SPA navigation (Medium, Substack) and late-rendered content: reload on URL change,
  // otherwise re-anchor only if a highlight is missing or its range was detached.
  // ponytail: a page with a permanent orphan re-indexes on every mutation burst; track retries if that shows up.
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        load();
      } else if (highlights.some((h) => {
        const r = ranges.get(h.id);
        return !r || r.collapsed || !r.startContainer.isConnected || !r.endContainer.isConnected;
      })) paint();
      else layoutIcons();  // content shifted (images, embeds)
    }, 800);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  load();
})();
