(function initArchiverScrollRuntime() {
  'use strict';

  const KEY = '__CHATGPT_ARCHIVER_SCROLL__';
  if (globalThis[KEY]) return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2 && rect.bottom > 0 && rect.right > 0;
  }

  function findScrollContainer(turn) {
    let el = turn && turn.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 80) {
        return el;
      }
      el = el.parentElement;
    }

    const candidates = [
      document.scrollingElement,
      document.documentElement,
      ...document.querySelectorAll(
        'main, main *, [class*="overflow-y-auto"], [class*="overflow-auto"]'
      )
    ].filter((candidate, index, all) =>
      candidate &&
      all.indexOf(candidate) === index &&
      candidate instanceof Element
    ).filter(candidate => {
      const style = getComputedStyle(candidate);
      return /(auto|scroll|overlay)/.test(style.overflowY) &&
        candidate.scrollHeight > candidate.clientHeight + 80;
    });

    const containing = turn
      ? candidates.filter(candidate => candidate.contains(turn))
      : [];

    if (containing.length) {
      return containing.sort((a, b) =>
        (a.scrollHeight - a.clientHeight) -
        (b.scrollHeight - b.clientHeight)
      )[0];
    }

    return candidates.sort((a, b) =>
      (b.scrollHeight - b.clientHeight) -
      (a.scrollHeight - a.clientHeight)
    )[0] || document.scrollingElement || document.documentElement;
  }

  function physicalScrollEndVisible(turns = []) {
    const last = turns[turns.length - 1] || null;
    const scroller = findScrollContainer(last);
    if (!scroller) return false;
    const top = Number(scroller.scrollTop || 0);
    const height = Number(scroller.clientHeight || 0);
    const total = Number(scroller.scrollHeight || 0);
    if (!height || !total) return false;
    return top + height >= total - Math.max(24, Math.round(height * 0.04));
  }

  function physicalScrollStartVisible(turns = []) {
    const first = turns[0] || null;
    const scroller = findScrollContainer(first);
    if (!scroller) return false;
    const top = Number(scroller.scrollTop || 0);
    const height = Number(scroller.clientHeight || 0);
    if (!height) return false;
    return top <= Math.max(24, Math.round(height * 0.04));
  }

  function findVisibleLoadRetry() {
    const buttonPattern = /^(?:Попробовать снова|Повторить|Try again|Retry)$/i;
    const errorPattern = /(?:something went wrong|there was an error|network error|failed to load|не удалось загрузить|произошла ошибка|ошибка сети|возникла ошибка)/i;

    return [...document.querySelectorAll('button, [role="button"]')].find(el => {
      if (!isVisible(el) || el.disabled) return false;

      const label = String(
        el.innerText ||
        el.textContent ||
        el.getAttribute?.('aria-label') ||
        el.getAttribute?.('title') ||
        ''
      ).replace(/\s+/g, ' ').trim();

      if (!buttonPattern.test(label)) return false;

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

  function observeWindow({
    turns = [],
    getTurnKey,
    signature = '',
    capturedCount = 0
  } = {}) {
    const keyOf = typeof getTurnKey === 'function'
      ? getTurnKey
      : () => '';
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

  function createStabilityState() {
    return {
      stable: 0,
      previousSignature: '',
      previousCapturedCount: -1,
      previousFirstKey: '',
      previousLastKey: ''
    };
  }

  function resetStabilityState(state) {
    if (!state) return createStabilityState();
    state.stable = 0;
    state.previousSignature = '';
    state.previousCapturedCount = -1;
    state.previousFirstKey = '';
    state.previousLastKey = '';
    return state;
  }

  function primeStabilityState(state, observation) {
    const target = resetStabilityState(state);
    target.previousSignature = String(observation?.signature || '');
    target.previousCapturedCount = Number(observation?.capturedCount) || 0;
    target.previousFirstKey = String(observation?.firstKey || '');
    target.previousLastKey = String(observation?.lastKey || '');
    return target;
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

  function updateStabilityState(state, before, after, {
    requireCapturedCount = true,
    requireFirstKey = false,
    requireLastKey = false
  } = {}) {
    const target = state || createStabilityState();
    const repeatedPrevious = Boolean(
      after?.signature &&
      before?.signature === target.previousSignature &&
      (!requireCapturedCount || after.capturedCount === target.previousCapturedCount) &&
      (!requireFirstKey || after.firstKey === target.previousFirstKey) &&
      (!requireLastKey || after.lastKey === target.previousLastKey)
    );
    const unchanged = sameWindow(before, after, {
      requireCapturedCount,
      requireFirstKey,
      requireLastKey
    }) && repeatedPrevious;

    target.stable = unchanged ? target.stable + 1 : 0;
    target.previousSignature = String(after?.signature || '');
    target.previousCapturedCount = Number(after?.capturedCount) || 0;
    target.previousFirstKey = String(after?.firstKey || '');
    target.previousLastKey = String(after?.lastKey || '');

    return {
      unchanged,
      stable: target.stable,
      observation: after
    };
  }

  async function waitForTurnSettle(
    getSignature,
    { timeout = 8000, quietWindow = 1400, pollMs = 220 } = {}
  ) {
    if (typeof getSignature !== 'function') {
      throw new Error('Scroll settle requires a signature provider.');
    }

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

  async function physicalScroll({
    jobId,
    direction = 'up',
    bursts = 7,
    getSignature,
    settleTimeout = 8000,
    quietWindow = 1400,
    turns = [],
    wheelDelta = 860
  } = {}) {
    const normalizedDirection = direction === 'down' ? 'down' : 'up';
    const result = await chrome.runtime.sendMessage({
      type: 'ARCHIVER_PHYSICAL_SCROLL',
      jobId,
      direction: normalizedDirection,
      bursts,
      wheelDelta
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Не удалось физически прокрутить вкладку.');
    }

    await waitForTurnSettle(getSignature, {
      timeout: settleTimeout,
      quietWindow
    });

    return {
      ...result,
      direction: normalizedDirection
    };
  }

  globalThis[KEY] = Object.freeze({
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
})();
