const LAST_ARCHIVE_KEY = 'lastArchiveId';
const ACTIVE_JOB_KEY = 'activeCaptureJob';
const ARCHIVE_PREFIX = 'archive:';
const ARCHIVE_INDEX_KEY = 'archiveIndex';
const DOC_EXPORTS_KEY = 'docExports';
const DOCS_NEW_URL = 'https://docs.new';
const SETTINGS_KEY = 'archiverSettings';
const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false };
async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


function parseUrl(url = '') {
  try { return new URL(url); } catch (_) { return null; }
}

function isChatGptHost(url = '') {
  const parsed = parseUrl(url);
  return Boolean(parsed && /^https:$/.test(parsed.protocol) &&
    (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'chat.openai.com'));
}

function isConversationUrl(url = '') {
  const parsed = parseUrl(url);
  if (!parsed || !isChatGptHost(url)) return false;
  if (/(?:^|\/)c\/[^/]+(?:\/|$)/.test(parsed.pathname)) return true;
  if (parsed.searchParams.has('conversationId') && parsed.searchParams.get('conversationId')) return true;
  return false;
}

function conversationKey(url = '') {
  const parsed = parseUrl(url);
  if (!parsed || !isChatGptHost(url)) return '';
  const match = parsed.pathname.match(/(?:^|\/)c\/([^/]+)(?:\/|$)/);
  const id = match?.[1] || parsed.searchParams.get('conversationId') || '';
  return id ? parsed.hostname + ':' + id : '';
}

function googleDocKey(url = '') {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== 'docs.google.com') return '';
  const match = parsed.pathname.match(/\/document\/d\/([^/]+)/);
  return match?.[1] || '';
}

function makeCaptureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function inspectAndKickScroll(tabId) {
  let attached = false;
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(item => item.tabId === tabId);
    if (target?.attached) {
      throw makeCaptureError(
        'DEBUGGER_BUSY',
        'Chrome уже использует отладчик этой вкладки. Если открыты DevTools, закройте их и повторите запуск.'
      );
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    const locationResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: `({
          href: location.href,
          origin: location.origin,
          pathname: location.pathname,
          readyState: document.readyState
        })`,
        returnByValue: true
      }
    );

    const page = locationResult?.result?.value || {};
    if (!isChatGptHost(page.href)) {
      throw makeCaptureError(
        'WRONG_SITE',
        'Откройте ChatGPT в активной вкладке.'
      );
    }

    if (!isConversationUrl(page.href)) {
      throw makeCaptureError(
        'NOT_CONVERSATION',
        'Убедитесь, что в активной вкладке открыт диалог ChatGPT.'
      );
    }

    return {
      ok: true,
      href: page.href,
      readyState: page.readyState
    };
  } catch (error) {
    if (error?.code) throw error;
    const raw = String(error?.message || error);
    if (/debugger|attach|target/i.test(raw)) {
      throw makeCaptureError(
        'DEBUGGER_ERROR',
        'Не удалось подключиться к отладчику вкладки. Если открыты DevTools, закройте их и повторите запуск.'
      );
    }
    throw error;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function isChatGptUrl(url = '') {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url);
}

function isGoogleDocUrl(url = '') {
  return /^https:\/\/docs\.google\.com\/document\//i.test(url);
}

function archiveKey(id) {
  return `${ARCHIVE_PREFIX}${id}`;
}

function summarize(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.id,
    title: conversation.title,
    sourceUrl: conversation.sourceUrl,
    capturedAt: conversation.capturedAt,
    messageCount: conversation.messages?.length || 0,
    imageCount: conversation.imageCount || 0,
    lastCaptureAddedCount: conversation.lastCaptureAddedCount || 0,
    lastCaptureMode: conversation.lastCaptureMode || 'full',
    lastMessageId: conversation.lastMessageId || conversation.messages?.[conversation.messages.length - 1]?.id || ''
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getJob() {
  return (await chrome.storage.local.get(ACTIVE_JOB_KEY))[ACTIVE_JOB_KEY] || null;
}

async function setJob(patch) {
  const current = await getJob();
  const next = { ...(current || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [ACTIVE_JOB_KEY]: next });
  if (next.tabId != null) {
    const running = next.status === 'running' || next.status === 'starting';
    const phaseBadge = next.phase === 'top' ? '1/3' : next.phase === 'walk' ? '2/3' : next.phase === 'finalizing' ? '3/3' : '…';
    const badge = running ? phaseBadge : next.status === 'done' ? '✓' : next.status === 'error' ? '!' : next.status === 'cancelled' ? '×' : '';
    await chrome.action.setBadgeText({ tabId: next.tabId, text: badge }).catch(() => {});
    const title = next.message ? `Архиватор ChatGPT: ${next.message}` : 'Архиватор ChatGPT';
    await chrome.action.setTitle({ tabId: next.tabId, title }).catch(() => {});
  }
  return next;
}

async function getArchive(id) {
  if (!id) return null;
  const result = await chrome.storage.local.get(archiveKey(id));
  return result[archiveKey(id)] || null;
}

async function getLastArchive() {
  const result = await chrome.storage.local.get(LAST_ARCHIVE_KEY);
  return getArchive(result[LAST_ARCHIVE_KEY]);
}

async function getArchiveForUrl(url = '') {
  const key = conversationKey(url);
  if (!key) return null;
  const result = await chrome.storage.local.get(ARCHIVE_INDEX_KEY);
  const index = result[ARCHIVE_INDEX_KEY] || {};
  return getArchive(index[key]);
}

async function indexArchive(conversation) {
  const key = conversationKey(conversation?.sourceUrl || '');
  if (!key || !conversation?.id) return;
  const result = await chrome.storage.local.get(ARCHIVE_INDEX_KEY);
  const index = { ...(result[ARCHIVE_INDEX_KEY] || {}), [key]: conversation.id };
  await chrome.storage.local.set({ [ARCHIVE_INDEX_KEY]: index });
}

function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function ensureChatGptContentScript(tabId, jobId, options = {}) {
  const payload = {
    type: 'ARCHIVER_START_CAPTURE',
    jobId,
    mode: options.mode || 'full',
    resumeAnchorId: options.resumeAnchorId || '',
    existingArchiveId: options.existingArchiveId || ''
  };

  try {
    const result = await chrome.tabs.sendMessage(tabId, payload);
    if (result?.ok) return result;
    throw new Error(result?.error || 'Content script не запустил сбор.');
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-chatgpt.js'] });
    const result = await chrome.tabs.sendMessage(tabId, payload);
    if (!result?.ok) throw new Error(result?.error || firstError?.message || 'Не удалось запустить сбор.');
    return result;
  }
}

async function waitForChatTabComplete(tabId, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && isConversationUrl(tab.url || '')) return tab;
    await sleep(250);
  }
  throw new Error('Фоновая вкладка ChatGPT не загрузилась за 30 секунд.');
}

async function startCapture({ mode = 'full' } = {}) {
  const sourceTab = await getActiveTab();
  if (!sourceTab?.id) throw new Error('Не удалось определить активную вкладку.');

  if (!isChatGptHost(sourceTab.url || '')) {
    throw makeCaptureError('WRONG_SITE', 'Откройте ChatGPT в активной вкладке.');
  }

  const current = await getJob();
  if (current && ['starting', 'running', 'paused'].includes(current.status)) {
    if (current.tabId === sourceTab.id) return { ok: true, job: current, alreadyRunning: true };
    throw new Error('Другой сбор переписки уже выполняется.');
  }

  const inspection = await inspectAndKickScroll(sourceTab.id);

  let existingArchive = null;
  if (mode === 'continue') {
    existingArchive = await getArchiveForUrl(inspection.href);
    if (!existingArchive?.messages?.length) {
      throw new Error('Для этого чата еще нет локального архива. Сначала выполните полный сбор.');
    }
  }

  const jobId = makeJobId();
  let captureTab = null;

  try {
    captureTab = await chrome.tabs.create({ url: inspection.href, active: false });
    if (!captureTab?.id) throw new Error('Не удалось открыть фоновую вкладку для сбора.');

    await chrome.tabs.update(captureTab.id, { autoDiscardable: false }).catch(() => {});
    captureTab = await waitForChatTabComplete(captureTab.id);

    await setJob({
      jobId,
      tabId: sourceTab.id,
      sourceTabId: sourceTab.id,
      captureTabId: captureTab.id,
      sourceUrl: inspection.href,
      status: 'starting',
      phase: 'top',
      captureMode: mode,
      message: mode === 'continue'
        ? 'Открываю фоновую копию и ищу место продолжения…'
        : 'Открываю фоновую копию и иду к началу…',
      count: 0,
      addedCount: 0,
      imageCount: 0,
      startedAt: Date.now()
    });

    const resumeAnchorId = existingArchive?.lastMessageId ||
      existingArchive?.messages?.[existingArchive.messages.length - 1]?.id || '';

    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode,
      resumeAnchorId,
      existingArchiveId: existingArchive?.id || ''
    });

    await setJob({
      status: 'running',
      message: mode === 'continue' ? 'Продолжаю архив в фоне…' : 'Сбор идет в фоновой вкладке…',
      phase: 'top'
    });

    return { ok: true, job: await getJob() };
  } catch (error) {
    if (captureTab?.id) await chrome.tabs.remove(captureTab.id).catch(() => {});
    await setJob({
      jobId,
      tabId: sourceTab.id,
      sourceTabId: sourceTab.id,
      captureTabId: captureTab?.id || null,
      status: 'error',
      message: error?.message || String(error),
      finishedAt: Date.now()
    });
    throw error;
  }
}

async function cancelCapture() {
  const job = await getJob();
  if (!job || !['starting', 'running', 'paused'].includes(job.status)) return { ok: true, job };

  try {
    if (job.captureTabId != null) {
      await chrome.tabs.sendMessage(job.captureTabId, { type: 'ARCHIVER_CANCEL_CAPTURE', jobId: job.jobId });
    }
  } catch (_) {}

  if (job.captureTabId != null) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }

  const next = await setJob({
    status: 'cancelled',
    message: 'Сбор отменен.',
    finishedAt: Date.now(),
    captureTabId: null
  });
  return { ok: true, job: next };
}

async function finishJobWithError(jobId, sourceTabId, message) {
  const job = await getJob();
  if (job?.jobId !== jobId) return;

  if (job.captureTabId != null) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }

  await setJob({
    status: 'error',
    message,
    finishedAt: Date.now(),
    tabId: sourceTabId ?? job.sourceTabId ?? job.tabId,
    captureTabId: null
  });
}

async function handleCaptureComplete(message) {
  const job = await getJob();
  if (!job || job.jobId !== message.jobId) return;

  const archive = await getArchive(message.archiveId);
  if (!archive) {
    return finishJobWithError(message.jobId, job.sourceTabId ?? job.tabId, 'Архив не найден после завершения сбора.');
  }

  await indexArchive(archive);

  if (job.captureTabId != null) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }

  await setJob({
    status: 'done',
    message: message.mode === 'continue'
      ? ('Архив продолжен: +' + (message.addedCount || 0) + ' сообщений.')
      : 'Переписка собрана.',
    count: archive.messages?.length || 0,
    addedCount: message.addedCount || archive.lastCaptureAddedCount || 0,
    imageCount: archive.imageCount || 0,
    archiveId: archive.id,
    finishedAt: Date.now(),
    captureTabId: null
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function speakerLabel(role, settings) {
  if (role === 'user') return settings.userName ? `Пользователь / ${settings.userName}:` : 'Пользователь:';
  return settings.assistantName ? `ChatGPT / ${settings.assistantName}:` : 'ChatGPT:';
}

function buildRichHtml(conversation, settings, options = {}) {
  const chunks = [];
  const messages = options.messages || conversation.messages || [];
  const includeHeader = options.includeHeader !== false;

  if (includeHeader) {
    chunks.push(`<h1>${escapeHtml(conversation.title || 'ChatGPT conversation')}</h1>`);
    if (conversation.sourceUrl) chunks.push(`<p><a href="${escapeHtml(conversation.sourceUrl)}">Исходная переписка ChatGPT</a></p>`);
    chunks.push(`<p><em>Сохранено: ${escapeHtml(new Date(conversation.capturedAt || Date.now()).toLocaleString('ru-RU'))}</em></p>`);
    chunks.push('<hr>');
  }

  for (const msg of messages) {
    const align = msg.role === 'user' && settings.alignUserRight ? 'right' : 'left';
    chunks.push(`<div style="text-align:${align};">`);
    chunks.push(`<p><strong>${escapeHtml(speakerLabel(msg.role, settings))}</strong></p>`);
    if (settings.includeReasoning && msg.reasoningHtml) {
      const reasoningTitle = msg.reasoningLabel || 'Размышления';
      chunks.push('<div><p><strong>' + escapeHtml(reasoningTitle) + ':</strong></p>');
      chunks.push(msg.reasoningHtml);
      chunks.push('</div>');
    }
    chunks.push(`<div>${msg.html || `<p>${escapeHtml(msg.text || '')}</p>`}</div>`);
    chunks.push('</div>');
    chunks.push('<p><br></p>');
  }
  return chunks.join('\n');
}

function buildPlainText(conversation, settings, options = {}) {
  const lines = [];
  const messages = options.messages || conversation.messages || [];
  const includeHeader = options.includeHeader !== false;

  if (includeHeader) {
    lines.push(conversation.title || 'ChatGPT conversation');
    if (conversation.sourceUrl) lines.push(conversation.sourceUrl);
    lines.push('');
  }

  for (const msg of messages) {
    lines.push(speakerLabel(msg.role, settings));
    if (settings.includeReasoning && msg.reasoningText) {
      lines.push((msg.reasoningLabel || 'Размышления') + ':');
      lines.push(msg.reasoningText);
    }
    lines.push(msg.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('Offscreen API недоступен в этой версии Chrome.');
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] }) : [];
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Write rich ChatGPT conversation HTML to the clipboard before pasting into Google Docs.'
    });
  } catch (error) {
    if (!/single offscreen/i.test(String(error))) throw error;
  }
}

async function writeClipboard(html, text) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_OFFSCREEN_WRITE', target: 'offscreen', html, text });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось записать переписку в буфер обмена.');
}

async function waitForTabComplete(tabId, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && isGoogleDocUrl(tab.url)) return tab;
    await sleep(300);
  }
  throw new Error('Google Docs не загрузился за 30 секунд.');
}

async function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function physicalScrollTab(tabId, direction = 'down', bursts = 7) {
  let attached = false;
  const count = Math.max(1, Math.min(16, Number(bursts) || 7));
  const sign = direction === 'up' ? -1 : 1;

  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(item => item.tabId === tabId);
    if (target?.attached) {
      throw new Error('Фоновая вкладка уже занята Chrome debugger.');
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    const viewportResult = await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight})',
      returnByValue: true
    });
    const viewport = viewportResult?.result?.value || {};
    const width = Math.max(640, Number(viewport.width) || 1280);
    const height = Math.max(480, Number(viewport.height) || 720);
    const x = Math.round(width * 0.68);
    const y = Math.round(height * 0.48);

    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none'
    }).catch(() => {});

    for (let i = 0; i < count; i++) {
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: sign * 860
      });
      await sleep(90);
    }

    return { ok: true, direction, bursts: count };
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function dispatchKey(tabId, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}

async function editorPoint(tabId) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const selectors = ['.kix-appview-editor', '.kix-page', '[role="textbox"]'];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) return {x:r.left + Math.min(r.width * 0.5, 500), y:r.top + Math.min(Math.max(140, r.height * 0.2), 350)};
      }
      return {x:Math.max(320, innerWidth * 0.5), y:Math.max(220, Math.min(420, innerHeight * 0.35))};
    })()`,
    returnByValue: true
  });
  return result?.result?.value || { x: 500, y: 300 };
}

async function pasteIntoGoogleDoc(tabId, { appendToEnd = false } = {}) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(700);
    const point = await editorPoint(tabId);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(450);
    if (appendToEnd) {
      await dispatchKey(tabId, 'End', 'End', 35, 2);
      await sleep(220);
    }
    await dispatchKey(tabId, 'v', 'KeyV', 86, 2);
    await sleep(2500);
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  return chrome.tabs.get(tabId);
}

async function exportConversation({ activeDoc = false } = {}) {
  const conversation = await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');

  const settings = await getSettings();
  let tab;
  let messages = conversation.messages || [];
  let includeHeader = true;
  let appendToEnd = false;
  let exportMode = 'full';

  if (activeDoc) {
    tab = await getActiveTab();
    if (!tab?.id || !isGoogleDocUrl(tab.url)) throw new Error('Откройте нужный Google Doc в активной вкладке.');

    const docKey = googleDocKey(tab.url);
    if (!docKey) throw new Error('Не удалось определить ID открытого Google Doc.');

    const result = await chrome.storage.local.get(DOC_EXPORTS_KEY);
    const exports = result[DOC_EXPORTS_KEY] || {};
    const previous = exports[docKey];
    const currentConversationKey = conversationKey(conversation.sourceUrl);

    if (previous?.conversationKey === currentConversationKey && previous.lastMessageId) {
      const anchorIndex = messages.findIndex(item => item.id === previous.lastMessageId);
      if (anchorIndex >= 0) {
        messages = messages.slice(anchorIndex + 1);
        includeHeader = false;
        appendToEnd = true;
        exportMode = 'delta';
      }
    }

    if (!messages.length) {
      return {
        docUrl: tab.url,
        archive: summarize(conversation),
        exportMode: 'delta',
        addedCount: 0,
        noChanges: true
      };
    }
  } else {
    tab = await chrome.tabs.create({ url: DOCS_NEW_URL, active: true });
    await waitForTabComplete(tab.id);
    await sleep(2500);
  }

  await writeClipboard(
    buildRichHtml(conversation, settings, { messages, includeHeader }),
    buildPlainText(conversation, settings, { messages, includeHeader })
  );

  const finalTab = await pasteIntoGoogleDoc(tab.id, { appendToEnd });
  const docKey = googleDocKey(finalTab.url);

  if (docKey) {
    const result = await chrome.storage.local.get(DOC_EXPORTS_KEY);
    const exports = result[DOC_EXPORTS_KEY] || {};
    const lastMessageId = conversation.messages?.[conversation.messages.length - 1]?.id || '';
    exports[docKey] = {
      conversationKey: conversationKey(conversation.sourceUrl),
      archiveId: conversation.id,
      lastMessageId,
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [DOC_EXPORTS_KEY]: exports });
  }

  return {
    docUrl: finalTab.url,
    archive: summarize(conversation),
    exportMode,
    addedCount: messages.length,
    noChanges: false
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    switch (message?.type) {
      case 'ARCHIVER_CAPTURE_CURRENT':
        return await startCapture({ mode: 'full' });
      case 'ARCHIVER_CONTINUE_CURRENT':
        return await startCapture({ mode: 'continue' });
      case 'ARCHIVER_GET_STATE': {
        const job = await getJob();
        const tab = await getActiveTab();
        let currentArchive = null;
        if (tab?.url && isConversationUrl(tab.url)) {
          currentArchive = await getArchiveForUrl(tab.url);
        }
        const archive = currentArchive || await getLastArchive();
        return {
          ok: true,
          job,
          archive: summarize(archive),
          canContinue: Boolean(currentArchive?.messages?.length)
        };
      }
      case 'ARCHIVER_GET_LAST':
        return { ok: true, archive: summarize(await getLastArchive()) };
      case 'ARCHIVER_CANCEL_CAPTURE':
        return await cancelCapture();
      case 'ARCHIVER_CAPTURE_PROGRESS': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId) return { ok: false, error: 'Сбор уже неактуален.' };
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId != null && senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Прогресс пришел не из фоновой вкладки сбора.' };
        }
        await setJob({ ...message.patch, tabId: job.sourceTabId ?? job.tabId });
        return { ok: true };
      }
      case 'ARCHIVER_PHYSICAL_SCROLL': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId) return { ok: false, error: 'Сбор уже неактуален.' };
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId == null || senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Физическая прокрутка разрешена только фоновой вкладке сбора.' };
        }
        return await physicalScrollTab(job.captureTabId, message.direction, message.bursts);
      }
      case 'ARCHIVER_CAPTURE_FAILED': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId) return { ok: true };
        await finishJobWithError(message.jobId, job.sourceTabId ?? job.tabId, message.error || 'Сбор не выполнен.');
        return { ok: true };
      }
      case 'ARCHIVER_CAPTURE_COMPLETE':
        await handleCaptureComplete(message);
        return { ok: true };
      case 'ARCHIVER_EXPORT_NEW_DOC':
        return { ok: true, ...(await exportConversation({ activeDoc: false })) };
      case 'ARCHIVER_EXPORT_ACTIVE_DOC':
        return { ok: true, ...(await exportConversation({ activeDoc: true })) };
      default:
        return null;
    }
  })().then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const job = await getJob();
  if (!job || !['starting', 'running', 'paused'].includes(job.status)) return;

  if (job.captureTabId === tabId) {
    await setJob({
      status: 'error',
      message: 'Фоновая вкладка сбора была закрыта.',
      finishedAt: Date.now(),
      captureTabId: null
    });
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const job = await getJob();
  if (!job || job.captureTabId !== tabId || !['starting', 'running', 'paused'].includes(job.status)) return;

  if (changeInfo.frozen === true) {
    await setJob({
      status: 'paused',
      message: 'Фоновая вкладка временно заморожена. Сбор продолжится после разморозки.',
      phase: 'paused'
    });
  } else if (changeInfo.frozen === false && job.status === 'paused') {
    await setJob({
      status: 'running',
      message: 'Фоновая вкладка снова доступна. Продолжаю сбор…',
      phase: 'walk'
    });
  }

  if (changeInfo.status === 'loading' && !isChatGptUrl(tab.url || '')) {
    await finishJobWithError(job.jobId, job.sourceTabId ?? job.tabId, 'Фоновая вкладка ушла со страницы ChatGPT.');
  }
});
