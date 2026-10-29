// Chrome MV3 background capture rendering support.
//
// The target must stay attached until the collector exits. Detaching restores
// Chrome's natural page visibility and throttling, making a "successful" wheel
// reply useless when the virtualized ChatGPT turn list is no longer rendered.
export function createBackgroundFocusManager(chrome, {
  debuggerVersion = '1.3',
  checkVisibility = true
} = {}) {
  const sessions = new Map();
  const debuggee = tabId => ({ tabId });
  const isManaged = tabId => sessions.has(tabId);
  const details = tabId => sessions.get(tabId) || null;

  async function enable(tabId, jobId) {
    if (tabId == null || !jobId) throw new Error('Missing background tab ID or capture job ID.');
    const existing = sessions.get(tabId);
    if (existing) {
      if (existing.jobId !== jobId) throw new Error('Another capture owns this debugger session.');
      return { ok: true, tabId, jobId, alreadyAttached: true };
    }
    const targets = await chrome.debugger.getTargets();
    if (targets.some(target => target.tabId === tabId && target.attached)) {
      throw new Error(
        'Фоновая вкладка уже занята отладчиком. Закройте DevTools именно этой вкладки.'
      );
    }
    await chrome.debugger.attach(debuggee(tabId), debuggerVersion);
    let accepted = false;
    try {
      await chrome.debugger.sendCommand(
        debuggee(tabId), 'Emulation.setFocusEmulationEnabled', { enabled: true }
      );
      if (checkVisibility) {
        const [snapshot] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            visibility: document.visibilityState,
            hidden: document.hidden,
            url: location.href
          })
        });
        if (!snapshot?.result || snapshot.result.visibility !== 'visible' ||
            snapshot.result.hidden === true) {
          throw new Error(
            'Chrome не подтвердил видимость фонового сборщика. ' +
            'Нельзя начинать длительный проход без гарантии отрисовки.'
          );
        }
      }
      sessions.set(tabId, { jobId, attachedAt: Date.now() });
      accepted = true;
      return { ok: true, tabId, jobId, alreadyAttached: false };
    } finally {
      if (!accepted) {
        await chrome.debugger.detach(debuggee(tabId)).catch(() => {});
      }
    }
  }

  async function withDebugger(tabId, fn) {
    if (isManaged(tabId)) return fn();
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
  }

  async function release(tabId, jobId = '') {
    const current = sessions.get(tabId);
    if (!current || (jobId && current.jobId !== jobId)) return false;
    sessions.delete(tabId);
    await chrome.debugger.detach(debuggee(tabId)).catch(() => {});
    return true;
  }

  function forgetDetached(tabId) {
    const session = sessions.get(tabId) || null;
    sessions.delete(tabId);
    return session;
  }

  return { enable, withDebugger, release, isManaged, details, forgetDetached };
}
