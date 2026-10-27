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
const AUTO_RECOVERY_MAX_ATTEMPTS = 0;
const AUTO_RECOVERY_TRIGGER_DELAY_MS = 900;
const AUTO_RECOVERY_ALARM_PREFIX = 'archiver-auto-recovery:';

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
  registerArchive,
  getLinkedDoc,
  setLinkedDoc,
  clearLinkedDoc,
  getArchiveDestination,
  setArchiveDestination,
  getDocExport,
  recordDocExport
} = archiveStore;
const summarize = summarizeArchive;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, timeoutMs, label = 'Операция') {
  const ms = Math.max(1000, Number(timeoutMs) || 15000);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(label + ' не ответила за ' + Math.round(ms / 1000) + ' с.')),
        ms
      );
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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

function unfinishedBoundaryKey(item) {
  const kind = item?.boundaryKind || item?.captureBoundary?.kind || '';
  const key = item?.boundaryKey || item?.captureBoundary?.key || '';
  return kind && key ? String(kind) + ':' + String(key) : 'legacy';
}

function unfinishedRangeKey(item) {
  const mode = String(item?.captureMode || '');
  const range = item?.captureRange || item?.manualFullRange || item?.fragmentMarkers || {};
  const start = range?.start || {};
  const end = range?.end || {};
  const startKey = String(start.id || start.signature || '');
  const endKey = String(end.id || end.signature || '');
  if (!startKey && !endKey) return 'full-range';
  return [
    mode || 'range',
    'start:' + (startKey || 'open'),
    'end:' + (endKey || 'open')
  ].join(':');
}

function unfinishedGroupKey(item) {
  const source = conversationKey(item?.sourceUrl || '') ||
    String(item?.sourceUrl || '') ||
    String(item?.id || '');
  return [source, unfinishedBoundaryKey(item), unfinishedRangeKey(item)].join('|');
}

function storedImageReady(image) {
  return Boolean(image?.binaryStatus === 'ready' && image?.dataUrl);
}

function mergeStoredImageRecords(primaryImages = [], alternateImages = []) {
  const merged = primaryImages.map(image => ({ ...image }));
  const bySrc = new Map();
  merged.forEach((image, index) => {
    const src = String(image?.src || '');
    if (src && !bySrc.has(src)) bySrc.set(src, index);
  });

  for (const alternate of alternateImages || []) {
    const src = String(alternate?.src || '');
    if (!src) continue;
    const index = bySrc.get(src);
    if (index == null) {
      bySrc.set(src, merged.length);
      merged.push({ ...alternate, index: merged.length });
      continue;
    }

    const current = merged[index] || {};
    if (storedImageReady(alternate) && !storedImageReady(current)) {
      merged[index] = { ...current, ...alternate, index };
      continue;
    }

    merged[index] = {
      ...current,
      alt: current.alt || alternate?.alt || '',
      width: current.width || alternate?.width || null,
      height: current.height || alternate?.height || null,
      placement: current.placement || alternate?.placement || '',
      mimeType: current.mimeType || alternate?.mimeType || '',
      byteSize: current.byteSize || alternate?.byteSize || 0,
      dataUrl: current.dataUrl || alternate?.dataUrl || '',
      binaryStatus: storedImageReady(current)
        ? 'ready'
        : (alternate?.binaryStatus || current.binaryStatus || 'pending'),
      binaryError: storedImageReady(current)
        ? ''
        : (current.binaryError || alternate?.binaryError || ''),
      index
    };
  }

  merged.forEach((image, index) => { image.index = index; });
  return merged;
}

function mergeStoredMessageCapture(primary, alternate) {
  if (!primary) return alternate;
  if (!alternate) return primary;
  const primaryImages = primary.images || [];
  const mergedImages = mergeStoredImageRecords(primaryImages, alternate.images || []);
  const merged = { ...primary, images: mergedImages };

  if (!primary.reasoningText && alternate.reasoningText) {
    merged.reasoningText = alternate.reasoningText;
    merged.reasoningHtml = alternate.reasoningHtml;
    merged.reasoningLabel = alternate.reasoningLabel;
    merged.reasoningStatus = alternate.reasoningStatus;
    merged.reasoningCount = alternate.reasoningCount;
  }

  if (mergedImages.length > primaryImages.length && alternate.html) {
    merged.html = alternate.html;
  }
  return merged;
}

function storedMessagesMatch(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(
    a.text && b.text &&
    messageSignature(a.role, a.text) === messageSignature(b.role, b.text)
  );
}

// Merge only verified chronological prefixes from the same conversation,
// snapshot boundary and manual range. Once the merged canonical draft is
// durably written, compatible technical retry copies are redundant and may
// be removed; unrelated ranges/boundaries are never collapsed.
async function reconcileUnfinishedPrefix(draft) {
  if (!draft?.id || !draft.messages?.length ||
      !['walk', 'finalizing'].includes(draft.capturePhase || '')) return draft;
  const source = conversationKey(draft.sourceUrl || '');
  const boundary = unfinishedBoundaryKey(draft);
  const range = unfinishedRangeKey(draft);
  if (!source || boundary === 'legacy') return draft;
  const others = (await listDrafts()).filter(item =>
    item?.id !== draft.id &&
    ['walk', 'finalizing'].includes(item.capturePhase || '') &&
    conversationKey(item.sourceUrl || '') === source &&
    unfinishedBoundaryKey(item) === boundary &&
    unfinishedRangeKey(item) === range &&
    item.messages?.length
  );
  const matchingMessage = storedMessagesMatch;
  const compatible = [draft, ...others.filter(candidate => {
    const n = Math.min(draft.messages.length, candidate.messages.length);
    // Require at least two matching turns and all available overlap in order.
    return n >= 2 && Array.from({ length: n }, (_, i) => i)
      .every(i => matchingMessage(draft.messages[i], candidate.messages[i]));
  })];
  if (compatible.length < 2) return draft;
  const longest = compatible.reduce((best, item) =>
    item.messages.length > best.messages.length ? item : best, draft);
  const messages = longest.messages.map((message, i) => {
    let enriched = message;
    for (const candidate of compatible) {
      const alternate = candidate.messages[i];
      if (!alternate || !matchingMessage(message, alternate)) continue;
      enriched = mergeStoredMessageCapture(enriched, alternate);
    }
    return enriched;
  });
  const imageReadyCount = message =>
    (message?.images || []).filter(storedImageReady).length;
  const newest = [...compatible].sort((a, b) =>
    String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
  )[0] || draft;
  const pendingDocSource = [...compatible]
    .sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')))
    .find(item => item.pendingDocUrl) || null;
  const partialSource = [...compatible]
    .sort((a, b) => String(b.partialSavedAt || b.capturedAt || '')
      .localeCompare(String(a.partialSavedAt || a.capturedAt || '')))
    .find(item => item.partialSaveEnabled || item.partialArchiveId) || null;

  const updated = {
    ...draft,
    messages,
    chronologicalCount: messages.length,
    imageCount: messages.reduce((n, item) => n + (item.images?.length || 0), 0),
    imageBinaryReady: messages.reduce((n, item) =>
      n + (item.images || []).filter(storedImageReady).length, 0),
    imageBinaryFailed: messages.reduce((n, item) =>
      n + (item.images || []).filter(image => image?.binaryStatus === 'failed').length, 0),
    capturePhase: 'walk',
    captureRange: longest.captureRange || newest.captureRange || draft.captureRange || null,
    navigationHighWater: Math.max(...compatible.map(item => Number(item.navigationHighWater || 0)), 0),
    resumeWindowSignatures: Array.isArray(longest.resumeWindowSignatures)
      ? longest.resumeWindowSignatures
      : (newest.resumeWindowSignatures || draft.resumeWindowSignatures || []),
    lastScrollDirection:
      longest.lastScrollDirection || newest.lastScrollDirection || draft.lastScrollDirection || 'down',
    pendingDocUrl: pendingDocSource?.pendingDocUrl || draft.pendingDocUrl || '',
    pendingDocMode: pendingDocSource?.pendingDocMode || draft.pendingDocMode || '',
    partialSaveEnabled: Boolean(
      draft.partialSaveEnabled || partialSource?.partialSaveEnabled
    ),
    partialArchiveId:
      partialSource?.partialArchiveId || draft.partialArchiveId || '',
    partialSavedAt:
      partialSource?.partialSavedAt || draft.partialSavedAt || '',
    recoveredFromDraftIds: [...new Set([
      ...(draft.recoveredFromDraftIds || []),
      ...compatible.map(item => item.id)
    ])]
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.draftPrefix + draft.id]: updated });

  const redundantIds = compatible
    .map(item => item.id)
    .filter(id => id && id !== draft.id);

  if (redundantIds.length) {
    const recoveryRecords = [];
    const canonicalRecovery = await getDraftRecoveryTabRecord(draft.id);
    if (canonicalRecovery) recoveryRecords.push(canonicalRecovery);
    for (const id of redundantIds) {
      const record = await getDraftRecoveryTabRecord(id);
      if (record) recoveryRecords.push(record);
    }
    recoveryRecords.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const bestRecovery = recoveryRecords[0] || null;
    if (bestRecovery?.tabId != null) {
      await setDraftRecoveryTab(draft.id, {
        tabId: bestRecovery.tabId,
        sourceUrl: bestRecovery.sourceUrl || updated.sourceUrl || '',
        sourceTabId: bestRecovery.sourceTabId,
        captureTarget: bestRecovery.captureTarget || '',
        jobId: bestRecovery.jobId || ''
      });
    }

    const activeJob = await getJob();
    if (activeJob) {
      const patch = {};
      if (redundantIds.includes(activeJob.draftId)) patch.draftId = draft.id;
      if (redundantIds.includes(activeJob.recoveryDraftId)) patch.recoveryDraftId = draft.id;
      if (Object.keys(patch).length) await setJob(patch);
    }

    for (const id of redundantIds) {
      await removeDraft(id).catch(() => {});
      await removeDraftRecoveryTab(id).catch(() => {});
    }
  }

  return updated;
}

async function compactCompatibleDrafts(drafts = []) {
  const buckets = new Map();
  for (const draft of drafts || []) {
    if (!draft?.id || !draft.messages?.length ||
        !['walk', 'finalizing'].includes(draft.capturePhase || '')) continue;
    const boundary = unfinishedBoundaryKey(draft);
    if (boundary === 'legacy') continue;
    const key = unfinishedGroupKey(draft);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(draft);
  }

  let changed = false;
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const canonical = [...members].sort((a, b) =>
      Number(b.messages?.length || 0) - Number(a.messages?.length || 0) ||
      String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
    )[0];
    const before = members.length;
    await reconcileUnfinishedPrefix(canonical);
    const remaining = (await listDrafts()).filter(item =>
      item?.id &&
      unfinishedGroupKey(item) === unfinishedGroupKey(canonical) &&
      ['walk', 'finalizing'].includes(item.capturePhase || '')
    );
    if (remaining.length < before) changed = true;
  }
  return changed ? await listDrafts() : drafts;
}

async function buildUnfinishedCaptureGroups(drafts = []) {
  const groups = new Map();

  for (const item of drafts || []) {
    if (!item?.id) continue;
    const recoveryTab = await resolveDraftRecoveryTab(item.id, item.sourceUrl || '');
    const row = {
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
      boundaryKind: item.captureBoundary?.kind || '',
      boundaryKey: item.captureBoundary?.key || '',
      recoveryTabAvailable: recoveryTab.available,
      recoveryTabId: recoveryTab.available ? recoveryTab.record.tabId : null,
      recoveryCaptureTarget: recoveryTab.available ? recoveryTab.record.captureTarget : '',
      recoveryTabUpdatedAt: Number(recoveryTab.record?.updatedAt || 0),
      canExportPrefix: ['walk', 'finalizing'].includes(item.capturePhase || '')
    };
    const key = unfinishedGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const result = [];
  for (const [groupKey, members] of groups.entries()) {
    members.sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
    const latest = members[0];

    // One user-facing card per logical capture chain (conversation + fixed
    // snapshot boundary + manual range). Internally there may still be several
    // technical recovery attempts; choose one current attempt for resume/export.
    const resumeCandidate = [...members]
      .filter(item => item.recoveryTabAvailable)
      .sort((a, b) =>
        // Prefer a real chronological prefix over a newer navigation-only
        // attempt. A failed retry can otherwise replace the useful frontier
        // with a tiny "top" draft and make Continue search the chat again.
        Number(['walk', 'finalizing'].includes(b.capturePhase || '')) -
          Number(['walk', 'finalizing'].includes(a.capturePhase || '')) ||
        Number(b.messageCount || 0) - Number(a.messageCount || 0) ||
        Number(b.recoveryTabUpdatedAt || 0) - Number(a.recoveryTabUpdatedAt || 0) ||
        String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
      )[0] || null;
    const primary = resumeCandidate || latest;
    const primaryBoundary = unfinishedBoundaryKey(primary);
    const chain = members.filter(item => unfinishedBoundaryKey(item) === primaryBoundary);
    const byCount = [...chain].sort((a, b) =>
      Number(b.messageCount || 0) - Number(a.messageCount || 0) ||
      String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
    );

    // Export is independent from the current recovery attempt: if an older
    // technical attempt already contains a valid top-to-bottom prefix, keep
    // offering it even when the newest attempt is travelling back to the top.
    const exportCandidate = [...chain]
      .filter(item => item.canExportPrefix)
      .sort((a, b) =>
        Number(b.messageCount || 0) - Number(a.messageCount || 0) ||
        String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
      )[0] || null;
    const contentCandidate = exportCandidate || byCount[0] || primary;
    const linkedDoc = await getLinkedDoc(primary.sourceUrl || contentCandidate.sourceUrl || '');

    result.push({
      ...primary,
      id: resumeCandidate?.id || contentCandidate?.id || primary.id,
      logicalGroupId: groupKey,
      resumePassId: resumeCandidate?.id || contentCandidate?.id || primary.id,
      exportPassId: exportCandidate?.id || '',
      copyPassId: contentCandidate?.id || primary.id,
      viewPassId: contentCandidate?.id || primary.id,
      passIds: chain.map(item => item.id),
      technicalPassCount: chain.length,
      messageCount: Number(contentCandidate?.messageCount || 0),
      imageCount: Number(contentCandidate?.imageCount || 0),
      imageBinaryReady: Number(contentCandidate?.imageBinaryReady || 0),
      imageBinaryFailed: Number(contentCandidate?.imageBinaryFailed || 0),
      chronologicalCount: Number(contentCandidate?.chronologicalCount || 0),
      canExportCurrent: Boolean(exportCandidate?.id),
      exportMessageCount: Number(exportCandidate?.messageCount || 0),
      recoveryTabAvailable: Boolean(resumeCandidate?.recoveryTabAvailable),
      recoveryTabId: resumeCandidate?.recoveryTabId ?? null,
      recoveryCaptureTarget: resumeCandidate?.recoveryCaptureTarget || '',
      capturePhase: primary.capturePhase || contentCandidate?.capturePhase || '',
      capturedAt: primary.capturedAt || contentCandidate?.capturedAt || '',
      hasBoundary: chain.some(item => item.hasBoundary),
      linkedDocUrl: linkedDoc?.url || ''
    });
  }

  result.sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
  return result;
}

function liveUnfinishedSummary(job) {
  if (!job?.draftId || !Number(job.draftCount || 0)) return null;
  const boundary = job.captureBoundary || null;
  const groupKey = unfinishedGroupKey({
    id: job.draftId,
    sourceUrl: job.sourceUrl || '',
    captureBoundary: boundary
  });
  const canExport = ['walk', 'finalizing'].includes(job.phase || '');
  return {
    id: job.draftId,
    logicalGroupId: groupKey,
    resumePassId: job.draftId,
    exportPassId: canExport ? job.draftId : '',
    copyPassId: job.draftId,
    viewPassId: job.draftId,
    passIds: [job.draftId],
    title: job.title || 'Незавершённый сбор',
    sourceUrl: job.sourceUrl || '',
    capturedAt: new Date(Number(job.updatedAt || Date.now())).toISOString(),
    messageCount: Number(job.draftCount || 0),
    imageCount: Number(job.imageCount || 0),
    imageBinaryReady: Number(job.imageBinaryReady || 0),
    imageBinaryFailed: Number(job.imageBinaryFailed || 0),
    captureMode: job.captureMode || '',
    capturePhase: job.phase || '',
    hasBoundary: Boolean(boundary?.kind && boundary?.key),
    boundaryKind: boundary?.kind || '',
    boundaryKey: boundary?.key || '',
    canExportCurrent: canExport,
    exportMessageCount: canExport ? Number(job.draftCount || 0) : 0,
    recoveryTabAvailable: Boolean(
      ['error', 'cancelled'].includes(job.status) &&
      job.captureTabId != null
    ),
    recoveryTabId: job.captureTabId ?? null,
    recoveryCaptureTarget: job.captureTarget || '',
    technicalPassCount: 1
  };
}

async function deleteUnfinishedGroup(logicalGroupId = '', passIds = []) {
  const drafts = await listDrafts();
  const ids = new Set((passIds || []).filter(Boolean));
  for (const item of drafts) {
    if (logicalGroupId && unfinishedGroupKey(item) === logicalGroupId) ids.add(item.id);
  }
  if (!ids.size) return { ok: true, removed: 0 };

  let removed = 0;
  for (const id of ids) {
    const result = await deleteDraftAndRecoveryTab(id);
    if (result?.removed) removed++;
  }
  return { ok: true, removed };
}

async function refreshCaptureJobHealth() {
  let job = await getJob();
  if (!job || !['starting', 'running'].includes(job.status)) return job;

  if (Date.now() - Number(job.updatedAt || job.startedAt || Date.now()) <= 300000) {
    return job;
  }

  const health = await probeLiveCapture(job);
  const alive = Boolean(
    health?.ok &&
    health.running &&
    health.jobId === job.jobId
  );

  if (alive) {
    return setJob({
      lastHeartbeatAt: Date.now(),
      contentScriptVersion: health.version || job.contentScriptVersion || '',
      lastScrollDirection: health.lastScrollDirection || job.lastScrollDirection || ''
    });
  }

  const draft = job.draftId ? await getDraft(job.draftId) : null;
  const failed = await finishJobWithError(
    job.jobId,
    job.sourceTabId ?? job.tabId,
    draft?.messages?.length
      ? 'Сбор перестал отвечать. Контрольная точка сохранена.'
      : 'Сбор перестал отвечать до создания контрольной точки.',
    draft?.id || job.draftId || '',
    draft?.messages?.length || Number(job.draftCount || 0),
    'error'
  );
  return failed?.job || await getJob();
}

function docExportCoversArchive(entry, archive) {
  const messages = archive?.messages || [];
  const last = messages[messages.length - 1] || null;
  if (!entry || !last) return false;

  if (entry.lastMessageId && last.id && entry.lastMessageId === last.id) return true;

  const lastSignature = messageSignature(last.role, last.text);
  if (entry.lastMessageSignature && lastSignature &&
      entry.lastMessageSignature === lastSignature) return true;

  const exportedTail = Array.isArray(entry.tailSignatures)
    ? entry.tailSignatures.filter(Boolean)
    : [];
  const archiveTail = exportTailSignatures(messages).filter(Boolean);
  if (!exportedTail.length || !archiveTail.length) return false;
  if (exportedTail.length !== archiveTail.length) return false;
  return exportedTail.every((signature, index) => signature === archiveTail[index]);
}

function exactDocExportForArchive(docExports = {}, archive = null) {
  if (!archive?.id) return null;
  const matches = Object.entries(docExports)
    .filter(([, entry]) =>
      entry?.archiveId === archive.id &&
      docExportCoversArchive(entry, archive)
    )
    .sort((left, right) =>
      Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0)
    );
  if (!matches.length) return null;
  const [docId, entry] = matches[0];
  return {
    docId,
    docUrl: entry?.docUrl || ('https://docs.google.com/document/d/' + docId + '/edit'),
    updatedAt: entry?.updatedAt || 0
  };
}

async function validatedArchiveDestination(archive, destination = null) {
  if (!archive?.id || !destination?.saved) return null;
  if (destination.kind !== 'google-doc') return destination;

  const docId = googleDocKey(destination.url || '');
  if (!docId) return null;
  const exportRecord = await getDocExport(docId);
  return docExportCoversArchive(exportRecord, archive) ? destination : null;
}

async function listLinkedArchives() {
  // Never deserialize every archive just to render the popup. Large archives
  // contain thousands of messages and can stall both UI polling and capture.
  // The lightweight registries below are the authoritative references to
  // user-visible archives.
  const meta = await chrome.storage.local.get([
    STORAGE_KEYS.archiveIndex,
    STORAGE_KEYS.archiveLibrary,
    STORAGE_KEYS.lastArchiveId,
    STORAGE_KEYS.archiveDestinations,
    STORAGE_KEYS.docExports,
    STORAGE_KEYS.docLinks,
    'fragmentLatestId'
  ]);

  const index = meta[STORAGE_KEYS.archiveIndex] || {};
  const library = meta[STORAGE_KEYS.archiveLibrary] || {};
  const destinations = meta[STORAGE_KEYS.archiveDestinations] || {};
  const docExports = meta[STORAGE_KEYS.docExports] || {};
  const docLinks = meta[STORAGE_KEYS.docLinks] || {};

  const ids = new Set([
    ...Object.keys(library),
    ...Object.values(index),
    meta[STORAGE_KEYS.lastArchiveId] || '',
    meta.fragmentLatestId || '',
    ...Object.keys(destinations),
    ...Object.values(docExports).map(entry => entry?.archiveId || '')
  ].filter(Boolean));

  if (!ids.size) return [];

  const archiveKeys = [...ids].map(id => STORAGE_KEYS.archivePrefix + id);
  const stored = await chrome.storage.local.get(archiveKeys);
  const rows = [];

  for (const id of ids) {
    const archive = stored[STORAGE_KEYS.archivePrefix + id];
    if (!archive?.id || !archive?.sourceUrl) continue;
    if (archive.partial && archive.complete !== true) continue;

    const sourceKey = conversationKey(archive.sourceUrl || '');
    let linked = !archive.isFragment && sourceKey ? (docLinks[sourceKey] || null) : null;

    // Older installs may only have docExports, without a direct docLinks entry.
    if (!linked && !archive.isFragment && sourceKey) {
      const legacy = Object.entries(docExports).find(([, entry]) =>
        entry?.conversationKey === sourceKey &&
        entry?.linkEligible !== false
      );
      if (legacy) {
        const [docId, entry] = legacy;
        linked = {
          url: entry.docUrl || ('https://docs.google.com/document/d/' + docId + '/edit'),
          docId,
          updatedAt: entry.updatedAt || 0
        };
      }
    }

    let destination = destinations[archive.id] || null;
    if (destination?.kind === 'google-doc') {
      const destinationDocId = googleDocKey(destination.url || '');
      const destinationExport = destinationDocId ? docExports[destinationDocId] : null;
      if (!docExportCoversArchive(destinationExport, archive)) destination = null;
    }

    const exactExport = exactDocExportForArchive(docExports, archive);
    if (!destination && exactExport?.docUrl) {
      destination = {
        saved: true,
        url: exactExport.docUrl,
        kind: 'google-doc',
        label: 'Google Docs',
        updatedAt: exactExport.updatedAt || archive.capturedAt || ''
      };
    }
    const exactDocUrl = destination?.kind === 'google-doc'
      ? (destination.url || exactExport?.docUrl || '')
      : (exactExport?.docUrl || '');

    rows.push({
      id: archive.id,
      isFragment: Boolean(archive.isFragment),
      partial: false,
      complete: archive.complete !== false,
      partialSourceDraftId: archive.partialSourceDraftId || '',
      capturePhase: archive.capturePhase || '',
      title: archive.title || 'Архив ChatGPT',
      messageCount: archive.messages?.length || 0,
      imageCount: archive.imageCount || 0,
      imageBinaryReady: archive.imageBinaryReady || 0,
      imageBinaryFailed: archive.imageBinaryFailed || 0,
      imageRecoveredCount: archive.lastImageRecoveredCount || 0,
      capturedAt: archive.capturedAt || '',
      sourceUrl: archive.sourceUrl,
      docUrl: exactDocUrl,
      linkedDocUrl: linked?.url || '',
      destination,
      updatedAt: destination?.updatedAt || archive.capturedAt || linked?.updatedAt || ''
    });
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

async function captureSavedArchive(archiveId = '', mode = 'continue', captureTarget = 'copy') {
  const archive = await getArchive(archiveId);
  if (!archive?.messages?.length || !archive?.sourceUrl) {
    throw new Error('Сохранённый архив не найден.');
  }
  if (archive.isFragment) {
    throw new Error('Эта операция доступна только для полного архива чата.');
  }
  if (!isConversationUrl(archive.sourceUrl)) {
    throw new Error('У архива нет рабочей ссылки на исходный чат.');
  }

  const openTabs = await chrome.tabs.query({});
  let sourceTab = openTabs.find(tab =>
    tab?.id && conversationKey(tab.url || '') === conversationKey(archive.sourceUrl || '')
  ) || null;

  if (sourceTab?.id) {
    await chrome.tabs.update(sourceTab.id, { active: true });
    if (sourceTab.windowId != null) {
      await chrome.windows.update(sourceTab.windowId, { focused: true }).catch(() => {});
    }
  } else {
    sourceTab = await chrome.tabs.create({ url: archive.sourceUrl, active: true });
    if (!sourceTab?.id) throw new Error('Не удалось открыть исходный чат.');
    await waitForChatTabComplete(sourceTab.id);
  }

  await waitForChatDomReady(sourceTab.id, 45000);

  const repairOnly = mode === 'reconcile' || mode === 'images';
  let restoreCanonicalArchiveId = '';
  let restoreLastArchiveId = '';
  if (repairOnly) {
    const canonical = await getArchiveForUrl(archive.sourceUrl || '');
    const last = await getLastArchive();
    restoreCanonicalArchiveId = canonical?.id && canonical.id !== archive.id ? canonical.id : '';
    restoreLastArchiveId = last?.id && last.id !== archive.id ? last.id : '';
  }

  return await startCapture({
    mode,
    existingArchive: archive,
    captureTarget,
    restoreCanonicalArchiveId,
    restoreLastArchiveId
  });
}

async function continueSavedArchive(archiveId = '', captureTarget = 'copy') {
  return captureSavedArchive(archiveId, 'continue', captureTarget);
}

async function selectSavedArchive(archiveId = '') {
  const archive = await getArchive(archiveId);
  if (!archive?.id) throw new Error('Сохранённый чат не найден.');
  // Selection is a UI choice, not a mutation of the canonical conversation archive.
  await chrome.storage.local.set({ selectedArchiveId: archive.id });
  return { ok: true, archive: summarize(archive) };
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageBinaryForContent(src = '') {
  const url = String(src || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Worker fallback supports only http(s) image URLs.');
  }

  const response = await fetch(url, {
    credentials: 'include',
    cache: 'force-cache',
    redirect: 'follow'
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const blob = await response.blob();
  const type = String(blob.type || response.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) {
    throw new Error('Полученный ресурс не является изображением: ' + (type || 'unknown content-type'));
  }
  if (!blob.size) throw new Error('Пустой файл изображения.');
  if (blob.size > 12 * 1024 * 1024) {
    throw new Error('Изображение больше 12 МБ; подготовить его для Google Docs не удалось.');
  }

  const buffer = await blob.arrayBuffer();
  return {
    ok: true,
    dataUrl: 'data:' + type + ';base64,' + arrayBufferToBase64(buffer),
    mimeType: type,
    byteSize: blob.size,
    finalUrl: response.url || url
  };
}

async function captureRenderedImageForContent(tabId, rect = {}, viewport = {}) {
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  const viewportWidth = Number(viewport.width);
  const viewportHeight = Number(viewport.height);

  if (![left, top, width, height, viewportWidth, viewportHeight].every(Number.isFinite) ||
      width < 2 || height < 2 || viewportWidth < 2 || viewportHeight < 2) {
    throw new Error('Не удалось определить видимую область картинки.');
  }

  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    const screenshot = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    if (!screenshot?.data) throw new Error('Chrome не вернул снимок вкладки.');

    const screenshotBlob = await (await fetch('data:image/png;base64,' + screenshot.data)).blob();
    const bitmap = await createImageBitmap(screenshotBlob);
    try {
      const scaleX = bitmap.width / viewportWidth;
      const scaleY = bitmap.height / viewportHeight;
      const x = Math.max(0, Math.floor(left * scaleX));
      const y = Math.max(0, Math.floor(top * scaleY));
      const right = Math.min(bitmap.width, Math.ceil((left + width) * scaleX));
      const bottom = Math.min(bitmap.height, Math.ceil((top + height) * scaleY));
      const cropWidth = Math.max(1, right - x);
      const cropHeight = Math.max(1, bottom - y);

      if (cropWidth < 2 || cropHeight < 2) {
        throw new Error('Картинка оказалась вне видимой области вкладки.');
      }

      const canvas = new OffscreenCanvas(cropWidth, cropHeight);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Chrome не дал создать буфер изображения.');
      context.drawImage(
        bitmap,
        x, y, cropWidth, cropHeight,
        0, 0, cropWidth, cropHeight
      );
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (!blob?.size) throw new Error('Не удалось сохранить видимую картинку.');

      return {
        ok: true,
        dataUrl: 'data:image/png;base64,' + arrayBufferToBase64(await blob.arrayBuffer()),
        mimeType: 'image/png',
        byteSize: blob.size,
        renderedFallback: true
      };
    } finally {
      bitmap.close?.();
    }
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }
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
      if (!response.ok) throw new Error(firstError + '; запасной запрос GitHub: HTTP ' + response.status);
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

async function setJob(patch, { replace = false } = {}) {
  const current = replace ? null : await getJob();
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

async function confirmCaptureTop() {
  const job = await getJob();
  if (!job || !['starting', 'running'].includes(job.status)) {
    throw new Error('Сейчас нет активного сбора.');
  }
  if (job.phase !== 'top') {
    throw new Error('Ручная отметка начала доступна только на этапе поиска начала.');
  }
  if (job.captureTabId == null) {
    throw new Error('Рабочая вкладка сбора недоступна.');
  }

  const result = await chrome.tabs.sendMessage(job.captureTabId, {
    type: 'ARCHIVER_CONFIRM_TOP',
    jobId: job.jobId
  }).catch(() => ({ ok: false, error: 'Рабочая вкладка не ответила.' }));
  if (!result?.ok) throw new Error(result?.error || 'Не удалось передать ручную отметку начала.');

  const next = await appendRunLog({
    message: 'Начало переписки отмечено вручную; переключаюсь на проход сверху вниз.'
  }, {
    level: 'info',
    code: 'TOP_CONFIRMED_BY_USER',
    message: 'Пользователь подтвердил, что рабочая вкладка находится в начале переписки.',
    phase: 'top',
    count: Number(job.count || 0)
  });
  return { ok: true, job: next };
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
  // Resetting UI/job metadata must never close a failed working tab.
  // The tab is a valuable physical recovery checkpoint and is closed only
  // after a verified successful capture.
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

async function ensureBoundaryMarkingScript(tabId, { enable = true } = {}) {
  const expectedVersion = chrome.runtime.getManifest().version;
  let ping = null;
  try {
    ping = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PING' });
  } catch (_) {}

  if (!ping?.ok || ping.version !== expectedVersion) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-chatgpt.js']
    });
    await sleep(80);
    ping = await chrome.tabs.sendMessage(tabId, { type: 'ARCHIVER_PING' }).catch(() => null);
  }

  if (!ping?.ok || ping.version !== expectedVersion) {
    throw new Error(
      'Вкладка ChatGPT использует устаревший код архиватора. Обновите страницу и повторите.'
    );
  }

  if (!enable) return ping;

  const result = await chrome.tabs.sendMessage(tabId, {
    type: 'ARCHIVER_SET_FRAGMENT_SELECTION',
    enabled: true
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'Не удалось включить режим разметки.');
  }
  return result;
}

async function toggleBoundaryMarkingCurrent() {
  const tab = await getActiveTab();
  if (!tab?.id || !isConversationUrl(tab.url || '')) {
    throw new Error('Откройте переписку ChatGPT в активной вкладке.');
  }

  const currentJob = await getJob();
  if (currentJob && ['starting', 'running', 'paused'].includes(currentJob.status)) {
    throw new Error('Во время активного сбора границы менять нельзя.');
  }

  await ensureBoundaryMarkingScript(tab.id, { enable: false });
  const current = await chrome.tabs.sendMessage(tab.id, {
    type: 'ARCHIVER_GET_FRAGMENT_SELECTION'
  });
  const next = await chrome.tabs.sendMessage(tab.id, {
    type: 'ARCHIVER_SET_FRAGMENT_SELECTION',
    enabled: !current?.enabled
  });
  if (!next?.ok) throw new Error('Не удалось переключить режим разметки.');
  return { ok: true, enabled: Boolean(next.enabled), tabId: tab.id };
}

async function clearBoundaryMarkersCurrent() {
  const tab = await getActiveTab();
  if (!tab?.id || !isConversationUrl(tab.url || '')) {
    throw new Error('Откройте переписку ChatGPT в активной вкладке.');
  }

  const currentJob = await getJob();
  if (currentJob && ['starting', 'running', 'paused'].includes(currentJob.status)) {
    throw new Error('Во время активного сбора границы менять нельзя.');
  }

  const source = new URL(tab.url);
  const markersKey = 'archiverFragmentMarkers:' + source.origin + source.pathname;
  await chrome.storage.local.remove(markersKey);

  await ensureBoundaryMarkingScript(tab.id, { enable: false }).catch(() => {});
  await chrome.tabs.sendMessage(tab.id, {
    type: 'ARCHIVER_CLEAR_FRAGMENT_MARKERS'
  }).catch(() => null);

  const tabs = await chrome.tabs.query({});
  for (const candidate of tabs) {
    if (!candidate?.id || candidate.id === tab.id) continue;
    if (conversationKey(candidate.url || '') !== conversationKey(tab.url || '')) continue;
    await chrome.tabs.sendMessage(candidate.id, {
      type: 'ARCHIVER_CLEAR_FRAGMENT_MARKERS'
    }).catch(() => {});
  }

  return { ok: true, cleared: true, tabId: tab.id };
}

async function openBoundaryMarkingTab() {
  const sourceTab = await getActiveTab();
  if (!sourceTab?.id || !isConversationUrl(sourceTab.url || '')) {
    throw new Error('Откройте переписку ChatGPT в активной вкладке.');
  }

  const current = await getJob();
  if (current && ['starting', 'running', 'paused'].includes(current.status)) {
    throw new Error('Сначала завершите или остановите текущий сбор.');
  }

  const tab = await chrome.tabs.create({
    url: sourceTab.url,
    active: false
  });
  if (!tab?.id) throw new Error('Не удалось открыть рабочую вкладку.');

  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await waitForChatTabComplete(tab.id);
  await waitForChatDomReady(tab.id, 45000);
  await ensureBoundaryMarkingScript(tab.id);

  const stored = await chrome.storage.local.get('archiverSettings');
  await chrome.storage.local.set({
    archiverSettings: {
      ...DEFAULT_SETTINGS,
      ...(stored.archiverSettings || {}),
      captureTarget: 'current'
    }
  });

  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  return {
    ok: true,
    tabId: tab.id,
    sourceUrl: sourceTab.url
  };
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
    captureRange: options.captureRange || null,
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
  if (!result?.ok) throw new Error(result?.error || 'Скрипт сбора во вкладке не запустился.');
  if (result.jobId && result.jobId !== jobId) {
    throw new Error('Предыдущий сбор в этой вкладке ещё завершает работу; новая попытка пока не запущена.');
  }
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
        const retryPattern = /^(?:Попробовать снова|Повторить|Try again|Retry)$/i;
        const errorPattern = /(?:something went wrong|there was an error|network error|failed to load|не удалось загрузить|произошла ошибка|ошибка сети|возникла ошибка)/i;
        const viewportWidth = Math.max(1, innerWidth || document.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, innerHeight || document.documentElement.clientHeight || 1);

        const retryAvailable = [...document.querySelectorAll('button, [role="button"]')].some(el => {
          if (!(el instanceof Element) || !el.isConnected || el.disabled) return false;
          if (el.closest('[aria-hidden="true"], [inert]')) return false;

          const style = getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.pointerEvents === 'none' ||
            Number.parseFloat(style.opacity || '1') <= 0.01
          ) return false;

          const rect = el.getBoundingClientRect();
          if (
            rect.width < 2 ||
            rect.height < 2 ||
            rect.bottom <= 0 ||
            rect.right <= 0 ||
            rect.top >= viewportHeight ||
            rect.left >= viewportWidth
          ) return false;

          const label = String(
            el.innerText ||
            el.textContent ||
            el.getAttribute?.('aria-label') ||
            el.getAttribute?.('title') ||
            ''
          ).replace(/\s+/g, ' ').trim();
          if (!retryPattern.test(label)) return false;

          const x = Math.max(1, Math.min(viewportWidth - 1, rect.left + rect.width / 2));
          const y = Math.max(1, Math.min(viewportHeight - 1, rect.top + rect.height / 2));
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === el || el.contains(hit))) return false;

          let node = el.parentElement;
          for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            const localRect = node.getBoundingClientRect();
            if (localRect.height > Math.max(520, viewportHeight * 0.8)) continue;
            const text = String(node.innerText || node.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (text && text.length <= 1800 && errorPattern.test(text)) return true;
          }
          return false;
        });
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
        const retryPattern = /^(?:Попробовать снова|Повторить|Try again|Retry)$/i;
        const errorPattern = /(?:something went wrong|there was an error|network error|failed to load|не удалось загрузить|произошла ошибка|ошибка сети|возникла ошибка)/i;
        const viewportWidth = Math.max(1, innerWidth || document.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, innerHeight || document.documentElement.clientHeight || 1);

        const button = [...document.querySelectorAll('button, [role="button"]')].find(el => {
          if (!(el instanceof Element) || !el.isConnected || el.disabled) return false;
          if (el.closest('[aria-hidden="true"], [inert]')) return false;

          const style = getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.pointerEvents === 'none' ||
            Number.parseFloat(style.opacity || '1') <= 0.01
          ) return false;

          const rect = el.getBoundingClientRect();
          if (
            rect.width < 2 ||
            rect.height < 2 ||
            rect.bottom <= 0 ||
            rect.right <= 0 ||
            rect.top >= viewportHeight ||
            rect.left >= viewportWidth
          ) return false;

          const label = String(
            el.innerText ||
            el.textContent ||
            el.getAttribute?.('aria-label') ||
            el.getAttribute?.('title') ||
            ''
          ).replace(/\s+/g, ' ').trim();
          if (!retryPattern.test(label)) return false;

          const x = Math.max(1, Math.min(viewportWidth - 1, rect.left + rect.width / 2));
          const y = Math.max(1, Math.min(viewportHeight - 1, rect.top + rect.height / 2));
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === el || el.contains(hit))) return false;

          let node = el.parentElement;
          for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
            const localRect = node.getBoundingClientRect();
            if (localRect.height > Math.max(520, viewportHeight * 0.8)) continue;
            const text = String(node.innerText || node.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (text && text.length <= 1800 && errorPattern.test(text)) return true;
          }
          return false;
        });

        if (!button) return null;
        const rect = button.getBoundingClientRect();
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

    if (
      last?.loadError &&
      last?.retryAvailable &&
      retries < 3 &&
      Date.now() >= nextRetryAt
    ) {
      const clicked = await clickChatRetry(tabId);
      if (clicked) {
        retries += 1;
        if (onRetry) {
          try { await onRetry(retries, true, last); } catch (_) {}
        }
        const backoff = retries === 1 ? 1800 : retries === 2 ? 3500 : 6500;
        nextRetryAt = Date.now() + backoff;
        await sleep(backoff);
        continue;
      }
    }

    if (last?.loadError && last?.retryAvailable && retries >= 3) {
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
    title: baseline.title || 'Архив Google Docs',
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
  captureRange = null,
  restoreCanonicalArchiveId = '',
  restoreLastArchiveId = '',
  captureTarget = 'copy'
} = {}) {
  const sourceTab = await getActiveTab();
  if (!sourceTab?.id) throw new Error('Не удалось определить активную вкладку.');

  if (!isChatGptHost(sourceTab.url || '')) {
    throw makeCaptureError('WRONG_SITE', 'Откройте ChatGPT в активной вкладке.');
  }

  // The manual range is tied to the viewport positioned by the user.
  captureTarget = (mode === 'fragment' ||
    (mode === 'resume-draft' && providedDraft?.captureMode === 'fragment'))
    ? 'current'
    : (captureTarget === 'current' ? 'current' : 'copy');

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
    const markers = captureRange ||
      (await chrome.storage.local.get(markersKey))[markersKey] ||
      {};
    captureRange = markers;
    if (mode === 'fragment' && (!markers.start || !markers.end)) {
      throw new Error('Сначала отметьте и начало, и конец диапазона в переписке.');
    }
  }
  let existingArchive = providedArchive;
  const existingDraft = providedDraft;

  if ((mode === 'continue' || mode === 'sync' || mode === 'compare' || mode === 'reconcile' || mode === 'images') && !existingArchive) {
    existingArchive = await getArchiveForUrl(inspection.href);
  }

  if ((mode === 'continue' || mode === 'compare' || mode === 'reconcile' || mode === 'images') && !existingArchive?.messages?.length) {
    throw new Error('Для этого чата нет локального архива. Сначала соберите переписку или восстановите стык по документу Google Docs.');
  }

  // Continuation must carry a multi-message tail whenever the local archive
  // can provide one. A single regenerated ID or repeated line of text is too
  // weak to define the append boundary safely.
  if (!resumeTailSignatures.length &&
      existingArchive?.messages?.length &&
      ['continue', 'compare'].includes(mode)) {
    resumeTailSignatures = buildResumeTailSignatures(existingArchive.messages, 4);
  }

  if ((mode === 'resume-draft' || mode === 'images-draft') && !existingDraft?.messages?.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }
  if ((mode === 'resume-draft' || mode === 'images-draft') && (!fixedCaptureBoundary?.kind || !fixedCaptureBoundary?.key)) {
    throw new Error('У незавершённого прохода нет сохранённой нижней метки. Без неё продолжить проход безопасно нельзя.');
  }

  const requestedDocUrl = normalizeGoogleDocUrl(docUrl);
  const currentLink = await getLinkedDoc(inspection.href);

  // A full rebuild refreshes the local archive only. It must never append the
  // whole rebuilt archive to an already-linked Google Doc. Automatic Docs
  // append is reserved for verified continuation/sync deltas.
  const currentLinkedUrl = normalizeGoogleDocUrl(currentLink?.url || '');
  const recoveryPendingDocUrl = (mode === 'resume-draft' || mode === 'retry-walk')
    ? normalizeGoogleDocUrl(existingDraft?.pendingDocUrl || '')
    : '';
  const pendingDocUrl = (mode === 'continue' || mode === 'sync')
    ? (requestedDocUrl || currentLinkedUrl || '')
    : recoveryPendingDocUrl;
  const pendingDocMode = mode === 'sync'
    ? 'sync'
    : mode === 'continue'
      ? (requestedDocUrl && requestedDocUrl !== currentLinkedUrl
          ? 'explicit'
          : (pendingDocUrl ? 'linked' : 'local-only'))
      : ((mode === 'resume-draft' || mode === 'retry-walk') && pendingDocUrl
          ? (existingDraft?.pendingDocMode || 'recovery')
          : '');

  const jobId = makeJobId();
  const captureStartedAt = Date.now();
  let captureTab = null;
  let domProbe = null;
  let collectorStarted = false;

  await setJob({
    jobId,
    tabId: sourceTab.id,
    sourceTabId: sourceTab.id,
    captureTabId: captureTarget === 'current' ? sourceTab.id : null,
    sourceUrl: inspection.href,
    status: 'starting',
    phase: 'top',
    captureMode: mode,
    captureTarget,
    baselineArchiveId: mode === 'sync' ? (existingArchive?.id || '') : '',
    recoveryDraftId: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
    draftId: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
    draftCount: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.messages?.length || 0) : 0,
    resumeBaseCount: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.messages?.length || 0) : 0,
    captureBoundary: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? fixedCaptureBoundary : null,
    captureRange,
    restoreCanonicalArchiveId: String(restoreCanonicalArchiveId || ''),
    restoreLastArchiveId: String(restoreLastArchiveId || ''),
    pendingDocUrl,
    pendingDocMode,
    count: 0,
    addedCount: 0,
    imageCount: 0,
    startedAt: captureStartedAt,
    finishedAt: null,
    message: captureTarget === 'current'
      ? 'Запуск: жду готовности текущей вкладки ChatGPT…'
      : 'Запуск: открываю и прогреваю рабочую вкладку ChatGPT…'
  }, { replace: true });

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

      await chrome.tabs.update(captureTab.id, {
        active: true,
        autoDiscardable: false
      }).catch(() => {});
      captureTab = await waitForChatTabComplete(captureTab.id);
      domProbe = await waitForChatDomReady(captureTab.id, 45000);
    }

    const modeLabel = mode === 'fragment' ? 'сбор выбранного фрагмента' : mode === 'reconcile'
      ? 'сверка и добор локального архива'
      : mode === 'compare'
        ? 'сверка с локальным архивом'
      : mode === 'sync'
        ? 'восстановление по документу Google Docs'
        : mode === 'continue'
          ? 'продолжение'
          : mode === 'images'
            ? 'добор изображений'
            : mode === 'images-draft'
              ? 'сверка изображений незавершённой части'
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
      recoveryDraftId: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
      draftId: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.id || '') : '',
      draftCount: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? (existingDraft?.messages?.length || 0) : 0,
      partialSaveEnabled: Boolean(existingDraft?.partialSaveEnabled),
      partialArchiveId: existingDraft?.partialArchiveId || '',
      captureBoundary: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? fixedCaptureBoundary : null,
      captureRange,
      restoreCanonicalArchiveId: String(restoreCanonicalArchiveId || ''),
      restoreLastArchiveId: String(restoreLastArchiveId || ''),
      pendingDocUrl,
      pendingDocMode,
      message: mode === 'fragment'
          ? 'Текущая вкладка готова; начало диапазона должно оставаться видимым…'
          : mode === 'full'
        ? (captureTarget === 'current'
            ? 'Текущая вкладка готова; иду к началу…'
            : 'Рабочая копия загружена; иду к началу…')
        : mode === 'images'
          ? (captureTarget === 'current'
              ? 'Текущая вкладка готова; добираю изображения по всей переписке…'
              : 'Рабочая копия загружена; добираю изображения по всей переписке…')
          : mode === 'images-draft'
            ? (captureTarget === 'current'
                ? 'Текущая вкладка готова; сверяю изображения сохранённой части…'
                : 'Рабочая копия загружена; сверяю изображения сохранённой части…')
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
      startedAt: captureStartedAt,
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
      : (mode === 'sync' || mode === 'images' || mode === 'images-draft')
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
      fixedCaptureBoundary: (mode === 'resume-draft' || mode === 'images-draft' || resumeNavigation) ? fixedCaptureBoundary : null,
      resumeNavigation,
      captureRange
    });
    collectorStarted = true;

    if (captureTarget === 'copy') {
      // Live-proven background path: hydrate and start the collector while the
      // working copy is foregrounded, then restore the user's source chat.
      await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
      if (sourceTab.windowId != null) {
        await chrome.windows.update(sourceTab.windowId, { focused: true }).catch(() => {});
      }
      await appendRunLog({
        status: 'running',
        message: mode === 'full'
          ? 'Фоновый сбор идет в рабочей вкладке…'
          : mode === 'reconcile'
              ? 'Фоново сверяю локальный архив и добираю пропуски…'
              : mode === 'images-draft'
                ? 'Фоново сверяю изображения сохранённой части…'
                : mode === 'images'
                  ? 'Фоново сверяю и добираю изображения по всей переписке…'
                  : mode === 'fragment'
                  ? 'Фоново собираю отмеченный фрагмент…'
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
          : mode === 'fragment'
              ? 'Физически собираю отмеченный фрагмент…'
              : mode === 'reconcile'
                ? 'Физически сверяю локальный архив и добираю пропуски…'
                : mode === 'images-draft'
                  ? 'Физически сверяю изображения сохранённой части…'
                  : mode === 'images'
                    ? 'Физически сверяю и добираю изображения…'
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
    const failedCaptureTabId = captureTab?.id || null;

    // A failed launch is not an unfinished capture. Stop any collector that may
    // have received the start message, and remove an unproductive working copy.
    // Recovery is reserved for a pass that has actually started and produced
    // recoverable state/checkpoints.
    if (collectorStarted && failedCaptureTabId != null) {
      await chrome.tabs.sendMessage(failedCaptureTabId, {
        type: 'ARCHIVER_CANCEL_CAPTURE',
        jobId
      }).catch(() => {});
    }

    if (captureTarget === 'copy' && failedCaptureTabId != null && !collectorStarted) {
      await chrome.tabs.remove(failedCaptureTabId).catch(() => {});
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
      captureTabId: collectorStarted ? failedCaptureTabId : null,
      sourceUrl: inspection.href,
      status: 'error',
      phase: 'starting',
      captureMode: mode,
      captureTarget,
      pendingDocUrl,
      pendingDocMode,
      recoveryAvailable: false,
      autoRecoveryPending: false,
      message,
      startedAt: captureStartedAt,
      finishedAt: Date.now(),
      log: [{
        at: Date.now(),
        level: 'error',
        code: captureTarget === 'copy' ? 'WORKING_COPY_START_FAILED' : 'CURRENT_TAB_START_FAILED',
        message,
        phase: 'starting',
        count: 0
      }]
    }, { replace: true });
    await recordRunHistory(failedJob);
    throw new Error(message);
  }
}

async function cancelCapture() {
  const job = await getJob();
  if (!job || !['starting', 'running', 'paused'].includes(job.status)) return { ok: true, job };

  // Stop the job in the worker first. From this point physical scrolling/clicks
  // are rejected immediately, so a slow content-script cleanup cannot keep the
  // capture visibly alive after the user pressed Stop.
  const preservedDraft = job.draftId ? await getDraft(job.draftId) : null;
  const hasTopBoundary = Boolean(
    ['top', 'boundary'].includes(job.phase || '') &&
    job.captureBoundary?.kind &&
    job.captureBoundary?.key &&
    ['full', 'fragment', 'reconcile', 'images'].includes(job.captureMode)
  );
  const canRecover = Boolean(
    job.captureTabId != null &&
    (preservedDraft?.messages?.length || hasTopBoundary)
  );

  const next = await appendRunLog({
    status: 'cancelled',
    phase: job.phase || 'top',
    pauseReason: '',
    autoRecoveryPending: false,
    recoveryAvailable: canRecover,
    draftCount: preservedDraft?.messages?.length || Number(job.draftCount || 0),
    message: canRecover
      ? 'Сбор остановлен. Сохранённую часть можно продолжить вручную.'
      : 'Сбор остановлен.',
    finishedAt: Date.now()
  }, {
    level: 'warn',
    code: canRecover ? 'RUN_CANCELLED_RECOVERABLE' : 'RUN_CANCELLED',
    message: canRecover
      ? 'Сбор немедленно остановлен пользователем; сохранённая точка оставлена только для ручного продолжения.'
      : 'Сбор немедленно остановлен пользователем.',
    phase: job.phase || '',
    count: Number(job.count || 0)
  });

  if (canRecover && job.draftId) {
    await setDraftRecoveryTab(job.draftId, {
      tabId: job.captureTabId,
      sourceUrl: job.sourceUrl || '',
      sourceTabId: job.sourceTabId ?? job.tabId ?? null,
      captureTarget: job.captureTarget || '',
      jobId: job.jobId
    }).catch(() => {});
  }

  await cleanupTemporaryBaseline(job).catch(() => {});

  // Best-effort notification after the worker state is already terminal.
  // The collector may still need a moment to unwind an in-flight fetch, but it
  // can no longer request physical actions because the worker rejects them.
  if (job.captureTabId != null) {
    chrome.tabs.sendMessage(job.captureTabId, {
      type: 'ARCHIVER_CANCEL_CAPTURE',
      jobId: job.jobId
    }).catch(() => {});
  }

  await recordRunHistory(next);
  return { ok: true, job: next };
}

async function scheduleAutomaticRecovery(jobId, delayMs = AUTO_RECOVERY_TRIGGER_DELAY_MS) {
  if (!jobId) return;
  await chrome.alarms.create(AUTO_RECOVERY_ALARM_PREFIX + jobId, {
    when: Date.now() + Math.max(500, Number(delayMs) || AUTO_RECOVERY_TRIGGER_DELAY_MS)
  });
}

async function resumeNavigationOnlyFromWorkingTab(failedJob = null) {
  failedJob = failedJob || await getJob();
  if (
    !failedJob ||
    !['error', 'cancelled'].includes(failedJob.status) ||
    failedJob.captureTabId == null
  ) {
    throw new Error('Нет сохранённой рабочей вкладки для продолжения.');
  }

  const boundary = failedJob.captureBoundary || null;
  if (!boundary?.kind || !boundary?.key) {
    throw new Error('Не сохранена нижняя метка снимка; безопасно продолжить этот проход нельзя.');
  }

  if (!['full', 'reconcile', 'images'].includes(failedJob.captureMode)) {
    throw new Error('Этот этап нельзя безопасно продолжить без сохранённого черновика.');
  }

  const captureTab = await chrome.tabs.get(failedJob.captureTabId).catch(() => null);
  if (!captureTab?.id ||
      conversationKey(captureTab.url || '') !== conversationKey(failedJob.sourceUrl || '')) {
    throw new Error('Рабочая вкладка уже недоступна или содержит другой чат.');
  }

  const jobId = makeJobId();
  await setJob({
    jobId,
    tabId: failedJob.tabId ?? failedJob.sourceTabId ?? captureTab.id,
    sourceTabId: failedJob.sourceTabId ?? failedJob.tabId ?? captureTab.id,
    sourceUrl: failedJob.sourceUrl || captureTab.url || '',
    status: 'starting',
    phase: 'top',
    captureMode: failedJob.captureMode,
    captureTarget: failedJob.captureTarget === 'current' ? 'current' : 'copy',
    recoveryAvailable: false,
    recoveryDraftId: '',
    draftId: '',
    draftCount: 0,
    resumeBaseCount: 0,
    captureTabId: captureTab.id,
    captureBoundary: boundary,
    captureRange: failedJob.captureRange || null,
    restoreCanonicalArchiveId: failedJob.restoreCanonicalArchiveId || '',
    restoreLastArchiveId: failedJob.restoreLastArchiveId || '',
    pendingDocUrl: failedJob.pendingDocUrl || '',
    pendingDocMode: failedJob.pendingDocMode || '',
    baselineArchiveId: failedJob.baselineArchiveId || '',
    autoRecoveryPending: false,
    message: 'Продолжаю путь к началу в той же рабочей вкладке…',
    startedAt: Date.now(),
    finishedAt: null
  }, { replace: true });

  try {
    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode: failedJob.captureMode,
      fixedCaptureBoundary: boundary,
      captureRange: failedJob.captureRange || null
    });
  } catch (error) {
    await setJob({
      status: 'error',
      recoveryAvailable: true,
      autoRecoveryPending: false,
      message: error?.message || String(error),
      finishedAt: Date.now()
    });
    throw error;
  }

  const next = await appendRunLog({
    status: 'running',
    phase: 'top',
    message: 'Продолжаю путь к началу в той же вкладке…',
    autoRecoveryPending: false
  }, {
    level: 'info',
    code: 'SAME_TAB_TOP_NAVIGATION_RESUMED',
    message: 'Проход к началу продолжен с физической позиции сохранённой рабочей вкладки.',
    phase: 'top',
    count: Number(failedJob.count || 0)
  });
  return { ok: true, job: next };
}

async function attemptAutomaticRecovery(failedJobId = '') {
  const failedJob = await getJob();
  if (
    !failedJob ||
    failedJob.jobId !== failedJobId ||
    failedJob.status !== 'error' ||
    !failedJob.autoRecoveryPending ||
    failedJob.captureMode === 'fragment'
  ) {
    // Stale alarms from older releases must never restart a manual range.
    return { ok: false, skipped: true };
  }

  const attempts = Number(failedJob.autoRecoveryAttempts || 0);
  const maxAttempts = Number(failedJob.autoRecoveryMaxAttempts || AUTO_RECOVERY_MAX_ATTEMPTS);
  if (attempts >= maxAttempts) {
    await setJob({
      autoRecoveryPending: false,
      message: (failedJob.message || 'Сбор остановился.') +
        ' Автоматические попытки исчерпаны; можно продолжить вручную в той же вкладке.'
    });
    return { ok: false, exhausted: true };
  }

  const tab = await chrome.tabs.get(failedJob.captureTabId).catch(() => null);
  if (!tab?.id ||
      conversationKey(tab.url || '') !== conversationKey(failedJob.sourceUrl || '')) {
    await setJob({
      autoRecoveryPending: false,
      recoveryAvailable: false,
      message: (failedJob.message || 'Сбор остановился.') +
        ' Сохранённая рабочая вкладка больше недоступна.'
    });
    return { ok: false, unavailable: true };
  }

  const attemptNumber = attempts + 1;
  await appendRunLog({
    autoRecoveryAttempts: attemptNumber,
    autoRecoveryPending: false,
    message: 'Автоматически восстанавливаю сбор в той же вкладке: попытка ' +
      attemptNumber + ' из ' + maxAttempts + '…'
  }, {
    level: 'warn',
    code: 'AUTO_RECOVERY_ATTEMPT',
    message: 'Запускаю ограниченную автоматическую попытку продолжения в той же вкладке.',
    phase: failedJob.phase || '',
    count: Number(failedJob.count || 0)
  });

  try {
    const current = await getJob();
    if (current?.draftId) {
      return await resumeFailedCaptureFromWorkingTab();
    }
    return await resumeNavigationOnlyFromWorkingTab(current);
  } catch (error) {
    const current = await getJob();
    const currentAttempts = Number(current?.autoRecoveryAttempts || attemptNumber);
    const canRetry = Boolean(
      current?.status === 'error' &&
      current?.captureTabId != null &&
      currentAttempts < maxAttempts
    );

    const next = await appendRunLog({
      status: 'error',
      recoveryAvailable: Boolean(current?.captureTabId != null),
      autoRecoveryPending: canRetry,
      autoRecoveryAttempts: currentAttempts,
      autoRecoveryMaxAttempts: maxAttempts,
      message: 'Автовосстановление не удалось: ' + (error?.message || String(error)) +
        (canRetry
          ? ' Попробую ещё раз.'
          : ' Автоматические попытки закончились; вкладка оставлена для ручного продолжения.'),
      finishedAt: Date.now()
    }, {
      level: 'warn',
      code: canRetry ? 'AUTO_RECOVERY_RETRY_PENDING' : 'AUTO_RECOVERY_EXHAUSTED',
      message: error?.message || String(error),
      phase: current?.phase || failedJob.phase || '',
      count: Number(current?.count || failedJob.count || 0)
    });

    if (canRetry) {
      await scheduleAutomaticRecovery(next.jobId, AUTO_RECOVERY_TRIGGER_DELAY_MS * 2);
    }
    return { ok: false, error: error?.message || String(error), job: next };
  }
}

async function finishJobWithError(jobId, sourceTabId, message, draftId = '', draftCount = 0, status = 'error') {
  const job = await getJob();
  if (job?.jobId !== jobId) return { job, autoRecoveryEligible: false };

  const boundary = job.captureBoundary || null;
  const navigationOnlyRecoverable = Boolean(
    ['error', 'cancelled'].includes(status) &&
    ['top', 'boundary'].includes(job.phase || '') &&
    boundary?.kind &&
    boundary?.key &&
    ['full', 'reconcile', 'images'].includes(job.captureMode)
  );

  let preservedCaptureTabId = null;
  if (
    ['error', 'cancelled'].includes(status) &&
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

  // Never close a ChatGPT capture working tab automatically. Keeping the
  // physical tab is the cheapest recovery point for very large conversations.
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
    job.captureMode !== 'fragment' &&
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
  if (autoRecoveryEligible) {
    await scheduleAutomaticRecovery(next.jobId);
  }
  return { job: next, autoRecoveryEligible };
}

async function focusRecoverableCaptureTab() {
  const job = await getJob();
  if (!job?.captureTabId) {
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
    failedJob.captureTabId == null
  ) {
    throw new Error('Нет незавершённого прохода с сохранённой рабочей вкладкой.');
  }

  if (!failedJob.draftId) {
    return resumeNavigationOnlyFromWorkingTab(failedJob);
  }

  // A failed retry can leave a newer but shallower technical draft while the
  // previous recovery draft still contains a deeper chronological prefix.
  // Choose by recovery value, not merely by which ID was written last.
  const draftIds = [...new Set([
    failedJob.draftId || '',
    failedJob.recoveryDraftId || ''
  ].filter(Boolean))];
  const draftCandidates = [];
  for (const id of draftIds) {
    const candidate = await getDraft(id);
    if (!candidate?.messages?.length) continue;
    draftCandidates.push(await reconcileUnfinishedPrefix(candidate));
  }
  if (!draftCandidates.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }
  draftCandidates.sort((a, b) =>
    Number(['walk', 'finalizing'].includes(b.capturePhase || '')) -
      Number(['walk', 'finalizing'].includes(a.capturePhase || '')) ||
    Number(b.messages?.length || 0) - Number(a.messages?.length || 0) ||
    String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''))
  );
  let draft = draftCandidates[0];

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
  const resumeNavigation = draft.captureMode !== 'fragment' && draft.capturePhase === 'top' &&
    ['full', 'reconcile', 'images'].includes(draft.captureMode);
  const resumeMode = draft.captureMode === 'fragment'
    ? 'resume-draft'
    : resumeNavigation
      ? draft.captureMode
      : (draft.capturePhase === 'walk' || draft.capturePhase === 'finalizing'
          ? 'resume-draft'
          : 'retry-walk');
  const resumeTailSignatures = buildResumeTailSignatures(draft.messages, 4);
  const target = failedJob.captureTarget === 'current' ? 'current' : 'copy';
  await setJob({
    jobId,
    tabId: failedJob.tabId ?? failedJob.sourceTabId ?? captureTab.id,
    sourceTabId: failedJob.sourceTabId ?? failedJob.tabId ?? captureTab.id,
    sourceUrl: draft.sourceUrl || failedJob.sourceUrl || captureTab.url || '',
    status: 'starting',
    phase: 'top',
    captureMode: resumeMode,
    captureTarget: target,
    recoveryDraftId: draft.id,
    // Recovery updates the same logical unfinished pass. Keeping one canonical
    // draft ID makes checkpoints monotonic and prevents duplicate draft cards.
    draftId: draft.id,
    draftCount: draft.messages.length,
    resumeBaseCount: draft.messages.length,
    partialSaveEnabled: Boolean(draft.partialSaveEnabled),
    partialArchiveId: draft.partialArchiveId || '',
    partialSavedAt: draft.partialSavedAt || '',
    recoveryAvailable: false,
    autoRecoveryPending: false,
    captureTabId: captureTab.id,
    captureBoundary: boundary,
    captureRange: draft.captureRange || failedJob.captureRange || null,
    restoreCanonicalArchiveId: failedJob.restoreCanonicalArchiveId || '',
    restoreLastArchiveId: failedJob.restoreLastArchiveId || '',
    pendingDocUrl: failedJob.pendingDocUrl || '',
    pendingDocMode: failedJob.pendingDocMode || '',
    baselineArchiveId: failedJob.baselineArchiveId || '',
    message: resumeNavigation
      ? 'Продолжаю навигацию вверх от сохранённого места…'
      : resumeMode === 'resume-draft'
        ? 'Ищу последнюю сохранённую реплику и продолжаю с неё без полного прохода…'
        : 'Возвращаю рабочую вкладку к началу для восстановления…',
    startedAt: Date.now(),
    finishedAt: null
  }, { replace: true });

  try {
    await ensureChatGptContentScript(captureTab.id, jobId, {
      mode: resumeMode,
      resumeAnchorId: lastMessage.id || '',
      resumeAnchorSignature: messageSignature(lastMessage.role, lastMessage.text),
      resumeTailSignatures,
      existingDraftId: draft.id,
      fixedCaptureBoundary: boundary,
      resumeNavigation,
      captureRange: draft.captureRange || failedJob.captureRange || null
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
    throw new Error('Незавершённый сбор не найден.');
  }

  const id = draft.partialArchiveId || partialArchiveIdForSource(draft.sourceUrl);
  if (!id) throw new Error('Не удалось определить исходный чат для частичного архива.');

  const existing = await getArchive(id);
  const messages = draft.messages.slice();
  const saveEnabled = Boolean(enable || draft.partialSaveEnabled);
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
    partialSaveEnabled: saveEnabled,
    capturePhase: draft.capturePhase || 'walk',
    lastCaptureMode: 'partial-draft'
  };

  await putArchive(archive);

  // Keep the binding on the unfinished pass itself. The content collector
  // preserves these fields across later checkpoints.
  const boundDraft = {
    ...draft,
    partialSaveEnabled: saveEnabled,
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
      partialSaveEnabled: saveEnabled,
      partialArchiveId: id
    });
  }

  return {
    ok: true,
    archiveId: id,
    messageCount: messages.length,
    updated: Boolean(existing?.id),
    resumable: true,
    partialSaveEnabled: saveEnabled,
    enabled: saveEnabled
  };
}

async function saveUnfinishedAsPartial(passId = '') {
  const draft = await getDraft(passId);
  return syncPartialArchiveFromDraft(draft, { enable: true });
}

async function exportUnfinishedPassToNewDoc(passId = '') {
  const draft = await getDraft(passId);
  if (!draft?.id || !draft?.messages?.length) {
    throw new Error('Незавершённый сбор не найден.');
  }

  if (!['walk', 'finalizing'].includes(draft.capturePhase || '')) {
    throw new Error(
      'Текущая часть ещё не является непрерывным архивом от начала чата. ' +
      'Дождитесь этапа сохранения сверху вниз.'
    );
  }

  // Materialize and verify the current chronological prefix locally first.
  // This gives Google Docs export the exact same object shape as a completed
  // archive, while the draft itself remains available for later resume.
  const partial = await syncPartialArchiveFromDraft(draft, { enable: false });
  const snapshot = await getArchive(partial.archiveId);
  if (!snapshot?.messages?.length ||
      snapshot.messages.length < draft.messages.length ||
      !snapshot.partial) {
    throw new Error('Не удалось зафиксировать текущую контрольную точку перед экспортом.');
  }

  const result = await exportConversation({
    activeDoc: false,
    archiveId: snapshot.id
  });

  return {
    ...result,
    ok: true,
    partial: true,
    partialArchiveId: snapshot.id,
    partialSourceDraftId: draft.id,
    exportedMessageCount: snapshot.messages.length
  };
}

async function resumeUnfinishedInSavedTab(passId = '') {
  let draft = await getDraft(passId);
  draft = await reconcileUnfinishedPrefix(draft);
  if (!draft?.messages?.length) throw new Error('Сохранённый незавершённый проход не найден.');

  // 0.3.91 could relabel a chronological walk draft as "top" when a fresh
  // recovery attempt failed while it was only searching for the saved frontier.
  // Such a draft is still a continuous saved prefix and must resume at its
  // frontier, not travel back to the beginning again.
  if (
    draft.capturePhase === 'top' &&
    ['resume-draft', 'retry-walk'].includes(draft.captureMode || '') &&
    draft.messages.length
  ) {
    draft = {
      ...draft,
      capturePhase: 'walk',
      lastScrollDirection: 'down'
    };
    await chrome.storage.local.set({ ['draft:' + draft.id]: draft });
  }

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
    resumeBaseCount: draft.messages.length,
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
  const draft = await reconcileUnfinishedPrefix(await getDraft(passId));
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
    mode: draft.captureMode !== 'fragment' && draft.capturePhase === 'top' && ['full', 'reconcile', 'images'].includes(draft.captureMode)
      ? draft.captureMode : 'resume-draft',
    resumeNavigation: draft.captureMode !== 'fragment' && draft.capturePhase === 'top',
    resumeTailSignatures: buildResumeTailSignatures(draft.messages, 4),
    existingDraft: draft,
    fixedCaptureBoundary: boundary,
    captureRange: draft.captureRange || null,
    docUrl: draft.pendingDocUrl || '',
    captureTarget
  });
}

async function deleteDraftAndRecoveryTab(draftId = '') {
  const job = await getJob();
  const targetId = draftId || job?.draftId || '';
  if (!targetId) return { ok: true, removed: false };

  await removeDraft(targetId);
  await removeDraftRecoveryTab(targetId).catch(() => {});

  if (job?.draftId === targetId || job?.recoveryDraftId === targetId) {
    // Deleting draft data must not close or discard the physical working tab.
    // A failed tab is kept until the user closes it manually or a later pass
    // succeeds and handleCaptureComplete() closes the working copy.
    await setJob({
      draftId: job?.draftId === targetId ? '' : (job?.draftId || ''),
      draftCount: job?.draftId === targetId ? 0 : Number(job?.draftCount || 0),
      recoveryDraftId: job?.recoveryDraftId === targetId ? '' : (job?.recoveryDraftId || ''),
      recoveryAvailable: Boolean(job?.captureTabId != null && job?.captureBoundary?.kind && job?.captureBoundary?.key)
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

async function hydrateUnfinishedDraftImages(passId = '') {
  const draft = await reconcileUnfinishedPrefix(await getDraft(passId));
  if (!draft?.messages?.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }
  if (!['walk', 'finalizing'].includes(draft.capturePhase || '')) {
    throw new Error(
      'Сверка изображений доступна после начала непрерывного сохранения сверху вниз.'
    );
  }
  if (!isConversationUrl(draft.sourceUrl || '')) {
    throw new Error('У незавершённого прохода нет рабочей ссылки на исходный чат.');
  }

  const lastMessage = draft.messages[draft.messages.length - 1] || null;
  if (!lastMessage) {
    throw new Error('В сохранённой части нет нижней границы для сверки изображений.');
  }
  const signature = messageSignature(lastMessage.role, lastMessage.text);
  const prefixBoundary = lastMessage.id
    ? { kind: 'stable', key: lastMessage.id, role: lastMessage.role || '', signature }
    : { kind: 'signature', key: signature, role: lastMessage.role || '', signature };

  const recovery = await resolveDraftRecoveryTab(passId, draft.sourceUrl || '');
  if (recovery.available) {
    await chrome.tabs.update(recovery.tab.id, { active: true });
    if (recovery.tab.windowId != null) {
      await chrome.windows.update(recovery.tab.windowId, { focused: true }).catch(() => {});
    }
    return startCapture({
      mode: 'images-draft',
      existingDraft: draft,
      fixedCaptureBoundary: prefixBoundary,
      captureTarget: 'current'
    });
  }

  const sourceTab = await chrome.tabs.create({ url: draft.sourceUrl, active: true });
  if (!sourceTab?.id) {
    throw new Error('Не удалось открыть исходный чат для сверки изображений.');
  }
  await waitForChatTabComplete(sourceTab.id);
  await waitForChatDomReady(sourceTab.id, 45000);

  return startCapture({
    mode: 'images-draft',
    existingDraft: draft,
    fixedCaptureBoundary: prefixBoundary,
    captureTarget: 'current'
  });
}

async function handleDraftImagesComplete(message) {
  const job = await getJob();
  if (!job || job.jobId !== message.jobId) return;

  const draft = await getDraft(message.draftId || job.draftId || job.recoveryDraftId || '');
  if (!draft?.messages?.length) {
    await finishJobWithError(
      message.jobId,
      job.sourceTabId ?? job.tabId,
      'Сверка изображений завершилась без сохранённого черновика.',
      message.draftId || '',
      0,
      'error'
    );
    return;
  }

  const finalMessage =
    'Сверка изображений сохранённой части завершена: ' +
    Number(draft.imageBinaryReady || 0) + ' подготовлено из ' +
    Number(draft.imageCount || 0) + '.';

  const next = await appendRunLog({
    status: 'done',
    phase: 'done',
    captureMode: 'images-draft',
    message: finalMessage,
    count: draft.messages.length,
    addedCount: 0,
    imageCount: Number(draft.imageCount || 0),
    imageBinaryReady: Number(draft.imageBinaryReady || 0),
    imageBinaryFailed: Number(draft.imageBinaryFailed || 0),
    draftId: draft.id,
    recoveryDraftId: draft.id,
    draftCount: draft.messages.length,
    finishedAt: Date.now(),
    captureTabId: null,
    recoveryAvailable: false
  }, {
    level: 'info',
    code: 'DRAFT_IMAGES_RECONCILED',
    message: finalMessage,
    phase: 'done',
    count: draft.messages.length
  });
  await recordRunHistory(next);

  if (job.captureTarget === 'copy' && job.captureTabId != null &&
      job.captureTabId !== job.sourceTabId) {
    await chrome.tabs.remove(job.captureTabId).catch(() => {});
  }
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
    const text = String(message?.text || '').trim();
    if (text) return 'sig:' + messageSignature(message?.role || '', text);
    return message?.id ? 'id:' + message.id : '';
  };

  const passMessages = unfinishedPass.messages || [];
  const archiveMessages = archive.messages || [];

  let commonPrefixCount = 0;
  while (
    commonPrefixCount < passMessages.length &&
    commonPrefixCount < archiveMessages.length &&
    identity(passMessages[commonPrefixCount]) === identity(archiveMessages[commonPrefixCount])
  ) {
    commonPrefixCount++;
  }

  const counts = messages => {
    const result = new Map();
    for (const message of messages) {
      const key = identity(message);
      if (!key) continue;
      result.set(key, (result.get(key) || 0) + 1);
    }
    return result;
  };
  const passCounts = counts(passMessages);
  const archiveCounts = counts(archiveMessages);
  const allKeys = new Set([...passCounts.keys(), ...archiveCounts.keys()]);
  let sharedCount = 0;
  let onlyInUnfinishedPassCount = 0;
  let onlyInArchiveCount = 0;
  for (const key of allKeys) {
    const passCount = passCounts.get(key) || 0;
    const archiveCount = archiveCounts.get(key) || 0;
    sharedCount += Math.min(passCount, archiveCount);
    onlyInUnfinishedPassCount += Math.max(0, passCount - archiveCount);
    onlyInArchiveCount += Math.max(0, archiveCount - passCount);
  }

  return {
    ok: true,
    unfinishedPass: summarize(unfinishedPass),
    archive: summarize(archive),
    commonPrefixCount,
    sharedCount,
    onlyInUnfinishedPassCount,
    onlyInArchiveCount
  };
}

async function reconcileUnfinishedPassIntoArchive(passId = '') {
  const draft = await reconcileUnfinishedPrefix(await getDraft(passId));
  if (!draft?.messages?.length) {
    throw new Error('Сохранённый незавершённый проход не найден.');
  }
  if (!['walk', 'finalizing'].includes(draft.capturePhase || '')) {
    throw new Error('Этот проход ещё не является непрерывной сохранённой частью от начала чата.');
  }

  const archive = await getArchiveForUrl(draft.sourceUrl || '');
  if (!archive?.messages?.length) {
    throw new Error('Для этого чата нет завершённого локального архива, с которым можно сверить сохранённую часть.');
  }

  const draftMessages = draft.messages || [];
  const archiveMessages = archive.messages || [];
  const matches = [];
  let draftFrom = 0;

  for (let archiveIndex = 0; archiveIndex < archiveMessages.length; archiveIndex++) {
    let found = -1;
    for (let i = draftFrom; i < draftMessages.length; i++) {
      if (storedMessagesMatch(archiveMessages[archiveIndex], draftMessages[i])) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      matches.push({ archiveIndex, draftIndex: -1 });
      continue;
    }
    matches.push({ archiveIndex, draftIndex: found });
    draftFrom = found + 1;
  }

  const matched = matches.filter(item => item.draftIndex >= 0);
  if (!matched.length) {
    throw new Error('Сверка не нашла доказуемого общего участка между незавершённым проходом и локальным архивом.');
  }

  const lastMatch = matched[matched.length - 1];
  const unresolvedInside = matches.filter(item =>
    item.archiveIndex <= lastMatch.archiveIndex && item.draftIndex < 0
  );
  if (unresolvedInside.length) {
    throw new Error(
      'Сверка остановлена: внутри общего диапазона есть сообщения локального архива, ' +
      'которых нет в незавершённом проходе. Архив не изменён.'
    );
  }

  const oldByDraftIndex = new Map(
    matched.map(item => [item.draftIndex, archiveMessages[item.archiveIndex]])
  );
  const mergedPrefix = draftMessages.map((message, index) => {
    const old = oldByDraftIndex.get(index);
    return old ? mergeStoredMessageCapture(message, old) : message;
  });
  const archiveTail = archiveMessages.slice(lastMatch.archiveIndex + 1);
  const messages = mergedPrefix.concat(archiveTail);
  const addedCount = draftMessages.length - matched.length;
  const allImages = messages.flatMap(item => item.images || []);

  const updated = {
    ...archive,
    messages,
    messageCount: messages.length,
    imageCount: allImages.length,
    imageBinaryReady: allImages.filter(storedImageReady).length,
    imageBinaryFailed: allImages.filter(image => image?.binaryStatus === 'failed').length,
    capturedAt: new Date().toISOString(),
    lastCaptureMode: 'reconcile-unfinished',
    lastCaptureAddedCount: Math.max(0, addedCount),
    previousMessageCount: archiveMessages.length,
    lastMessageId: messages[messages.length - 1]?.id || archive.lastMessageId || ''
  };

  await putArchive(updated);
  await indexArchive(updated);
  await registerArchive(updated);
  await chrome.storage.local.set({ [STORAGE_KEYS.lastArchiveId]: updated.id });

  return {
    ok: true,
    archive: summarize(updated),
    previousMessageCount: archiveMessages.length,
    messageCount: messages.length,
    addedCount: Math.max(0, addedCount),
    matchedCount: matched.length
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

  let archive = await getArchive(message.archiveId);
  if (!archive) {
    return finishJobWithError(
      message.jobId,
      job.sourceTabId ?? job.tabId,
      'Архив не найден после завершения сбора.',
      job.draftId || job.recoveryDraftId || '',
      Number(job.draftCount || 0),
      'error'
    );
  }

  if (message.mode !== 'compare' && (archive.partial || archive.complete !== true)) {
    archive = {
      ...archive,
      partial: false,
      complete: true
    };
    await putArchive(archive);
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
  } else if (message.mode !== 'compare' && !archive.isFragment) {
    await indexArchive(archive);
  }

  if (message.mode !== 'compare') {
    const libraryArchive = partialMerge.applied
      ? await getArchive(partialMerge.archiveId)
      : archive;
    if (libraryArchive?.id && !libraryArchive.partial && libraryArchive.complete !== false) {
      await registerArchive(libraryArchive);
    }
  }

  if (job.restoreCanonicalArchiveId) {
    const canonical = await getArchive(job.restoreCanonicalArchiveId);
    if (canonical?.id) await indexArchive(canonical);
  }
  if (job.restoreLastArchiveId) {
    const previousLast = await getArchive(job.restoreLastArchiveId);
    if (previousLast?.id) {
      await chrome.storage.local.set({ [STORAGE_KEYS.lastArchiveId]: previousLast.id });
    }
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

  // Keep the working ChatGPT tab open even after a verified successful pass.
  // Large captures can take hours; an automatic close destroys the physical
  // recovery position and can race with tabs.onRemoved before the job is marked
  // done. The user may close the working tab explicitly when it is no longer
  // needed.

  const addedCount = Number(message.addedCount || archive.lastCaptureAddedCount || 0);
  // The just-completed archive should be immediately previewable in the popup.
  await chrome.storage.local.set({ selectedArchiveId: archive.id });

  if (archive.isFragment && archive.sourceUrl) {
    try {
      const source = new URL(archive.sourceUrl);
      const markersKey = 'archiverFragmentMarkers:' + source.origin + source.pathname;
      await chrome.storage.local.remove(markersKey);
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab?.id || conversationKey(tab.url || '') !== conversationKey(archive.sourceUrl)) continue;
        await chrome.tabs.sendMessage(tab.id, {
          type: 'ARCHIVER_CLEAR_FRAGMENT_MARKERS'
        }).catch(() => {});
      }
    } catch (_) {}
  }

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

  if (message.mode === 'reconcile') {
    const repaired = Number(message.addedCount || archive.lastCaptureAddedCount || 0);
    const recoveredImages = Number(message.imageRecoveredCount || archive.lastImageRecoveredCount || 0);
    const imageTotal = Number(archive.imageCount || 0);
    const imageReady = Number(archive.imageBinaryReady || 0);
    const imageFailed = Number(archive.imageBinaryFailed || 0);
    const finalMessage =
      'Сверка завершена.' +
      (repaired ? ' Восстановлено сообщений: ' + repaired + '.' : ' Сообщения совпадают.') +
      (imageTotal
        ? ' Картинки: готово ' + imageReady + '/' + imageTotal +
          (recoveredImages ? ', восстановлено ' + recoveredImages : '') +
          (imageFailed ? ', не удалось ' + imageFailed : '') + '.'
        : '');

    const next = await appendRunLog({
      status: 'done',
      phase: 'done',
      captureMode: 'reconcile',
      message: finalMessage,
      count: archive.messages?.length || 0,
      addedCount: repaired,
      imageCount: archive.imageCount || 0,
      imageBinaryReady: archive.imageBinaryReady || 0,
      imageBinaryFailed: archive.imageBinaryFailed || 0,
      imageRecoveredCount: recoveredImages,
      archiveId: archive.id,
      finishedAt: Date.now(),
      captureTabId: null,
      recoveryAvailable: false,
      recoveryDraftId: '',
      draftId: '',
      draftCount: 0
    }, {
      level: 'info',
      code: 'ARCHIVE_RECONCILE_COMPLETE',
      message: finalMessage,
      phase: 'done',
      count: archive.messages?.length || 0
    });
    await recordRunHistory(next);
    return;
  }

  if (message.mode === 'images') {
    const recovered = Number(message.imageRecoveredCount || archive.lastImageRecoveredCount || 0);
    const finalMessage = recovered
      ? ('Добор изображений завершён: +' + recovered + '. Локальный архив обновлён; документ Google Docs не изменялся.')
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
      imageBinaryReady: archive.imageBinaryReady || 0,
      imageBinaryFailed: archive.imageBinaryFailed || 0,
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
  const shouldAutoAppend = Boolean(
    (isContinuation || isDraftRecovery) &&
    job.pendingDocUrl
  );

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
    ? ('Незавершённый сбор восстановлен: +' + addedCount + ' сообщений; архив собран до исходной нижней метки.')
    : isContinuation
      ? ('Архив продолжен: +' + addedCount + ' сообщений.')
      : 'Переписка собрана.';

  if (!isContinuation && !isDraftRecovery && Number(archive.imageCount || 0) > 0) {
    finalMessage += ' Картинки в локальном архиве: ' + Number(archive.imageCount || 0) +
      '; готово ' + Number(archive.imageBinaryReady || 0) +
      ', не удалось ' + Number(archive.imageBinaryFailed || 0) + '.';
  }

  if (shouldAutoAppend) {
    if (docError) finalMessage += ' Документ Google Docs не обновлён: ' + docError;
    else if (docResult?.addedCount) {
      finalMessage += ' В документ Google Docs добавлено ' + docResult.addedCount + ' сообщений';
      if (docResult.imageInsertedCount || docResult.imageFailedCount) {
        finalMessage += ' и ' + Number(docResult.imageInsertedCount || 0) + ' изображений';
        if (docResult.imageFailedCount) finalMessage += ' (' + Number(docResult.imageFailedCount) + ' не вставлено)';
      }
      finalMessage += '.';
    } else finalMessage += ' В документе Google Docs новых сообщений для вставки нет.';
  }

  const next = await appendRunLog({
    status: 'done',
    phase: 'done',
    message: finalMessage,
    count: archive.messages?.length || 0,
    addedCount,
    imageCount: archive.imageCount || 0,
    imageBinaryReady: archive.imageBinaryReady || 0,
    imageBinaryFailed: archive.imageBinaryFailed || 0,
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
  if (role === 'user') return settings.userName ? `${settings.userName}:` : 'Пользователь:';
  return settings.assistantName ? `${settings.assistantName}:` : 'ChatGPT:';
}
function messageHtmlForExport(message, {
  stripImages = false,
  preferOriginalImageSrc = false,
  preserveUnreadyImages = false
} = {}) {
  let html = String(message?.html || `<p>${escapeHtml(message?.text || '')}</p>`);

  // Exact legacy path: before 34f7bcb the rich clipboard received the captured
  // message HTML untouched, including its original absolute image URLs.
  if (preferOriginalImageSrc && !stripImages) return html;

  html = html.replace(/<img\b[^>]*>/gi, tag => {
    const indexMatch = tag.match(/data-archiver-image-index=["']?(\d+)["']?/i);
    const index = indexMatch ? Number(indexMatch[1]) : -1;
    const image = index >= 0 ? message?.images?.[index] : null;

    if (stripImages) {
      const ready = image?.binaryStatus === 'ready' && image?.dataUrl;
      if (!preserveUnreadyImages || ready) return '';
    }

    const src = (preserveUnreadyImages && !(image?.binaryStatus === 'ready' && image?.dataUrl))
      ? (image?.src || image?.dataUrl || '')
      : preferOriginalImageSrc
      ? (image?.src || image?.dataUrl || '')
      : (image?.dataUrl || image?.src || '');
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
    chunks.push(`<div>${messageHtmlForExport(msg, {
      stripImages: Boolean(options.stripImages),
      preferOriginalImageSrc: Boolean(options.preferOriginalImageSrc),
      preserveUnreadyImages: Boolean(options.preserveUnreadyImages)
    })}</div>`);
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
  await withTimeout(ensureOffscreen(), 10000, 'Подготовка буфера обмена');
  const result = await withTimeout(
    chrome.runtime.sendMessage({ type: 'ARCHIVER_OFFSCREEN_WRITE', target: 'offscreen', html, text }),
    12000,
    'Запись в буфер обмена'
  );
  if (!result?.ok) throw new Error(result?.error || 'Не удалось записать переписку в буфер обмена.');
}

async function readClipboardText() {
  await withTimeout(ensureOffscreen(), 10000, 'Подготовка буфера обмена');
  const result = await withTimeout(
    chrome.runtime.sendMessage({ type: 'ARCHIVER_OFFSCREEN_READ', target: 'offscreen' }),
    12000,
    'Чтение буфера обмена'
  );
  if (!result?.ok) throw new Error(result?.error || 'Не удалось прочитать текст из буфера обмена.');
  return String(result.text || '');
}

async function clearLinkedDocumentState(sourceUrl = '', docUrl = '') {
  const sourceKey = conversationKey(sourceUrl || '');
  const targetDocId = googleDocKey(docUrl || '');
  if (!sourceKey) return { cleared: false };

  const rows = await listLinkedArchives().catch(() => []);
  const matchingArchiveIds = rows
    .filter(item =>
      conversationKey(item?.sourceUrl || '') === sourceKey &&
      (!targetDocId || googleDocKey(item?.docUrl || item?.destination?.url || '') === targetDocId)
    )
    .map(item => item.id)
    .filter(Boolean);

  const result = await clearLinkedDoc(sourceUrl, docUrl);

  for (const archiveId of matchingArchiveIds) {
    await setArchiveDestination(archiveId, null).catch(() => {});
  }

  if (targetDocId) {
    const stored = await chrome.storage.local.get(DOC_IMAGE_PATCHES_KEY);
    const patches = { ...(stored[DOC_IMAGE_PATCHES_KEY] || {}) };
    if (Object.prototype.hasOwnProperty.call(patches, targetDocId)) {
      delete patches[targetDocId];
      await chrome.storage.local.set({ [DOC_IMAGE_PATCHES_KEY]: patches });
    }
  }

  return result;
}

async function waitForTabLoadComplete(tabId, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Вкладка была закрыта до завершения загрузки.');
    if (tab.status === 'complete') return tab;
    await sleep(250);
  }
  throw new Error('Страница не загрузилась за 30 секунд.');
}

async function inspectGoogleDocAvailability(tabId) {
  const started = Date.now();
  let last = null;

  while (Date.now() - started < 9000) {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = String(document.body?.innerText || '')
          .replace(/\s+/g, ' ')
          .slice(0, 12000);
        const editor = Boolean(document.querySelector(
          '.kix-appview-editor,.docs-editor-container,.kix-page,[role="textbox"]'
        ));
        return {
          href: location.href,
          title: document.title || '',
          readyState: document.readyState || '',
          bodyText,
          editor
        };
      }
    }).catch(() => []);
    last = execution?.[0]?.result || null;

    if (last?.editor) {
      return { status: 'available', ...last };
    }

    const text = ((last?.title || '') + ' ' + (last?.bodyText || '')).toLowerCase();
    const missing = [
      'file you have requested does not exist',
      'the file you have requested does not exist',
      'document does not exist',
      'this file has been deleted',
      'this document has been deleted',
      'файл, который вы запросили, не существует',
      'запрошенный файл не существует',
      'документ не существует',
      'файл удален',
      'файл удалён',
      'документ удален',
      'документ удалён'
    ].some(pattern => text.includes(pattern));
    if (missing) return { status: 'missing', ...last };

    const forbidden = [
      'you need access',
      'request access',
      'access denied',
      'you do not have permission',
      'вам нужен доступ',
      'запросить доступ',
      'нет доступа',
      'у вас нет доступа'
    ].some(pattern => text.includes(pattern));
    if (forbidden) return { status: 'forbidden', ...last };

    const login = /accounts\.google\.com/i.test(last?.href || '') ||
      text.includes('sign in') ||
      text.includes('войти');
    if (login) return { status: 'login', ...last };

    await sleep(500);
  }

  return { status: 'unknown', ...(last || {}) };
}

async function openExistingGoogleDocTab(
  docUrl,
  { sourceUrl = '', active = true, clearMissingLink = true } = {}
) {
  const normalized = normalizeGoogleDocUrl(docUrl);
  if (!normalized) throw new Error('Некорректная ссылка на документ Google Docs.');

  const tab = await chrome.tabs.create({ url: normalized, active });
  if (!tab?.id) throw new Error('Не удалось открыть документ Google Docs.');

  try {
    await waitForTabLoadComplete(tab.id, 30000);
    await sleep(900);
    const availability = await inspectGoogleDocAvailability(tab.id);

    if (availability.status === 'available') return tab;

    if (availability.status === 'missing') {
      if (clearMissingLink && sourceUrl) {
        await clearLinkedDocumentState(sourceUrl, normalized);
      }
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error(
        'Связанный документ Google Docs удалён или больше не существует. ' +
        (clearMissingLink && sourceUrl
          ? 'Архиватор снял устаревшую связь; можно создать новый документ.'
          : 'Операция остановлена.')
      );
    }

    if (availability.status === 'forbidden') {
      throw new Error(
        'Документ Google Docs существует, но текущему аккаунту не хватает доступа. Связь сохранена.'
      );
    }

    if (availability.status === 'login') {
      throw new Error('Google Docs просит войти в аккаунт. Связь сохранена.');
    }

    throw new Error(
      'Страница открылась, но Архиватор не смог подтвердить редактор Google Docs. Связь не изменена.'
    );
  } catch (error) {
    throw error;
  }
}

async function openLinkedGoogleDoc({ archiveId = '', sourceUrl = '' } = {}) {
  const archive = archiveId ? await getArchive(archiveId) : null;
  const source = sourceUrl || archive?.sourceUrl || '';
  if (!source) throw new Error('Не удалось определить исходный чат для связанного документа.');

  const linked = await getLinkedDoc(source);
  const docUrl = normalizeGoogleDocUrl(linked?.url || '');
  if (!docUrl) throw new Error('Для этого чата нет связанного документа Google Docs.');

  const tab = await openExistingGoogleDocTab(docUrl, {
    sourceUrl: source,
    active: true,
    clearMissingLink: true
  });
  return { ok: true, docUrl, tabId: tab.id, linkedDoc: linked };
}

async function replaceLinkedGoogleDoc({ archiveId = '', sourceUrl = '', docUrl = '' } = {}) {
  const archive = archiveId ? await getArchive(archiveId) : null;
  const source = sourceUrl || archive?.sourceUrl || '';
  if (!source) throw new Error('Не удалось определить исходный чат для замены связанного документа.');

  const normalized = normalizeGoogleDocUrl(docUrl);
  if (!normalized) {
    throw new Error('Нужна ссылка на документ Google Docs вида docs.google.com/document/d/...');
  }

  const previous = await getLinkedDoc(source);
  let probeTab = null;
  try {
    probeTab = await openExistingGoogleDocTab(normalized, {
      sourceUrl: source,
      active: false,
      clearMissingLink: false
    });
  } finally {
    if (probeTab?.id != null) await chrome.tabs.remove(probeTab.id).catch(() => {});
  }

  const linkedDoc = await setLinkedDoc(source, {
    url: normalized,
    docId: googleDocKey(normalized),
    lastMessageId: '',
    lastMessageSignature: '',
    tailSignatures: [],
    relinkedManually: true
  });

  const previousUrl = normalizeGoogleDocUrl(previous?.url || '');
  if (previousUrl && previousUrl !== normalized) {
    await clearLinkedDoc(source, previousUrl).catch(() => {});
  }

  return {
    ok: true,
    linkedDoc,
    previousUrl,
    docUrl: normalized,
    verificationRequired: true
  };
}

async function unlinkGoogleDoc({ archiveId = '', sourceUrl = '' } = {}) {
  const archive = archiveId ? await getArchive(archiveId) : null;
  const source = sourceUrl || archive?.sourceUrl || '';
  if (!source) throw new Error('Не удалось определить исходный чат для отвязки документа.');

  const linked = await getLinkedDoc(source);
  if (!linked?.url) return { ok: true, cleared: false };

  const result = await clearLinkedDoc(source, linked.url);
  return {
    ok: true,
    cleared: Boolean(result?.cleared),
    previousUrl: linked.url
  };
}

async function googleDocsNamedControlRect(tabId, patterns = []) {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const patterns = ${JSON.stringify(patterns)}.map(value => String(value || '').toLowerCase());
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 4 && rect.height >= 4 && rect.bottom > 0 && rect.right > 0;
      };
      const label = el => [
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('title') || '',
        el.getAttribute?.('data-tooltip') || '',
        el.textContent || ''
      ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      const nodes = [...document.querySelectorAll(
        'button,[role="button"],[role="menuitem"],[aria-label],[title],[data-tooltip]'
      )].filter(visible);
      const match = nodes.find(el => {
        const value = label(el);
        return value && patterns.some(pattern => pattern && value.includes(pattern));
      }) || null;
      if (!match) return null;
      const rect = match.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        label: label(match)
      };
    })()`,
    returnByValue: true
  });
  return result?.result?.value || null;
}

async function moveGoogleDocToTrash(docUrl, sourceUrl = '') {
  const normalized = normalizeGoogleDocUrl(docUrl);
  if (!normalized) throw new Error('Для удаления нужна корректная ссылка Google Docs.');

  let tab = null;
  let attached = false;
  try {
    tab = await openExistingGoogleDocTab(normalized, {
      sourceUrl,
      active: true,
      clearMissingLink: false
    });
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    attached = true;
    await sleep(500);

    let fileMenu = await googleDocsNamedControlRect(tab.id, ['file', 'файл']);
    if (!fileMenu) {
      const direct = await cdp(tab.id, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('#docs-file-menu');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`,
        returnByValue: true
      });
      fileMenu = direct?.result?.value || null;
    }
    if (!fileMenu) throw new Error('Не удалось найти меню «Файл» в Google Docs.');
    await physicalClick(tab.id, fileMenu);
    await sleep(350);

    const trash = await googleDocsNamedControlRect(tab.id, [
      'move to trash',
      'move to bin',
      'переместить в корзину',
      'в корзину'
    ]);
    if (!trash) {
      throw new Error('В меню Google Docs не найдено действие перемещения документа в корзину.');
    }
    await physicalClick(tab.id, trash);
    await sleep(500);

    const confirmTrash = await googleDocsNamedControlRect(tab.id, [
      'move to trash',
      'move to bin',
      'переместить в корзину'
    ]);
    if (confirmTrash) {
      await physicalClick(tab.id, confirmTrash);
      await sleep(800);
    }

    return { ok: true, docUrl: normalized, movedToTrash: true };
  } finally {
    if (attached && tab?.id != null) {
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    }
    if (tab?.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function deleteArchiveWithGoogleDoc(archiveId = '') {
  const archive = await getArchive(archiveId);
  if (!archive?.id) return { ok: true, removed: false, docRemoved: false };

  const destination = await getArchiveDestination(archive.id);
  const linked = archive.sourceUrl ? await getLinkedDoc(archive.sourceUrl) : null;
  const destinationUrl = destination?.kind === 'google-doc'
    ? normalizeGoogleDocUrl(destination.url || '')
    : '';
  const linkedUrl = normalizeGoogleDocUrl(linked?.url || '');
  const docUrl = destinationUrl || linkedUrl;

  if (!docUrl) {
    throw new Error('У этого архива нет связанного документа Google Docs для совместного удаления.');
  }

  await moveGoogleDocToTrash(docUrl, archive.sourceUrl || '');
  if (archive.sourceUrl) {
    await clearLinkedDocumentState(archive.sourceUrl, docUrl).catch(() => {});
  }
  const local = await deleteLocalArchive(archive.id);
  return {
    ...local,
    ok: true,
    docRemoved: true,
    docUrl
  };
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

async function cdp(tabId, method, params = {}, timeoutMs = 15000) {
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    timeoutMs,
    'Команда Chrome (' + method + ')'
  );
}

async function chatScrollMetrics(tabId, direction = 'down') {
  const sign = direction === 'up' ? -1 : 1;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scrollSign => {
      const roleSelector = [
        '[data-chatgpt-search-unit-key$=":user"]',
        '[data-chatgpt-search-unit-key$=":assistant"]',
        '[data-testid^="conversation-turn-"]',
        'article[data-turn]',
        'section[data-turn]'
      ].join(',');

      const visibleTurns = [...document.querySelectorAll(roleSelector)].filter(el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
      });
      const anchor = scrollSign < 0
        ? (visibleTurns[0] || document.querySelector('main'))
        : (visibleTurns[visibleTurns.length - 1] || document.querySelector('main'));

      const scrollable = el => {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        return /(auto|scroll|overlay)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 80;
      };

      let scroller = anchor?.parentElement || null;
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        if (scrollable(scroller)) break;
        scroller = scroller.parentElement;
      }

      if (!scroller || !scrollable(scroller)) {
        const candidates = [
          document.scrollingElement,
          document.documentElement,
          ...document.querySelectorAll(
            'main, main *, [class*="overflow-y-auto"], [class*="overflow-auto"]'
          )
        ].filter((el, index, all) =>
          el && all.indexOf(el) === index && scrollable(el)
        );

        const containing = anchor
          ? candidates.filter(el => el instanceof Element && el.contains(anchor))
          : [];
        scroller = (containing.length
          ? containing.sort((a, b) =>
              (a.scrollHeight - a.clientHeight) - (b.scrollHeight - b.clientHeight)
            )[0]
          : candidates.sort((a, b) =>
              (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
            )[0]) || document.scrollingElement || document.documentElement;
      }

      const top = Number(scroller?.scrollTop || window.scrollY || 0);
      const clientHeight = Number(scroller?.clientHeight || innerHeight || 0);
      const scrollHeight = Number(
        scroller?.scrollHeight || document.documentElement.scrollHeight || 0
      );
      const threshold = Math.max(24, Math.round(clientHeight * 0.04));
      return {
        top,
        clientHeight,
        scrollHeight,
        atStart: top <= threshold,
        atEnd: top + clientHeight >= scrollHeight - threshold
      };
    },
    args: [sign]
  });
  return results?.[0]?.result || null;
}

async function scriptedScrollChatTab(tabId, direction = 'down', bursts = 7) {
  const sign = direction === 'up' ? -1 : 1;
  const count = Math.max(1, Math.min(24, Number(bursts) || 7));
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (scrollSign, burstCount) => {
      const roleSelector = [
        '[data-chatgpt-search-unit-key$=":user"]',
        '[data-chatgpt-search-unit-key$=":assistant"]',
        '[data-testid^="conversation-turn-"]',
        'article[data-turn]',
        'section[data-turn]'
      ].join(',');

      const visibleTurns = [...document.querySelectorAll(roleSelector)].filter(el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden';
      });
      const anchor = scrollSign < 0
        ? (visibleTurns[0] || document.querySelector('main'))
        : (visibleTurns[visibleTurns.length - 1] || document.querySelector('main'));

      const scrollable = el => {
        if (!(el instanceof Element)) return false;
        const style = getComputedStyle(el);
        return /(auto|scroll|overlay)/.test(style.overflowY) &&
          el.scrollHeight > el.clientHeight + 80;
      };

      let scroller = anchor?.parentElement || null;
      while (scroller && scroller !== document.body && scroller !== document.documentElement) {
        if (scrollable(scroller)) break;
        scroller = scroller.parentElement;
      }

      if (!scroller || !scrollable(scroller)) {
        const candidates = [
          document.scrollingElement,
          document.documentElement,
          ...document.querySelectorAll(
            'main, main *, [class*="overflow-y-auto"], [class*="overflow-auto"]'
          )
        ].filter((el, index, all) =>
          el && all.indexOf(el) === index && scrollable(el)
        );

        const containing = anchor
          ? candidates.filter(el => el instanceof Element && el.contains(anchor))
          : [];
        scroller = (containing.length
          ? containing.sort((a, b) =>
              (a.scrollHeight - a.clientHeight) - (b.scrollHeight - b.clientHeight)
            )[0]
          : candidates.sort((a, b) =>
              (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
            )[0]) || document.scrollingElement || document.documentElement;
      }

      const amount = scrollSign * 860 * burstCount;
      const before = Number(scroller?.scrollTop || window.scrollY || 0);
      if (
        scroller === document.documentElement ||
        scroller === document.body ||
        scroller === document.scrollingElement
      ) {
        window.scrollBy({ top: amount, left: 0, behavior: 'auto' });
      } else {
        scroller.scrollBy({ top: amount, left: 0, behavior: 'auto' });
      }
      const after = Number(scroller?.scrollTop || window.scrollY || 0);
      return {
        ok: true,
        method: 'scripted-scroll-fallback',
        before,
        after,
        delta: after - before
      };
    },
    args: [sign, count]
  });
  return results?.[0]?.result || {
    ok: true,
    method: 'scripted-scroll-fallback'
  };
}

async function physicalScrollTab(tabId, direction = 'down', bursts = 7) {
  let attached = false;
  const count = Math.max(1, Math.min(24, Number(bursts) || 7));
  const sign = direction === 'up' ? -1 : 1;
  let debuggerError = '';
  const beforeMetrics = await chatScrollMetrics(tabId, direction).catch(() => null);

  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(item => item.tabId === tabId);
    if (target?.attached) {
      throw new Error('Фоновая вкладка уже занята средством отладки Chrome.');
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;

    const viewportResult = await cdp(tabId, 'Runtime.evaluate', {
      expression: '({width: innerWidth, height: innerHeight})',
      returnByValue: true
    }, 5000);
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
    }, 2500).catch(() => {});

    for (let i = 0; i < count; i++) {
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: sign * 860
      }, 4000);
      await sleep(70);
    }
  } catch (error) {
    debuggerError = error?.message || String(error);
  } finally {
    if (attached) {
      await withTimeout(
        chrome.debugger.detach({ tabId }).catch(() => {}),
        3000,
        'Отключение Chrome Debugger'
      ).catch(() => {});
      attached = false;
    }
  }

  await sleep(120);
  const afterMetrics = await chatScrollMetrics(tabId, direction).catch(() => null);
  const moved = Boolean(
    beforeMetrics && afterMetrics &&
    Math.abs(Number(afterMetrics.top || 0) - Number(beforeMetrics.top || 0)) >= 2
  );
  const alreadyAtRequestedEdge = direction === 'up'
    ? Boolean(beforeMetrics?.atStart)
    : Boolean(beforeMetrics?.atEnd);

  if (!debuggerError && (moved || alreadyAtRequestedEdge)) {
    return {
      ok: true,
      direction,
      bursts: count,
      method: moved ? 'debugger-wheel' : 'debugger-wheel-edge',
      before: beforeMetrics?.top ?? null,
      after: afterMetrics?.top ?? null
    };
  }

  const fallbackReason =
    debuggerError ||
    'debugger wheel returned success without moving the chat scroller';
  const fallback = await withTimeout(
    scriptedScrollChatTab(tabId, direction, count),
    5000,
    'Резервная прокрутка ChatGPT'
  );

  return {
    ...fallback,
    ok: true,
    direction,
    bursts: count,
    fallbackFrom: fallbackReason
  };
}

async function withChatDebugger(tabId, fn) {
  let attached = false;
  try {
    const targets = await chrome.debugger.getTargets();
    const target = targets.find(item => item.tabId === tabId);
    if (target?.attached) throw new Error('Вкладка уже занята средством отладки Chrome.');
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
  if (!normalizedUrl) throw new Error('Нужна ссылка на документ Google Docs вида docs.google.com/document/d/...');

  let tab = null;
  let attached = false;
  try {
    tab = await openExistingGoogleDocTab(normalizedUrl, {
      sourceUrl: '',
      active: true,
      clearMissingLink: false
    });
    await sleep(900);

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
      throw new Error('В документе Google Docs не удалось найти достаточно реплик для надёжной сверки.');
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
    return { ok: false, error: 'В архиве нет подготовленных данных изображения.' };
  }

  // The primary path must put a real bitmap on the OS clipboard. Google Docs
  // can accept execCommand/rich-HTML copy as "successful" while still treating
  // the <img src> as an external upload and rejecting it with a permission
  // snackbar. Convert every prepared image to PNG and write ClipboardItem
  // directly from the focused Google Docs page under a debugger user gesture.
  let binaryClipboardError = '';
  try {
    const expression = `(async () => {
      const dataUrl = ${JSON.stringify(dataUrl)};
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
          throw new Error('ClipboardItem API недоступен.');
        }

        const response = await fetch(dataUrl);
        const sourceBlob = await response.blob();
        if (!sourceBlob.size) throw new Error('Пустые данные изображения.');

        const bitmap = await createImageBitmap(sourceBlob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Не удалось создать PNG-буфер изображения.');
          context.drawImage(bitmap, 0, 0);

          const pngBlob = await new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
              if (blob?.size) resolve(blob);
              else reject(new Error('Не удалось преобразовать изображение в PNG.'));
            }, 'image/png');
          });

          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
          ]);

          return {
            ok: true,
            method: 'navigator.clipboard-image-png',
            type: 'image/png',
            size: pngBlob.size
          };
        } finally {
          bitmap.close?.();
        }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    })()`;

    const result = await withTimeout(
      cdp(tabId, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      }),
      15000,
      'Запись PNG в буфер обмена'
    );
    const value = result?.result?.value || {
      ok: false,
      error: 'Google Docs не подтвердил запись PNG в буфер обмена.'
    };
    if (value.ok) return value;
    binaryClipboardError = value.error || 'navigator.clipboard.write failed';
  } catch (error) {
    binaryClipboardError = error?.message || String(error);
  }

  // Compatibility fallback only. Unlike the primary path, these methods can be
  // interpreted by Google Docs as an external image upload, so their success
  // must never be mistaken for proof that a bitmap reached the clipboard.
  let offscreenError = '';
  try {
    await withTimeout(ensureOffscreen(), 10000, 'Подготовка резервного буфера изображения');
    const offscreen = await withTimeout(
      chrome.runtime.sendMessage({
        type: 'ARCHIVER_OFFSCREEN_WRITE_IMAGE',
        target: 'offscreen',
        dataUrl,
        alt: String(image?.alt || '')
      }),
      15000,
      'Резервное копирование изображения'
    );
    if (offscreen?.ok) {
      return {
        ok: true,
        method: offscreen.method || 'offscreen-image-selection',
        size: offscreen.size || dataUrl.length,
        fallbackFrom: binaryClipboardError
      };
    }
    offscreenError = offscreen?.error || 'offscreen image clipboard failed';
  } catch (error) {
    offscreenError = error?.message || String(error);
  }

  try {
    const source = String(image?.src || dataUrl);
    const alt = String(image?.alt || '');
    const html =
      '<img src="' + escapeHtml(source) + '" alt="' + escapeHtml(alt) + '">';
    await writeClipboard(html, alt);
    return {
      ok: true,
      method: 'offscreen-rich-html-image',
      size: source.length,
      fallbackFrom: [binaryClipboardError, offscreenError].filter(Boolean).join(' | ')
    };
  } catch (error) {
    return {
      ok: false,
      error: [
        binaryClipboardError,
        offscreenError,
        error?.message || String(error)
      ].filter(Boolean).join(' | ')
    };
  }
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
  let imageInlinePasteCount = 0;
  let imageFailedCount = 0;
  const failedImages = [];

  const pasteChunk = async (
    buffer,
    withHeader,
    { stripImages = true, preferOriginalImageSrc = false } = {}
  ) => {
    if (!buffer.length && !withHeader) return;
    const html = buildRichHtml(conversation, settings, {
      messages: buffer,
      includeHeader: withHeader,
      stripImages,
      preferOriginalImageSrc
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
    await sleep(stripImages ? 450 : 950);
  };

  const pasteBinaryImages = async message => {
    const ready = messageImagesReady(message);
    const failed = (message.images || []).filter(image => !image?.dataUrl);

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
      const images = (message.images || []).filter(image => image?.src || image?.dataUrl);
      if (!images.length) {
        buffer.push(message);
        continue;
      }

      // Restore the pre-34f7bcb path that was observed to work in Google Docs:
      // text and image markup for an image-bearing message travel through one
      // rich HTML clipboard paste, using the original ChatGPT image URL first.
      if (buffer.length) {
        await pasteChunk(buffer, headerPending, { stripImages: true });
        buffer = [];
        headerPending = false;
      }

      try {
        await pasteChunk([message], headerPending, {
          stripImages: false,
          preferOriginalImageSrc: true
        });
        headerPending = false;
        imageInlinePasteCount += images.length;
      } catch (error) {
        // If the old rich-HTML route itself errors, keep the newer binary
        // clipboard path as a fallback instead of losing the whole export.
        await pasteChunk([message], headerPending, { stripImages: true });
        headerPending = false;
        await pasteBinaryImages(message);
        if (!imageInsertedCount && !imageFailedCount) {
          failedImages.push({
            src: images[0]?.src || '',
            error: error?.message || String(error)
          });
        }
      }
    }

    await pasteChunk(buffer, headerPending, { stripImages: true });
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  return {
    tab: await chrome.tabs.get(tabId),
    imageInsertedCount,
    imageInlinePasteCount,
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

async function patchRecoveredImagesToLinkedDoc(archiveId = '', { excludeMessages = [] } = {}) {
  const archive = await getArchive(archiveId) || await getLastArchive();
  if (!archive) throw new Error('Нет локального архива.');
  const linked = await getLinkedDoc(archive.sourceUrl || '');
  const docUrl = normalizeGoogleDocUrl(linked?.url || '');
  if (!docUrl) throw new Error('Для этого архива не найден связанный документ Google Docs.');

  const excludedIds = new Set(
    (excludeMessages || []).map(item => String(item?.id || '')).filter(Boolean)
  );
  const excludedSignatures = new Set(
    (excludeMessages || []).map(item => messageSignature(item?.role, item?.text)).filter(Boolean)
  );
  const allItems = recoveredImageItems(archive).filter(item =>
    !excludedIds.has(String(item?.message?.id || '')) &&
    !excludedSignatures.has(messageSignature(item?.message?.role, item?.message?.text))
  );
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
    tab = await openExistingGoogleDocTab(docUrl, {
      sourceUrl: archive.sourceUrl || '',
      active: true,
      clearMissingLink: true
    });
    await sleep(900);

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
          failures.push({ src: item.image.src || '', error: 'Не найден уникальный текстовый якорь сообщения в документе Google Docs.' });
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
  if (!normalizedUrl) throw new Error('Некорректная ссылка на документ Google Docs.');

  if (!messages?.length) {
    const linkedDoc = await recordDocExport(conversation, normalizedUrl, { link: linkTarget });
    return { docUrl: normalizedUrl, addedCount: 0, noChanges: true, linkedDoc };
  }

  const settings = await getSettings();
  let tab = null;
  try {
    tab = await openExistingGoogleDocTab(normalizedUrl, {
      sourceUrl: conversation.sourceUrl || '',
      active: true,
      clearMissingLink: linkTarget
    });
    await sleep(900);

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
      imageInlinePasteCount: pasted.imageInlinePasteCount || 0,
      imageFailedCount: pasted.imageFailedCount || 0,
      failedImages: pasted.failedImages || []
    };
  } finally {
    if (sourceTabId != null) await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  }
}

async function exportConversationToLinkedDoc(archiveId = '') {
  const conversation = archiveId ? await getArchive(archiveId) : await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');
  if (conversation.isFragment) {
    throw new Error('Для фрагмента нет канонического связанного документа.');
  }

  const linked = await getLinkedDoc(conversation.sourceUrl || '');
  const docUrl = normalizeGoogleDocUrl(linked?.url || '');
  if (!docUrl) throw new Error('Для этого чата нет связанного документа Google Docs.');

  const docId = googleDocKey(docUrl);
  const previous = await getDocExport(docId);
  const messages = conversation.messages || [];
  const currentConversationKey = conversationKey(conversation.sourceUrl);
  let anchorIndex = -1;

  if (previous?.conversationKey === currentConversationKey) {
    if (previous.lastMessageId) {
      anchorIndex = messages.findIndex(item => item.id === previous.lastMessageId);
    }
    if (anchorIndex < 0 &&
        Array.isArray(previous.tailSignatures) &&
        previous.tailSignatures.length >= 2) {
      anchorIndex = findExportTailAnchor(messages, previous.tailSignatures);
    }
  }

  if (anchorIndex < 0) {
    throw new Error(
      'Связанный документ найден, но точку продолжения подтвердить не удалось. ' +
      'Полный архив повторно не вставлен.'
    );
  }

  const delta = messages.slice(anchorIndex + 1);
  let messageResult = {
    docUrl,
    addedCount: 0,
    noChanges: true,
    imageInsertedCount: 0,
    imageInlinePasteCount: 0,
    imageFailedCount: 0,
    failedImages: []
  };

  if (delta.length) {
    messageResult = await appendMessagesToGoogleDocUrl(
      conversation,
      delta,
      docUrl,
      null,
      { linkTarget: true }
    );
  }

  // Recovered images can belong to messages that were exported long before
  // their binary data became available. Patch those older messages during the
  // same manual export action. Do not re-patch images from delta messages:
  // pasteArchiveIntoGoogleDoc already inserted those in sequence with the text.
  let patchResult = {
    docUrl,
    inserted: 0,
    failed: 0,
    noChanges: true,
    failures: []
  };
  const oldRecoveredItems = recoveredImageItems(conversation).filter(item => {
    const index = messages.findIndex(message =>
      (item?.message?.id && message.id === item.message.id) ||
      messageSignature(message.role, message.text) === messageSignature(item?.message?.role, item?.message?.text)
    );
    return index >= 0 && index <= anchorIndex;
  });

  if (oldRecoveredItems.length) {
    patchResult = await patchRecoveredImagesToLinkedDoc(conversation.id, {
      excludeMessages: delta
    });
  } else if (!delta.length) {
    // No text delta and no pending recovered images: opening the linked Doc is
    // the only visible result of the user's manual export action.
    await openLinkedGoogleDoc({ archiveId: conversation.id });
  }

  const imageInsertedCount =
    Number(messageResult.imageInsertedCount || 0) +
    Number(patchResult.inserted || 0);
  const imageInlinePasteCount = Number(messageResult.imageInlinePasteCount || 0);
  const imageFailedCount =
    Number(messageResult.imageFailedCount || 0) +
    Number(patchResult.failed || 0);
  const failedImages = [
    ...(messageResult.failedImages || []),
    ...(patchResult.failures || [])
  ];

  return {
    docUrl: messageResult.docUrl || patchResult.docUrl || docUrl,
    linkedDoc: await getLinkedDoc(conversation.sourceUrl || ''),
    addedCount: Number(messageResult.addedCount || 0),
    noChanges: !delta.length && !imageInsertedCount && !imageFailedCount,
    imageInsertedCount,
    imageInlinePasteCount,
    imageFailedCount,
    failedImages,
    recoveredImagePatchAttempted: Boolean(oldRecoveredItems.length),
    recoveredImagePatchCandidateCount: oldRecoveredItems.length,
    recoveredImagePatchInserted: Number(patchResult.inserted || 0),
    recoveredImagePatchFailed: Number(patchResult.failed || 0),
    firstImageFailure: String(failedImages[0]?.error || '')
  };
}

async function exportConversation({ activeDoc = false, archiveId = '' } = {}) {
  const conversation = archiveId ? await getArchive(archiveId) : await getLastArchive();
  if (!conversation) throw new Error('Сначала соберите переписку.');

  if (conversation.isFragment && activeDoc) throw new Error('Фрагмент можно экспортировать только в новый документ Google Docs.');
  if (!activeDoc) {
    const autoParts = planGoogleDocParts(conversation.messages || [], []);
    if (autoParts.length > 1) {
      if (conversation.isFragment) throw new Error('Этот фрагмент превышает лимит одного документа Google Docs. Скопируйте его или разбейте на части.');
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
    if (!tab?.id || !isGoogleDocUrl(tab.url)) throw new Error('Откройте нужный документ Google Docs в активной вкладке.');

    const docKey = googleDocKey(tab.url);
    if (!docKey) throw new Error('Не удалось определить идентификатор открытого документа Google Docs.');

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

    // A new Google Doc must always receive the archive title, including
    // partial/unfinished snapshots. Completeness is unrelated to document naming.
    const documentTitle = String(conversation.title || 'ChatGPT conversation').trim();
    await renameGoogleDoc(tab.id, documentTitle).catch(() => false);
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
    imageInlinePasteCount: pasted.imageInlinePasteCount || 0,
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
      'Новый документ Google Docs должен начинаться с одной первой вкладки, но найдено: ' +
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
  let imageInlinePasteCount = 0;
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
    if (!browserTab?.id) throw new Error('Не удалось открыть новый документ Google Docs.');
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
        imageInlinePasteCount += Number(pasted.imageInlinePasteCount || 0);
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
      case 'ARCHIVER_FETCH_IMAGE_BINARY':
        return await fetchImageBinaryForContent(message.src || '');
      case 'ARCHIVER_CAPTURE_RENDERED_IMAGE': {
        const tabId = sender?.tab?.id;
        if (tabId == null) throw new Error('Не удалось определить вкладку с картинкой.');
        const job = await getJob();
        if (job?.captureTabId != null && job.captureTabId !== tabId) {
          throw new Error('Картинка пришла не из вкладки текущего сбора.');
        }
        return await captureRenderedImageForContent(
          tabId,
          message.rect || {},
          message.viewport || {}
        );
      }
      case 'ARCHIVER_CHECK_UPDATE':
        return await checkForUpdate();
      case 'ARCHIVER_TOGGLE_MARKING_CURRENT':
        return await toggleBoundaryMarkingCurrent();
      case 'ARCHIVER_CLEAR_MARKERS_CURRENT':
        return await clearBoundaryMarkersCurrent();
      case 'ARCHIVER_OPEN_MARKING_TAB':
        return await openBoundaryMarkingTab();
      case 'ARCHIVER_CAPTURE_FRAGMENT':
        return await startCapture({ mode: 'fragment', captureTarget: 'current' });
      case 'ARCHIVER_CAPTURE_CURRENT':
        return await startCapture({
          mode: 'full',
          captureTarget: message.captureTarget || 'copy'
        });
      case 'ARCHIVER_RECONCILE_CURRENT':
        return await startCapture({
          mode: 'reconcile',
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
      case 'ARCHIVER_SELECT_SAVED_ARCHIVE':
        return await selectSavedArchive(message.archiveId || '');
      case 'ARCHIVER_RECONCILE_SAVED_ARCHIVE':
        return await captureSavedArchive(
          message.archiveId || '',
          'reconcile',
          message.captureTarget || 'copy'
        );
      case 'ARCHIVER_RECOVER_IMAGES_SAVED_ARCHIVE':
        return await captureSavedArchive(
          message.archiveId || '',
          'images',
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
      case 'ARCHIVER_GET_LIVE_STATE': {
        const job = await refreshCaptureJobHealth();
        return { ok: true, job, unfinishedPass: liveUnfinishedSummary(job) };
      }
      case 'ARCHIVER_GET_STATE': {
        let job = await refreshCaptureJobHealth();
        const tab = await getActiveTab();
        let currentArchive = null;
        let linkedDoc = null;
        let captureRange = null;
        if (tab?.url && isConversationUrl(tab.url)) {
          currentArchive = await getArchiveForUrl(tab.url);
          linkedDoc = await getLinkedDoc(tab.url);
          try {
            const source = new URL(tab.url);
            const markersKey = 'archiverFragmentMarkers:' + source.origin + source.pathname;
            captureRange = (await chrome.storage.local.get(markersKey))[markersKey] || null;
          } catch (_) {}
        }
        const activeIsConversation = Boolean(tab?.url && isConversationUrl(tab.url));
        const selection = await chrome.storage.local.get('selectedArchiveId');
        const selectedArchive = selection.selectedArchiveId
          ? await getArchive(selection.selectedArchiveId) : null;
        const archive = selectedArchive || (activeIsConversation
          ? currentArchive
          : (currentArchive || await getLastArchive()));
        if (archive?.id && !archive.partial && archive.complete !== false) {
          await registerArchive(archive);
        }
        if (!activeIsConversation && !linkedDoc && archive?.sourceUrl) {
          linkedDoc = await getLinkedDoc(archive.sourceUrl);
        }
        const drafts = await compactCompatibleDrafts(await listDrafts());
        const unfinishedPasses = await buildUnfinishedCaptureGroups(drafts);

        let activeUnfinished = unfinishedPasses.find(item =>
          (item.passIds || []).includes(job?.draftId || '') ||
          (item.passIds || []).includes(job?.recoveryDraftId || '')
        ) || null;

        // A huge chat may fail while still travelling to the beginning, before
        // the first chronological draft exists. Surface that as the same single
        // unfinished capture card so the preserved tab remains recoverable.
        if (!activeUnfinished &&
            job &&
            ['error', 'cancelled'].includes(job.status) &&
            job.captureTabId != null &&
            job.captureBoundary?.kind &&
            job.captureBoundary?.key &&
            job.sourceUrl) {
          const linked = await getLinkedDoc(job.sourceUrl);
          const pseudo = {
            id: 'job:' + String(job.jobId || ''),
            logicalGroupId: unfinishedGroupKey({
              id: job.jobId || '',
              sourceUrl: job.sourceUrl || ''
            }),
            resumePassId: '',
            exportPassId: '',
            copyPassId: '',
            viewPassId: '',
            passIds: [],
            title: job.title || 'Незавершённый сбор',
            sourceUrl: job.sourceUrl || '',
            capturedAt: new Date(Number(job.updatedAt || job.finishedAt || Date.now())).toISOString(),
            messageCount: Number(job.count || 0),
            imageCount: 0,
            captureMode: job.captureMode || 'full',
            capturePhase: job.phase || 'top',
            hasBoundary: true,
            canExportCurrent: false,
            exportMessageCount: 0,
            recoveryTabAvailable: true,
            recoveryTabId: job.captureTabId,
            recoveryCaptureTarget: job.captureTarget || '',
            resumeFromJob: true,
            linkedDocUrl: linked?.url || '',
            technicalPassCount: 0
          };
          unfinishedPasses.unshift(pseudo);
          activeUnfinished = pseudo;
        }

        const rawArchiveDestination = archive?.id
          ? await getArchiveDestination(archive.id)
          : null;
        const archiveDestination = await validatedArchiveDestination(
          archive,
          rawArchiveDestination
        );

        return {
          ok: true,
          job,
          archive: summarize(archive),
          archiveDestination,
          unfinishedPass: activeUnfinished,
          unfinishedPasses,
          linkedDoc,
          captureRange,
          savedArchives: await listLinkedArchives(),
          canContinue: Boolean(currentArchive?.messages?.length && !archive?.isFragment),
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
      case 'ARCHIVER_RECONCILE_UNFINISHED_PASS':
        return await reconcileUnfinishedPassIntoArchive(message.passId || message.draftId || '');
      case 'ARCHIVER_HYDRATE_UNFINISHED_IMAGES':
        return await hydrateUnfinishedDraftImages(message.passId || message.draftId || '');
      case 'ARCHIVER_GET_LAST':
        return { ok: true, archive: summarize(await getLastArchive()) };
      case 'ARCHIVER_CONFIRM_TOP':
        return await confirmCaptureTop();
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
      case 'ARCHIVER_EXPORT_UNFINISHED_NEW_DOC':
        return await exportUnfinishedPassToNewDoc(message.passId || message.draftId || '');
      case 'ARCHIVER_DELETE_DRAFT':
      case 'ARCHIVER_DELETE_UNFINISHED_PASS':
        return await deleteDraftAndRecoveryTab(message.draftId || message.passId || '');
      case 'ARCHIVER_DELETE_UNFINISHED_GROUP':
        return await deleteUnfinishedGroup(
          message.logicalGroupId || '',
          Array.isArray(message.passIds) ? message.passIds : []
        );
      case 'ARCHIVER_DELETE_ARCHIVE':
        return await deleteLocalArchive(message.archiveId || '');
      case 'ARCHIVER_DELETE_ARCHIVE_WITH_DOC':
        return await deleteArchiveWithGoogleDoc(message.archiveId || '');
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

        // A successful physical-scroll request proves that the collector is
        // alive, but persisting that proof on every wheel step is expensive on
        // very long chats. Store a heartbeat at most once every 15 seconds.
        const now = Date.now();
        if (now - Number(job.lastHeartbeatAt || job.updatedAt || 0) >= 15000) {
          await setJob({
            lastHeartbeatAt: now,
            lastPhysicalActivity: 'scroll'
          });
        }
        return await physicalScrollTab(
          job.captureTabId,
          message.direction,
          message.bursts
        );
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
      case 'ARCHIVER_DRAFT_IMAGES_COMPLETE':
        await handleDraftImagesComplete(message);
        return { ok: true };
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
      case 'ARCHIVER_EXPORT_LINKED_DOC':
        return { ok: true, ...(await exportConversationToLinkedDoc(message.archiveId || '')) };
      case 'ARCHIVER_OPEN_LINKED_DOC':
        return await openLinkedGoogleDoc({
          archiveId: message.archiveId || '',
          sourceUrl: message.sourceUrl || ''
        });
      case 'ARCHIVER_REPLACE_LINKED_DOC':
        return await replaceLinkedGoogleDoc({
          archiveId: message.archiveId || '',
          sourceUrl: message.sourceUrl || '',
          docUrl: message.docUrl || ''
        });
      case 'ARCHIVER_CLEAR_LINKED_DOC':
        return await unlinkGoogleDoc({
          archiveId: message.archiveId || '',
          sourceUrl: message.sourceUrl || ''
        });
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
        : 'Рабочая копия с перепиской была закрыта. Незавершённый сбор можно продолжить.',
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
    const draft = job.draftId ? await getDraft(job.draftId).catch(() => null) : null;
    await finishJobWithError(
      job.jobId,
      job.sourceTabId ?? job.tabId,
      'Расширение обновлено во время сбора.',
      draft?.id || job.draftId || '',
      draft?.messages?.length || Number(job.draftCount || 0),
      'error'
    );
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
  if (alarm?.name === UPDATE_ALARM) {
    checkForUpdate().catch(() => {});
    return;
  }
  if (String(alarm?.name || '').startsWith(AUTO_RECOVERY_ALARM_PREFIX)) {
    const failedJobId = String(alarm.name).slice(AUTO_RECOVERY_ALARM_PREFIX.length);
    attemptAutomaticRecovery(failedJobId).catch(error =>
      logTabListenerError('auto-recovery', error)
    );
  }
});
