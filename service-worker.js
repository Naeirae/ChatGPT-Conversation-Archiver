import {
  buildGoogleDocBaseline
} from './lib/google-docs-baseline.mjs';

import {
  createArchiveStore,
  summarizeArchive
} from './lib/archive-store.mjs';

import {
  findExportTailAnchor,
  hashText,
  messageSignature
} from './lib/text.mjs';

import {
  conversationKey,
  googleDocKey,
  googleDocTabToken,
  unseenGoogleDocTabToken,
  isChatGptHost,
  isConversationUrl,
  normalizeGoogleDocUrl
} from './lib/urls.mjs';

import {
  buildTabbedSections,
  parseTabPlan
} from './lib/tab-plan.mjs';

const ACTIVE_JOB_KEY = 'activeCaptureJob';
const RUN_HISTORY_KEY = 'captureRunHistory';
const DOCS_NEW_URL = 'https://docs.new';
const SETTINGS_KEY = 'archiverSettings';
const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false, captureTarget: 'copy' };
async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

const archiveStore = createArchiveStore(chrome.storage.local);
const {
  getArchive,
  putArchive,
  removeArchive,
  getDraft,
  getLastArchive,
  getArchiveForUrl,
  indexArchive,
  getLinkedDoc,
  setLinkedDoc,
  getDocExport,
  recordDocExport
} = archiveStore;
const summarize = summarizeArchive;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function getRunHistory() {
  const result = await chrome.storage.local.get(RUN_HISTORY_KEY);
  return Array.isArray(result[RUN_HISTORY_KEY]) ? result[RUN_HISTORY_KEY] : [];
}

async function recordRunHistory(job) {
  if (!job?.jobId) return;
  const history = await getRunHistory();
  const summary = {
    jobId: job.jobId,
    sourceUrl: job.sourceUrl || '',
    captureMode: job.captureMode || 'full',
    captureTarget: job.captureTarget || 'copy',
    status: job.status || '',
    phase: job.phase || '',
    count: Number(job.count || 0),
    addedCount: Number(job.addedCount || 0),
    reasoningBlockCount: Number(job.reasoningBlockCount || 0),
    draftCount: Number(job.draftCount || 0),
    archiveId: job.archiveId || '',
    message: job.message || '',
    startedAt: Number(job.startedAt || 0),
    finishedAt: Number(job.finishedAt || Date.now())
  };
  const next = [summary, ...history.filter(item => item?.jobId !== job.jobId)].slice(0, 20);
  await chrome.storage.local.set({ [RUN_HISTORY_KEY]: next });
}

async function pauseCapture() {
  const job = await getJob();
  if (!job || !['starting', 'running'].includes(job.status)) return { ok: true, job };

  if (job.captureTabId != null) {
    const result = await chrome.tabs.sendMessage(job.captureTabId, {
      type: 'ARCHIVER_PAUSE_CAPTURE',
      jobId: job.jobId
    }).catch(() => ({ ok: false }));
    if (result && result.ok === false) throw new Error(result.error || 'Не удалось поставить сбор на паузу.');
  }

  const next = await appendRunLog({
    status: 'paused',
    pauseReason: 'user',
    resumePhase: job.phase === 'paused' ? (job.resumePhase || 'top') : (job.phase || 'top'),
    phase: 'paused',
    message: 'Сбор поставлен на паузу.'
  }, {
    level: 'info',
    code: 'RUN_PAUSED_BY_USER',
    message: 'Сбор поставлен на паузу пользователем.',
    phase: job.phase || '',
    count: Number(job.count || 0)
  });
  return { ok: true, job: next };
}

async function resumeCapture() {
  const job = await getJob();
  if (!job || job.status !== 'paused') return { ok: true, job };
  if (job.pauseReason && job.pauseReason !== 'user') {
    throw new Error('Сбор приостановлен браузером. Дождитесь, пока рабочая вкладка снова станет доступна.');
  }

  if (job.captureTabId != null) {
    const result = await chrome.tabs.sendMessage(job.captureTabId, {
      type: 'ARCHIVER_RESUME_CAPTURE',
      jobId: job.jobId
    }).catch(() => ({ ok: false }));
    if (result && result.ok === false) throw new Error(result.error || 'Не удалось продолжить сбор.');
  }

  const resumePhase = job.resumePhase || 'top';
  const next = await appendRunLog({
    status: 'running',
    pauseReason: '',
    phase: resumePhase,
    message: 'Сбор продолжен.'
  }, {
    level: 'info',
    code: 'RUN_RESUMED_BY_USER',
    message: 'Сбор продолжен пользователем.',
    phase: resumePhase,
    count: Number(job.count || 0)
  });
  return { ok: true, job: next };
}

async function resetCaptureState() {
  const job = await getJob();
  if (job && ['starting', 'running', 'paused'].includes(job.status)) {
    throw new Error('Сначала остановите текущий сбор.');
  }
  if (job?.draftId) {
    await chrome.storage.local.remove('draft:' + job.draftId).catch(() => {});
  }
  if (job?.tabId != null) {
    await chrome.action.setBadgeText({ tabId: job.tabId, text: '' }).catch(() => {});
    await chrome.action.setTitle({ tabId: job.tabId, title: 'Архиватор ChatGPT' }).catch(() => {});
  }
  await chrome.storage.local.remove(ACTIVE_JOB_KEY);
  return { ok: true };
}

async function clearRunHistory() {
  await chrome.storage.local.remove(RUN_HISTORY_KEY);
  return { ok: true, history: [] };
}

function formatRunLog(job) {
  if (!job) return 'Нет данных о последнем запуске.';
  const lines = [];
  lines.push('ChatGPT Archiver run');
  lines.push('jobId: ' + (job.jobId || ''));
  lines.push('mode: ' + (job.captureMode || 'full'));
  lines.push('captureTarget: ' + (job.captureTarget || 'copy'));
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

async function cleanupTemporaryBaseline(job) {
  if (!job?.baselineArchiveId) return;
  await removeArchive(job.baselineArchiveId).catch(() => {});
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
  await putArchive(archive);
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

  if ((mode === 'continue' || mode === 'sync' || mode === 'compare') && !existingArchive) {
    existingArchive = await getArchiveForUrl(inspection.href);
  }

  if ((mode === 'continue' || mode === 'compare') && !existingArchive?.messages?.length) {
    throw new Error('Для этого чата нет локального архива. Сначала соберите переписку или восстановите стык по Google Doc.');
  }

  const requestedDocUrl = normalizeGoogleDocUrl(docUrl);
  const currentLink = await getLinkedDoc(inspection.href);

  // A full rebuild refreshes the local archive only. It must never append the
  // whole rebuilt archive to an already-linked Google Doc. Automatic Docs
  // append is reserved for verified continuation/sync deltas.
  const currentLinkedUrl = normalizeGoogleDocUrl(currentLink?.url || '');
  const pendingDocUrl = (mode === 'continue' || mode === 'sync')
    ? (requestedDocUrl || currentLinkedUrl || '')
    : '';
  const pendingDocMode = mode === 'sync'
    ? 'sync'
    : mode === 'continue'
      ? (requestedDocUrl && requestedDocUrl !== currentLinkedUrl
          ? 'explicit'
          : (pendingDocUrl ? 'linked' : 'local-only'))
      : '';

  const jobId = makeJobId();
  let captureTab = null;
  let domProbe = null;

  try {
    if (captureTarget === 'current') {
      captureTab = await chrome.tabs.get(sourceTab.id);
      domProbe = await waitForChatDomReady(sourceTab.id, 15000);
    } else {
      // Restore the last live-proven background capture path (0.3.10):
      // open a dedicated ChatGPT tab in the foreground long enough to hydrate
      // the virtualized conversation DOM, then return focus to the source chat
      // after the collector has started.
      captureTab = await chrome.tabs.create({ url: inspection.href, active: true });
      if (!captureTab?.id) throw new Error('Не удалось открыть рабочую вкладку для фонового сбора.');

      await chrome.tabs.update(captureTab.id, { autoDiscardable: false }).catch(() => {});
      captureTab = await waitForChatTabComplete(captureTab.id);
      domProbe = await waitForChatDomReady(captureTab.id, 45000);
    }

    const modeLabel = mode === 'compare'
      ? 'сверка с локальным архивом'
      : mode === 'sync'
        ? 'восстановление по Google Doc'
        : mode === 'continue'
          ? 'продолжение'
          : 'полный сбор';
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
      pendingDocMode,
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
          ? 'Фоновый сбор идет в рабочей вкладке…'
          : 'Фоново добираю сообщения после найденного стыка…',
        phase: 'top'
      }, {
        level: 'info',
        code: 'SOURCE_TAB_RESTORED',
        message: 'Фокус возвращен в исходный чат; рабочая вкладка продолжает сбор в фоне.',
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
      await removeArchive(existingArchive.id).catch(() => {});
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
      pendingDocMode,
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
    if (job.sourceTabId != null) {
      await chrome.tabs.update(job.sourceTabId, { active: true }).catch(() => {});
    }
  }
  await cleanupTemporaryBaseline(job);

  const next = await appendRunLog({
    status: 'cancelled',
    message: 'Сбор остановлен.',
    finishedAt: Date.now(),
    captureTabId: null
  }, {
    level: 'warn',
    code: 'RUN_CANCELLED',
    message: 'Сбор остановлен пользователем.',
    phase: job.phase || '',
    count: Number(job.count || 0)
  });
  await recordRunHistory(next);
  return { ok: true, job: next };
}

async function finishJobWithError(jobId, sourceTabId, message, draftId = '', draftCount = 0, status = 'error') {
  const job = await getJob();
  if (job?.jobId !== jobId) return;

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
    if (job.sourceTabId != null) {
      await chrome.tabs.update(job.sourceTabId, { active: true }).catch(() => {});
    }
  }
  await cleanupTemporaryBaseline(job);

  const next = await appendRunLog({
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
  await recordRunHistory(next);
}

async function handleCaptureComplete(message) {
  const job = await getJob();
  if (!job || job.jobId !== message.jobId) return;

  const archive = await getArchive(message.archiveId);
  if (!archive) {
    return finishJobWithError(message.jobId, job.sourceTabId ?? job.tabId, 'Архив не найден после завершения сбора.');
  }

  if (message.mode !== 'compare') {
    await indexArchive(archive);
  }

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
    if (job.sourceTabId != null) {
      await chrome.tabs.update(job.sourceTabId, { active: true }).catch(() => {});
    }
  }

  const addedCount = Number(message.addedCount || archive.lastCaptureAddedCount || 0);

  if (message.mode === 'compare') {
    const finalMessage = addedCount
      ? ('Сверка завершена: +' + addedCount + ' новых сообщений относительно локального архива. Архив не изменён.')
      : 'Сверка завершена: новых сообщений относительно локального архива нет. Архив не изменён.';

    const next = await appendRunLog({
      status: 'done',
      phase: 'done',
      captureMode: 'compare',
      message: finalMessage,
      count: Number(message.count || archive.messages?.length || 0),
      addedCount,
      archiveId: archive.id,
      finishedAt: Date.now(),
      captureTabId: null
    }, {
      level: 'info',
      code: 'ARCHIVE_COMPARE_COMPLETE',
      message: finalMessage,
      phase: 'done',
      count: Number(message.count || archive.messages?.length || 0)
    });
    await recordRunHistory(next);
    return;
  }

  let docResult = null;
  let docError = '';

  const isContinuation = message.mode === 'continue' || message.mode === 'sync';
  const shouldAutoAppend = Boolean(isContinuation && job.pendingDocUrl);

  if (shouldAutoAppend) {
    try {
      const delta = addedCount > 0 ? archive.messages.slice(-addedCount) : [];
      docResult = await appendMessagesToGoogleDocUrl(
        archive,
        delta,
        job.pendingDocUrl,
        job.sourceTabId ?? job.tabId,
        { linkTarget: job.pendingDocMode !== 'explicit' }
      );
    } catch (error) {
      docError = error?.message || String(error);
    }
  }

  let finalMessage = isContinuation
    ? ('Архив продолжен: +' + addedCount + ' сообщений.')
    : 'Переписка собрана.';

  if (shouldAutoAppend) {
    if (docError) finalMessage += ' Google Doc не обновлен: ' + docError;
    else if (docResult?.addedCount) {
      finalMessage += ' В Google Doc добавлено ' + docResult.addedCount + ' сообщений';
      if (docResult.imageInsertedCount || docResult.imageFailedCount) {
        finalMessage += ' и ' + Number(docResult.imageInsertedCount || 0) + ' изображений';
        if (docResult.imageFailedCount) finalMessage += ' (' + Number(docResult.imageFailedCount) + ' не вставлено)';
      }
      finalMessage += '.';
    } else finalMessage += ' В Google Doc новых сообщений для вставки нет.';
  }

  const next = await appendRunLog({
    status: 'done',
    phase: 'done',
    message: finalMessage,
    count: archive.messages?.length || 0,
    addedCount,
    imageCount: archive.imageCount || 0,
    archiveId: archive.id,
    docUrl: docResult?.docUrl || (shouldAutoAppend ? job.pendingDocUrl : '') || '',
    docExportError: docError,
    finishedAt: Date.now(),
    captureTabId: null
  }, {
    level: docError ? 'warn' : 'info',
    code: docError
      ? 'ARCHIVE_SAVED_DOC_APPEND_FAILED'
      : (shouldAutoAppend ? 'ARCHIVE_SAVED_AND_DOC_APPENDED' : 'ARCHIVE_SAVED'),
    message: finalMessage,
    phase: 'done',
    count: archive.messages?.length || 0
  });
  await recordRunHistory(next);
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
function messageHtmlForExport(message, { stripImages = false } = {}) {
  let html = String(message?.html || `<p>${escapeHtml(message?.text || '')}</p>`);

  html = html.replace(/<img\b[^>]*>/gi, tag => {
    const indexMatch = tag.match(/data-archiver-image-index=["']?(\d+)["']?/i);
    const index = indexMatch ? Number(indexMatch[1]) : -1;
    const image = index >= 0 ? message?.images?.[index] : null;

    if (stripImages) return '';

    const src = image?.dataUrl || image?.src || '';
    if (!src) return '';

    const escaped = escapeHtml(src);
    if (/\bsrc\s*=\s*["'][^"']*["']/i.test(tag)) {
      return tag.replace(/\bsrc\s*=\s*["'][^"']*["']/i, 'src="' + escaped + '"');
    }
    return tag.replace(/<img\b/i, '<img src="' + escaped + '"');
  });

  if (stripImages) {
    html = html
      .replace(/<p\b[^>]*data-archiver-attachment=["']true["'][^>]*>\s*<\/p>/gi, '')
      .replace(/<div\b[^>]*>\s*<\/div>/gi, '');
  }

  return html;
}

function messageImagesReady(message) {
  return (message?.images || []).filter(image => image?.binaryStatus === 'ready' && image?.dataUrl);
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
    for (const heading of Array.isArray(msg.archiveHeadings) ? msg.archiveHeadings : []) {
      if (heading) chunks.push('<h2>' + escapeHtml(heading) + '</h2>');
    }
    const align = msg.role === 'user' && settings.alignUserRight ? 'right' : 'left';
    chunks.push(`<div style="text-align:${align};">`);
    chunks.push(`<p><strong>${escapeHtml(speakerLabel(msg.role, settings))}</strong></p>`);
    if (settings.includeReasoning && msg.reasoningHtml) {
      const reasoningTitle = msg.reasoningLabel || 'Размышления';
      chunks.push('<div><p><strong>' + escapeHtml(reasoningTitle) + ':</strong></p>');
      chunks.push(msg.reasoningHtml);
      chunks.push('</div>');
    }
    chunks.push(`<div>${messageHtmlForExport(msg, { stripImages: Boolean(options.stripImages) })}</div>`);
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
    for (const heading of Array.isArray(msg.archiveHeadings) ? msg.archiveHeadings : []) {
      if (heading) {
        lines.push(heading);
        lines.push('');
      }
    }
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
async function googleDocsControlRect(tabId, mode = 'add-tab') {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const mode = ${JSON.stringify(mode)};
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0;
      };

      const labelOf = el => [
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('data-tooltip') || '',
        el.getAttribute?.('title') || '',
        el.textContent || ''
      ].join(' ').replace(/\\s+/g, ' ').trim();

      const controls = [...document.querySelectorAll(
        'button,[role="button"],[role="menuitem"],[aria-label],[data-tooltip],[title]'
      )].filter(visible);

      let candidate = null;

      if (mode === 'add-tab') {
        const addPattern = /(?:добавить|создать).{0,24}вкладк|(?:add|new).{0,16}tab/i;
        candidate = controls.find(el => addPattern.test(labelOf(el))) || null;

        if (!candidate) {
          const icon = [...document.querySelectorAll('.docs-icon-add-20x20')].find(visible);
          candidate = icon?.closest('button,[role="button"]') || icon?.parentElement || null;
        }
      } else if (mode === 'tabs-panel') {
        const panelPattern = /вкладк.{0,24}(?:документ|структур)|(?:document|show).{0,24}tabs|tabs.{0,24}(?:outline|document)/i;
        candidate = controls.find(el => panelPattern.test(labelOf(el))) || null;
      } else if (mode === 'add-tab-menuitem') {
        const menuPattern = /^(?:добавить|создать) вкладк|^(?:add|new) tab/i;
        candidate = controls.find(el => menuPattern.test(labelOf(el))) || null;
      }

      if (!candidate || !visible(candidate)) return null;
      const r = candidate.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        label: labelOf(candidate),
        tag: candidate.tagName || ''
      };
    })()`,
    returnByValue: true
  });

  return result?.result?.value || null;
}

async function physicalClick(tabId, point) {
  if (!point) return false;
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
  await sleep(260);
  return true;
}

async function createNextGoogleDocsTab(tabId, seenTokens = new Set()) {
  let attached = false;
  const knownTokens = seenTokens instanceof Set ? seenTokens : new Set(seenTokens || []);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(500);

    for (let attempt = 1; attempt <= 3; attempt++) {
      let before = await googleDocPageState(tabId);
      const beforeToken = googleDocTabToken(before.href);
      if (beforeToken) knownTokens.add(beforeToken);

      let addControl = await googleDocsControlRect(tabId, 'add-tab');
      if (!addControl) {
        const panelControl = await googleDocsControlRect(tabId, 'tabs-panel');
        if (panelControl) {
          await physicalClick(tabId, panelControl);
          await sleep(450);
          addControl = await googleDocsControlRect(tabId, 'add-tab');
        }
      }

      if (!addControl) {
        throw new Error(
          'Не удалось найти кнопку добавления вкладки Google Docs. ' +
          'Откройте панель «Вкладки в документе» и повторите экспорт.'
        );
      }

      await physicalClick(tabId, addControl);
      await sleep(350);

      let state = await googleDocPageState(tabId);
      if (googleDocTabToken(state.href) === beforeToken) {
        const menuItem = await googleDocsControlRect(tabId, 'add-tab-menuitem');
        if (menuItem) {
          await physicalClick(tabId, menuItem);
          await sleep(350);
        }
      }

      const started = Date.now();
      while (Date.now() - started < 4500) {
        state = await googleDocPageState(tabId);
        const token = unseenGoogleDocTabToken(state.href, knownTokens);
        if (token) {
          knownTokens.add(token);
          await sleep(450);
          return {
            ok: true,
            url: state.href,
            token,
            controlLabel: addControl.label || '',
            attempt
          };
        }
        await sleep(180);
      }

      // A mere URL change to an already-seen tab is not creation. Re-open the
      // panel / find the plus again and retry instead of silently pasting the
      // next section into an existing tab.
      await sleep(350);
    }

    throw new Error(
      'Google Docs не создал новую уникальную вкладку после трёх попыток. ' +
      'Экспорт остановлен, чтобы следующая секция не попала в уже существующую вкладку.'
    );
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
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

    const baseline = buildGoogleDocBaseline(tabs, { tailLimit: 6 });
    if (baseline.meaningfulCount < 2) {
      throw new Error('В Google Doc не удалось найти достаточно реплик для надежной сверки.');
    }

    return {
      docId: googleDocKey(normalizedUrl),
      inputUrl: normalizedUrl,
      tabs,
      messages: baseline.messages,
      meaningfulCount: baseline.meaningfulCount,
      tailSignatures: baseline.tailSignatures,
      targetTabUrl: baseline.targetTabUrl || normalizedUrl,
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
    await focusGoogleDocEditor(tabId);
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

async function copyImageClipboardInGoogleDocs(tabId, image) {
  const dataUrl = String(image?.dataUrl || '');
  if (!/^data:image\//i.test(dataUrl)) {
    return { ok: false, error: 'В архиве нет бинарных данных изображения.' };
  }

  const expression = `(async () => {
    const dataUrl = ${JSON.stringify(dataUrl)};
    let clipboardError = '';

    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const type = blob.type || 'image/png';
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        return { ok: true, method: 'navigator.clipboard', type, size: blob.size };
      }
    } catch (error) {
      clipboardError = String(error?.message || error);
    }

    try {
      const host = document.createElement('div');
      host.contentEditable = 'true';
      host.style.position = 'fixed';
      host.style.left = '-10000px';
      host.style.top = '0';
      host.style.opacity = '0';

      const img = document.createElement('img');
      img.src = dataUrl;
      host.appendChild(img);
      document.body.appendChild(host);
      if (img.decode) await img.decode();

      const selection = getSelection();
      const range = document.createRange();
      range.selectNode(img);
      selection.removeAllRanges();
      selection.addRange(range);
      host.focus();

      const ok = document.execCommand('copy');
      selection.removeAllRanges();
      host.remove();

      if (!ok) throw new Error('document.execCommand(copy) returned false');
      return { ok: true, method: 'execCommand-image', type: 'image/png', size: dataUrl.length };
    } catch (error) {
      return {
        ok: false,
        error: (clipboardError ? clipboardError + ' | ' : '') + String(error?.message || error)
      };
    }
  })()`;

  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  return result?.result?.value || { ok: false, error: 'Не удалось подготовить image clipboard.' };
}

async function pasteArchiveIntoGoogleDoc(
  tabId,
  conversation,
  messages,
  settings,
  { includeHeader = true, appendToEnd = false } = {}
) {
  let attached = false;
  let imageInsertedCount = 0;
  let imageFailedCount = 0;
  const failedImages = [];

  const flushText = async (buffer, withHeader) => {
    if (!buffer.length && !withHeader) return;
    const html = buildRichHtml(conversation, settings, {
      messages: buffer,
      includeHeader: withHeader,
      stripImages: true
    });
    const text = buildPlainText(conversation, settings, {
      messages: buffer,
      includeHeader: withHeader
    });
    if (!html.trim() && !text.trim()) return;

    await writeClipboard(html, text);
    await focusGoogleDocEditor(tabId);
    await dispatchKey(tabId, 'End', 'End', 35, 2);
    await sleep(100);
    await dispatchKey(tabId, 'v', 'KeyV', 86, 2);
    await sleep(450);
  };

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(700);
    await focusGoogleDocEditor(tabId);
    if (appendToEnd) {
      await dispatchKey(tabId, 'End', 'End', 35, 2);
      await sleep(180);
    }

    let buffer = [];
    let headerPending = includeHeader;

    for (const message of messages || []) {
      buffer.push(message);
      const ready = messageImagesReady(message);
      const failed = (message.images || []).filter(image => !image?.dataUrl);

      if (!ready.length && !failed.length) continue;

      await flushText(buffer, headerPending);
      buffer = [];
      headerPending = false;

      for (const image of ready) {
        const copied = await copyImageClipboardInGoogleDocs(tabId, image);
        if (!copied?.ok) {
          imageFailedCount++;
          failedImages.push({ src: image.src || '', error: copied?.error || 'clipboard failed' });
          continue;
        }

        await focusGoogleDocEditor(tabId);
        await dispatchKey(tabId, 'End', 'End', 35, 2);
        await sleep(100);
        await dispatchKey(tabId, 'v', 'KeyV', 86, 2);
        await sleep(850);
        await dispatchKey(tabId, 'Enter', 'Enter', 13, 0);
        await sleep(120);
        imageInsertedCount++;
      }

      for (const image of failed) {
        imageFailedCount++;
        failedImages.push({ src: image.src || '', error: image.binaryError || 'binary unavailable' });
      }
    }

    await flushText(buffer, headerPending);
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  return {
    tab: await chrome.tabs.get(tabId),
    imageInsertedCount,
    imageFailedCount,
    failedImages
  };
}

async function appendMessagesToGoogleDocUrl(
  conversation,
  messages,
  docUrl,
  sourceTabId = null,
  { linkTarget = true } = {}
) {
  const normalizedUrl = normalizeGoogleDocUrl(docUrl);
  if (!normalizedUrl) throw new Error('Некорректная ссылка на Google Doc.');

  if (!messages?.length) {
    const linkedDoc = await recordDocExport(conversation, normalizedUrl, { link: linkTarget });
    return { docUrl: normalizedUrl, addedCount: 0, noChanges: true, linkedDoc };
  }

  const settings = await getSettings();
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: normalizedUrl, active: true });
    if (!tab?.id) throw new Error('Не удалось открыть Google Doc для продолжения.');
    await waitForTabComplete(tab.id);
    await sleep(1800);

    const pasted = await pasteArchiveIntoGoogleDoc(
      tab.id,
      conversation,
      messages,
      settings,
      { includeHeader: false, appendToEnd: true }
    );

    const finalTab = pasted.tab;
    const linkedDoc = await recordDocExport(
      conversation,
      finalTab.url || normalizedUrl,
      { link: linkTarget }
    );
    return {
      docUrl: finalTab.url || normalizedUrl,
      addedCount: messages.length,
      noChanges: false,
      linkedDoc,
      imageInsertedCount: pasted.imageInsertedCount || 0,
      imageFailedCount: pasted.imageFailedCount || 0,
      failedImages: pasted.failedImages || []
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

    const previous = await getDocExport(docKey);
    const currentConversationKey = conversationKey(conversation.sourceUrl);

    if (previous?.conversationKey === currentConversationKey) {
      let anchorIndex = -1;

      if (previous.lastMessageId) {
        anchorIndex = messages.findIndex(item => item.id === previous.lastMessageId);
      }

      if (anchorIndex < 0 && Array.isArray(previous.tailSignatures) && previous.tailSignatures.length >= 2) {
        anchorIndex = findExportTailAnchor(messages, previous.tailSignatures);
      }

      if (anchorIndex < 0) {
        throw new Error(
          'Документ уже связан с этим чатом, но точку продолжения подтвердить не удалось. ' +
          'Полный архив не вставлен повторно. Используйте «Сверить».'
        );
      }

      messages = messages.slice(anchorIndex + 1);
      includeHeader = false;
      appendToEnd = true;
      exportMode = 'delta';
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

  const pasted = await pasteArchiveIntoGoogleDoc(
    tab.id,
    conversation,
    messages,
    settings,
    { includeHeader, appendToEnd }
  );
  const finalTab = pasted.tab;
  const linkedDoc = await recordDocExport(conversation, finalTab.url);

  return {
    docUrl: finalTab.url,
    archive: summarize(conversation),
    linkedDoc,
    exportMode,
    addedCount: messages.length,
    imageInsertedCount: pasted.imageInsertedCount || 0,
    imageFailedCount: pasted.imageFailedCount || 0,
    failedImages: pasted.failedImages || [],
    noChanges: false
  };
}

async function exportTabbedConversation(planText = '') {
  const conversation = await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');

  const messages = conversation.messages || [];
  if (!messages.length) throw new Error('В архиве нет сообщений для экспорта.');

  const events = parseTabPlan(planText, messages.length);
  const sections = buildTabbedSections(messages, events);
  if (sections.length > 40) {
    throw new Error('За один экспорт можно создать не более 40 вкладок.');
  }

  const settings = await getSettings();
  const tab = await chrome.tabs.create({ url: DOCS_NEW_URL, active: true });
  if (!tab?.id) throw new Error('Не удалось открыть новый Google Doc.');

  await waitForTabComplete(tab.id);
  await sleep(2500);

  const initialDocTab = await chrome.tabs.get(tab.id);
  const seenTabTokens = new Set([googleDocTabToken(initialDocTab.url || '')].filter(Boolean));

  let imageInsertedCount = 0;
  let imageFailedCount = 0;
  const failedImages = [];
  let completedTabs = 0;

  try {
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];

      if (index > 0) {
        const created = await createNextGoogleDocsTab(tab.id, seenTabTokens);
        if (created?.token) seenTabTokens.add(created.token);
      }

      const pasted = await pasteArchiveIntoGoogleDoc(
        tab.id,
        conversation,
        section.messages,
        settings,
        {
          includeHeader: index === 0,
          appendToEnd: false
        }
      );

      imageInsertedCount += Number(pasted.imageInsertedCount || 0);
      imageFailedCount += Number(pasted.imageFailedCount || 0);
      failedImages.push(...(pasted.failedImages || []));
      completedTabs++;
    }
  } catch (error) {
    throw new Error(
      'Разделение остановлено после ' + completedTabs + ' из ' + sections.length +
      ' вкладок. Документ оставлен открытым. Причина: ' +
      (error?.message || String(error))
    );
  }

  const finalTab = await chrome.tabs.get(tab.id);
  const linkedDoc = await recordDocExport(conversation, finalTab.url);
  const headingCount = events.filter(event => event.type === 'heading').length;

  return {
    docUrl: finalTab.url,
    archive: summarize(conversation),
    linkedDoc,
    exportMode: 'tabbed-full',
    addedCount: messages.length,
    tabCount: sections.length,
    headingCount,
    imageInsertedCount,
    imageFailedCount,
    failedImages,
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
      case 'ARCHIVER_COMPARE_CURRENT':
        return await startCapture({
          mode: 'compare',
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
          canContinue: Boolean(currentArchive?.messages?.length),
          history: await getRunHistory()
        };
      }
      case 'ARCHIVER_GET_LAST':
        return { ok: true, archive: summarize(await getLastArchive()) };
      case 'ARCHIVER_PAUSE_CAPTURE':
        return await pauseCapture();
      case 'ARCHIVER_RESUME_CAPTURE':
        return await resumeCapture();
      case 'ARCHIVER_CANCEL_CAPTURE':
        return await cancelCapture();
      case 'ARCHIVER_RESET_CAPTURE_STATE':
        return await resetCaptureState();
      case 'ARCHIVER_CLEAR_RUN_HISTORY':
        return await clearRunHistory();
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
      case 'ARCHIVER_EXPORT_TABBED_NEW_DOC':
        return { ok: true, ...(await exportTabbedConversation(message.planText || '')) };
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
    await finishJobWithError(
      job.jobId,
      job.sourceTabId ?? job.tabId,
      job.captureTarget === 'current'
        ? 'Текущая вкладка с перепиской была закрыта.'
        : 'Рабочая копия с перепиской была закрыта. Можно повторить в обычном режиме.'
    );
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const job = await getJob();
  if (!job || job.captureTabId !== tabId || !['starting', 'running', 'paused'].includes(job.status)) return;

  if (changeInfo.frozen === true && job.status !== 'paused') {
    await setJob({
      status: 'paused',
      pauseReason: 'frozen',
      resumePhase: job.phase === 'paused' ? (job.resumePhase || 'top') : (job.phase || 'top'),
      message: 'Вкладка сбора временно заморожена. Сбор продолжится после разморозки.',
      phase: 'paused'
    });
  } else if (
    changeInfo.frozen === false &&
    job.status === 'paused' &&
    job.pauseReason === 'frozen'
  ) {
    await setJob({
      status: 'running',
      pauseReason: '',
      message: 'Вкладка сбора снова доступна. Продолжаю сбор…',
      phase: job.resumePhase || 'top'
    });
  }

  if (changeInfo.status === 'loading' && !isChatGptUrl(tab.url || '')) {
    await finishJobWithError(
      job.jobId,
      job.sourceTabId ?? job.tabId,
      job.captureTarget === 'current'
        ? 'Текущая вкладка ушла со страницы ChatGPT.'
        : 'Рабочая копия ушла со страницы ChatGPT. Можно повторить в обычном режиме.'
    );
  }
});
