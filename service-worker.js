const LAST_ARCHIVE_KEY = 'lastArchiveId';
const ACTIVE_JOB_KEY = 'activeCaptureJob';
const ARCHIVE_PREFIX = 'archive:';
const DRAFT_PREFIX = 'draft:';
const ARCHIVE_INDEX_KEY = 'archiveIndex';
const DOC_EXPORTS_KEY = 'docExports';
const DOC_LINKS_KEY = 'docLinks';
const DOCS_NEW_URL = 'https://docs.new';
const SETTINGS_KEY = 'archiverSettings';
const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false, captureTarget: 'copy' };
async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hashText(text = '') {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
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

function messageSignature(role, text = '') {
  return String(role || 'unknown') + ':' + hashText(normalizeMatchText(text));
}

function externalMatchSignature(role, text = '') {
  const normalized = normalizeMatchText(text);
  return String(role || 'unknown') + ':p:' + hashText(normalized.slice(0, 240));
}


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

function googleDocTabToken(url = '') {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  return parsed.searchParams.get('tab') || 't.0';
}

function normalizeGoogleDocUrl(url = '') {
  const parsed = parseUrl(String(url).trim());
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') return '';
  const docId = googleDocKey(parsed.href);
  if (!docId) return '';
  return parsed.href;
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

async function appendRunLog(patch, entry = null) {
  const current = await getJob();
  const log = Array.isArray(current?.log) ? [...current.log] : [];
  if (entry) {
    log.push({
      at: Date.now(),
      level: entry.level || 'info',
      code: entry.code || '',
      message: entry.message || '',
      phase: entry.phase || patch?.phase || current?.phase || '',
      count: Number(entry.count ?? patch?.count ?? current?.count ?? 0)
    });
  }
  return setJob({ ...(patch || {}), log: log.slice(-40) });
}

function formatRunLog(job) {
  if (!job) return 'Нет данных о последнем запуске.';
  const lines = [];
  lines.push('ChatGPT Archiver run');
  lines.push('jobId: ' + (job.jobId || ''));
  lines.push('mode: ' + (job.captureMode || 'full'));
  lines.push('status: ' + (job.status || ''));
  lines.push('phase: ' + (job.phase || ''));
  lines.push('count: ' + Number(job.count || 0));
  if (job.draftCount) lines.push('draftCount: ' + Number(job.draftCount || 0));
  if (job.archiveId) lines.push('archiveId: ' + job.archiveId);
  if (job.message) lines.push('message: ' + job.message);
  lines.push('');
  for (const item of job.log || []) {
    const time = item.at ? new Date(item.at).toLocaleTimeString('ru-RU') : '--:--:--';
    const meta = [item.phase, Number.isFinite(item.count) ? item.count + ' msg' : ''].filter(Boolean).join(' · ');
    lines.push('[' + time + '] ' + (item.level || 'info').toUpperCase() + ' ' + (item.code || '') +
      (meta ? ' · ' + meta : '') + (item.message ? ' — ' + item.message : ''));
  }
  return lines.join('\n');
}

async function getArchive(id) {
  if (!id) return null;
  const result = await chrome.storage.local.get(archiveKey(id));
  return result[archiveKey(id)] || null;
}

async function getDraft(id) {
  if (!id) return null;
  const result = await chrome.storage.local.get(DRAFT_PREFIX + id);
  return result[DRAFT_PREFIX + id] || null;
}

async function cleanupTemporaryBaseline(job) {
  if (!job?.baselineArchiveId) return;
  await chrome.storage.local.remove(archiveKey(job.baselineArchiveId)).catch(() => {});
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

async function getLinkedDoc(chatUrl = '') {
  const key = conversationKey(chatUrl);
  if (!key) return null;

  const result = await chrome.storage.local.get([DOC_LINKS_KEY, DOC_EXPORTS_KEY]);
  const direct = (result[DOC_LINKS_KEY] || {})[key] || null;
  if (direct) return direct;

  // Backward compatibility: versions before linked-doc state stored only
  // docId -> conversationKey in docExports. Recover that relationship so an
  // already exported document can immediately become the Continue target.
  const exports = result[DOC_EXPORTS_KEY] || {};
  for (const [docId, entry] of Object.entries(exports)) {
    if (entry?.conversationKey !== key) continue;
    const recovered = {
      url: entry.docUrl || ('https://docs.google.com/document/d/' + docId + '/edit'),
      docId,
      lastMessageId: entry.lastMessageId || '',
      recoveredFromLegacyExport: true,
      updatedAt: Date.now()
    };
    await setLinkedDoc(chatUrl, recovered);
    return recovered;
  }

  return null;
}

async function setLinkedDoc(chatUrl = '', docInfo = null) {
  const key = conversationKey(chatUrl);
  if (!key || !docInfo?.url) return null;
  const result = await chrome.storage.local.get(DOC_LINKS_KEY);
  const links = { ...(result[DOC_LINKS_KEY] || {}) };
  links[key] = {
    ...docInfo,
    url: normalizeGoogleDocUrl(docInfo.url) || docInfo.url,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [DOC_LINKS_KEY]: links });
  return links[key];
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
    existingArchiveId: options.existingArchiveId || '',
    resumeAnchorSignature: options.resumeAnchorSignature || '',
    resumeTailSignatures: Array.isArray(options.resumeTailSignatures) ? options.resumeTailSignatures : []
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

async function probeChatDom(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const roleSelector = [
          '[data-message-author-role="user"]',
          '[data-message-author-role="assistant"]',
          '[data-role="user"]',
          '[data-role="assistant"]',
          '[data-message-author="user"]',
          '[data-message-author="assistant"]'
        ].join(',');
        const shellSelector = [
          'section[data-turn="user"]',
          'section[data-turn="assistant"]',
          'article[data-turn="user"]',
          'article[data-turn="assistant"]',
          '[data-testid^="conversation-turn-"]',
          '[data-chatgpt-search-unit-key$=":user"]',
          '[data-chatgpt-search-unit-key$=":assistant"]',
          '[data-turn-key]'
        ].join(',');
        const bodyText = String(document.body?.innerText || '');
        const loadError = /Не удалось загрузить этот разговор ChatGPT|Failed to load this conversation/i.test(bodyText);
        const retryAvailable = [...document.querySelectorAll('button, [role="button"]')].some(el =>
          /^(Попробовать снова|Try again|Retry)$/i.test(String(el.innerText || el.textContent || '').trim())
        );
        return {
          href: location.href,
          readyState: document.readyState,
          visibility: document.visibilityState,
          roleCount: document.querySelectorAll(roleSelector).length,
          shellCount: document.querySelectorAll(shellSelector).length,
          loadError,
          retryAvailable
        };
      }
    });
    return result?.result || null;
  } catch (_) {
    return null;
  }
}

async function clickChatRetry(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const button = [...document.querySelectorAll('button, [role="button"]')].find(el =>
          /^(Попробовать снова|Try again|Retry)$/i.test(String(el.innerText || el.textContent || '').trim())
        );
        if (!button) return false;
        button.click();
        return true;
      }
    });
    return Boolean(result?.result);
  } catch (_) {
    return false;
  }
}

async function waitForChatDomReady(tabId, timeout = 45000, onRetry = null) {
  const started = Date.now();
  let last = null;
  let retries = 0;
  let nextRetryAt = 0;

  while (Date.now() - started < timeout) {
    last = await probeChatDom(tabId);
    if (last && (last.roleCount > 0 || last.shellCount > 0)) return { ...last, retries };

    if (last?.loadError && retries < 3 && Date.now() >= nextRetryAt) {
      const clicked = await clickChatRetry(tabId);
      retries += 1;
      if (onRetry) {
        try { await onRetry(retries, clicked, last); } catch (_) {}
      }
      const backoff = retries === 1 ? 1800 : retries === 2 ? 3500 : 6500;
      nextRetryAt = Date.now() + backoff;
      await sleep(backoff);
      continue;
    }

    if (last?.loadError && retries >= 3) {
      throw new Error(
        'Рабочая копия ChatGPT трижды не загрузила разговор. Попробуйте режим «Текущая вкладка».'
      );
    }

    await sleep(300);
  }

  const detail = last
    ? (' role-узлов: ' + last.roleCount + ', оболочек: ' + last.shellCount +
       ', visibility: ' + last.visibility + ', readyState: ' + last.readyState +
       (last.loadError ? ', ChatGPT показал ошибку загрузки разговора' : '') + '.')
    : '';

  throw new Error(
    'ChatGPT не отрисовал реплики в рабочей вкладке за 45 секунд.' + detail +
    ' Попробуйте режим «Текущая вкладка».'
  );
}

async function createBaselineArchiveFromGoogleDoc(chatUrl, baseline) {
  const archiveId = 'doc-baseline-' + baseline.docId + '-' + hashText(chatUrl + ':' + Date.now());
  const messages = baseline.messages.map((item, index) => ({
    ...item,
    id: item.id || ('doc:' + index + ':' + hashText(messageSignature(item.role, item.text)))
  }));
  const archive = {
    id: archiveId,
    kind: 'google-doc-baseline',
    title: baseline.title || 'Google Doc archive',
    sourceUrl: chatUrl,
    capturedAt: new Date().toISOString(),
    messages,
    imageCount: 0,
    externalDocUrl: baseline.targetTabUrl || baseline.inputUrl,
    baselineDocId: baseline.docId,
    baselineTabCount: baseline.tabs.length,
    baselineMeaningfulCount: baseline.meaningfulCount,
    lastCaptureMode: 'sync-baseline',
    lastCaptureAddedCount: 0,
    previousMessageCount: messages.length,
    lastMessageId: messages[messages.length - 1]?.id || ''
  };

  // Keep the imported Google Doc as a temporary baseline only. It must not
  // replace/index the current archive until the ChatGPT tail has been verified.
  await chrome.storage.local.set({
    [archiveKey(archiveId)]: archive
  });
  return archive;
}

async function syncCurrentWithDoc(docUrl, captureTarget = 'copy') {
  const sourceTab = await getActiveTab();
  if (!sourceTab?.id || !isConversationUrl(sourceTab.url || '')) {
    throw new Error('Откройте нужный диалог ChatGPT перед сверкой.');
  }

  const inspection = await inspectAndKickScroll(sourceTab.id);
  const baseline = await readGoogleDocBaseline(docUrl, sourceTab.id);
  const archive = await createBaselineArchiveFromGoogleDoc(inspection.href, baseline);
  const targetDocUrl = baseline.targetTabUrl || baseline.inputUrl;

  await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
  await sleep(120);

  const result = await startCapture({
    mode: 'sync',
    docUrl: targetDocUrl,
    existingArchive: archive,
    resumeTailSignatures: baseline.tailSignatures,
    captureTarget
  });

  return {
    ...result,
    archive: summarize(archive),
    pendingDoc: {
      url: targetDocUrl,
      docId: baseline.docId,
      tabCount: baseline.tabs.length,
      baselineMessageCount: baseline.messages.length,
      baselineMeaningfulCount: baseline.meaningfulCount
    },
    baseline: {
      tabCount: baseline.tabs.length,
      messageCount: baseline.messages.length,
      meaningfulCount: baseline.meaningfulCount
    }
  };
}

async function startCapture({
  mode = 'full',
  docUrl = '',
  existingArchive: providedArchive = null,
  resumeTailSignatures = [],
  captureTarget = 'copy'
} = {}) {
  const sourceTab = await getActiveTab();
  if (!sourceTab?.id) throw new Error('Не удалось определить активную вкладку.');

  if (!isChatGptHost(sourceTab.url || '')) {
    throw makeCaptureError('WRONG_SITE', 'Откройте ChatGPT в активной вкладке.');
  }

  captureTarget = captureTarget === 'current' ? 'current' : 'copy';

  const current = await getJob();
  if (current && ['starting', 'running', 'paused'].includes(current.status)) {
    if (current.tabId === sourceTab.id) return { ok: true, job: current, alreadyRunning: true };
    throw new Error('Другой сбор переписки уже выполняется.');
  }

  const inspection = await inspectAndKickScroll(sourceTab.id);
  let existingArchive = providedArchive;

  if ((mode === 'continue' || mode === 'sync') && !existingArchive) {
    existingArchive = await getArchiveForUrl(inspection.href);
  }

  if (mode === 'continue' && !existingArchive?.messages?.length) {
    throw new Error('Для этого чата нет локальной точки продолжения. Используйте «Сверить» с Google Doc.');
  }

  const requestedDocUrl = normalizeGoogleDocUrl(docUrl);
  const currentLink = await getLinkedDoc(inspection.href);
  const pendingDocUrl = requestedDocUrl || currentLink?.url || '';

  if (requestedDocUrl && mode !== 'sync') {
    await setLinkedDoc(inspection.href, {
      ...(currentLink || {}),
      url: requestedDocUrl,
      docId: googleDocKey(requestedDocUrl)
    });
  }

  const jobId = makeJobId();
  let captureTab = null;
  let domProbe = null;

  try {
    if (captureTarget === 'current') {
      captureTab = await chrome.tabs.get(sourceTab.id);
      domProbe = await waitForChatDomReady(sourceTab.id, 15000);
    } else {
      captureTab = await chrome.tabs.create({ url: inspection.href, active: true });
      if (!captureTab?.id) throw new Error('Не удалось открыть рабочую копию для сбора.');

      await chrome.tabs.update(captureTab.id, { autoDiscardable: false }).catch(() => {});
      captureTab = await waitForChatTabComplete(captureTab.id);
      domProbe = await waitForChatDomReady(captureTab.id, 45000);
    }

    const modeLabel = mode === 'sync' ? 'сверка' : mode === 'continue' ? 'продолжение' : 'полный сбор';
    const targetLabel = captureTarget === 'current' ? 'текущая вкладка' : 'рабочая копия';

    await setJob({
      jobId,
      tabId: sourceTab.id,
      sourceTabId: sourceTab.id,
      captureTabId: captureTab.id,
      sourceUrl: inspection.href,
      status: 'starting',
      phase: 'top',
      captureMode: mode,
      captureTarget,
      baselineArchiveId: mode === 'sync' ? (existingArchive?.id || '') : '',
      pendingDocUrl,
      message: mode === 'full'
        ? (captureTarget === 'current'
            ? 'Текущая вкладка готова; иду к началу…'
            : 'Рабочая копия загружена; иду к началу…')
        : (captureTarget === 'current'
            ? 'Текущая вкладка готова; ищу последний сохраненный стык…'
            : 'Рабочая копия загружена; ищу последний сохраненный стык…'),
      count: 0,
      addedCount: 0,
      imageCount: 0,
      startedAt: Date.now(),
      domProbe,
      log: [{
        at: Date.now(),
        level: 'info',
        code: 'RUN_STARTED',
        message: 'Запущен режим: ' + modeLabel + '; источник: ' + targetLabel + '.',
        phase: 'top',
        count: 0
      }, {
        at: Date.now(),
        level: 'info',
        code: captureTarget === 'current' ? 'CURRENT_TAB_READY' : 'CAPTURE_TAB_HYDRATED',
        message: 'ChatGPT отрисовал реплики: role=' +
          Number(domProbe?.roleCount || 0) + ', shells=' + Number(domProbe?.shellCount || 0) + '.',
        phase: 'top',
        count: 0
      }]
    });

    const lastExistingMessage = existingArchive?.messages?.[existingArchive.messages.length - 1] || null;
    const resumeAnchorId = mode === 'sync' ? '' : (existingArchive?.lastMessageId || lastExistingMessage?.id || '');
    const resumeAnchorSignature = mode === 'sync'
      ? (resumeTailSignatures[resumeTailSignatures.length - 1] || '')
      : (lastExistingMessage ? messageSignature(lastExistingMessage.role, lastExistingMessage.text) : '');

    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode,
      resumeAnchorId,
      resumeAnchorSignature,
      resumeTailSignatures,
      existingArchiveId: existingArchive?.id || ''
    });

    if (captureTarget === 'copy') {
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
      await appendRunLog({
        status: 'running',
        message: mode === 'full'
          ? 'Сбор идет в рабочей копии…'
          : 'Добираю сообщения после найденного стыка в рабочей копии…',
        phase: 'top'
      }, {
        level: 'info',
        code: 'SOURCE_TAB_RESTORED',
        message: 'Фокус возвращен в исходный чат; рабочая копия продолжает сбор.',
        phase: 'top',
        count: 0
      });
    } else {
      await appendRunLog({
        status: 'running',
        message: mode === 'full'
          ? 'Физически прокручиваю текущую вкладку…'
          : 'Ищу стык и добираю хвост в текущей вкладке…',
        phase: 'top'
      }, {
        level: 'info',
        code: 'CURRENT_TAB_CAPTURE_STARTED',
        message: 'Сбор идет прямо в текущей вкладке; прокрутка будет видна.',
        phase: 'top',
        count: 0
      });
    }

    return {
      ok: true,
      job: await getJob(),
      linkedDoc: await getLinkedDoc(inspection.href)
    };
  } catch (error) {
    if (captureTarget === 'copy' && captureTab?.id && captureTab.id !== sourceTab.id) {
      await chrome.tabs.remove(captureTab.id).catch(() => {});
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
    }

    if (mode === 'sync' && existingArchive?.id) {
      await chrome.storage.local.remove(archiveKey(existingArchive.id)).catch(() => {});
    }

    const rawMessage = error?.message || String(error);
    const message = captureTarget === 'copy' &&
      !/Текущая вкладка/i.test(rawMessage)
      ? rawMessage + ' Можно повторить в режиме «Текущая вкладка».'
      : rawMessage;

    await setJob({
      jobId,
      tabId: sourceTab.id,
      sourceTabId: sourceTab.id,
      captureTabId: null,
      sourceUrl: inspection.href,
      status: 'error',
      phase: 'starting',
      captureMode: mode,
      captureTarget,
      pendingDocUrl,
      message,
      finishedAt: Date.now(),
      log: [{
        at: Date.now(),
        level: 'error',
        code: captureTarget === 'copy' ? 'WORKING_COPY_START_FAILED' : 'CURRENT_TAB_START_FAILED',
        message,
        phase: 'starting',
        count: 0
      }]
    });
    throw new Error(message);
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

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }
  await cleanupTemporaryBaseline(job);

  const next = await appendRunLog({
    status: 'cancelled',
    message: 'Сбор отменен.',
    finishedAt: Date.now(),
    captureTabId: null
  }, {
    level: 'warn',
    code: 'RUN_CANCELLED',
    message: 'Сбор отменен пользователем.',
    phase: job.phase || '',
    count: Number(job.count || 0)
  });
  return { ok: true, job: next };
}

async function finishJobWithError(jobId, sourceTabId, message, draftId = '', draftCount = 0, status = 'error') {
  const job = await getJob();
  if (job?.jobId !== jobId) return;

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }
  await cleanupTemporaryBaseline(job);

  await appendRunLog({
    status,
    message,
    draftId,
    draftCount,
    finishedAt: Date.now(),
    tabId: sourceTabId ?? job.sourceTabId ?? job.tabId,
    captureTabId: null
  }, {
    level: status === 'cancelled' ? 'warn' : 'error',
    code: draftId ? 'RUN_FAILED_WITH_DRAFT' : 'RUN_FAILED',
    message: draftId
      ? ('Сбор завершился ошибкой; сохранен черновик на ' + Number(draftCount || 0) + ' сообщений.')
      : message,
    phase: job.phase || '',
    count: Number(job.count || 0)
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

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }

  const addedCount = Number(message.addedCount || archive.lastCaptureAddedCount || 0);
  let docResult = null;
  let docError = '';

  if (job.pendingDocUrl) {
    try {
      const delta = addedCount > 0 ? archive.messages.slice(-addedCount) : [];
      docResult = await appendMessagesToGoogleDocUrl(
        archive,
        delta,
        job.pendingDocUrl,
        job.sourceTabId ?? job.tabId
      );
    } catch (error) {
      docError = error?.message || String(error);
    }
  }

  const isContinuation = message.mode === 'continue' || message.mode === 'sync';
  let finalMessage = isContinuation
    ? ('Архив продолжен: +' + addedCount + ' сообщений.')
    : 'Переписка собрана.';

  if (job.pendingDocUrl) {
    if (docError) finalMessage += ' Google Doc не обновлен: ' + docError;
    else if (docResult?.addedCount) finalMessage += ' В Google Doc добавлено ' + docResult.addedCount + '.';
    else finalMessage += ' В Google Doc новых сообщений для вставки нет.';
  }

  await appendRunLog({
    status: 'done',
    phase: 'done',
    message: finalMessage,
    count: archive.messages?.length || 0,
    addedCount,
    imageCount: archive.imageCount || 0,
    archiveId: archive.id,
    docUrl: docResult?.docUrl || job.pendingDocUrl || '',
    docExportError: docError,
    finishedAt: Date.now(),
    captureTabId: null
  }, {
    level: docError ? 'warn' : 'info',
    code: docError ? 'ARCHIVE_SAVED_DOC_APPEND_FAILED' : (job.pendingDocUrl ? 'ARCHIVE_SAVED_AND_DOC_APPENDED' : 'ARCHIVE_SAVED'),
    message: finalMessage,
    phase: 'done',
    count: archive.messages?.length || 0
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

async function readClipboardText() {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ type: 'ARCHIVER_OFFSCREEN_READ', target: 'offscreen' });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось прочитать текст из буфера обмена.');
  return String(result.text || '');
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

async function googleDocPageState(tabId) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `({
      href: location.href,
      title: document.title,
      readyState: document.readyState
    })`,
    returnByValue: true
  });
  return result?.result?.value || {};
}

async function focusGoogleDocEditor(tabId) {
  const point = await editorPoint(tabId);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  });
  await sleep(250);
}

async function copyCurrentGoogleDocTabText(tabId) {
  await focusGoogleDocEditor(tabId);
  await dispatchKey(tabId, 'a', 'KeyA', 65, 2);
  await sleep(120);
  await dispatchKey(tabId, 'c', 'KeyC', 67, 2);
  await sleep(220);
  const text = await readClipboardText();
  await dispatchKey(tabId, 'Escape', 'Escape', 27, 0).catch(() => {});
  return text;
}

function googleDocMarkerRole(line = '') {
  const value = normalizeMatchText(line);
  if (/^Пользователь(?:\s*\/\s*[^:]+)?:$/i.test(value)) return 'user';
  if (/^ChatGPT(?:\s*\/\s*[^:]+)?:$/i.test(value)) return 'assistant';
  return '';
}

function plainMessageHtml(text = '') {
  return normalizeDisplayText(text)
    .split(/\n{2,}/)
    .map(part => '<p>' + escapeHtml(part).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

function parseGoogleDocTabMessages(text = '', tabUrl = '', tabIndex = 0) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const messages = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const body = normalizeDisplayText(current.lines.join('\n'));
    messages.push({
      id: 'doc:' + tabIndex + ':' + messages.length + ':' + hashText(messageSignature(current.role, body)),
      role: current.role,
      text: body,
      html: plainMessageHtml(body),
      images: [],
      reasoningHtml: '',
      reasoningText: '',
      reasoningLabel: '',
      reasoningCount: 0,
      baselineTabUrl: tabUrl
    });
    current = null;
  };

  for (const raw of lines) {
    const line = normalizeMatchText(raw);
    const role = googleDocMarkerRole(line);
    if (role) {
      flush();
      current = { role, lines: [] };
      continue;
    }
    if (!current) continue;
    if (/^ChatGPT сказал:$/i.test(line) || /^ChatGPT said:$/i.test(line)) continue;
    current.lines.push(raw);
  }
  flush();
  return messages;
}

async function readGoogleDocBaseline(docUrl, sourceTabId) {
  const normalizedUrl = normalizeGoogleDocUrl(docUrl);
  if (!normalizedUrl) throw new Error('Нужна ссылка на Google Doc вида docs.google.com/document/d/...');

  let tab = null;
  let attached = false;
  try {
    tab = await chrome.tabs.create({ url: normalizedUrl, active: true });
    if (!tab?.id) throw new Error('Не удалось открыть Google Doc для сверки.');
    await waitForTabComplete(tab.id);
    await sleep(1800);

    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    attached = true;
    await focusGoogleDocEditor(tab.id);

    // Go to the first document tab. Google Docs officially maps Ctrl+Shift+PgUp/PgDown
    // to previous/next document tab while the editor has focus.
    let state = await googleDocPageState(tab.id);
    for (let i = 0; i < 100; i++) {
      const before = googleDocTabToken(state.href);
      await dispatchKey(tab.id, 'PageUp', 'PageUp', 33, 10);
      await sleep(220);
      const next = await googleDocPageState(tab.id);
      if (googleDocTabToken(next.href) === before) {
        state = next;
        break;
      }
      state = next;
    }

    const tabs = [];
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      state = await googleDocPageState(tab.id);
      const token = googleDocTabToken(state.href);
      if (seen.has(token)) break;
      seen.add(token);

      const text = await copyCurrentGoogleDocTabText(tab.id);
      tabs.push({
        index: tabs.length,
        token,
        url: state.href,
        title: state.title || '',
        text
      });

      await focusGoogleDocEditor(tab.id);
      await dispatchKey(tab.id, 'PageDown', 'PageDown', 34, 10);
      await sleep(260);
      const after = await googleDocPageState(tab.id);
      if (googleDocTabToken(after.href) === token) break;
    }

    const messages = [];
    for (const item of tabs) {
      messages.push(...parseGoogleDocTabMessages(item.text, item.url, item.index));
    }

    const meaningful = messages.filter(item => normalizeMatchText(item.text));
    if (meaningful.length < 2) {
      throw new Error('В Google Doc не удалось найти достаточно реплик для надежной сверки.');
    }

    const tail = meaningful.slice(-6);
    const target = tail[tail.length - 1];
    return {
      docId: googleDocKey(normalizedUrl),
      inputUrl: normalizedUrl,
      tabs,
      messages,
      meaningfulCount: meaningful.length,
      tailSignatures: tail.map(item => externalMatchSignature(item.role, item.text)),
      targetTabUrl: target?.baselineTabUrl || tabs[tabs.length - 1]?.url || normalizedUrl,
      title: String(tab.title || '').replace(/\s*[–—-]\s*Google Docs\s*$/i, '').trim()
    };
  } finally {
    if (attached && tab?.id) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    if (sourceTabId != null) await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  }
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

async function recordDocExport(conversation, docUrl) {
  const docKey = googleDocKey(docUrl);
  if (!docKey || !conversation) return null;

  const result = await chrome.storage.local.get(DOC_EXPORTS_KEY);
  const exports = result[DOC_EXPORTS_KEY] || {};
  const lastMessageId = conversation.messages?.[conversation.messages.length - 1]?.id || '';
  exports[docKey] = {
    conversationKey: conversationKey(conversation.sourceUrl),
    archiveId: conversation.id,
    lastMessageId,
    docUrl,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [DOC_EXPORTS_KEY]: exports });

  return setLinkedDoc(conversation.sourceUrl, {
    url: docUrl,
    docId: docKey,
    lastMessageId
  });
}

async function appendMessagesToGoogleDocUrl(conversation, messages, docUrl, sourceTabId = null) {
  const normalizedUrl = normalizeGoogleDocUrl(docUrl);
  if (!normalizedUrl) throw new Error('Некорректная ссылка на Google Doc.');

  if (!messages?.length) {
    const linkedDoc = await recordDocExport(conversation, normalizedUrl);
    return { docUrl: normalizedUrl, addedCount: 0, noChanges: true, linkedDoc };
  }

  const settings = await getSettings();
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: normalizedUrl, active: true });
    if (!tab?.id) throw new Error('Не удалось открыть Google Doc для продолжения.');
    await waitForTabComplete(tab.id);
    await sleep(1800);

    await writeClipboard(
      buildRichHtml(conversation, settings, { messages, includeHeader: false }),
      buildPlainText(conversation, settings, { messages, includeHeader: false })
    );

    const finalTab = await pasteIntoGoogleDoc(tab.id, { appendToEnd: true });
    const linkedDoc = await recordDocExport(conversation, finalTab.url || normalizedUrl);
    return {
      docUrl: finalTab.url || normalizedUrl,
      addedCount: messages.length,
      noChanges: false,
      linkedDoc
    };
  } finally {
    if (sourceTabId != null) await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  }
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
  const linkedDoc = await recordDocExport(conversation, finalTab.url);

  return {
    docUrl: finalTab.url,
    archive: summarize(conversation),
    linkedDoc,
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
        return await startCapture({
          mode: 'full',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_CONTINUE_CURRENT':
        return await startCapture({
          mode: 'continue',
          docUrl: message.docUrl || '',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_SYNC_CURRENT':
        return await syncCurrentWithDoc(
          message.docUrl || '',
          message.captureTarget || 'copy'
        );
      case 'ARCHIVER_GET_STATE': {
        const job = await getJob();
        const tab = await getActiveTab();
        let currentArchive = null;
        let linkedDoc = null;
        if (tab?.url && isConversationUrl(tab.url)) {
          currentArchive = await getArchiveForUrl(tab.url);
          linkedDoc = await getLinkedDoc(tab.url);
        }
        const archive = currentArchive || await getLastArchive();
        const draft = job?.draftId ? await getDraft(job.draftId) : null;
        return {
          ok: true,
          job,
          archive: summarize(archive),
          draft: summarize(draft),
          linkedDoc,
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
          return { ok: false, error: 'Прогресс пришел не из вкладки сбора.' };
        }
        const phaseChanged = message.patch?.phase && message.patch.phase !== job.phase;
        const notable = phaseChanged || message.patch?.boundaryReached || message.patch?.anchorReached;
        if (notable) {
          await appendRunLog(
            { ...message.patch, tabId: job.sourceTabId ?? job.tabId },
            {
              level: 'info',
              code: message.patch?.boundaryReached
                ? 'BOUNDARY_REACHED'
                : message.patch?.anchorReached
                  ? 'RESUME_ANCHOR_REACHED'
                  : 'PHASE_CHANGED',
              message: message.patch?.message || '',
              phase: message.patch?.phase || job.phase,
              count: Number(message.patch?.count || 0)
            }
          );
        } else {
          await setJob({ ...message.patch, tabId: job.sourceTabId ?? job.tabId });
        }
        return { ok: true };
      }
      case 'ARCHIVER_PHYSICAL_SCROLL': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId) return { ok: false, error: 'Сбор уже неактуален.' };
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId == null || senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Физическая прокрутка разрешена только вкладке текущего сбора.' };
        }
        return await physicalScrollTab(job.captureTabId, message.direction, message.bursts);
      }
      case 'ARCHIVER_CAPTURE_FAILED': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId) return { ok: true };
        await finishJobWithError(
          message.jobId,
          job.sourceTabId ?? job.tabId,
          message.error || 'Сбор не выполнен.',
          message.draftId || '',
          Number(message.draftCount || 0),
          message.status === 'cancelled' ? 'cancelled' : 'error'
        );
        return { ok: true };
      }
      case 'ARCHIVER_COPY_ARCHIVE': {
        const archive = await getArchive(message.archiveId) || await getLastArchive();
        if (!archive) throw new Error('Нет завершенного архива для копирования.');
        const settings = await getSettings();
        await writeClipboard(buildRichHtml(archive, settings), buildPlainText(archive, settings));
        return { ok: true, count: archive.messages?.length || 0 };
      }
      case 'ARCHIVER_COPY_DRAFT': {
        const draft = await getDraft(message.draftId);
        if (!draft) throw new Error('Черновик текущего прохода не найден.');
        const settings = await getSettings();
        await writeClipboard(
          buildRichHtml(draft, settings, { includeHeader: true }),
          buildPlainText(draft, settings, { includeHeader: true })
        );
        return { ok: true, count: draft.messages?.length || 0 };
      }
      case 'ARCHIVER_COPY_RUN_LOG': {
        const job = await getJob();
        const text = formatRunLog(job);
        await writeClipboard('<pre>' + escapeHtml(text) + '</pre>', text);
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
