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
  const state = { running: false, jobId: null, cancel: false, paused: false };
  let lastProgressAt = 0;
  const SETTINGS_KEY = 'archiverSettings';
  const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
  const REASONING_ACTION_EXCLUDE_RE = /copy|share|regenerate|retry|edit|like|dislike|feedback|citation|source|download|listen|read aloud|stop|поделиться|скопировать|повторить|изменить|источник|скачать|озвучить/i;
  const REASONING_STATUS_RE = /^(?:обработка заняла|размышление заняло|размышления заняли|thought for|thinking for|reasoned for|processing took)\b/i;
  const REASONING_ATTR_HINT_RE = /(?:reasoning|thinking|thought|analysis|cot)/i;
  const reasoningClicked = new WeakSet();

  async function waitIfPaused() {
    while (state.paused && !state.cancel) {
      await sleep(250);
    }
    if (state.cancel) throw new Error('Сбор отменен.');
  }

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

  function externalMatchSignature(role, text = '') {
    const normalized = normalizeMatchText(text);
    return String(role || 'unknown') + ':p:' + hashText(normalized.slice(0, 240));
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
      el?.innerText ||
      el?.textContent ||
      el?.getAttribute?.('aria-label') ||
      el?.getAttribute?.('title') ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }

  function isReasoningStatusLabel(value = '') {
    return REASONING_STATUS_RE.test(String(value || '').replace(/\s+/g, ' ').trim());
  }

  function nodeComesBefore(a, b) {
    if (!a || !b || a === b) return false;
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function previousTurnFor(turn) {
    const turns = orderedTurns();
    const index = turns.indexOf(turn);
    return index > 0 ? turns[index - 1] : null;
  }

  function nodeIsInReasoningWindow(node, turn, messageRoot) {
    if (!node || !turn || !messageRoot) return false;
    if (node === messageRoot || node.contains?.(messageRoot)) return false;
    if (!nodeComesBefore(node, messageRoot)) return false;

    const previous = previousTurnFor(turn);
    if (!previous) return true;
    if (previous.contains?.(node)) return false;
    return nodeComesBefore(previous, node);
  }

  function closestReasoningTrigger(node, messageRoot) {
    let el = node instanceof Element ? node : node?.parentElement;
    let fallback = el || null;

    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      if (messageRoot?.contains?.(el)) break;
      if (el.matches?.(ROLE_SELECTOR)) break;

      const clickish = Boolean(
        el.matches?.('button, [role="button"], [aria-expanded], [aria-controls], [data-state="open"], [data-state="closed"], [tabindex]') ||
        el.hasAttribute?.('onclick') ||
        getComputedStyle(el).cursor === 'pointer'
      );
      if (clickish) return el;
      if (depth < 2) fallback = el;
    }

    return fallback;
  }

  function reasoningStatusCandidates(turn, messageRoot) {
    const scope =
      document.querySelector('[data-thread-user-message-navigation-content]') ||
      document.querySelector('main') ||
      document.body;
    if (!scope) return [];

    const result = [];
    const seen = new Set();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const raw = String(walker.currentNode.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!raw || !isReasoningStatusLabel(raw)) continue;

      const trigger = closestReasoningTrigger(walker.currentNode, messageRoot);
      if (!trigger || seen.has(trigger) || !visible(trigger)) continue;
      if (!nodeIsInReasoningWindow(trigger, turn, messageRoot)) continue;

      seen.add(trigger);
      result.push(trigger);
    }

    return result;
  }

  function isReasoningDisclosure(el, turn, messageRoot) {
    if (!visible(el) || el.disabled) return false;
    if (!nodeIsInReasoningWindow(el, turn, messageRoot)) return false;
    if (messageRoot && messageRoot.contains(el)) return false;

    const label = reasoningLabel(el);
    if (isReasoningStatusLabel(label)) return true;

    if (!el.matches('button, [role="button"], [aria-expanded], [aria-controls], [data-state="open"], [data-state="closed"]')) {
      return false;
    }
    if (el.getAttribute('aria-haspopup')) return false;

    const testId = String(el.getAttribute('data-testid') || '');
    if (REASONING_ACTION_EXCLUDE_RE.test(testId)) return false;
    if (!label && !el.hasAttribute('aria-controls')) return false;
    if (REASONING_ACTION_EXCLUDE_RE.test(label)) return false;

    const attrHint = [
      testId,
      el.getAttribute('class') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || ''
    ].join(' ');

    const structurallyExpandable = Boolean(
      el.hasAttribute('aria-expanded') ||
      el.hasAttribute('aria-controls') ||
      el.getAttribute('data-state') === 'open' ||
      el.getAttribute('data-state') === 'closed' ||
      el.closest('.relative.my-1.min-h-6')
    );

    return structurallyExpandable && (
      turn.contains(el) ||
      REASONING_ATTR_HINT_RE.test(attrHint)
    );
  }

  function reasoningCandidates(turn) {
    const messageRoot = contentRoot(turn, 'assistant');
    const local = [...turn.querySelectorAll(
      'button[aria-expanded], [role="button"][aria-expanded], button[aria-controls], [role="button"][aria-controls], [data-state="open"], [data-state="closed"], .relative.my-1.min-h-6 button, .relative.my-1.min-h-6 [role="button"]'
    )];
    const strong = reasoningStatusCandidates(turn, messageRoot);
    const seen = new Set();

    return [...strong, ...local]
      .filter(el => {
        if (seen.has(el) || !isReasoningDisclosure(el, turn, messageRoot)) return false;
        seen.add(el);
        return true;
      })
      .sort((a, b) => {
        if (a === b) return 0;
        return nodeComesBefore(a, b) ? -1 : 1;
      });
  }

  function controlledReasoningRoot(trigger) {
    const ids = String(trigger.getAttribute?.('aria-controls') || '')
      .split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const target = document.getElementById(id);
      if (target && visible(target)) return target;
    }
    return null;
  }

  function siblingReasoningRoots(trigger, messageRoot) {
    const header = trigger.closest?.('.relative.my-1.min-h-6');
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

  function interstitialReasoningFragment(trigger, messageRoot) {
    if (!trigger || !messageRoot || !nodeComesBefore(trigger, messageRoot)) return null;

    try {
      const range = document.createRange();
      range.setStartAfter(trigger);
      range.setEndBefore(messageRoot);
      return range.cloneContents();
    } catch (_) {
      return null;
    }
  }

  function cleanReasoningSource(source) {
    if (!source) return { html: '', text: '' };

    const holder = document.createElement('div');
    holder.appendChild(source.cloneNode(true));

    // Never absorb an adjacent normal turn into the reasoning payload.
    holder.querySelectorAll(TURN_SELECTOR).forEach(node => node.remove());

    const cleaned = cleanClone(holder);
    const text = normalizeDisplayText(cleaned.innerText || cleaned.textContent || '');
    if (!text || isReasoningStatusLabel(normalizeMatchText(text))) {
      return { html: '', text: '' };
    }

    return { html: cleaned.innerHTML, text };
  }

  function captureReasoning(turn) {
    const messageRoot = contentRoot(turn, 'assistant');
    const candidates = reasoningCandidates(turn);
    if (!candidates.length) {
      return { html: '', text: '', label: '', status: '', count: 0 };
    }

    const statusLabel =
      candidates.map(reasoningLabel).find(isReasoningStatusLabel) || '';
    const labels = candidates.map(reasoningLabel).filter(Boolean);
    const pieces = [];
    const seenText = new Set();

    const addSource = source => {
      const piece = cleanReasoningSource(source);
      if (!piece.text) return;
      const key = normalizeMatchText(piece.text);
      if (!key || seenText.has(key)) return;
      seenText.add(key);
      pieces.push(piece);
    };

    for (const trigger of candidates) {
      const controlled = controlledReasoningRoot(trigger);
      if (controlled) addSource(controlled);
    }

    if (!pieces.length) {
      const primary =
        candidates.find(el => isReasoningStatusLabel(reasoningLabel(el))) ||
        candidates[0];
      addSource(interstitialReasoningFragment(primary, messageRoot));
    }

    if (!pieces.length) {
      for (const trigger of candidates) {
        for (const root of siblingReasoningRoots(trigger, messageRoot)) addSource(root);
      }
    }

    if (!pieces.length) {
      return {
        html: '',
        text: '',
        label: statusLabel || labels[0] || '',
        status: statusLabel,
        count: 0
      };
    }

    return {
      html: pieces.map(piece => piece.html).join(''),
      text: pieces.map(piece => piece.text).join('\n\n'),
      label: statusLabel || labels[0] || 'Размышления',
      status: statusLabel,
      count: pieces.length
    };
  }

  async function waitForReasoningExpansion(trigger, turn, timeout = 1400) {
    const messageRoot = contentRoot(turn, 'assistant');
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const controlled = controlledReasoningRoot(trigger);
      if (controlled) {
        const text = normalizeDisplayText(controlled.innerText || controlled.textContent || '');
        if (text) return true;
      }

      const fragment = interstitialReasoningFragment(trigger, messageRoot);
      const text = normalizeDisplayText(fragment?.textContent || '');
      if (text && !isReasoningStatusLabel(normalizeMatchText(text))) return true;

      const expanded = trigger.getAttribute?.('aria-expanded');
      const stateValue = trigger.getAttribute?.('data-state');
      if ((expanded === 'true' || stateValue === 'open') && Date.now() - started > 240) return true;
      await sleep(90);
    }

    return false;
  }

  async function expandReasoningVisible(turns) {
    let clicks = 0;

    for (const turn of turns || orderedTurns()) {
      if (roleOf(turn) !== 'assistant') continue;

      for (const el of reasoningCandidates(turn)) {
        if (reasoningClicked.has(el)) continue;

        const expanded = el.getAttribute?.('aria-expanded');
        const stateValue = el.getAttribute?.('data-state');
        if (expanded === 'true' || stateValue === 'open') {
          reasoningClicked.add(el);
          continue;
        }

        try {
          el.click();
          clicks++;
          await waitForReasoningExpansion(el, turn);
          reasoningClicked.add(el);
        } catch (_) {
          // Retry on a later physical-scroll pass if the UI was not ready yet.
        }
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
      const pos = img.compareDocumentPosition(root);
      const placement = root.contains(img)
        ? 'inline'
        : (pos & Node.DOCUMENT_POSITION_FOLLOWING)
          ? 'before'
          : 'after';

      const item = {
        index,
        src,
        alt: img.getAttribute('alt') || '',
        width: size.width || null,
        height: size.height || null,
        placement,
        mimeType: '',
        byteSize: 0,
        dataUrl: '',
        binaryStatus: 'pending',
        binaryError: ''
      };
      images.push(item);

      // Images already inside the text root are present in clone.innerHTML.
      if (root.contains(img)) return;

      const escapedSrc = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const escapedAlt = String(item.alt || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const html = '<p data-archiver-attachment="true"><img src="' + escapedSrc +
        '" alt="' + escapedAlt + '" data-archiver-image-index="' + index + '"></p>';

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
      reasoningStatus: reasoning.status,
      reasoningCount: reasoning.count
    };
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function normalizeImageBlob(blob) {
    if (!blob || !blob.size) throw new Error('Пустой файл изображения.');
    if (blob.size > 12 * 1024 * 1024) {
      throw new Error('Изображение больше 12 МБ; бинарная вставка пропущена.');
    }

    // PNG is the most predictable clipboard format in Chromium. Convert when
    // possible; if decoding fails, preserve the original image blob.
    try {
      const bitmap = await createImageBitmap(blob);
      const maxSide = 4096;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width || 1, bitmap.height || 1));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D недоступен.');
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (pngBlob?.size) return pngBlob;
    } catch (_) {}

    if (!String(blob.type || '').startsWith('image/')) {
      throw new Error('Полученный ресурс не является изображением.');
    }
    return blob;
  }

  async function fetchImageBinary(image) {
    if (!image?.src) throw new Error('У изображения нет src.');

    if (/^data:image\//i.test(image.src)) {
      const response = await fetch(image.src);
      return normalizeImageBlob(await response.blob());
    }

    const response = await fetch(image.src, {
      credentials: 'include',
      cache: 'force-cache'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return normalizeImageBlob(await response.blob());
  }

  async function hydrateMessageImages(messages) {
    const unique = new Map();
    for (const message of messages || []) {
      for (const image of message.images || []) {
        if (!image?.src) continue;
        if (!unique.has(image.src)) unique.set(image.src, []);
        unique.get(image.src).push(image);
      }
    }

    let embedded = 0;
    let failed = 0;
    let processed = 0;
    const total = unique.size;

    for (const [src, refs] of unique) {
      if (state.cancel) throw new Error('Сбор отменен.');

      try {
        const blob = await fetchImageBinary(refs[0]);
        const dataUrl = await blobToDataUrl(blob);
        for (const image of refs) {
          image.dataUrl = dataUrl;
          image.mimeType = blob.type || 'image/png';
          image.byteSize = blob.size || 0;
          image.binaryStatus = 'ready';
          image.binaryError = '';
        }
        embedded += refs.length;
      } catch (error) {
        const message = error?.message || String(error);
        for (const image of refs) {
          image.binaryStatus = 'failed';
          image.binaryError = message;
        }
        failed += refs.length;
      }

      processed++;
      await progress(
        'Этап 3/3: забираю изображения · ' + processed + '/' + total,
        messages.length,
        {
          phase: 'finalizing',
          imageBinaryProcessed: processed,
          imageBinaryTotal: total,
          imageBinaryReady: embedded,
          imageBinaryFailed: failed,
          force: true
        }
      );
    }

    return { embedded, failed, unique: total };
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

  async function waitForTurnSettle(timeout = 8000, quietWindow = 1400) {
    const started = Date.now();
    let previous = visibleTurnSignature();
    let quietSince = Date.now();

    while (Date.now() - started < timeout) {
      await sleep(220);
      const next = visibleTurnSignature();

      if (next && next === previous) {
        if (Date.now() - quietSince >= quietWindow) return next;
      } else {
        previous = next;
        quietSince = Date.now();
      }
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
      .map(turn => {
        const role = roleOf(turn) || 'unknown';
        const text = turnMessageText(turn);
        return {
          turn,
          role,
          text,
          externalSignature: externalMatchSignature(role, text),
          exactSignature: turnTextSignature(turn)
        };
      })
      .filter(item => item.text);
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
          if (visible[start + offset].externalSignature !== suffix[offset]) {
            same = false;
            break;
          }
        }
        if (same) {
          const last = visible[start + length - 1];
          return {
            signature: last.exactSignature,
            matchLength: length
          };
        }
      }
    }

    return null;
  }

  async function reachTop(map, order, settings) {
    let confirmedIdle = 0;
    let previousSignature = '';
    let previousSize = -1;
    let firstVisibleKey = '';

    for (let i = 0; i < 320; i++) {
      await waitIfPaused();

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      const turnsBefore = orderedTurns();
      const signature = visibleTurnSignature();
      const firstBefore = turnsBefore.length
        ? (turnStableKey(turnsBefore[0]) || turnTextSignature(turnsBefore[0]))
        : '';

      await progress('Этап 1/3: физически иду к началу · собрано ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1,
        topIdleConfirmations: confirmedIdle
      });

      // Push harder than a single viewport. ChatGPT may sit visually at the top
      // while an older virtualized chunk is still loading.
      await physicalScroll('up', confirmedIdle > 0 ? 12 : 9);

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      let nextSignature = visibleTurnSignature();
      let turnsAfter = orderedTurns();
      let firstAfter = turnsAfter.length
        ? (turnStableKey(turnsAfter[0]) || turnTextSignature(turnsAfter[0]))
        : '';
      let nextSize = map.size;

      const unchanged =
        Boolean(nextSignature) &&
        nextSignature === signature &&
        signature === previousSignature &&
        nextSize === previousSize &&
        firstAfter === firstBefore &&
        firstAfter === firstVisibleKey;

      if (unchanged) {
        // A temporarily stalled/lazy-loading tab must not be mistaken for the
        // true beginning. Give it a real loading window, then probe upward again.
        await progress('Этап 1/3: проверяю, не догружается ли начало…', map.size, {
          phase: 'top',
          iteration: i + 1,
          topIdleConfirmations: confirmedIdle + 1
        });

        await sleep(2600);
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);

        const afterWaitSignature = visibleTurnSignature();
        turnsAfter = orderedTurns();
        const afterWaitFirst = turnsAfter.length
          ? (turnStableKey(turnsAfter[0]) || turnTextSignature(turnsAfter[0]))
          : '';

        if (
          afterWaitSignature === nextSignature &&
          map.size === nextSize &&
          afterWaitFirst === firstAfter
        ) {
          confirmedIdle++;
        } else {
          confirmedIdle = 0;
          nextSignature = afterWaitSignature;
          firstAfter = afterWaitFirst;
          nextSize = map.size;
        }
      } else {
        confirmedIdle = 0;
      }

      previousSignature = nextSignature;
      previousSize = nextSize;
      firstVisibleKey = firstAfter;

      // Five separately confirmed idle probes means roughly tens of seconds
      // with repeated upward wheel input and no newly loaded older turns.
      if (confirmedIdle >= 5) {
        await progress('Этап 1/3: начало подтверждено повторными проверками · собрано ' + map.size + ' сообщений', map.size, {
          phase: 'top',
          iteration: i + 1,
          topIdleConfirmations: confirmedIdle,
          force: true
        });
        return;
      }
    }

    throw new Error('Не удалось надежно подтвердить начало переписки после повторных попыток прокрутки и ожидания догрузки.');
  }

  async function reachResumeAnchor(anchorId, anchorSignature, tailSignatures, map, order, settings) {
    if (!anchorId && !anchorSignature && !(tailSignatures || []).length) {
      throw new Error('У сохраненного архива нет якоря продолжения.');
    }

    for (let i = 0; i < 260; i++) {
      await waitIfPaused();

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
      await waitIfPaused();

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
    state.paused = false;
    lastProgressAt = 0;

    const mode = ['continue', 'sync', 'compare'].includes(options.mode) ? options.mode : 'full';
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

      await progress(
        mode === 'compare'
          ? 'Этап 3/3: считаю новые сообщения…'
          : 'Этап 3/3: сохраняю локальный архив…',
        map.size,
        {
          phase: 'finalizing',
          force: true,
          captureMode: mode
        }
      );

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      let capturedMessages = order.map(id => map.get(id)).filter(Boolean);

      if (mode !== 'full') {
        const anchorIndex = capturedMessages.findIndex(item =>
          (matchedAnchorId && item.id === matchedAnchorId) ||
          (matchedAnchorSignature && messageTextSignature(item) === matchedAnchorSignature)
        );

        if (anchorIndex < 0) {
          throw new Error(
            'Точка продолжения была найдена при навигации, но не попала в итоговый хронологический проход. ' +
            'Продолжение остановлено без слияния, чтобы не добавить старые сообщения повторно.'
          );
        }

        capturedMessages = capturedMessages.slice(anchorIndex + 1);
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

      const reasoningMessageCount = messages.filter(item =>
        Boolean(normalizeDisplayText(item?.reasoningText || ''))
      ).length;
      const reasoningBlockCount = messages.reduce(
        (sum, item) => sum + Number(item?.reasoningCount || 0),
        0
      );

      if (mode === 'compare') {
        const comparisonCount = previousCount + addedCount;
        const currentJob = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
        const comparisonMessage = addedCount
          ? ('Сверка завершена: +' + addedCount + ' новых сообщений относительно локального архива.')
          : 'Сверка завершена: новых сообщений относительно локального архива нет.';

        await chrome.storage.local.set({
          activeCaptureJob: Object.assign({}, currentJob, {
            jobId,
            status: 'done',
            phase: 'done',
            captureMode: 'compare',
            message: comparisonMessage,
            count: comparisonCount,
            addedCount,
            reasoningMessageCount,
            reasoningBlockCount,
            archiveId: existingArchiveId,
            finishedAt: Date.now(),
            updatedAt: Date.now()
          })
        });

        try {
          await chrome.runtime.sendMessage({
            type: 'ARCHIVER_CAPTURE_COMPLETE',
            jobId,
            archiveId: existingArchiveId,
            count: comparisonCount,
            addedCount,
            mode
          });
        } catch (_) {}
        return;
      }

      const binaryTargetMessages = mode === 'full'
        ? messages
        : (addedCount > 0 ? messages.slice(messages.length - addedCount) : []);
      const binaryStats = await hydrateMessageImages(binaryTargetMessages);

      const allImages = messages.flatMap(item => item.images || []);
      const conversation = {
        title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount: allImages.length,
        imageBinaryReady: allImages.filter(image => image.binaryStatus === 'ready' && image.dataUrl).length,
        imageBinaryFailed: allImages.filter(image => image.binaryStatus === 'failed').length,
        lastImageBinaryReady: binaryStats.embedded,
        lastImageBinaryFailed: binaryStats.failed,
        lastCaptureMode: mode,
        lastCaptureAddedCount: addedCount,
        previousMessageCount: previousCount,
        reasoningMessageCount,
        reasoningBlockCount,
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
          reasoningMessageCount,
          reasoningBlockCount,
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
    if (message && message.type === 'ARCHIVER_PAUSE_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) state.paused = true;
      sendResponse({ ok: true, paused: state.paused });
      return false;
    }
    if (message && message.type === 'ARCHIVER_RESUME_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) state.paused = false;
      sendResponse({ ok: true, paused: state.paused });
      return false;
    }
    if (message && message.type === 'ARCHIVER_CANCEL_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) {
        state.paused = false;
        state.cancel = true;
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();