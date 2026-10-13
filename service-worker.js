import {
  buildGoogleDocBaseline
} from './lib/google-docs-baseline.mjs';

import {
  createArchiveStore,
  summarizeArchive,
  STORAGE_KEYS
} from './lib/archive-store.mjs';

import {
  buildResumeTailSignatures,
  exportTailSignatures,
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

import {
  partTitle,
  planGoogleDocParts
} from './lib/document-parts.mjs';

const ACTIVE_JOB_KEY = 'activeCaptureJob';
const RUN_HISTORY_KEY = 'captureRunHistory';
const DOC_IMAGE_PATCHES_KEY = 'docImagePatches';
const DOCS_NEW_URL = 'https://docs.new';
const SETTINGS_KEY = 'archiverSettings';
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/Naeirae/ChatGPT-Conversation-Archiver/main/manifest.json';
const UPDATE_ALARM = 'archiver-update-check';
const WHATS_NEW_PENDING_KEY = 'archiverWhatsNewPending';
const DRAFT_RECOVERY_TAB_PREFIX = 'draftRecoveryTab:';
const AUTO_RECOVERY_MAX_ATTEMPTS = 2;
const AUTO_RECOVERY_TRIGGER_DELAY_MS = 900;

const DEFAULT_SETTINGS = { userName: '', assistantName: '', palette: 'ocean', alignUserRight: true, includeReasoning: false, captureTarget: 'copy' };
async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}), includeReasoning: false };
}

const archiveStore = createArchiveStore(chrome.storage.local);
const {
  getArchive,
  putArchive,
  removeArchive,
  deleteArchive,
  getDraft,
  removeDraft,
  listDrafts,
  getLastArchive,
  getArchiveForUrl,
  indexArchive,
  getLinkedDoc,
  setLinkedDoc,
  getArchiveDestination,
  setArchiveDestination,
  getDocExport,
  recordDocExport
} = archiveStore;
const summarize = summarizeArchive;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setDraftRecoveryTab(draftId, {
  tabId = null,
  sourceUrl = '',
  sourceTabId = null,
  captureTarget = '',
  jobId = ''
} = {}) {
  if (!draftId || tabId == null) return null;
  const record = {
    draftId,
    tabId: Number(tabId),
    sourceUrl: String(sourceUrl || ''),
    sourceTabId: sourceTabId == null ? null : Number(sourceTabId),
    captureTarget: captureTarget === 'current' ? 'current' : 'copy',
    jobId: String(jobId || ''),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [DRAFT_RECOVERY_TAB_PREFIX + draftId]: record });
  return record;
}

async function getDraftRecoveryTabRecord(draftId) {
  if (!draftId) return null;
  const key = DRAFT_RECOVERY_TAB_PREFIX + draftId;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function removeDraftRecoveryTab(draftId) {
  if (!draftId) return;
  await chrome.storage.local.remove(DRAFT_RECOVERY_TAB_PREFIX + draftId);
}

async function resolveDraftRecoveryTab(draftId, sourceUrl = '') {
  const record = await getDraftRecoveryTabRecord(draftId);
  if (!record?.tabId) return { available: false, record: null, tab: null };

  const tab = await chrome.tabs.get(record.tabId).catch(() => null);
  const expected = conversationKey(sourceUrl || record.sourceUrl || '');
  const actual = conversationKey(tab?.url || '');
  if (!tab?.id || !expected || actual !== expected) {
    await removeDraftRecoveryTab(draftId).catch(() => {});
    return { available: false, record: null, tab: null };
  }

  return { available: true, record, tab };
}

async function listLinkedArchives() {
  const keys = typeof chrome.storage.local.getKeys === 'function'
    ? await chrome.storage.local.getKeys() : null;
  const archiveKeys = keys?.filter(key => key.startsWith(STORAGE_KEYS.archivePrefix)) || null;
  const result = archiveKeys
    ? await chrome.storage.local.get([STORAGE_KEYS.archiveIndex, ...archiveKeys])
    : await chrome.storage.local.get(null);
  const index = result[STORAGE_KEYS.archiveIndex] || {};
  const indexedIds = new Set(Object.values(index).filter(Boolean));
  const archives = [];

  for (const [key, value] of Object.entries(result || {})) {
    if (!key.startsWith(STORAGE_KEYS.archivePrefix)) continue;
    if (!value?.id || !value?.sourceUrl) continue;
    archives.push(value);
    indexedIds.add(value.id);
  }

  for (const archiveId of Object.values(index)) {
    if (!archiveId || archives.some(item => item.id === archiveId)) continue;
    const archive = await getArchive(archiveId);
    if (archive?.id && archive?.sourceUrl) archives.push(archive);
  }

  const rows = [];
  const seen = new Set();
  const repairedIndex = { ...index };
  let indexChanged = false;

  for (const archive of archives) {
    if (seen.has(archive.id)) continue;
    seen.add(archive.id);

    const key = conversationKey(archive.sourceUrl || '');
    if (!archive.isFragment && key && repairedIndex[key] !== archive.id) {
      const indexedArchiveId = repairedIndex[key] || '';
      const indexedArchive = indexedArchiveId ? await getArchive(indexedArchiveId) : null;
      const canRepair = !archive.partial || !indexedArchive?.id || Boolean(indexedArchive.partial);
      if (canRepair) {
        repairedIndex[key] = archive.id;
        indexChanged = true;
      }
    }

    const linked = archive.isFragment ? null : await getLinkedDoc(archive.sourceUrl);
    let destination = await getArchiveDestination(archive.id);
    if (!destination && linked?.url) {
      destination = await setArchiveDestination(archive.id, {
        saved: true,
        url: linked.url,
        kind: 'google-doc',
        label: 'Google Docs'
      });
    }
    rows.push({
      id: archive.id,
      isFragment: Boolean(archive.isFragment),
      partial: Boolean(archive.partial),
      complete: archive.complete !== false && !archive.partial,
      partialSourceDraftId: archive.partialSourceDraftId || '',
      capturePhase: archive.capturePhase || '',
      title: archive.title || 'Архив ChatGPT',
      messageCount: archive.messages?.length || 0,
      imageCount: archive.imageCount || 0,
      capturedAt: archive.capturedAt || '',
      sourceUrl: archive.sourceUrl,
      docUrl: linked?.url || '',
      destination,
      updatedAt: destination?.updatedAt || linked?.updatedAt || archive.capturedAt || ''
    });
  }

  if (indexChanged) {
    await chrome.storage.local.set({ [STORAGE_KEYS.archiveIndex]: repairedIndex });
  }

  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows;
}

async function setArchiveSavedDestination(archiveId = '', { saved = true, url = '', label = '' } = {}) {
  const archive = await getArchive(archiveId);
  if (!archive?.id) throw new Error('Сохранённый чат не найден.');

  const normalizedUrl = String(url || '').trim();
  if (normalizedUrl) {
    let parsed;
    try { parsed = new URL(normalizedUrl); } catch (_) {
      throw new Error('Проверьте ссылку: она должна начинаться с http:// или https://.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Проверьте ссылку: она должна начинаться с http:// или https://.');
    }
  }

  const destination = await setArchiveDestination(archive.id, saved ? {
    saved: true,
    url: normalizedUrl,
    kind: 'manual',
    label: String(label || '').trim()
  } : null);

  return { ok: true, archiveId: archive.id, destination };
}

async function continueSavedArchive(archiveId = '', captureTarget = 'copy') {
  const archive = await getArchive(archiveId);
  if (!archive?.messages?.length || !archive?.sourceUrl) {
    throw new Error('Сохранённый архив не найден.');
  }
  if (!isConversationUrl(archive.sourceUrl)) {
    throw new Error('У архива нет рабочей ссылки на исходный чат.');
  }

  const sourceTab = await chrome.tabs.create({ url: archive.sourceUrl, active: true });
  if (!sourceTab?.id) throw new Error('Не удалось открыть исходный чат.');

  await waitForChatTabComplete(sourceTab.id);
  await waitForChatDomReady(sourceTab.id, 45000);

  return await startCapture({
    mode: 'continue',
    existingArchive: archive,
    captureTarget
  });
}

function compareVersions(left = '', right = '') {
  const a = String(left).split('.').map(value => Number(value) || 0);
  const b = String(right).split('.').map(value => Number(value) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function checkForUpdate() {
  const localVersion = chrome.runtime.getManifest().version || '0.0.0';
  try {
    let remote;
    let firstError = '';
    try {
      // Prefer the GitHub API: it is tied to the repository object model and
      // does not depend on raw.githubusercontent.com CDN propagation.
      const apiUrl =
        'https://api.github.com/repos/Naeirae/ChatGPT-Conversation-Archiver/contents/manifest.json?ref=main&check=' +
        Date.now();
      const response = await fetch(apiUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error('GitHub API: HTTP ' + response.status);
      const payload = await response.json();
      if (!payload.content || payload.encoding !== 'base64') {
        throw new Error('GitHub API вернул manifest.json без содержимого.');
      }
      remote = JSON.parse(atob(payload.content.replace(/\s/g, '')));
    } catch (error) {
      firstError = error?.message || String(error);
      const response = await fetch(
        REMOTE_MANIFEST_URL + '?check=' + Date.now(),
        { cache: 'no-store' }
      );
      if (!response.ok) throw new Error(firstError + '; Raw GitHub: HTTP ' + response.status);
      remote = await response.json();
    }
    const remoteVersion = String(remote?.version || '');
    const available = Boolean(remoteVersion && compareVersions(remoteVersion, localVersion) > 0);

    await chrome.action.setBadgeText({ text: available ? '↑' : '' });
    if (available) {
      await chrome.action.setBadgeBackgroundColor({ color: '#2f9e44' }).catch(() => {});
      await chrome.action.setTitle({ title: 'Архиватор ChatGPT — доступно обновление ' + remoteVersion });
    } else {
      await chrome.action.setTitle({ title: 'Архиватор ChatGPT' });
    }

    return { ok: true, available, localVersion, remoteVersion };
  } catch (error) {
    return { ok: false, available: false, localVersion, remoteVersion: '', error: error?.message || String(error) };
  }
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getJob() {
  return (await chrome.storage.local.get(ACTIVE_JOB_KEY))[ACTIVE_JOB_KEY] || null;
}

async function probeLiveCapture(job, timeoutMs = 1800) {
  if (!job?.jobId || job.captureTabId == null) return null;
  const probe = chrome.tabs.sendMessage(job.captureTabId, {
    type: 'ARCHIVER_CAPTURE_HEALTH',
    jobId: job.jobId
  }).catch(() => null);
  const timeout = sleep(timeoutMs).then(() => null);
  return Promise.race([probe, timeout]);
}

async function setJob(patch) {
  const current = await getJob();
  const next = { ...(current || {}), ...patch, updatedAt: Date.now() };
  delete next.coverageRetry;
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
    imageRecoveredCount: Number(job.imageRecoveredCount || 0),
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
    message: 'Место остановки найдено. Сбор продолжен.'
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
  // Resetting a failed run must not erase the preserved draft.
  if (
    job?.captureTarget === 'copy' &&
    job?.captureTabId != null &&
    job.captureTabId !== job.sourceTabId
  ) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
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

async function formatDiagnosticLog() {
  const job = await getJob();
  const rows = (await chrome.storage.local.get('archiverWorkerErrors')).archiverWorkerErrors || [];
  return formatRunLog(job) + '\n\n=== WORKER ERRORS ===\n' + (rows.length
    ? rows.map(item => '[' + new Date(item.at).toISOString() + '] ' + item.source + '\n' + item.message).join('\n\n')
    : 'Нет записанных ошибок фонового процесса.');
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
    existingDraftId: options.existingDraftId || '',
    fixedCaptureBoundary: options.fixedCaptureBoundary || null,
    resumeAnchorSignature: options.resumeAnchorSignature || '',
    resumeTailSignatures: Array.isArray(options.resumeTailSignatures) ? options.resumeTailSignatures : [],
    resumeNavigation: Boolean(options.resumeNavigation)
  };
  const expectedVersion = chrome.runtime.getManifest().version;

  let ping = null;
  try {
    ping = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PING' });
  } catch (_) {}

  if (!ping?.ok || ping.version !== expectedVersion) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-chatgpt.js'] });
    await sleep(80);
    ping = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PING' }).catch(() => null);
  }

  if (!ping?.ok || ping.version !== expectedVersion) {
    throw new Error(
      'Вкладка ChatGPT использует устаревший код архиватора. ' +
      'Обновите страницу чата и повторите запуск.'
    );
  }

  const result = await chrome.tabs.sendMessage(tabId, payload);
  if (!result?.ok) throw new Error(result?.error || 'Content script не запустил сбор.');
  return result;
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
          /^(Попробовать снова|Повторить|Try again|Retry)$/i.test(String(el.innerText || el.textContent || '').trim())
        );
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      }
    });
    const point = result?.result;
    if (!point) return false;
    const clicked = await physicalClickChatTab(tabId, point);
    return Boolean(clicked?.ok);
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
  existingDraft: providedDraft = null,
  fixedCaptureBoundary = null,
  resumeTailSignatures = [],
  resumeNavigation = false,
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
    const stale = Date.now() - Number(current.updatedAt || current.startedAt || 0) > 300000;
    if (!stale) {
      // A tab ID is not a conversation ID; never redirect a new capture to
      // a saved run merely because its former Chrome tab ID is the same.
      if (current.tabId === sourceTab.id &&
          conversationKey(current.sourceUrl || '') &&
          conversationKey(current.sourceUrl || '') === conversationKey(sourceTab.url || '')) {
        return { ok: true, job: current, alreadyRunning: true };
      }
      throw new Error('Другой сбор переписки ещё активен. Остановите его перед новым запуском.');
    }
    // Retire the stale job metadata, preserving its checkpoint and draft.
    await setJob({
      status: 'error',
      recoveryAvailable: false,
      finishedAt: Date.now(),
      message: 'Старое задание больше не отвечает. Черновик сохранён; новый сбор запускается отдельно.'
    });
  }

  const inspection = await inspectAndKickScroll(sourceTab.id);
  if (mode === 'fragment') {
    const source = new URL(inspection.href);
    const markersKey = 'archiverFragmentMarkers:' + source.origin + source.pathname;
    const markers = (await chrome.storage.local.get(markersKey))[markersKey] || {};
    if (!markers.start && !markers.end) {
      throw new Error('Сначала отметьте начало и/или конец фрагмента в переписке.');
    }
  }
  let existingArchive = providedArchive;
  const existingDraft = providedDraft;

  if ((mode === 'continue' || mode === 'sync' || mode === 'compare' || mode === 'images') && !existingArchive) {
    existingArchive = await getArchiveForUrl(inspection.href);
  }

  if ((mode === 'continue' || mode === 'compare' || mode === 'images') && !existingArchive?.messages?.length) {
    throw new Error('Для этого чата нет локального архива. Сначала соберите переписку или восстановите стык по Google Doc.');
  }
  if (mode === 'resume-draft' && !existingDraft?.messages?.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }
  if (mode === 'resume-draft' && (!fixedCaptureBoundary?.kind || !fixedCaptureBoundary?.key)) {
    throw new Error('У незавершённого прохода нет сохранённой нижней метки. Без неё продолжить проход безопасно нельзя.');
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
      captureTab = await chrome.tabs.create({ url: inspection.href, active: false });
      if (!captureTab?.id) throw new Error('Не удалось открыть рабочую вкладку для фонового сбора.');

      await chrome.tabs.update(captureTab.id, { autoDiscardable: false }).catch(() => {});
      captureTab = await waitForChatTabComplete(captureTab.id);
      domProbe = await waitForChatDomReady(captureTab.id, 45000);
    }

    const modeLabel = mode === 'fragment' ? 'сбор выбранного фрагмента' : mode === 'compare'
      ? 'сверка с локальным архивом'
      : mode === 'sync'
        ? 'восстановление по Google Doc'
        : mode === 'continue'
          ? 'продолжение'
          : mode === 'images'
            ? 'добор изображений'
            : mode === 'resume-draft'
              ? 'продолжение незавершённого прохода'
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
      recoveryDraftId: (mode === 'resume-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
      draftId: (mode === 'resume-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
      draftCount: (mode === 'resume-draft' || resumeNavigation) ? (existingDraft?.messages?.length || 0) : 0,
      partialSaveEnabled: Boolean(existingDraft?.partialSaveEnabled),
      partialArchiveId: existingDraft?.partialArchiveId || '',
      captureBoundary: (mode === 'resume-draft' || resumeNavigation) ? fixedCaptureBoundary : null,
      pendingDocUrl,
      pendingDocMode,
      message: mode === 'fragment'
        ? 'Рабочая вкладка готова; ищу выбранную границу начала фрагмента…'
        : mode === 'full'
        ? (captureTarget === 'current'
            ? 'Текущая вкладка готова; иду к началу…'
            : 'Рабочая копия загружена; иду к началу…')
        : mode === 'images'
          ? (captureTarget === 'current'
              ? 'Текущая вкладка готова; добираю изображения по всей переписке…'
              : 'Рабочая копия загружена; добираю изображения по всей переписке…')
          : mode === 'resume-draft'
            ? (captureTarget === 'current'
                ? 'Текущая вкладка готова; ищу место остановки незавершённого прохода…'
                : 'Рабочая копия загружена; ищу место остановки незавершённого прохода…')
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
    const lastDraftMessage = existingDraft?.messages?.[existingDraft.messages.length - 1] || null;
    const resumeAnchorId = mode === 'resume-draft'
      ? (lastDraftMessage?.id || '')
      : (mode === 'sync' || mode === 'images')
        ? ''
        : (existingArchive?.lastMessageId || lastExistingMessage?.id || '');
    const resumeAnchorSignature = mode === 'resume-draft'
      ? (lastDraftMessage ? messageSignature(lastDraftMessage.role, lastDraftMessage.text) : '')
      : mode === 'sync'
        ? (resumeTailSignatures[resumeTailSignatures.length - 1] || '')
        : (lastExistingMessage ? messageSignature(lastExistingMessage.role, lastExistingMessage.text) : '');

    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode,
      resumeAnchorId,
      resumeAnchorSignature,
      resumeTailSignatures,
      existingArchiveId: existingArchive?.id || '',
      existingDraftId: existingDraft?.id || '',
      fixedCaptureBoundary: (mode === 'resume-draft' || resumeNavigation) ? fixedCaptureBoundary : null,
      resumeNavigation
    });

    if (captureTarget === 'copy') {
      // The capture tab was created inactive; do not steal the user's focus.
      await appendRunLog({
        status: 'running',
        message: mode === 'full'
          ? 'Фоновый сбор идет в рабочей вкладке…'
          : mode === 'images'
            ? 'Фоново добираю изображения по всей переписке…'
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
          : mode === 'images'
            ? 'Физически прохожу чат и добираю изображения…'
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
    }

    if (mode === 'sync' && existingArchive?.id) {
      await removeArchive(existingArchive.id).catch(() => {});
    }

    const rawMessage = error?.message || String(error);
    const message = captureTarget === 'copy' &&
      !/Текущая вкладка/i.test(rawMessage)
      ? rawMessage + ' Можно повторить в режиме «Текущая вкладка».'
      : rawMessage;

    const failedJob = await setJob({
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
      startedAt: Date.now(),
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
    await recordRunHistory(failedJob);
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

  // Give the content collector time to persist its current draft and report
  // ARCHIVER_CAPTURE_FAILED(status=cancelled). Do not close the working tab:
  // its scroll position is the cheapest and most reliable resume checkpoint.
  const waitUntil = Date.now() + 3500;
  while (Date.now() < waitUntil) {
    await sleep(120);
    const current = await getJob();
    if (current?.jobId !== job.jobId || current?.status === 'cancelled') {
      return { ok: true, job: current || job };
    }
  }

  const preservedDraft = job.draftId ? await getDraft(job.draftId) : null;
  const canRecover = Boolean(
    preservedDraft?.messages?.length &&
    job.captureTabId != null
  );
  if (canRecover && job.draftId) {
    await setDraftRecoveryTab(job.draftId, {
      tabId: job.captureTabId,
      sourceUrl: job.sourceUrl || '',
      sourceTabId: job.sourceTabId ?? job.tabId ?? null,
      captureTarget: job.captureTarget || '',
      jobId: job.jobId
    });
  }
  await cleanupTemporaryBaseline(job);

  const next = await appendRunLog({
    status: 'cancelled',
    message: canRecover
      ? 'Сбор остановлен. Сохранённую часть можно продолжить с рабочей вкладки.'
      : 'Сбор остановлен.',
    finishedAt: Date.now(),
    recoveryAvailable: canRecover,
    draftCount: preservedDraft?.messages?.length || Number(job.draftCount || 0)
  }, {
    level: 'warn',
    code: canRecover ? 'RUN_CANCELLED_RECOVERABLE' : 'RUN_CANCELLED',
    message: canRecover
      ? 'Сбор остановлен пользователем; рабочая вкладка и контрольная точка сохранены.'
      : 'Сбор остановлен пользователем.',
    phase: job.phase || '',
    count: Number(job.count || 0)
  });
  await recordRunHistory(next);
  return { ok: true, job: next };
}

async function finishJobWithError(jobId, sourceTabId, message, draftId = '', draftCount = 0, status = 'error') {
  const job = await getJob();
  if (job?.jobId !== jobId) return { job, autoRecoveryEligible: false };

  const boundary = job.captureBoundary || null;
  const navigationOnlyRecoverable = Boolean(
    status === 'error' &&
    job.phase === 'top' &&
    boundary?.kind &&
    boundary?.key &&
    ['full', 'fragment'].includes(job.captureMode)
  );

  let preservedCaptureTabId = null;
  if (
    ['error', 'cancelled'].includes(status) &&
    (draftId || navigationOnlyRecoverable) &&
    ['full', 'fragment', 'resume-draft', 'retry-walk'].includes(job.captureMode) &&
    job.captureTabId != null
  ) {
    try {
      const tab = await chrome.tabs.get(job.captureTabId);
      if (tab?.id && conversationKey(tab.url || '') &&
          conversationKey(tab.url || '') === conversationKey(job.sourceUrl || '')) {
        preservedCaptureTabId = tab.id;
      }
    } catch (_) {}
  }

  if (
    job.captureTarget === 'copy' &&
    job.captureTabId != null &&
    job.captureTabId !== job.sourceTabId &&
    preservedCaptureTabId == null
  ) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }
  await cleanupTemporaryBaseline(job);

  const recoveryAvailable = Boolean(
    preservedCaptureTabId != null &&
    (draftId || navigationOnlyRecoverable)
  );

  if (recoveryAvailable && draftId) {
    await setDraftRecoveryTab(draftId, {
      tabId: preservedCaptureTabId,
      sourceUrl: job.sourceUrl || '',
      sourceTabId: job.sourceTabId ?? job.tabId ?? null,
      captureTarget: job.captureTarget || '',
      jobId: job.jobId
    });
  }

  if (draftId) {
    const failedDraft = await getDraft(draftId);
    if (failedDraft?.partialSaveEnabled) {
      try {
        await syncPartialArchiveFromDraft(failedDraft);
      } catch (error) {
        await appendRunLog({}, {
          level: 'warn',
          code: 'PARTIAL_AUTOSAVE_FAILED',
          message: error?.message || String(error),
          phase: failedDraft.capturePhase || job.phase || '',
          count: failedDraft.messages?.length || 0
        });
      }
    }
  }

  const attempts = Number(job.autoRecoveryAttempts || 0);
  const maxAttempts = Number(job.autoRecoveryMaxAttempts || AUTO_RECOVERY_MAX_ATTEMPTS);
  const autoRecoveryEligible = Boolean(
    status === 'error' &&
    recoveryAvailable &&
    attempts < maxAttempts
  );

  const next = await appendRunLog({
    status,
    message: autoRecoveryEligible
      ? message + ' Попробую автоматически продолжить в этой же вкладке.'
      : message,
    draftId,
    draftCount,
    recoveryAvailable,
    autoRecoveryPending: autoRecoveryEligible,
    autoRecoveryAttempts: attempts,
    autoRecoveryMaxAttempts: maxAttempts,
    autoRecoveryRootId: job.autoRecoveryRootId || job.jobId,
    finishedAt: Date.now(),
    tabId: sourceTabId ?? job.sourceTabId ?? job.tabId,
    captureTabId: preservedCaptureTabId
  }, {
    level: status === 'cancelled' ? 'warn' : 'error',
    code: autoRecoveryEligible
      ? 'RUN_FAILED_AUTO_RECOVERY_PENDING'
      : recoveryAvailable
        ? 'RUN_FAILED_RECOVERABLE'
        : (draftId ? 'RUN_FAILED_WITH_DRAFT' : 'RUN_FAILED'),
    message: autoRecoveryEligible
      ? (
          'Сбор оборвался программно; рабочая вкладка сохранена. ' +
          'Автоматическая попытка восстановления ' + (attempts + 1) + ' из ' + maxAttempts + ' запланирована.'
        )
      : recoveryAvailable
        ? (
            'Сбор оборвался; ' +
            (draftId
              ? 'сохранён незавершённый проход на ' + Number(draftCount || 0) + ' сообщений'
              : 'сохранена текущая позиция прохода к началу') +
            ' и оставлена рабочая вкладка для продолжения.'
          )
        : draftId
          ? ('Сбор завершился ошибкой; сохранён незавершённый проход на ' + Number(draftCount || 0) + ' сообщений.')
          : message,
    phase: job.phase || '',
    count: Number(job.count || 0)
  });
  await recordRunHistory(next);
  return { job: next, autoRecoveryEligible };
}

async function focusRecoverableCaptureTab() {
  const job = await getJob();
  if (!job?.captureTabId || !job?.draftId) {
    throw new Error('Нет сохранённой рабочей вкладки незавершённого прохода.');
  }

  const tab = await chrome.tabs.get(job.captureTabId).catch(() => null);
  if (!tab?.id || !isConversationUrl(tab.url || '')) {
    throw new Error('Сохранённая вкладка сбора уже закрыта или ушла со страницы ChatGPT.');
  }

  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true, tabId: tab.id };
}

async function resumeFailedCaptureFromWorkingTab() {
  const failedJob = await getJob();
  if (
    !failedJob ||
    !['error', 'cancelled'].includes(failedJob.status) ||
    !failedJob.draftId ||
    failedJob.captureTabId == null
  ) {
    throw new Error('Нет незавершённого прохода с сохранённой рабочей вкладкой.');
  }

  const draft = await getDraft(failedJob.draftId);
  if (!draft?.messages?.length) throw new Error('Сохранённый незавершённый проход не найден.');

  const captureTab = await chrome.tabs.get(failedJob.captureTabId).catch(() => null);
  if (!captureTab?.id ||
      conversationKey(captureTab.url || '') !== conversationKey(draft.sourceUrl || '')) {
    throw new Error('Рабочая вкладка незавершённого прохода уже недоступна.');
  }

  const boundary = failedJob.captureBoundary || draft.captureBoundary || null;
  if (!boundary?.kind || !boundary?.key) {
    throw new Error(
      'У этого сохранённого незавершённого прохода нет нижней метки снимка. ' +
      'Автоматически продолжить его без риска захватить новые сообщения нельзя.'
    );
  }

  const lastMessage = draft.messages[draft.messages.length - 1] || null;
  if (!lastMessage) throw new Error('В сохранённом незавершённом проходе нет точки, от которой можно продолжить.');

  const jobId = makeJobId();
  const resumeNavigation = draft.capturePhase === 'top' &&
    ['full', 'fragment'].includes(draft.captureMode);
  const resumeMode = resumeNavigation
    ? draft.captureMode
    : (draft.capturePhase === 'walk' || draft.capturePhase === 'finalizing'
        ? 'resume-draft'
        : 'retry-walk');
  const resumeTailSignatures = buildResumeTailSignatures(draft.messages, 4);
  const target = failedJob.captureTarget === 'current' ? 'current' : 'copy';
  await setJob({
    jobId,
    status: 'starting',
    phase: 'top',
    captureMode: resumeMode,
    captureTarget: target,
    recoveryDraftId: draft.id,
    // Keep the previous checkpoint immutable while the resumed pass runs.
    // Its own checkpoints use a fresh draft ID.
    draftId: 'draft-' + jobId,
    draftCount: draft.messages.length,
    partialSaveEnabled: Boolean(draft.partialSaveEnabled),
    partialArchiveId: draft.partialArchiveId || '',
    recoveryAvailable: false,
    captureTabId: captureTab.id,
    message: resumeNavigation
      ? 'Продолжаю навигацию вверх от сохранённого места…'
      : resumeMode === 'resume-draft'
        ? 'Ищу последнюю сохранённую реплику и продолжаю с неё без полного прохода…'
        : 'Возвращаю рабочую вкладку к началу для восстановления…',
    startedAt: Date.now(),
    finishedAt: null
  });

  try {
    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode: resumeMode,
      resumeAnchorId: lastMessage.id || '',
      resumeAnchorSignature: messageSignature(lastMessage.role, lastMessage.text),
      resumeTailSignatures,
      existingDraftId: draft.id,
      fixedCaptureBoundary: boundary,
      resumeNavigation
    });
  } catch (error) {
    const message = error?.message || String(error);
    await setJob({
      status: 'error',
      recoveryAvailable: true,
      message,
      finishedAt: Date.now()
    });
    throw error;
  }



  const next = await appendRunLog({
    status: 'running',
    phase: 'top',
    message: resumeNavigation
      ? 'Продолжаю путь к началу от сохранённой контрольной точки…'
      : resumeMode === 'resume-draft'
        ? 'Продолжаю после последней сохранённой реплики…'
        : 'Восстанавливаю хронологический проход…'
  }, {
    level: 'info',
    code: 'UNFINISHED_PASS_RETRY_STARTED',
    message: resumeNavigation
      ? 'Черновик сохранён; навигация продолжается от последнего сохранённого участка без возврата к уже пройденной части.'
      : resumeMode === 'resume-draft'
        ? 'Черновик сохранён; поиск последнего сохранённого сообщения и добор до исходной конечной метки.'
        : 'Сохранённый незавершённый проход найден; повторяется хронологический проход.',
    phase: 'top',
    count: draft.messages.length
  });

  return { ok: true, job: next };
}

function partialArchiveIdForSource(sourceUrl = '') {
  const key = conversationKey(sourceUrl) || String(sourceUrl || '');
  return key ? 'partial-' + hashText(key) : '';
}

async function syncPartialArchiveFromDraft(draft, { enable = false } = {}) {
  if (!draft?.id || !draft?.messages?.length) {
    throw new Error('Незавершённый проход не найден.');
  }

  const id = draft.partialArchiveId || partialArchiveIdForSource(draft.sourceUrl);
  if (!id) throw new Error('Не удалось определить исходный чат для частичного архива.');

  const existing = await getArchive(id);
  const messages = draft.messages.slice();
  const archive = {
    ...(existing || {}),
    ...draft,
    id,
    title: draft.title || existing?.title || 'ChatGPT',
    capturedAt: new Date().toISOString(),
    messages,
    messageCount: messages.length,
    imageCount: messages.reduce((n, item) => n + (item.images?.length || 0), 0),
    partial: true,
    complete: false,
    isFragment: false,
    partialSourceDraftId: draft.id,
    partialSaveEnabled: true,
    capturePhase: draft.capturePhase || 'walk',
    lastCaptureMode: 'partial-draft'
  };

  await putArchive(archive);

  // Keep the binding on the unfinished pass itself. The content collector
  // preserves these fields across later checkpoints.
  const boundDraft = {
    ...draft,
    partialSaveEnabled: true,
    partialArchiveId: id,
    partialSavedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.draftPrefix + draft.id]: boundDraft });

  // A partial snapshot must never replace an already completed canonical
  // archive for the same conversation. If there is no completed archive yet,
  // indexing the partial makes it discoverable as the current local state.
  const currentCanonical = await getArchiveForUrl(draft.sourceUrl || '');
  if (!currentCanonical?.id || currentCanonical.partial || currentCanonical.id === archive.id) {
    await indexArchive(archive);
  }

  // lastArchiveId is presentation state, not the canonical conversation index.
  // It is safe to point it at the freshly saved partial snapshot.
  await chrome.storage.local.set({ [STORAGE_KEYS.lastArchiveId]: archive.id });

  const job = await getJob();
  if (job && (job.draftId === draft.id || job.recoveryDraftId === draft.id)) {
    await setJob({
      partialSaveEnabled: true,
      partialArchiveId: id
    });
  }

  return {
    ok: true,
    archiveId: id,
    messageCount: messages.length,
    updated: Boolean(existing?.id),
    resumable: true,
    partialSaveEnabled: true,
    enabled: enable || Boolean(draft.partialSaveEnabled)
  };
}

async function saveUnfinishedAsPartial(passId = '') {
  const draft = await getDraft(passId);
  return syncPartialArchiveFromDraft(draft, { enable: true });
}

async function resumeUnfinishedInSavedTab(passId = '') {
  const draft = await getDraft(passId);
  if (!draft?.messages?.length) throw new Error('Сохранённый незавершённый проход не найден.');

  const recovery = await resolveDraftRecoveryTab(passId, draft.sourceUrl || '');
  if (!recovery.available) {
    throw new Error('Та вкладка, в которой оборвался этот проход, уже недоступна.');
  }

  const activeJob = await getJob();
  if (activeJob && ['starting', 'running', 'paused'].includes(activeJob.status)) {
    const sameRun = activeJob.draftId === passId || activeJob.recoveryDraftId === passId;
    if (!sameRun) {
      throw new Error('Другой сбор ещё активен. Остановите его перед восстановлением этой вкладки.');
    }
  }

  const boundary = draft.captureBoundary || null;
  if (!boundary?.kind || !boundary?.key) {
    throw new Error('У незавершённого прохода нет нижней метки. Без неё безопасно продолжить нельзя.');
  }

  // Recreate the minimal failed-job envelope so the existing same-tab resume
  // path can be reused even after another job or service-worker restart.
  await setJob({
    status: 'error',
    draftId: passId,
    recoveryDraftId: passId,
    draftCount: draft.messages.length,
    recoveryAvailable: true,
    captureTabId: recovery.tab.id,
    sourceTabId: recovery.record.sourceTabId ?? recovery.tab.id,
    tabId: recovery.record.sourceTabId ?? recovery.tab.id,
    sourceUrl: draft.sourceUrl || recovery.tab.url || '',
    captureBoundary: boundary,
    captureMode: draft.captureMode || 'resume-draft',
    captureTarget: recovery.record.captureTarget || 'copy',
    partialSaveEnabled: Boolean(draft.partialSaveEnabled),
    partialArchiveId: draft.partialArchiveId || '',
    message: 'Восстанавливаю незавершённый проход в той же вкладке.'
  });

  return resumeFailedCaptureFromWorkingTab();
}

async function resumeSavedUnfinishedPass(passId = '', captureTarget = 'copy', resumeStrategy = 'auto') {
  // "auto" preserves previous behavior. UI can explicitly choose "fresh" or
  // "saved-tab" so a manually positioned interrupted tab is never discarded.
  if (resumeStrategy === 'saved-tab') {
    return resumeUnfinishedInSavedTab(passId);
  }

  const activeJob = await getJob();
  if (resumeStrategy !== 'fresh' &&
      ['error', 'cancelled'].includes(activeJob?.status) && activeJob.recoveryAvailable &&
      activeJob.captureTabId != null &&
      (activeJob.draftId === passId || activeJob.recoveryDraftId === passId)) {
    return resumeFailedCaptureFromWorkingTab();
  }
  const draft = await getDraft(passId);
  if (!draft?.messages?.length) throw new Error('Сохранённый незавершённый проход не найден.');
  if (!isConversationUrl(draft.sourceUrl || '')) {
    throw new Error('У незавершённого прохода нет рабочей ссылки на исходный чат.');
  }
  const boundary = draft.captureBoundary || null;
  if (!boundary?.kind || !boundary?.key) {
    throw new Error('У этого незавершённого прохода нет нижней метки. Без неё безопасно продолжить сбор нельзя.');
  }

  const existingJob = await getJob();
  if (existingJob && ['starting', 'running', 'paused'].includes(existingJob.status)) {
    const existingTab = existingJob.captureTabId != null
      ? await chrome.tabs.get(existingJob.captureTabId).catch(() => null) : null;
    if (existingTab?.id && isConversationUrl(existingTab.url || '') &&
        Date.now() - Number(existingJob.updatedAt || existingJob.startedAt || Date.now()) < 300000) {
      throw new Error('Предыдущий сбор ещё активен. Остановите его перед восстановлением.');
    }
    await setJob({
      status: 'error',
      message: 'Прежний запуск прерван; продолжаю сохранённый проход.',
      finishedAt: Date.now(),
      recoveryAvailable: false
    });
  }

  const active = await getActiveTab();
  const activeMatches = Boolean(active?.id && conversationKey(active.url || '') === conversationKey(draft.sourceUrl || ''));

  if (!activeMatches) {
    throw new Error('Сохранённый проход относится к другой переписке. Откройте исходный чат вручную, затем повторите продолжение.');
  }


  return startCapture({
    mode: draft.capturePhase === 'top' && ['full', 'fragment'].includes(draft.captureMode)
      ? draft.captureMode : 'resume-draft',
    resumeNavigation: draft.capturePhase === 'top',
    resumeTailSignatures: buildResumeTailSignatures(draft.messages, 4),
    existingDraft: draft,
    fixedCaptureBoundary: boundary,
    captureTarget
  });
}

async function deleteDraftAndRecoveryTab(draftId = '') {
  const job = await getJob();
  const targetId = draftId || job?.draftId || '';
  if (!targetId) return { ok: true, removed: false };

  await removeDraft(targetId);
  await removeDraftRecoveryTab(targetId).catch(() => {});

  if (job?.draftId === targetId) {
    if (
      job.captureTarget === 'copy' &&
      job.captureTabId != null &&
      job.captureTabId !== job.sourceTabId
    ) {
      await chrome.tabs.remove(job.captureTabId).catch(() => {});
    }

    await setJob({
      draftId: '',
      draftCount: 0,
      recoveryDraftId: '',
      recoveryAvailable: false,
      captureTabId: null
    });
  }

  return { ok: true, removed: true };
}

async function deleteLocalArchive(archiveId = '') {
  const archive = await getArchive(archiveId) || (!archiveId ? await getLastArchive() : null);
  if (!archive?.id) return { ok: true, removed: false };

  await deleteArchive(archive.id);

  const job = await getJob();
  if (job?.archiveId === archive.id) {
    await setJob({ archiveId: '' });
  }

  return { ok: true, removed: true, archiveId: archive.id };
}

async function compareUnfinishedPass(passId = '') {
  const unfinishedPass = await getDraft(passId);
  if (!unfinishedPass?.messages?.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }

  const archive = await getArchiveForUrl(unfinishedPass.sourceUrl || '');
  if (!archive?.messages?.length) {
    return {
      ok: true,
      unfinishedPass: summarize(unfinishedPass),
      archive: null,
      commonPrefixCount: 0,
      sharedCount: 0,
      onlyInUnfinishedPassCount: unfinishedPass.messages.length,
      onlyInArchiveCount: 0
    };
  }

  const identity = message => {
    if (message?.id) return 'id:' + message.id;
    return 'sig:' + messageSignature(message?.role || '', message?.text || '');
  };

  const passMessages = unfinishedPass.messages || [];
  const archiveMessages = archive.messages || [];
  const archiveSet = new Set(archiveMessages.map(identity));
  const passSet = new Set(passMessages.map(identity));

  let commonPrefixCount = 0;
  while (
    commonPrefixCount < passMessages.length &&
    commonPrefixCount < archiveMessages.length &&
    identity(passMessages[commonPrefixCount]) === identity(archiveMessages[commonPrefixCount])
  ) {
    commonPrefixCount++;
  }

  let sharedCount = 0;
  for (const key of passSet) if (archiveSet.has(key)) sharedCount++;

  return {
    ok: true,
    unfinishedPass: summarize(unfinishedPass),
    archive: summarize(archive),
    commonPrefixCount,
    sharedCount,
    onlyInUnfinishedPassCount: [...passSet].filter(key => !archiveSet.has(key)).length,
    onlyInArchiveCount: [...archiveSet].filter(key => !passSet.has(key)).length
  };
}

function partialMessageKey(item) {
  return item?.id ? 'id:' + item.id
    : 'sig:' + messageSignature(item?.role || '', item?.text || '');
}

async function reconcilePartialArchive(draftId, completed) {
  if (!draftId || !completed?.messages?.length) return { applied: false, reason: 'no-draft' };
  const partialId = partialArchiveIdForSource(completed.sourceUrl || '');
  if (!partialId) return { applied: false, reason: 'no-partial-id' };
  const partial = await getArchive(partialId);
  if (!partial?.partial || !partial.messages?.length) return { applied: false, reason: 'no-partial' };

  const finalIds = new Set(completed.messages.map(partialMessageKey));
  const missing = partial.messages.filter(item => !finalIds.has(partialMessageKey(item)));
  if (missing.length) {
    return { applied: false, reason: 'unmatched', missingCount: missing.length, archiveId: partialId };
  }

  // Use the independently verified chronological capture as canonical content.
  // Never infer completeness by concatenating unordered navigation windows.
  const merged = {
    ...completed,
    id: partialId,
    title: completed.title,
    partial: false,
    complete: true,
    isFragment: Boolean(completed.isFragment),
    partialSourceDraftId: draftId,
    completedFromPartialAt: new Date().toISOString()
  };
  await putArchive(merged);
  return { applied: true, archiveId: partialId, messageCount: merged.messages.length };
}

async function handleCaptureComplete(message) {
  const job = await getJob();
  if (!job || job.jobId !== message.jobId) return;

  const archive = await getArchive(message.archiveId);
  if (!archive) {
    return finishJobWithError(message.jobId, job.sourceTabId ?? job.tabId, 'Архив не найден после завершения сбора.');
  }

  const partialSourceId = job.recoveryDraftId || job.draftId || '';
  const partialMerge = message.mode === 'compare' || message.mode === 'images'
    ? { applied: false, reason: 'noncapture' }
    : await reconcilePartialArchive(partialSourceId, archive);
  if (partialMerge.applied) {
    if (!archive.isFragment) {
      await chrome.storage.local.set({ [STORAGE_KEYS.lastArchiveId]: partialMerge.archiveId });
      await indexArchive(await getArchive(partialMerge.archiveId));
    }
  } else if (message.mode !== 'compare' && message.mode !== 'fragment') {
    await indexArchive(archive);
  }
  const completedDraftIds = new Set([
    job.draftId || '',
    job.recoveryDraftId || ''
  ].filter(Boolean));
  for (const draftId of completedDraftIds) {
    if (partialMerge.reason === 'unmatched' && draftId === partialSourceId) continue;
    await removeDraft(draftId).catch(() => {});
    await removeDraftRecoveryTab(draftId).catch(() => {});
  }

  if (job.captureTarget === 'copy' && job.captureTabId != null && job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});

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

  if (message.mode === 'images') {
    const recovered = Number(message.imageRecoveredCount || archive.lastImageRecoveredCount || 0);
    const finalMessage = recovered
      ? ('Добор изображений завершён: +' + recovered + '. Локальный архив обновлён; текст не пересобирался.')
      : 'Добор изображений завершён: новых изображений не найдено.';

    const next = await appendRunLog({
      status: 'done',
      phase: 'done',
      captureMode: 'images',
      message: finalMessage,
      count: archive.messages?.length || 0,
      addedCount: 0,
      imageRecoveredCount: recovered,
      imageCount: archive.imageCount || 0,
      archiveId: archive.id,
      finishedAt: Date.now(),
      captureTabId: null
    }, {
      level: 'info',
      code: 'IMAGE_RECOVERY_COMPLETE',
      message: finalMessage,
      phase: 'done',
      count: archive.messages?.length || 0
    });
    await recordRunHistory(next);
    return;
  }

  let docResult = null;
  let docError = '';

  const isContinuation = message.mode === 'continue' || message.mode === 'sync';
  const isDraftRecovery = message.mode === 'resume-draft' || message.mode === 'retry-walk';
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

  let finalMessage = isDraftRecovery
    ? ('Незавершённый проход восстановлен: +' + addedCount + ' сообщений; архив собран до исходной нижней метки.')
    : isContinuation
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
    captureTabId: null,
    recoveryAvailable: false,
    recoveryDraftId: '',
    draftId: '',
    draftCount: 0
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

async function withChatDebugger(tabId, fn) {
  let attached = false;
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(item => item.tabId === tabId);
    if (target?.attached) throw new Error('Вкладка уже занята Chrome debugger.');
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    return await fn();
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function physicalClickChatTab(tabId, point = {}) {
  return withChatDebugger(tabId, async () => {
    const viewportResult = await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight})',
      returnByValue: true
    });
    const viewport = viewportResult?.result?.value || {};
    const width = Math.max(1, Number(viewport.width) || 1280);
    const height = Math.max(1, Number(viewport.height) || 720);
    const x = Math.max(1, Math.min(width - 1, Number(point.x) || width / 2));
    const y = Math.max(1, Math.min(height - 1, Number(point.y) || height / 2));

    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {});
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    });
    await sleep(220);
    return { ok: true, x, y };
  });
}

async function physicalCopyChatSelection(tabId) {
  const sentinel = '__ARCHIVER_CLIPBOARD_SENTINEL__';
  await writeClipboard('<span>' + sentinel + '</span>', sentinel);

  await withChatDebugger(tabId, async () => {
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 2
    }).catch(() => {});
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
      modifiers: 2
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
      modifiers: 2
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 0
    }).catch(() => {});
    await sleep(220);
  });

  const text = await readClipboardText();
  return { ok: text !== sentinel, text: text === sentinel ? '' : text };
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

async function goToGoogleDocTabTokenAttached(tabId, targetToken, maxTabs = 100) {
  if (!targetToken) return false;
  await focusGoogleDocEditor(tabId);

  let state = await googleDocPageState(tabId);
  for (let i = 0; i < maxTabs; i++) {
    const current = googleDocTabToken(state.href);
    if (current === targetToken) return true;
    await dispatchKey(tabId, 'PageUp', 'PageUp', 33, 10);
    await sleep(160);
    const next = await googleDocPageState(tabId);
    if (googleDocTabToken(next.href) === current) {
      state = next;
      break;
    }
    state = next;
  }

  for (let i = 0; i < maxTabs; i++) {
    const current = googleDocTabToken(state.href);
    if (current === targetToken) return true;
    await dispatchKey(tabId, 'PageDown', 'PageDown', 34, 10);
    await sleep(180);
    const next = await googleDocPageState(tabId);
    if (googleDocTabToken(next.href) === current) return current === targetToken;
    state = next;
  }
  return googleDocTabToken(state.href) === targetToken;
}

async function inspectGoogleDocTabsAttached(tabId, { restoreToken = '' } = {}) {
  await focusGoogleDocEditor(tabId);
  const original = restoreToken || googleDocTabToken((await googleDocPageState(tabId)).href);

  // Google Docs starts every new document with one implicit first tab. Its URL
  // often has no ?tab= parameter, so googleDocTabToken() normalizes it to t.0.
  let state = await googleDocPageState(tabId);
  for (let i = 0; i < 100; i++) {
    const before = googleDocTabToken(state.href);
    await dispatchKey(tabId, 'PageUp', 'PageUp', 33, 10);
    await sleep(170);
    const next = await googleDocPageState(tabId);
    if (googleDocTabToken(next.href) === before) {
      state = next;
      break;
    }
    state = next;
  }

  const tokens = [];
  for (let i = 0; i < 100; i++) {
    const token = googleDocTabToken(state.href);
    if (tokens.includes(token)) break;
    tokens.push(token);

    await dispatchKey(tabId, 'PageDown', 'PageDown', 34, 10);
    await sleep(190);
    const next = await googleDocPageState(tabId);
    if (googleDocTabToken(next.href) === token) {
      state = next;
      break;
    }
    state = next;
  }

  if (original) await goToGoogleDocTabTokenAttached(tabId, original).catch(() => false);

  return {
    count: tokens.length,
    tokens,
    firstToken: tokens[0] || '',
    lastToken: tokens[tokens.length - 1] || '',
    originalToken: original
  };
}

async function createNextGoogleDocsTab(tabId, seenTokens = new Set(), expectedBeforeCount = null) {
  let attached = false;
  const knownTokens = seenTokens instanceof Set ? seenTokens : new Set(seenTokens || []);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(500);

    for (let attempt = 1; attempt <= 3; attempt++) {
      let before = await googleDocPageState(tabId);
      const beforeToken = googleDocTabToken(before.href);
      const beforeInventory = await inspectGoogleDocTabsAttached(tabId, { restoreToken: beforeToken });
      for (const token of beforeInventory.tokens) knownTokens.add(token);

      if (Number.isInteger(expectedBeforeCount) && beforeInventory.count !== expectedBeforeCount) {
        throw new Error(
          'Перед созданием следующей вкладки Google Docs найдено ' + beforeInventory.count +
          ' вкладок, ожидалось ' + expectedBeforeCount +
          '. Экспорт остановлен до вставки следующего раздела.'
        );
      }

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
      while (Date.now() - started < 6000) {
        state = await googleDocPageState(tabId);
        const activeToken = googleDocTabToken(state.href);
        const inventory = await inspectGoogleDocTabsAttached(tabId, { restoreToken: activeToken });
        const newTokens = inventory.tokens.filter(token => !knownTokens.has(token));

        if (inventory.count === beforeInventory.count + 1 && newTokens.length === 1) {
          const token = newTokens[0];
          for (const item of inventory.tokens) knownTokens.add(item);
          const selected = await goToGoogleDocTabTokenAttached(tabId, token);
          if (!selected) {
            throw new Error('Новая вкладка создана, но переключиться в неё перед вставкой не удалось.');
          }
          await sleep(300);
          return {
            ok: true,
            url: (await googleDocPageState(tabId)).href,
            token,
            count: inventory.count,
            controlLabel: addControl.label || '',
            attempt
          };
        }

        if (inventory.count > beforeInventory.count + 1) {
          throw new Error(
            'Google Docs создал больше одной вкладки за один шаг (' +
            beforeInventory.count + ' → ' + inventory.count +
            '). Экспорт остановлен до вставки следующего раздела.'
          );
        }

        await sleep(220);
      }

      // A URL change alone is not enough. We retry only if the physical tab
      // inventory is still unchanged.
      await goToGoogleDocTabTokenAttached(tabId, beforeToken).catch(() => false);
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

async function knownBaselineDecorations(docUrl) {
  const docId = googleDocKey(docUrl);
  if (!docId) return [];

  const exportInfo = await getDocExport(docId);
  if (!exportInfo?.archiveId) return [];

  const archive = await getArchive(exportInfo.archiveId);
  const stored = await chrome.storage.local.get('tabMarkers:' + exportInfo.archiveId);
  const markers = stored['tabMarkers:' + exportInfo.archiveId];
  const headings = Array.isArray(markers)
    ? markers
        .filter(item => item?.type === 'heading')
        .map(item => String(item.title || '').trim())
        .filter(Boolean)
    : [];

  const linked = archive?.sourceUrl ? await getLinkedDoc(archive.sourceUrl) : null;
  const partTitles = Array.isArray(linked?.parts)
    ? linked.parts.map(item => String(item?.title || '').trim()).filter(Boolean)
    : [];

  return [...new Set([...headings, ...partTitles])];
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

    const ignoredStandaloneLines = await knownBaselineDecorations(normalizedUrl);
    const baseline = buildGoogleDocBaseline(tabs, {
      tailLimit: 6,
      ignoredStandaloneLines
    });
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

function normalizeDocSearchText(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function occurrenceCount(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return count;
    count++;
    from = index + needle.length;
  }
}

function uniqueMessageAnchor(docText, message) {
  const normalizedDoc = normalizeDocSearchText(docText);
  const lines = String(message?.text || '')
    .split(/\r?\n/)
    .map(normalizeDocSearchText)
    .filter(line => line.length >= 24)
    .sort((a, b) => b.length - a.length);

  const candidates = [];
  for (const line of lines) {
    candidates.push(line.slice(0, 120));
    if (line.length > 120) {
      const mid = Math.max(0, Math.floor(line.length / 2) - 60);
      candidates.push(line.slice(mid, mid + 120));
    }
  }
  const full = normalizeDocSearchText(message?.text || '');
  if (full.length >= 24) candidates.push(full.slice(0, 120));

  for (const candidate of candidates) {
    const query = candidate.trim();
    if (query.length < 24) continue;
    if (occurrenceCount(normalizedDoc, query) === 1) return query;
  }
  return '';
}

async function copyEditorSelectionText(tabId) {
  const sentinel = '__ARCHIVER_DOC_SELECTION_SENTINEL__';
  await writeClipboard('<span>' + sentinel + '</span>', sentinel);
  await dispatchKey(tabId, 'c', 'KeyC', 67, 2);
  await sleep(160);
  const text = await readClipboardText();
  return text === sentinel ? '' : String(text || '');
}

async function locateGoogleDocAnchor(tabId, query) {
  await focusGoogleDocEditor(tabId);
  await dispatchKey(tabId, 'f', 'KeyF', 70, 2);
  await sleep(120);
  await cdp(tabId, 'Input.insertText', { text: query });
  await sleep(320);
  await dispatchKey(tabId, 'Enter', 'Enter', 13, 0).catch(() => {});
  await sleep(120);
  await dispatchKey(tabId, 'Escape', 'Escape', 27, 0);
  await sleep(180);

  const selected = normalizeDocSearchText(await copyEditorSelectionText(tabId));
  const expected = normalizeDocSearchText(query);
  if (!selected || !selected.includes(expected)) return false;

  // Collapse the proven editor selection to its end; only after this
  // verification may an image be pasted.
  await dispatchKey(tabId, 'ArrowRight', 'ArrowRight', 39, 0);
  await sleep(80);
  await dispatchKey(tabId, 'Enter', 'Enter', 13, 0);
  await sleep(100);
  return true;
}

function recoveredImageItems(archive) {
  const refs = Array.isArray(archive?.lastRecoveredImageRefs)
    ? archive.lastRecoveredImageRefs
    : [];
  const messages = archive?.messages || [];
  const items = [];

  for (const ref of refs) {
    const message = messages.find(item =>
      (ref.messageId && item.id === ref.messageId) ||
      (ref.messageSignature && messageSignature(item.role, item.text) === ref.messageSignature)
    );
    if (!message) continue;
    const image = (message.images || []).find(item => item?.src === ref.src);
    if (!image?.dataUrl || image.binaryStatus !== 'ready') continue;
    items.push({ message, image, ref });
  }
  return items;
}

async function patchRecoveredImagesToLinkedDoc(archiveId = '') {
  const archive = await getArchive(archiveId) || await getLastArchive();
  if (!archive) throw new Error('Нет локального архива.');
  const linked = await getLinkedDoc(archive.sourceUrl || '');
  const docUrl = normalizeGoogleDocUrl(linked?.url || '');
  if (!docUrl) throw new Error('Для этого архива не найден связанный Google Doc.');

  const allItems = recoveredImageItems(archive);
  if (!allItems.length) {
    return { docUrl, inserted: 0, failed: 0, noChanges: true, failures: [] };
  }

  const docId = googleDocKey(docUrl);
  const patchStateRaw = await chrome.storage.local.get(DOC_IMAGE_PATCHES_KEY);
  const patchState = { ...(patchStateRaw[DOC_IMAGE_PATCHES_KEY] || {}) };
  const done = new Set(Array.isArray(patchState[docId]) ? patchState[docId] : []);

  const keyOf = item => hashText(
    String(item?.ref?.messageId || item?.ref?.messageSignature || '') + '|' +
    String(item?.image?.src || '')
  );
  const items = allItems.filter(item => !done.has(keyOf(item)));
  if (!items.length) {
    return { docUrl, inserted: 0, failed: 0, noChanges: true, failures: [] };
  }

  let tab = null;
  let attached = false;
  let inserted = 0;
  const failures = [];

  try {
    tab = await chrome.tabs.create({ url: docUrl, active: true });
    if (!tab?.id) throw new Error('Не удалось открыть связанный Google Doc.');
    await waitForTabComplete(tab.id);
    await sleep(1800);

    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    attached = true;
    await sleep(400);

    const docText = await copyCurrentGoogleDocTabText(tab.id);
    const grouped = new Map();
    for (const item of items) {
      const key = item.message.id || messageSignature(item.message.role, item.message.text);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }

    for (const group of grouped.values()) {
      const message = group[0].message;
      const anchor = uniqueMessageAnchor(docText, message);
      if (!anchor) {
        for (const item of group) {
          failures.push({ src: item.image.src || '', error: 'Не найден уникальный текстовый якорь сообщения в Google Doc.' });
        }
        continue;
      }

      const located = await locateGoogleDocAnchor(tab.id, anchor);
      if (!located) {
        for (const item of group) {
          failures.push({ src: item.image.src || '', error: 'Google Docs не подтвердил выделение якоря; вставка пропущена.' });
        }
        continue;
      }

      for (const item of group) {
        const copied = await copyImageClipboardInGoogleDocs(tab.id, item.image);
        if (!copied?.ok) {
          failures.push({ src: item.image.src || '', error: copied?.error || 'clipboard failed' });
          continue;
        }
        await dispatchKey(tab.id, 'v', 'KeyV', 86, 2);
        await sleep(850);
        await dispatchKey(tab.id, 'Enter', 'Enter', 13, 0);
        await sleep(120);
        inserted++;
        done.add(keyOf(item));
      }
    }

    patchState[docId] = [...done];
    await chrome.storage.local.set({ [DOC_IMAGE_PATCHES_KEY]: patchState });
  } finally {
    if (attached && tab?.id) await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
  }

  return {
    docUrl,
    inserted,
    failed: failures.length,
    noChanges: false,
    failures
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

async function exportConversation({ activeDoc = false, archiveId = '' } = {}) {
  const conversation = archiveId ? await getArchive(archiveId) : await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');

  if (conversation.isFragment && activeDoc) throw new Error('Фрагмент можно экспортировать только в новый Google Doc.');
  if (!activeDoc) {
    const autoParts = planGoogleDocParts(conversation.messages || [], []);
    if (autoParts.length > 1) {
      if (conversation.isFragment) throw new Error('Этот фрагмент превышает лимит одного Google Doc. Скопируйте его или разбейте на части.');
      return exportTabbedConversation('', conversation.id);
    }
  }

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
  const linkedDoc = conversation.isFragment
    ? await setArchiveDestination(conversation.id, { saved: true, url: finalTab.url, kind: 'google-doc', label: 'Google Docs' })
    : await recordDocExport(conversation, finalTab.url);

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

async function renameGoogleDoc(tabId, title) {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(250);
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const selectors = [
          '#docs-title-input',
          'input.docs-title-input',
          'input[aria-label*="Rename"]',
          'input[aria-label*="Переимен"]',
          'input[aria-label*="назван"]'
        ];
        for (const selector of selectors) {
          const input = document.querySelector(selector);
          if (!input || typeof input.focus !== 'function') continue;
          input.focus();
          if (typeof input.select === 'function') input.select();
          return true;
        }
        return false;
      })()`,
      returnByValue: true
    });
    if (!result?.result?.value) return false;
    await cdp(tabId, 'Input.insertText', { text: String(title || '').trim() });
    await dispatchKey(tabId, 'Enter', 'Enter', 13, 0);
    await sleep(260);
    return true;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function selectGoogleDocTextAttached(tabId, query) {
  await focusGoogleDocEditor(tabId);
  await dispatchKey(tabId, 'f', 'KeyF', 70, 2);
  await sleep(120);
  await cdp(tabId, 'Input.insertText', { text: query });
  await sleep(300);
  await dispatchKey(tabId, 'Enter', 'Enter', 13, 0).catch(() => {});
  await sleep(100);
  await dispatchKey(tabId, 'Escape', 'Escape', 27, 0);
  await sleep(160);

  const selected = normalizeDocSearchText(await copyEditorSelectionText(tabId));
  const expected = normalizeDocSearchText(query);
  return Boolean(selected && selected.includes(expected));
}

async function selectInsertedGoogleDocNavigationAtEnd(tabId, text) {
  const expected = normalizeDocSearchText(text);
  if (!expected) return false;

  // The forward link is inserted as the final standalone paragraph.
  // Select it locally from the caret instead of opening Docs search:
  // on very large documents Ctrl+F can lag, and typing the search query then
  // lands in the document body, duplicating the label inside conversation text.
  const attempts = [
    { key: 'Home', code: 'Home', vk: 36, modifiers: 8 },       // Shift+Home
    { key: 'ArrowUp', code: 'ArrowUp', vk: 38, modifiers: 10 } // Ctrl+Shift+Up
  ];

  for (const attempt of attempts) {
    await dispatchKey(tabId, 'End', 'End', 35, 2); // Ctrl+End: collapse at true document end.
    await sleep(180);
    await dispatchKey(tabId, attempt.key, attempt.code, attempt.vk, attempt.modifiers);
    await sleep(180);

    const selected = normalizeDocSearchText(await copyEditorSelectionText(tabId));
    if (selected === expected) return true;
  }

  return false;
}

async function insertGoogleDocNavigation(tabId, label, url, position = 'end') {
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(220);
    await focusGoogleDocEditor(tabId);

    const goToStart = position === 'start';
    await dispatchKey(
      tabId,
      goToStart ? 'Home' : 'End',
      goToStart ? 'Home' : 'End',
      goToStart ? 36 : 35,
      2
    );
    await sleep(140);

    const text = String(label || '').trim();
    if (!text) throw new Error('Пустая подпись междокументной ссылки.');

    await cdp(tabId, 'Input.insertText', {
      text: goToStart ? text + '\n\n' : '\n\n' + text
    });
    await sleep(goToStart ? 260 : 420);

    const selected = goToStart
      ? await selectGoogleDocTextAttached(tabId, text)
      : await selectInsertedGoogleDocNavigationAtEnd(tabId, text);
    if (!selected) {
      throw new Error('Не удалось безопасно выделить текст междокументной ссылки: ' + text);
    }

    await dispatchKey(tabId, 'k', 'KeyK', 75, 2);
    await sleep(goToStart ? 360 : 650);
    await cdp(tabId, 'Input.insertText', { text: String(url || '') });
    await sleep(goToStart ? 160 : 260);
    await dispatchKey(tabId, 'Enter', 'Enter', 13, 0);
    await sleep(goToStart ? 320 : 650);
    return true;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function inspectSingleNewGoogleDoc(tabId) {
  const current = await chrome.tabs.get(tabId);
  const seenTabTokens = new Set([googleDocTabToken(current.url || '')].filter(Boolean));
  let initialTabCount = 0;
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(420);
    const inventory = await inspectGoogleDocTabsAttached(tabId);
    initialTabCount = inventory.count;
    for (const token of inventory.tokens) seenTabTokens.add(token);
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  if (initialTabCount !== 1) {
    throw new Error(
      'Новый Google Doc должен начинаться с одной первой вкладки, но найдено: ' +
      initialTabCount + '. Экспорт не начат.'
    );
  }
  return seenTabTokens;
}

async function verifyGoogleDocTabCount(tabId, expectedCount) {
  let verifiedTabCount = 0;
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await sleep(350);
    const state = await googleDocPageState(tabId);
    const inventory = await inspectGoogleDocTabsAttached(tabId, {
      restoreToken: googleDocTabToken(state.href)
    });
    verifiedTabCount = inventory.count;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  if (verifiedTabCount !== expectedCount) {
    throw new Error(
      'После экспорта количество вкладок не совпало с планом: создано ' +
      verifiedTabCount + ', должно быть ' + expectedCount +
      '. Документ оставлен открытым для проверки.'
    );
  }
  return verifiedTabCount;
}

async function exportTabbedConversation(planText = '', archiveId = '') {
  const conversation = archiveId ? await getArchive(archiveId) : await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');

  const messages = conversation.messages || [];
  if (!messages.length) throw new Error('В архиве нет сообщений для экспорта.');

  const events = parseTabPlan(planText, messages.length);
  const parts = planGoogleDocParts(messages, events);
  const settings = await getSettings();
  const docs = [];
  let imageInsertedCount = 0;
  let imageFailedCount = 0;
  const failedImages = [];
  let totalTabs = 0;
  let totalHeadings = 0;

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    const sections = buildTabbedSections(part.messages, part.events);
    if (sections.length > 40) {
      throw new Error(
        'В части ' + (partIndex + 1) +
        ' получилось больше 40 вкладок. Поставьте границы документов раньше.'
      );
    }

    const browserTab = await chrome.tabs.create({ url: DOCS_NEW_URL, active: true });
    if (!browserTab?.id) throw new Error('Не удалось открыть новый Google Doc.');
    await waitForTabComplete(browserTab.id);
    await sleep(2200);

    const title = partTitle(conversation.title || 'ChatGPT conversation', part.partNumber, parts.length);
    const renamed = await renameGoogleDoc(browserTab.id, title).catch(() => false);
    const seenTabTokens = await inspectSingleNewGoogleDoc(browserTab.id);

    if (partIndex > 0) {
      const previous = docs[partIndex - 1];
      await insertGoogleDocNavigation(
        browserTab.id,
        previous.title,
        previous.url,
        'start'
      );
    }

    let completedTabs = 0;
    try {
      for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
        const section = sections[sectionIndex];

        if (sectionIndex > 0) {
          const created = await createNextGoogleDocsTab(
            browserTab.id,
            seenTabTokens,
            sectionIndex
          );
          if (created?.token) seenTabTokens.add(created.token);
        }

        const pasted = await pasteArchiveIntoGoogleDoc(
          browserTab.id,
          {
            ...conversation,
            title,
            messages: part.messages
          },
          section.messages,
          settings,
          {
            includeHeader: sectionIndex === 0,
            appendToEnd: true
          }
        );

        imageInsertedCount += Number(pasted.imageInsertedCount || 0);
        imageFailedCount += Number(pasted.imageFailedCount || 0);
        failedImages.push(...(pasted.failedImages || []));
        completedTabs++;
      }
    } catch (error) {
      throw new Error(
        'Разделение остановлено в части ' + (partIndex + 1) +
        ' после ' + completedTabs + ' из ' + sections.length +
        ' вкладок. Документ оставлен открытым. Причина: ' +
        (error?.message || String(error))
      );
    }

    const verifiedTabCount = await verifyGoogleDocTabCount(browserTab.id, sections.length);
    const finalTab = await chrome.tabs.get(browserTab.id);
    const partConversation = {
      ...conversation,
      title,
      messages: part.messages
    };
    await recordDocExport(partConversation, finalTab.url, { link: false });

    docs.push({
      partNumber: part.partNumber,
      title,
      url: finalTab.url,
      renamed,
      startMessageNumber: part.startMessageNumber,
      endMessageNumber: part.endMessageNumber,
      estimatedChars: part.estimatedChars,
      tabCount: verifiedTabCount
    });
    totalTabs += verifiedTabCount;
    totalHeadings += part.events.filter(event => event.type === 'heading').length;

    if (partIndex > 0) {
      const previous = docs[partIndex - 1];
      const previousTab = await chrome.tabs.get(previous.browserTabId || 0).catch(() => null);
      let previousTabId = previousTab?.id || null;
      if (previousTabId == null) {
        const reopened = await chrome.tabs.create({ url: previous.url, active: true });
        previousTabId = reopened?.id || null;
        if (previousTabId != null) {
          await waitForTabComplete(previousTabId);
          await sleep(1400);
        }
      }
      if (previousTabId != null) {
        await insertGoogleDocNavigation(previousTabId, title, finalTab.url, 'end');
      }
    }

    docs[docs.length - 1].browserTabId = browserTab.id;
  }

  const finalDoc = docs[docs.length - 1];
  const linkedDocBase = await recordDocExport(conversation, finalDoc.url, { link: true });
  const linkedDoc = await setLinkedDoc(conversation.sourceUrl, {
    ...(linkedDocBase || {}),
    url: finalDoc.url,
    docId: googleDocKey(finalDoc.url),
    parts: docs.map(({ browserTabId, ...item }) => item)
  });

  return {
    docUrl: finalDoc.url,
    docs: docs.map(({ browserTabId, ...item }) => item),
    documentCount: docs.length,
    archive: summarize(conversation),
    linkedDoc,
    exportMode: docs.length > 1 ? 'tabbed-multi-doc' : 'tabbed-full',
    addedCount: messages.length,
    tabCount: totalTabs,
    headingCount: totalHeadings,
    imageInsertedCount,
    imageFailedCount,
    failedImages,
    noChanges: false
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return;
  (async () => {
    await captureRuntimeReady;
    switch (message?.type) {
      case 'ARCHIVER_CHECK_UPDATE':
        return await checkForUpdate();
      case 'ARCHIVER_CAPTURE_FRAGMENT':
        return await startCapture({ mode: 'fragment', captureTarget: message.captureTarget || 'copy' });
      case 'ARCHIVER_CAPTURE_CURRENT':
        return await startCapture({
          mode: 'full',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_RECOVER_IMAGES_CURRENT':
        return await startCapture({
          mode: 'images',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_CONTINUE_CURRENT':
        return await startCapture({
          mode: 'continue',
          docUrl: message.docUrl || '',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_CONTINUE_SAVED_ARCHIVE':
        return await continueSavedArchive(
          message.archiveId || '',
          message.captureTarget || 'copy'
        );
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
        let job = await getJob();
        // A killed MV3 worker can leave an indefinitely "running" job behind,
        // but a long navigation-only pass may legitimately keep the message
        // count unchanged. Before declaring the run dead, ask the concrete
        // capture tab whether the same job is still executing.
        if (job && ['starting', 'running'].includes(job.status) &&
            Date.now() - Number(job.updatedAt || job.startedAt || Date.now()) > 300000) {
          const health = await probeLiveCapture(job);
          const alive = Boolean(
            health?.ok &&
            health.running &&
            health.jobId === job.jobId
          );

          if (alive) {
            job = await setJob({
              lastHeartbeatAt: Date.now(),
              contentScriptVersion: health.version || job.contentScriptVersion || '',
              lastScrollDirection: health.lastScrollDirection || job.lastScrollDirection || ''
            });
          } else {
            const draft = job.draftId ? await getDraft(job.draftId) : null;
            job = await setJob({
              status: 'error',
              message: draft?.messages?.length
                ? 'Сбор перестал отвечать. Контрольная точка сохранена — можно продолжить.'
                : 'Сбор перестал отвечать до создания контрольной точки.',
              draftCount: draft?.messages?.length || 0,
              finishedAt: Date.now()
            });
          }
        }
        const tab = await getActiveTab();
        let currentArchive = null;
        let linkedDoc = null;
        if (tab?.url && isConversationUrl(tab.url)) {
          currentArchive = await getArchiveForUrl(tab.url);
          linkedDoc = await getLinkedDoc(tab.url);
        }
        const archive = currentArchive || await getLastArchive();
        if (!linkedDoc && archive?.sourceUrl) {
          linkedDoc = await getLinkedDoc(archive.sourceUrl);
        }
        const draft = job?.draftId ? await getDraft(job.draftId) : null;
        const drafts = await listDrafts();
        const unfinishedPasses = [];
        for (const item of drafts) {
          const recoveryTab = await resolveDraftRecoveryTab(item.id, item.sourceUrl || '');
          unfinishedPasses.push({
            ...summarize(item),
            complete: Boolean(item.complete),
            error: item.error || '',
            captureMode: item.captureMode || '',
            capturePhase: item.capturePhase || '',
            partialSaveEnabled: Boolean(item.partialSaveEnabled),
            partialArchiveId: item.partialArchiveId || '',
            partialSavedAt: item.partialSavedAt || '',
            navigationHighWater: Number(item.navigationHighWater || 0),
            chronologicalCount: Number(item.chronologicalCount || item.messages?.length || 0),
            hasBoundary: Boolean(item.captureBoundary?.kind && item.captureBoundary?.key),
            recoveryTabAvailable: recoveryTab.available,
            recoveryTabId: recoveryTab.available ? recoveryTab.record.tabId : null,
            recoveryCaptureTarget: recoveryTab.available ? recoveryTab.record.captureTarget : ''
          });
        }
        return {
          ok: true,
          job,
          archive: summarize(archive),
          unfinishedPass: summarize(draft),
          unfinishedPasses,
          linkedDoc,
          savedArchives: await listLinkedArchives(),
          canContinue: Boolean(currentArchive?.messages?.length),
          history: await getRunHistory()
        };
      }
      case 'ARCHIVER_GET_DRAFT':
      case 'ARCHIVER_GET_UNFINISHED_PASS': {
        const draft = await getDraft(message.draftId || message.passId || '');
        return { ok: true, unfinishedPass: draft, draft };
      }
      case 'ARCHIVER_COMPARE_UNFINISHED_PASS':
        return await compareUnfinishedPass(message.passId || message.draftId || '');
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
      case 'ARCHIVER_FOCUS_FAILED_CAPTURE_TAB':
        return await focusRecoverableCaptureTab();
      case 'ARCHIVER_FOCUS_UNFINISHED_RECOVERY_TAB':
        return await focusUnfinishedRecoveryTab(message.passId || message.draftId || '');
      case 'ARCHIVER_RESUME_FAILED_CAPTURE':
        return await resumeFailedCaptureFromWorkingTab();
      case 'ARCHIVER_RESUME_UNFINISHED_PASS':
        return await resumeSavedUnfinishedPass(
          message.passId || message.draftId || '',
          message.captureTarget || 'copy',
          message.resumeStrategy || 'auto'
        );
      case 'ARCHIVER_RESUME_UNFINISHED_IN_SAVED_TAB':
        return await resumeUnfinishedInSavedTab(message.passId || message.draftId || '');
      case 'ARCHIVER_SAVE_UNFINISHED_PARTIAL':
        return await saveUnfinishedAsPartial(message.passId || message.draftId || '');
      case 'ARCHIVER_DELETE_DRAFT':
      case 'ARCHIVER_DELETE_UNFINISHED_PASS':
        return await deleteDraftAndRecoveryTab(message.draftId || message.passId || '');
      case 'ARCHIVER_DELETE_ARCHIVE':
        return await deleteLocalArchive(message.archiveId || '');
      case 'ARCHIVER_SET_ARCHIVE_DESTINATION':
        return await setArchiveSavedDestination(
          message.archiveId || '',
          {
            saved: message.saved !== false,
            url: message.url || '',
            label: message.label || ''
          }
        );
      case 'ARCHIVER_CHECKPOINT_SAVED': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId ||
            !['starting', 'running', 'paused'].includes(job.status) ||
            (job.captureTabId != null && sender?.tab?.id !== job.captureTabId)) {
          return { ok: false, error: 'Контрольная точка от устаревшего запуска.' };
        }
        const draftId = String(message.draftId || '');
        if (!draftId || (draftId !== job.draftId && draftId !== job.recoveryDraftId &&
            draftId !== 'draft-' + job.jobId)) {
          return { ok: false, error: 'Контрольная точка не принадлежит текущему запуску.' };
        }
        // The collector has already awaited the write. getBytesInUse checks
        // existence without deserializing a multi-thousand-message draft.
        const bytes = await chrome.storage.local.getBytesInUse('draft:' + draftId);
        if (!bytes) return { ok: false, error: 'Контрольная точка недоступна.' };
        await setJob({
          draftId,
          draftCount: Math.max(Number(job.draftCount || 0), Number(message.draftCount || 0))
        });

        const recoveryTabId = sender?.tab?.id ?? job.captureTabId;
        if (recoveryTabId != null) {
          await setDraftRecoveryTab(draftId, {
            tabId: recoveryTabId,
            sourceUrl: job.sourceUrl || sender?.tab?.url || '',
            sourceTabId: job.sourceTabId ?? job.tabId ?? null,
            captureTarget: job.captureTarget || '',
            jobId: job.jobId
          });
        }

        const checkpointDraft = await getDraft(draftId);
        if (checkpointDraft?.partialSaveEnabled) {
          try {
            await syncPartialArchiveFromDraft(checkpointDraft);
          } catch (error) {
            await appendRunLog({}, {
              level: 'warn',
              code: 'PARTIAL_AUTOSAVE_FAILED',
              message: error?.message || String(error),
              phase: checkpointDraft.capturePhase || job.phase || '',
              count: checkpointDraft.messages?.length || 0
            });
          }
        }

        return { ok: true };
      }
      case 'ARCHIVER_CAPTURE_PROGRESS': {
        const job = await getJob();
        if (!job || !['starting', 'running'].includes(job.status) || job.jobId !== message.jobId) return { ok: false, error: 'Сбор уже неактуален.' };
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
        if (!job || job.jobId !== message.jobId ||
            !['starting', 'running'].includes(job.status)) {
          return { ok: false, error: 'Сбор уже остановлен или неактуален.' };
        }
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId == null || senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Физическая прокрутка разрешена только вкладке текущего сбора.' };
        }
        const liveTab = await chrome.tabs.get(job.captureTabId).catch(() => null);
        const expected = conversationKey(job.sourceUrl || '');
        const actual = conversationKey(liveTab?.url || '');
        if (expected && actual !== expected) {
          return { ok: false, error: 'Прокрутка остановлена: вкладка больше не содержит исходную переписку.' };
        }

        // A successful physical-scroll request is itself proof that the
        // collector is alive, even if the navigation-only phase has not changed
        // the message count for several minutes.
        await setJob({
          lastHeartbeatAt: Date.now(),
          lastPhysicalActivity: 'scroll'
        });
        return await physicalScrollTab(job.captureTabId, message.direction, message.bursts);
      }
      case 'ARCHIVER_PHYSICAL_CLICK': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId ||
            !['starting', 'running'].includes(job.status)) {
          return { ok: false, error: 'Сбор уже остановлен или неактуален.' };
        }
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId == null || senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Физическое нажатие разрешено только вкладке текущего сбора.' };
        }
        return await physicalClickChatTab(job.captureTabId, message.point || {});
      }
      case 'ARCHIVER_PHYSICAL_COPY_SELECTION': {
        const job = await getJob();
        if (!job || job.jobId !== message.jobId ||
            !['starting', 'running'].includes(job.status)) {
          return { ok: false, error: 'Сбор уже остановлен или неактуален.' };
        }
        const senderTabId = sender?.tab?.id;
        if (job.captureTabId == null || senderTabId !== job.captureTabId) {
          return { ok: false, error: 'Физическое копирование разрешено только вкладке текущего сбора.' };
        }
        return await physicalCopyChatSelection(job.captureTabId);
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
      case 'ARCHIVER_GET_FRAGMENT': {
        const record = await chrome.storage.local.get('fragmentLatestId');
        const fragment = await getArchive(record.fragmentLatestId || '');
        return { ok: true, fragment: fragment ? summarize(fragment) : null };
      }
      case 'ARCHIVER_COPY_SELECTED_FRAGMENT': {
        const record = await chrome.storage.local.get('fragmentLatestId');
        const fragment = await getArchive(record.fragmentLatestId || '');
        if (!fragment?.isFragment) throw new Error('Сначала соберите фрагмент.');
        const settings = await getSettings();
        await writeClipboard(buildRichHtml(fragment, settings), buildPlainText(fragment, settings));
        return { ok: true, count: fragment.messages.length };
      }
      case 'ARCHIVER_COPY_ARCHIVE': {
        const archive = await getArchive(message.archiveId) || await getLastArchive();
        if (!archive) throw new Error('Нет завершенного архива для копирования.');
        const settings = await getSettings();
        await writeClipboard(buildRichHtml(archive, settings), buildPlainText(archive, settings));
        return { ok: true, count: archive.messages?.length || 0 };
      }
      case 'ARCHIVER_COPY_DRAFT':
      case 'ARCHIVER_COPY_UNFINISHED_PASS': {
        const draft = await getDraft(message.draftId || message.passId);
        if (!draft) throw new Error('Сохранённый незавершённый проход не найден.');
        const settings = await getSettings();
        await writeClipboard(
          buildRichHtml(draft, settings, { includeHeader: true }),
          buildPlainText(draft, settings, { includeHeader: true })
        );
        return { ok: true, count: draft.messages?.length || 0 };
      }
      case 'ARCHIVER_COPY_RUN_LOG': {
        const job = await getJob();
        const text = await formatDiagnosticLog();
        await writeClipboard('<pre>' + escapeHtml(text) + '</pre>', text);
        return { ok: true };
      }
      case 'ARCHIVER_CAPTURE_COMPLETE':
        await handleCaptureComplete(message);
        return { ok: true };
      case 'ARCHIVER_EXPORT_NEW_DOC':
        return { ok: true, ...(await exportConversation({
          activeDoc: false,
          archiveId: message.archiveId || ''
        })) };
      case 'ARCHIVER_EXPORT_TABBED_NEW_DOC':
        return { ok: true, ...(await exportTabbedConversation(
          message.planText || '',
          message.archiveId || ''
        )) };
      case 'ARCHIVER_EXPORT_ACTIVE_DOC':
        return { ok: true, ...(await exportConversation({
          activeDoc: true,
          archiveId: message.archiveId || ''
        })) };
      case 'ARCHIVER_PATCH_RECOVERED_IMAGES':
        return { ok: true, ...(await patchRecoveredImagesToLinkedDoc(message.archiveId || '')) };
      default:
        return null;
    }
  })().then(result => sendResponse(result)).catch(error => {
    void logTabListenerError('runtime.onMessage:' + String(message?.type || 'unknown'), error);
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function logTabListenerError(source, error) {
  const message = String(error?.stack || error?.message || error);
  console.error(source, error);
  try {
    const key = 'archiverWorkerErrors';
    const rows = (await chrome.storage.local.get(key))[key] || [];
    const next = Array.isArray(rows) ? rows.slice(-29) : [];
    next.push({ at: Date.now(), source, message: message.slice(0, 3000) });
    await chrome.storage.local.set({ [key]: next });
  } catch (loggingError) {
    console.error('Failed to save worker error', loggingError);
  }
}

self.addEventListener('unhandledrejection', event => {
  void logTabListenerError('worker.unhandledrejection', event.reason);
});
self.addEventListener('error', event => {
  void logTabListenerError('worker.error', event.error || event.message || 'Unknown worker error');
});

chrome.tabs.onRemoved.addListener(tabId => {
  (async () => {
  await captureRuntimeReady;
  const job = await getJob();
  if (!job) return;

  if (
    ['error', 'cancelled'].includes(job.status) &&
    job.recoveryAvailable &&
    job.captureTabId === tabId
  ) {
    await setJob({
      recoveryAvailable: false,
      captureTabId: null,
      message: (job.message || 'Сбор оборвался.') + ' Сохранённая рабочая вкладка закрыта; незавершённый проход остаётся доступен.'
    });
    return;
  }

  if (!['starting', 'running', 'paused'].includes(job.status)) return;

  if (job.captureTabId === tabId) {
    await finishJobWithError(
      job.jobId,
      job.sourceTabId ?? job.tabId,
      job.captureTarget === 'current'
        ? 'Текущая вкладка с перепиской была закрыта.'
        : 'Рабочая копия с перепиской была закрыта. Незавершённый проход можно продолжить.',
      job.draftId || '',
      Number(job.draftCount || 0)
    );
  }
  })().catch(error => logTabListenerError('tabs.onRemoved', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
  await captureRuntimeReady;
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
  }
  // A thaw is not user consent to resume a capture. Keep paused state
  // until an explicit resume command verifies the live content script.

  // ChatGPT changes conversations using client-side routing without leaving
  // chatgpt.com. Detect a changed conversation identity, not just the host.
  const expectedConversation = conversationKey(job.sourceUrl || '');
  const actualConversation = conversationKey(tab.url || changeInfo.url || '');
  if (expectedConversation && actualConversation && actualConversation !== expectedConversation) {
    await finishJobWithError(
      job.jobId,
      job.sourceTabId ?? job.tabId,
      'Сбор остановлен: вкладка переключилась на другую переписку. Сохранённые контрольные точки не удалены.',
      job.draftId || '',
      Number(job.draftCount || 0)
    );
    return;
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
  })().catch(error => logTabListenerError('tabs.onUpdated', error));
});


// Extension code reload invalidates content-script execution, but storage
// survives. Invalidate the old running job on first worker start per version.
const CAPTURE_RUNTIME_VERSION_KEY = 'archiverCaptureRuntimeVersion';
async function retireCaptureAfterVersionChange() {
  const version = chrome.runtime.getManifest().version || '';
  const stored = await chrome.storage.local.get(CAPTURE_RUNTIME_VERSION_KEY);
  if (stored[CAPTURE_RUNTIME_VERSION_KEY] === version) return;
  const job = await getJob();
  if (job && ['starting', 'running', 'paused'].includes(job.status)) {
    await setJob({
      status: 'error',
      recoveryAvailable: false,
      finishedAt: Date.now(),
      message: 'Расширение обновлено: прежний сбор остановлен. Сохранённый черновик доступен для ручного продолжения.'
    });
  }
  await chrome.storage.local.set({ [CAPTURE_RUNTIME_VERSION_KEY]: version });
}
const captureRuntimeReady = retireCaptureAfterVersionChange().catch(error => {
  console.error('Capture version migration failed', error);
  throw error;
});

chrome.runtime.onInstalled.addListener(details => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  checkForUpdate().catch(() => {});

  if (details?.reason === 'update') {
    chrome.storage.local.set({
      [WHATS_NEW_PENDING_KEY]: {
        version: chrome.runtime.getManifest().version || '',
        previousVersion: details.previousVersion || '',
        updatedAt: Date.now()
      }
    }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  checkForUpdate().catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name !== UPDATE_ALARM) return;
  checkForUpdate().catch(() => {});
});
