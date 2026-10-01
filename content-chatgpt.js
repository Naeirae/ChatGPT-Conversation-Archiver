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
    '[data-chatgpt-search-unit-key$=":user"]',
    '[data-chatgpt-search-unit-key$=":assistant"]'
  ].join(',');
  const TURN_WRAPPER_SELECTOR = '[data-turn-key]';
  const TURN_SELECTOR = TURN_SHELL_SELECTOR + ',' + ROLE_SELECTOR;
  const EXPAND_RE = /^(show more|read more|expand|показать больше|показать полностью|читать полностью|развернуть|ещ[её]|more)$/i;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const state = { running: false, jobId: null, cancel: false };
  let lastProgressAt = 0;
  const SETTINGS_KEY = 'archiverSettings';
  const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
  const REASONING_ACTION_EXCLUDE_RE = /copy|share|regenerate|retry|edit|like|dislike|feedback|citation|source|download|listen|read aloud|stop|поделиться|скопировать|повторить|изменить|источник|скачать|озвучить/i;
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

  function normalizeDisplayText(text = '') {
    return String(text)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeMatchText(text = '') {
    return normalizeDisplayText(text)
      .split('\n')
      .map(line => line
        .replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/u, '')
        .trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanMessageText(text = '', role = '') {
    let value = normalizeDisplayText(text);
    if (role === 'assistant') {
      value = value.replace(/^(?:ChatGPT\s+(?:сказал|said):)\s*/i, '');
    }
    return normalizeDisplayText(value);
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
    return node.closest('[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]') ||
      node.closest('[data-testid^="conversation-turn-"]') ||
      node.closest('section[data-turn]') ||
      node.closest('article[data-turn]') ||
      node.closest('[data-turn-key]') ||
      node;
  }

  function orderedTurns() {
    const result = [];
    const seen = new Set();

    // Current ChatGPT virtualizes the conversation. A data-turn-key wrapper can
    // contain both the user and assistant message, so it is not itself a message.
    document.querySelectorAll(TURN_SHELL_SELECTOR).forEach(shell => {
      if (!roleOf(shell) || seen.has(shell)) return;
      seen.add(shell);
      result.push(shell);
    });

    getRoleNodes().forEach(node => {
      const turn = getTurn(node);
      if (!roleOf(turn) || seen.has(turn)) return;
      seen.add(turn);
      result.push(turn);
    });

    // Fallback only for rollouts that expose a single message directly under a
    // data-turn-key wrapper and no more specific message shell.
    if (!result.length) {
      document.querySelectorAll(TURN_WRAPPER_SELECTOR).forEach(wrapper => {
        const role = roleOf(wrapper);
        if (!role) return;
        const units = wrapper.querySelectorAll(
          '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]'
        );
        if (units.length > 1 || seen.has(wrapper)) return;
        seen.add(wrapper);
        result.push(wrapper);
      });
    }

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
    const searchUnit = turn.getAttribute('data-chatgpt-search-unit-key') || '';
    if (searchUnit.endsWith(':user')) return 'user';
    if (searchUnit.endsWith(':assistant')) return 'assistant';
    return null;
  }

  function turnStableKey(turn) {
    if (!turn) return '';

    const role = roleOf(turn) || 'unknown';
    const nodes = [
      turn,
      turn.matches?.(ROLE_SELECTOR) ? turn : turn.querySelector?.(ROLE_SELECTOR)
    ].filter(Boolean);

    for (const attr of ['data-message-id', 'data-turn-id']) {
      for (const node of nodes) {
        const value = String(node.getAttribute?.(attr) || '').trim();
        if (value) return attr + ':' + value;
      }
    }

    // Current ChatGPT virtualization exposes a stable UUID on the outer turn
    // wrapper, while data-chatgpt-search-unit-key may be positional
    // (fallback-turn-N) and can change as the virtualized list is rebuilt.
    const wrapper = turn.closest?.('[data-turn-key]') || turn.querySelector?.('[data-turn-key]');
    const wrapperKey = String(wrapper?.getAttribute?.('data-turn-key') || '').trim();
    if (wrapperKey) {
      return 'turn:' + wrapperKey + ':' + role + ':' +
        hashText(normalizeMatchText(turnMessageText(turn)));
    }

    const searchUnit = String(turn.getAttribute?.('data-chatgpt-search-unit-key') || '').trim();
    if (searchUnit) return 'search:' + searchUnit + ':' + hashText(String(contentRoot(turn, role)?.innerText || ''));

    for (const node of nodes) {
      const testId = String(node.getAttribute?.('data-testid') || '').trim();
      if (testId) return 'testid:' + testId + ':' + hashText(String(contentRoot(turn, role)?.innerText || ''));
    }

    return '';
  }

  function turnMessageText(turn) {
    const role = roleOf(turn) || 'unknown';
    const root = contentRoot(turn, role);
    return cleanMessageText(String(root?.innerText || root?.textContent || ''), role);
  }

  function turnTextSignature(turn) {
    const role = roleOf(turn) || 'unknown';
    return role + ':' + hashText(normalizeMatchText(turnMessageText(turn)));
  }

  function messageTextSignature(message) {
    const role = message?.role || 'unknown';
    return role + ':' + hashText(normalizeMatchText(cleanMessageText(String(message?.text || ''), role)));
  }

  function makeCaptureBoundary(turns) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const key = turnStableKey(turns[i]);
      if (key) return { kind: 'stable', key, role: roleOf(turns[i]) || '', ordinal: i };
    }

    for (let i = turns.length - 1; i >= 0; i--) {
      if (roleOf(turns[i]) === 'user') {
        return { kind: 'signature', key: turnTextSignature(turns[i]), role: 'user', ordinal: i };
      }
    }

    const last = turns[turns.length - 1];
    return last ? { kind: 'signature', key: turnTextSignature(last), role: roleOf(last) || '', ordinal: turns.length - 1 } : null;
  }

  function matchesBoundary(turn, boundary) {
    if (!boundary || !turn) return false;
    if (boundary.kind === 'stable') return turnStableKey(turn) === boundary.key;
    return turnTextSignature(turn) === boundary.key;
  }

  function boundaryIsVisible(boundary) {
    return Boolean(boundary && orderedTurns().some(turn => matchesBoundary(turn, boundary)));
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


  function reasoningLabel(el) {
    return String(
      el.innerText ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }

  function isReasoningDisclosure(el, turn, messageRoot) {
    if (!visible(el) || el.disabled) return false;
    if (!el.matches('button, [role="button"], [aria-expanded], [data-state="open"], [data-state="closed"]')) return false;
    if (el.getAttribute('aria-haspopup')) return false;

    const testId = String(el.getAttribute('data-testid') || '');
    if (REASONING_ACTION_EXCLUDE_RE.test(testId)) return false;

    const label = reasoningLabel(el);
    if (!label && !el.hasAttribute('aria-controls')) return false;
    if (REASONING_ACTION_EXCLUDE_RE.test(label)) return false;

    const buttonRect = el.getBoundingClientRect();
    const contentRect = messageRoot?.getBoundingClientRect?.();
    if (!buttonRect.width || !buttonRect.height) return false;

    // Reasoning/analysis controls are structurally before the final assistant
    // message. This does not depend on the language or the visible label.
    if (contentRect && buttonRect.top > contentRect.top + 24) return false;
    if (messageRoot && messageRoot.contains(el)) return false;

    return Boolean(
      el.hasAttribute('aria-expanded') ||
      el.hasAttribute('aria-controls') ||
      el.getAttribute('data-state') === 'open' ||
      el.getAttribute('data-state') === 'closed' ||
      el.closest('.relative.my-1.min-h-6')
    );
  }

  function reasoningCandidates(turn) {
    const messageRoot = contentRoot(turn, 'assistant');
    const candidates = [...turn.querySelectorAll(
      'button[aria-expanded], [role="button"][aria-expanded], button[aria-controls], [role="button"][aria-controls], [data-state="open"], [data-state="closed"], .relative.my-1.min-h-6 button, .relative.my-1.min-h-6 [role="button"]'
    )].filter(el => isReasoningDisclosure(el, turn, messageRoot));

    return candidates.sort((a, b) =>
      a.getBoundingClientRect().top - b.getBoundingClientRect().top
    );
  }

  function controlledReasoningRoot(trigger) {
    const ids = String(trigger.getAttribute('aria-controls') || '')
      .split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const target = document.getElementById(id);
      if (target && visible(target)) return target;
    }
    return null;
  }

  function siblingReasoningRoots(trigger, messageRoot) {
    const header = trigger.closest('.relative.my-1.min-h-6');
    if (!header?.parentElement) return [];

    const siblings = [...header.parentElement.children];
    const start = siblings.indexOf(header);
    if (start < 0) return [];

    const roots = [];
    for (let i = start + 1; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === messageRoot || sibling.contains(messageRoot)) break;
      if (!visible(sibling)) continue;
      const text = String(sibling.innerText || sibling.textContent || '').trim();
      if (text) roots.push(sibling);
    }
    return roots;
  }

  function captureReasoning(turn) {
    const messageRoot = contentRoot(turn, 'assistant');
    const candidates = reasoningCandidates(turn);
    if (!candidates.length) return { html: '', text: '', label: '', count: 0 };

    const holder = document.createElement('div');
    const texts = [];
    const labels = [];
    const seenRoots = new Set();

    for (const trigger of candidates) {
      const label = reasoningLabel(trigger);
      const controlled = controlledReasoningRoot(trigger);
      const roots = controlled ? [controlled] : siblingReasoningRoots(trigger, messageRoot);

      for (const root of roots) {
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        const clone = cleanClone(root);
        holder.appendChild(clone);
        const text = String(root.innerText || root.textContent || '').trim();
        if (text) texts.push(text);
      }
      if (label) labels.push(label);
    }

    if (!texts.length) return { html: '', text: '', label: labels[0] || '', count: 0 };
    return {
      html: holder.innerHTML,
      text: texts.join('\n\n'),
      label: labels[0] || 'Размышления',
      count: texts.length
    };
  }

  async function expandReasoningVisible(turns) {
    let clicks = 0;
    for (const turn of turns || orderedTurns()) {
      for (const el of reasoningCandidates(turn)) {
        if (reasoningClicked.has(el)) continue;
        const expanded = el.getAttribute('aria-expanded');
        const state = el.getAttribute('data-state');
        reasoningClicked.add(el);
        if (expanded === 'true' || state === 'open') continue;
        try {
          el.click();
          clicks++;
          await sleep(320);
        } catch (_) {}
      }
    }
    return clicks;
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

  function imageSource(img) {
    if (!(img instanceof HTMLImageElement)) return '';
    const direct =
      img.currentSrc ||
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      '';
    if (direct) return absUrl(direct);

    const srcset = String(img.getAttribute('srcset') || '').trim();
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
      if (first) return absUrl(first);
    }
    return '';
  }

  function imageSize(img) {
    const rect = img.getBoundingClientRect?.() || { width: 0, height: 0 };
    return {
      width: Math.round(
        Number(img.naturalWidth) ||
        Number(img.getAttribute?.('width')) ||
        Number(rect.width) ||
        0
      ),
      height: Math.round(
        Number(img.naturalHeight) ||
        Number(img.getAttribute?.('height')) ||
        Number(rect.height) ||
        0
      )
    };
  }

  function isLikelyContentImage(img) {
    const src = imageSource(img);
    if (!src) return false;

    const size = imageSize(img);
    const label = [
      img.getAttribute?.('alt') || '',
      img.getAttribute?.('aria-label') || '',
      img.className || '',
      img.closest?.('[data-testid]')?.getAttribute?.('data-testid') || ''
    ].join(' ').toLowerCase();

    // Do not treat tiny avatars/icons/emoji as conversation attachments.
    if (size.width && size.height && size.width <= 40 && size.height <= 40) return false;
    if (/(avatar|profile|favicon|emoji|icon)/i.test(label) &&
        (!size.width || size.width <= 64) &&
        (!size.height || size.height <= 64)) return false;

    return true;
  }

  function turnImageNodes(turn, role) {
    const nodes = [];
    const seen = new Set();

    const add = img => {
      if (!(img instanceof HTMLImageElement) || seen.has(img) || !isLikelyContentImage(img)) return;
      seen.add(img);
      nodes.push(img);
    };

    turn.querySelectorAll('img').forEach(add);

    // Current ChatGPT may render uploaded/generated attachments as siblings of
    // the role-bearing text node inside a shared data-turn-key wrapper. Include
    // those siblings, but exclude images that belong to the opposite message.
    const wrapper = turn.closest?.('[data-turn-key]');
    if (wrapper && wrapper !== turn) {
      const oppositeSelector = role === 'user'
        ? '[data-chatgpt-search-unit-key$=":assistant"], [data-message-author-role="assistant"], [data-role="assistant"]'
        : '[data-chatgpt-search-unit-key$=":user"], [data-message-author-role="user"], [data-role="user"]';

      wrapper.querySelectorAll('img').forEach(img => {
        const opposite = img.closest(oppositeSelector);
        if (!opposite) add(img);
      });
    }

    return nodes.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
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
      const src = imageSource(img);
      if (src) img.setAttribute('src', src);
      img.setAttribute('data-archiver-image-index', String(index));
      img.removeAttribute('loading');
      img.removeAttribute('srcset');
    });
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').forEach(node => {
      const label = normalizeMatchText(node.textContent || '');
      if (/^ChatGPT\s+(?:сказал|said):$/i.test(label)) node.remove();
    });
    return clone;
  }

  function captureTurn(turn, ordinal, settings) {
    const role = roleOf(turn);
    if (!role) return null;

    const root = contentRoot(turn, role);
    const clone = cleanClone(root);
    const text = cleanMessageText(String(root.innerText || root.textContent || ''), role);

    const imageNodes = turnImageNodes(turn, role);
    const images = [];
    const extraBefore = [];
    const extraAfter = [];
    const seenSrc = new Set();

    imageNodes.forEach(img => {
      const src = imageSource(img);
      if (!src || seenSrc.has(src)) return;
      seenSrc.add(src);

      const size = imageSize(img);
      const index = images.length;
      const item = {
        index,
        src,
        alt: img.getAttribute('alt') || '',
        width: size.width || null,
        height: size.height || null
      };
      images.push(item);

      // Images already inside the text root are present in clone.innerHTML.
      if (root.contains(img)) return;

      const escapedSrc = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const escapedAlt = String(item.alt || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const html = '<p data-archiver-attachment="true"><img src="' + escapedSrc +
        '" alt="' + escapedAlt + '" data-archiver-image-index="' + index + '"></p>';

      const pos = img.compareDocumentPosition(root);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) extraBefore.push(html);
      else extraAfter.push(html);
    });

    // Re-index images that were already present in the cloned root so metadata
    // and exported HTML use one message-level index space.
    const cloneImages = [...clone.querySelectorAll('img')];
    cloneImages.forEach(img => {
      const src = imageSource(img);
      const index = images.findIndex(item => item.src === src);
      if (index >= 0) img.setAttribute('data-archiver-image-index', String(index));
    });

    if (!text && !images.length) return null;

    const reasoning = role === 'assistant' && settings?.includeReasoning
      ? captureReasoning(turn)
      : { html: '', text: '', label: '', count: 0 };

    const stableId = turnStableKey(turn);
    return {
      id: stableId || ((turn.getAttribute('data-testid') || role) + ':' + ordinal + ':' + hashText(text)),
      role,
      text,
      html: extraBefore.join('') + clone.innerHTML + extraAfter.join(''),
      images,
      reasoningHtml: reasoning.html,
      reasoningText: reasoning.text,
      reasoningLabel: reasoning.label,
      reasoningCount: reasoning.count
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
    const patch = Object.assign({ status: 'running', message, count }, extra || {});
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_PROGRESS',
        jobId: state.jobId,
        patch
      });
      if (result?.ok) return result;
    } catch (_) {}
    return updateJob(patch);
  }

  function visibleTurnSignature() {
    const keys = orderedTurns().map(turn => turnStableKey(turn) || turnTextSignature(turn));
    return keys.slice(0, 3).concat(keys.slice(-3)).join('|') + '::' + keys.length;
  }

  async function waitForTurnSettle(timeout = 1600) {
    const started = Date.now();
    let previous = '';
    let stable = 0;
    while (Date.now() - started < timeout) {
      await sleep(180);
      const next = visibleTurnSignature();
      if (next && next === previous) stable++;
      else stable = 0;
      previous = next;
      if (stable >= 2) return next;
    }
    return previous;
  }

  async function physicalScroll(direction, bursts = 7) {
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PHYSICAL_SCROLL',
      jobId: state.jobId,
      direction,
      bursts
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось физически прокрутить вкладку.');
    await waitForTurnSettle();
    return result;
  }

  function hasResumeAnchor(id, signature) {
    return orderedTurns().some(turn => {
      const key = turnStableKey(turn);
      const textSignature = turnTextSignature(turn);
      return Boolean((id && key === id) || (signature && textSignature === signature));
    });
  }

  function visibleMeaningfulSignatures() {
    return orderedTurns()
      .map(turn => ({
        signature: turnTextSignature(turn),
        text: turnMessageText(turn)
      }))
      .filter(item => item.text)
      .map(item => item.signature);
  }

  function findResumeTailMatch(tailSignatures) {
    const baseline = (tailSignatures || []).filter(Boolean);
    if (baseline.length < 2) return null;

    const visible = visibleMeaningfulSignatures();
    const maxLength = Math.min(4, baseline.length, visible.length);

    for (let length = maxLength; length >= 2; length--) {
      const suffix = baseline.slice(-length);
      for (let start = 0; start <= visible.length - length; start++) {
        let same = true;
        for (let offset = 0; offset < length; offset++) {
          if (visible[start + offset] !== suffix[offset]) {
            same = false;
            break;
          }
        }
        if (same) {
          return {
            signature: suffix[suffix.length - 1],
            matchLength: length
          };
        }
      }
    }

    return null;
  }

  async function reachTop(map, order, settings) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;

    for (let i = 0; i < 260; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      const signature = visibleTurnSignature();
      await progress('Этап 1/3: физически иду к началу · собрано ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1
      });

      await physicalScroll('up');

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      const nextSignature = visibleTurnSignature();
      if (nextSignature && nextSignature === signature && signature === previousSignature && map.size === previousSize) {
        stable++;
      } else {
        stable = 0;
      }

      previousSignature = nextSignature;
      previousSize = map.size;

      if (stable >= 4) {
        await progress('Этап 1/3: начало достигнуто · собрано ' + map.size + ' сообщений', map.size, {
          phase: 'top',
          iteration: i + 1,
          force: true
        });
        return;
      }
    }

    throw new Error('Не удалось надежно дойти до начала переписки физической прокруткой.');
  }

  async function reachResumeAnchor(anchorId, anchorSignature, tailSignatures, map, order, settings) {
    if (!anchorId && !anchorSignature && !(tailSignatures || []).length) {
      throw new Error('У сохраненного архива нет якоря продолжения.');
    }

    for (let i = 0; i < 260; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      const tailMatch = findResumeTailMatch(tailSignatures);
      if (tailMatch) {
        await progress(
          'Этап 1/3: найден стык по ' + tailMatch.matchLength + ' соседним репликам · ' +
            map.size + ' сообщений в новом проходе',
          map.size,
          {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            anchorMatchLength: tailMatch.matchLength,
            force: true
          }
        );
        return { id: '', signature: tailMatch.signature, matchLength: tailMatch.matchLength };
      }

      if (hasResumeAnchor(anchorId, anchorSignature)) {
        await progress('Этап 1/3: найден конец сохраненного архива · ' + map.size + ' сообщений в новом проходе', map.size, {
          phase: 'top',
          iteration: i + 1,
          anchorReached: true,
          force: true
        });
        return { id: anchorId, signature: anchorSignature, matchLength: 1 };
      }

      await progress('Этап 1/3: ищу последний сохраненный стык · ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1
      });

      await physicalScroll('up');
    }

    throw new Error('Не удалось надежно сопоставить хвост сохраненного архива с текущим чатом.');
  }

  async function walkDown(map, order, settings, boundary) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;

    for (let i = 0; i < 520; i++) {
      if (state.cancel) throw new Error('Сбор отменен.');

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      if (boundaryIsVisible(boundary)) {
        await progress('Этап 2/3: достигнут конец снимка · ' + map.size + ' сообщений', map.size, {
          phase: 'walk',
          iteration: i + 1,
          boundaryReached: true,
          force: true
        });
        return;
      }

      const signature = visibleTurnSignature();
      await progress('Этап 2/3: физически прохожу вниз · собрано ' + map.size + ' сообщений', map.size, {
        phase: 'walk',
        iteration: i + 1
      });

      await physicalScroll('down');

      const nextSignature = visibleTurnSignature();
      if (nextSignature && nextSignature === signature && signature === previousSignature && map.size === previousSize) stable++;
      else stable = 0;

      previousSignature = nextSignature;
      previousSize = map.size;

      if (stable >= 4) break;
    }

    if (!boundaryIsVisible(boundary)) {
      throw new Error('Не удалось дойти до зафиксированного конца снимка переписки.');
    }
  }

  async function captureConversation(jobId, options = {}) {
    if (state.running) return;
    state.running = true;
    state.jobId = jobId;
    state.cancel = false;
    lastProgressAt = 0;

    const mode = options.mode === 'continue' || options.mode === 'sync' ? options.mode : 'full';
    const resumeAnchorId = String(options.resumeAnchorId || '');
    const resumeAnchorSignature = String(options.resumeAnchorSignature || '');
    const resumeTailSignatures = Array.isArray(options.resumeTailSignatures)
      ? options.resumeTailSignatures.filter(Boolean)
      : [];
    const existingArchiveId = String(options.existingArchiveId || '');
    const map = new Map();
    const order = [];
    let chronologicalStarted = false;
    let matchedAnchorId = resumeAnchorId;
    let matchedAnchorSignature = resumeAnchorSignature;

    try {
      const settings = await getSettings();
      await progress(
        mode === 'full'
          ? 'Этап 1/3: фиксирую конец снимка…'
          : 'Этап 1/3: фиксирую новый конец и ищу сохраненный стык…',
        0,
        { phase: 'top', force: true, captureMode: mode }
      );

      const turns = await waitForTurns(10000);
      if (!turns.length) {
        const roleCount = document.querySelectorAll(ROLE_SELECTOR).length;
        const shellCount = document.querySelectorAll(TURN_SHELL_SELECTOR).length;
        throw new Error(`Не удалось найти реплики ChatGPT. role-узлов: ${roleCount}, оболочек: ${shellCount}. Возможно, интерфейс еще загружается или ChatGPT изменил DOM.`);
      }

      const boundary = makeCaptureBoundary(turns);
      if (!boundary) throw new Error('Не удалось зафиксировать конец снимка переписки.');

      collect(map, order, settings);

      if (mode === 'full') {
        await reachTop(map, order, settings);
      } else {
        const matched = await reachResumeAnchor(
          resumeAnchorId,
          resumeAnchorSignature,
          resumeTailSignatures,
          map,
          order,
          settings
        );
        matchedAnchorId = matched?.id || '';
        matchedAnchorSignature = matched?.signature || resumeAnchorSignature;
      }

      map.clear();
      order.length = 0;
      chronologicalStarted = true;

      await walkDown(map, order, settings, boundary);

      await progress('Этап 3/3: сохраняю локальный архив…', map.size, {
        phase: 'finalizing',
        force: true,
        captureMode: mode
      });

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      let capturedMessages = order.map(id => map.get(id)).filter(Boolean);

      if (mode !== 'full') {
        const anchorIndex = capturedMessages.findIndex(item =>
          (matchedAnchorId && item.id === matchedAnchorId) ||
          (matchedAnchorSignature && messageTextSignature(item) === matchedAnchorSignature)
        );
        if (anchorIndex >= 0) capturedMessages = capturedMessages.slice(anchorIndex + 1);
      }

      if (mode === 'full' && !capturedMessages.length) {
        throw new Error('Сообщения не найдены. Возможно, ChatGPT изменил структуру страницы.');
      }

      let messages = capturedMessages;
      const archiveId = existingArchiveId || (String(Date.now()) + '-' + hashText(location.href));
      let addedCount = capturedMessages.length;
      let previousCount = 0;

      if (mode !== 'full' && existingArchiveId) {
        const stored = await chrome.storage.local.get('archive:' + existingArchiveId);
        const existing = stored['archive:' + existingArchiveId];
        if (!existing?.messages) throw new Error('Локальный архив для продолжения недоступен.');

        previousCount = existing.messages.length;
        const existingIds = new Set(existing.messages.map(item => item.id).filter(Boolean));
        const existingSignatures = new Set(
          existing.messages
            .filter(item => cleanMessageText(item.text || '', item.role || ''))
            .map(messageTextSignature)
        );

        const delta = capturedMessages.filter(item => {
          if (item.id && existingIds.has(item.id)) return false;
          const hasText = Boolean(cleanMessageText(item.text || '', item.role || ''));
          if (hasText && existingSignatures.has(messageTextSignature(item))) return false;
          return true;
        });

        addedCount = delta.length;
        messages = existing.messages.concat(delta);
      }

      const conversation = {
        title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount: messages.reduce((sum, item) => sum + (item.images ? item.images.length : 0), 0),
        lastCaptureMode: mode,
        lastCaptureAddedCount: addedCount,
        previousMessageCount: previousCount,
        lastMessageId: messages[messages.length - 1]?.id || ''
      };

      const currentJob = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
      await chrome.storage.local.set({
        ['archive:' + archiveId]: Object.assign({}, conversation, { id: archiveId }),
        lastArchiveId: archiveId,
        activeCaptureJob: Object.assign({}, currentJob, {
          jobId,
          status: 'done',
          message: mode === 'full'
            ? 'Переписка собрана.'
            : ('Архив продолжен: +' + addedCount + ' сообщений.'),
          count: messages.length,
          addedCount,
          imageCount: conversation.imageCount,
          archiveId,
          finishedAt: Date.now(),
          updatedAt: Date.now()
        })
      });

      try {
        await chrome.runtime.sendMessage({
          type: 'ARCHIVER_CAPTURE_COMPLETE',
          jobId,
          archiveId,
          count: messages.length,
          addedCount,
          mode
        });
      } catch (_) {}
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const status = /отменен/i.test(message) ? 'cancelled' : 'error';
      const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};

      let draftId = '';
      let draftCount = 0;

      if (chronologicalStarted && map.size > 0) {
        const draftMessages = order.map(id => map.get(id)).filter(Boolean);
        if (draftMessages.length) {
          draftId = 'draft-' + jobId;
          draftCount = draftMessages.length;
          const draft = {
            id: draftId,
            kind: 'capture-draft',
            title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
            sourceUrl: location.href,
            capturedAt: new Date().toISOString(),
            captureMode: mode,
            messages: draftMessages,
            imageCount: draftMessages.reduce((sum, item) => sum + (item.images ? item.images.length : 0), 0),
            complete: false,
            error: message
          };
          await chrome.storage.local.set({ ['draft:' + draftId]: draft });
        }
      }

      await chrome.storage.local.set({
        activeCaptureJob: Object.assign({}, current, {
          jobId,
          status,
          message,
          draftId,
          draftCount,
          finishedAt: Date.now(),
          updatedAt: Date.now()
        })
      });

      try {
        await chrome.runtime.sendMessage({
          type: 'ARCHIVER_CAPTURE_FAILED',
          jobId,
          error: message,
          draftId,
          draftCount,
          status
        });
      } catch (_) {}
    } finally {
      state.running = false;
      state.jobId = null;
      state.cancel = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'ARCHIVER_START_CAPTURE') {
      if (state.running) {
        sendResponse({ ok: true, running: true, jobId: state.jobId });
        return false;
      }
      captureConversation(message.jobId, {
        mode: message.mode,
        resumeAnchorId: message.resumeAnchorId,
        existingArchiveId: message.existingArchiveId,
        resumeAnchorSignature: message.resumeAnchorSignature,
        resumeTailSignatures: message.resumeTailSignatures
      }).catch(() => {});
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