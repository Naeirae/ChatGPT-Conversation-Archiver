const LAST_ARCHIVE_KEY = 'lastArchiveId';
const ACTIVE_JOB_KEY = 'activeCaptureJob';
const ARCHIVE_PREFIX = 'archive:';
const DOCS_NEW_URL = 'https://docs.new';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    imageCount: conversation.imageCount || 0
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
    const badge = next.status === 'running' || next.status === 'starting' ? '…' : next.status === 'done' ? '✓' : next.status === 'error' ? '!' : '';
    await chrome.action.setBadgeText({ tabId: next.tabId, text: badge }).catch(() => {});
    if (badge === '…') await chrome.action.setTitle({ tabId: next.tabId, title: `ChatGPT Archiver: ${next.message || 'сбор идет в фоне'}` }).catch(() => {});
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

function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function ensureChatGptContentScript(tabId, jobId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_START_CAPTURE', jobId });
    if (result?.ok) return result;
    throw new Error(result?.error || 'Content script не запустил сбор.');
  } catch (firstError) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-chatgpt.js'] });
    const result = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_START_CAPTURE', jobId });
    if (!result?.ok) throw new Error(result?.error || firstError?.message || 'Не удалось запустить сбор.');
    return result;
  }
}

async function startCapture() {
  const tab = await getActiveTab();
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error('Откройте нужную переписку ChatGPT в активной вкладке.');
  if (tab.discarded) throw new Error('Вкладка ChatGPT сейчас выгружена из памяти. Откройте ее и повторите запуск.');
  if (tab.frozen) throw new Error('Вкладка ChatGPT сейчас заморожена. Активируйте ее и повторите запуск.');

  const current = await getJob();
  if (current && ['starting', 'running'].includes(current.status)) {
    if (current.tabId === tab.id) return { ok: true, job: current, alreadyRunning: true };
    throw new Error('Другой сбор переписки уже выполняется.');
  }

  const jobId = makeJobId();
  const job = await setJob({
    jobId,
    tabId: tab.id,
    status: 'starting',
    phase: 'starting',
    message: 'Запускаю фоновый сбор…',
    count: 0,
    imageCount: 0,
    startedAt: Date.now(),
    previousAutoDiscardable: tab.autoDiscardable
  });

  if (tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  try {
    await ensureChatGptContentScript(tab.id, jobId);
    await setJob({ status: 'running', message: 'Сбор идет в фоне…', phase: 'starting' });
    return { ok: true, job: await getJob() };
  } catch (error) {
    await finishJobWithError(jobId, tab.id, error?.message || String(error));
    throw error;
  }
}

async function cancelCapture() {
  const job = await getJob();
  if (!job || !['starting', 'running', 'paused'].includes(job.status)) return { ok: true, job };
  try {
    await chrome.tabs.sendMessage(job.tabId, { type: 'ARCHIVER_CANCEL_CAPTURE', jobId: job.jobId });
  } catch (_) {}
  const next = await setJob({ status: 'cancelled', message: 'Сбор отменен.', finishedAt: Date.now() });
  await restoreAutoDiscardable(next);
  return { ok: true, job: next };
}

async function restoreAutoDiscardable(job) {
  if (!job?.tabId || job.previousAutoDiscardable == null) return;
  await chrome.tabs.update(job.tabId, { autoDiscardable: job.previousAutoDiscardable }).catch(() => {});
}

async function finishJobWithError(jobId, tabId, message) {
  const job = await getJob();
  if (job?.jobId !== jobId) return;
  const next = await setJob({ status: 'error', message, finishedAt: Date.now(), tabId });
  await restoreAutoDiscardable(next);
}

async function handleCaptureComplete(message) {
  const job = await getJob();
  if (!job || job.jobId !== message.jobId) return;
  const archive = await getArchive(message.archiveId);
  if (!archive) return finishJobWithError(message.jobId, job.tabId, 'Архив не найден после завершения сбора.');
  const next = await setJob({
    status: 'done',
    message: 'Переписка собрана.',
    count: archive.messages?.length || 0,
    imageCount: archive.imageCount || 0,
    archiveId: archive.id,
    finishedAt: Date.now()
  });
  await restoreAutoDiscardable(next);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roleTitle(role) {
  return role === 'user' ? 'Пользователь' : 'ChatGPT';
}

function buildRichHtml(conversation) {
  const chunks = [];
  chunks.push(`<h1>${escapeHtml(conversation.title || 'ChatGPT conversation')}</h1>`);
  if (conversation.sourceUrl) chunks.push(`<p><a href="${escapeHtml(conversation.sourceUrl)}">Исходная переписка ChatGPT</a></p>`);
  chunks.push(`<p><em>Сохранено: ${escapeHtml(new Date(conversation.capturedAt || Date.now()).toLocaleString('ru-RU'))}</em></p>`);
  chunks.push('<hr>');
  for (const msg of conversation.messages || []) {
    chunks.push(`<p><strong>${roleTitle(msg.role)}</strong></p>`);
    chunks.push(`<div>${msg.html || `<p>${escapeHtml(msg.text || '')}</p>`}</div>`);
    chunks.push('<p><br></p>');
  }
  return chunks.join('\n');
}

function buildPlainText(conversation) {
  const lines = [conversation.title || 'ChatGPT conversation'];
  if (conversation.sourceUrl) lines.push(conversation.sourceUrl);
  lines.push('');
  for (const msg of conversation.messages || []) {
    lines.push(`${roleTitle(msg.role)}:`);
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

async function pasteIntoGoogleDoc(tabId) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(700);
    const point = await editorPoint(tabId);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await sleep(450);
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
  await writeClipboard(buildRichHtml(conversation), buildPlainText(conversation));

  let tab;
  if (activeDoc) {
    tab = await getActiveTab();
    if (!tab?.id || !isGoogleDocUrl(tab.url)) throw new Error('Откройте нужный Google Doc в активной вкладке.');
  } else {
    tab = await chrome.tabs.create({ url: DOCS_NEW_URL, active: true });
    await waitForTabComplete(tab.id);
    await sleep(2500);
  }
  const finalTab = await pasteIntoGoogleDoc(tab.id);
  return { docUrl: finalTab.url, archive: summarize(conversation) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    switch (message?.type) {
      case 'ARCHIVER_CAPTURE_CURRENT':
        return await startCapture();
      case 'ARCHIVER_GET_STATE': {
        const job = await getJob();
        const archive = await getLastArchive();
        return { ok: true, job, archive: summarize(archive) };
      }
      case 'ARCHIVER_GET_LAST':
        return { ok: true, archive: summarize(await getLastArchive()) };
      case 'ARCHIVER_CANCEL_CAPTURE':
        return await cancelCapture();
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
  if (job?.tabId !== tabId || !['starting', 'running', 'paused'].includes(job.status)) return;
  await setJob({ status: 'error', message: 'Вкладка с перепиской была закрыта.', finishedAt: Date.now() });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const job = await getJob();
  if (job?.tabId !== tabId || !['starting', 'running', 'paused'].includes(job.status)) return;
  if (changeInfo.frozen === true) {
    await setJob({ status: 'paused', message: 'Вкладка временно заморожена. Сбор продолжится после ее разморозки.', phase: 'paused' });
  } else if (changeInfo.frozen === false && job.status === 'paused') {
    await setJob({ status: 'running', message: 'Вкладка снова доступна. Продолжаю сбор…', phase: 'walk' });
  }
  if (changeInfo.status === 'loading' && !isChatGptUrl(tab.url || '')) {
    await finishJobWithError(job.jobId, tabId, 'Вкладка с перепиской была переведена на другую страницу.');
  }
});
