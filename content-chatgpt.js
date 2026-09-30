(() => {
  const TURN_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const EXPAND_RE = /^(show more|read more|expand|показать больше|показать полностью|читать полностью|развернуть|ещ[её])$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function findContentRoot(turn) {
    return turn.querySelector('.markdown') ||
      turn.querySelector('[class*="markdown"]') ||
      turn.querySelector('.whitespace-pre-wrap') ||
      turn.querySelector('[class*="whitespace-pre-wrap"]') ||
      turn.querySelector('[class*="prose"]') ||
      turn;
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
    const direct = turn.getAttribute('data-message-id') || turn.id;
    if (direct) return direct;
    const owner = turn.closest('[data-message-id]');
    if (owner?.getAttribute('data-message-id')) return owner.getAttribute('data-message-id');
    const article = turn.closest('article[id]');
    if (article?.id) return article.id;
    return `fallback-${role}-${fnv1a(text)}`;
  }

  function captureTurn(turn) {
    const role = turn.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') return null;
    const root = findContentRoot(turn);
    const clone = cleanClone(root);
    const text = String(root.innerText || root.textContent || '').trim();
    if (!text && !clone.querySelector('img')) return null;
    const images = [...clone.querySelectorAll('img[src]')].map((img, index) => ({
      index,
      src: img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      width: Number(img.getAttribute('width')) || null,
      height: Number(img.getAttribute('height')) || null
    }));
    return {
      id: findMessageId(turn, role, text),
      role,
      text,
      html: clone.innerHTML,
      images
    };
  }

  async function expandVisibleTurns() {
    let clicks = 0;
    for (const turn of document.querySelectorAll(TURN_SELECTOR)) {
      const candidates = [...turn.querySelectorAll('button, [role="button"]')];
      for (const el of candidates) {
        const label = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (!label || !EXPAND_RE.test(label)) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        try {
          el.click();
          clicks++;
          await sleep(80);
        } catch (_) {}
      }
    }
    return clicks;
  }

  function orderedVisibleTurns() {
    return [...document.querySelectorAll(TURN_SELECTOR)].sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.top + scrollY) - (br.top + scrollY);
    });
  }

  function storeVisible(map, order) {
    for (const turn of orderedVisibleTurns()) {
      const msg = captureTurn(turn);
      if (!msg) continue;
      if (!map.has(msg.id)) order.push(msg.id);
      map.set(msg.id, msg);
    }
  }

  async function notifyProgress(message, extra = {}) {
    try { await chrome.runtime.sendMessage({ type: 'ARCHIVER_CAPTURE_PROGRESS', message, ...extra }); }
    catch (_) {}
  }

  async function settleAtTop(map, order) {
    let stable = 0;
    let previous = -1;
    for (let i = 0; i < 12 && stable < 3; i++) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(450);
      await expandVisibleTurns();
      storeVisible(map, order);
      const current = document.querySelectorAll(TURN_SELECTOR).length;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      await notifyProgress(`Загружаю начало переписки… ${map.size} сообщений`, { count: map.size });
    }
  }

  async function traverseConversation() {
    const map = new Map();
    const order = [];
    await settleAtTop(map, order);

    let stableBottom = 0;
    let lastHeight = 0;
    let guard = 0;
    while (stableBottom < 3 && guard++ < 800) {
      await expandVisibleTurns();
      storeVisible(map, order);
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const current = Math.max(0, scrollY);
      if (current >= max - 8) {
        await sleep(500);
        await expandVisibleTurns();
        storeVisible(map, order);
        const h = document.documentElement.scrollHeight;
        stableBottom = h === lastHeight ? stableBottom + 1 : 0;
        lastHeight = h;
        window.scrollTo({ top: h, behavior: 'instant' });
      } else {
        stableBottom = 0;
        window.scrollTo({ top: Math.min(max, current + Math.max(450, Math.floor(innerHeight * 0.75))), behavior: 'instant' });
        await sleep(240);
      }
      if (guard % 4 === 0) await notifyProgress(`Собираю переписку… ${map.size} сообщений`, { count: map.size });
    }

    await expandVisibleTurns();
    storeVisible(map, order);

    const messages = order.map(id => map.get(id)).filter(Boolean);
    const imageCount = messages.reduce((sum, item) => sum + (item.images?.length || 0), 0);
    return { messages, imageCount };
  }

  async function captureConversation() {
    const originalY = scrollY;
    await notifyProgress('Начинаю сбор переписки…');
    try {
      const { messages, imageCount } = await traverseConversation();
      const title = document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation';
      return {
        title,
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount
      };
    } finally {
      window.scrollTo({ top: originalY, behavior: 'instant' });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ARCHIVER_CAPTURE_CONVERSATION') return;
    captureConversation()
      .then(conversation => sendResponse({ ok: true, conversation }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
