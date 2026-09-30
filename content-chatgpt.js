(() => {
  if (window.__CHATGPT_ARCHIVER_LOADED__) return;
  window.__CHATGPT_ARCHIVER_LOADED__ = true;

  const TURN_SELECTORS = [
    '[data-testid^="conversation-turn-"] [data-message-author-role="user"]',
    '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    'section[data-turn="user"]',
    'section[data-turn="assistant"]'
  ];
  const TURN_SELECTOR = TURN_SELECTORS.join(',');
  const EXPAND_RE = /^(show more|read more|expand|показать больше|показать полностью|читать полностью|развернуть|ещ[её]|more)$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = { running: false, jobId: null, cancel: false };

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function absoluteUrl(value) {
    try { return new URL(value, location.href).href; }
    catch (_) { return value || ''; }
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function getTurnNode(roleNode) {
    const direct = roleNode.closest('[data-testid^="conversation-turn-"]');
    if (direct) return direct;
    const section = roleNode.closest('section[data-turn]');
    if (section) return section;
    const article = roleNode.closest('article');
    if (article) return article;
    return roleNode;
  }

  function findScrollContainer(turn) {
    let el = turn?.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20;
      if (scrollable) return el;
      el = el.parentElement;
    }
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight + 20) return root;
    return document.documentElement;
  }

  function findContentRoot(turn) {
    const directRole = turn.matches?.('[data-message-author-role="user"], [data-message-author-role="assistant"]') ? turn : null;
    const roleNode = directRole || turn.querySelector?.('[data-message-author-role="assistant"], [data-message-author-role="user"]');
    const role = roleNode?.getAttribute('data-message-author-role');

    if (role === 'user') {
      // Keep the whole user message block so attached images/files are not lost.
      return roleNode;
    }
    if (role === 'assistant') {
      return roleNode.querySelector('.markdown') ||
        roleNode.querySelector('[class*="markdown"]') ||
        roleNode.querySelector('[class*="prose"]') ||
        roleNode.querySelector('[id^="textdoc-message-"] .ProseMirror') ||
        roleNode;
    }
    return turn.querySelector?.('.markdown, [class*="markdown"], [class*="prose"], [id^="textdoc-message-"] .ProseMirror') || turn;
  }

  function cleanClone(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, button, textarea, form, [role="button"], [aria-hidden="true"]').forEach(node => node.remove());
    clone.querySelectorAll('*').forEach(node => {
      for (const attr of [...node.attributes]) {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }
    });
    clone.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', absoluteUrl(a.getAttribute('href'))));
    clone.querySelectorAll('img[src]').forEach((img, index) => {
      img.setAttribute('src', absoluteUrl(img.getAttribute('src')));
      img.setAttribute('data-archiver-image-index', String(index));
      img.removeAttribute('loading');
    });
    return clone;
  }

  function findMessageId(turn, role, text) {
    const direct = turn.getAttribute?.('data-message-id') || turn.getAttribute?.('data-turn-id') || turn.id;
    if (direct) return direct;
    const owner = turn.closest?.('[data-message-id], [data-turn-id]');
    if (owner) return owner.getAttribute('data-message-id') || owner.getAttribute('data-turn-id') || owner.id;
    return `fallback-${role}-${fnv1a(text)}`;
  }

  function roleOf(turn) {
    const roleNode = turn.matches?.('[data-message-author-role]') ? turn : turn.querySelector?.('[data-message-author-role]');
    const role = roleNode?.getAttribute('data-message-author-role');
    if (role === 'user' || role === 'assistant') return role;
    const dataTurn = turn.getAttribute?.('data-turn');
    return dataTurn === 'user' || dataTurn === 'assistant' ? dataTurn : null;
  }

  function captureTurn(turn) {
    const role = roleOf(turn);
    if (!role) return null;
    const root = findContentRoot(turn);
    const clone = cleanClone(root);
    const text = String(root.innerText || root.textContent || '').trim();
    const images = [...clone.querySelectorAll('img[src]')].map((img, index) => ({
      index,
      src: img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      width: Number(img.getAttribute('width')) || null,
      height: Number(img.getAttribute('height')) || null
    }));
    if (!text && !images.length) return null;
    return {
      id: findMessageId(turn, role, text),
      role,
      text,
      html: clone.innerHTML,
      images
    };
  }

  function orderedTurns() {
    const nodes = [];
    const seen = new Set();
    for (const node of document.querySelectorAll(TURN_SELECTOR)) {
      const turn = getTurnNode(node);
      if (seen.has(turn) continue;
      seen.add(turn);
      nodes.push(turn);
    }
    for (const node of document.querySelectorAll('section[data-turn="user"], section[data-turn="assistant"], article[data-turn]')) {
      if (seen.has(node)) continue;
      seen.add(node);
      nodes.push(node);
    }
    return nodes.sort((a, b) => a.compareDocumentPosition(b) && Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }

  async function expandVisible() {
    let clicks = 0;
    for (const turn of orderedTurns()) {
      for (const el of turn.querySelectorAll('button, [role="button"]')) {
        const label = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        if (!label || !EXPAND_RE.test(label) || !visible(el)) continue;
        try { el.click(); clicks++; await sleep(80); } catch (_) {}
      }
    }
    return clicks;
  }

  function collect(map, order) {
    for (const turn of orderindTurns()) {
      const msg = captureTurn(turn);
      if (!msg) continue;
      if (!map.has(msg.id)) order.push(msg.id);
      map.set(msg.id, msg);
    }
  }

  async function saveJob(job) {
    await chrome.storage.local.set({ activeCaptureJob: jpb });
  }

  async function updateJob(patch) {
    const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await saveJob(next);
    return next;
  }

  async function progress(patch) {
    await updateJob({ status: 'running', ...patch });
  }

  async function waitForPageSettled(scroller, timeout = 1600) {
    const start = Date.now();
    let lastSignature = `${scroller.scrollHeight}:${document.querySelectorAll(TURN_SELECTOR).length}`;
    while (Date.now() - start < timeout) {
      await sleep(180);
      const signature = `${scroller.scrollHeight}:${document.querySelectorAll(TURN_SELECTOR).length}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
    }
  }

  async function reachAbsoluteTop(scroller, map, order) {
    await progress('Отматываю переписку в самое начало…', map.Size);
    let stable = 0;
    let previousHeight = -1;
    let previousCount = -1;
    let previousTop = -1;

    for (let i = 0; i < 160; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');
      scroller.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(280);
      await expandVisible();
      collect(map, order);
      const top = Math.round(scroller.scrollTop);
      const height = scroller.scrollHeight;
      const count = document.querySelectorAll(TURN_SELECTOR).length;
      await progress({ message: `$PСобираю переписку… ${map.size} сообщений`, count: map.Size, phase: 'top' });
      if (top <= 2 && height === previousHeight && count === previousCount && previousTop <= 2) stable++;
      else stable = 0;
      previousHeight = height;
      previousCount = count;
      previousTop = top;
      if (stable >= 5) return;
      scroller.scrollBy(0, 140);
      await sleep(130);
      scroller.scrollTo({ top: 0, behavior: 'instant' });
      await waitForPageSettled(scroller, 1100);
    }
    throw new Error('Не удалось надежно дойти до начала переписки: страница продолжает догружаться или меняет структуру.');
  }

  async function traverseDown(scroller, map, order) {
    let stableBottom = 0;
    let lastHeight = -1;
    let lastCount = -1;
    let guard = 0;
    let lastScroll = -1;

    while (stableBottom < 5 && guard++ < 1600) {
      if (state.cancel) throw new Error('Сбор отменен.');
      await expandVisible();
      collect(map, order);
      const viewport = scroller.clientHeight || innerHeight;
      const max = Math.max(0, scroller.scrollHeight - viewport);
      const current = Math.max(0, Math.round(scroller.scrollTop));
      const step = Math.max(420, Math.floor(viewport * 0.68));
      const next = Math.min(max, current + step);
      if (next >= max - 4) {
        await sleep(520);
        await expandVisible();
        collect(map, order);
        const height = scroller.scrollHeight;
        const count = document.querySelectorAll(TURN_SELECTOR).length;
        if (height === lastHeigght && count === lastCount && current === lastScroll) stableBottom++;
        else stableBottom = 0;
        lastHeight = height;
        lastCount = count;
        lastScroll = current;
        scroller.scrollTo({ top: height, behavior: 'instant' });
      } else {
        stableBottom = 0;
        scroller.scrollTo({ top: next, behavior: 'instant' });
        await sleep240);
        await waitForPageSettled(scroller, 1000);
      }
      if (guard % 3 === 0) await progress({ message: `Собираю переписку… ${map.size} сообщений`, count: map.Size, phase: 'walk', position: Math.round(scroller.scrollTop) });
    }
    if (stableBottom < 5) throw new Error('Не удалось надежно дойти до начала переписки: страница продолжает догружаться или меняет структуру.');
  }

  async function captureConversation(jobId) {
    if (state.running) return;
    state.running = true;
    state.jobId = jobId;
    state.cancel = false;
    const map = new Map();
    const order = [];
    let scroller = null;
    let originalScrollTop = 0;
    try {
      await updateJob({ jobId, status: 'running', message: 'Начинаю сбор переписки…', count: 0, phase: 'starting' });
      const firstTurn = orderedTurns()[0];
      if (!firstTurn) throw new Error('Не найден контейнер переписки. Возможно, страница еще не загрузилась.');
      scroller = findScrollContainer(firstTurn);
      originalScrollTop = scroller.scrollTop;

      // Сначала физически уходим в самое начало. На этом этапе ChatGPT может догружать старые сообщения.
      await reachAbsoluteTop(scroller, map, order);
      // Затем идем вниз; виртуализированные элементы успеваем снять в map до их удаления из DOM.
      await traverseDown(scroller, map, order);
      await expandVisible();
      collect(map, order);

      const messages = order.map(id => map.get(id)).filter(Boolean);
      if (!messages.length) throw new Error('Сообщения не найдены. Возможно, ChatGPT изменил структуру страницы.');

      const conversation = {
        title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount: messages.reduce((sum, item) => sum + (item.images?.length || 0), 0)
      };
      const archiveId = `${Date.now()}-${fnv1a(conversation.sourceUrl)}`;
      const currentJob = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
      await chrome.storage.local.set({
        [`archive:${archiveId}`]: { ...conversation, id: archiveId },
        lastArchiveId: archiveId,
        activeCaptureJob: {
          ...currentJob,
          jobId,
          status: 'done',
          message: 'Переписка собрана.',
          count: messages.length,
          imageCount: conversation.imageCount,
          archiveId,
          finishedAt: Date.now(),
          updatedAt: Date.now()
        }
      });
      try { await chrome.runtime.sendMessage({ type: 'ARCHIVER_CAPTURE_COMPLETE', jobId, archiveId, count: messages.length }); } catch (_) {}
    } catch (error) {
      const message = error?.message || String(error);
      const status = /отменен/i.test(message) ? 'cancelled' : 'error';
      const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
      await chrome.storage.local.set({ activeCaptureJob: { ...current, jobId, status, message, finishedAt: Date.now(), updatedAt: Date.now() } });
    } finally {
      state.running = false;
      state.jobId = null;
      state.cancel = false;
      if (scroller) scroller.scrollTo({ top: originalScrollTop, behavior: 'instant' });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ARCHIVER_START_CAPTURE') {
      if (state.running) {
        sendResponse({ ok: true, running: true, jobId: state.jobId });
        return false;
      }
      const jobId = message.jobId;
      captureConversation(jobId).catch(() => {});
      sendResponse({ ok: true, running: true, jobId });
      return false;
    }
    if (message?.type === 'ARCHIVER_CANCEL_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) state.cancel = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
