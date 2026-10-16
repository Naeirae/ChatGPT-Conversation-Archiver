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
  const state = {
    running: false,
    jobId: null,
    cancel: false,
    paused: false,
    pauseCheckpoint: null,
    resumeFailure: '',
    lastScrollDirection: '',
    manualTopConfirmed: false,
    boundarySearchActive: false
  };
  let lastProgressAt = 0;
  const SETTINGS_KEY = 'archiverSettings';
  const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
  const REASONING_ACTION_EXCLUDE_RE = /copy|share|regenerate|retry|edit|like|dislike|feedback|citation|source|download|listen|read aloud|stop|поделиться|скопировать|повторить|изменить|источник|скачать|озвучить/i;
  const REASONING_STATUS_RE = /^(?:обработка заняла|размышление заняло|размышления заняли|thought for|thinking for|reasoned for|processing took)\b/i;
  const REASONING_ATTR_HINT_RE = /(?:reasoning|thinking|thought|analysis|cot)/i;
  const reasoningClicked = new WeakSet();
  const reasoningPhysicalCopies = new WeakMap();

  async function waitIfPaused() {
    while (state.paused && !state.cancel) {
      await sleep(250);
    }
    if (state.resumeFailure) {
      const message = state.resumeFailure;
      state.resumeFailure = '';
      throw new Error(message);
    }
    if (state.cancel) throw new Error('Сбор отменен.');
  }

  function makePauseCheckpoint() {
    const visible = visibleMeaningfulSignatures();
    const tail = visible.slice(-4).map(item => item.externalSignature).filter(Boolean);
    const last = visible[visible.length - 1] || null;
    return {
      tail,
      exactSignature: last?.exactSignature || '',
      capturedAt: Date.now()
    };
  }

  function pauseCheckpointVisible(checkpoint) {
    if (!checkpoint) return true;
    const visible = visibleMeaningfulSignatures();
    if (!visible.length) return false;
    if (checkpoint.exactSignature && visible.some(item => item.exactSignature === checkpoint.exactSignature)) {
      return true;
    }
    const target = (checkpoint.tail || []).filter(Boolean);
    if (!target.length) return false;
    const current = visible.map(item => item.externalSignature);
    const minMatch = Math.min(2, target.length);
    for (let length = target.length; length >= minMatch; length--) {
      const suffix = target.slice(-length);
      for (let start = 0; start <= current.length - length; start++) {
        let same = true;
        for (let offset = 0; offset < length; offset++) {
          if (current[start + offset] !== suffix[offset]) {
            same = false;
            break;
          }
        }
        if (same) return true;
      }
    }
    return false;
  }

  async function recoverPauseCheckpoint(checkpoint) {
    if (!checkpoint || pauseCheckpointVisible(checkpoint)) return true;

    for (let i = 0; i < 180; i++) {
      await physicalScroll('up', i < 12 ? 2 : 4);
      await sleep(120);
      if (pauseCheckpointVisible(checkpoint)) return true;
    }

    throw new Error(
      'После паузы не удалось надёжно найти место остановки. ' +
      'Автоматическое продолжение прекращено, чтобы не создать пропуски или дубли. ' +
      'Собранная часть будет сохранена как незавершённый проход.'
    );
  }

  function elementPoint(el) {
    const rect = el?.getBoundingClientRect?.();
    if (!rect || rect.width < 2 || rect.height < 2) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height / 2, 24)
    };
  }

  async function physicalClickElement(el) {
    const point = elementPoint(el);
    if (!point) return false;
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PHYSICAL_CLICK',
      jobId: state.jobId,
      point
    });
    return Boolean(result?.ok);
  }

  function selectReasoningRange(trigger, turn) {
    const messageRoot = contentRoot(turn, 'assistant');
    const selection = getSelection();
    if (!selection || !trigger || !messageRoot) return false;

    try {
      const range = document.createRange();
      const controlled = controlledReasoningRoot(trigger);
      const siblings = siblingReasoningRoots(trigger, messageRoot);

      if (controlled) {
        range.selectNodeContents(controlled);
      } else if (siblings.length) {
        range.setStartBefore(siblings[0]);
        range.setEndAfter(siblings[siblings.length - 1]);
      } else {
        const triggerText = normalizeDisplayText(trigger.innerText || trigger.textContent || '');
        const label = reasoningLabel(trigger);
        if (triggerText && label && triggerText.length > label.length + 12) {
          range.selectNodeContents(trigger);
        } else if (nodeComesBefore(trigger, messageRoot)) {
          range.setStartAfter(trigger);
          range.setEndBefore(messageRoot);
        } else {
          return false;
        }
      }

      const text = normalizeDisplayText(range.toString());
      if (!text) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function physicalCopyReasoning(trigger, turn) {
    if (!selectReasoningRange(trigger, turn)) return '';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_PHYSICAL_COPY_SELECTION',
        jobId: state.jobId
      });
      let text = normalizeDisplayText(result?.text || '');
      if (!result?.ok || !text) return '';

      const statusLabel = reasoningStatusLabelText(trigger);
      if (statusLabel && text.startsWith(statusLabel)) {
        text = normalizeDisplayText(text.slice(statusLabel.length));
      }
      if (!text || isReasoningStatusLabel(normalizeMatchText(text))) return '';
      return text;
    } finally {
      try { getSelection()?.removeAllRanges(); } catch (_) {}
    }
  }

  function visibleRetryButton() {
    const buttonPattern = /^(?:Попробовать снова|Повторить|Try again|Retry)$/i;
    const errorPattern = /(?:something went wrong|there was an error|network error|failed to load|не удалось загрузить|произошла ошибка|ошибка сети|возникла ошибка)/i;

    return [...document.querySelectorAll('button, [role="button"]')].find(el => {
      if (!visible(el) || el.disabled) return false;

      const label = String(
        el.innerText ||
        el.textContent ||
        el.getAttribute?.('aria-label') ||
        el.getAttribute?.('title') ||
        ''
      ).replace(/\s+/g, ' ').trim();

      if (!buttonPattern.test(label)) return false;

      // ChatGPT can keep generic Retry buttons in unrelated UI. Recovery is
      // expensive, so only enter it when the same local region also contains
      // an actual load/network error message.
      let node = el;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const text = String(node.innerText || node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text && errorPattern.test(text)) return true;
      }
      return false;
    }) || null;
  }

  async function recoverVisibleLoadError(phase = 'top', count = 0) {
    // Retry physical scrolling, not ChatGPT's generic button, and only after
    // visibleRetryButton() has verified a real nearby load error.
    if (!visibleRetryButton()) return false;

    const direction = phase === 'walk' ? 'down' : 'up';
    const originalUrl = location.href;
    const before = visibleTurnSignature();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await waitIfPaused();
      await progress(
        'ChatGPT не догрузил участок · повторяю прокрутку (' + attempt + '/2)…',
        count,
        { phase, retryVisible: true, force: true }
      );

      await physicalScroll(direction, 2, {
        settleTimeout: 2200,
        quietWindow: 380
      });

      if (location.href !== originalUrl) {
        throw new Error('Переписка сменилась во время повторной прокрутки. Сбор остановлен.');
      }

      await sleep(350);
      const after = visibleTurnSignature();
      if (after && after !== before) return true;
      if (!visibleRetryButton()) return true;
    }

    return false;
  }

  async function getSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}), includeReasoning: false };
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
      // data-turn-key belongs to ChatGPT's virtualized rendering layer. The DOM
      // wrapper can be recycled for another message while walking a very long
      // conversation, so the wrapper key alone is not a message identity.
      // Preserve the pre-recovery behavior: combine the virtual wrapper key
      // with role + rendered message signature. This prevents a finite wrapper
      // pool from capping a 1000-message chat at roughly the pool size.
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
    if (!root) return '';
    const copy = root.cloneNode(true);
    copy.querySelectorAll('.archiver-fragment-buttons,[data-archiver-ui="true"]').forEach(node => node.remove());
    return cleanMessageText(String(copy.innerText || copy.textContent || ''), role);
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

  function normalizedBoundary(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'stable' ? 'stable' : value.kind === 'signature' ? 'signature' : '';
    const key = String(value.key || '').trim();
    if (!kind || !key) return null;
    return {
      kind,
      key,
      role: String(value.role || ''),
      ordinal: Number.isFinite(Number(value.ordinal)) ? Number(value.ordinal) : -1,
      signature: String(value.signature || ''),
      strictStable: Boolean(value.strictStable)
    };
  }

  function makeCaptureBoundary(turns) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const key = turnStableKey(turns[i]);
      if (key) {
        return {
          kind: 'stable',
          key,
          role: roleOf(turns[i]) || '',
          ordinal: i,
          signature: turnTextSignature(turns[i])
        };
      }
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
    if (boundary.kind === 'stable') {
      if (turnStableKey(turn) === boundary.key) return true;
      // Explicitly marked boundaries are user-selected message identities.
      // They must never stop early on another message with identical text.
      if (boundary.strictStable) return false;
      return Boolean(boundary.signature && turnTextSignature(turn) === boundary.signature);
    }
    return turnTextSignature(turn) === boundary.key;
  }

  function physicalScrollEndVisible() {
    const turns = orderedTurns();
    const last = turns[turns.length - 1] || null;
    const scroller = findScrollContainer(last);
    if (!scroller) return false;
    const top = Number(scroller.scrollTop || 0);
    const height = Number(scroller.clientHeight || 0);
    const total = Number(scroller.scrollHeight || 0);
    if (!height || !total) return false;
    return top + height >= total - Math.max(24, Math.round(height * 0.04));
  }

  function physicalScrollStartVisible() {
    const turns = orderedTurns();
    const first = turns[0] || null;
    const scroller = findScrollContainer(first);
    if (!scroller) return false;
    const top = Number(scroller.scrollTop || 0);
    const height = Number(scroller.clientHeight || 0);
    if (!height) return false;
    return top <= Math.max(24, Math.round(height * 0.04));
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
  function reasoningStatusLabelText(el) {
    const raw = String(
      el?.innerText ||
      el?.textContent ||
      el?.getAttribute?.('aria-label') ||
      el?.getAttribute?.('title') ||
      ''
    ).replace(/\r/g, '').trim();
    if (!raw) return '';
    const firstLine = raw.split('\n').map(part => part.trim()).find(Boolean) || '';
    return isReasoningStatusLabel(firstLine) ? firstLine : '';
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

    for (let depth = 0; el && depth < 16; depth++, el = el.parentElement) {
      if (messageRoot?.contains?.(el)) break;
      if (el.matches?.(ROLE_SELECTOR)) break;

      const clickish = Boolean(
        el.matches?.('button, [role="button"], [aria-expanded], [aria-controls], [data-state="open"], [data-state="closed"], [tabindex]') ||
        el.hasAttribute?.('onclick') ||
        getComputedStyle(el).cursor === 'pointer'
      );
      if (clickish) return el;

      // Keep the tightest visible wrapper around the status text as a physical
      // click fallback; the current ChatGPT rollout does not always expose a
      // semantic button/aria-expanded node.
      const rect = el.getBoundingClientRect?.();
      if (rect?.width > 2 && rect?.height > 2 && depth < 5) fallback = el;
    }

    return fallback;
  }

  function reasoningStatusCandidates(turn, messageRoot) {
    const scope =
      document.querySelector('[data-thread-user-message-navigation-content]') ||
      document.querySelector('main') ||
      document.body;
    if (!scope) return [];

    const assistants = orderedTurns().filter(item => roleOf(item) === 'assistant');
    const result = [];
    const seen = new Set();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const raw = String(walker.currentNode.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!raw || !isReasoningStatusLabel(raw)) continue;

      const textNode = walker.currentNode;
      const textElement = textNode.parentElement;
      if (!textElement || !visible(textElement)) continue;

      // Associate the disclosure with the nearest visible assistant reply that
      // follows it in DOM order. Do not depend on the previous-turn window:
      // current ChatGPT renders reasoning/status UI between turn wrappers.
      const targetTurn = assistants.find(item => {
        const root = contentRoot(item, 'assistant');
        return root && nodeComesBefore(textElement, root);
      }) || null;
      if (targetTurn !== turn) continue;

      const trigger = closestReasoningTrigger(textNode, messageRoot) || textElement;
      if (!trigger || seen.has(trigger) || !visible(trigger)) continue;

      seen.add(trigger);
      result.push(trigger);
    }

    return result;
  }

  function isReasoningDisclosure(el, turn, messageRoot) {
    if (!visible(el) || el.disabled) return false;
    if (messageRoot && messageRoot.contains(el)) return false;

    const label = reasoningLabel(el);
    const statusLabel = reasoningStatusLabelText(el);
    // Strong visible status labels are already associated with the nearest
    // following assistant turn by reasoningStatusCandidates(). They must not
    // be rejected by the older "previous turn window" heuristic.
    if (statusLabel) return true;
    if (!nodeIsInReasoningWindow(el, turn, messageRoot)) return false;

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
    const physicalCopies = Array.isArray(reasoningPhysicalCopies.get(turn))
      ? reasoningPhysicalCopies.get(turn).filter(Boolean)
      : [];

    if (!candidates.length && !physicalCopies.length) {
      return { html: '', text: '', label: '', status: '', count: 0 };
    }

    const statusLabel =
      candidates.map(reasoningStatusLabelText).find(Boolean) || '';
    const labels = candidates.map(reasoningLabel).filter(Boolean);

    if (physicalCopies.length) {
      const unique = [...new Set(
        physicalCopies
          .map(normalizeDisplayText)
          .filter(Boolean)
      )];
      const text = unique.join('\n\n');
      const html = unique
        .map(piece => '<p>' + piece
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/\n/g, '<br>') + '</p>')
        .join('');
      return {
        html,
        text,
        label: statusLabel || labels[0] || 'Размышления',
        status: statusLabel,
        count: unique.length,
        origin: 'physical-copy'
      };
    }

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

        try {
          const expanded = el.getAttribute?.('aria-expanded');
          const stateValue = el.getAttribute?.('data-state');

          if (!(expanded === 'true' || stateValue === 'open')) {
            const clicked = await physicalClickElement(el);
            if (!clicked) continue;
            clicks++;
            const opened = await waitForReasoningExpansion(el, turn, 3200);
            if (!opened) continue;
          }

          const copied = await physicalCopyReasoning(el, turn);
          if (copied) {
            const current = Array.isArray(reasoningPhysicalCopies.get(turn))
              ? reasoningPhysicalCopies.get(turn)
              : [];
            const normalized = normalizeDisplayText(copied);
            if (normalized && !current.some(item => normalizeDisplayText(item) === normalized)) {
              reasoningPhysicalCopies.set(turn, [...current, normalized]);
            }
          }

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
      throw new Error('Изображение больше 12 МБ; подготовить его для Google Docs не удалось.');
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

  function renderedImageNode(src = '') {
    const expected = String(src || '');
    const nodes = [...document.querySelectorAll('img')];
    return nodes.find(img => {
      const candidate = imageSource(img);
      if (!candidate || candidate !== expected) return false;
      const rect = img.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    }) || null;
  }

  async function captureRenderedImageBlob(src = '') {
    const img = renderedImageNode(src);
    if (!img) throw new Error('Картинка сейчас не видна в DOM.');

    try {
      img.scrollIntoView({ block: 'center', inline: 'center' });
      if (img.decode) await Promise.race([img.decode(), sleep(1800)]).catch(() => {});
      await sleep(120);
    } catch (_) {}

    const rect = img.getBoundingClientRect();
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(innerWidth, rect.right);
    const visibleBottom = Math.min(innerHeight, rect.bottom);
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;

    if (visibleWidth < 2 || visibleHeight < 2) {
      throw new Error('Картинка не попала в видимую область вкладки.');
    }

    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CAPTURE_RENDERED_IMAGE',
      src,
      rect: {
        left: visibleLeft,
        top: visibleTop,
        width: visibleWidth,
        height: visibleHeight
      },
      viewport: {
        width: innerWidth,
        height: innerHeight
      }
    });
    if (!result?.ok || !result.dataUrl) {
      throw new Error(result?.error || 'Не удалось снять видимую картинку.');
    }

    const response = await fetch(result.dataUrl);
    return normalizeImageBlob(await response.blob());
  }

  async function fetchImageBinary(image) {
    if (!image?.src) throw new Error('У изображения нет src.');

    if (/^data:image\//i.test(image.src)) {
      const response = await fetch(image.src);
      return normalizeImageBlob(await response.blob());
    }

    let pageError = '';
    try {
      const response = await fetch(image.src, {
        credentials: 'include',
        cache: 'force-cache'
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return normalizeImageBlob(await response.blob());
    } catch (error) {
      pageError = error?.message || String(error);
    }

    let workerError = '';
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_FETCH_IMAGE_BINARY',
        src: image.src
      });
      if (!result?.ok || !result.dataUrl) {
        throw new Error(result?.error || 'extension fetch failed');
      }
      const response = await fetch(result.dataUrl);
      return normalizeImageBlob(await response.blob());
    } catch (error) {
      workerError = error?.message || String(error);
    }

    // Final fallback: the browser has already rendered the picture in ChatGPT.
    // Capture those pixels while the message is physically on screen. This
    // avoids CORS, expiring media URLs and Google Docs fetching the remote URL.
    try {
      return await captureRenderedImageBlob(image.src);
    } catch (error) {
      const renderedError = error?.message || String(error);
      throw new Error(
        'страница: ' + (pageError || 'не загрузила') +
        ' | расширение: ' + (workerError || 'не загрузило') +
        ' | видимая картинка: ' + renderedError
      );
    }
  }

  async function hydrateMessageImages(messages, { onlyMissing = false, reportProgress = true } = {}) {
    const unique = new Map();
    for (const message of messages || []) {
      for (const image of message.images || []) {
        if (!image?.src) continue;
        if (onlyMissing && image.binaryStatus === 'ready' && image.dataUrl) continue;
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
      if (reportProgress) {
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
    }

    return { embedded, failed, unique: total };
  }

  async function hydrateSequentialImages(messages, attemptedSources) {
    const attempted = attemptedSources instanceof Set ? attemptedSources : new Set();
    const targets = [];

    for (const message of messages || []) {
      const pending = [];
      for (const image of message?.images || []) {
        const src = String(image?.src || '');
        if (!src || attempted.has(src)) continue;
        attempted.add(src);
        pending.push(image);
      }
      if (pending.length) targets.push({ ...message, images: pending });
    }

    if (!targets.length) return { embedded: 0, failed: 0, unique: 0 };
    return hydrateMessageImages(targets, {
      onlyMissing: false,
      reportProgress: false
    });
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

  function collect(map, order, settings, stopBoundary = null) {
    const turns = orderedTurns();
    const touchedIds = [];

    for (let ordinal = 0; ordinal < turns.length; ordinal++) {
      const turn = turns[ordinal];
      const message = captureTurn(turn, ordinal, settings);

      if (message) {
        touchedIds.push(message.id);
        const existing = map.get(message.id);
        if (!existing) {
          order.push(message.id);
          map.set(message.id, message);
        } else {
          // Virtualization can recreate the same turn after its reasoning block or
          // images disappear from the current DOM. Never overwrite richer captured
          // data with a poorer later snapshot.
          if (!message.reasoningText && existing.reasoningText) {
            message.reasoningText = existing.reasoningText;
            message.reasoningHtml = existing.reasoningHtml;
            message.reasoningLabel = existing.reasoningLabel;
            message.reasoningStatus = existing.reasoningStatus;
            message.reasoningCount = existing.reasoningCount;
          }
          if ((existing.images?.length || 0) > (message.images?.length || 0)) {
            message.images = existing.images;
            message.html = existing.html;
          }

          map.set(message.id, message);
        }
      }

      // A full capture is a snapshot. Messages created after the bottom marker
      // must never be absorbed just because they became visible while we were
      // walking back down.
      if (stopBoundary && matchesBoundary(turn, stopBoundary)) break;
    }

    return [...new Set(touchedIds)];
  }

  function capturedImageStats(messages) {
    const images = (messages || []).flatMap(item => item?.images || []);
    return {
      total: images.length,
      ready: images.filter(image => image?.binaryStatus === 'ready' && image.dataUrl).length,
      failed: images.filter(image => image?.binaryStatus === 'failed').length
    };
  }

  function messageMatchesBoundary(message, boundary) {
    if (!message || !boundary) return false;
    if (boundary.kind === 'stable') return message.id === boundary.key;
    return messageTextSignature(message) === boundary.key;
  }

  function trimMessagesThroughBoundary(messages, boundary) {
    const rows = [...(messages || [])];
    const index = rows.findIndex(message => messageMatchesBoundary(message, boundary));
    if (index < 0) return { messages: rows, found: false, trimmed: 0 };
    return {
      messages: rows.slice(0, index + 1),
      found: true,
      trimmed: Math.max(0, rows.length - index - 1)
    };
  }

  function navigationRef(message) {
    return {
      id: String(message?.id || ''),
      signature: message ? messageTextSignature(message) : '',
      externalSignature: message
        ? externalMatchSignature(message?.role || 'unknown', message?.text || '')
        : ''
    };
  }

  function sameNavigationRef(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id && a.id === b.id) return true;
    if (a.signature && b.signature && a.signature === b.signature) return true;
    return Boolean(
      a.externalSignature &&
      b.externalSignature &&
      a.externalSignature === b.externalSignature
    );
  }

  function recordNavigationWindow(windows, settings, stopBoundary = null) {
    if (!Array.isArray(windows)) return;
    const refs = [];
    const turns = orderedTurns();
    for (let ordinal = 0; ordinal < turns.length; ordinal++) {
      const turn = turns[ordinal];
      const message = captureTurn(turn, ordinal, settings);
      if (message) refs.push(navigationRef(message));
      if (stopBoundary && matchesBoundary(turn, stopBoundary)) break;
    }
    if (!refs.length) return;

    const previous = windows[windows.length - 1] || [];
    if (
      previous.length === refs.length &&
      previous.every((ref, index) => sameNavigationRef(ref, refs[index]))
    ) return;

    windows.push(refs);
  }

  function buildNavigationSequence(windows) {
    let sequence = [];

    for (const windowRefs of windows || []) {
      const refs = (windowRefs || []).filter(ref => ref && (ref.id || ref.signature));
      if (!refs.length) continue;
      if (!sequence.length) {
        sequence = [...refs];
        continue;
      }

      const allKnown = refs.every(ref => sequence.some(existing => sameNavigationRef(ref, existing)));
      if (allKnown) continue;

      let overlap = 0;
      const maxOverlap = Math.min(refs.length, sequence.length);
      for (let size = maxOverlap; size >= 1; size--) {
        let same = true;
        for (let offset = 0; offset < size; offset++) {
          if (!sameNavigationRef(refs[refs.length - size + offset], sequence[offset])) {
            same = false;
            break;
          }
        }
        if (same) {
          overlap = size;
          break;
        }
      }

      if (overlap) {
        sequence = refs.slice(0, refs.length - overlap).concat(sequence);
        continue;
      }

      let pivot = null;
      for (let i = 0; i < refs.length && !pivot; i++) {
        const j = sequence.findIndex(existing => sameNavigationRef(refs[i], existing));
        if (j >= 0) pivot = { i, j };
      }

      if (pivot) {
        sequence = refs.slice(0, pivot.i).concat(sequence);
        continue;
      }

      // Upward traversal only moves toward older turns. If virtualization gives
      // us a non-overlapping window, its visible messages are still older than
      // the sequence already observed below it.
      const unseen = refs.filter(ref => !sequence.some(existing => sameNavigationRef(ref, existing)));
      sequence = unseen.concat(sequence);
    }

    const deduped = [];
    for (const ref of sequence) {
      if (!deduped.some(existing => sameNavigationRef(ref, existing))) deduped.push(ref);
    }
    return deduped;
  }

  function mergeRicherCapture(base, fallback) {
    if (!base) return fallback;
    if (!fallback) return base;
    const merged = { ...fallback, ...base };
    if (!base.reasoningText && fallback.reasoningText) {
      merged.reasoningText = fallback.reasoningText;
      merged.reasoningHtml = fallback.reasoningHtml;
      merged.reasoningLabel = fallback.reasoningLabel;
      merged.reasoningStatus = fallback.reasoningStatus;
      merged.reasoningCount = fallback.reasoningCount;
    }
    const imageMerge = mergeImageRecords(base.images || [], fallback.images || []);
    if (imageMerge.images.length) {
      merged.images = imageMerge.images;
      if (imageMerge.added.length && fallback.html) {
        merged.html = fallback.html;
      }
    }
    return merged;
  }

  function reconcileNavigationCoverage(capturedMessages, navigationMessages, navigationSequence) {
    const result = [...(capturedMessages || [])];
    const navMessages = [...(navigationMessages || [])];

    const matchesRef = (message, ref) => sameNavigationRef(navigationRef(message), ref);
    const findResultIndex = ref => result.findIndex(message => matchesRef(message, ref));
    const findNavigationMessage = ref => navMessages.find(message => matchesRef(message, ref)) || null;

    // First use the upward pass as a richness fallback for messages that are
    // already present in the chronological pass.
    for (let i = 0; i < result.length; i++) {
      const fallback = navMessages.find(message =>
        sameNavigationRef(navigationRef(result[i]), navigationRef(message))
      );
      if (fallback) result[i] = mergeRicherCapture(result[i], fallback);
    }

    const missingGroups = [];
    let current = [];
    for (const ref of navigationSequence || []) {
      if (findResultIndex(ref) >= 0) {
        if (current.length) {
          missingGroups.push(current);
          current = [];
        }
      } else {
        current.push(ref);
      }
    }
    if (current.length) missingGroups.push(current);

    let insertedCount = 0;
    let unresolvedCount = 0;

    for (const group of missingGroups) {
      const firstRef = group[0];
      const lastRef = group[group.length - 1];
      const firstNavIndex = (navigationSequence || []).findIndex(ref => sameNavigationRef(ref, firstRef));
      let lastNavIndex = firstNavIndex;
      for (let i = firstNavIndex; i < (navigationSequence || []).length; i++) {
        if (sameNavigationRef(navigationSequence[i], lastRef)) {
          lastNavIndex = i;
          break;
        }
      }

      let previousRef = null;
      for (let i = firstNavIndex - 1; i >= 0; i--) {
        if (findResultIndex(navigationSequence[i]) >= 0) {
          previousRef = navigationSequence[i];
          break;
        }
      }

      let nextRef = null;
      for (let i = lastNavIndex + 1; i < (navigationSequence || []).length; i++) {
        if (findResultIndex(navigationSequence[i]) >= 0) {
          nextRef = navigationSequence[i];
          break;
        }
      }

      const messages = group.map(findNavigationMessage).filter(Boolean);
      if (messages.length !== group.length) {
        unresolvedCount += group.length;
        continue;
      }

      const previousIndex = previousRef ? findResultIndex(previousRef) : -1;
      const nextIndex = nextRef ? findResultIndex(nextRef) : -1;
      let insertAt = -1;

      if (previousRef && nextRef && previousIndex >= 0 && nextIndex > previousIndex) {
        insertAt = nextIndex;
      } else if (!previousRef && nextRef && nextIndex >= 0) {
        insertAt = nextIndex;
      } else if (previousRef && !nextRef && previousIndex >= 0) {
        insertAt = previousIndex + 1;
      }

      if (insertAt < 0) {
        unresolvedCount += group.length;
        continue;
      }

      result.splice(insertAt, 0, ...messages);
      insertedCount += messages.length;
    }

    const unresolvedRefs = (navigationSequence || []).filter(ref => findResultIndex(ref) < 0);
    const unsequencedNavigation = navMessages.filter(message =>
      !(navigationSequence || []).some(ref => matchesRef(message, ref)) &&
      !result.some(existing =>
        sameNavigationRef(navigationRef(existing), navigationRef(message))
      )
    );
    unresolvedCount = Math.max(
      unresolvedCount,
      unresolvedRefs.length + unsequencedNavigation.length
    );

    return {
      messages: result,
      insertedCount,
      unresolvedCount,
      navigationCount: navMessages.length,
      chronologicalCount: (capturedMessages || []).length
    };
  }

  function mergeImageRecords(existingImages, scannedImages) {
    const merged = (existingImages || []).map(image => ({ ...image }));
    const bySrc = new Map();
    merged.forEach((image, index) => {
      const src = String(image?.src || '');
      if (src && !bySrc.has(src)) bySrc.set(src, index);
    });
    const added = [];

    for (const image of scannedImages || []) {
      const src = String(image?.src || '');
      if (!src) continue;
      const index = bySrc.get(src);
      if (index == null) {
        const next = {
          ...image,
          index: merged.length,
          dataUrl: image?.dataUrl || '',
          binaryStatus: image?.binaryStatus || 'pending',
          binaryError: image?.binaryError || ''
        };
        bySrc.set(src, merged.length);
        merged.push(next);
        added.push(next);
        continue;
      }

      const current = merged[index] || {};
      const currentReady = current.binaryStatus === 'ready' && current.dataUrl;
      const incomingReady = image?.binaryStatus === 'ready' && image?.dataUrl;
      merged[index] = {
        ...current,
        alt: current.alt || image?.alt || '',
        width: current.width || image?.width || null,
        height: current.height || image?.height || null,
        placement: current.placement || image?.placement || '',
        mimeType: currentReady ? current.mimeType : (image?.mimeType || current.mimeType || ''),
        byteSize: currentReady ? current.byteSize : (image?.byteSize || current.byteSize || 0),
        dataUrl: currentReady ? current.dataUrl : (incomingReady ? image.dataUrl : (current.dataUrl || '')),
        binaryStatus: currentReady ? 'ready' : (incomingReady ? 'ready' : (image?.binaryStatus || current.binaryStatus || 'pending')),
        binaryError: currentReady || incomingReady ? '' : (current.binaryError || image?.binaryError || ''),
        index
      };
    }

    merged.forEach((image, index) => { image.index = index; });
    return { images: merged, added };
  }

  function imageAttachmentHtml(image, index) {
    const src = String(image?.src || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
    const alt = String(image?.alt || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
    return '<p data-archiver-attachment="true"><img src="' + src +
      '" alt="' + alt + '" data-archiver-image-index="' + index + '"></p>';
  }

  function appendRecoveredImageMarkup(html, images, addedImages) {
    let next = String(html || '');
    for (const image of addedImages || []) {
      const index = images.findIndex(item => item.src === image.src);
      if (index < 0) continue;
      next += imageAttachmentHtml(image, index);
    }
    return next;
  }

  function reconcileVerifiedCaptureWithArchive(capturedMessages, existingMessages) {
    const captured = [...(capturedMessages || [])];
    const existing = [...(existingMessages || [])];
    const matchedCapturedIndexes = [];
    let searchFrom = 0;

    for (let oldIndex = 0; oldIndex < existing.length; oldIndex++) {
      const oldMessage = existing[oldIndex];
      let found = -1;
      for (let i = searchFrom; i < captured.length; i++) {
        if (sameNavigationRef(navigationRef(oldMessage), navigationRef(captured[i]))) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        return {
          ok: false,
          missingArchiveIndex: oldIndex,
          missingArchiveMessage: oldMessage,
          messages: captured,
          addedCount: 0
        };
      }
      matchedCapturedIndexes.push(found);
      searchFrom = found + 1;
    }

    const oldByCapturedIndex = new Map(
      matchedCapturedIndexes.map((capturedIndex, oldIndex) => [capturedIndex, existing[oldIndex]])
    );
    const messages = captured.map((message, index) => {
      const previous = oldByCapturedIndex.get(index);
      return previous ? mergeRicherCapture(message, previous) : message;
    });

    return {
      ok: true,
      messages,
      addedCount: Math.max(0, captured.length - matchedCapturedIndexes.length),
      matchedCount: matchedCapturedIndexes.length
    };
  }

  function mergeRecoveredImagesIntoArchive(existingMessages, scannedMessages) {
    const scanned = scannedMessages || [];
    const result = (existingMessages || []).map(message => ({ ...message }));
    const recovered = [];

    const findScanned = message => scanned.find(candidate =>
      sameNavigationRef(navigationRef(message), navigationRef(candidate))
    ) || null;

    for (let i = 0; i < result.length; i++) {
      const target = result[i];
      const source = findScanned(target);
      if (!source?.images?.length) continue;

      const beforeImages = target.images || [];
      const beforeReady = new Map(beforeImages.map(image => [
        String(image?.src || ''),
        Boolean(image?.binaryStatus === 'ready' && image?.dataUrl)
      ]));
      const merged = mergeImageRecords(beforeImages, source.images || []);
      const enrichedExisting = merged.images.filter(image => {
        const src = String(image?.src || '');
        return src && beforeReady.has(src) &&
          !beforeReady.get(src) &&
          image?.binaryStatus === 'ready' &&
          image?.dataUrl;
      });
      if (!merged.added.length && !enrichedExisting.length) continue;

      target.images = merged.images;
      if (merged.added.length) {
        target.html = appendRecoveredImageMarkup(target.html, merged.images, merged.added);
      }
      for (const image of [...merged.added, ...enrichedExisting]) {
        recovered.push({
          messageId: target.id || '',
          messageSignature: messageTextSignature(target),
          src: image.src || ''
        });
      }
    }

    return { messages: result, recovered };
  }

  async function updateJob(patch) {
    // Deliberately do not write activeCaptureJob from a page. The service
    // worker owns the job lifecycle; a late page write can resurrect a
    // completed/paused/failed job or overwrite a newer job's metadata.
    return { ok: false, error: 'Фоновый процесс недоступен; контрольные точки сохраняются отдельно.' };
  }

  async function progress(message, count, extra) {
    const now = Date.now();
    if (now - lastProgressAt < 1500 && !(extra && extra.force)) return;
    lastProgressAt = now;
    const patch = Object.assign({ status: 'running', message, count }, extra || {});
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_PROGRESS',
        jobId: state.jobId,
        patch
      });
      if (result?.ok) return result;
      if (result && result.ok === false) {
        throw new Error(result.error || 'Фоновый процесс остановил этот сбор.');
      }
    } catch (error) {
      // A concrete response from the worker means the run is no longer active;
      // do not keep driving the tab after the popup has declared it stopped.
      if (error?.message && /останов|неактуал|Прогресс пришел не из вкладки сбора/i.test(error.message)) {
        throw error;
      }
    }
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

  async function physicalScroll(
    direction,
    bursts = 7,
    { settleTimeout = 8000, quietWindow = 1400 } = {}
  ) {
    const normalizedDirection = direction === 'down' ? 'down' : 'up';
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PHYSICAL_SCROLL',
      jobId: state.jobId,
      direction: normalizedDirection,
      bursts
    });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось физически прокрутить вкладку.');
    state.lastScrollDirection = normalizedDirection;
    await waitForTurnSettle(settleTimeout, quietWindow);
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


  function currentResumeWindowSignatures(limit = 6) {
    const visible = visibleMeaningfulSignatures()
      .map(item => item.externalSignature)
      .filter(Boolean);
    return visible.slice(-Math.max(2, Number(limit) || 6));
  }

  function checkpointWindowVisible(signatures) {
    const target = (signatures || []).filter(Boolean);
    if (target.length < 2) return false;
    const current = visibleMeaningfulSignatures()
      .map(item => item.externalSignature)
      .filter(Boolean);
    const maxLength = Math.min(target.length, current.length, 6);
    for (let length = maxLength; length >= 2; length--) {
      const suffix = target.slice(-length);
      for (let start = 0; start <= current.length - length; start++) {
        let same = true;
        for (let offset = 0; offset < length; offset++) {
          if (current[start + offset] !== suffix[offset]) {
            same = false;
            break;
          }
        }
        if (same) return true;
      }
    }
    return false;
  }

  function oppositeScrollDirection(direction) {
    return direction === 'up' ? 'down' : 'up';
  }

  async function locateBoundaryForUpwardScan(boundary) {
    if (!boundary || boundaryIsVisible(boundary)) return;

    state.manualTopConfirmed = false;
    state.boundarySearchActive = true;
    await progress('Сначала нахожу нижнюю границу выбранного диапазона…', 0, {
      phase: 'boundary',
      boundarySearchActive: true,
      force: true
    });

    const scanDirection = async (direction, limit = 320) => {
      let stable = 0;
      let previous = '';
      for (let i = 0; i < limit; i++) {
        await waitIfPaused();
        await expandVisible();
        if (boundaryIsVisible(boundary)) return true;

        const before = visibleTurnSignature();
        await progress(
          direction === 'up'
            ? 'Ищу отмеченную нижнюю границу выше текущей позиции…'
            : 'Ищу отмеченную нижнюю границу ниже текущей позиции…',
          0,
          {
            phase: 'boundary',
            boundarySearchActive: true,
            boundarySearchDirection: direction,
            boundarySearchIteration: i + 1
          }
        );
        await physicalScroll(direction, direction === 'up' ? 6 : 4, {
          settleTimeout: 2600,
          quietWindow: 350
        });
        await expandVisible();
        if (boundaryIsVisible(boundary)) return true;

        const after = visibleTurnSignature();
        if (after && after === before && after === previous) stable++;
        else stable = 0;
        previous = after;

        const atPhysicalEdge = direction === 'up'
          ? physicalScrollStartVisible()
          : physicalScrollEndVisible();
        if (atPhysicalEdge && stable >= 1) return false;
      }
      return false;
    };

    try {
      if (await scanDirection('up')) return;
      if (await scanDirection('down')) return;

      throw new Error(
        'Не удалось найти зафиксированную нижнюю границу выбранного диапазона. ' +
        'Сбор остановлен, чтобы не захватить сообщения за пределами диапазона.'
      );
    } finally {
      state.boundarySearchActive = false;
      state.manualTopConfirmed = false;
      await progress('Нижняя граница найдена; теперь иду к началу диапазона…', 0, {
        phase: 'top',
        boundarySearchActive: false,
        force: true
      }).catch(() => {});
    }
  }

  async function reachTop(map, order, settings, navigationWindows = null, startAnchor = null, checkpointBoundary = null) {
    let confirmedIdle = 0;
    let previousSignature = '';
    let previousSize = -1;
    let firstVisibleKey = '';

    for (let i = 0; i < 320; i++) {
      await waitIfPaused();

      if (state.manualTopConfirmed) {
        await progress('Этап 1/3: начало подтверждено вручную. Начинаю сохранение сверху вниз…', map.size, {
          phase: 'walk',
          manualTopConfirmed: true,
          force: true
        });
        return;
      }

      if (sharedConversationStartVisible()) return;

      if (await recoverVisibleLoadError('top', map.size)) {
        confirmedIdle = 0;
        previousSignature = '';
        previousSize = -1;
        firstVisibleKey = '';
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, checkpointBoundary);
      recordNavigationWindow(navigationWindows, settings, checkpointBoundary);

      if (startAnchor && orderedTurns().some(turn =>
        anchorMatches({
          id: turnStableKey(turn),
          role: roleOf(turn),
          text: turnMessageText(turn)
        }, startAnchor))) return;

      const turnsBefore = orderedTurns();
      const signature = visibleTurnSignature();
      const firstBefore = turnsBefore.length
        ? (turnStableKey(turnsBefore[0]) || turnTextSignature(turnsBefore[0]))
        : '';

      await progress('Этап 1/3: физически иду к началу · найдено ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1,
        topIdleConfirmations: confirmedIdle
      });

      // Do not infer the real conversation top from scrollTop of a virtualized
      // inner container. Keep physically probing upward and require several
      // unchanged message windows, as the pre-0.3.98 collector did.
      await physicalScroll('up', confirmedIdle > 0 ? 12 : 9, {
        settleTimeout: 4500,
        quietWindow: 450
      });

      if (state.manualTopConfirmed) {
        await progress('Этап 1/3: начало подтверждено вручную. Начинаю сохранение сверху вниз…', map.size, {
          phase: 'walk',
          manualTopConfirmed: true,
          force: true
        });
        return;
      }

      if (sharedConversationStartVisible()) return;

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, checkpointBoundary);
      recordNavigationWindow(navigationWindows, settings, checkpointBoundary);

      if (startAnchor && orderedTurns().some(turn =>
        anchorMatches({
          id: turnStableKey(turn),
          role: roleOf(turn),
          text: turnMessageText(turn)
        }, startAnchor))) return;

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
        await progress('Этап 1/3: проверяю, не догружается ли начало…', map.size, {
          phase: 'top',
          iteration: i + 1,
          topIdleConfirmations: confirmedIdle + 1
        });

        await sleep(700);
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings, checkpointBoundary);
        recordNavigationWindow(navigationWindows, settings, checkpointBoundary);

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

      if (confirmedIdle >= 2 && !visibleRetryButton()) {
        if (startAnchor) {
          throw new Error('Не удалось найти отмеченное начало: достигнуто начало переписки.');
        }
        await progress('Этап 1/3: начало подтверждено повторными проверками · собрано ' + map.size + ' сообщений', map.size, {
          phase: 'walk',
          iteration: i + 1,
          topIdleConfirmations: confirmedIdle,
          force: true
        });
        return;
      }
    }

    throw new Error(
      startAnchor
        ? 'Не удалось найти отмеченное начало.'
        : 'Не удалось надежно подтвердить начало переписки после повторных попыток прокрутки и ожидания догрузки.'
    );
  }

  function sharedConversationStartVisible() {
    if (!/^\/share\/(?:e\/)?/i.test(location.pathname)) return false;
    const intro = String(document.body?.innerText || '').slice(0, 2500);
    return /Это копия общего чата ChatGPT\./i.test(intro) &&
      /Пожаловаться на разговор/i.test(intro);
  }

  async function reachTopWithoutCapture(
    existingCount = 0,
    {
      fullCapture = false,
      timeoutMs = 2 * 60 * 60 * 1000
    } = {}
  ) {
    let confirmedIdle = 0;
    let previousSignature = '';
    let firstVisibleKey = '';
    const startedAt = Date.now();

    for (let i = 0; Date.now() - startedAt < timeoutMs; i++) {
      await waitIfPaused();

      if (state.manualTopConfirmed) {
        await progress(
          fullCapture
            ? 'Этап 1/3: начало подтверждено вручную. Начинаю сохранять сверху вниз…'
            : 'Начало подтверждено вручную. Запускаю хронологический проход вниз…',
          existingCount,
          {
            phase: 'walk',
            manualTopConfirmed: true,
            retryWalkOnly: !fullCapture,
            force: true
          }
        );
        return;
      }

      if (await recoverVisibleLoadError('top', existingCount)) {
        confirmedIdle = 0;
        previousSignature = '';
        firstVisibleKey = '';
      }

      if (sharedConversationStartVisible()) {
        await progress('Начало опубликованной переписки подтверждено.', existingCount, {
          phase: 'walk',
          force: true,
          sharedStartDetected: true
        });
        return;
      }

      const turnsBefore = orderedTurns();
      const signature = visibleTurnSignature();
      const firstBefore = turnsBefore.length
        ? (turnStableKey(turnsBefore[0]) || turnTextSignature(turnsBefore[0]))
        : '';

      await progress(
        fullCapture
          ? 'Этап 1/3: быстро иду к началу · можно помочь вручную'
          : 'Возвращаю рабочую вкладку к началу без пересчёта сообщений…',
        existingCount,
        {
          phase: 'top',
          iteration: i + 1,
          topIdleConfirmations: confirmedIdle,
          retryWalkOnly: !fullCapture,
          manualAssistAllowed: true
        }
      );

      // This phase is navigation only. Give ChatGPT enough time to replace the
      // virtualized message window before deciding that upward motion is over.
      await physicalScroll('up', 24, {
        settleTimeout: 4500,
        quietWindow: 450
      });

      if (state.manualTopConfirmed) {
        await progress(
          fullCapture
            ? 'Этап 1/3: начало подтверждено вручную. Начинаю сохранять сверху вниз…'
            : 'Начало подтверждено вручную. Запускаю хронологический проход вниз…',
          existingCount,
          {
            phase: 'walk',
            manualTopConfirmed: true,
            retryWalkOnly: !fullCapture,
            force: true
          }
        );
        return;
      }

      if (sharedConversationStartVisible()) {
        await progress('Начало опубликованной переписки найдено.', existingCount, {
          phase: 'walk',
          force: true,
          sharedStartDetected: true
        });
        return;
      }

      let nextSignature = visibleTurnSignature();
      let turnsAfter = orderedTurns();
      let firstAfter = turnsAfter.length
        ? (turnStableKey(turnsAfter[0]) || turnTextSignature(turnsAfter[0]))
        : '';

      const unchanged =
        Boolean(nextSignature) &&
        nextSignature === signature &&
        signature === previousSignature &&
        firstAfter === firstBefore &&
        firstAfter === firstVisibleKey;

      if (unchanged) {
        await progress(
          'Этап 1/3: проверяю, не догружается ли ещё более ранняя часть…',
          existingCount,
          {
            phase: 'top',
            iteration: i + 1,
            topIdleConfirmations: confirmedIdle + 1,
            retryWalkOnly: !fullCapture,
            manualAssistAllowed: true
          }
        );

        await sleep(700);
        const afterWaitSignature = visibleTurnSignature();
        turnsAfter = orderedTurns();
        const afterWaitFirst = turnsAfter.length
          ? (turnStableKey(turnsAfter[0]) || turnTextSignature(turnsAfter[0]))
          : '';

        if (afterWaitSignature === nextSignature && afterWaitFirst === firstAfter) {
          confirmedIdle++;
        } else {
          confirmedIdle = 0;
          nextSignature = afterWaitSignature;
          firstAfter = afterWaitFirst;
        }
      } else {
        confirmedIdle = 0;
      }

      previousSignature = nextSignature;
      firstVisibleKey = firstAfter;

      if (confirmedIdle >= 2 && !visibleRetryButton()) {
        await progress(
          fullCapture
            ? 'Этап 1/3: начало подтверждено. Начинаю сохранять сверху вниз…'
            : 'Начало подтверждено. Запускаю хронологический проход вниз…',
          existingCount,
          {
            phase: 'walk',
            iteration: i + 1,
            topIdleConfirmations: confirmedIdle,
            retryWalkOnly: !fullCapture,
            manualAssistAllowed: true,
            force: true
          }
        );
        return;
      }
    }

    throw new Error(
      fullCapture
        ? 'Не удалось подтвердить начало переписки за два часа непрерывной навигации.'
        : 'Не удалось надежно вернуть рабочую вкладку к началу за два часа.'
    );
  }

  async function reachResumeAnchor(anchorId, anchorSignature, tailSignatures, map, order, settings, { allowDownwardFallback = false } = {}) {
    if (!anchorId && !anchorSignature && !(tailSignatures || []).length) {
      throw new Error('У сохраненного архива нет якоря продолжения.');
    }

    for (let i = 0; i < 72; i++) {
      await waitIfPaused();

      if (physicalScrollStartVisible() && i > 0) {
        throw new Error(
          'Сохранённый стык не найден локально. Продолжение остановлено, чтобы не превращать его в полный проход к началу.'
        );
      }

      if (await recoverVisibleLoadError('top', map.size)) {
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);
      }

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

    if (allowDownwardFallback) {
      await progress('Стык не найден выше; проверяю участок ниже текущей позиции…', map.size, {
        phase: 'top',
        force: true
      });

      for (let i = 0; i < 260; i++) {
        await waitIfPaused();
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);

        const tailMatch = findResumeTailMatch(tailSignatures);
        if (tailMatch) {
          await progress('Найден стык незавершённого прохода по соседним репликам.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            anchorMatchLength: tailMatch.matchLength,
            force: true
          });
          return { id: '', signature: tailMatch.signature, matchLength: tailMatch.matchLength };
        }

        if (hasResumeAnchor(anchorId, anchorSignature)) {
          await progress('Найден последний сохранённый стык незавершённого прохода.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            force: true
          });
          return { id: anchorId, signature: anchorSignature, matchLength: 1 };
        }

        await physicalScroll('down', 3);
      }
    }

    throw new Error('Не удалось надежно сопоставить хвост сохраненного архива с текущим чатом.');
  }


  function visibleHasKnownSignatures(knownSignatures) {
    const known = knownSignatures instanceof Set
      ? knownSignatures
      : new Set((knownSignatures || []).filter(Boolean));
    if (!known.size) return false;
    return visibleMeaningfulSignatures().some(item => known.has(item.externalSignature));
  }

  function visibleSavedPrefixEvidence(savedRefs) {
    const refs = (savedRefs || []).filter(ref =>
      ref && (ref.id || ref.externalSignature || ref.signature)
    );
    if (!refs.length) return { known: false, matchLength: 0, savedIndex: -1 };

    const visible = visibleMeaningfulSignatures().map(item => ({
      id: turnStableKey(item.turn),
      signature: item.externalSignature
    }));
    if (!visible.length) return { known: false, matchLength: 0, savedIndex: -1 };

    // Stable message IDs are strong enough on their own.
    let strongestIndex = -1;
    for (const item of visible) {
      if (!item.id) continue;
      const index = refs.findIndex(ref => ref.id && ref.id === item.id);
      if (index >= 0) strongestIndex = Math.max(strongestIndex, index);
    }
    if (strongestIndex >= 0) {
      return { known: true, matchLength: 1, savedIndex: strongestIndex, stable: true };
    }

    // Text signatures can repeat ("Да", "Окей", etc.), so require at least
    // two neighbouring saved messages in the same order before classifying
    // the viewport as part of the saved prefix.
    const maxLength = Math.min(6, visible.length, refs.length);
    for (let length = maxLength; length >= 2; length--) {
      for (let v = 0; v <= visible.length - length; v++) {
        for (let s = 0; s <= refs.length - length; s++) {
          let same = true;
          for (let offset = 0; offset < length; offset++) {
            const savedSignature =
              refs[s + offset].externalSignature || refs[s + offset].signature || '';
            if (!visible[v + offset].signature ||
                visible[v + offset].signature !== savedSignature) {
              same = false;
              break;
            }
          }
          if (same) {
            return {
              known: true,
              matchLength: length,
              savedIndex: s + length - 1,
              stable: false
            };
          }
        }
      }
    }

    return { known: false, matchLength: 0, savedIndex: -1 };
  }

  async function reachDraftResumeAnchor(
    anchorId,
    anchorSignature,
    tailSignatures,
    knownSignatures,
    savedRefs,
    checkpointSignatures,
    lastScrollDirection,
    capturePhase,
    map,
    order,
    settings
  ) {
    const known = new Set((knownSignatures || []).filter(Boolean));

    if (checkpointWindowVisible(checkpointSignatures)) {
      await progress('Сохранённая контрольная точка уже видна. Продолжаю с неё.', map.size, {
        phase: 'top',
        anchorReached: true,
        resumeSearchDirection: capturePhase === 'walk' ? 'down' : lastScrollDirection,
        force: true
      });
      return {
        id: anchorId,
        signature: anchorSignature,
        matchLength: Math.min(6, (checkpointSignatures || []).length),
        checkpointMatched: true
      };
    }

    // During the chronological save pass, captured messages form a continuous
    // prefix from the beginning of the conversation to the saved frontier.
    // Therefore geometry is deterministic:
    // - visible saved messages => viewport is above the frontier, move down;
    // - no saved messages => viewport is below the frontier, move up until the
    //   saved prefix is found, then turn down toward the exact checkpoint.
    if (capturePhase === 'walk') {
      let prefixEvidence = visibleSavedPrefixEvidence(savedRefs);
      const frontierSlack = Math.max(0, (savedRefs || []).length - 12);

      if (prefixEvidence.known && prefixEvidence.savedIndex >= frontierSlack) {
        await progress('Последняя сохранённая часть уже видна. Продолжаю прямо отсюда.', map.size, {
          phase: 'top',
          anchorReached: true,
          resumeSearchDirection: 'down',
          force: true
        });
        return {
          id: anchorId,
          signature: anchorSignature,
          matchLength: Math.max(1, prefixEvidence.matchLength || 1),
          frontierMatched: true
        };
      }

      let knownVisible = prefixEvidence.known;
      let unknownSearchDirection = 'up';
      let direction = knownVisible ? 'down' : unknownSearchDirection;
      let enteredSavedPrefix = knownVisible;
      let crossedFrontier = false;
      let previousSignature = '';
      let unchanged = 0;
      let sameDirectionStalls = 0;
      let reversals = 0;

      for (let i = 0; i < 360; i++) {
        await waitIfPaused();
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);

        if (checkpointWindowVisible(checkpointSignatures)) {
          await progress('Найдена сохранённая контрольная точка. Продолжаю с неё.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            resumeSearchDirection: direction,
            force: true
          });
          return {
            id: anchorId,
            signature: anchorSignature,
            matchLength: Math.min(6, (checkpointSignatures || []).length),
            checkpointMatched: true
          };
        }

        const tailMatch = findResumeTailMatch(tailSignatures);
        if (tailMatch) {
          await progress(
            'Найден последний сохранённый участок по ' + tailMatch.matchLength + ' соседним репликам.',
            map.size,
            {
              phase: 'top',
              iteration: i + 1,
              anchorReached: true,
              anchorMatchLength: tailMatch.matchLength,
              resumeSearchDirection: direction,
              force: true
            }
          );
          return { id: '', signature: tailMatch.signature, matchLength: tailMatch.matchLength };
        }

        if (hasResumeAnchor(anchorId, anchorSignature)) {
          await progress('Найдена последняя сохранённая реплика.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            resumeSearchDirection: direction,
            force: true
          });
          return { id: anchorId, signature: anchorSignature, matchLength: 1 };
        }

        prefixEvidence = visibleSavedPrefixEvidence(savedRefs);
        knownVisible = prefixEvidence.known;

        if (!enteredSavedPrefix) {
          if (knownVisible) {
            enteredSavedPrefix = true;
            crossedFrontier = false;
            direction = 'down';
            unchanged = 0;
            sameDirectionStalls = 0;
            previousSignature = '';
            await progress(
              'Нашёл знакомую сохранённую часть; иду по ней вниз к месту остановки…',
              map.size,
              {
                phase: 'top',
                iteration: i + 1,
                resumeSearchDirection: direction,
                force: true
              }
            );
          } else {
            // Normally unknown content is below the saved frontier, so search
            // upward first. If that physical direction is exhausted without
            // evidence, unknownSearchDirection is reversed and the search
            // continues instead of repeatedly forcing the same edge.
            direction = unknownSearchDirection;
            await progress(
              direction === 'up'
                ? 'Участок пока незнакомый; ищу вверх ближайшую уже сохранённую часть…'
                : 'Участок пока незнакомый; после проверки верхнего края ищу знакомую часть вниз…',
              map.size,
              {
                phase: 'top',
                iteration: i + 1,
                resumeSearchDirection: direction
              }
            );
          }
        } else if (knownVisible) {
          // We are inside the saved prefix; the frontier is at or below us.
          direction = 'down';
          crossedFrontier = false;
          await progress(
            'Участок знакомый; продолжаю вниз к границе уже сохранённого…',
            map.size,
            {
              phase: 'top',
              iteration: i + 1,
              resumeSearchDirection: direction
            }
          );
        } else {
          // Known -> unknown while moving down means the frontier was crossed.
          // Reverse and reduce the step. Keep searching instead of aborting.
          if (direction === 'down') {
            reversals++;
            crossedFrontier = true;
          }
          direction = 'up';
          await progress(
            'Перешёл из знакомой части в незнакомую; возвращаюсь к границе и сужаю шаг…',
            map.size,
            {
              phase: 'top',
              iteration: i + 1,
              resumeSearchDirection: direction,
              frontierCrossed: true,
              frontierReversals: reversals,
              force: true
            }
          );
        }

        const before = visibleTurnSignature();
        const bursts = crossedFrontier
          ? 1
          : direction === 'down'
            ? 2
            : (enteredSavedPrefix ? 2 : 5);

        await physicalScroll(direction, bursts, {
          settleTimeout: 2600,
          quietWindow: 400
        });

        const after = visibleTurnSignature();
        if (after && after === before && after === previousSignature) {
          unchanged++;
          sameDirectionStalls++;
        } else {
          unchanged = 0;
          sameDirectionStalls = 0;
        }
        previousSignature = after;

        // Do not stop merely because one direction stalled. Reverse once the
        // current edge/window is exhausted and keep looking for known content.
        if (sameDirectionStalls >= 4) {
          const atEdge = direction === 'up'
            ? physicalScrollStartVisible()
            : physicalScrollEndVisible();

          if (atEdge) {
            const nextDirection = oppositeScrollDirection(direction);
            direction = nextDirection;
            if (!enteredSavedPrefix) unknownSearchDirection = nextDirection;
            enteredSavedPrefix = false;
            crossedFrontier = false;
            sameDirectionStalls = 0;
            unchanged = 0;
            previousSignature = '';
            reversals++;

            await progress(
              'В этом направлении новых окон больше нет; проверяю противоположное направление…',
              map.size,
              {
                phase: 'top',
                iteration: i + 1,
                resumeSearchDirection: direction,
                resumeSearchEdgeReversal: true,
                frontierReversals: reversals,
                force: true
              }
            );
            continue;
          }
        }

        // 360 directional probes are intentionally generous. At this point the
        // search has already reversed at physical edges and repeatedly failed
        // to recover any saved evidence, so continuing would no longer be an
        // evidence-based resume.
        if (unchanged >= 18 && reversals >= 2) {
          throw new Error(
            enteredSavedPrefix
              ? 'Сохранённую часть нашёл, но точную границу продолжения восстановить не удалось после проверки обоих направлений.'
              : 'Не удалось найти сохранённую часть после проверки обоих направлений.'
          );
        }
      }

      throw new Error('Не удалось восстановить место остановки после полного ориентированного поиска.');
    }

    // Navigation-to-top drafts are not chronological prefixes. For them the
    // only reliable directional hint is the last physical scroll direction:
    // known viewport => continue that way; unknown viewport => search in the
    // opposite direction until known content is found, then turn back.
    const savedDirection = lastScrollDirection === 'down' ? 'down' : 'up';
    let knownVisible = visibleHasKnownSignatures(known);
    let direction = knownVisible
      ? savedDirection
      : oppositeScrollDirection(savedDirection);
    let crossedIntoKnown = knownVisible;
    let unchanged = 0;
    let previousSignature = '';

    for (let i = 0; i < 160; i++) {
      await waitIfPaused();
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      if (checkpointWindowVisible(checkpointSignatures)) {
        await progress('Найдена сохранённая контрольная точка.', map.size, {
          phase: 'top',
          iteration: i + 1,
          anchorReached: true,
          resumeSearchDirection: direction,
          force: true
        });
        return {
          id: anchorId,
          signature: anchorSignature,
          matchLength: Math.min(6, (checkpointSignatures || []).length),
          checkpointMatched: true
        };
      }

      knownVisible = visibleHasKnownSignatures(known);
      if (!crossedIntoKnown && knownVisible) {
        crossedIntoKnown = true;
        direction = savedDirection;
        unchanged = 0;
        previousSignature = '';
      }

      await progress(
        knownVisible
          ? 'Иду по сохранённому участку в направлении последней прокрутки…'
          : 'Ищу сохранённый участок в противоположном направлении…',
        map.size,
        {
          phase: 'top',
          iteration: i + 1,
          resumeSearchDirection: direction
        }
      );

      const before = visibleTurnSignature();
      await physicalScroll(direction, direction === 'down' ? 3 : 5);
      const after = visibleTurnSignature();

      if (after && after === before && after === previousSignature) unchanged++;
      else unchanged = 0;
      previousSignature = after;

      if (unchanged >= 6) {
        throw new Error('Не удалось восстановить контрольную точку навигационного прохода.');
      }
    }

    throw new Error('Не удалось восстановить контрольную точку незавершённого прохода.');
  }

  async function saveRecoveryCheckpoint(map, order, boundary, { force = false } = {}) {
    const jobId = state.jobId;
    if (!jobId || !boundary?.kind || !boundary?.key || !order.length) return;

    const now = Date.now();
    const last = state.recoveryCheckpoint || { at: 0, count: 0 };
    const checkpointSize = order.length;
    const minInterval =
      checkpointSize >= 4000 ? 90000 :
      checkpointSize >= 2000 ? 60000 :
      checkpointSize >= 500 ? 45000 : 30000;
    const minDelta =
      checkpointSize >= 4000 ? 240 :
      checkpointSize >= 2000 ? 140 :
      checkpointSize >= 500 ? 70 : 35;
    if (!force && (now - last.at < minInterval || order.length - last.count < minDelta)) return;

    const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};
    if (current.jobId !== jobId) return;
    // Image-only repair of an unfinished draft must be transactional: do not
    // overwrite the canonical saved text with intermediate DOM snapshots.
    if (current.captureMode === 'images-draft') return;

    let messages = order.map(id => map.get(id)).filter(Boolean);
    if (!messages.length) return;

    const canonicalRecoveryDraftId =
      current.draftId || current.recoveryDraftId || '';
    const canonicalRecoveryDraft = canonicalRecoveryDraftId
      ? (await chrome.storage.local.get('draft:' + canonicalRecoveryDraftId))['draft:' + canonicalRecoveryDraftId]
      : null;
    // On a resumed downward pass, every checkpoint must include the already
    // saved prefix; otherwise a second failure exposes only the new tail.
    if (current.recoveryDraftId && current.phase !== 'top') {
      const prior = (await chrome.storage.local.get('draft:' + current.recoveryDraftId))['draft:' + current.recoveryDraftId];
      if (prior?.messages?.length) {
        const used = new Set();
        const combined = prior.messages.map(previous => {
          const index = messages.findIndex((candidate, i) =>
            !used.has(i) && sameNavigationRef(navigationRef(previous), navigationRef(candidate))
          );
          if (index < 0) return previous;
          used.add(index);
          return mergeRicherCapture(messages[index], previous);
        });
        messages = combined.concat(messages.filter((_, i) => !used.has(i)));
      }
    }

    const draftId = current.draftId || ('draft-' + jobId);
    // In the upward phase the next checkpoint is cumulative. The older saved
    // slice is retained even when Chrome virtualizes it out of the DOM.
    if (current.recoveryDraftId && current.phase === 'top') {
      const preserved = (await chrome.storage.local.get('draft:' + current.recoveryDraftId))['draft:' + current.recoveryDraftId];
      if (preserved?.capturePhase === 'top' && preserved.messages?.length) {
        const known = new Set(preserved.messages.map(item => item.id).filter(Boolean));
        messages = preserved.messages.concat(messages.filter(item => !item.id || !known.has(item.id)));
      }
    }
    const draft = {
      id: draftId,
      kind: 'capture-draft',
      title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'Переписка ChatGPT',
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      captureMode:
        canonicalRecoveryDraft?.captureMode ||
        current.captureMode ||
        'full',
      capturePhase: current.phase || 'walk',
      captureBoundary: current.captureBoundary || boundary,
      navigationHighWater: Number(current.navigationHighWater || 0),
      chronologicalCount: messages.length,
      lastScrollDirection:
        state.lastScrollDirection ||
        (current.phase === 'walk' ? 'down' : 'up'),
      resumeWindowSignatures: currentResumeWindowSignatures(6),
      messages,
      imageCount: messages.reduce((sum, item) => sum + (item.images ? item.images.length : 0), 0),
      imageBinaryReady: messages.reduce((sum, item) =>
        sum + (item.images || []).filter(image => image?.binaryStatus === 'ready' && image.dataUrl).length, 0),
      imageBinaryFailed: messages.reduce((sum, item) =>
        sum + (item.images || []).filter(image => image?.binaryStatus === 'failed').length, 0),
      complete: false,
      error: '',
      captureRange:
        canonicalRecoveryDraft?.captureRange ||
        current.captureRange ||
        null,
      pendingDocUrl: current.pendingDocUrl || '',
      pendingDocMode: current.pendingDocMode || '',
      partialSaveEnabled: Boolean(current.partialSaveEnabled),
      partialArchiveId: current.partialArchiveId || '',
      partialSavedAt: current.partialSavedAt || ''
    };

    // Persist the large checkpoint independently. The background worker is
    // the sole writer of the active job: do not overwrite a newer state with
    // the copy read before storage I/O.
    await chrome.storage.local.set({ ['draft:' + draftId]: draft });
    await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CHECKPOINT_SAVED',
      jobId,
      draftId,
      draftCount: messages.length
    }).catch(() => {});
    state.recoveryCheckpoint = { at: now, count: messages.length };
  }

  function visibleNavigationRefsLightweight() {
    return orderedTurns()
      .map(turn => ({
        id: String(turnStableKey(turn) || ''),
        signature: String(turnTextSignature(turn) || '')
      }))
      .filter(ref => ref.id || ref.signature);
  }

  function navigationWindowsOverlap(a, b) {
    const left = (a || []).filter(ref => ref && (ref.id || ref.signature));
    const right = (b || []).filter(ref => ref && (ref.id || ref.signature));
    if (!left.length || !right.length) return false;

    // A stable message ID is strong evidence on its own.
    for (const x of left) {
      if (!x.id) continue;
      if (right.some(y => y.id && y.id === x.id)) return true;
    }

    // Text signatures can repeat, so require at least two adjacent messages in
    // the same order before treating two virtualized windows as continuous.
    const maxLength = Math.min(4, left.length, right.length);
    for (let length = maxLength; length >= 2; length--) {
      for (let i = 0; i <= left.length - length; i++) {
        for (let j = 0; j <= right.length - length; j++) {
          let same = true;
          for (let offset = 0; offset < length; offset++) {
            if (!left[i + offset].signature ||
                left[i + offset].signature !== right[j + offset].signature) {
              same = false;
              break;
            }
          }
          if (same) return true;
        }
      }
    }

    return false;
  }

  async function recoverDownwardContinuity(beforeRefs, map, order, settings, boundary) {
    for (let attempt = 0; attempt < 14; attempt++) {
      const currentRefs = visibleNavigationRefsLightweight();
      if (navigationWindowsOverlap(beforeRefs, currentRefs)) return true;

      await progress(
        'Этап 2/3: слишком большой скачок вниз; возвращаюсь к последнему перекрывающемуся участку…',
        map.size,
        {
          phase: 'walk',
          continuityRecovery: true,
          continuityAttempt: attempt + 1,
          force: attempt === 0
        }
      );

      await physicalScroll(
        'up',
        1,
        { settleTimeout: 2400, quietWindow: 400 }
      );
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);
    }

    return navigationWindowsOverlap(beforeRefs, visibleNavigationRefsLightweight());
  }

  async function reachTopFullLegacy(map, order, settings, navigationWindows = null, boundary = null) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;

    for (let i = 0; i < 260; i++) {
      await waitIfPaused();

      if (state.manualTopConfirmed) {
        await progress('Этап 1/3: начало подтверждено вручную.', map.size, {
          phase: 'top',
          iteration: i + 1,
          manualTopConfirmed: true,
          force: true
        });
        return;
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);
      recordNavigationWindow(navigationWindows, settings, boundary);

      const signature = visibleTurnSignature();
      await progress('Этап 1/3: первый проход вверх · собрано ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1
      });

      // Historical working cadence from 0.3.14.
      await physicalScroll('up', 7, {
        settleTimeout: 1600,
        quietWindow: 360
      });

      if (state.manualTopConfirmed) {
        await progress('Этап 1/3: начало подтверждено вручную.', map.size, {
          phase: 'top',
          iteration: i + 1,
          manualTopConfirmed: true,
          force: true
        });
        return;
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);
      recordNavigationWindow(navigationWindows, settings, boundary);

      const nextSignature = visibleTurnSignature();
      if (
        nextSignature &&
        nextSignature === signature &&
        signature === previousSignature &&
        map.size === previousSize
      ) {
        stable++;
      } else {
        stable = 0;
      }

      previousSignature = nextSignature;
      previousSize = map.size;

      // This is intentionally the old conservative stop rule. If ChatGPT is
      // slow at the top, the user can press "I'm at the beginning".
      if (stable >= 4) {
        await progress('Этап 1/3: первый проход завершён · собрано ' + map.size + ' сообщений', map.size, {
          phase: 'top',
          iteration: i + 1,
          force: true
        });
        return;
      }
    }

    throw new Error('Не удалось надёжно дойти до начала переписки. Можно повторить и использовать «Я в начале».');
  }

  async function walkDownFullLegacy(map, order, settings, boundary, { firstPassCount = 0, attemptedImageSources = new Set() } = {}) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;

    for (let i = 0; i < 520; i++) {
      await waitIfPaused();

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      const touchedIds = collect(map, order, settings, boundary);
      await hydrateSequentialImages(
        touchedIds.map(id => map.get(id)).filter(Boolean),
        attemptedImageSources
      );

      if (boundaryIsVisible(boundary)) {
        const imageStats = capturedImageStats([...map.values()]);
        const countMatch = Number(firstPassCount || 0) === map.size;
        await progress(
          'Этап 2/3: второй проход завершён · первый ' + Number(firstPassCount || 0) +
            ' · второй ' + map.size + ' · количество ' + (countMatch ? 'совпало' : 'не совпало'),
          map.size,
          {
            phase: 'walk',
            iteration: i + 1,
            boundaryReached: true,
            chronologicalCount: map.size,
            firstPassCount: Number(firstPassCount || 0),
            secondPassCount: map.size,
            passCountMatch: countMatch,
            comparisonComplete: true,
            imageCount: imageStats.total,
            imageBinaryReady: imageStats.ready,
            imageBinaryFailed: imageStats.failed,
            force: true
          }
        );
        return { boundaryReached: true, physicalEndReached: false };
      }

      const signature = visibleTurnSignature();
      const imageStats = capturedImageStats([...map.values()]);
      await progress(
        'Этап 2/3: сверяю сверху вниз · ' + map.size +
          (firstPassCount ? ' из ' + firstPassCount + ' сообщений первого прохода' : ' сообщений'),
        map.size,
        {
          phase: 'walk',
          iteration: i + 1,
          chronologicalCount: map.size,
          firstPassCount: Number(firstPassCount || 0),
          secondPassCount: map.size,
          imageCount: imageStats.total,
          imageBinaryReady: imageStats.ready,
          imageBinaryFailed: imageStats.failed
        }
      );

      // Stable pre-recovery path: one physical scroll request, then wait for the
      // virtualized window to settle. No checkpoint/storage/network/recovery work here.
      await physicalScroll('down');

      const nextSignature = visibleTurnSignature();
      if (nextSignature && nextSignature === signature &&
          signature === previousSignature && map.size === previousSize) {
        stable++;
      } else {
        stable = 0;
      }

      previousSignature = nextSignature;
      previousSize = map.size;

      if (stable >= 4) break;
    }

    if (!boundaryIsVisible(boundary)) {
      throw new Error('Не удалось дойти до зафиксированного конца снимка переписки.');
    }
    return { boundaryReached: true, physicalEndReached: false };
  }

  async function walkDown(
    map,
    order,
    settings,
    boundary,
    {
      bursts = 3,
      requireBoundary = false,
      hydrateImages = false,
      attemptedImageSources = new Set()
    } = {}
  ) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;
    const startedAt = Date.now();
    const timeoutMs = 4 * 60 * 60 * 1000;

    for (let i = 0; Date.now() - startedAt < timeoutMs; i++) {
      await waitIfPaused();

      if (await recoverVisibleLoadError('walk', map.size)) {
        stable = 0;
        previousSignature = '';
        previousSize = -1;
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();

      // Always capture the current viewport before moving. This is especially
      // important for the very first viewport at the real top of the chat.
      const firstTouchedIds = collect(map, order, settings, boundary);
      if (hydrateImages) {
        await hydrateSequentialImages(
          firstTouchedIds.map(id => map.get(id)).filter(Boolean),
          attemptedImageSources
        );
      }
      const beforeRefs = visibleNavigationRefsLightweight();

      if (boundaryIsVisible(boundary)) {
        const boundaryImageStats = capturedImageStats([...map.values()]);
        await progress(
          'Этап 2/3: достигнута метка конца снимка · ' +
            map.size + ' сообщений · ' +
            boundaryImageStats.total + ' изображений найдено',
          map.size,
          {
            phase: 'walk',
            iteration: i + 1,
            boundaryReached: true,
            chronologicalCount: map.size,
            imageCount: boundaryImageStats.total,
            imageBinaryReady: boundaryImageStats.ready,
            imageBinaryFailed: boundaryImageStats.failed,
            force: true
          }
        );
        await saveRecoveryCheckpoint(map, order, boundary, { force: true });
        return { boundaryReached: true, physicalEndReached: false };
      }

      const signature = visibleTurnSignature();
      const walkImageStats = capturedImageStats([...map.values()]);
      await progress(
        'Этап 2/3: физически прохожу вниз · ' +
          map.size + ' сообщений · ' +
          walkImageStats.total + ' изображений найдено',
        map.size,
        {
          phase: 'walk',
          iteration: i + 1,
          chronologicalCount: map.size,
          imageCount: walkImageStats.total,
          imageBinaryReady: walkImageStats.ready,
          imageBinaryFailed: walkImageStats.failed
        }
      );
      await saveRecoveryCheckpoint(map, order, boundary);

      // Downward capture stays granular. If either virtualization or a manual
      // jump moves farther than one overlapping message window, recover upward
      // and re-approach instead of silently accepting a possible gap.
      await physicalScroll('down', bursts, { settleTimeout: 2200, quietWindow: 380 });

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      const secondTouchedIds = collect(map, order, settings, boundary);
      if (hydrateImages) {
        await hydrateSequentialImages(
          secondTouchedIds.map(id => map.get(id)).filter(Boolean),
          attemptedImageSources
        );
      }

      if (boundaryIsVisible(boundary)) {
        const boundaryImageStats = capturedImageStats([...map.values()]);
        await progress(
          'Этап 2/3: достигнута метка конца снимка · ' +
            map.size + ' сообщений · ' +
            boundaryImageStats.total + ' изображений найдено',
          map.size,
          {
            phase: 'walk',
            iteration: i + 1,
            boundaryReached: true,
            chronologicalCount: map.size,
            imageCount: boundaryImageStats.total,
            imageBinaryReady: boundaryImageStats.ready,
            imageBinaryFailed: boundaryImageStats.failed,
            force: true
          }
        );
        await saveRecoveryCheckpoint(map, order, boundary, { force: true });
        return { boundaryReached: true, physicalEndReached: false };
      }

      const afterRefs = visibleNavigationRefsLightweight();
      if (beforeRefs.length && afterRefs.length &&
          !navigationWindowsOverlap(beforeRefs, afterRefs)) {
        const recovered = await recoverDownwardContinuity(
          beforeRefs,
          map,
          order,
          settings,
          boundary
        );
        if (!recovered) {
          throw new Error(
            'Хронологический проход потерял перекрытие между соседними участками. ' +
            'Сбор остановлен, чтобы не сохранить чат с пропуском.'
          );
        }

        stable = 0;
        previousSignature = '';
        previousSize = -1;
        await saveRecoveryCheckpoint(map, order, boundary);
        continue;
      }

      await saveRecoveryCheckpoint(map, order, boundary);

      const nextSignature = visibleTurnSignature();
      if (nextSignature && nextSignature === signature &&
          signature === previousSignature && map.size === previousSize) stable++;
      else stable = 0;

      previousSignature = nextSignature;
      previousSize = map.size;

      if (stable >= 3 && physicalScrollEndVisible()) {
        if (requireBoundary) {
          throw new Error(
            'Достигнут физический конец, но отмеченная нижняя граница не найдена. ' +
            'Ручной диапазон не сохранён, чтобы не выдать локальное окно за полный участок.'
          );
        }
        const endImageStats = capturedImageStats([...map.values()]);
        await progress(
          'Этап 2/3: достигнут физический конец переписки · ' +
            map.size + ' сообщений · ' +
            endImageStats.total + ' изображений найдено',
          map.size,
          {
            phase: 'walk',
            iteration: i + 1,
            physicalEndReached: true,
            boundaryReached: false,
            chronologicalCount: map.size,
            imageCount: endImageStats.total,
            imageBinaryReady: endImageStats.ready,
            imageBinaryFailed: endImageStats.failed,
            force: true
          }
        );
        await saveRecoveryCheckpoint(map, order, boundary, { force: true });
        return { boundaryReached: false, physicalEndReached: true };
      }

      if (stable >= 6) {
        throw new Error(
          'Хронологический проход остановился до зафиксированного конца снимка.'
        );
      }
    }

    throw new Error(
      'Не удалось дойти до зафиксированного конца снимка за четыре часа непрерывного прохода.'
    );
  }

  async function captureConversation(jobId, options = {}) {
    if (state.running) return;
    state.running = true;
    // Remove our marker controls before any message signatures or text are read.
    document.querySelectorAll('.archiver-fragment-buttons').forEach(node => node.remove());
    state.jobId = jobId;
    state.cancel = false;
    state.paused = false;
    state.lastScrollDirection = '';
    state.manualTopConfirmed = false;
    state.boundarySearchActive = false;
    lastProgressAt = 0;

    const mode = ['continue', 'sync', 'compare', 'reconcile', 'images', 'images-draft', 'resume-draft', 'retry-walk', 'fragment'].includes(options.mode) ? options.mode : 'full';
    const resumeAnchorId = String(options.resumeAnchorId || '');
    const resumeAnchorSignature = String(options.resumeAnchorSignature || '');
    const resumeTailSignatures = Array.isArray(options.resumeTailSignatures)
      ? options.resumeTailSignatures.filter(Boolean)
      : [];
    const existingArchiveId = String(options.existingArchiveId || '');
    const existingDraftId = String(options.existingDraftId || '');
    const fixedCaptureBoundary = normalizedBoundary(options.fixedCaptureBoundary);
    const map = new Map();
    const order = [];
    let chronologicalStarted = false;
    let navigationHighWater = 0;
    let navigationFirstId = '';
    let navigationFirstSignature = '';
    let navigationMessages = [];
    let navigationSequence = [];
    let firstPassCount = 0;
    let secondPassCount = 0;
    const sequentialImageSources = new Set();
    let matchedAnchorId = resumeAnchorId;
    let matchedAnchorSignature = resumeAnchorSignature;

    try {
      const settings = await getSettings();
      const resumeNavigation = Boolean(options.resumeNavigation && existingDraftId);
      const selectedFragment = (mode === 'fragment')
        ? (options.captureRange ||
          (await chrome.storage.local.get(fragmentStorageKey()))[fragmentStorageKey()] ||
          {})
        : null;
      if (mode === 'fragment' && !selectedFragment.start && !selectedFragment.end) {
        throw new Error('Отметьте начало или конец фрагмента прямо в чате.');
      }
      await progress(
        mode === 'full'
          ? 'Этап 1/3: фиксирую конец снимка…'
          : mode === 'reconcile'
            ? 'Этап 1/3: фиксирую текущий конец для сверки и добора…'
          : mode === 'images-draft'
            ? 'Этап 1/3: фиксирую границу сохранённой части и готовлю сверку изображений…'
            : mode === 'images'
              ? 'Этап 1/3: фиксирую конец и готовлю добор изображений…'
              : mode === 'retry-walk'
              ? 'Повторяю только второй этап: возвращаюсь к началу без пересчёта сообщений…'
              : mode === 'resume-draft'
                ? 'Этап 1/3: восстанавливаю место незавершённого прохода…'
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

      const markerEnd = (mode === 'fragment') && selectedFragment.end
        ? {
            kind: selectedFragment.end.id ? 'stable' : 'signature',
            key: selectedFragment.end.id || selectedFragment.end.signature,
            role: selectedFragment.end.role || '',
            signature: selectedFragment.end.signature || '',
            strictStable: Boolean(selectedFragment.end.id)
          }
        : null;
      const boundary = markerEnd || fixedCaptureBoundary || makeCaptureBoundary(turns);
      if (!boundary) throw new Error('Не удалось зафиксировать конец снимка переписки.');

      await progress(
        fixedCaptureBoundary
          ? 'Продолжаю незавершённый снимок до исходной нижней метки…'
          : 'Нижняя метка снимка зафиксирована.',
        0,
        {
          phase: 'top',
          force: true,
          captureBoundary: {
            kind: boundary.kind,
            key: boundary.key,
            role: boundary.role || '',
            ordinal: Number(boundary.ordinal ?? -1),
            signature: boundary.signature || '',
            strictStable: Boolean(boundary.strictStable)
          }
        }
      );

      collect(map, order, settings, boundary);

      if (mode === 'full' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile' || mode === 'fragment') {
        const navigationWindows = [];
        if (resumeNavigation) {
          const checkpoint = (await chrome.storage.local.get('draft:' + existingDraftId))['draft:' + existingDraftId];
          const fallbackAnchor = checkpoint?.messages?.[checkpoint.messages.length - 1];
          if (!fallbackAnchor || checkpoint.capturePhase !== 'top') {
            throw new Error('Контрольная точка прокрутки вверх отсутствует.');
          }

          const knownSignatures = checkpoint.messages
            .filter(item => cleanMessageText(item?.text || '', item?.role || ''))
            .map(item => externalMatchSignature(item.role, item.text));

          if ((checkpoint.resumeWindowSignatures || []).length >= 2) {
            await reachDraftResumeAnchor(
              '',
              '',
              [],
              knownSignatures,
              checkpoint.messages.map(item => ({
                id: String(item?.id || ''),
                signature: externalMatchSignature(item?.role || 'unknown', item?.text || '')
              })),
              checkpoint.resumeWindowSignatures,
              checkpoint.lastScrollDirection || 'up',
              checkpoint.capturePhase || 'top',
              map,
              order,
              settings
            );
          } else {
            // Legacy drafts did not persist the visible checkpoint window.
            await reachResumeAnchor(
              fallbackAnchor.id || '',
              fallbackAnchor.text ? messageTextSignature(fallbackAnchor) : '',
              resumeTailSignatures,
              map,
              order,
              settings,
              { allowDownwardFallback: true }
            );
          }

          map.clear();
          order.length = 0;
        }

        if (mode === 'full') {
          // The upward pass is a real first capture again. Keep its message set
          // and navigation windows so the downward pass can prove coverage,
          // recover a turn missed by either pass, and compare the two counts.
          await reachTopFullLegacy(map, order, settings, navigationWindows, boundary);
          navigationMessages = [...map.values()];
          navigationSequence = buildNavigationSequence(navigationWindows);
        } else {
          // Rich upward scans normally begin at the fixed lower boundary. Manual
          // full-range capture is different: the user already chose an explicit
          // end marker, so travelling to that marker before finding the start
          // only adds a redundant down/up pass. Start from the explicit start
          // marker and let the chronological walk stop at the saved end marker.
          if (boundary && !boundaryIsVisible(boundary)) {
            await locateBoundaryForUpwardScan(boundary);
          }
          map.clear();
          order.length = 0;
          // Image recovery still benefits from a rich upward scan, and fragment
          // capture may need to discover its explicit start marker.
          await reachTop(
            map,
            order,
            settings,
            navigationWindows,
            (mode === 'fragment') ? selectedFragment.start || null : null,
            boundary
          );
          navigationMessages = [...map.values()];
          navigationSequence = buildNavigationSequence(navigationWindows);
        }
      } else if (mode === 'retry-walk') {
        if (!existingDraftId) throw new Error('Для повторного прохода нужен сохранённый незавершённый проход.');
        const stored = await chrome.storage.local.get('draft:' + existingDraftId);
        const existingPass = stored['draft:' + existingDraftId];
        if (!existingPass?.messages?.length) {
          throw new Error('Сохранённый незавершённый проход недоступен.');
        }
        await reachTopWithoutCapture(existingPass.messages.length);
      } else {
        let matched;
        if (mode === 'resume-draft' && existingDraftId) {
          const stored = await chrome.storage.local.get('draft:' + existingDraftId);
          const existingPass = stored['draft:' + existingDraftId];
          if (!existingPass?.messages?.length) {
            throw new Error('Сохранённый незавершённый проход недоступен.');
          }
          const knownSignatures = existingPass.messages
            .filter(item => cleanMessageText(item?.text || '', item?.role || ''))
            .map(item => externalMatchSignature(item.role, item.text));

          matched = await reachDraftResumeAnchor(
            resumeAnchorId,
            resumeAnchorSignature,
            resumeTailSignatures,
            knownSignatures,
            existingPass.messages.map(item => ({
              id: String(item?.id || ''),
              signature: messageTextSignature(item),
              externalSignature: externalMatchSignature(item?.role || 'unknown', item?.text || '')
            })),
            existingPass.resumeWindowSignatures || [],
            existingPass.lastScrollDirection ||
              (existingPass.capturePhase === 'walk' ? 'down' : 'up'),
            existingPass.capturePhase || 'walk',
            map,
            order,
            settings
          );
        } else {
          matched = await reachResumeAnchor(
            resumeAnchorId,
            resumeAnchorSignature,
            resumeTailSignatures,
            map,
            order,
            settings,
            { allowDownwardFallback: false }
          );
        }
        matchedAnchorId = matched?.id || '';
        matchedAnchorSignature = matched?.signature || resumeAnchorSignature;
      }

      if (mode === 'full' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile' || mode === 'fragment') {
        navigationHighWater = map.size;
        firstPassCount = navigationHighWater;
        const firstAtTop = orderedTurns()[0] || null;
        navigationFirstId = firstAtTop ? turnStableKey(firstAtTop) : '';
        navigationFirstSignature = firstAtTop ? turnTextSignature(firstAtTop) : '';
        await progress(
          mode === 'full'
            ? 'Этап 1/3: первый проход вверх завершён · ' + navigationHighWater + ' сообщений'
            : 'Этап 1/3: начало подтверждено · навигационный минимум ' + navigationHighWater + ' сообщений',
          navigationHighWater,
          {
            phase: 'top',
            navigationHighWater,
            firstPassCount: navigationHighWater,
            navigationOnly: false,
            force: true
          }
        );
      }

      map.clear();
      order.length = 0;
      chronologicalStarted = true;

      const walkResult = mode === 'full'
        ? await walkDownFullLegacy(map, order, settings, boundary, {
            firstPassCount,
            attemptedImageSources: sequentialImageSources
          })
        : await walkDown(map, order, settings, boundary, {
            bursts: 3,
            requireBoundary: false,
            hydrateImages: mode === 'reconcile' || mode === 'images' || mode === 'images-draft',
            attemptedImageSources: sequentialImageSources
          });

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
      const finalTouchedIds = collect(map, order, settings, boundary);
      if (mode === 'full') {
        await hydrateSequentialImages(
          finalTouchedIds.map(id => map.get(id)).filter(Boolean),
          sequentialImageSources
        );
      }

      let capturedMessages = order.map(id => map.get(id)).filter(Boolean);
      const bounded = trimMessagesThroughBoundary(capturedMessages, boundary);
      const acceptedPhysicalEnd = Boolean(
        mode !== 'full' && !bounded.found && walkResult?.physicalEndReached
      );
      if (!bounded.found && !acceptedPhysicalEnd) {
        throw new Error('Метка конца снимка не найдена в итоговом проходе. Архив не сохранён, чтобы не смешать сообщения, появившиеся после запуска.');
      }
      capturedMessages = bounded.found ? bounded.messages : capturedMessages;

      if (mode === 'full' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile' || mode === 'fragment') {
        const reconciliation = reconcileNavigationCoverage(
          capturedMessages,
          navigationMessages,
          navigationSequence
        );
        secondPassCount = reconciliation.chronologicalCount;
        firstPassCount = navigationHighWater;
        const passCountMatch = firstPassCount === secondPassCount;
        capturedMessages = reconciliation.messages;

        // Keep the best first-pass result as the unfinished-pass source too. The old
        // coverage retry cleared map/order and could destroy a usable capture.
        map.clear();
        order.length = 0;
        for (const message of capturedMessages) {
          if (!message?.id || map.has(message.id)) continue;
          map.set(message.id, message);
          order.push(message.id);
        }

        await progress(
          mode === 'full'
            ? (
                'Сверка проходов: первый ' + firstPassCount +
                ', второй ' + secondPassCount +
                ' · количество ' + (passCountMatch ? 'совпало' : 'не совпало') +
                (reconciliation.insertedCount
                  ? ' · восстановлено ' + reconciliation.insertedCount + ' сообщений'
                  : '') +
                ' · итог ' + capturedMessages.length
              )
            : reconciliation.insertedCount
              ? ('Сверка проходов: восстановлено ' + reconciliation.insertedCount +
                 ' пропущенных сообщений · итог ' + capturedMessages.length)
              : ('Сверка проходов: пропусков не найдено · итог ' + capturedMessages.length),
          capturedMessages.length,
          {
            phase: 'finalizing',
            navigationHighWater,
            chronologicalCount: reconciliation.chronologicalCount,
            firstPassCount,
            secondPassCount,
            passCountMatch,
            comparisonComplete: mode === 'full',
            reconciledInsertedCount: reconciliation.insertedCount,
            reconciledUnresolvedCount: reconciliation.unresolvedCount,
            navigationOnly: false,
            force: true
          }
        );

        if (mode === 'full' || mode === 'reconcile' || mode === 'images-draft' || mode === 'fragment') {
          const finalCount = capturedMessages.length;
          const hasNavigationFirst = capturedMessages.some(item =>
            (navigationFirstId && item.id === navigationFirstId) ||
            (navigationFirstSignature && messageTextSignature(item) === navigationFirstSignature)
          );

          if (
            reconciliation.unresolvedCount > 0 ||
            finalCount < navigationHighWater ||
            (navigationFirstId || navigationFirstSignature) && !hasNavigationFirst
          ) {
            const missing = Math.max(0, navigationHighWater - finalCount);
            throw new Error(
              mode === 'full' && !navigationSequence.length
                ? (
                    'Полный архив не сохранён: хронологический проход не подтвердил весь диапазон ' +
                    'от первой реплики до зафиксированной нижней метки.' +
                    (!hasNavigationFirst ? ' Самая ранняя реплика отсутствует.' : '') +
                    ' Результат оставлен как незавершённый проход.'
                  )
                : (
                    'Полный архив не сохранён: сверка двух проходов не смогла доказательно восстановить все сообщения. ' +
                    'Навигационный минимум: ' + navigationHighWater +
                    ', хронологический проход: ' + reconciliation.chronologicalCount +
                    ', после сверки: ' + finalCount +
                    (reconciliation.insertedCount ? ', вставлено из навигационного прохода: ' + reconciliation.insertedCount : '') +
                    (reconciliation.unresolvedCount ? ', не удалось разместить: ' + reconciliation.unresolvedCount : '') +
                    (missing ? ', не хватает минимум ' + missing : '') +
                    (!hasNavigationFirst ? '. Самая ранняя найденная реплика отсутствует.' : '.') +
                    ' Результат сохранён как незавершённый проход; повторный полный проход автоматически не запускается.'
                  )
            );
          }
        }
      }

      if (mode !== 'full' && mode !== 'images' && mode !== 'retry-walk' && mode !== 'fragment') {
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

      if (mode === 'fragment') {
        const startMatches = selectedFragment.start
          ? capturedMessages.flatMap((item, i) => anchorMatches(item, selectedFragment.start) ? [i] : [])
          : [0];
        const endMatches = selectedFragment.end
          ? capturedMessages.flatMap((item, i) => anchorMatches(item, selectedFragment.end) ? [i] : [])
          : [capturedMessages.length - 1];
        if (startMatches.length !== 1 || endMatches.length !== 1) {
          throw new Error('Невозможно однозначно определить отмеченные реплики.');
        }
        const startAt = startMatches[0];
        const endAt = endMatches[0];
        if (startAt < 0 || endAt < 0 || startAt > endAt) {
          throw new Error('Отмеченные начало и конец не найдены или идут в обратном порядке.');
        }
        capturedMessages = capturedMessages.slice(startAt, endAt + 1);
      }
      if ((mode === 'full' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile' || mode === 'fragment') && !capturedMessages.length) {
        throw new Error('Сообщения не найдены. Возможно, ChatGPT изменил структуру страницы.');
      }

      let messages = capturedMessages;
      const archiveId = existingArchiveId || (String(Date.now()) + '-' + hashText(location.href));
      let addedCount = capturedMessages.length;
      let previousCount = 0;
      let recoveredImageRefs = [];

      if (mode === 'resume-draft' || mode === 'retry-walk') {
        if (!existingDraftId) throw new Error('Для продолжения нужен сохранённый незавершённый проход.');
        const stored = await chrome.storage.local.get('draft:' + existingDraftId);
        const existing = stored['draft:' + existingDraftId];
        if (!existing?.messages?.length) throw new Error('Сохранённый незавершённый проход недоступен.');

        previousCount = existing.messages.length;

        if (mode === 'retry-walk') {
          // retry-walk has just rebuilt the prefix chronologically from the real
          // top to the fixed lower boundary. Treat that pass as canonical;
          // concatenating the old prefix here can duplicate or reorder messages
          // when ChatGPT regenerated turn IDs.
          messages = capturedMessages.map(current => {
            const previous = existing.messages.find(item =>
              sameNavigationRef(navigationRef(item), navigationRef(current))
            );
            return previous ? mergeRicherCapture(current, previous) : current;
          });
          addedCount = Math.max(0, messages.length - previousCount);
        } else {
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
      } else if (mode === 'images-draft') {
        if (!existingDraftId) throw new Error('Для сверки изображений нужен сохранённый незавершённый проход.');
        const stored = await chrome.storage.local.get('draft:' + existingDraftId);
        const existing = stored['draft:' + existingDraftId];
        if (!existing?.messages?.length) {
          throw new Error('Сохранённый незавершённый проход недоступен.');
        }

        previousCount = existing.messages.length;
        const scanPool = [];
        const scanByRef = new Map();
        for (const candidate of [...navigationMessages, ...capturedMessages]) {
          const ref = navigationRef(candidate);
          const key = ref.id || ref.signature || ref.externalSignature;
          if (!key) continue;
          const previous = scanByRef.get(key);
          if (!previous) {
            scanByRef.set(key, { ...candidate, images: [...(candidate.images || [])] });
            continue;
          }
          const merged = mergeImageRecords(previous.images || [], candidate.images || []);
          previous.images = merged.images;
        }
        scanPool.push(...scanByRef.values());

        const merged = mergeRecoveredImagesIntoArchive(existing.messages, scanPool);
        messages = merged.messages;
        recoveredImageRefs = merged.recovered;
        addedCount = 0;
      } else if (mode === 'reconcile') {
        if (!existingArchiveId) throw new Error('Для сверки нужен существующий локальный архив.');
        const stored = await chrome.storage.local.get('archive:' + existingArchiveId);
        const existing = stored['archive:' + existingArchiveId];
        if (!existing?.messages?.length) throw new Error('Локальный архив для сверки недоступен.');

        previousCount = existing.messages.length;
        const reconciled = reconcileVerifiedCaptureWithArchive(capturedMessages, existing.messages);
        if (!reconciled.ok) {
          const index = Number(reconciled.missingArchiveIndex || 0) + 1;
          throw new Error(
            'Сверка остановлена: сохранённое сообщение №' + index +
            ' не удалось подтвердить в текущем полном проходе. ' +
            'Локальный архив не изменён; используйте ручной полный диапазон, если чат был отредактирован или ветка изменилась.'
          );
        }

        messages = reconciled.messages;
        addedCount = reconciled.addedCount;

        // One reconcile pass owns both text and images. Track images that are
        // newly discovered relative to the saved archive so the same result can
        // later be patched into a linked Google Doc without a second scan.
        const existingByRef = new Map();
        for (const message of existing.messages || []) {
          const ref = navigationRef(message);
          const key = ref.id || ref.signature || ref.externalSignature;
          if (key) existingByRef.set(key, message);
        }
        for (const message of messages) {
          const ref = navigationRef(message);
          const key = ref.id || ref.signature || ref.externalSignature;
          const previous = key ? existingByRef.get(key) : null;
          const previousImages = new Map(
            (previous?.images || []).map(image => [String(image?.src || ''), image])
          );
          for (const image of message.images || []) {
            const src = String(image?.src || '');
            if (!src) continue;
            const before = previousImages.get(src);
            if (!before) {
              recoveredImageRefs.push({
                messageId: message.id || '',
                messageSignature: messageTextSignature(message),
                src
              });
            }
          }
        }
      } else if (mode === 'images') {
        if (!existingArchiveId) throw new Error('Для добора изображений нужен существующий локальный архив.');
        const stored = await chrome.storage.local.get('archive:' + existingArchiveId);
        const existing = stored['archive:' + existingArchiveId];
        if (!existing?.messages?.length) throw new Error('Локальный архив для добора изображений недоступен.');

        previousCount = existing.messages.length;

        // The upward and downward scans can each expose a different subset of
        // lazy-loaded images. Union them before merging into the saved archive.
        const scanPool = [];
        const scanByRef = new Map();
        for (const candidate of [...navigationMessages, ...capturedMessages]) {
          const ref = navigationRef(candidate);
          const key = ref.id || ref.signature || ref.externalSignature;
          if (!key) continue;
          const previous = scanByRef.get(key);
          if (!previous) {
            scanByRef.set(key, { ...candidate, images: [...(candidate.images || [])] });
            continue;
          }
          const merged = mergeImageRecords(previous.images || [], candidate.images || []);
          previous.images = merged.images;
        }
        scanPool.push(...scanByRef.values());

        const merged = mergeRecoveredImagesIntoArchive(existing.messages, scanPool);
        messages = merged.messages;
        recoveredImageRefs = merged.recovered;
        addedCount = 0;
      } else if (mode !== 'full' && mode !== 'fragment' && existingArchiveId) {
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
        // Completion is confirmed by the background job controller.
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

      const binaryTargetMessages = (mode === 'full' || mode === 'fragment')
        ? messages
        : mode === 'images-draft'
          ? messages.filter(message => (message.images || []).some(image =>
              image?.src && !(image.binaryStatus === 'ready' && image.dataUrl)
            ))
        : mode === 'reconcile'
          ? messages.filter(message => (message.images || []).some(image =>
              image?.src && !(image.binaryStatus === 'ready' && image.dataUrl)
            ))
        : mode === 'images'
          ? messages.filter(message => {
              const hasMissingBinary = (message.images || []).some(image =>
                image?.src && !(image.binaryStatus === 'ready' && image.dataUrl)
              );
              if (hasMissingBinary) return true;
              return recoveredImageRefs.some(ref =>
                (ref.messageId && ref.messageId === message.id) ||
                (ref.messageSignature && ref.messageSignature === messageTextSignature(message))
              );
            })
          : (addedCount > 0 ? messages.slice(messages.length - addedCount) : []);

      const unresolvedBeforeHydration = (mode === 'images' || mode === 'reconcile')
        ? binaryTargetMessages.flatMap(message =>
            (message.images || [])
              .filter(image => image?.src && !(image.binaryStatus === 'ready' && image.dataUrl))
              .map(image => ({
                message,
                src: image.src
              }))
          )
        : [];

      const binaryStats = await hydrateMessageImages(binaryTargetMessages, {
        onlyMissing: mode === 'full' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile'
      });

      if ((mode === 'images' || mode === 'reconcile') && unresolvedBeforeHydration.length) {
        const knownRecovered = new Set(recoveredImageRefs.map(ref =>
          String(ref.messageId || ref.messageSignature || '') + '|' + String(ref.src || '')
        ));
        for (const item of unresolvedBeforeHydration) {
          const image = (item.message.images || []).find(candidate => candidate?.src === item.src);
          if (!image?.dataUrl || image.binaryStatus !== 'ready') continue;
          const ref = {
            messageId: item.message.id || '',
            messageSignature: messageTextSignature(item.message),
            src: item.src
          };
          const key = String(ref.messageId || ref.messageSignature || '') + '|' + String(ref.src || '');
          if (knownRecovered.has(key)) continue;
          knownRecovered.add(key);
          recoveredImageRefs.push(ref);
        }
      }

      const allImages = messages.flatMap(item => item.images || []);

      if (mode === 'images-draft') {
        const stored = await chrome.storage.local.get('draft:' + existingDraftId);
        const existing = stored['draft:' + existingDraftId];
        if (!existing?.messages?.length) {
          throw new Error('Сохранённый незавершённый проход исчез во время сверки изображений.');
        }
        const nextDraft = {
          ...existing,
          messages,
          chronologicalCount: messages.length,
          imageCount: allImages.length,
          imageBinaryReady: allImages.filter(image =>
            image.binaryStatus === 'ready' && image.dataUrl
          ).length,
          imageBinaryFailed: allImages.filter(image =>
            image.binaryStatus === 'failed'
          ).length,
          capturedAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ ['draft:' + existingDraftId]: nextDraft });
        try {
          await chrome.runtime.sendMessage({
            type: 'ARCHIVER_DRAFT_IMAGES_COMPLETE',
            jobId,
            draftId: existingDraftId,
            count: messages.length,
            imageCount: nextDraft.imageCount,
            imageBinaryReady: nextDraft.imageBinaryReady,
            imageBinaryFailed: nextDraft.imageBinaryFailed
          });
        } catch (_) {}
        return;
      }

      const conversation = {
        title: (mode === 'fragment' ? 'Фрагмент — ' : '') + (document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation'),
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        messages,
        imageCount: allImages.length,
        imageBinaryReady: allImages.filter(image => image.binaryStatus === 'ready' && image.dataUrl).length,
        imageBinaryFailed: allImages.filter(image => image.binaryStatus === 'failed').length,
        lastImageBinaryReady: binaryStats.embedded,
        lastImageBinaryFailed: binaryStats.failed,
        lastCaptureMode: mode,
        firstPassCount: mode === 'full' ? firstPassCount : undefined,
        secondPassCount: mode === 'full' ? secondPassCount : undefined,
        passCountMatch: mode === 'full' ? firstPassCount === secondPassCount : undefined,
        isFragment: mode === 'fragment',
        fragmentMarkers: mode === 'fragment' ? selectedFragment : undefined,
        lastCaptureAddedCount: addedCount,
        lastImageRecoveredCount: recoveredImageRefs.length,
        lastRecoveredImageRefs: recoveredImageRefs,
        previousMessageCount: previousCount,
        reasoningMessageCount,
        reasoningBlockCount,
        lastMessageId: messages[messages.length - 1]?.id || '',
        captureBoundaryKind: boundary.kind || '',
        captureBoundaryKey: boundary.key || '',
        captureBoundaryRole: boundary.role || '',
        captureBoundaryTrimmedNewerCount: bounded.trimmed || 0,
        captureBoundaryReached: Boolean(bounded.found),
        captureEndedAtPhysicalBottom: Boolean(acceptedPhysicalEnd)
      };

      // Store the finished archive independently of the job record.
      await chrome.storage.local.set({
        ['archive:' + archiveId]: Object.assign({}, conversation, { id: archiveId }),
        ...(mode === 'fragment' ? { fragmentLatestId: archiveId } : { lastArchiveId: archiveId })
      });

      try {
        await chrome.runtime.sendMessage({
          type: 'ARCHIVER_CAPTURE_COMPLETE',
          jobId,
          archiveId,
          count: messages.length,
          addedCount,
          imageRecoveredCount: recoveredImageRefs.length,
          mode
        });
      } catch (_) {}
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const status = /отменен/i.test(message) ? 'cancelled' : 'error';
      const current = (await chrome.storage.local.get('activeCaptureJob')).activeCaptureJob || {};

      let draftId = '';
      let draftCount = 0;

      // Image recovery is additive and safe to persist incrementally. If a full
      // image pass fails after finding some lazy-loaded images, merge and embed
      // what was already discovered instead of throwing all that work away.
      if (mode === 'images' && existingArchiveId && status !== 'cancelled') {
        try {
          const storedArchive = await chrome.storage.local.get('archive:' + existingArchiveId);
          const existingArchive = storedArchive['archive:' + existingArchiveId];
          if (existingArchive?.messages?.length) {
            const partialScan = [];
            const partialByRef = new Map();
            for (const candidate of [...navigationMessages, ...order.map(id => map.get(id)).filter(Boolean)]) {
              const ref = navigationRef(candidate);
              const key = ref.id || ref.signature || ref.externalSignature;
              if (!key) continue;
              const previous = partialByRef.get(key);
              if (!previous) {
                partialByRef.set(key, { ...candidate, images: [...(candidate.images || [])] });
                continue;
              }
              const union = mergeImageRecords(previous.images || [], candidate.images || []);
              previous.images = union.images;
            }
            partialScan.push(...partialByRef.values());

            const salvaged = mergeRecoveredImagesIntoArchive(existingArchive.messages, partialScan);
            if (salvaged.recovered.length) {
              const changedMessages = salvaged.messages.filter(message =>
                salvaged.recovered.some(ref =>
                  (ref.messageId && ref.messageId === message.id) ||
                  (ref.messageSignature && ref.messageSignature === messageTextSignature(message))
                )
              );
              await hydrateMessageImages(changedMessages, { onlyMissing: true }).catch(() => {});
              const allImages = salvaged.messages.flatMap(item => item.images || []);
              await chrome.storage.local.set({
                ['archive:' + existingArchiveId]: {
                  ...existingArchive,
                  messages: salvaged.messages,
                  imageCount: allImages.length,
                  imageBinaryReady: allImages.filter(image => image.binaryStatus === 'ready' && image.dataUrl).length,
                  imageBinaryFailed: allImages.filter(image => image.binaryStatus === 'failed').length,
                  lastImageRecoveredCount: salvaged.recovered.length,
                  lastRecoveredImageRefs: salvaged.recovered,
                  lastCaptureMode: 'images-partial',
                  capturedAt: new Date().toISOString()
                }
              });
            }
          }
        } catch (_) {
          // Preserve the original capture failure; partial image salvage is best effort.
        }
      }

      if (mode !== 'images-draft' &&
          (chronologicalStarted || current.phase === 'top') && map.size > 0) {
        let draftMessages = order.map(id => map.get(id)).filter(Boolean);

        let existingRecoveryDraft = null;
        if ((mode === 'resume-draft' || mode === 'retry-walk') && existingDraftId) {
          const stored = await chrome.storage.local.get('draft:' + existingDraftId);
          const existing = stored['draft:' + existingDraftId];
          existingRecoveryDraft = existing || null;
          if (existing?.messages?.length) {
            const seenIds = new Set(existing.messages.map(item => item.id).filter(Boolean));
            const seenSignatures = new Set(
              existing.messages
                .filter(item => cleanMessageText(item.text || '', item.role || ''))
                .map(messageTextSignature)
            );
            const delta = draftMessages.filter(item => {
              if (item.id && seenIds.has(item.id)) return false;
              const hasText = Boolean(cleanMessageText(item.text || '', item.role || ''));
              return !hasText || !seenSignatures.has(messageTextSignature(item));
            });
            // A retry may encounter the same text before lazy images load.
            // Preserve the richer saved version and union newly found images.
            const refreshed = existing.messages.map(previous => {
              const newer = draftMessages.find(item =>
                (previous.id && item.id === previous.id) ||
                sameNavigationRef(navigationRef(previous), navigationRef(item))
              );
              if (!newer) return previous;
              const merged = mergeRicherCapture(newer, previous);
              const extra = mergeImageRecords(previous.images || [], newer.images || []);
              if (extra.added.length) {
                merged.images = extra.images;
                merged.html = appendRecoveredImageMarkup(merged.html, extra.images, extra.added);
              }
              return merged;
            });
            draftMessages = refreshed.concat(delta);
          }
        }

        if (draftMessages.length) {
          if (status !== 'cancelled') {
            const withImages = draftMessages.filter(item => (item.images || []).some(image =>
              image?.src && !(image.binaryStatus === 'ready' && image.dataUrl)
            ));
            if (withImages.length) {
              await hydrateMessageImages(withImages, { onlyMissing: true }).catch(() => {});
            }
          }
          // A resumed capture continues one logical unfinished pass. Reuse the
          // canonical draft ID instead of exposing every retry as a new draft.
          draftId = current.draftId || existingDraftId || current.recoveryDraftId || ('draft-' + jobId);
          draftCount = draftMessages.length;
          const recoveryCapturePhase = chronologicalStarted
            ? 'walk'
            : (existingRecoveryDraft?.capturePhase || current.phase || 'top');
          const draft = {
            id: draftId,
            kind: 'capture-draft',
            title: document.title.replace(/\s*[–—-]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT conversation',
            sourceUrl: location.href,
            capturedAt: new Date().toISOString(),
            captureMode: existingRecoveryDraft?.captureMode || mode,
            capturePhase: recoveryCapturePhase,
            captureBoundary: current.captureBoundary || fixedCaptureBoundary || null,
            navigationHighWater: Number(current.navigationHighWater || existingRecoveryDraft?.navigationHighWater || 0),
            chronologicalCount: draftMessages.length,
            lastScrollDirection:
              state.lastScrollDirection ||
              existingRecoveryDraft?.lastScrollDirection ||
              (recoveryCapturePhase === 'walk' ? 'down' : 'up'),
            resumeWindowSignatures: currentResumeWindowSignatures(6),
            messages: draftMessages,
            imageCount: draftMessages.reduce((sum, item) => sum + (item.images ? item.images.length : 0), 0),
            imageBinaryReady: draftMessages.reduce((sum, item) =>
              sum + (item.images || []).filter(image => image?.binaryStatus === 'ready' && image.dataUrl).length, 0),
            imageBinaryFailed: draftMessages.reduce((sum, item) =>
              sum + (item.images || []).filter(image => image?.binaryStatus === 'failed').length, 0),
            captureRange:
              existingRecoveryDraft?.captureRange ||
              ((mode === 'fragment') ? selectedFragment : null) ||
              current.captureRange ||
              null,
            pendingDocUrl: existingRecoveryDraft?.pendingDocUrl || current.pendingDocUrl || '',
            pendingDocMode: existingRecoveryDraft?.pendingDocMode || current.pendingDocMode || '',
            complete: false,
            error: message,
            partialSaveEnabled: Boolean(existingRecoveryDraft?.partialSaveEnabled || current.partialSaveEnabled),
            partialArchiveId: existingRecoveryDraft?.partialArchiveId || current.partialArchiveId || '',
            partialSavedAt: existingRecoveryDraft?.partialSavedAt || ''
          };
          await chrome.storage.local.set({ ['draft:' + draftId]: draft });
          // Never delete an earlier recovery attempt. A second interruption
          // must still be able to fall back to its last complete prefix.
        }
      }

      if (!draftId) {
        const fallbackDraftIds = [
          current.draftId || '',
          current.recoveryDraftId || '',
          existingDraftId || ''
        ].filter(Boolean);
        for (const candidateId of [...new Set(fallbackDraftIds)]) {
          const saved = (await chrome.storage.local.get('draft:' + candidateId))['draft:' + candidateId];
          if (!saved?.messages?.length) continue;
          draftId = candidateId;
          draftCount = saved.messages.length;
          break;
        }
      }
      // Failure reporting is routed to the worker; a lost connection does
      // not overwrite other jobs, and saved drafts remain on disk.
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
      state.paused = false;
      state.pauseCheckpoint = null;
      state.resumeFailure = '';
      state.lastScrollDirection = '';
      state.manualTopConfirmed = false;
      state.boundarySearchActive = false;
    }
  }


  // Personal fragment markers are anchored to the actual message, never its viewport index.
  const FRAGMENT_KEY_PREFIX = 'archiverFragmentMarkers:';
  const fragmentStyle = document.createElement('style');
  fragmentStyle.textContent = `
    .archiver-fragment-buttons { opacity: .92 !important; pointer-events: auto !important; transition: opacity .15s; }
    .archiver-fragment-buttons:hover, .archiver-fragment-buttons:focus-within { opacity: 1 !important; }
    .archiver-fragment-buttons button { pointer-events: auto !important; }
  `;
  document.documentElement.appendChild(fragmentStyle);
  const fragmentStorageKey = () => FRAGMENT_KEY_PREFIX + location.origin + location.pathname;
  let fragmentMarkers = {};
  function fragmentAnchor(turn) {
    if (!turn) return null;
    const role = roleOf(turn);
    const signature = turnTextSignature(turn);
    const id = turnStableKey(turn);
    return role && (id || signature) ? { id, signature, role } : null;
  }
  function markerIdentityMatches(anchor, candidate) {
    if (!anchor || !candidate) return false;
    if (anchor.id && candidate.id && anchor.id === candidate.id) return true;
    const anchorSignature = String(anchor.signature || '');
    const candidateSignature = String(candidate.signature || '');
    if (!anchorSignature || !candidateSignature || anchorSignature !== candidateSignature) return false;
    const anchorRole = String(anchor.role || '');
    const candidateRole = String(candidate.role || '');
    return !anchorRole || !candidateRole || anchorRole === candidateRole;
  }

  function anchorMatches(message, anchor) {
    if (!anchor || !message) return false;
    return markerIdentityMatches(anchor, {
      id: String(message.id || ''),
      signature: messageTextSignature(message),
      role: String(message.role || '')
    });
  }
  async function loadFragmentMarkers() {
    const record = await chrome.storage.local.get(fragmentStorageKey());
    fragmentMarkers = record[fragmentStorageKey()] || {};
    updateFragmentOverlay();
  }
  function renderFragmentMarkers() {
    return; // Selector UI is owned by the fixed overlay below.
    if (state.running) return;
    for (const turn of orderedTurns()) {
      if (turn.querySelector(':scope > .archiver-fragment-buttons')) continue;
      const marker = fragmentAnchor(turn);
      if (!marker) continue;
      const host = document.createElement('div');
      host.className = 'archiver-fragment-buttons';
      if (['start', 'end'].some(kind => fragmentMarkers[kind] && (fragmentMarkers[kind].id === marker.id || fragmentMarkers[kind].signature === marker.signature))) host.dataset.selected = 'true';
      host.setAttribute('data-archiver-ui', 'true');
      host.style.cssText = 'display:flex;gap:4px;justify-content:flex-end;margin:3px 0;position:relative;z-index:10';
      for (const [kind, caption] of [['start','Начать фрагмент здесь'], ['end','Закончить фрагмент здесь']]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = kind === 'start' ? '⟦ Начало' : 'Конец ⟧';
        btn.title = caption;
        btn.setAttribute('aria-label', caption);
        btn.style.cssText = 'font:12px system-ui;padding:3px 7px;border:1px solid #888;border-radius:6px;background:#f5f5f5;color:#222;cursor:pointer';
        const chosen = fragmentMarkers[kind];
        if (chosen && (chosen.id && chosen.id === marker.id || chosen.signature === marker.signature)) {
          btn.style.background = '#bce9d0';
          btn.setAttribute('aria-pressed','true');
        }
        btn.addEventListener('click', async event => {
          event.preventDefault();event.stopPropagation();
          const same = fragmentMarkers[kind] &&
            (fragmentMarkers[kind].id && fragmentMarkers[kind].id === marker.id ||
             fragmentMarkers[kind].signature === marker.signature);
          if (same) delete fragmentMarkers[kind];
          else fragmentMarkers[kind] = marker;
          await chrome.storage.local.set({ [fragmentStorageKey()]: fragmentMarkers });
          document.querySelectorAll('.archiver-fragment-buttons').forEach(node => node.remove());
          renderFragmentMarkers();
        });
        host.appendChild(btn);
      }
      turn.appendChild(host);
    }
  }
  let fragmentRenderPending = false;
  new MutationObserver(() => {
    if (fragmentRenderPending || state.running) return;
    fragmentRenderPending = true;
    setTimeout(() => { fragmentRenderPending = false; renderFragmentMarkers(); }, 350);
  }).observe(document.documentElement, {subtree:true,childList:true});
  loadFragmentMarkers().catch(() => {});

  // Boundary marking uses a persistent toolbar outside React-controlled DOM.
  // Selecting a message is click-based rather than hover-only, so changes in
  // ChatGPT's nested message markup do not make the controls disappear.
  let fragmentSelectionActive = false;
  let selectedFragmentTurn = null;

  const fragmentOverlay = document.createElement('div');
  fragmentOverlay.id = 'archiver-fragment-overlay';
  fragmentOverlay.setAttribute('data-archiver-ui', 'true');
  fragmentOverlay.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'display:none',
    'right:16px',
    'top:72px',
    'max-width:360px',
    'align-items:center',
    'gap:6px',
    'padding:9px 10px',
    'background:#182a36',
    'color:white',
    'border-radius:10px',
    'box-shadow:0 3px 16px #0006',
    'font:12px system-ui',
    'pointer-events:auto'
  ].join(';');

  const overlayButtons = {};
  const selectionStatus = document.createElement('span');
  selectionStatus.style.cssText = 'font-size:11px;line-height:1.3;min-width:150px';

  function clearSelectedFragmentTurn() {
    if (selectedFragmentTurn?.isConnected) {
      selectedFragmentTurn.style.removeProperty('outline');
      selectedFragmentTurn.style.removeProperty('outline-offset');
    }
    selectedFragmentTurn = null;
  }

  function resolveFragmentTurnFromTarget(target) {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    if (!node) return null;

    const shell = node.closest?.(TURN_SHELL_SELECTOR);
    if (shell && roleOf(shell)) return shell;

    const roleNode = node.closest?.(ROLE_SELECTOR);
    if (roleNode && roleOf(roleNode)) {
      const wrapper = roleNode.closest?.(TURN_SHELL_SELECTOR);
      return wrapper && roleOf(wrapper) ? wrapper : roleNode;
    }

    const turns = orderedTurns();
    return turns.find(turn => turn === node || turn.contains(node)) || null;
  }

  function markerMatchesTurn(kind, turn) {
    if (!turn) return false;
    const anchor = fragmentAnchor(turn);
    const selected = fragmentMarkers[kind];
    if (!anchor || !selected) return false;
    return markerIdentityMatches(selected, anchor);
  }

  function updateFragmentOverlay() {
    if (!fragmentSelectionActive || state.running) {
      fragmentOverlay.style.display = 'none';
      return;
    }

    fragmentOverlay.style.display = 'flex';
    fragmentOverlay.style.flexWrap = 'wrap';

    const hasTurn = Boolean(selectedFragmentTurn?.isConnected && fragmentAnchor(selectedFragmentTurn));
    const marked = [
      fragmentMarkers.start ? 'начало ✓' : 'начало —',
      fragmentMarkers.end ? 'конец ✓' : 'конец —'
    ].join(' · ');
    selectionStatus.textContent = hasTurn
      ? 'Реплика выбрана. ' + marked
      : 'Кликните по реплике. ' + marked;

    for (const kind of ['start', 'end']) {
      const button = overlayButtons[kind];
      if (!button) continue;
      button.disabled = !hasTurn;
      button.style.opacity = hasTurn ? '1' : '.55';
      button.style.background = markerMatchesTurn(kind, selectedFragmentTurn)
        ? '#a2e4bd'
        : '#fff';
    }
  }

  for (const [kind, label] of [['start', '⟦ Начало'], ['end', 'Конец ⟧']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = kind === 'start'
      ? 'Сделать выбранную реплику началом диапазона'
      : 'Сделать выбранную реплику концом диапазона';
    button.style.cssText =
      'font:12px system-ui;background:#fff;color:#222;border:0;border-radius:5px;padding:7px 9px;cursor:pointer';
    button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();

      const anchor = fragmentAnchor(selectedFragmentTurn);
      if (!anchor) return;

      const old = fragmentMarkers[kind];
      if (old && markerIdentityMatches(old, anchor)) {
        delete fragmentMarkers[kind];
      } else {
        fragmentMarkers[kind] = anchor;
      }

      await chrome.storage.local.set({ [fragmentStorageKey()]: fragmentMarkers });
      updateFragmentOverlay();
    });
    overlayButtons[kind] = button;
    fragmentOverlay.appendChild(button);
  }

  fragmentOverlay.appendChild(selectionStatus);

  const closeSelection = document.createElement('button');
  closeSelection.type = 'button';
  closeSelection.textContent = 'Завершить разметку';
  closeSelection.title = 'Выключить режим разметки и оставить выбранные границы';
  closeSelection.setAttribute('aria-label', 'Завершить разметку');
  closeSelection.style.cssText =
    'border:0;border-radius:5px;background:#435766;color:white;padding:7px 9px;cursor:pointer';
  closeSelection.addEventListener('click', () => {
    fragmentSelectionActive = false;
    clearSelectedFragmentTurn();
    updateFragmentOverlay();
  });
  fragmentOverlay.appendChild(closeSelection);

  function attachFragmentOverlay() {
    if (!document.body) return;
    if (!fragmentOverlay.isConnected) document.body.appendChild(fragmentOverlay);
  }

  attachFragmentOverlay();

  document.addEventListener('click', event => {
    if (!fragmentSelectionActive || state.running || fragmentOverlay.contains(event.target)) return;

    const turn = resolveFragmentTurnFromTarget(event.target);
    if (!turn || !roleOf(turn)) return;

    event.preventDefault();
    event.stopPropagation();

    clearSelectedFragmentTurn();
    selectedFragmentTurn = turn;
    selectedFragmentTurn.style.setProperty('outline', '2px solid #38bdf8', 'important');
    selectedFragmentTurn.style.setProperty('outline-offset', '4px', 'important');
    updateFragmentOverlay();
  }, true);

  document.addEventListener('scroll', () => {
    if (fragmentSelectionActive) updateFragmentOverlay();
  }, { passive: true, capture: true });

  window.addEventListener('resize', () => {
    if (fragmentSelectionActive) updateFragmentOverlay();
  }, { passive: true });


  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'ARCHIVER_SET_FRAGMENT_SELECTION') {
      fragmentSelectionActive = Boolean(message.enabled);
      clearSelectedFragmentTurn();
      attachFragmentOverlay();
      updateFragmentOverlay();
      sendResponse({ ok: true, enabled: fragmentSelectionActive });
      return false;
    }
    if (message && message.type === 'ARCHIVER_GET_FRAGMENT_SELECTION') {
      sendResponse({ ok: true, enabled: fragmentSelectionActive });
      return false;
    }
    if (message && message.type === 'ARCHIVER_CLEAR_FRAGMENT_MARKERS') {
      fragmentMarkers = {};
      fragmentSelectionActive = false;
      clearSelectedFragmentTurn();
      chrome.storage.local.remove(fragmentStorageKey()).then(() => {
        removeFragmentOverlay();
        sendResponse({ ok: true, cleared: true });
      }).catch(error => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
      return true;
    }
    if (message && message.type === 'ARCHIVER_PING') {
      sendResponse({ ok: true, version: EXTENSION_VERSION });
      return false;
    }
    if (message && message.type === 'ARCHIVER_CAPTURE_HEALTH') {
      const sameJob = !message.jobId || message.jobId === state.jobId;
      sendResponse({
        ok: true,
        running: Boolean(state.running && sameJob),
        paused: Boolean(state.paused && sameJob),
        cancelling: Boolean(state.cancel && sameJob),
        jobId: state.jobId || '',
        version: EXTENSION_VERSION,
        lastScrollDirection: state.lastScrollDirection || ''
      });
      return false;
    }
    if (message && message.type === 'ARCHIVER_START_CAPTURE') {
      if (state.running) {
        sendResponse({ ok: true, running: true, jobId: state.jobId, version: EXTENSION_VERSION });
        return false;
      }
      captureConversation(message.jobId, {
        mode: message.mode,
        resumeAnchorId: message.resumeAnchorId,
        existingArchiveId: message.existingArchiveId,
        existingDraftId: message.existingDraftId,
        fixedCaptureBoundary: message.fixedCaptureBoundary,
        resumeAnchorSignature: message.resumeAnchorSignature,
        resumeTailSignatures: message.resumeTailSignatures,
        resumeNavigation: Boolean(message.resumeNavigation),
        captureRange: message.captureRange || null
      }).catch(() => {});
      sendResponse({ ok: true, running: true, jobId: message.jobId, version: EXTENSION_VERSION });
      return false;
    }
    if (message && message.type === 'ARCHIVER_CONFIRM_TOP') {
      if (!state.running || (message.jobId && message.jobId !== state.jobId)) {
        sendResponse({ ok: false, error: 'Активный сбор для ручной отметки начала не найден.' });
        return false;
      }
      if (state.boundarySearchActive) {
        sendResponse({
          ok: false,
          error: 'Сейчас Архиватор ищет нижнюю границу диапазона. «Я в начале» станет доступно после её нахождения.'
        });
        return false;
      }
      state.manualTopConfirmed = true;
      sendResponse({ ok: true, confirmed: true });
      return false;
    }
    if (message && message.type === 'ARCHIVER_PAUSE_CAPTURE') {
      if (state.running && (!message.jobId || message.jobId === state.jobId)) {
        state.pauseCheckpoint = makePauseCheckpoint();
        state.paused = true;
      }
      sendResponse({ ok: true, paused: state.paused, checkpointSaved: Boolean(state.pauseCheckpoint) });
      return false;
    }
    if (message && message.type === 'ARCHIVER_RESUME_CAPTURE') {
      if (!state.running || (message.jobId && message.jobId !== state.jobId)) {
        sendResponse({ ok: false, error: 'Активный сбор для продолжения не найден.' });
        return false;
      }

      // Pause means "stop automatic activity here", not "start a recovery
      // traversal on resume". The old resume path tried to scroll while the
      // worker still marked the job paused, so the worker rejected those
      // physical scroll requests and the pause could appear to hang.
      //
      // Resume immediately from the physical viewport that is currently open.
      // If the user moved the page manually during the pause, the ordinary
      // overlap/frontier checks of the active pass decide how to reconnect.
      state.paused = false;
      state.pauseCheckpoint = null;
      state.resumeFailure = '';
      sendResponse({ ok: true, paused: false, recovered: false });
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