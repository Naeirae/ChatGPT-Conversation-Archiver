(() => {
  const EXTENSION_VERSION = chrome.runtime.getManifest().version;
  if (window.__CHATGPT_ARCHIVER_LOADED__ === EXTENSION_VERSION) return;
  window.__CHATGPT_ARCHIVER_LOADED__ = EXTENSION_VERSION;

  const ROLE_SELECTOR = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-role="user"]',
    '[data-role="assistant"]',
    '[data-message-author="user"]',
    '[data-message-author="assistant"]'
  ].join(',');
  const TURN_SHELL_SELECTOR = [
    'section[data-turn="user"]',
    'section[data-turn="assistant"]',
    'article[data-turn="user"]',
    'article[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]',
    '[data-turn-key]'
  ].join(',');
  const TURN_SELECTOR = TURN_SHELL_SELECTOR + ',' + ROLE_SELECTOR;
  const EXPAND_RE = /^(show more|read more|expand|показать больше|показать полностью|читать полностью|развернуть|ещ[её]|more)$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = { running: false, jobId: null, cancel: false };
  let lastProgressAt = 0;
  const SETTINGS_KEY = 'archiverSettings';
  const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
  const REASONING_LABEL_RE = /^(думаю|размышляю|thinking|reasoning|show thinking|show reasoning|показать рассуждения|показать размышления)$/i;
  const reasoningClicked = new WeakSet();

  async function getSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function absUrl(value) {
    try { return new URL(value, location.href).href; }
    catch (_) { return value || ''; }
  }

  function isVisible(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  const visible = isVisible;

  function getRoleNodes() {
    const nodes = [...document.querySelectorAll(ROLE_SELECTOR)]
      .filter(isVisible)
      .filter(node => !node.parentElement?.closest(ROLE_SELECTOR));
    return nodes;
  }

  function getTurn(node) {
    return node.closest('[data-testid^="conversation-turn-"]') ||
      node.closest('section[data-turn]') ||
      node.closest('article[data-turn]') ||
      node.closest('[data-turn-key]') ||
      node;
  }

  function orderedTurns() {
    const result = [];
    const seen = new Set();

    // Prefer a real turn shell when one exists.
    document.querySelectorAll(TURN_SHELL_SELECTOR).forEach(shell => {
      const role = roleOf(shell);
      const hasRoleChild = shell.matches(ROLE_SELECTOR) || shell.querySelector(ROLE_SELECTOR);
      if (!hasRoleChild && !role) return;
      if (seen.has(shell)) return;
      seen.add(shell);
      result.push(shell);
    });

    // Current ChatGPT rollouts may have no article/section turn shell at all.
    // In that case the role-bearing node itself is the message container.
    getRoleNodes().forEach(node => {
      const turn = getTurn(node);
      if (seen.has(turn)) return;
      seen.add(turn);
      result.push(turn);
    });

    return result.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  async function waitForTurns(timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const turns = orderedTurns();
      if (turns.length) return turns;
      await sleep(250);
    }
    return [];
  }

  function roleOf(turn) {
    const roleNode = turn.matches(ROLE_SELECTOR) ? turn : turn.querySelector(ROLE_SELECTOR);
    const role =
      roleNode?.getAttribute('data-message-author-role') ||
      roleNode?.getAttribute('data-role') ||
      roleNode?.getAttribute('data-message-author');
    if (role === 'user' || role === 'assistant') return role;
    const dataTurn = turn.getAttribute('data-turn');
    if (dataTurn === 'user' || dataTurn === 'assistant') return dataTurn;
    return null;
  }

  function findScrollContainer(turn) {
    let el = turn && turn.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80) return el;
      el = el.parentElement;
    }

    const candidates = [
      document.scrollingElement,
      document.documentElement,
      ...document.querySelectorAll('main, main *, [class*="overflow-y-auto"], [class*="overflow-auto"]')
    ].filter((candidate, index, all) =>
      candidate &&
      all.indexOf(candidate) === index &&
      candidate instanceof Element
    ).filter(candidate => {
      const style = getComputedStyle(candidate);
      return /(auto|scroll|overlay)/.test(style.overflowY) &&
        candidate.scrollHeight > candidate.clientHeight + 80;
    });

    const containing = candidates.filter(candidate => candidate.contains(turn));
    if (containing.length) {
      return containing.sort((a, b) =>
        (a.scrollHeight - a.clientHeight) - (b.scrollHeight - b.clientHeight)
      )[0];
    }

    return candidates.sort((a, b) =>
      (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
    )[0] || document.scrollingElement || document.documentElement;
  }


  function reasoningRoots(turn) {
    const selectors = [
      '[data-testid*="reasoning"]',
      '[data-testid*="thinking"]',
      '[class*="reasoning"]',
      '[class*="thinking"]'
    ];
    const roots = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const el of turn.querySelectorAll(selector)) {
        if (seen.has(el) || !visible(el)) continue;
        if (el.matches('button, [role="button"]')) continue;
        if (el.querySelector('.markdown, [class*="markdown"], [class*="prose"]')) continue;
        const text = String(el.innerText || el.textContent || '').trim();
        if (text.length < 2) continue;
        seen.add(el);
        roots.push(el);
      }
    }
    return roots;
  }

  async function expandReasoningVisible(turns) {
    let clicks = 0;
    for (const turn of turns || orderedTurns()) {
      for (const el of turn.querySelectorAll('button, [role="button"]')) {
        if (!visible(el) || el.disabled || reasoningClicked.has(el)) continue;
        const label = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ').trim();
        if (!REASONING_LABEL_RE.test(label)) continue;
        if (el.getAttribute('aria-expanded') === 'true') {
          reasoningClicked.add(el);
          continue;
        }
        try {
          el.click();
          reasoningClicked.add(el);
          clicks++;
          await sleep(320);
        } catch (_) {}
      }
    }
    return clicks;
  }

  function captureReasoning(turn) {
    const roots = reasoningRoots(turn);
    if (!roots.length) return { html: '', text: '' };
    const holder = document.createElement('div');
    const texts = [];
    for (const root of roots) {
      const clone = cleanClone(root);
      holder.appendChild(clone);
      const text = String(root.innerText || root.textContent || '').trim();
      if (text) texts.push(text);
    }
    return { html: holder.innerHTML, text: texts.join('\n\n') };
  }

  function contentRoot(turn, role) {
    const roleNode = turn.matches(ROLE_SELECTOR) ? turn : turn.querySelector(ROLE_SELECTOR);
    if (role === 'user' && roleNode) return roleNode;
    if (role === 'assistant' && roleNode) {
      return roleNode.querySelector('.markdown') ||
        roleNode.querySelector('[class*="markdown"]') ||
        roleNode.querySelector('[class*="prose"]') ||
        roleNode.querySelector('[id^="textdoc-message-"] .ProseMirror') ||
        roleNode;
    }
    return turn.querySelector('.markdown, [class*="markdown"], [class*="prose"], [id^="textdoc-message-"] .ProseMirror') || turn;
  }

  function cleanClone(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script, style, button, textarea, form, [role="button"], [aria-hidden="true"]')
      .forEach(node => node.remove());
    clone.querySelectorAll('*').forEach(node => {
      [...node.attributes].forEach(attr => { if (/^on/i.test(attr.name)) node.removeAttribute(attr.name); });
    });
    clone.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', absUrl(a.getAttribute('href'))));
    clone.querySelectorAll('img').forEach((img, index) => {
      const src = img.getAttribute('src') || img.currentSrc || '';
      if (src) img.setAttribute('src', absUrl(src));
      img.setAttribute('data-archiver-image-index', String(index));
      img.removeAttribute('loading');
    });
    return clone;
  }

  function captureTurn(turn, ordinal, settings) {
    const role = roleOf(turn);
    if (!role) return null;
    const root = contentRoot(turn, role);
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
    const reasoning = role === 'assistant' && settings?.includeReasoning ? captureReasoning(turn) : { html: '', text: '' };
    const explicitId = turn.getAttribute('data-message-id') || turn.getAttribute('data-turn-id');
    return {
      id: explicitId || ((turn.getAttribute('data-testid') || role) + ':' + ordinal + ':' + hashText(text)),
      role,
      text,
      html: clone.innerHTML,
      images,
      reasoningHtml: reasoning.html,
      reasoningText: reasoning.text
    };
  }

  async function expandVisible() {
    let clicks = 0;
    for (const turn of orderedTurns()) {
      for (const el of turn.querySelectorAll('button, [role="button"]')) {
        const label = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ').trim();
        if (!label || !EXPAND_RE.test(label)) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        try { el.click(); clicks++; await sleep(70); } catch (_) {}
      }
    }
    return clicks;
  }

  function collect(map, order, settings) {
    orderedTurns().forEach((turn, ordinal) => {
      const message = captureTurn(turn, ordinal, settings);
      if (!message) return;
      if (!map.has(message.id)) order.push(message.id);
      map.set(message.id, message);
    });
  }

  async function updateJob(patch) {
    const data = await chrome.storage.local.get('activeCaptureJob');
    const current = data.activeCaptureJob || {};
    const next = Object.assign({}, current, patch, { updatedAt: Date.now() });
    await chrome.storage.local.set({ activeCaptureJob: next });
    return next;
  }

  async function progress(message, count, extra) {
    const now = Date.now();
    if (now - lastProgressAt < 500 && !(extra && extra.force)) return;
    lastProgressAt = now;
    await updateJob(Object.assign({ status: 'running', message, count }, extra || {}));
  }

  async function waitForDomQuiet(scroller, timeout) {
    const started = Date.now();
    let last = scroller.scrollHeight + ':' + document.querySelectorAll(TURN_SELECTOR).length;
    while (Date.now() - started < timeout) {
      await sleep(180);
      const next = scroller.scrollHeight + ':' + document.querySelectorAll(TURN_SELECTOR).length;
      if (next === last) return;
      last = next;
    }
  }

  async function reachTop(scroller, map, order, jobId, settings) {
    let stable = 0;
    let previousHeight = -1;
    let previousCount = -1;
    let previousTop = -1;
    for (let i = 0; i < 160; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');
      scroller.scrollTo({ top: 0, behavior: 'auto' });
      await sleep(280);
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);
      const top = Math.round(scroller.scrollTop);
      const height = scroller.scrollHeight;
      const count = document.querySelectorAll(TURN_SELECTOR).length;
      await progress('Отматываю в начало и загружаю старые сообщения… ' + map.size, map.size, { phase: 'top' });
      if (top <= 2 && height === previousHeight && count === previousCount && previousTop <= 2) stable++;
      else stable = 0;
      previousHeight = height;
      previousCount = count;
      previousTop = top;
      if (stable >= 5) return;
      scroller.scrollBy(0, 140);
      await sleep(130);
      scroller.scrollTo({ top: 0, behavior: 'auto' });
      await waitForDomQuiet(scroller, 1100);
    }
    throw new Error('Не удалось надежно дойти до начала переписки: страница продолжает догружаться.');
  }

  async function walkDown(scroller, map, order, jobId, settings) {
    let stable = 0;
    let previousHeight = -1;
    let previousCount = -1;
    let previousTop = -1;
    for (let i = 0; i < 1600 && stable < 5; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);
      const viewport = scroller.clientHeight || innerHeight;
      const max = Math.max(0, scroller.scrollHeight - viewport);
      const current = Math.max(0, Math.round(scroller.scrollTop));
      const next = Math.min(max, current + Math.max(420, Math.floor(viewport * 0.68)));
      if (next >= max - 4) {
        await sleep(520);
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);
        const height = scroller.scrollHeight;
        const count = document.querySelectorAll(TURN_SELECTOR).length;
        const top = Math.round(scroller.scrollTop);
        if (height === previousHeight && count === previousCount && top === previousTop) stable++;
        else stable = 0;
        previousHeight = height;
        previousCount = count;
        previousTop = top;
        scroller.scrollTo({ top: height, behavior: 'auto' });
      } else {
        stable = 0;
        scroller.scrollTo({ top: next, behavior: 'auto' });
        await sleep(240);
        await waitForDomQuiet(scroller, 1000);
      }
      if (i % 3 === 0) await progress('Собираю переписку… ' + map.size + ' сообщений', map.size, { phase: 'walk', position: Math.round(scroller.scrollTop) });
    }
    if (stable < 5) throw new Error('Не удалось надежно дойти до конца переписки.');
  }

  async function captureConversation(jobId) {
    if (state.running) return;
    state.running = true;
    state.jobId = jobId;
    state.cancel = false;
    lastProgressAt = 0;
    const map = new Map();
    const order = [];
    let scroller = null;
    let originalScrollTop = 0;
    try {
      const settings = await getSettings();
      await progress('Подготовка фонового сбора…', 0, { phase: 'starting', force: true });
      const turns = await waitForTurns(10000);
      const firstTurn = turns[0];
      if (!firstTurn) {
        const roleCount = document.querySelectorAll(ROLE_SELECTOR).length;
        const shellCount = document.querySelectorAll(TURN_SHELL_SELECTOR).length;
        throw new Error(`Не удалось найти реплики ChatGPT. role-узлов: ${roleCount}, оболочек: ${shellCount}. Возможно, интерфейс еще загружается или ChatGPT изменил DOM.`);
      }
      scroller = findScrollContainer(firstTurn);
      originalScrollTop = scroller.scrollTop;
      await reachTop(scroller, map, order, jobId, settings);
      await walkDown(scroller, map, order, jobId, settings);
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);
      const messages = order.map(id => map.get(id)).filter(Boolean);
      if (!messages.length) throw new Error('Сообщения не найдены. Возможно, ChatGPT изменил структуру страницы.');
      const conversation = {
        title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount: messages.reduce((sum, item) => sum + (item.images ? item.images.length : 0), 0)
      };
      const archiveId = String(Date.now()) + '-' + hashText(conversation.sourceUrl);
      const currentJob = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
      await chrome.storage.local.set({
        ['archive:' + archiveId]: Object.assign({}, conversation, { id: archiveId }),
        lastArchiveId: archiveId,
        activeCaptureJob: Object.assign({}, currentJob, {
          jobId,
          status: 'done',
          message: 'Переписка собрана.',
          count: messages.length,
          imageCount: conversation.imageCount,
          archiveId,
          finishedAt: Date.now(),
          updatedAt: Date.now()
        })
      });
      try { await chrome.runtime.sendMessage({ type: 'ARCHIVER_CAPTURE_COMPLETE', jobId, archiveId, count: messages.length }); } catch (_) {}
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const status = /отменен/i.test(message) ? 'cancelled' : 'error';
      const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
      await chrome.storage.local.set({ activeCaptureJob: Object.assign({}, current, { jobId, status, message, finishedAt: Date.now(), updatedAt: Date.now() }) });
    } finally {
      state.running = false;
      state.jobId = null;
      state.cancel = false;
      if (scroller) scroller.scrollTo({ top: originalScrollTop, behavior: 'auto' });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'ARCHIVER_START_CAPTURE') {
      if (state.running) {
        sendResponse({ ok: true, running: true, jobId: state.jobId });
        return false;
      }
      captureConversation(message.jobId).catch(() => {});
      sendResponse({ ok: true, running: true, jobId: message.jobId });
      return false;
    }
    if (message && message.type === 'ARCHIVER_CANCEL_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) state.cancel = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();