// Highlights on the page and Notion-style comment cards beside them (spec D12, D14).
// Select text → a comment box appears next to it → Enter asks the model. Saved threads show as
// margin icons; clicking one (or the yellow text) opens its card. One card open at a time.
(async () => {
  // Excluded sites: stay fully inert (spec T5). A change applies on the next page load.
  const s0 = await MarginSettings.get();
  if (MarginSettings.isExcluded(location.hostname, s0.excluded)) return;

  const A = MarginAnchor;
  const reg = new Highlight(), regActive = new Highlight(), regDraft = new Highlight();
  CSS.highlights.set('margin', reg);
  CSS.highlights.set('margin-active', regActive);
  CSS.highlights.set('margin-draft', regDraft);
  let urlKey = null, highlights = [], lastHref = location.href;
  const ranges = new Map();          // highlight id → live Range
  const pending = new Set();         // ids waiting on the model (storage.session)
  const streams = {};                // id → partial reply while streaming
  const replierOf = (s) => (s?.provider === 'openai' && s.openai?.model ? s.openai.model.split('/').pop() : 'Claude');
  let replier = replierOf(s0);

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);  // null if the extension was reloaded
  const pageInfo = () => ({
    url: location.href,
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    title: document.title,
  });
  const md = (s) => DOMPurify.sanitize(marked.parse(s));  // model output is untrusted HTML (spec T4)

  // ---------- highlights ----------
  function paint() {
    reg.clear();
    regActive.clear();
    ranges.clear();
    if (highlights.length) {
      const ix = A.buildIndex();
      for (const h of highlights) {
        const se = A.anchor(ix, h);
        if (!se) continue;  // orphaned: stays in storage, flagged in the side panel
        ranges.set(h.id, A.toRange(ix, se[0], se[1]));
      }
    }
    syncActive();
    layout();
    if (urlKey) send({ type: 'page.anchored', urlKey, orphans: highlights.filter((h) => !ranges.has(h.id)).map((h) => h.id) });
  }

  function syncActive() {
    reg.clear();
    regActive.clear();
    for (const [id, r] of ranges) (id === open?.id ? regActive : reg).add(r);
  }

  async function load() {
    const res = await send({ type: 'page.load', ...pageInfo() });
    urlKey = res?.urlKey || null;
    highlights = res?.highlights || [];
    if (open?.id) closeCard();
    paint();
  }

  // ---------- overlay: one closed shadow root, isolated from page CSS and scripts ----------
  const ICON = {
    bubble: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 11.5H7.2L4.3 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    note: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.7a1.4 1.4 0 0 1 2 2L6 11.5l-2.7.7.7-2.7Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9m-4 4 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { --bg: #fff; --ink: #37352f; --soft: rgba(55,53,47,.65); --faint: rgba(55,53,47,.45); --line: rgba(55,53,47,.09);
      --hover: rgba(55,53,47,.06); --hl: rgba(255,212,0,.14); --hl-line: #f5c400; --send: #2383e2; --err: #eb5757;
      --shadow: 0 0 0 1px rgba(15,15,15,.05), 0 3px 6px rgba(15,15,15,.1), 0 9px 24px rgba(15,15,15,.2);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif; color: var(--ink); }
    .wrap.dark { --bg: #252525; --ink: rgba(255,255,255,.81); --soft: rgba(255,255,255,.55); --faint: rgba(255,255,255,.38);
      --line: rgba(255,255,255,.09); --hover: rgba(255,255,255,.06); --send: #529cca;
      --shadow: 0 0 0 1px rgba(255,255,255,.07), 0 3px 6px rgba(0,0,0,.25), 0 9px 24px rgba(0,0,0,.45); }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--send); outline-offset: 1px; }
    svg { width: 16px; height: 16px; display: block; }

    .icon { position: absolute; display: flex; align-items: center; gap: 3px; height: 24px; padding: 0 6px; border-radius: 6px;
      color: var(--faint); font-size: 12px; font-weight: 500; }
    .icon:hover { background: var(--hover); color: var(--soft); }
    .icon.resolved { opacity: .45; }

    .card { position: absolute; width: 340px; max-width: calc(100vw - 16px); background: var(--bg); border-radius: 12px;
      box-shadow: var(--shadow); display: flex; flex-direction: column; max-height: min(70vh, 560px); }
    .card .scroll { overflow-y: auto; padding: 6px 0 0; }
    .head { display: flex; align-items: center; gap: 2px; padding: 8px 8px 0 14px; }
    .head .title { flex: 1; font-size: 12px; color: var(--faint); font-weight: 500; }
    .head button { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: var(--faint); }
    .head button:hover { background: var(--hover); color: var(--ink); }

    .msg { display: grid; grid-template-columns: 22px 1fr; column-gap: 8px; padding: 6px 14px; }
    .av { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 600;
      background: var(--line); color: var(--soft); margin-top: 1px; }
    .av.ai { background: #f5c400; color: #3a2e00; }
    .meta { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .time, .tag { font-size: 12px; color: var(--faint); white-space: nowrap; }
    .body { grid-column: 2; overflow-wrap: anywhere; }
    .body p { margin: 2px 0 6px; } .body p:last-child { margin-bottom: 0; }
    .body ul, .body ol { margin: 2px 0 6px; padding-left: 20px; }
    .body pre { overflow-x: auto; background: var(--hover); padding: 6px 8px; border-radius: 6px; font-size: 12.5px; }
    .body code { background: var(--hover); border-radius: 4px; padding: 0 3px; font-size: 12.5px; }
    .body a { color: inherit; }
    .msg.note .body { color: var(--soft); }
    .caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; background: var(--soft); vertical-align: -2px;
      animation: blink 1s steps(2) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .caret { animation: none; } }
    .thinking { color: var(--faint); }

    .takeaway { margin: 6px 14px 4px; padding: 8px 10px; border-radius: 8px; background: var(--hl); border-left: 3px solid var(--hl-line); }
    .takeaway b { display: block; font-size: 12px; color: var(--soft); font-weight: 600; margin-bottom: 2px; }
    .state { padding: 0 14px; }
    .state:empty { display: none; }
    .error { color: var(--err); font-size: 13px; padding: 4px 0; }
    .row { display: flex; gap: 6px; align-items: center; justify-content: flex-end; padding: 6px 0; flex-wrap: wrap; }
    .row .grow { flex: 1; font-size: 13px; color: var(--soft); }
    .btn { font-size: 13px; padding: 4px 10px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--line); }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--send); color: #fff; box-shadow: none; }
    .btn.danger { color: var(--err); }
    .field { width: 100%; font: inherit; color: inherit; background: var(--hover); border: 0; border-radius: 6px; padding: 6px 8px; resize: none; }

    .composer { margin: 8px; display: flex; align-items: flex-end; gap: 4px; padding: 6px 6px 6px 12px; border-radius: 10px;
      box-shadow: inset 0 0 0 1px var(--line); }
    .composer:focus-within { box-shadow: inset 0 0 0 1px var(--soft); }
    .composer textarea { flex: 1; border: 0; outline: 0; resize: none; background: none; font: inherit; color: inherit;
      line-height: 22px; height: 22px; max-height: 160px; padding: 2px 0; }
    .composer textarea::placeholder { color: var(--faint); }
    .composer .tool { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 6px; color: var(--faint); flex: none; }
    .composer .tool:hover { background: var(--hover); color: var(--soft); }
    .composer .tool[aria-pressed="true"] { color: var(--ink); background: var(--hover); }
    .composer .send { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex: none;
      background: var(--faint); color: var(--bg); }
    .composer .send.ready { background: var(--send); color: #fff; }
    .composer .send:disabled { cursor: default; }
    .composer.hidden { display: none; }
    /* A new comment is just the input, like Notion: the card itself is the box. */
    .card.draft .head { display: none; }
    .card.draft .composer { margin: 0; padding: 9px 8px 9px 14px; box-shadow: none; }
  `;

  let root = null, wrap = null, iconsEl = null, cardHost = null;
  function ensureRoot() {
    if (root) return;
    root = document.createElement('margin-root');
    root.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647';
    const shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS_TEXT}</style><div class="wrap"><div class="icons"></div><div class="cards"></div></div>`;
    wrap = shadow.querySelector('.wrap');
    iconsEl = shadow.querySelector('.icons');
    cardHost = shadow.querySelector('.cards');
    // Keystrokes in our box must not trigger the page's own shortcuts (j/k, /, etc.).
    for (const t of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(t, (e) => e.stopPropagation());
    document.documentElement.append(root);
  }
  const inRoot = (e) => !!root && e.composedPath().includes(root);

  // Match the page, not the OS: a dark card on a dark page, light on light.
  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m || (m[3] !== undefined && +m[3] < 0.5)) continue;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
    }
    return false;  // transparent all the way down: the browser default is white
  }

  const kids = (list) => list.filter((k) => k != null && k !== false && k !== '');
  const h_ = (tag, cls, props = {}, ...children) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    Object.assign(n, props);
    n.append(...kids(children));
    return n;
  };
  const iconBtn = (name, label, onclick, cls = '') => {
    const b = h_('button', cls, { type: 'button', title: label, ariaLabel: label, onclick });
    b.innerHTML = ICON[name];
    return b;
  };

  // ---------- margin icons ----------
  function blockOf(range) {
    const n = range.startContainer;
    return (n.nodeType === 1 ? n : n.parentElement || document.body).closest('p,li,blockquote,pre,td,dd,figcaption,h1,h2,h3,h4,h5,h6,div') || document.body;
  }

  function layout() {
    if (!ranges.size && !root) return;
    ensureRoot();
    wrap.classList.toggle('dark', pageIsDark());
    iconsEl.replaceChildren();
    if (open) placeCard();
    const cardBox = card && card.el.getBoundingClientRect();
    const maxX = document.documentElement.clientWidth - 44;
    const taken = [];
    for (const h of highlights) {
      const r = ranges.get(h.id);
      const rect = r?.getClientRects()[0];
      if (!rect || h.id === open?.id) continue;
      const x = Math.min(blockOf(r).getBoundingClientRect().right + 16, maxX) + scrollX;
      let y = rect.top + scrollY - 2;
      while (taken.some((t) => Math.abs(t - y) < 26)) y += 26;
      taken.push(y);
      if (cardBox && y - scrollY + 24 > cardBox.top && y - scrollY < cardBox.bottom) continue;  // hidden under the open card
      const n = h.messages.length;
      const b = h_('button', 'icon' + (h.status === 'resolved' ? ' resolved' : ''), {
        type: 'button',
        title: h.status === 'resolved' ? `Resolved: ${h.takeaway || ''}` : `${n} comment${n === 1 ? '' : 's'}`,
        ariaLabel: `Open comments on “${h.exact.slice(0, 60)}”`,
        onclick: () => openCard({ id: h.id }),
      });
      b.innerHTML = ICON.bubble;
      if (n) b.append(String(n));
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      iconsEl.append(b);
    }
  }

  // ---------- the comment card ----------
  // open = { id } for a saved thread, or { id: null, draft: { selector, context, range } } before the first message.
  let open = null, card = null;
  let cardLift = 0;  // px the card sits above its natural spot, so it fits at the end of a short page
  let ui = {};  // per-card transient state: noteMode, error, resolving, confirmDelete

  function openCard(target) {
    if (open && !open.draft && target.id === open.id) return;
    ensureRoot();
    wrap.classList.toggle('dark', pageIsDark());
    open = target;
    cardLift = 0;
    ui = { noteMode: false, error: null, resolving: null, confirmDelete: false };
    if (!target.draft) regDraft.clear();

    const ta = h_('textarea', '', { rows: 1, ariaLabel: 'Comment' });
    const noteBtn = iconBtn('note', 'Note only: save without asking', () => {
      ui.noteMode = !ui.noteMode;
      noteBtn.setAttribute('aria-pressed', String(ui.noteMode));
      renderCard();
      ta.focus();
    }, 'tool');
    noteBtn.setAttribute('aria-pressed', 'false');
    const sendBtn = iconBtn('up', 'Send', () => submit(), 'send');
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
      sendBtn.classList.toggle('ready', !!ta.value.trim());
    };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeCard(); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    const el = h_('section', 'card', { role: 'dialog', ariaLabel: 'Comments on the highlighted passage' });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });
    const head = h_('div', 'head');
    const scroll = h_('div', 'scroll');
    const msgs = h_('div', 'msgs');
    const state = h_('div', 'state');
    const composer = h_('div', 'composer', {}, ta, noteBtn, sendBtn);
    scroll.append(msgs);
    el.append(head, scroll, state, composer);
    cardHost.replaceChildren(el);
    card = { el, head, scroll, msgs, state, composer, ta, sendBtn, autosize };

    syncActive();
    layout();
    renderCard();
    card.scroll.scrollTop = card.scroll.scrollHeight;  // open at the latest comment; scroll up for history
    requestAnimationFrame(revealCard);
    if (target.id) {
      chrome.storage.session.get([`pending:${target.id}`, `stream:${target.id}`]).then((s) => {
        if (s[`pending:${target.id}`]) pending.add(target.id);
        if (s[`stream:${target.id}`]) streams[target.id] = s[`stream:${target.id}`];
        renderCard();
      }).catch(() => {});
      ta.focus({ preventScroll: true });
      send({ type: 'highlight.open', id: target.id });  // lets an open side panel follow along
    }
  }

  function closeCard() {
    open = null;
    card = null;
    cardHost?.replaceChildren();
    regDraft.clear();
    syncActive();
    layout();
  }

  // Beside the paragraph in the right margin when there's room, else just below the passage.
  function placeCard() {
    if (!card) return;
    const r = open.draft ? open.draft.range : ranges.get(open.id);
    const rects = r?.getClientRects();
    if (!rects?.length) return;
    const first = rects[0], last = rects[rects.length - 1];
    const vw = document.documentElement.clientWidth;
    const W = Math.min(340, vw - 16);
    const right = blockOf(r).getBoundingClientRect().right;
    let x, y;
    if (right + 16 + W <= vw - 8) { x = right + 16; y = first.top - 8; }
    else { x = Math.min(Math.max(8, last.left), vw - W - 8); y = last.bottom + 8; }
    card.el.style.left = `${x + scrollX}px`;
    card.el.style.top = `${Math.max(0, y + scrollY - cardLift)}px`;
  }

  // Keep the whole card on screen: if it runs past the bottom of the window (long thread, or a passage
  // near the bottom), scroll the page just enough, never so far that the card's top leaves the view.
  let lastCardHeight = 0;
  function revealCard() {
    if (!card) return;
    const r = card.el.getBoundingClientRect();
    lastCardHeight = r.height;
    const pad = 16;
    let dy = 0;
    if (r.bottom > innerHeight - pad) dy = Math.min(r.bottom - innerHeight + pad, r.top - pad);
    else if (r.top < pad) dy = r.top - pad;
    if (!dy) return;
    // Near the end of a short page the window can't scroll that far: lift the card by the remainder.
    // Measure the page without the card, which otherwise extends it and skews the answer.
    card.el.style.display = 'none';
    const pageH = document.documentElement.scrollHeight;
    card.el.style.display = '';
    const room = pageH - innerHeight - scrollY;
    if (dy > room) {
      cardLift += dy - Math.max(0, room);
      placeCard();
      dy = Math.max(0, room);
    }
    if (dy) scrollBy({ top: dy, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  const ago = (ts) => {
    const s = (Date.now() - new Date(ts)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  function msgView(m, partial = false) {
    const ai = m.role === 'assistant';
    const name = ai ? (m.by || replier) : 'You';
    const body = h_('div', 'body');
    if (ai) {
      body.innerHTML = md(m.content);
      if (partial) (body.lastElementChild || body).append(h_('span', 'caret'));
    } else body.textContent = m.content;
    return h_('div', 'msg' + (m.role === 'note' ? ' note' : ''), {},
      h_('div', 'av' + (ai ? ' ai' : ''), { textContent: ai ? '✦' : 'Y', ariaHidden: 'true' }),
      h_('div', 'meta', {}, h_('span', 'name', { textContent: name }),
        m.role === 'note' && h_('span', 'tag', { textContent: 'note' }),
        !partial && m.ts && h_('span', 'time', { textContent: ago(m.ts) })),
      body);
  }

  function renderCard() {
    if (!card) return;
    const h = open.id ? highlights.find((x) => x.id === open.id) : null;
    if (open.id && !h) return closeCard();  // deleted elsewhere
    const busy = !!open.id && pending.has(open.id);
    card.el.classList.toggle('draft', !h && !ui.error);
    const resolved = h?.status === 'resolved';
    const atBottom = card.scroll.scrollHeight - card.scroll.scrollTop - card.scroll.clientHeight < 40;

    card.head.replaceChildren(...kids([
      h_('span', 'title', { textContent: resolved ? 'Resolved' : h ? `${h.messages.length} comment${h.messages.length === 1 ? '' : 's'}` : 'New comment' }),
      h && !resolved && iconBtn('check', 'Resolve with a takeaway', startResolve),
      h && iconBtn('trash', 'Delete this thread', () => { ui.confirmDelete = true; renderCard(); }),
      iconBtn('close', 'Close (Esc)', closeCard)]));

    const live = streams[open.id];
    card.msgs.replaceChildren(...kids([
      ...(h?.messages || []).map((m) => msgView(m)),
      busy && (live ? msgView({ role: 'assistant', content: live }, true)
        : h_('div', 'msg', {}, h_('div', 'av ai', { textContent: '✦' }), h_('div', 'thinking', { textContent: `${replier} is thinking…` })))]));
    card.scroll.hidden = !card.msgs.childElementCount;
    if (atBottom || busy) card.scroll.scrollTop = card.scroll.scrollHeight;

    const state = [];
    if (resolved && h.takeaway) state.push(h_('div', 'takeaway', {}, h_('b', '', { textContent: 'Takeaway' }), h.takeaway));
    if (resolved) state.push(h_('div', 'row', {}, h_('button', 'btn', { type: 'button', textContent: 'Reopen', onclick: () => send({ type: 'thread.reopen', urlKey, id: h.id }) })));
    if (!busy && h?.messages.at(-1)?.needsPage) {
      state.push(h_('div', 'row', {}, h_('span', 'grow', { textContent: 'Sends the full page to summarise it.' }),
        h_('button', 'btn primary', { type: 'button', textContent: 'Share page and retry', onclick: () => retry(true) })));
    }
    if (ui.error) {
      state.push(h_('div', 'error', { role: 'alert', textContent: ui.error.hint }),
        h_('div', 'row', {}, h_('button', 'btn', { type: 'button', textContent: 'Retry', onclick: () => retry() })));
    }
    if (ui.resolving) state.push(...resolveView(h));
    if (ui.confirmDelete) {
      state.push(h_('div', 'row', {}, h_('span', 'grow', { textContent: 'Delete this highlight and its thread?' }),
        h_('button', 'btn', { type: 'button', textContent: 'Cancel', onclick: () => { ui.confirmDelete = false; renderCard(); } }),
        h_('button', 'btn danger', { type: 'button', textContent: 'Delete', onclick: () => send({ type: 'highlight.delete', urlKey, id: h.id }) })));
    }
    card.state.replaceChildren(...state);

    card.composer.classList.toggle('hidden', resolved || !!ui.resolving);
    card.ta.disabled = busy;
    card.sendBtn.disabled = busy;
    card.ta.placeholder = ui.noteMode ? 'Add a note…' : h?.messages.length ? `Reply, or ask ${replier} a follow-up…` : `Ask ${replier} about this…`;
    card.autosize();
    // focus inside a closed shadow root reports the host as the active element
    if (document.activeElement === root && card.el.getBoundingClientRect().height !== lastCardHeight) requestAnimationFrame(revealCard);
  }

  function resolveView(h) {
    const r = ui.resolving;
    if (r.loading) return [h_('div', 'thinking', { textContent: 'Drafting a takeaway…' })];
    const field = h_('textarea', 'field', { rows: 2, value: r.text, placeholder: 'One-line takeaway', ariaLabel: 'Takeaway' });
    field.addEventListener('input', () => { r.text = field.value; });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); finishResolve(h, field.value); }
    });
    queueMicrotask(() => field.focus());
    return [h_('div', 'takeaway', {}, h_('b', '', { textContent: 'Takeaway' }), field),
      h_('div', 'row', {},
        h_('button', 'btn', { type: 'button', textContent: 'Cancel', onclick: () => { ui.resolving = null; renderCard(); } }),
        h_('button', 'btn primary', { type: 'button', textContent: 'Resolve', onclick: () => finishResolve(h, field.value) }))];
  }

  async function startResolve() {
    const id = open.id;
    ui.resolving = { loading: true };
    renderCard();
    const res = await send({ type: 'thread.resolve', urlKey, id });
    if (open?.id !== id) return;
    ui.resolving = { text: res?.draft || '' };
    if (res?.error) ui.error = res.error;
    renderCard();
  }

  async function finishResolve(h, text) {
    ui.resolving = null;
    await send({ type: 'thread.resolve', urlKey, id: h.id, takeaway: text });
  }

  async function submit() {
    const text = card.ta.value.trim();
    if (!text || !open) return;
    const ask = !ui.noteMode;
    ui.error = null;
    if (open.draft) {
      // First message: only now does the selection become a saved highlight.
      const { selector, context, range } = open.draft;
      const res = await send({ type: 'highlight.create', ...pageInfo(), selector, context });
      if (!res?.highlight) { ui.error = res?.error || { hint: 'Couldn\'t save. Reload the page and try again.' }; renderCard(); return; }
      urlKey ||= res.urlKey;
      highlights.push(res.highlight);
      ranges.set(res.highlight.id, range);
      open = { id: res.highlight.id };
      regDraft.clear();
      syncActive();
    }
    const id = open.id;
    card.ta.value = '';
    if (ask) pending.add(id);
    renderCard();
    const r = await send({ type: 'thread.send', urlKey, id, text, ask });
    if (r?.error) { pending.delete(id); if (open?.id === id) ui.error = r.error; }
    renderCard();
  }

  // share: summarise the page first, then re-answer the reply that asked for it.
  async function retry(share = false) {
    const id = open.id;
    ui.error = null;
    pending.add(id);
    renderCard();
    const r = await send({ type: 'thread.send', urlKey, id, text: '', ask: true, share });
    if (r?.error) { pending.delete(id); if (open?.id === id) ui.error = r.error; }
    renderCard();
  }

  // ---------- selection → draft card ----------
  function editable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return !!el && (el.isContentEditable || !!el.closest('input,textarea,select'));
  }

  function onSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || sel.toString().trim().length < 2 || editable(sel.anchorNode)) return;
    if (card && card.ta.value.trim()) return;  // don't throw away a half-written comment
    const range = sel.getRangeAt(0);
    const ix = A.buildIndex();
    const selector = A.selectorFromRange(ix, range);
    if (!selector) return;
    const r = A.toRange(ix, selector.start, selector.end);
    regDraft.clear();
    regDraft.add(r);
    // No focus steal: the page selection stays, so ⌘C still copies. Click the box to type.
    openCard({ id: null, draft: { selector, context: A.itemText(range, selector.exact), range: r } });
  }

  function extractArticle() {
    let art = null;
    try { art = new Readability(document.cloneNode(true)).parse(); } catch {}
    const raw = art?.textContent || document.body.innerText;
    return { title: art?.title || document.title, text: raw.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim() };
  }

  document.addEventListener('mouseup', (e) => { if (!inRoot(e)) setTimeout(onSelection, 0); });  // selection settles after mouseup
  document.addEventListener('keyup', (e) => { if (e.shiftKey && !inRoot(e)) onSelection(); });
  // Clicking elsewhere closes the card, unless there's an unsent comment in it.
  document.addEventListener('mousedown', (e) => {
    if (open && !inRoot(e) && !card?.ta.value.trim()) closeCard();
  });
  // Clicking highlighted text opens its thread.
  document.addEventListener('click', (e) => {
    if (!ranges.size || !getSelection().isCollapsed || inRoot(e)) return;
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    for (const [id, r] of ranges) {
      try { if (r.isPointInRange(pos.offsetNode, pos.offset)) return openCard({ id }); } catch {}
    }
  });

  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });

  // Storage is the source of truth: writes from the side panel or background flow back here.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { replier = replierOf(changes.settings.newValue); renderCard(); }
    if (area === 'local' && urlKey && changes['page:' + urlKey]) {
      const next = changes['page:' + urlKey].newValue?.highlights || [];
      const sameIds = next.length === highlights.length && next.every((h, i) => h.id === highlights[i].id);
      highlights = next;
      if (sameIds) layout();
      else paint();
      renderCard();
    }
    if (area === 'session') {
      for (const [k, { newValue }] of Object.entries(changes)) {
        const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
        if (kind === 'pending') newValue ? pending.add(id) : pending.delete(id);
        else if (kind === 'stream') { if (newValue) streams[id] = newValue; else delete streams[id]; }
        else continue;
        if (id === open?.id) renderCard();
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === 'page.extract') sendResponse(extractArticle());
    if (msg.type === 'highlight.scroll') {  // side panel picked a thread
      const rect = ranges.get(msg.id)?.getBoundingClientRect();
      if (rect) scrollTo({ top: rect.top + scrollY - innerHeight / 3, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      if (ranges.has(msg.id)) openCard({ id: msg.id });
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
      else layout();  // content shifted (images, embeds)
    }, 800);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  load();
})();
