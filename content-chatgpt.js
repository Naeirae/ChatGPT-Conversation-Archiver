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
    boundarySearchActive: false,
    queueCapture: false,
    pauseSnapshotWriter: null,
    captureStartProof: null
  };
  let lastProgressAt = 0;
  const SETTINGS_KEY = 'archiverSettings';
  const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
  function createInlineScrollRuntime() {
    function visibleElement(el, { interactive = false } = {}) {
      if (!(el instanceof Element) || !el.isConnected) return false;
      if (el.closest('[aria-hidden="true"], [inert]')) return false;

      const style = getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') <= 0.01
      ) return false;
      if (interactive && style.pointerEvents === 'none') return false;

      const rect = el.getBoundingClientRect();
      const viewportWidth = Math.max(
        1,
        window.innerWidth || document.documentElement.clientWidth || 1
      );
      const viewportHeight = Math.max(
        1,
        window.innerHeight || document.documentElement.clientHeight || 1
      );

      if (
        rect.width < 2 ||
        rect.height < 2 ||
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= viewportHeight ||
        rect.left >= viewportWidth
      ) return false;

      if (!interactive) return true;

      const x = Math.max(1, Math.min(viewportWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(1, Math.min(viewportHeight - 1, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === el || el.contains(hit)));
    }

    function findScrollContainer(turn) {
      let el = turn && turn.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        const style = getComputedStyle(el);
        if (
          /(auto|scroll|overlay)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 20
        ) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    function physicalScrollStartVisible(turns = []) {
      const scroller = findScrollContainer(turns[0] || null);
      if (!scroller) return false;
      const height = Number(scroller.clientHeight || 0);
      if (!height) return false;
      return Number(scroller.scrollTop || 0) <= Math.max(24, Math.round(height * 0.04));
    }

    function physicalScrollEndVisible(turns = []) {
      const scroller = findScrollContainer(turns[turns.length - 1] || null);
      if (!scroller) return false;
      const top = Number(scroller.scrollTop || 0);
      const height = Number(scroller.clientHeight || 0);
      const total = Number(scroller.scrollHeight || 0);
      if (!height || !total) return false;
      return top + height >= total - Math.max(24, Math.round(height * 0.04));
    }

    function findVisibleLoadRetry() {
      const buttonPattern = /^(?:Попробовать снова|Повторить|Try again|Retry)$/i;
      const errorPattern = /(?:something went wrong|there was an error|network error|failed to load|не удалось загрузить|произошла ошибка|ошибка сети|возникла ошибка)/i;
      const viewportHeight = Math.max(
        1,
        window.innerHeight || document.documentElement.clientHeight || 1
      );

      return [...document.querySelectorAll('button, [role="button"]')].find(el => {
        if (!visibleElement(el, { interactive: true }) || el.disabled) return false;

        const label = String(
          el.innerText ||
          el.textContent ||
          el.getAttribute?.('aria-label') ||
          el.getAttribute?.('title') ||
          ''
        ).replace(/\s+/g, ' ').trim();
        if (!buttonPattern.test(label)) return false;

        // Recovery must be scoped to a real, local, visible error card.
        // Never walk high enough to match stale/error text elsewhere on page.
        let node = el.parentElement;
        for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
          if (!visibleElement(node)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.height > Math.max(520, viewportHeight * 0.8)) continue;

          const text = String(node.innerText || node.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text && text.length <= 1800 && errorPattern.test(text)) return true;
        }
        return false;
      }) || null;
    }

    async function waitForTurnSettle(
      getSignature,
      { timeout = 2200, quietWindow = 320, pollMs = 120 } = {}
    ) {
      if (typeof getSignature !== 'function') return '';
      const started = Date.now();
      let previous = String(getSignature() || '');
      let quietSince = Date.now();

      while (Date.now() - started < timeout) {
        await sleep(pollMs);
        const next = String(getSignature() || '');
        if (next && next === previous) {
          if (Date.now() - quietSince >= quietWindow) return next;
        } else {
          previous = next;
          quietSince = Date.now();
        }
      }
      return previous;
    }

    function createStabilityState() {
      return {
        stable: 0,
        previousSignature: '',
        previousCapturedCount: -1,
        previousFirstKey: '',
        previousLastKey: ''
      };
    }

    function resetStabilityState(target) {
      const state = target || createStabilityState();
      state.stable = 0;
      state.previousSignature = '';
      state.previousCapturedCount = -1;
      state.previousFirstKey = '';
      state.previousLastKey = '';
      return state;
    }

    function primeStabilityState(target, observation) {
      const state = resetStabilityState(target);
      state.previousSignature = String(observation?.signature || '');
      state.previousCapturedCount = Number(observation?.capturedCount) || 0;
      state.previousFirstKey = String(observation?.firstKey || '');
      state.previousLastKey = String(observation?.lastKey || '');
      return state;
    }

    function observeWindow({
      turns = [],
      getTurnKey,
      signature = '',
      capturedCount = 0
    } = {}) {
      const keyOf = typeof getTurnKey === 'function' ? getTurnKey : () => '';
      const first = turns[0] || null;
      const last = turns[turns.length - 1] || null;
      return Object.freeze({
        signature: String(signature || ''),
        firstKey: first ? String(keyOf(first) || '') : '',
        lastKey: last ? String(keyOf(last) || '') : '',
        visibleCount: turns.length,
        capturedCount: Number(capturedCount) || 0,
        retryVisible: Boolean(findVisibleLoadRetry()),
        atStart: physicalScrollStartVisible(turns),
        atEnd: physicalScrollEndVisible(turns)
      });
    }

    function sameWindow(left, right, {
      requireCapturedCount = true,
      requireFirstKey = false,
      requireLastKey = false
    } = {}) {
      if (!left || !right || right.retryVisible) return false;
      if (!right.signature || right.signature !== left.signature) return false;
      if (requireCapturedCount && right.capturedCount !== left.capturedCount) return false;
      if (requireFirstKey && right.firstKey !== left.firstKey) return false;
      if (requireLastKey && right.lastKey !== left.lastKey) return false;
      return true;
    }

    function updateStabilityState(target, before, after, options = {}) {
      const state = target || createStabilityState();
      const repeatedPrevious = Boolean(
        after?.signature &&
        before?.signature === state.previousSignature &&
        (!options.requireCapturedCount || after.capturedCount === state.previousCapturedCount) &&
        (!options.requireFirstKey || after.firstKey === state.previousFirstKey) &&
        (!options.requireLastKey || after.lastKey === state.previousLastKey)
      );
      const unchanged = sameWindow(before, after, options) && repeatedPrevious;
      state.stable = unchanged ? state.stable + 1 : 0;
      state.previousSignature = String(after?.signature || '');
      state.previousCapturedCount = Number(after?.capturedCount) || 0;
      state.previousFirstKey = String(after?.firstKey || '');
      state.previousLastKey = String(after?.lastKey || '');
      return { unchanged, stable: state.stable, observation: after };
    }

    async function physicalScroll({
      jobId,
      direction = 'up',
      bursts = 7,
      getSignature,
      settleTimeout = 2200,
      quietWindow = 320,
      turns = [],
      wheelDelta = 860
    } = {}) {
      const normalizedDirection = direction === 'down' ? 'down' : 'up';
      let result = null;
      // A wheel request may already be in flight when Pause is acknowledged.
      // Wait for Resume and retry the step instead of aborting the capture.
      for (let attempt = 0; attempt < 8; attempt++) {
        await waitIfPaused();
        result = await chrome.runtime.sendMessage({
          type: 'ARCHIVER_PHYSICAL_SCROLL',
          queueCapture: state.queueCapture,
          jobId,
          direction: normalizedDirection,
          bursts,
          wheelDelta
        });
        if (result?.ok) break;
        if (result?.paused === true && result?.error === 'CAPTURE_PAUSED') {
          await waitIfPaused();
          await sleep(180);
          continue;
        }
        throw new Error(result?.error || 'Не удалось физически прокрутить вкладку.');
      }
      if (!result?.ok) {
        throw new Error('После паузы рабочая вкладка так и не разрешила прокрутку.');
      }
      await waitForTurnSettle(getSignature, {
        timeout: settleTimeout,
        quietWindow
      });
      return {
        ...result,
        direction: normalizedDirection,
        transport: 'cdp-wheel'
      };
    }

    return Object.freeze({
      findScrollContainer,
      physicalScrollStartVisible,
      physicalScrollEndVisible,
      findVisibleLoadRetry,
      observeWindow,
      createStabilityState,
      resetStabilityState,
      primeStabilityState,
      sameWindow,
      updateStabilityState,
      waitForTurnSettle,
      physicalScroll
    });
  }

  const INLINE_SCROLL_RUNTIME = createInlineScrollRuntime();

  function scrollRuntime() {
    return INLINE_SCROLL_RUNTIME;
  }
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
      await physicalScroll('up', 1);
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
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect?.();
    const viewportWidth = Math.max(
      1,
      window.innerWidth || document.documentElement.clientWidth || 1
    );
    const viewportHeight = Math.max(
      1,
      window.innerHeight || document.documentElement.clientHeight || 1
    );
    if (
      !rect ||
      rect.width < 2 ||
      rect.height < 2 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= viewportHeight ||
      rect.left >= viewportWidth
    ) return false;

    const point = elementPoint(el);
    if (!point) return false;
    const hit = document.elementFromPoint(
      Math.max(1, Math.min(viewportWidth - 1, point.x)),
      Math.max(1, Math.min(viewportHeight - 1, point.y))
    );
    if (!hit || !(hit === el || el.contains(hit))) return false;

    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PHYSICAL_CLICK',
      queueCapture: state.queueCapture,
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
        queueCapture: state.queueCapture,
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
    return scrollRuntime().findVisibleLoadRetry();
  }

  async function recoverVisibleLoadError(phase = 'top', count = 0) {
    const firstRetry = visibleRetryButton();
    if (!firstRetry) return false;

    const originalUrl = location.href;
    let previousSignature = visibleTurnSignature();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await waitIfPaused();

      let retry = visibleRetryButton();
      if (!retry) return true;

      // Virtualized ChatGPT can leave stale retry controls in the DOM for a
      // frame. Revalidate after the DOM settles before claiming/clicking.
      await sleep(120);
      retry = visibleRetryButton();
      if (!retry) return true;

      await progress(
        'ChatGPT не догрузил участок · нажимаю «Попробовать снова» (' + attempt + '/2)…',
        count,
        { phase, retryVisible: true, force: true }
      );

      const clicked = await physicalClickElement(retry);
      if (!clicked) {
        throw new Error(
          'ChatGPT показал «Попробовать снова», но Архиватор не смог нажать кнопку загрузки.'
        );
      }

      const waitStarted = Date.now();
      let changed = false;
      while (Date.now() - waitStarted < 4500) {
        await sleep(250);

        if (location.href !== originalUrl) {
          throw new Error('Переписка сменилась во время повторной загрузки. Сбор остановлен.');
        }

        const currentSignature = visibleTurnSignature();
        if (!visibleRetryButton()) {
          changed = true;
          break;
        }
        if (
          currentSignature &&
          previousSignature &&
          currentSignature !== previousSignature
        ) {
          changed = true;
          break;
        }
      }

      if (changed) return true;
      previousSignature = visibleTurnSignature();

      // One small nudge is allowed between two verified Retry clicks. Never
      // push the chronological walk farther past the failed region.
      if (attempt === 1) {
        await physicalScroll(
          phase === 'walk' ? 'up' : 'up',
          1,
          {
            settleTimeout: 1200,
            quietWindow: 260,
            wheelDelta: phase === 'walk' ? 120 : 320
          }
        );
      }
    }

    if (visibleRetryButton()) {
      throw new Error(
        'ChatGPT дважды не смог догрузить этот участок после «Попробовать снова». ' +
        'Сбор остановлен, чтобы не зациклиться и не сохранить архив с пропуском.'
      );
    }

    return true;
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
    return [...document.querySelectorAll(ROLE_SELECTOR)]
      .filter(isVisible)
      .filter(node => !node.parentElement?.closest(ROLE_SELECTOR));
  }

  function elementLogicalRoles(element) {
    if (!(element instanceof Element)) return [];
    const roles = [];

    const own =
      element.getAttribute('data-message-author-role') ||
      element.getAttribute('data-role') ||
      element.getAttribute('data-message-author') ||
      element.getAttribute('data-turn') ||
      '';
    if (own === 'user' || own === 'assistant') roles.push(own);

    const searchUnit = String(element.getAttribute('data-chatgpt-search-unit-key') || '');
    if (searchUnit.endsWith(':user')) roles.push('user');
    if (searchUnit.endsWith(':assistant')) roles.push('assistant');

    element.querySelectorAll(ROLE_SELECTOR).forEach(node => {
      const role =
        node.getAttribute('data-message-author-role') ||
        node.getAttribute('data-role') ||
        node.getAttribute('data-message-author') ||
        '';
      if (role === 'user' || role === 'assistant') roles.push(role);
    });

    element.querySelectorAll(
      '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]'
    ).forEach(node => {
      const key = String(node.getAttribute('data-chatgpt-search-unit-key') || '');
      if (key.endsWith(':user')) roles.push('user');
      if (key.endsWith(':assistant')) roles.push('assistant');
    });

    return [...new Set(roles)];
  }

  function unambiguousTurnContainer(element, role) {
    if (!(element instanceof Element) || !role) return false;
    const roles = elementLogicalRoles(element);
    return roles.length === 1 && roles[0] === role;
  }

  function getTurn(node) {
    const role = roleOf(node);
    if (!role) return node;

    const searchUnit = node.closest(
      '[data-chatgpt-search-unit-key$=":' + role + '"]'
    );
    if (searchUnit) return searchUnit;

    const semantic = node.closest(
      'section[data-turn="' + role + '"], article[data-turn="' + role + '"]'
    );
    if (semantic) return semantic;

    const conversationTurn = node.closest('[data-testid^="conversation-turn-"]');
    if (conversationTurn && unambiguousTurnContainer(conversationTurn, role)) {
      return conversationTurn;
    }

    const wrapper = node.closest('[data-turn-key]');
    if (wrapper && unambiguousTurnContainer(wrapper, role)) {
      return wrapper;
    }

    // Ambiguous outer shells may contain both a user and assistant message.
    // Keep the role-bearing node itself rather than collapsing both messages.
    return node;
  }

  function orderedTurns() {
    const result = [];
    const seen = new Set();

    const add = turn => {
      if (!(turn instanceof Element) || !roleOf(turn) || seen.has(turn)) return;
      seen.add(turn);
      result.push(turn);
    };

    // Prefer role-bearing nodes because they cannot silently collapse two
    // messages that happen to share one virtualized outer shell.
    getRoleNodes().forEach(node => add(getTurn(node)));

    // Add shell-shaped turns only when the shell itself is unambiguous and no
    // already discovered logical turn represents it.
    document.querySelectorAll(TURN_SHELL_SELECTOR).forEach(shell => {
      const roles = elementLogicalRoles(shell);
      if (roles.length !== 1) return;

      const represented = result.some(turn =>
        turn === shell ||
        shell.contains(turn) ||
        turn.contains?.(shell)
      );
      if (!represented) add(shell);
    });

    // Mixed rollout support: a data-turn-key wrapper may coexist with ordinary
    // shells in the same viewport. Keep a wrapper only when it represents one
    // role and is not already covered by a more specific logical turn.
    document.querySelectorAll(TURN_WRAPPER_SELECTOR).forEach(wrapper => {
      const roles = elementLogicalRoles(wrapper);
      if (roles.length !== 1) return;

      const represented = result.some(turn =>
        turn === wrapper ||
        wrapper.contains(turn) ||
        turn.contains?.(wrapper)
      );
      if (!represented) add(wrapper);
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

  function isStrongMessageId(id = '') {
    return /^(?:data-message-id|data-turn-id):/.test(String(id || ''));
  }

  function turnIdentityContext(turn) {
    const turns = orderedTurns();
    const index = turns.indexOf(turn);
    if (index < 0) return { previous: '', next: '' };
    const previousTurn = index > 0 ? turns[index - 1] : null;
    const nextTurn = index + 1 < turns.length ? turns[index + 1] : null;
    return {
      previous: previousTurn ? turnTextSignature(previousTurn) : '',
      next: nextTurn ? turnTextSignature(nextTurn) : ''
    };
  }

  function identityContextsCompatible(a, b) {
    if (!a || !b) return true;
    if (a.previous && b.previous && a.previous !== b.previous) return false;
    if (a.next && b.next && a.next !== b.next) return false;
    return true;
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
      contextBefore: Array.isArray(value.contextBefore)
        ? value.contextBefore.map(item => String(item || '')).filter(Boolean).slice(-3)
        : [],
      strictStable: Boolean(value.strictStable)
    };
  }

  function boundaryContextBefore(turns, index, limit = 3) {
    if (!Array.isArray(turns) || index <= 0) return [];
    return turns
      .slice(Math.max(0, index - Math.max(1, limit)), index)
      .map(turn => turnTextSignature(turn))
      .filter(Boolean);
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
          signature: turnTextSignature(turns[i]),
          contextBefore: boundaryContextBefore(turns, i)
        };
      }
    }

    for (let i = turns.length - 1; i >= 0; i--) {
      if (roleOf(turns[i]) === 'user') {
        return {
          kind: 'signature',
          key: turnTextSignature(turns[i]),
          role: 'user',
          ordinal: i,
          contextBefore: boundaryContextBefore(turns, i)
        };
      }
    }

    const last = turns[turns.length - 1];
    const index = turns.length - 1;
    return last ? {
      kind: 'signature',
      key: turnTextSignature(last),
      role: roleOf(last) || '',
      ordinal: index,
      contextBefore: boundaryContextBefore(turns, index)
    } : null;
  }

  function boundaryContextMatchesTurns(turn, boundary) {
    const expected = (boundary?.contextBefore || []).filter(Boolean);
    if (!expected.length) return true;
    const turns = orderedTurns();
    const index = turns.indexOf(turn);
    if (index < expected.length) return false;
    const actual = boundaryContextBefore(turns, index, expected.length);
    return actual.length === expected.length &&
      actual.every((signature, offset) => signature === expected[offset]);
  }

  function matchesBoundary(turn, boundary) {
    if (!boundary || !turn) return false;
    // A real ChatGPT message ID remains the same when surrounding turns are
    // virtualized away. Its verified identity is stronger than stale context.
    if (boundary.kind === 'stable' &&
        isStrongMessageId(boundary.key)) {
      return turnStableKey(turn) === boundary.key;
    }
    const contextMatches = boundaryContextMatchesTurns(turn, boundary);
    if (boundary.kind === 'stable') {
      if (turnStableKey(turn) === boundary.key) return contextMatches;
      // Weak virtual wrapper IDs can be recycled; do not stop at repeated
      // text unless the original surrounding message context also matches.
      if (boundary.strictStable) return false;
      return Boolean(
        boundary.signature &&
        turnTextSignature(turn) === boundary.signature &&
        contextMatches
      );
    }
    return turnTextSignature(turn) === boundary.key && contextMatches;
  }

  function physicalScrollEndVisible() {
    return scrollRuntime().physicalScrollEndVisible(orderedTurns());
  }

  function physicalScrollStartVisible() {
    return scrollRuntime().physicalScrollStartVisible(orderedTurns());
  }

  function rectIntersectsCaptureViewport(
    targetRect, viewportWidth, viewportHeight, scrollportRect = null, minPixels = 2
  ) {
    if (!targetRect) return false;
    const t = targetRect;
    const values = [t.left, t.right, t.top, t.bottom, viewportWidth, viewportHeight]
      .map(Number);
    if (!values.every(Number.isFinite) ||
        values[1] <= values[0] || values[3] <= values[2] ||
        values[4] <= 0 || values[5] <= 0) return false;
    let left = Math.max(values[0], 0);
    let right = Math.min(values[1], values[4]);
    let top = Math.max(values[2], 0);
    let bottom = Math.min(values[3], values[5]);
    if (scrollportRect) {
      const r = scrollportRect;
      if (![r.left, r.right, r.top, r.bottom].map(Number).every(Number.isFinite)) return false;
      left = Math.max(left, Number(r.left));
      right = Math.min(right, Number(r.right));
      top = Math.max(top, Number(r.top));
      bottom = Math.min(bottom, Number(r.bottom));
    }
    const minimum = Math.max(1, Number(minPixels) || 2);
    return right - left >= minimum && bottom - top >= minimum;
  }

  function turnIntersectsCaptureViewport(turn) {
    if (!turn?.isConnected) return false;
    const root = contentRoot(turn, roleOf(turn)) || turn;
    const scroller = findScrollContainer(turn);
    const documentRoot = !scroller ||
      scroller === document.documentElement ||
      scroller === document.body ||
      scroller === document.scrollingElement;
    const scrollerRect = documentRoot ? null : scroller.getBoundingClientRect();
    const intersects = element => element?.getBoundingClientRect &&
      rectIntersectsCaptureViewport(
        element.getBoundingClientRect(),
        window.innerWidth || document.documentElement.clientWidth,
        window.innerHeight || document.documentElement.clientHeight,
        scrollerRect
      );
    // contentRoot can point at the FIRST Markdown subtree, whose bounds end
    // well before attachments/other blocks in a many-screen assistant turn.
    // The outer logical turn is still the same message throughout that span.
    // Count that message as visible if its own logical wrapper intersects the
    // actual ChatGPT scrollport; never count a wholly offscreen wrapper.
    return Boolean(intersects(root) || (root !== turn && intersects(turn)));
  }

  function rectTrailingEdgeInsideCaptureViewport(
    rect, viewportWidth, viewportHeight, scrollportRect = null
  ) {
    if (!rectIntersectsCaptureViewport(rect, viewportWidth, viewportHeight, scrollportRect)) {
      return false;
    }
    const top = Math.max(0, scrollportRect ? Number(scrollportRect.top) : 0);
    const bottom = Math.min(
      Number(viewportHeight),
      scrollportRect ? Number(scrollportRect.bottom) : Number(viewportHeight)
    );
    // The turn may be taller than the entire viewport. Seeing its first
    // pixels does not mean that its trailing attachments have been visited.
    return rect.bottom >= top + 2 && rect.bottom <= bottom + 8;
  }

  function turnTrailingEdgeVisible(turn) {
    if (!turn?.isConnected) return false;
    const role = roleOf(turn);
    const root = contentRoot(turn, role) || turn;
    const rootRect = root.getBoundingClientRect();
    // An attachment may be rendered beside the text root, under the logical
    // message wrapper. Its lower edge is still part of the marked message.
    const rect = turnImageNodes(turn, role).reduce((area, image) => {
      const next = image.getBoundingClientRect();
      if (next.width < 2 || next.height < 2) return area;
      return {
        left: Math.min(area.left, next.left),
        right: Math.max(area.right, next.right),
        top: Math.min(area.top, next.top),
        bottom: Math.max(area.bottom, next.bottom)
      };
    }, rootRect);
    const scroller = findScrollContainer(turn);
    const documentRoot = !scroller ||
      scroller === document.documentElement ||
      scroller === document.body ||
      scroller === document.scrollingElement;
    return rectTrailingEdgeInsideCaptureViewport(
      rect,
      window.innerWidth || document.documentElement.clientWidth,
      window.innerHeight || document.documentElement.clientHeight,
      documentRoot ? null : scroller.getBoundingClientRect()
    );
  }

  function boundaryIsVisible(boundary) {
    // Reaching the end marker requires the trailing edge of that message to
    // enter the physical scrollport, not merely its first visible pixels.
    return Boolean(boundary && orderedTurns().some(turn =>
      matchesBoundary(turn, boundary) && turnTrailingEdgeVisible(turn)
    ));
  }

  function findScrollContainer(turn) {
    return scrollRuntime().findScrollContainer(turn);
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
    const identityContext = turnIdentityContext(turn);
    return {
      id: stableId || ((turn.getAttribute('data-testid') || role) + ':' + ordinal + ':' + hashText(text)),
      identityStrong: isStrongMessageId(stableId),
      identityContext,
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

    // Do not scroll to an image during hydration. An image fallback must not
    // disturb the chronological viewport or simulate reaching a boundary.
    try {
      if (img.decode) await Promise.race([img.decode(), sleep(1800)]).catch(() => {});
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
      queueCapture: state.queueCapture,
      jobId: state.jobId,
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
        const blob = await withCaptureOperationTimeout(
          fetchImageBinary(refs[0]), 45000, 'Получение изображения'
        );
        const dataUrl = await withCaptureOperationTimeout(
          blobToDataUrl(blob), 15000, 'Кодирование изображения'
        );
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

  function physicallyVisibleImageSources() {
    const result = new Set();
    for (const image of document.querySelectorAll('img')) {
      const src = imageSource(image);
      if (!src) continue;
      const scroller = findScrollContainer(image);
      const documentRoot = !scroller ||
        scroller === document.documentElement ||
        scroller === document.body ||
        scroller === document.scrollingElement;
      if (rectIntersectsCaptureViewport(
        image.getBoundingClientRect(),
        window.innerWidth || document.documentElement.clientWidth,
        window.innerHeight || document.documentElement.clientHeight,
        documentRoot ? null : scroller.getBoundingClientRect()
      )) result.add(src);
    }
    return result;
  }

  async function hydrateSequentialImages(messages, attemptState, { visibleOnly = false, walkStep = 0 } = {}) {
    // Failed sources must not re-block every 120px movement through a long
    // message. Retry once in a later viewport; finalization still gets an
    // independent last attempt for every missing image.
    const attempts = attemptState instanceof Map ? attemptState : new Map();
    const visibleSources = visibleOnly ? physicallyVisibleImageSources() : null;
    const targets = [];
    const targetSources = new Set();
    const step = Number(walkStep) || 0;

    for (const message of messages || []) {
      const pending = [];
      for (const image of message?.images || []) {
        const src = String(image?.src || '');
        if (!src || (visibleSources && !visibleSources.has(src))) continue;
        const previous = attempts.get(src);
        if (previous?.ready || (image.binaryStatus === 'ready' && image.dataUrl)) {
          attempts.set(src, { ready: true, count: previous?.count || 1, lastStep: step });
          continue;
        }
        if (previous && (previous.count >= 2 || step - previous.lastStep < 8)) continue;
        pending.push(image);
        targetSources.add(src);
      }
      if (pending.length) targets.push({ ...message, images: pending });
    }

    if (!targets.length) return { embedded: 0, failed: 0, unique: 0 };
    const result = await hydrateMessageImages(targets, {
      onlyMissing: false,
      reportProgress: false
    });

    for (const src of targetSources) {
      const refs = targets.flatMap(message =>
        (message.images || []).filter(image => String(image?.src || '') === src)
      );
      const previous = attempts.get(src);
      const ready = refs.some(image => image?.binaryStatus === 'ready' && image.dataUrl);
      attempts.set(src, {
        ready,
        count: (previous?.count || 0) + 1,
        lastStep: step
      });
    }
    return result;
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
        let messageId = message.id;
        let existing = map.get(messageId);

        // A virtual wrapper/text ID is only a weak identity. If the same weak ID
        // reappears with incompatible neighbours, keep both occurrences instead
        // of silently merging a repeated message into the earlier one.
        if (existing && !message.identityStrong &&
            !identityContextsCompatible(existing.identityContext, message.identityContext)) {
          const contextKey = hashText([
            message.identityContext?.previous || '',
            messageTextSignature(message),
            message.identityContext?.next || ''
          ].join('|'));
          messageId = message.id + ':ctx:' + contextKey;
          message.id = messageId;
          existing = map.get(messageId);
        }

        touchedIds.push(messageId);
        if (!existing) {
          order.push(messageId);
          map.set(messageId, message);
        } else {
          // Virtualization can recreate the same turn after a prepared image has
          // disappeared or been recreated as a fresh pending <img>. Preserve the
          // richer snapshot, including ready image binaries even when image counts
          // are equal.
          map.set(messageId, mergeRicherCapture(message, existing));
        }
      }

      // A full capture is a snapshot. Messages created after the bottom marker
      // must never be absorbed just because they became visible while we were
      // walking back down.
      // A mounted offscreen end marker must not truncate the current window.
      if (stopBoundary && matchesBoundary(turn, stopBoundary) &&
          turnTrailingEdgeVisible(turn)) break;
    }

    return [...new Set(touchedIds)];
  }

  function rebuildCaptureMap(map, order, messages) {
    map.clear();
    order.length = 0;

    for (let index = 0; index < (messages || []).length; index++) {
      const message = messages[index];
      if (!message?.id) continue;

      let id = String(message.id);
      if (map.has(id)) {
        if (messageStrongId(message)) {
          // A duplicate strong ID is the same logical message; keep the richer
          // snapshot instead of inventing a second occurrence.
          map.set(id, mergeRicherCapture(message, map.get(id)));
          continue;
        }

        const contextKey = weakIdentityContextKey(message) ||
          hashText([messageTextSignature(message), String(index)].join('|'));
        let candidate = id + ':ctx:' + contextKey;
        let collision = 1;
        while (map.has(candidate)) {
          candidate = id + ':ctx:' + contextKey + ':' + collision++;
        }
        id = candidate;
        message.id = id;
      }

      map.set(id, message);
      order.push(id);
    }
  }

  function capturedImageStats(messages) {
    const images = (messages || []).flatMap(item => item?.images || []);
    return {
      total: images.length,
      ready: images.filter(image => image?.binaryStatus === 'ready' && image.dataUrl).length,
      failed: images.filter(image => image?.binaryStatus === 'failed').length
    };
  }

  function messageBoundaryContextMatches(rows, index, boundary) {
    const expected = (boundary?.contextBefore || []).filter(Boolean);
    if (!expected.length) return true;
    if (index < expected.length) return false;
    const actual = rows
      .slice(index - expected.length, index)
      .map(message => messageTextSignature(message))
      .filter(Boolean);
    return actual.length === expected.length &&
      actual.every((signature, offset) => signature === expected[offset]);
  }

  function messageMatchesBoundary(message, boundary, rows = [], index = -1) {
    if (!message || !boundary) return false;
    if (boundary.kind === 'stable' && isStrongMessageId(boundary.key)) {
      return message.id === boundary.key;
    }
    const contextMatches = messageBoundaryContextMatches(rows, index, boundary);
    if (boundary.kind === 'stable') {
      if (message.id === boundary.key) return contextMatches;
      if (boundary.strictStable) return false;
      return Boolean(
        boundary.signature &&
        messageTextSignature(message) === boundary.signature &&
        contextMatches
      );
    }
    return messageTextSignature(message) === boundary.key && contextMatches;
  }

  function uniqueBoundaryIndex(rows, boundary) {
    if (!boundary) return -1;
    const matches = rows
      .map((message, index) =>
        messageMatchesBoundary(message, boundary, rows, index) ? index : -1
      )
      .filter(index => index >= 0);
    // A strong ID may identify exactly one message. Weak signatures must also
    // resolve uniquely; choosing the first repeat truncates a real conversation.
    return matches.length === 1 ? matches[0] : -1;
  }

  function trimMessagesFromMarkedStart(messages, marker) {
    const rows = [...(messages || [])];
    if (!marker) return { messages: rows, found: false, trimmed: 0 };
    const boundary = isStrongMessageId(marker.id)
      ? { kind: 'stable', key: marker.id }
      : { kind: 'signature', key: marker.signature, contextBefore: marker.contextBefore || [] };
    const index = uniqueBoundaryIndex(rows, boundary);
    if (index < 0) return { messages: rows, found: false, trimmed: 0 };
    return {
      messages: rows.slice(index),
      found: true,
      trimmed: index
    };
  }

  function trimMessagesThroughBoundary(messages, boundary) {
    const rows = [...(messages || [])];
    const index = uniqueBoundaryIndex(rows, boundary);
    if (index < 0) return { messages: rows, found: false, trimmed: 0 };
    return {
      messages: rows.slice(0, index + 1),
      found: true,
      trimmed: Math.max(0, rows.length - index - 1)
    };
  }

  function messageStrongId(message) {
    const id = String(message?.id || '');
    return (message?.identityStrong || isStrongMessageId(id)) ? id : '';
  }

  function navigationRef(message) {
    const id = String(message?.id || '');
    return {
      id,
      strongId: messageStrongId(message),
      signature: message ? messageTextSignature(message) : '',
      externalSignature: message
        ? externalMatchSignature(message?.role || 'unknown', message?.text || '')
        : ''
    };
  }

  function sameNavigationRef(a, b) {
    if (!a || !b) return false;
    return Boolean(a.strongId && b.strongId && a.strongId === b.strongId);
  }

  function sameNavigationText(a, b) {
    if (!a || !b) return false;
    if (a.signature && b.signature && a.signature === b.signature) return true;
    return Boolean(
      a.externalSignature &&
      b.externalSignature &&
      a.externalSignature === b.externalSignature
    );
  }

  function sameNavigationSequence(left, right, minWeakLength = 2) {
    const a = (left || []).filter(Boolean);
    const b = (right || []).filter(Boolean);
    if (!a.length || a.length !== b.length) return false;
    const allStrong = a.every((ref, index) => sameNavigationRef(ref, b[index]));
    if (allStrong) return true;
    if (a.length < minWeakLength) return false;
    return a.every((ref, index) =>
      sameNavigationRef(ref, b[index]) || sameNavigationText(ref, b[index])
    );
  }

  function findContextualRefIndex(targetRefs, ref, sourceRefs = [], sourceIndex = -1) {
    const target = (targetRefs || []).filter(Boolean);
    if (!ref || !target.length) return -1;

    const strongMatches = target
      .map((candidate, index) => sameNavigationRef(candidate, ref) ? index : -1)
      .filter(index => index >= 0);
    if (strongMatches.length === 1) return strongMatches[0];
    if (strongMatches.length > 1) return -1;

    if (sourceIndex < 0 || !sourceRefs.length) return -1;

    const windows = [];
    for (const length of [4, 3, 2]) {
      for (let start = Math.max(0, sourceIndex - length + 1);
           start <= Math.min(sourceIndex, sourceRefs.length - length);
           start++) {
        const end = start + length;
        if (sourceIndex < start || sourceIndex >= end) continue;
        windows.push({ start, end, length });
      }
    }

    for (const window of windows) {
      const needle = sourceRefs.slice(window.start, window.end);
      const offset = sourceIndex - window.start;
      const matches = [];
      for (let i = 0; i <= target.length - needle.length; i++) {
        const candidate = target.slice(i, i + needle.length);
        if (sameNavigationSequence(needle, candidate, 2)) {
          matches.push(i + offset);
        }
      }
      if (matches.length === 1) return matches[0];
    }

    return -1;
  }

  function findContextualMessageIndex(messages, message, sourceMessages = [], sourceIndex = -1) {
    const targetRefs = (messages || []).map(navigationRef);
    const sourceRefs = (sourceMessages || []).map(navigationRef);
    return findContextualRefIndex(targetRefs, navigationRef(message), sourceRefs, sourceIndex);
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
      sameNavigationSequence(previous, refs, 2)
    ) return;

    windows.push(refs);
  }

  function buildNavigationSequence(windows) {
    let sequence = [];

    for (const windowRefs of windows || []) {
      const refs = (windowRefs || []).filter(ref =>
        ref && (ref.strongId || ref.id || ref.signature)
      );
      if (!refs.length) continue;
      if (!sequence.length) {
        sequence = [...refs];
        continue;
      }

      let overlap = 0;
      const maxOverlap = Math.min(refs.length, sequence.length);
      for (let size = maxOverlap; size >= 1; size--) {
        const left = refs.slice(refs.length - size);
        const right = sequence.slice(0, size);
        if (
          (size === 1 && sameNavigationRef(left[0], right[0])) ||
          (size >= 2 && sameNavigationSequence(left, right, 2))
        ) {
          overlap = size;
          break;
        }
      }

      if (overlap) {
        sequence = refs.slice(0, refs.length - overlap).concat(sequence);
        continue;
      }

      // A single weak text match is never enough to pivot or deduplicate an
      // upward navigation window. Only a strong message ID may anchor a
      // one-message overlap; otherwise preserve the whole window as evidence.
      let pivot = null;
      for (let i = 0; i < refs.length && !pivot; i++) {
        const j = sequence.findIndex(existing => sameNavigationRef(refs[i], existing));
        if (j >= 0) pivot = { i, j };
      }

      if (pivot) {
        sequence = refs.slice(0, pivot.i).concat(sequence);
        continue;
      }

      sequence = refs.concat(sequence);
    }

    const deduped = [];
    for (const ref of sequence) {
      if (
        ref.strongId &&
        deduped.some(existing => sameNavigationRef(ref, existing))
      ) continue;
      deduped.push(ref);
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
    const navRefs = (navigationSequence || []).filter(Boolean);

    const resultRefs = () => result.map(navigationRef);
    const navMessageRefs = navMessages.map(navigationRef);

    const findResultIndex = ref => {
      const sourceIndex = navRefs.indexOf(ref);
      return findContextualRefIndex(resultRefs(), ref, navRefs, sourceIndex);
    };

    const findNavigationMessage = ref => {
      const sourceIndex = navRefs.indexOf(ref);
      const index = findContextualRefIndex(navMessageRefs, ref, navRefs, sourceIndex);
      return index >= 0 ? navMessages[index] : null;
    };

    // Enrich only when the correspondence is strong or uniquely contextual.
    // Repeated standalone text is never enough to merge two messages.
    for (let i = 0; i < result.length; i++) {
      const index = findContextualMessageIndex(
        navMessages,
        result[i],
        result,
        i
      );
      if (index >= 0) {
        result[i] = mergeRicherCapture(result[i], navMessages[index]);
      }
    }

    const missingGroups = [];
    let current = [];
    for (const ref of navRefs) {
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
      const firstNavIndex = navRefs.indexOf(firstRef);
      const lastNavIndex = navRefs.indexOf(lastRef);

      let previousRef = null;
      for (let i = firstNavIndex - 1; i >= 0; i--) {
        if (findResultIndex(navRefs[i]) >= 0) {
          previousRef = navRefs[i];
          break;
        }
      }

      let nextRef = null;
      for (let i = lastNavIndex + 1; i < navRefs.length; i++) {
        if (findResultIndex(navRefs[i]) >= 0) {
          nextRef = navRefs[i];
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

    const unresolvedRefs = navRefs.filter(ref => findResultIndex(ref) < 0);
    unresolvedCount = Math.max(unresolvedCount, unresolvedRefs.length);

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
      const candidateSlice = captured.slice(searchFrom);
      const localIndex = findContextualMessageIndex(
        candidateSlice,
        oldMessage,
        existing,
        oldIndex
      );
      const found = localIndex >= 0 ? searchFrom + localIndex : -1;

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

  function weakIdentityContextKey(message) {
    const context = message?.identityContext || {};
    if (!context.previous && !context.next) return '';
    return hashText([
      context.previous || '',
      messageTextSignature(message),
      context.next || ''
    ].join('|'));
  }

  function buildImageScanPool(candidates) {
    const pooled = [];
    const byKey = new Map();

    for (const candidate of candidates || []) {
      if (!candidate) continue;
      const strongId = messageStrongId(candidate);
      const weakContext = weakIdentityContextKey(candidate);
      const key = strongId
        ? 'strong:' + strongId
        : weakContext
          ? 'weak:' + String(candidate.id || '') + ':' + weakContext
          : '';

      if (!key) {
        pooled.push({ ...candidate, images: [...(candidate.images || [])] });
        continue;
      }

      const previous = byKey.get(key);
      if (!previous) {
        const copy = { ...candidate, images: [...(candidate.images || [])] };
        byKey.set(key, copy);
        pooled.push(copy);
        continue;
      }

      const merged = mergeImageRecords(previous.images || [], candidate.images || []);
      previous.images = merged.images;
    }

    return pooled;
  }

  function mergeRecoveredImagesIntoArchive(existingMessages, scannedMessages) {
    const scanned = scannedMessages || [];
    const result = (existingMessages || []).map(message => ({ ...message }));
    const recovered = [];

    for (let i = 0; i < result.length; i++) {
      const target = result[i];
      const sourceIndex = findContextualMessageIndex(
        scanned,
        target,
        result,
        i
      );
      const source = sourceIndex >= 0 ? scanned[sourceIndex] : null;
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

  async function withCaptureOperationTimeout(operation, timeoutMs, label) {
    let timeoutId;
    try {
      return await Promise.race([
        Promise.resolve(operation),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(
            label + ': не получен ответ за ' + Math.ceil(timeoutMs / 1000) + ' с.'
          )), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function progress(message, count, extra) {
    const now = Date.now();
    if (now - lastProgressAt < 1500 && !(extra && extra.force)) return;
    lastProgressAt = now;
    const patch = Object.assign({ status: 'running', message, count }, extra || {});
    const strictFinalization = Boolean(extra?.finalizationStep || extra?.phase === 'finalizing');
    try {
      const request = chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_PROGRESS',
        queueCapture: state.queueCapture,
        jobId: state.jobId,
        patch
      });
      const result = await withCaptureOperationTimeout(
        request,
        strictFinalization ? 30000 : 12000,
        strictFinalization ? 'Завершение сбора' : 'Обновление прогресса'
      );
      if (result?.ok) return result;
      if (result && result.ok === false) {
        throw new Error(result.error || 'Фоновый процесс остановил этот сбор.');
      }
    } catch (error) {
      // A missing acknowledgement during final persistence cannot be treated
      // as an optional progress update: preserve a draft and stop rather than
      // leaving the popup silently in the image-loading phase.
      if (strictFinalization ||
          (error?.message && /останов|неактуал|Прогресс пришел не из вкладки сбора/i.test(error.message))) {
        throw error;
      }
    }
    return updateJob(patch);
  }

  function visibleTurnSignature() {
    const keys = orderedTurns().map(turn => turnStableKey(turn) || turnTextSignature(turn));
    return keys.join('|') + '::' + keys.length;
  }

  function visibleTopTextSignature(limit = 6) {
    const signatures = orderedTurns()
      .slice(0, Math.max(2, Number(limit) || 6))
      .map(turn => turnTextSignature(turn))
      .filter(Boolean);
    return signatures.join('|') + '::' + signatures.length;
  }

  function scrollObservation(capturedCount = 0) {
    const turns = orderedTurns();
    return scrollRuntime().observeWindow({
      turns,
      getTurnKey: turn => turnStableKey(turn) || turnTextSignature(turn),
      signature: visibleTurnSignature(),
      capturedCount
    });
  }

  async function waitForTurnSettle(timeout = 8000, quietWindow = 1400) {
    return scrollRuntime().waitForTurnSettle(visibleTurnSignature, {
      timeout,
      quietWindow
    });
  }

  async function physicalScroll(
    direction,
    bursts = 7,
    { settleTimeout = 8000, quietWindow = 1400, wheelDelta = 860 } = {}
  ) {
    const result = await scrollRuntime().physicalScroll({
      jobId: state.jobId,
      direction,
      bursts,
      getSignature: visibleTurnSignature,
      settleTimeout,
      quietWindow,
      turns: orderedTurns(),
      wheelDelta
    });
    state.lastScrollDirection = result.direction;
    return result;
  }

  function hasStableResumeAnchor(id) {
    const strongId = String(id || '');
    if (!isStrongMessageId(strongId)) return false;
    return orderedTurns().some(turn => turnStableKey(turn) === strongId);
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

  function locateCapturedResumeAnchor(messages, {
    anchorId = '',
    anchorSignature = '',
    tailSignatures = []
  } = {}) {
    const captured = messages || [];

    if (anchorId) {
      const matches = captured
        .map((item, index) => item?.id === anchorId ? index : -1)
        .filter(index => index >= 0);
      if (matches.length === 1) return { index: matches[0], method: 'stable-id', matchLength: 1 };
      if (matches.length > 1) return { index: -1, ambiguous: true, method: 'stable-id' };
    }

    const baseline = (tailSignatures || []).filter(Boolean);
    if (baseline.length >= 2) {
      const signatures = captured.map(item =>
        externalMatchSignature(item?.role || 'unknown', item?.text || '')
      );
      const maxLength = Math.min(4, baseline.length, signatures.length);

      for (let length = maxLength; length >= 2; length--) {
        const suffix = baseline.slice(-length);
        const matches = [];
        for (let start = 0; start <= signatures.length - length; start++) {
          let same = true;
          for (let offset = 0; offset < length; offset++) {
            if (!signatures[start + offset] || signatures[start + offset] !== suffix[offset]) {
              same = false;
              break;
            }
          }
          if (same) matches.push(start + length - 1);
        }
        if (matches.length === 1) {
          return { index: matches[0], method: 'tail', matchLength: length };
        }
        if (matches.length > 1) {
          continue;
        }
      }
    }

    if (anchorSignature) {
      const matches = captured
        .map((item, index) => messageTextSignature(item) === anchorSignature ? index : -1)
        .filter(index => index >= 0);
      if (matches.length === 1) return { index: matches[0], method: 'signature', matchLength: 1 };
      if (matches.length > 1) return { index: -1, ambiguous: true, method: 'signature' };
    }

    return { index: -1, ambiguous: false, method: '' };
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
        await physicalScroll(direction, 1, {
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
    const stability = scrollRuntime().createStabilityState();

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
        scrollRuntime().resetStabilityState(stability);
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

      const before = scrollObservation(map.size);

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

      const after = scrollObservation(map.size);
      const candidate = scrollRuntime().updateStabilityState(stability, before, after, {
        requireFirstKey: true
      });

      if (candidate.unchanged) {
        await progress('Этап 1/3: проверяю, не догружается ли начало…', map.size, {
          phase: 'top',
          iteration: i + 1,
          topIdleConfirmations: candidate.stable
        });

        await sleep(700);
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings, checkpointBoundary);
        recordNavigationWindow(navigationWindows, settings, checkpointBoundary);

        const afterWait = scrollObservation(map.size);
        if (scrollRuntime().sameWindow(after, afterWait, { requireFirstKey: true })) {
          confirmedIdle = candidate.stable;
        } else {
          confirmedIdle = 0;
          scrollRuntime().primeStabilityState(stability, afterWait);
        }
      } else {
        confirmedIdle = 0;
      }

      if (confirmedIdle >= 2) {
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

  function explicitConversationStartVisible() {
    // A fallback-turn-0 index may be assigned to the FIRST RENDERED ITEM of
    // any virtualized window. It is not proof of the real conversation start.
    // Use a globally numbered conversation turn when provided; otherwise
    // require verified upward movement/stability or explicit user marking.
    return [...document.querySelectorAll('[data-testid="conversation-turn-0"]')]
      .some(node => isVisible(node) && roleOf(node));
  }

  function firstVisibleTurnSignature() {
    const first = orderedTurns()[0] || null;
    return first ? turnTextSignature(first) : '';
  }

  // Establish the real snapshot end before fixing its message boundary.
  // A freshly loaded copy can start on an arbitrary virtualized window; its
  // last rendered turn is NOT automatically the last turn of the conversation.
  async function reachSnapshotEndWithoutCapture(timeoutMs = 20 * 60 * 1000) {
    const startedAt = Date.now();
    let previousSignature = '';
    let quietAtEnd = 0;
    let observedDownwardTravel = false;

    for (let i = 0; Date.now() - startedAt < timeoutMs; i++) {
      await waitIfPaused();
      if (await recoverVisibleLoadError('top', 0)) {
        previousSignature = '';
        quietAtEnd = 0;
      }

      const before = scrollObservation(0);
      if (before.atEnd && before.signature && before.signature === previousSignature) {
        quietAtEnd++;
      } else {
        quietAtEnd = 0;
      }
      if (quietAtEnd >= 2 && !visibleRetryButton()) {
        return {
          verified: true,
          source: observedDownwardTravel ? 'downward-navigation' : 'settled-physical-end',
          observedDownwardTravel
        };
      }

      await progress(
        'Этап 1/3: проверяю фактический конец переписки, прежде чем закрепить снимок…',
        0,
        { phase: 'boundary', boundarySearchDirection: 'down', iteration: i + 1 }
      );
      const result = await physicalScroll('down', 2, {
        settleTimeout: 2200, quietWindow: 450
      });
      const after = scrollObservation(0);
      observedDownwardTravel ||= Boolean(result.moved);
      if (!result.moved && !after.atEnd && after.signature === before.signature) {
        throw new Error(
          'Не удалось прокрутить чат до настоящего конца. Последняя видимая реплика не считается границей архива.'
        );
      }
      previousSignature = after.signature;
      // Let ChatGPT finish lazy-loading the next virtualized page.
      await sleep(500);
    }
    throw new Error('Не удалось подтвердить конец переписки. Архив не объявлен полным.');
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
    let observedUpwardTravel = false;
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
        return { verified: true, source: 'user-confirmed-start', observedUpwardTravel, stableChecks: confirmedIdle };
      }

      if (await recoverVisibleLoadError('top', existingCount)) {
        confirmedIdle = 0;
        previousSignature = '';
        firstVisibleKey = '';
      }

      if (sharedConversationStartVisible() || explicitConversationStartVisible()) {
        await progress('Этап 1/3: начало переписки найдено.', existingCount, {
          phase: 'walk',
          force: true,
          explicitStartDetected: true
        });
        return { verified: true, source: 'visible-first-turn', observedUpwardTravel, stableChecks: confirmedIdle };
      }

      const turnsBefore = orderedTurns();
      const signature = visibleTurnSignature();
      const firstBefore = turnsBefore.length
        ? (turnStableKey(turnsBefore[0]) || turnTextSignature(turnsBefore[0]))
        : '';

      await progress(
        fullCapture
          ? 'Этап 1/3: быстро иду к началу через debugger · без сбора сообщений вверх'
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

      // 0.3.87 full-capture invariant: upward travel is navigation only.
      // Large bursts are allowed here because no canonical messages are
      // committed until the chronological pass starts at the confirmed top.
      const travel = await physicalScroll(
        'up',
        16,
        { settleTimeout: 5000, quietWindow: 550 }
      );
      observedUpwardTravel ||= Boolean(travel.moved);

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
        return { verified: true, source: 'user-confirmed-start', observedUpwardTravel, stableChecks: confirmedIdle };
      }

      if (sharedConversationStartVisible() || explicitConversationStartVisible()) {
        await progress('Этап 1/3: начало переписки найдено.', existingCount, {
          phase: 'walk',
          iteration: i + 1,
          force: true,
          explicitStartDetected: true
        });
        return { verified: true, source: 'visible-first-turn', observedUpwardTravel, stableChecks: confirmedIdle };
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

        await sleep(2200);
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

      // Do not use physicalScrollStartVisible() here. That heuristic was added
      // in 0.3.98 and was later explicitly reverted as a traversal regression.
      if (confirmedIdle >= 5 && !visibleRetryButton()) {
        if (!observedUpwardTravel) {
          throw new Error(
            'Вкладка не прокручивалась вверх и первая реплика не подтверждена. ' +
            'Нельзя считать видимое окно полным чатом. Используйте ручные отметки начала и конца.'
          );
        }
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
        return { verified: true, source: 'upward-traversal-and-stability', observedUpwardTravel, stableChecks: confirmedIdle };
      }
    }

    throw new Error(
      fullCapture
        ? 'Не удалось подтвердить начало переписки в пределах навигационного окна.'
        : 'Не удалось надежно вернуть рабочую вкладку к началу.'
    );
  }

  async function reachResumeAnchor(anchorId, anchorSignature, tailSignatures, map, order, settings, { allowDownwardFallback = false } = {}) {
    if (!anchorId && !anchorSignature && !(tailSignatures || []).length) {
      throw new Error('У сохраненного архива нет якоря продолжения.');
    }

    const upwardStability = scrollRuntime().createStabilityState();

    for (let i = 0; i < 72; i++) {
      await waitIfPaused();

      if (await recoverVisibleLoadError('top', map.size)) {
        scrollRuntime().resetStabilityState(upwardStability);
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings);

      if (hasStableResumeAnchor(anchorId)) {
        await progress('Этап 1/3: найден конец сохраненного архива по стабильному ID · ' + map.size + ' сообщений в новом проходе', map.size, {
          phase: 'top',
          iteration: i + 1,
          anchorReached: true,
          anchorMatchLength: 1,
          force: true
        });
        return { id: anchorId, signature: anchorSignature, matchLength: 1 };
      }

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

      if (!(tailSignatures || []).filter(Boolean).length &&
          hasResumeAnchor('', anchorSignature)) {
        await progress('Этап 1/3: найден legacy-стык по одиночной сигнатуре · ' + map.size + ' сообщений в новом проходе', map.size, {
          phase: 'top',
          iteration: i + 1,
          anchorReached: true,
          anchorMatchLength: 1,
          force: true
        });
        return { id: '', signature: anchorSignature, matchLength: 1 };
      }

      const before = scrollObservation(map.size);
      await progress('Этап 1/3: ищу последний сохраненный стык · ' + map.size + ' сообщений', map.size, {
        phase: 'top',
        iteration: i + 1
      });

      await physicalScroll('up', 1);

      const after = scrollObservation(map.size);
      const stall = scrollRuntime().updateStabilityState(upwardStability, before, after, {
        requireFirstKey: true
      });
      if (stall.stable >= 2 && after.atStart) {
        if (allowDownwardFallback) break;
        throw new Error(
          'Сохранённый стык не найден после подтверждённого прохода до начала переписки.'
        );
      }
      if (stall.stable >= 5) {
        if (allowDownwardFallback) break;
        throw new Error(
          'Поиск сохранённого стыка остановился на неизменном участке до подтверждённого начала.'
        );
      }
    }

    if (allowDownwardFallback) {
      const downwardStability = scrollRuntime().createStabilityState();
      await progress('Стык не найден выше; проверяю участок ниже текущей позиции…', map.size, {
        phase: 'top',
        force: true
      });

      for (let i = 0; i < 260; i++) {
        await waitIfPaused();
        await expandVisible();
        if (settings.includeReasoning) await expandReasoningVisible();
        collect(map, order, settings);

        if (hasStableResumeAnchor(anchorId)) {
          await progress('Найдена сохранённая точка продолжения по стабильному ID.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            anchorMatchLength: 1,
            force: true
          });
          return { id: anchorId, signature: anchorSignature, matchLength: 1 };
        }

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

        if (!(tailSignatures || []).filter(Boolean).length &&
            hasResumeAnchor('', anchorSignature)) {
          await progress('Найдена legacy-точка продолжения по одиночной сигнатуре.', map.size, {
            phase: 'top',
            iteration: i + 1,
            anchorReached: true,
            anchorMatchLength: 1,
            force: true
          });
          return { id: '', signature: anchorSignature, matchLength: 1 };
        }

        const before = scrollObservation(map.size);
        await physicalScroll('down', 1);
        const after = scrollObservation(map.size);
        const stall = scrollRuntime().updateStabilityState(downwardStability, before, after, {
          requireLastKey: true
        });
        if (stall.stable >= 3 && after.atEnd) break;
        if (stall.stable >= 6) break;
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
        const bursts = 1;

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
      await physicalScroll(direction, 1);
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

  function checkpointDue(last, now, count, minInterval, minDelta, force = false) {
    if (force) return true;
    // A long logical message can occupy thousands of pixels with no count
    // increase. Either elapsed time OR new material must trigger persistence.
    const elapsed = now - Number(last?.at || 0);
    const grown = count - Number(last?.count || 0);
    return elapsed >= minInterval || grown >= minDelta;
  }

  let recoveryCheckpointWrite = Promise.resolve();
  // A periodic checkpoint and a pause snapshot must never overwrite one
  // another out of order. Serialize the actual storage operations.
  async function saveRecoveryCheckpoint(map, order, boundary, options = {}) {
    const jobId = state.jobId;
    const operation = recoveryCheckpointWrite.catch(() => {}).then(async () => {
      if (!jobId || jobId !== state.jobId) return;
      return persistRecoveryCheckpoint(map, order, boundary, options);
    });
    recoveryCheckpointWrite = operation.catch(() => {});
    return operation;
  }

  async function persistRecoveryCheckpoint(map, order, boundary, { force = false } = {}) {
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
    if (!checkpointDue(last, now, order.length, minInterval, minDelta, force)) return;

    const activeKey = state.queueCapture ? 'archiverQueueJob:' + jobId : 'activeCaptureJob';
    const current = (await chrome.storage.local.get(activeKey))[activeKey] || {};
    if (current.jobId !== jobId) return;
    // Image-only repair and resume navigation must not replace the canonical
    // chronological prefix with a transient, virtualized DOM window.
    if (current.captureMode === 'images-draft') return;
    if (['resume-draft', 'retry-walk'].includes(current.captureMode) &&
        current.phase === 'top') return;

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
      captureStartProof: state.captureStartProof || canonicalRecoveryDraft?.captureStartProof || null,
      pendingDocUrl: current.pendingDocUrl || '',
      pendingDocMode: current.pendingDocMode || '',
      partialSaveEnabled: Boolean(current.partialSaveEnabled),
      partialArchiveId: current.partialArchiveId || '',
      partialSavedAt: current.partialSavedAt || ''
    };

    // Never replace a longer verified saved prefix with a shorter transient
    // checkpoint. A resumed walk may only grow or enrich that prefix.
    const storedBeforeWrite = (await chrome.storage.local.get('draft:' + draftId))['draft:' + draftId];
    if (['resume-draft', 'retry-walk'].includes(current.captureMode) &&
        storedBeforeWrite?.messages?.length) {
      const oldPrefix = storedBeforeWrite.messages;
      // Length alone is insufficient: a same-sized unrelated window must
      // never masquerade as the saved chronological prefix.
      if (draft.messages.length < oldPrefix.length ||
          oldPrefix.some((oldMessage, index) =>
            !sameNavigationRef(navigationRef(oldMessage), navigationRef(draft.messages[index])))) {
        return;
      }
    }
    // Persist the large checkpoint independently. The background worker is
    // the sole writer of the active job: do not overwrite a newer state with
    // the copy read before storage I/O.
    await chrome.storage.local.set({ ['draft:' + draftId]: draft });
    await chrome.runtime.sendMessage({
      type: 'ARCHIVER_CHECKPOINT_SAVED',
      queueCapture: state.queueCapture,
      jobId,
      draftId,
      draftCount: messages.length
    }).catch(() => {});
    state.recoveryCheckpoint = { at: now, count: messages.length };
  }

  function visibleNavigationRefsLightweight() {
    return orderedTurns()
      .filter(turn => turnIntersectsCaptureViewport(turn))
      .map(turn => {
        const id = String(turnStableKey(turn) || '');
        return {
          id,
          strongId: isStrongMessageId(id) ? id : '',
          signature: String(turnTextSignature(turn) || '')
        };
      })
      .filter(ref => ref.strongId || ref.signature);
  }

  function navigationWindowsOverlap(a, b) {
    const left = (a || []).filter(ref => ref && (ref.strongId || ref.signature));
    const right = (b || []).filter(ref => ref && (ref.strongId || ref.signature));
    if (!left.length || !right.length) return false;

    // One immutable ChatGPT message ID is sufficient to prove identity.
    for (const x of left) {
      if (!x.strongId) continue;
      if (right.some(y => y.strongId && y.strongId === x.strongId)) return true;
    }

    // Text repeats can form convincing but false windows. Accept a weak
    // multi-turn sequence only when it has one placement in each viewport.
    // If both DOM turns carry distinct strong IDs, text equality is not proof.
    const weakCompatible = (x, y) => {
      if (x.strongId && y.strongId) return x.strongId === y.strongId;
      return Boolean(x.signature && y.signature && x.signature === y.signature);
    };
    // An A-B-A-B pattern can match as one four-turn window while its
    // underlying two-turn witness is repeated. Such weak evidence cannot
    // distinguish a stationary viewport from progress.
    const hasRepeatedWeakPair = refs => {
      const seen = new Set();
      for (let i = 0; i + 1 < refs.length; i++) {
        const a = refs[i], b = refs[i + 1];
        if (a.strongId || b.strongId || !a.signature || !b.signature) continue;
        const pair = JSON.stringify([a.signature, b.signature]);
        if (seen.has(pair)) return true;
        seen.add(pair);
      }
      return false;
    };
    if (hasRepeatedWeakPair(left) || hasRepeatedWeakPair(right)) return false;
    const maxLength = Math.min(6, left.length, right.length);
    for (let length = maxLength; length >= 2; length--) {
      const placements = [];
      for (let i = 0; i <= left.length - length; i++) {
        for (let j = 0; j <= right.length - length; j++) {
          let same = true;
          for (let offset = 0; offset < length; offset++) {
            if (!weakCompatible(left[i + offset], right[j + offset])) {
              same = false;
              break;
            }
          }
          if (same) placements.push([i, j]);
        }
      }
      if (placements.length === 1) return true;
      if (placements.length > 1) return false;
    }
    return false;
  }

  function sampleCaptureScroller() {
    const turn = orderedTurns().find(item => turnIntersectsCaptureViewport(item));
    if (!turn) return null;
    const scroller = findScrollContainer(turn);
    if (!scroller?.isConnected) return null;
    return {
      element: scroller,
      top: Number(scroller.scrollTop),
      clientHeight: Number(scroller.clientHeight),
      scrollHeight: Number(scroller.scrollHeight)
    };
  }

  function measuredAdjacentScroll(before, after, transport, maxPixels = Infinity) {
    // Long ChatGPT messages can occupy several viewports without adding a
    // new turn ID. 200px / 35%-viewport was too small for a real Chrome wheel
    // step and falsely treated same-scroller scrolling as a missing seam.
    //
    // A measured down-step shorter than 75% of BOTH scrollports guarantees
    // physical viewport overlap when the layout has not rebased. Only accept
    // it from the same container with nearly unchanged document geometry.
    // A renderer saying "moved: false" cannot override measured DOM movement:
    // the background SW and content script may have sampled different roots.
    if (!before?.element || !after?.element || before.element !== after.element) return false;
    if (transport?.direction !== 'down' || transport?.ok === false) return false;
    const delta = Number(after.top) - Number(before.top);
    const firstHeight = Number(before.clientHeight);
    const secondHeight = Number(after.clientHeight);
    const firstTotal = Number(before.scrollHeight);
    const secondTotal = Number(after.scrollHeight);
    if (![delta, firstHeight, secondHeight, firstTotal, secondTotal].every(Number.isFinite) ||
        firstHeight <= 0 || secondHeight <= 0 ||
        firstTotal <= firstHeight || secondTotal <= secondHeight) return false;
    const overlapLimit = Math.floor(Math.min(firstHeight, secondHeight) * 0.75);
    const stableHeight = Math.abs(secondTotal - firstTotal) <=
      Math.max(12, Math.floor(Math.min(firstHeight, secondHeight) * 0.06));
    return stableHeight && delta >= 2 && delta <=
      Math.min(Math.max(2, Number(maxPixels) || Infinity), overlapLimit);
  }

  function createContinuityWatchdog({
    maxSameFrontier = 2,
    maxRecoveriesWithoutAdvance = 6,
    maxStationarySteps = 8,
    maxRevisitedSteps = 24
  } = {}) {
    // A wheel delta is not necessarily *new* progress: recovering a missing
    // seam can move up and then traverse the exact same 120px section again.
    // Reset the retry budget only for a frontier never traversed before.
    const retries = new Map();
    const maxTopByScroller = new WeakMap();
    const seenStrongIds = new Set();
    let recoveriesWithoutAdvance = 0;
    let stationarySteps = 0;
    let revisitedSteps = 0;
    let forwardSteps = 0;
    let recoveryAttempts = 0;
    // Genuine scroll movement inside an already-seen message must not erase
    // the failed-seam budget. Only a NEW captured turn advances this frontier.
    let recoveryCountFrontier = null;
    let recoveriesAtSameCount = 0;
    const fingerprint = (sample, refs = []) => {
      const position = Number(sample?.top);
      const height = Number(sample?.scrollHeight);
      return JSON.stringify([
        Number.isFinite(position) ? Math.round(position / 10) : null,
        Number.isFinite(height) ? Math.round(height / 50) : null,
        (refs || []).map(ref => String(ref?.strongId || ref?.signature || '')).slice(0, 8)
      ]);
    };
    const rememberStrongRefs = refs => {
      for (const ref of refs || []) {
        const id = String(ref?.strongId || '');
        if (id) seenStrongIds.add(id);
      }
    };
    return {
      noteStep({ before, after, beforeRefs = [], afterRefs = [],
        adjacent = false, overlapping = false } = {}) {
        const sameScroller = Boolean(before?.element && before.element === after?.element);
        const beforeTop = Number(before?.top);
        const afterTop = Number(after?.top);
        const displacement = sameScroller ? afterTop - beforeTop : NaN;
        const physicalForward = Number.isFinite(displacement) && displacement >= 2 &&
          (adjacent || overlapping);

        // The high-water mark is local to the physical scroll container.
        // A repeated down-step below the maximum must NOT erase seam retries.
        let topBeyondFrontier = false;
        if (sameScroller && Number.isFinite(beforeTop) && Number.isFinite(afterTop) &&
            typeof after.element === 'object') {
          const highest = maxTopByScroller.has(after.element)
            ? maxTopByScroller.get(after.element)
            : beforeTop;
          topBeyondFrontier = afterTop >= highest + 2;
          if (afterTop > highest) maxTopByScroller.set(after.element, afterTop);
        }
        rememberStrongRefs(beforeRefs);
        const newStrongId = (afterRefs || []).some(ref => {
          const id = String(ref?.strongId || '');
          return id && !seenStrongIds.has(id);
        });
        rememberStrongRefs(afterRefs);

        // A truly new strong message in an adjacent/overlapping window is
        // evidence of progress even if virtualized scrollTop has rebased.
        const verifiedMovement = Boolean(physicalForward &&
          (topBeyondFrontier || newStrongId));

        if (verifiedMovement) {
          forwardSteps++;
          stationarySteps = 0;
          revisitedSteps = 0;
          recoveriesWithoutAdvance = 0;
          retries.clear();
        } else if (physicalForward) {
          revisitedSteps++;
          stationarySteps = 0;
        } else if (fingerprint(before, beforeRefs) === fingerprint(after, afterRefs)) {
          stationarySteps++;
        } else {
          stationarySteps = 0;
        }
        if (stationarySteps >= maxStationarySteps) {
          throw new Error(
            'Прокрутка не продвигается: восемь последовательных окон без нового ' +
            'физического положения или сообщения. Черновик сохранён вместо бесконечного прохода.'
          );
        }
        if (revisitedSteps >= maxRevisitedSteps) {
          throw new Error(
            'Архиватор снова проходит уже просмотренный участок, не достигая нового ' +
            'хронологического рубежа. Сбор остановлен с сохранением черновика.'
          );
        }
        return { forwardSteps, stationarySteps, revisitedSteps, verifiedMovement };
      },
      beforeRecovery(sample, refs, capturedCount = null) {
        // A large virtualized chat can repeatedly scroll down/up and keep
        // raising the pixel high-water mark while never capturing a new turn.
        // The older watchdog reset on each physical step, permitting hundreds
        // of retries. Count only recovered *message* frontiers here.
        if (Number.isFinite(Number(capturedCount)) && capturedCount != null) {
          const currentCount = Number(capturedCount);
          if (currentCount !== recoveryCountFrontier) {
            recoveryCountFrontier = currentCount;
            recoveriesAtSameCount = 0;
          }
          recoveriesAtSameCount++;
          if (recoveriesAtSameCount > 4) {
            throw new Error(
              'Повторяется поиск одного и того же стыка без новых сообщений (' +
              currentCount + '). Проход остановлен с сохранением черновика.'
            );
          }
        }
        rememberStrongRefs(refs);
        const key = fingerprint(sample, refs);
        const repeats = (retries.get(key) || 0) + 1;
        retries.set(key, repeats);
        recoveriesWithoutAdvance++;
        recoveryAttempts++;
        if (repeats > maxSameFrontier ||
            recoveriesWithoutAdvance > maxRecoveriesWithoutAdvance) {
          throw new Error(
            'Один и тот же стык сообщений повторно не подтверждается: ' +
            'физический проход остановлен без циклических возвращений. ' +
            'Неполный архив сохранён как черновик.'
          );
        }
        return { repeats, recoveriesWithoutAdvance, recoveryAttempts, forwardSteps };
      },
      metrics() {
        return {
          forwardSteps, stationarySteps, revisitedSteps,
          recoveryAttempts, recoveriesWithoutAdvance,
          recoveriesAtSameCount
        };
      }
    };
  }

  async function recoverDownwardContinuity(
    beforeRefs, afterRefs, originalAfter, map, order, settings, boundary
  ) {
    // Returning true just because an UP step rediscovered the old viewport
    // caused a down/up loop: the next pass crossed the *same* uncertified seam
    // again. Recovery must also re-traverse forward with small verified
    // overlapping steps, reaching the missed after-window before succeeding.
    const seenWindows = new Set();
    let originFound = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      await waitIfPaused();
      const currentRefs = visibleNavigationRefsLightweight();
      const sample = sampleCaptureScroller();
      const windowKey = JSON.stringify({
        top: sample?.top ?? null,
        refs: currentRefs.map(ref => [ref.strongId, ref.signature])
      });
      if (seenWindows.has(windowKey)) return false;
      seenWindows.add(windowKey);
      if (navigationWindowsOverlap(beforeRefs, currentRefs)) {
        originFound = true;
        break;
      }

      await progress(
        'Этап 2/3: стык не подтверждён; ищу предыдущий доказанный участок…',
        map.size, {
          phase: 'walk', continuityRecovery: true,
          continuityAttempt: attempt + 1,
          force: attempt === 0
        }
      );
      await physicalScroll('up', 1, {
        settleTimeout: 1800, quietWindow: 300, wheelDelta: 120
      });
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);
    }
    if (!originFound) return false;

    let lastRefs = visibleNavigationRefsLightweight();
    let lastSample = sampleCaptureScroller();
    let advanced = false;
    const replaySeen = new Set();
    for (let replay = 0; replay < 18; replay++) {
      await waitIfPaused();
      const key = JSON.stringify([lastSample?.top ?? null,
        lastRefs.map(ref => String(ref.strongId || ref.signature || ''))]);
      if (replaySeen.has(key)) return false;
      replaySeen.add(key);
      const step = await physicalScroll('down', 1, {
        settleTimeout: 1800, quietWindow: 300, wheelDelta: 80
      });
      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);
      const nextRefs = visibleNavigationRefsLightweight();
      const nextSample = sampleCaptureScroller();
      const adjacent = measuredAdjacentScroll(lastSample, nextSample, step);
      const overlap = navigationWindowsOverlap(lastRefs, nextRefs);
      // Neither a changed DOM shell nor a wheel request alone proves a
      // bridge. If the replay has a gap, preserve the draft and stop.
      if (!adjacent && !overlap) return false;
      const movedForward = Boolean(lastSample && nextSample &&
        lastSample.element === nextSample.element &&
        Number(nextSample.top) >= Number(lastSample.top) + 2);
      advanced = advanced || movedForward;
      const sameScrollContainer = Boolean(originalAfter?.element &&
        originalAfter.element === nextSample?.element);
      // An identical long message can appear hundreds of pixels before the
      // original failed after-window. Matching its ID is not enough to claim
      // that all intervening paragraphs and attachments were traversed.
      const reachedAfter = sameScrollContainer
        ? Number(nextSample.top) >= Number(originalAfter.top) - 2
        : navigationWindowsOverlap(afterRefs, nextRefs);
      if (advanced && reachedAfter) return true;
      if (!movedForward && !step?.moved) return false;
      lastRefs = nextRefs;
      lastSample = nextSample;
    }
    return false;
  }



  async function walkDownFullLegacy(map, order, settings, boundary) {
    let stable = 0;
    let previousSignature = '';
    let previousSize = -1;
    const watchdog = createContinuityWatchdog();
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

      // 0.3.87 invariant: capture the current viewport before every movement,
      // especially the first viewport at the confirmed top.
      collect(map, order, settings, boundary);
      const beforeRefs = visibleNavigationRefsLightweight();

      if (boundaryIsVisible(boundary)) {
        await progress('Этап 2/3: достигнута метка конца снимка · ' + map.size + ' сообщений', map.size, {
          phase: 'walk',
          iteration: i + 1,
          boundaryReached: true,
          chronologicalCount: map.size,
          force: true
        });
        await saveRecoveryCheckpoint(map, order, boundary, { force: true });
        return { boundaryReached: true, physicalEndReached: false };
      }

      const signature = visibleTurnSignature();
      await progress('Этап 2/3: физически прохожу вниз через debugger · ' + map.size + ' сообщений', map.size, {
        phase: 'walk',
        iteration: i + 1,
        chronologicalCount: map.size
      });
      await saveRecoveryCheckpoint(map, order, boundary);

      // Fast three-burst steps can jump past whole turns and are impossible
      // to certify with a virtualized ChatGPT DOM. Use the same short overlap-
      // preserving step as the marked-range traversal.
      const physicalBefore = sampleCaptureScroller();
      const wheel = await physicalScroll('down', 1, {
        wheelDelta: 120, settleTimeout: 1800, quietWindow: 300
      });

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      collect(map, order, settings, boundary);

      const afterRefs = visibleNavigationRefsLightweight();
      const physicalAfter = sampleCaptureScroller();
      const verifiedOverlap = navigationWindowsOverlap(beforeRefs, afterRefs);
      watchdog.noteStep({
        before: physicalBefore, after: physicalAfter, beforeRefs, afterRefs,
        overlapping: verifiedOverlap,
        adjacent: measuredAdjacentScroll(physicalBefore, physicalAfter, wheel)
      });
      if (!beforeRefs.length || !afterRefs.length || !verifiedOverlap) {
        const retry = watchdog.beforeRecovery(physicalBefore, beforeRefs, map.size);
        await progress(
          'Восстанавливаю стык: попытка ' + retry.recoveriesWithoutAdvance +
            ' без подтверждённого продвижения…',
          map.size, { phase: 'walk', continuityRecovery: true,
            continuityAttempt: retry.recoveryAttempts, force: true }
        );
        const recovered = await recoverDownwardContinuity(
          beforeRefs, afterRefs, physicalAfter, map, order, settings, boundary
        );
        if (!recovered) {
          throw new Error(
            'Хронологический debugger-проход потерял перекрытие между соседними участками. ' +
            'Сбор остановлен, чтобы не сохранить чат с пропуском.'
          );
        }

        stable = 0;
        previousSignature = '';
        previousSize = -1;
        await saveRecoveryCheckpoint(map, order, boundary);
        continue;
      }

if (boundaryIsVisible(boundary)) {
        await progress('Этап 2/3: достигнута метка конца снимка · ' + map.size + ' сообщений', map.size, {
          phase: 'walk',
          iteration: i + 1,
          boundaryReached: true,
          chronologicalCount: map.size,
          force: true
        });
        await saveRecoveryCheckpoint(map, order, boundary, { force: true });
        return { boundaryReached: true, physicalEndReached: false };
      }

            await saveRecoveryCheckpoint(map, order, boundary);

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

      if (stable >= 6) {
        throw new Error(
          'Хронологический debugger-проход остановился до зафиксированного конца снимка.'
        );
      }
    }

    throw new Error(
      'Не удалось дойти до зафиксированного конца снимка в пределах хронологического прохода.'
    );
  }

  async function walkDown(
    map,
    order,
    settings,
    boundary,
    {
      bursts = 1,
      requireBoundary = false,
      recoverLoadErrors = true,
      hydrateImages = false,
      hydrateVisibleImages = false,
      attemptedImageSources = new Map()
    } = {}
  ) {
    const stability = scrollRuntime().createStabilityState();
    const watchdog = createContinuityWatchdog();
    let physicalStepCount = 0;
    const startedAt = Date.now();
    const timeoutMs = 4 * 60 * 60 * 1000;

    for (let i = 0; Date.now() - startedAt < timeoutMs; i++) {
      await waitIfPaused();

      if (recoverLoadErrors && await recoverVisibleLoadError('walk', map.size)) {
        scrollRuntime().resetStabilityState(stability);
      }

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();

      // Always capture the current viewport before moving. This is especially
      // important for the very first viewport at the real top of the chat.
      const firstTouchedIds = collect(map, order, settings, boundary);
      if (hydrateImages) {
        await hydrateSequentialImages(
          firstTouchedIds.map(id => map.get(id)).filter(Boolean),
          attemptedImageSources,
          { visibleOnly: hydrateVisibleImages, walkStep: i }
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

      const physicalBefore = sampleCaptureScroller();
      const before = scrollObservation(map.size);
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
      const downwardStep = await physicalScroll('down', Math.max(1, Math.min(2, bursts)), {
        settleTimeout: 1800,
        quietWindow: 300,
        wheelDelta: 120
      });

      await expandVisible();
      if (settings.includeReasoning) await expandReasoningVisible();
      const secondTouchedIds = collect(map, order, settings, boundary);
      if (hydrateImages) {
        await hydrateSequentialImages(
          secondTouchedIds.map(id => map.get(id)).filter(Boolean),
          attemptedImageSources,
          { visibleOnly: hydrateVisibleImages, walkStep: i }
        );
      }

      const afterRefs = visibleNavigationRefsLightweight();
      const physicalAfter = sampleCaptureScroller();
      physicalStepCount += Number(Boolean(downwardStep?.moved));
      const physicalDelta = physicalBefore?.element === physicalAfter?.element
        ? Number(physicalAfter.top) - Number(physicalBefore.top)
        : null;
      if (physicalStepCount === 1 || physicalStepCount % 8 === 0) {
        await progress(
          'Этап 2/3: движение вниз · ' + map.size + ' сообщений · ' +
            physicalStepCount + ' шагов · позиция ' +
            (physicalAfter ? Math.round(physicalAfter.top) + ' px' : 'не определена'),
          map.size,
          {
            phase: 'walk',
            physicalStepCount,
            physicalScrollTop: physicalAfter?.top ?? null,
            physicalScrollHeight: physicalAfter?.scrollHeight ?? null,
            physicalScrollDelta: Number.isFinite(physicalDelta) ? physicalDelta : null,
            uniqueMessageCount: map.size,
            ...watchdog.metrics(),
            force: true
          }
        );
      }
      const overlapping = navigationWindowsOverlap(beforeRefs, afterRefs);
      const adjacent = measuredAdjacentScroll(
        physicalBefore, physicalAfter, downwardStep
      );
      const movement = watchdog.noteStep({
        before: physicalBefore, after: physicalAfter, beforeRefs, afterRefs,
        adjacent, overlapping
      });
      if (!overlapping && !adjacent) {
        const retry = watchdog.beforeRecovery(physicalBefore, beforeRefs, map.size);
        await progress(
          'Стык не подтверждён · попытка восстановления ' +
            retry.recoveriesWithoutAdvance +
            ' без проверенного движения вперёд…',
          map.size, {
            phase: 'walk', continuityRecovery: true,
            continuityAttempt: retry.recoveryAttempts,
            continuityFrontierRepeat: retry.repeats, force: true
          }
        );
        const recovered = await recoverDownwardContinuity(
          beforeRefs, afterRefs, physicalAfter, map, order, settings, boundary
        );
        if (!recovered) {
          throw new Error(
            'Хронологический проход потерял перекрытие между соседними участками. ' +
            'Сбор остановлен, чтобы не сохранить чат с пропуском.'
          );
        }

        scrollRuntime().resetStabilityState(stability);
        await saveRecoveryCheckpoint(map, order, boundary);
        continue;
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

            await saveRecoveryCheckpoint(map, order, boundary);

      const after = scrollObservation(map.size);
      // No new message text is expected while crossing a 20-screen turn.
      // Only a non-moving viewport contributes to the stall counter.
      const physicallyAdvanced = measuredAdjacentScroll(
        physicalBefore, physicalAfter, downwardStep
      );
      if (physicallyAdvanced) scrollRuntime().resetStabilityState(stability);
      const stall = physicallyAdvanced
        ? { stable: 0 }
        : scrollRuntime().updateStabilityState(stability, before, after);

      if (stall.stable >= 3 && after.atEnd) {
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

      if (stall.stable >= 6) {
        throw new Error(
          'Хронологический проход остановился до зафиксированного конца снимка.'
        );
      }
    }

    throw new Error(
      'Не удалось дойти до зафиксированного конца снимка за четыре часа непрерывного прохода.'
    );
  }

  function chooseAutomaticSplitMiddle(witnesses = []) {
    // The planner has physically traversed start -> end. Select a real
    // central turn whose immediate neighbours also carry immutable IDs.
    // Never invent an index-based marker for a virtualized conversation.
    if (witnesses.length < 5) {
      throw new Error('Для разделения недостаточно проверенных сообщений между началом и концом.');
    }
    const middle = (witnesses.length - 1) / 2;
    const candidates = [];
    for (let i = 2; i < witnesses.length - 2; i++) {
      const [previous, center, next] = witnesses.slice(i - 1, i + 2);
      if ([previous, center, next].every(item => isStrongMessageId(item.id)) &&
          new Set([previous.id, center.id, next.id]).size === 3) {
        candidates.push({ i, center, previous, next });
      }
    }
    if (!candidates.length) {
      throw new Error(
        'Не найдена безопасная середина с устойчивыми ID соседних реплик. ' +
        'Исходные границы сохранены; объединение не выполнялось.'
      );
    }
    candidates.sort((a, b) => Math.abs(a.i - middle) - Math.abs(b.i - middle));
    const chosen = candidates[0];
    return { ...chosen.center,
      previous: chosen.previous, next: chosen.next };
  }

  async function planAutomaticSplit(jobId, captureRange) {
    if (state.running) throw new Error('Вкладка уже выполняет другой сбор.');
    const start = captureRange?.start;
    const end = captureRange?.end;
    if (!isStrongMessageId(start?.id) || !isStrongMessageId(end?.id) ||
        start.id === end.id) {
      throw new Error('Для автоматического разделения нужны две разные отметки с устойчивыми ID.');
    }
    state.running = true;
    state.jobId = jobId;
    state.queueCapture = true;
    state.cancel = false;
    state.paused = false;
    state.pauseSnapshotWriter = null;
    state.captureStartProof = null;
    state.boundarySearchActive = true;
    try {
      await progress('Ищу начало выбранного диапазона для расчёта середины…', 0,
        { phase: 'boundary', force: true });
      await waitForTurns(10000);
      await seekQueueMarkedStart(start);
      if (!orderedTurns().some(turn =>
        turnStableKey(turn) === start.id && turnIntersectsCaptureViewport(turn))) {
        throw new Error('Не удалось подтвердить отмеченное начало диапазона.');
      }

      const witnesses = [];
      const seen = new Set();
      let started = false;
      const watchdog = createContinuityWatchdog();
      const deadline = Date.now() + 90 * 60 * 1000;
      let reachedEnd = false;

      const addWindow = () => {
        for (const turn of orderedTurns()) {
          // A virtualized ChatGPT page may retain offscreen DOM shells. They
          // are not evidence of a physically traversed chronological window.
          if (!turnIntersectsCaptureViewport(turn)) continue;
          const id = turnStableKey(turn);
          if (!started) {
            if (id !== start.id) continue;
            started = true;
          }
          if (!id) continue;
          // Once the immutable end is encountered, turns after it can never
          // become evidence for selecting the middle of the user's range.
          if (!seen.has(id)) {
            seen.add(id);
            witnesses.push({
              id, role: roleOf(turn) || '',
              signature: turnTextSignature(turn)
            });
          }
          if (id === end.id) break;
        }
      };

      for (let step = 0; step < 22000 && Date.now() < deadline; step++) {
        await waitIfPaused();
        addWindow();
        if (seen.has(end.id) && boundaryIsVisible({
          kind: 'stable', key: end.id, strictStable: true
        })) {
          reachedEnd = true;
          break;
        }
        if (step === 0 || step % 24 === 0) {
          await progress('Автоматически определяю середину между двумя отметками · ' +
            witnesses.length + ' видимых реплик · шаг ' + (step + 1),
            witnesses.length, { phase: 'boundary', force: true });
        }
        const before = sampleCaptureScroller();
        const beforeRefs = visibleNavigationRefsLightweight();
        const movement = await physicalScroll('down', 1, {
          wheelDelta: 120, settleTimeout: 1600, quietWindow: 260
        });
        const after = sampleCaptureScroller();
        const afterRefs = visibleNavigationRefsLightweight();
        const overlapping = navigationWindowsOverlap(beforeRefs, afterRefs);
        const adjacent = measuredAdjacentScroll(before, after, movement);
        watchdog.noteStep({ before, after, beforeRefs, afterRefs,
          overlapping, adjacent });
        if (!overlapping && !adjacent) {
          watchdog.beforeRecovery(before, beforeRefs, witnesses.length);
          throw new Error('Предварительный проход потерял непрерывность. ' +
            'Нельзя выбирать середину по неполному диапазону.');
        }
        if (!movement.moved && physicalScrollEndVisible() && !seen.has(end.id)) {
          throw new Error('Достигнут конец чата, но отмеченный конец диапазона не найден.');
        }
      }
      if (!reachedEnd || witnesses[0]?.id !== start.id ||
          witnesses[witnesses.length - 1]?.id !== end.id) {
        throw new Error('Начало и конец диапазона не подтверждены одним непрерывным проходом.');
      }
      const middle = chooseAutomaticSplitMiddle(witnesses);
      const reply = await chrome.runtime.sendMessage({
        type: 'ARCHIVER_SPLIT_PLAN_READY',
        queueCapture: true,
        jobId,
        middle,
        startId: start.id,
        endId: end.id,
        visitedCount: witnesses.length
      });
      if (!reply?.ok) throw new Error(reply?.error ||
        'Фоновый диспетчер не подтвердил автоматическую середину.');
    } catch (error) {
      await chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_FAILED',
        queueCapture: true,
        jobId,
        error: error?.message || String(error)
      }).catch(() => {});
    } finally {
      state.running = false;
      state.paused = false;
      state.cancel = false;
      state.queueCapture = false;
      state.jobId = null;
      state.boundarySearchActive = false;
    }
  }

  async function seekQueueMarkedStart(marker) {
    if (!marker?.id || !isStrongMessageId(marker.id)) {
      throw new Error('Экспериментальному потоку нужна устойчивая начальная отметка.');
    }
    const visible = () => orderedTurns().some(turn =>
      turnStableKey(turn) === marker.id && turnIntersectsCaptureViewport(turn)
    );
    if (visible()) return;
    const deadline = Date.now() + 4 * 60 * 60 * 1000;
    for (const direction of ['up', 'down']) {
      let atEdge = 0;
      for (let step = 0; step < 20000 && Date.now() < deadline; step++) {
        await waitIfPaused();
        if (visible()) return;
        if (step === 0 || step % 24 === 0) {
          await progress('Экспериментальный поток: ищу отмеченное начало · ' +
            direction + ' · шаг ' + (step + 1), 0,
            { phase: 'boundary', force: true });
        }
        const before = sampleCaptureScroller();
        const movement = await physicalScroll(direction, 1, {
          wheelDelta: 120, settleTimeout: 1800, quietWindow: 260
        });
        if (visible()) return;
        const after = sampleCaptureScroller();
        const edge = direction === 'up'
          ? physicalScrollStartVisible() : physicalScrollEndVisible();
        const unchanged = before?.element === after?.element &&
          Number(before.top) === Number(after.top);
        if (edge && unchanged && !movement.moved) atEdge++;
        else atEdge = 0;
        if (atEdge >= 3) break;
      }
    }
    throw new Error(
      'Не удалось физически найти начальную отметку экспериментального потока. ' +
      'Чужие сообщения не будут включены в архив.'
    );
  }

  async function captureConversation(jobId, options = {}) {
    if (state.running) return;
    state.running = true;
    // Remove our marker controls before any message signatures or text are read.
    document.querySelectorAll('.archiver-fragment-buttons').forEach(node => node.remove());
    state.jobId = jobId;
    state.queueCapture = Boolean(options.queueCapture);
    state.cancel = false;
    state.paused = false;
    state.pauseSnapshotWriter = null;
    state.captureStartProof = null;
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
    let verifiedSnapshotEnd = null;
    let verifiedFullStart = null;
    let verifiedMarkedStart = false;
    let navigationHighWater = 0;
    let navigationFirstId = '';
    let navigationFirstSignature = '';
    let navigationMessages = [];
    let navigationSequence = [];
    let firstPassCount = 0;
    let secondPassCount = 0;
    const sequentialImageSources = new Map();
    let matchedAnchorId = resumeAnchorId;
    let matchedAnchorSignature = resumeAnchorSignature;

    try {
      const settings = await getSettings();
      const resumedDraft = (mode === 'resume-draft' && existingDraftId)
        ? (await chrome.storage.local.get('draft:' + existingDraftId))['draft:' + existingDraftId]
        : null;
      if (resumedDraft?.captureStartProof?.startVerified) {
        state.captureStartProof = { ...resumedDraft.captureStartProof };
      }
      // Manual markers are the capture transport for the primary chat archive.
      // They do not change the archive's canonical identity.
      const manuallyBounded = mode === 'fragment' || Boolean(
        resumedDraft?.captureMode === 'fragment' &&
        resumedDraft?.captureRange?.start && resumedDraft?.captureRange?.end
      );
      const resumeNavigation = Boolean(options.resumeNavigation && existingDraftId);
      const selectedFragment = (mode === 'fragment')
        ? (options.captureRange ||
          (await chrome.storage.local.get(fragmentStorageKey()))[fragmentStorageKey()] ||
          {})
        : null;
      if (mode === 'fragment' && (!selectedFragment.start || !selectedFragment.end)) {
        throw new Error('Для ручного диапазона отметьте и начало, и конец.');
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

      let turns = await waitForTurns(10000);
      if (!turns.length) {
        const roleCount = document.querySelectorAll(ROLE_SELECTOR).length;
        const shellCount = document.querySelectorAll(TURN_SHELL_SELECTOR).length;
        throw new Error(`Не удалось найти реплики ChatGPT. role-узлов: ${roleCount}, оболочек: ${shellCount}. Возможно, интерфейс еще загружается или ChatGPT изменил DOM.`);
      }

      // Auto/full mode must first navigate to the real end. The final turn
      // of an arbitrary initial viewport is not a snapshot boundary.
      // Manual end/start marking bypasses this navigation entirely.
      if (mode === 'full') {
        verifiedSnapshotEnd = await reachSnapshotEndWithoutCapture();
        turns = await waitForTurns(10000);
        if (!turns.length) throw new Error('Реплики исчезли при проверке конца переписки.');
      }

      const markerEnd = (mode === 'fragment') && selectedFragment.end
        ? {
            kind: isStrongMessageId(selectedFragment.end.id) ? 'stable' : 'signature',
            key: isStrongMessageId(selectedFragment.end.id)
              ? selectedFragment.end.id : selectedFragment.end.signature,
            role: selectedFragment.end.role || '',
            signature: selectedFragment.end.signature || '',
            contextBefore: selectedFragment.end.contextBefore || [],
            strictStable: isStrongMessageId(selectedFragment.end.id)
          }
        : null;
      const boundary = markerEnd || fixedCaptureBoundary || makeCaptureBoundary(turns);
      if (!boundary) throw new Error('Не удалось зафиксировать конец снимка переписки.');
      // Write the exact accumulated work to disk before acknowledging Pause.
      state.pauseSnapshotWriter = () => saveRecoveryCheckpoint(
        map, order, boundary, { force: true }
      );

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
          // Restore the 0.3.87 fast path: full capture must not parse/store the
          // conversation while travelling upward. The upward phase is navigation
          // only; the canonical archive is built once, chronologically, after
          // the real top is confirmed.
          map.clear();
          order.length = 0;
          verifiedFullStart = await reachTopWithoutCapture(0, {
            fullCapture: true,
            timeoutMs: 20 * 60 * 1000
          });
        } else if (mode === 'fragment') {
          if (options.seekMarkedStart) {
            // Both a single background copy and a queued lane must locate
            // the same immutable user mark without requiring that the user
            // keeps the source tab visible.
            await seekQueueMarkedStart(selectedFragment.start);
          }
          // Manual range is authoritative. Do not search upward or visit the
          // lower boundary first. The user positions the current tab at the
          // marked start; collection then moves only downward to the marked end.
          const visibleStart = orderedTurns().find(turn => {
            const anchor = fragmentAnchor(turn);
            return anchor && turnIntersectsCaptureViewport(turn) &&
              markerIdentityMatches(selectedFragment.start, anchor);
          });
          if (!visibleStart) {
            throw new Error(
              'Отмеченное начало не найдено в рабочей вкладке. Диапазон не был сохранён с пропуском.'
            );
          }
          verifiedMarkedStart = true;

          map.clear();
          order.length = 0;
          navigationMessages = [];
          navigationSequence = [];
          navigationHighWater = 0;

          await progress(
            'Начало диапазона видно · собираю только вниз до отмеченного конца…',
            0,
            {
              phase: 'walk',
              navigationOnly: true,
              manualRange: true,
              force: true
            }
          );
        } else {
          if (boundary && !boundaryIsVisible(boundary)) {
            await locateBoundaryForUpwardScan(boundary);
          }
          map.clear();
          order.length = 0;
          await reachTop(
            map,
            order,
            settings,
            navigationWindows,
            null,
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

      if (mode === 'full') {
        navigationHighWater = 0;
        navigationMessages = [];
        navigationSequence = [];
        firstPassCount = 0;
        secondPassCount = 0;
        await progress(
          'Этап 1/3: начало подтверждено · начинаю сохранение сверху вниз',
          map.size,
          {
            phase: 'top',
            navigationOnly: true,
            force: true
          }
        );
      } else if (mode === 'images' || mode === 'images-draft' || mode === 'reconcile') {
        navigationHighWater = map.size;
        const firstAtTop = orderedTurns()[0] || null;
        navigationFirstId = firstAtTop ? turnStableKey(firstAtTop) : '';
        navigationFirstSignature = firstAtTop ? turnTextSignature(firstAtTop) : '';
        await progress(
          'Этап 1/3: начало подтверждено · навигационный минимум ' + navigationHighWater + ' сообщений',
          navigationHighWater,
          {
            phase: 'top',
            navigationHighWater,
            navigationOnly: false,
            force: true
          }
        );
      }

      // Once the original start was proved, persist its evidence in every
      // checkpoint. A resumed run may never infer completeness merely because
      // its new walk reached the end.
      if (mode === 'full' && verifiedFullStart?.verified && verifiedSnapshotEnd?.verified) {
        state.captureStartProof = {
          mode: 'full', startVerified: true,
          startSource: verifiedFullStart.source || '',
          snapshotEndVerified: true,
          startTravelObserved: Boolean(verifiedFullStart.observedUpwardTravel),
          startStableChecks: Number(verifiedFullStart.stableChecks || 0)
        };
      } else if (mode === 'fragment' && verifiedMarkedStart) {
        state.captureStartProof = {
          mode: 'fragment', startVerified: true,
          startSource: 'user-marked-start',
          markedStartId: selectedFragment.start.id,
          markedEndId: selectedFragment.end.id,
          snapshotEndVerified: true
        };
      }

      map.clear();
      order.length = 0;
      chronologicalStarted = true;

      const resumedQueueMode = state.queueCapture && mode === 'resume-draft'
        ? resumedDraft?.captureMode || '' : '';
      const queueFragmentResume = resumedQueueMode === 'fragment';
      const walkResult = mode === 'full'
        ? await walkDownFullLegacy(map, order, settings, boundary)
        : await walkDown(map, order, settings, boundary, {
            bursts: 1,
            requireBoundary: mode === 'fragment' || queueFragmentResume,
            recoverLoadErrors: mode !== 'fragment' && !queueFragmentResume,
            hydrateImages: queueFragmentResume || mode === 'fragment' ||
              mode === 'reconcile' || mode === 'images' || mode === 'images-draft',
            hydrateVisibleImages: queueFragmentResume || mode === 'fragment',
            attemptedImageSources: sequentialImageSources
          });

      if (mode === 'full' &&
          (!verifiedSnapshotEnd?.verified || !verifiedFullStart?.verified ||
           !walkResult?.boundaryReached)) {
        throw new Error(
          'Полный архив не сохранён: начало и конец переписки не подтверждены независимо.'
        );
      }
      if (mode === 'fragment' &&
          (!verifiedMarkedStart || !walkResult?.boundaryReached)) {
        throw new Error(
          'Архив по отметкам не сохранён: не удалось подтвердить обе границы диапазона.'
        );
      }

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
      const rawCollectedCount = capturedMessages.length;
      let trimmedBeforeMarkedStart = 0;
      if (mode === 'fragment') {
        const markedStart = trimMessagesFromMarkedStart(capturedMessages, selectedFragment?.start);
        if (!markedStart.found) {
          throw new Error(
            'Отмеченное начало не удалось однозначно найти в итоговой последовательности. ' +
            'Архив не сохранён, чтобы не включить сообщения до диапазона.'
          );
        }
        trimmedBeforeMarkedStart = markedStart.trimmed;
        capturedMessages = markedStart.messages;
      }
      const bounded = trimMessagesThroughBoundary(capturedMessages, boundary);
      // Text-changing operations must stop at the snapshot boundary that was
      // fixed when the run started. Reaching the live physical bottom is not
      // equivalent: new turns may have appeared while a long capture was running.
      // Read-only comparison and image-only recovery may safely accept the live
      // bottom because they do not append unbounded text to the canonical archive.
      const acceptedPhysicalEnd = Boolean(
        ['compare', 'images'].includes(mode) &&
        !bounded.found &&
        walkResult?.physicalEndReached
      );
      if (!bounded.found && !acceptedPhysicalEnd) {
        throw new Error('Метка конца снимка не найдена в итоговом проходе. Архив не сохранён, чтобы не смешать сообщения, появившиеся после запуска.');
      }
      capturedMessages = bounded.found ? bounded.messages : capturedMessages;
      if (mode === 'fragment') {
        // Persist numerical provenance of any count shrinkage. This makes a
        // 7-to-1 transition diagnosable without retaining private message text.
        await progress(
          'Этап 3/3: границы сверены · ' + capturedMessages.length +
            ' сообщений из ' + rawCollectedCount + ' собранных…',
          capturedMessages.length,
          {
            phase: 'finalizing',
            captureMode: mode,
            rawCollectedCount,
            trimmedBeforeMarkedStart,
            trimmedAfterMarkedEnd: bounded.trimmed || 0,
            force: true
          }
        );
      }

      if (mode === 'images' || mode === 'images-draft' || mode === 'reconcile') {
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
        rebuildCaptureMap(map, order, capturedMessages);

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

        if (mode === 'reconcile' || mode === 'images-draft' || mode === 'fragment') {
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
        const locatedAnchor = locateCapturedResumeAnchor(capturedMessages, {
          anchorId: matchedAnchorId,
          anchorSignature: matchedAnchorSignature,
          tailSignatures: resumeTailSignatures
        });

        if (locatedAnchor.index < 0) {
          throw new Error(
            locatedAnchor.ambiguous
              ? 'Точка продолжения встречается в итоговом проходе неоднозначно. ' +
                'Продолжение остановлено без слияния, чтобы не выбрать не тот повторяющийся участок.'
              : 'Точка продолжения была найдена при навигации, но не подтверждена в итоговом хронологическом проходе. ' +
                'Продолжение остановлено без слияния, чтобы не добавить старые сообщения повторно.'
          );
        }

        capturedMessages = capturedMessages.slice(locatedAnchor.index + 1);
      }

      if (mode === 'fragment') {
        const startMatches = selectedFragment.start
          ? capturedMessages.flatMap((item, i) =>
              anchorMatches(item, selectedFragment.start, capturedMessages, i) ? [i] : [])
          : [0];
        const endMatches = selectedFragment.end
          ? capturedMessages.flatMap((item, i) =>
              anchorMatches(item, selectedFragment.end, capturedMessages, i) ? [i] : [])
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
      const archiveId = existingArchiveId || (String(Date.now()) + '-' + hashText(location.href) +
        (state.queueCapture ? '-q-' + jobId : ''));
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
          // The chronological pass has already been sliced strictly after the
          // proven resume anchor. Text equality is not evidence of duplication:
          // users and ChatGPT can legitimately repeat the same message later.
          // Only a stable ID can prove that a captured turn is already present.
          const existingIds = new Set(existing.messages.map(messageStrongId).filter(Boolean));
          const delta = capturedMessages.filter(item =>
            !(messageStrongId(item) && existingIds.has(messageStrongId(item)))
          );

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
        const scanPool = buildImageScanPool([
          ...navigationMessages,
          ...capturedMessages
        ]);

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
        for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
          const message = messages[messageIndex];
          const previousIndex = findContextualMessageIndex(
            existing.messages || [],
            message,
            messages,
            messageIndex
          );
          const previous = previousIndex >= 0
            ? existing.messages[previousIndex]
            : null;
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
        const scanPool = buildImageScanPool([
          ...navigationMessages,
          ...capturedMessages
        ]);

        const merged = mergeRecoveredImagesIntoArchive(existing.messages, scanPool);
        messages = merged.messages;
        recoveredImageRefs = merged.recovered;
        addedCount = 0;
      } else if (mode !== 'full' && mode !== 'fragment' && existingArchiveId) {
        const stored = await chrome.storage.local.get('archive:' + existingArchiveId);
        const existing = stored['archive:' + existingArchiveId];
        if (!existing?.messages) throw new Error('Локальный архив для продолжения недоступен.');

        previousCount = existing.messages.length;
        // capturedMessages is already the proven chronological suffix after
        // the saved anchor. Do not deduplicate by text signature: a later turn
        // may intentionally repeat an earlier one. Stable IDs are the only
        // safe cross-boundary duplicate filter here.
        const existingIds = new Set(existing.messages.map(messageStrongId).filter(Boolean));
        const delta = capturedMessages.filter(item =>
          !(messageStrongId(item) && existingIds.has(messageStrongId(item)))
        );

        addedCount = delta.length;
        messages = existing.messages.concat(delta);
      }

      if (state.queueCapture && mode === 'resume-draft' &&
          resumedDraft?.captureMode === 'fragment') {
        const selected = resumedDraft.captureRange || {};
        const startId = String(selected.start?.id || '');
        const endId = String(selected.end?.id || '');
        const starts = messages.flatMap((message, i) =>
          message.id === startId ? [i] : []);
        const ends = messages.flatMap((message, i) =>
          message.id === endId ? [i] : []);
        if (!isStrongMessageId(startId) || !isStrongMessageId(endId) ||
            starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
          throw new Error(
            'После восстановления не удалось доказать исходные начало и конец ' +
            'ручного диапазона. Исходные черновики сохранены отдельно.'
          );
        }
        messages = messages.slice(starts[0], ends[0] + 1);
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
            queueCapture: state.queueCapture,
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
        onlyMissing: mode === 'full' || mode === 'fragment' || mode === 'images' || mode === 'images-draft' || mode === 'reconcile'
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
            queueCapture: state.queueCapture,
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
        firstPassCount: undefined,
        secondPassCount: undefined,
        passCountMatch: undefined,
        isFragment: false,
        manualRangeMarkers: manuallyBounded ? (selectedFragment || resumedDraft?.captureRange) : undefined,
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
        captureEndedAtPhysicalBottom: Boolean(acceptedPhysicalEnd),
        captureProof: (mode === 'full' || mode === 'fragment' ||
          (state.queueCapture && mode === 'resume-draft' &&
            ['full', 'fragment'].includes(resumedDraft?.captureMode))) ? {
          mode: state.queueCapture && mode === 'resume-draft'
            ? resumedDraft.captureMode : mode,
          startVerified: Boolean(state.captureStartProof?.startVerified),
          endVerified: Boolean(bounded.found && walkResult?.boundaryReached &&
            ((state.queueCapture && mode === 'resume-draft')
              ? state.captureStartProof?.snapshotEndVerified
              : (mode === 'fragment' || verifiedSnapshotEnd?.verified))),
          startSource: state.captureStartProof?.startSource || '',
          startTravelObserved: Boolean(state.captureStartProof?.startTravelObserved),
          startStableChecks: Number(state.captureStartProof?.startStableChecks || 0),
          endSource: (mode === 'fragment' || resumedDraft?.captureMode === 'fragment')
            ? 'user-marked-end' : (verifiedSnapshotEnd?.source || 'saved-snapshot-end')
        } : undefined
      };

      // Image hydration can be complete while the popup still reads 2/2.
      // Split write and worker-ack into distinct, observable stages.
      await progress(
        'Этап 3/3: изображения обработаны · записываю локальный архив…',
        messages.length,
        {
          phase: 'finalizing',
          finalizationStep: 'write-archive',
          imageBinaryProcessed: binaryStats.unique,
          imageBinaryTotal: binaryStats.unique,
          imageBinaryReady: conversation.imageBinaryReady,
          imageBinaryFailed: conversation.imageBinaryFailed,
          force: true
        }
      );
      // Only the worker may publish lastArchiveId after it validates the
      // result. Keep a rejected archive under its private key for recovery.
      await withCaptureOperationTimeout(
        chrome.storage.local.set({
          ['archive:' + archiveId]: Object.assign({}, conversation, { id: archiveId })
        }),
        30000,
        'Запись локального архива'
      );
      await progress(
        'Этап 3/3: локальная запись завершена · подтверждаю архив…',
        messages.length,
        { phase: 'finalizing', finalizationStep: 'confirm-complete', force: true }
      );
      const completionRequest = chrome.runtime.sendMessage({
        type: 'ARCHIVER_CAPTURE_COMPLETE',
        queueCapture: state.queueCapture,
        jobId,
        archiveId,
        count: messages.length,
        addedCount,
        imageRecoveredCount: recoveredImageRefs.length,
        mode
      });
      const completion = ['fragment', 'full'].includes(mode)
        ? await withCaptureOperationTimeout(
            completionRequest, 90000, 'Подтверждение полного архива'
          )
        : await completionRequest;
      if (!completion?.ok || completion.status !== 'done') {
        throw new Error(
          'Фоновый процесс не подтвердил завершение: ' +
          (completion?.error || completion?.status || 'нет ответа') +
          '. Сохранённая часть остаётся доступной для восстановления.'
        );
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const status = /отменен/i.test(message) ? 'cancelled' : 'error';
      // Write the primary failure before salvage: follow-up storage work or
      // background messaging may fail, but the original cause must survive.
      await chrome.storage.local.set({ ['archiverCaptureFailure:' + jobId]: {
        jobId, message, phase: chronologicalStarted ? 'walk' : 'top',
        capturedCount: map.size, occurredAt: Date.now()
      } }).catch(() => {});
      const activeKey = state.queueCapture ? 'archiverQueueJob:' + jobId : 'activeCaptureJob';
      const current = (await chrome.storage.local.get(activeKey))[activeKey] || {};

      let draftId = '';
      let draftCount = 0;
      // If the worker already rejected this candidate into a dedicated
      // recoverable draft, don't overwrite its verified image/text snapshot
      // with an older DOM map when the acknowledgement returns as an error.
      if (current.status === 'error' && current.draftId) {
        const key = 'draft:' + current.draftId;
        const saved = (await chrome.storage.local.get(key))[key];
        if (saved?.recoveredFromArchiveId && saved.messages?.length) {
          draftId = current.draftId;
          draftCount = saved.messages.length;
        }
      }

      // Image recovery is additive and safe to persist incrementally. If a full
      // image pass fails after finding some lazy-loaded images, merge and embed
      // what was already discovered instead of throwing all that work away.
      if (mode === 'images' && existingArchiveId && status !== 'cancelled') {
        try {
          const storedArchive = await chrome.storage.local.get('archive:' + existingArchiveId);
          const existingArchive = storedArchive['archive:' + existingArchiveId];
          if (existingArchive?.messages?.length) {
            const partialScan = buildImageScanPool([
              ...navigationMessages,
              ...order.map(id => map.get(id)).filter(Boolean)
            ]);

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

      if (!draftId && mode !== 'images-draft' &&
          (chronologicalStarted || current.phase === 'top') &&
          (map.size > 0 ||
            (['resume-draft', 'retry-walk'].includes(mode) && Boolean(existingDraftId)))) {
        let draftMessages = order.map(id => map.get(id)).filter(Boolean);

        let existingRecoveryDraft = null;
        if ((mode === 'resume-draft' || mode === 'retry-walk') && existingDraftId) {
          const stored = await chrome.storage.local.get('draft:' + existingDraftId);
          const existing = stored['draft:' + existingDraftId];
          existingRecoveryDraft = existing || null;
          if (existing?.messages?.length) {
            if (mode === 'retry-walk') {
              // retry-walk starts again from the real top. Never append that
              // fresh prefix after the old prefix. Only merge two prefixes when
              // their complete overlap is proven in the same order.
              const overlap = Math.min(existing.messages.length, draftMessages.length);
              const compatible = overlap > 0 && Array.from({ length: overlap }, (_, i) => i)
                .every(i => sameNavigationRef(
                  navigationRef(existing.messages[i]),
                  navigationRef(draftMessages[i])
                ));

              if (compatible) {
                const spine = draftMessages.length > existing.messages.length
                  ? draftMessages
                  : existing.messages;
                draftMessages = spine.map((message, index) => {
                  const oldMessage = existing.messages[index];
                  const newMessage = draftMessages[index];
                  if (!oldMessage || !newMessage ||
                      !sameNavigationRef(navigationRef(oldMessage), navigationRef(newMessage))) {
                    return message;
                  }
                  return mergeRicherCapture(newMessage, oldMessage);
                });
              } else {
                // Divergent retry evidence is not safe to synthesize. Preserve
                // the last canonical saved prefix and let the next retry start
                // from that known state.
                draftMessages = existing.messages;
              }
            } else {
              // resume-draft starts after a proven anchor. Repeated text is valid
              // new content; only stable IDs may prove an overlap with the old
              // saved prefix.
              const seenIds = new Set(existing.messages.map(messageStrongId).filter(Boolean));
              const delta = draftMessages.filter(item => {
                const strongId = messageStrongId(item);
                return !(strongId && seenIds.has(strongId));
              });
              const refreshed = existing.messages.map((previous, previousIndex) => {
                const newerIndex = findContextualMessageIndex(
                  draftMessages,
                  previous,
                  existing.messages,
                  previousIndex
                );
                const newer = newerIndex >= 0 ? draftMessages[newerIndex] : null;
                return newer ? mergeRicherCapture(newer, previous) : previous;
              });
              draftMessages = refreshed.concat(delta);
            }
          }
        }

        if (draftMessages.length) {
          // Error recovery must persist the collected text immediately.
          // Retry missing binaries only through explicit image recovery; a
          // failed network path must not delay or defeat saving the draft.
          // A resumed capture continues one logical unfinished pass. Reuse the
          // canonical draft ID instead of exposing every retry as a new draft.
          draftId = (['resume-draft', 'retry-walk'].includes(mode) && existingRecoveryDraft?.id)
            ? existingRecoveryDraft.id
            : (current.draftId || existingDraftId || current.recoveryDraftId || ('draft-' + jobId));
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
            captureStartProof: state.captureStartProof || existingRecoveryDraft?.captureStartProof || null,
            pendingDocUrl: existingRecoveryDraft?.pendingDocUrl || current.pendingDocUrl || '',
            pendingDocMode: existingRecoveryDraft?.pendingDocMode || current.pendingDocMode || '',
            complete: false,
            error: message,
            partialSaveEnabled: Boolean(existingRecoveryDraft?.partialSaveEnabled || current.partialSaveEnabled),
            partialArchiveId: existingRecoveryDraft?.partialArchiveId || current.partialArchiveId || '',
            partialSavedAt: existingRecoveryDraft?.partialSavedAt || ''
          };
          const previousCheckpoint = (await chrome.storage.local.get('draft:' + draftId))['draft:' + draftId];
          if (['resume-draft', 'retry-walk'].includes(mode) &&
              previousCheckpoint?.messages?.length > draft.messages.length) {
            draftCount = previousCheckpoint.messages.length;
          } else {
            await chrome.storage.local.set({ ['draft:' + draftId]: draft });
          }
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
          queueCapture: state.queueCapture,
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
      state.queueCapture = false;
      state.cancel = false;
      state.paused = false;
      state.pauseSnapshotWriter = null;
      state.captureStartProof = null;
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
    const turns = orderedTurns();
    const index = turns.indexOf(turn);
    const contextBefore = index > 0 ? boundaryContextBefore(turns, index, 3) : [];
    return role && (id || signature)
      ? { id, signature, role, contextBefore } : null;
  }
  function markerIdentityMatches(anchor, candidate) {
    if (!anchor || !candidate) return false;
    const roleMatches = !anchor.role || !candidate.role || anchor.role === candidate.role;
    if (!roleMatches) return false;
    // The old 0.4.64 code additionally demanded the same text and neighbours
    // even for immutable message IDs. This loses legitimate marked turns when
    // ChatGPT virtualizes preceding messages or the text changes.
    if (isStrongMessageId(anchor.id)) return anchor.id === candidate.id;
    const signatureMatches = Boolean(
      anchor.signature && candidate.signature && anchor.signature === candidate.signature
    );
    if (!signatureMatches) return false;
    const before = Array.isArray(anchor.contextBefore) ? anchor.contextBefore : [];
    const actual = Array.isArray(candidate.contextBefore) ? candidate.contextBefore : null;
    if (actual && before.length &&
        (actual.length < before.length ||
          !before.every((signature, i) =>
            signature === actual[actual.length - before.length + i]))) return false;
    return Boolean(
      (anchor.id && candidate.id && anchor.id === candidate.id) || signatureMatches
    );
  }

  function anchorMatches(message, anchor, messages = null, index = -1) {
    if (!anchor || !message) return false;
    // A persisted strong ID identifies a logical turn even after the nearby
    // DOM/context disappears through ChatGPT virtualization.
    if (isStrongMessageId(anchor.id)) return anchor.id === message.id;
    const signature = messageTextSignature(message);
    if (anchor.signature && anchor.signature !== signature) return false;
    if (Array.isArray(messages) && index >= 0) {
      // Final trimming must use the ORIGINAL marked neighbour context,
      // otherwise a repeated text elsewhere in a long chat could be mistaken
      // for the selected end marker.
      return messageBoundaryContextMatches(messages, index, {
        contextBefore: anchor.contextBefore || []
      });
    }
    return markerIdentityMatches(anchor, {
      id: String(message.id || ''),
      signature,
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
        visibility: document.visibilityState || 'unknown',
        hidden: Boolean(document.hidden),
        lastScrollDirection: state.lastScrollDirection || ''
      });
      return false;
    }
    if (message && message.type === 'ARCHIVER_START_SPLIT_PLAN') {
      if (state.running) {
        sendResponse({ ok: false, error: 'Вкладка уже занята другим проходом.' });
        return false;
      }
      planAutomaticSplit(message.jobId, message.captureRange || {}).catch(() => {});
      sendResponse({ ok: true, running: true, jobId: message.jobId,
        version: EXTENSION_VERSION });
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
        captureRange: message.captureRange || null,
        queueCapture: Boolean(message.queueCapture),
        seekMarkedStart: Boolean(message.seekMarkedStart)
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
      if (!state.running || (message.jobId && message.jobId !== state.jobId)) {
        sendResponse({
          ok: false, paused: false, running: false,
          jobId: state.jobId || '', error: 'Активный сбор для постановки на паузу не найден.'
        });
        return false;
      }
      const pausedJobId = state.jobId;
      state.pauseCheckpoint = makePauseCheckpoint();
      state.paused = true;
      (async () => {
        let snapshotError = '';
        if (state.pauseSnapshotWriter) {
          try {
            await state.pauseSnapshotWriter();
          } catch (error) {
            snapshotError = error?.message || String(error);
          }
        }
        // A collector may have failed while its pause checkpoint was saving.
        if (!state.running || state.jobId !== pausedJobId) {
          sendResponse({
            ok: false, paused: false, running: false, jobId: pausedJobId,
            error: 'Сбор завершился при сохранении паузы. Проверьте незавершённые сборы.'
          });
          return;
        }
        const key = state.queueCapture
          ? 'archiverQueueJob:' + pausedJobId : 'activeCaptureJob';
        const stored = (await chrome.storage.local.get(key))[key] || {};
        const draftId = stored.draftId || stored.recoveryDraftId || ('draft-' + pausedJobId);
        const draft = (await chrome.storage.local.get('draft:' + draftId))['draft:' + draftId];
        sendResponse({
          ok: true, paused: true, running: true, jobId: pausedJobId,
          checkpointSaved: Boolean(draft?.messages?.length),
          draftCount: Number(draft?.messages?.length || 0),
          snapshotError
        });
      })().catch(error => {
        const alive = Boolean(state.running && state.jobId === pausedJobId);
        sendResponse({
          ok: alive, paused: alive, running: alive, jobId: pausedJobId,
          checkpointSaved: false, draftCount: 0,
          snapshotError: error?.message || String(error),
          error: alive ? '' : 'Сборщик завершился во время подтверждения паузы.'
        });
      });
      return true;
    }
    if (message && message.type === 'ARCHIVER_RESUME_CAPTURE') {
      if (!state.running || (message.jobId && message.jobId !== state.jobId)) {
        sendResponse({
          ok: false, resumed: false, running: false, jobId: state.jobId || '',
          error: 'Активный сбор для продолжения не найден.'
        });
        return false;
      }
      state.paused = false;
      state.pauseCheckpoint = null;
      state.resumeFailure = '';
      sendResponse({
        ok: true, resumed: true, paused: false, running: true,
        jobId: state.jobId, recovered: false
      });
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