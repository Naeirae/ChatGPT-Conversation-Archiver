// Exclusive debugger ownership for Chrome MV3 background collectors.
// A managed session is attached for the entire capture, not per wheel event.
// All temporary operations on the same tab share the same gate.
export function createBackgroundFocusManager(chrome, {
  debuggerVersion = '1.3',
  checkVisibility = true
} = {}) {
  const sessions = new Map();
  const gates = new Map();
  const debuggee = tabId => ({ tabId });

  function conversationPath(url) {
    try {
      const value = new URL(url);
      if (!['chatgpt.com', 'chat.openai.com'].includes(value.hostname)) return '';
      return value.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  function sameConversation(actual, expected) {
    const a = conversationPath(actual);
    const b = conversationPath(expected);
    return Boolean(a && b && a === b);
  }

  // A queued operation only blocks another operation for the same tab.
  async function exclusive(tabId, action) {
    const previous = gates.get(tabId) || Promise.resolve();
    const running = previous.catch(() => {}).then(action);
    const tail = running.catch(() => {});
    gates.set(tabId, tail);
    try {
      return await running;
    } finally {
      if (gates.get(tabId) === tail) gates.delete(tabId);
    }
  }

  async function inspect(tabId, expectedUrl) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !sameConversation(tab.url || '', expectedUrl)) {
      throw new Error('Рабочая вкладка больше не принадлежит исходной переписке.');
    }
    const [snapshot] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        visibility: document.visibilityState,
        hidden: document.hidden,
        url: location.href,
        readyState: document.readyState
      })
    });
    const result = snapshot?.result;
    if (!result || !sameConversation(result.url || '', expectedUrl)) {
      throw new Error('Фоновая страница сменила переписку или не ответила.');
    }
    if (checkVisibility && (result.visibility !== 'visible' || result.hidden !== false)) {
      throw new Error('Chrome не подтвердил видимость фонового сборщика.');
    }
    return result;
  }

  function isManaged(tabId) {
    const session = sessions.get(tabId);
    return Boolean(session && !session.closing);
  }
  const details = tabId => sessions.get(tabId) || null;

  async function enable(tabId, jobId, expectedUrl) {
    if (!Number.isInteger(tabId) || !jobId || !conversationPath(expectedUrl)) {
      throw new Error('Нужны рабочая вкладка, ID задания и URL переписки.');
    }
    return exclusive(tabId, async () => {
      const existing = sessions.get(tabId);
      if (existing) {
        if (existing.jobId !== jobId || existing.closing) {
          throw new Error('Отладочная сессия принадлежит другому заданию.');
        }
        const visibility = await inspect(tabId, expectedUrl);
        return { ok: true, tabId, jobId, alreadyAttached: true, visibility };
      }
      // getTargets includes DevTools attachments. Never claim someone else's
      // session and never attach to an arbitrary user tab.
      const tab = await chrome.tabs.get(tabId);
      if (!sameConversation(tab?.url || '', expectedUrl)) {
        throw new Error('Фоновый сборщик открыл не исходную переписку.');
      }
      const targets = await chrome.debugger.getTargets();
      if (targets.some(target => target.tabId === tabId && target.attached)) {
        throw new Error('Вкладка занята DevTools или другим отладчиком Chrome.');
      }
      await chrome.debugger.attach(debuggee(tabId), debuggerVersion);
      const session = { jobId, expectedUrl, attachedAt: Date.now(), closing: false };
      sessions.set(tabId, session);
      try {
        await chrome.debugger.sendCommand(
          debuggee(tabId), 'Emulation.setFocusEmulationEnabled', { enabled: true }
        );
        const visibility = await inspect(tabId, expectedUrl);
        if (sessions.get(tabId) !== session) {
          throw new Error('Chrome отсоединил отладчик во время подготовки.');
        }
        return { ok: true, tabId, jobId, alreadyAttached: false, visibility };
      } catch (error) {
        if (sessions.get(tabId) === session) sessions.delete(tabId);
        await chrome.debugger.detach(debuggee(tabId)).catch(() => {});
        throw error;
      }
    });
  }

  // This is the only CDP ownership gateway for chat capture transport,
  // screenshots, clicks and clipboard operations. The callback can issue
  // several CDP commands while the tab gate is held.
  async function withDebugger(tabId, fn) {
    return exclusive(tabId, async () => {
      const session = sessions.get(tabId);
      if (session?.closing) throw new Error('Фоновая отладочная сессия завершается.');
      if (session) {
        const targets = await chrome.debugger.getTargets();
        if (!targets.some(target => target.tabId === tabId && target.attached)) {
          sessions.delete(tabId);
          throw new Error('Фоновая отладочная сессия неожиданно отсоединена.');
        }
        return fn();
      }
      const targets = await chrome.debugger.getTargets();
      if (targets.some(target => target.tabId === tabId && target.attached)) {
        throw new Error('Вкладка занята другим отладчиком Chrome.');
      }
      let attached = false;
      try {
        await chrome.debugger.attach(debuggee(tabId), debuggerVersion);
        attached = true;
        return await fn();
      } finally {
        if (attached) await chrome.debugger.detach(debuggee(tabId)).catch(() => {});
      }
    });
  }

  async function verify(tabId, jobId) {
    return exclusive(tabId, async () => {
      const session = sessions.get(tabId);
      if (!session || session.jobId !== jobId || session.closing) {
        throw new Error('Фоновая сессия задания отсутствует.');
      }
      const targets = await chrome.debugger.getTargets();
      if (!targets.some(target => target.tabId === tabId && target.attached)) {
        sessions.delete(tabId);
        throw new Error('Отладчик фонового сборщика отключился.');
      }
      return inspect(tabId, session.expectedUrl);
    });
  }

  async function release(tabId, jobId = '') {
    const session = sessions.get(tabId);
    if (!session || (jobId && session.jobId !== jobId)) return false;
    session.closing = true;
    return exclusive(tabId, async () => {
      if (sessions.get(tabId) !== session) return false;
      sessions.delete(tabId);
      await chrome.debugger.detach(debuggee(tabId)).catch(() => {});
      return true;
    });
  }

  // Called synchronously by chrome.debugger.onDetach. A subsequent normal
  // release cannot accidentally detach the debugger now owned by DevTools.
  function forgetDetached(tabId) {
    const session = sessions.get(tabId) || null;
    sessions.delete(tabId);
    return session;
  }

  return { enable, withDebugger, release, verify, isManaged, details, forgetDetached };
}
