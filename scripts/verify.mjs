import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const jsFiles = [
  'service-worker.js',
  'content-chatgpt-scroll.js',
  'content-chatgpt.js',
  'popup.js',
  'updater.js',
  'planner.js',
  'offscreen.js',
  'lib/text.mjs',
  'lib/urls.mjs',
  'lib/archive-store.mjs',
  'lib/google-docs-baseline.mjs',
  'lib/tab-plan.mjs',
  'lib/document-parts.mjs'
];

const forbiddenArtifacts = [
  'updater-last.log',
  '.chatgpt-archiver-updater-state.json'
];

let failed = false;

function fail(message) {
  failed = true;
  console.error('ERROR:', message);
}

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    fail(`${file}: JavaScript syntax check failed\n${result.stderr || result.stdout}`);
  } else {
    console.log('OK:', file);
  }
}

try {
  const serviceWorkerSource = await readFile('service-worker.js', 'utf8');
  const requiredRuntimeHelpers = [
    'getActiveTab',
    'getJob',
    'setJob',
    'appendRunLog',
    'formatRunLog'
  ];
  for (const helper of requiredRuntimeHelpers) {
    const declaration = new RegExp('(?:async\\s+)?function\\s+' + helper + '\\s*\\(');
    if (!declaration.test(serviceWorkerSource)) {
      fail('service-worker.js: missing runtime helper declaration ' + helper);
    }
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_COMPARE_CURRENT'")) {
    fail('service-worker.js: missing compare-current route');
  }
  const scrollSource = await readFile('content-chatgpt-scroll.js', 'utf8');
  const contentSource = await readFile('content-chatgpt.js', 'utf8');
  if (!scrollSource.includes("globalThis[KEY] = Object.freeze") ||
      !scrollSource.includes('findScrollContainer') ||
      !scrollSource.includes('physicalScrollStartVisible') ||
      !scrollSource.includes('physicalScrollEndVisible') ||
      !scrollSource.includes('findVisibleLoadRetry') ||
      !scrollSource.includes('observeWindow') ||
      !scrollSource.includes('createStabilityState') ||
      !scrollSource.includes('updateStabilityState') ||
      !scrollSource.includes('sameWindow') ||
      !scrollSource.includes('waitForTurnSettle') ||
      !scrollSource.includes("type: 'ARCHIVER_PHYSICAL_SCROLL'")) {
    fail('scroll runtime: missing shared container/edge/retry/settle/transport primitives');
  }
  if (!contentSource.includes('function scrollRuntime()') ||
      !contentSource.includes('scrollRuntime().findScrollContainer') ||
      !contentSource.includes('scrollRuntime().findVisibleLoadRetry') ||
      !contentSource.includes('scrollRuntime().physicalScroll') ||
      contentSource.includes("type: 'ARCHIVER_PHYSICAL_SCROLL'")) {
    fail('content-chatgpt.js: traversal must use the shared scroll runtime instead of reimplementing transport');
  }
  if (!contentSource.includes("return 'turn:' + wrapperKey + ':' + role + ':'") ||
      !contentSource.includes('hashText(normalizeMatchText(turnMessageText(turn)))')) {
    fail('long-chat identity: virtual data-turn-key wrappers must remain message-qualified; wrapper keys are recyclable');
  }
  const identityStart = contentSource.indexOf('function isStrongMessageId');
  const identityEnd = contentSource.indexOf('function recordNavigationWindow', identityStart);
  const identityBlock = identityStart >= 0 && identityEnd > identityStart
    ? contentSource.slice(identityStart, identityEnd)
    : '';
  const sameRefStart = contentSource.indexOf('function sameNavigationRef');
  const sameRefEnd = contentSource.indexOf('function sameNavigationText', sameRefStart);
  const sameRefBlock = sameRefStart >= 0 && sameRefEnd > sameRefStart
    ? contentSource.slice(sameRefStart, sameRefEnd)
    : '';
  if (!identityBlock ||
      !identityBlock.includes('isStrongMessageId') ||
      !identityBlock.includes('identityContextsCompatible') ||
      !identityBlock.includes('sameNavigationSequence') ||
      !identityBlock.includes('findContextualRefIndex') ||
      !sameRefBlock.includes('a.strongId && b.strongId') ||
      sameRefBlock.includes('a.signature') ||
      sameRefBlock.includes('externalSignature')) {
    fail('message identity: standalone text must never prove message identity; weak matches require sequence context');
  }
  if (!contentSource.includes('rebuildCaptureMap(map, order, capturedMessages)') ||
      !contentSource.includes('weakIdentityContextKey') ||
      !contentSource.includes('buildImageScanPool') ||
      contentSource.includes('const key = ref.id || ref.signature || ref.externalSignature')) {
    fail('message identity: weak-ID collisions must survive map rebuild and image recovery');
  }
  if (!contentSource.includes('existing.messages.map(messageStrongId).filter(Boolean)') ||
      contentSource.includes('existing.messages.map(item => item.id).filter(Boolean)')) {
    fail('continuation identity: cross-boundary duplicate filtering must use strong IDs only');
  }
  if (!contentSource.includes('contextBefore: boundaryContextBefore(turns, i)') ||
      !contentSource.includes('boundaryContextMatchesTurns') ||
      !contentSource.includes('messageBoundaryContextMatches')) {
    fail('snapshot boundary: text fallback must be disambiguated by neighbouring message context');
  }
  const visibleSignatureStart = contentSource.indexOf('function visibleTurnSignature');
  const visibleSignatureEnd = contentSource.indexOf('function scrollObservation', visibleSignatureStart);
  const visibleSignatureBlock = visibleSignatureStart >= 0 && visibleSignatureEnd > visibleSignatureStart
    ? contentSource.slice(visibleSignatureStart, visibleSignatureEnd)
    : '';
  if (!visibleSignatureBlock.includes("return keys.join('|')") ||
      visibleSignatureBlock.includes('slice(0, 3)') ||
      visibleSignatureBlock.includes('slice(-3)')) {
    fail('scroll settle: signature must cover the whole visible virtualized window');
  }

  if (/activeCaptureJob\s*:/.test(contentSource)) {
    fail('content-chatgpt.js: capture page must never overwrite worker-owned activeCaptureJob');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_CHECKPOINT_SAVED'")) {
    fail('service-worker.js: missing worker-owned checkpoint metadata handler');
  }
  if (!serviceWorkerSource.includes('collectorStarted = false') ||
      !serviceWorkerSource.includes('RUN_CANCELLED_RECOVERABLE') ||
      !serviceWorkerSource.includes('autoRecoveryPending: false') ||
      !serviceWorkerSource.includes('Best-effort notification after the worker state is already terminal')) {
    fail('capture lifecycle: missing immediate stop or clean launch-failure contract');
  }
  if (!contentSource.includes("'compare'") ||
      !contentSource.includes("type: 'ARCHIVER_CAPTURE_COMPLETE'")) {
    fail('content-chatgpt.js: missing legacy non-mutating compare mode');
  }
  if (!contentSource.includes("'reconcile'") ||
      !contentSource.includes('reconcileVerifiedCaptureWithArchive') ||
      !serviceWorkerSource.includes("case 'ARCHIVER_RECONCILE_CURRENT'")) {
    fail('capture runtime: missing verified reconcile-and-fill mode');
  }
  if (contentSource.includes("'manual-full'") ||
      serviceWorkerSource.includes("case 'ARCHIVER_CAPTURE_MANUAL_FULL'")) {
    fail('capture runtime: manual full-range mode must stay removed');
  }
  if (!contentSource.includes("closeSelection.textContent = 'Завершить разметку'") ||
      !contentSource.includes('strictStable: Boolean(selectedFragment.end.id)') ||
      !contentSource.includes('if (boundary.strictStable) return false')) {
    fail('fragment marking: explicit end marker must remain stable and marking exit must stay visible');
  }
  if (!contentSource.includes('resolveFragmentTurnFromTarget') ||
      !contentSource.includes("document.addEventListener('click'") ||
      !contentSource.includes("'archiver-fragment-overlay'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_TOGGLE_MARKING_CURRENT'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_OPEN_MARKING_TAB'") ||
      !serviceWorkerSource.includes('ensureBoundaryMarkingScript')) {
    fail('boundary marking: missing persistent click-selection/working-tab flow');
  }
  if (!contentSource.includes("'images-draft'") ||
      !contentSource.includes("current.captureMode === 'images-draft'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_HYDRATE_UNFINISHED_IMAGES'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_DRAFT_IMAGES_COMPLETE'")) {
    fail('capture runtime: missing transactional unfinished image reconciliation');
  }
  if (!contentSource.includes("phase: 'boundary'") ||
      !contentSource.includes('state.boundarySearchActive') ||
      !contentSource.includes('locateBoundaryForUpwardScan') ||
      !serviceWorkerSource.includes("['top', 'boundary'].includes(job.phase || '')")) {
    fail('capture runtime: lower-boundary search/manual-top/recovery contract is incomplete');
  }
  if (!serviceWorkerSource.includes('async function setJob(patch, { replace = false } = {})') ||
      (serviceWorkerSource.match(/\{ replace: true \}/g) || []).length < 3) {
    fail('service-worker.js: new capture jobs must replace stale active-job state');
  }
  if (!serviceWorkerSource.includes('unfinishedRangeKey(item) === range') ||
      !serviceWorkerSource.includes('pendingDocSource') ||
      !contentSource.includes("pendingDocUrl: current.pendingDocUrl || ''")) {
    fail('unfinished recovery: range and pending-document metadata are not preserved');
  }
  if (!serviceWorkerSource.includes('draftId: draft.id') ||
      !serviceWorkerSource.includes('const redundantIds = compatible') ||
      !contentSource.includes("current.draftId || existingDraftId || current.recoveryDraftId || ('draft-' + jobId)") ||
      !contentSource.includes('canonicalRecoveryDraft?.captureMode') ||
      !contentSource.includes('canonicalRecoveryDraft?.captureRange')) {
    fail('unfinished recovery: retries must update one canonical draft and preserve original capture identity');
  }
  if (!contentSource.includes('REASONING_STATUS_RE') ||
      !contentSource.includes('обработка заняла') ||
      !contentSource.includes('interstitialReasoningFragment') ||
      !contentSource.includes('reasoningStatusCandidates')) {
    fail('content-chatgpt.js: missing interstitial reasoning capture adapter');
  }
  if (!contentSource.includes('reconcileNavigationCoverage') ||
      !contentSource.includes('reconciledInsertedCount') ||
      !contentSource.includes('повторный полный проход автоматически не запускается')) {
    fail('content-chatgpt.js: missing non-destructive navigation reconciliation');
  }
  const fullCaptureStart = contentSource.indexOf("if (mode === 'full') {");
  const fullCaptureWindow = fullCaptureStart >= 0
    ? contentSource.slice(fullCaptureStart, fullCaptureStart + 12000)
    : '';
  if (!fullCaptureWindow ||
      !contentSource.includes('Historical 0.3.14/0.4.17 behavior') ||
      !contentSource.includes('await reachTopFullLegacy(map, order, settings);') ||
      !contentSource.includes('navigationHighWater = 0;') ||
      !contentSource.includes('navigationMessages = [];') ||
      !contentSource.includes('navigationSequence = [];') ||
      !contentSource.includes("if (mode === 'images' || mode === 'images-draft' || mode === 'reconcile' || mode === 'fragment')")) {
    fail('full capture: preserve 0.4.17 navigation-only upward pass and single canonical chronological save');
  }
  const fullTopStart = contentSource.indexOf('async function reachTopFullLegacy');
  const fullDownStart = contentSource.indexOf('async function walkDownFullLegacy', fullTopStart);
  const fullDownEnd = contentSource.indexOf('async function walkDown(', fullDownStart);
  const fullTopBlock = fullTopStart >= 0 && fullDownStart > fullTopStart
    ? contentSource.slice(fullTopStart, fullDownStart)
    : '';
  const fullDownBlock = fullDownStart >= 0 && fullDownEnd > fullDownStart
    ? contentSource.slice(fullDownStart, fullDownEnd)
    : '';
  if (!fullTopBlock ||
      !fullDownBlock ||
      !fullTopBlock.includes("await physicalScroll('up', 7") ||
      !fullTopBlock.includes("recoverVisibleLoadError('top'") ||
      !fullTopBlock.includes('scrollObservation(map.size)') ||
      !fullTopBlock.includes('updateStabilityState(stability, before, after)') ||
      !fullTopBlock.includes('stall.stable >= 4') ||
      fullTopBlock.includes('recordNavigationWindow(') ||
      !fullDownBlock.includes("await physicalScroll('down', 1") ||
      !fullDownBlock.includes("recoverVisibleLoadError('walk'") ||
      !fullDownBlock.includes('visibleNavigationRefsLightweight()') ||
      !fullDownBlock.includes('navigationWindowsOverlap(beforeRefs, afterRefs)') ||
      !fullDownBlock.includes('recoverDownwardContinuity(') ||
      !fullDownBlock.includes('scrollObservation(map.size)') ||
      !fullDownBlock.includes('updateStabilityState(stability, before, after)') ||
      !fullDownBlock.includes('stall.stable >= 4') ||
      fullDownBlock.includes('hydrateSequentialImages(') ||
      fullDownBlock.includes('firstPassCount')) {
    fail('full capture: keep fast upward navigation but require one-burst overlap-verified chronological movement');
  }

  const topOnlyStart = contentSource.indexOf('async function reachTopWithoutCapture');
  const topOnlyEnd = contentSource.indexOf('async function reachResumeAnchor', topOnlyStart);
  const topOnlyBlock = topOnlyStart >= 0 && topOnlyEnd > topOnlyStart
    ? contentSource.slice(topOnlyStart, topOnlyEnd)
    : '';
  if (!topOnlyBlock ||
      !topOnlyBlock.includes('createStabilityState()') ||
      !topOnlyBlock.includes('scrollObservation(existingCount)') ||
      !topOnlyBlock.includes('updateStabilityState(stability, before, after') ||
      !topOnlyBlock.includes('sameWindow(after, afterWait')) {
    fail('continuation navigation: top-only traversal must use the shared scroll observation/stall state');
  }

  const resumeAnchorStart = contentSource.indexOf('async function reachResumeAnchor');
  const resumeAnchorEnd = contentSource.indexOf('function visibleHasKnownSignatures', resumeAnchorStart);
  const resumeAnchorBlock = resumeAnchorStart >= 0 && resumeAnchorEnd > resumeAnchorStart
    ? contentSource.slice(resumeAnchorStart, resumeAnchorEnd)
    : '';
  if (!resumeAnchorBlock ||
      resumeAnchorBlock.includes('if (physicalScrollStartVisible() && i > 0)') ||
      !resumeAnchorBlock.includes('createStabilityState()') ||
      !resumeAnchorBlock.includes('updateStabilityState(upwardStability, before, after') ||
      !resumeAnchorBlock.includes('after.atStart') ||
      !resumeAnchorBlock.includes('allowDownwardFallback) break')) {
    fail('continuation anchor search: virtualized physical-start alone must not terminate the search');
  }

  const pauseResumeBlock = contentSource.slice(
    contentSource.indexOf("message.type === 'ARCHIVER_RESUME_CAPTURE'"),
    contentSource.indexOf("message.type === 'ARCHIVER_CANCEL_CAPTURE'")
  );
  if (pauseResumeBlock.includes('recoverPauseCheckpoint') ||
      !pauseResumeBlock.includes('state.paused = false')) {
    fail('pause/resume: resume must be immediate and must not launch hidden navigation');
  }
  if (!contentSource.includes('unknownSearchDirection') ||
      !contentSource.includes('frontierCrossed') ||
      !contentSource.includes('resumeSearchEdgeReversal')) {
    fail('unfinished resume: missing directional known/unknown frontier search');
  }
  if (contentSource.includes('coverageRetry') ||
      contentSource.includes('повторяю медленнее')) {
    fail('content-chatgpt.js: destructive automatic coverage retry must stay removed');
  }
  if (!contentSource.includes("mode === 'images'") ||
      !contentSource.includes('mergeRecoveredImagesIntoArchive') ||
      !contentSource.includes('lastRecoveredImageRefs')) {
    fail('content-chatgpt.js: missing image-only recovery mode');
  }
  if (!contentSource.includes('reasoningStatusLabelText') ||
      !contentSource.includes("text.startsWith(statusLabel)")) {
    fail('content-chatgpt.js: reasoning status stripping must not erase expanded reasoning');
  }
  if (!contentSource.includes('trimMessagesThroughBoundary') ||
      !contentSource.includes('captureBoundaryKey') ||
      !contentSource.includes("collect(map, order, settings, boundary)") ||
      !contentSource.includes('locateBoundaryForUpwardScan') ||
      !contentSource.includes('recordNavigationWindow(navigationWindows, settings, checkpointBoundary)') ||
      !contentSource.includes('fixedCaptureBoundary') ||
      !contentSource.includes('trimMessagesThroughBoundary(capturedMessages, boundary)') ||
      !contentSource.includes("['compare', 'images'].includes(mode)")) {
    fail('content-chatgpt.js: missing proven live-bottom snapshot boundary or bounded rich traversal');
  }
  if (!contentSource.includes('locateCapturedResumeAnchor') ||
      !contentSource.includes('hasStableResumeAnchor') ||
      !contentSource.includes("method: 'tail'") ||
      !contentSource.includes('Repeated text is valid') &&
        !contentSource.includes('Repeated text is valid new content') ||
      !contentSource.includes('retry-walk starts again from the real top')) {
    fail('continuation: resume anchor must be re-verified and repeated text must not be deduplicated');
  }
  if (!serviceWorkerSource.includes("['continue', 'compare'].includes(mode)") ||
      !serviceWorkerSource.includes('buildResumeTailSignatures(existingArchive.messages, 4)')) {
    fail('continuation: worker must supply a multi-turn saved tail when available');
  }
  if (!contentSource.includes("'resume-draft'") ||
      !contentSource.includes('allowDownwardFallback') ||
      !contentSource.includes('existingDraftId')) {
    fail('content-chatgpt.js: missing failed-capture draft recovery mode');
  }
  if (!serviceWorkerSource.includes('resumeFailedCaptureFromWorkingTab') ||
      !serviceWorkerSource.includes('ARCHIVER_RESUME_FAILED_CAPTURE') ||
      !serviceWorkerSource.includes('ARCHIVER_DELETE_UNFINISHED_PASS') ||
      !serviceWorkerSource.includes('ARCHIVER_DELETE_ARCHIVE')) {
    fail('service-worker.js: missing recovery/deletion commands');
  }
  if (!serviceWorkerSource.includes('inspectGoogleDocTabsAttached') ||
      !serviceWorkerSource.includes('expectedBeforeCount') ||
      !serviceWorkerSource.includes('verifyGoogleDocTabCount') ||
      !serviceWorkerSource.includes('verifiedTabCount !== expectedCount')) {
    fail('service-worker.js: missing physical Google Docs tab-count verification');
  }
  if (!serviceWorkerSource.includes('patchRecoveredImagesToLinkedDoc') ||
      !serviceWorkerSource.includes('DOC_IMAGE_PATCHES_KEY')) {
    fail('service-worker.js: missing recovered-image patch machinery');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_OPEN_LINKED_DOC'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_EXPORT_LINKED_DOC'") ||
      !serviceWorkerSource.includes('inspectGoogleDocAvailability') ||
      !serviceWorkerSource.includes('clearLinkedDocumentState') ||
      !serviceWorkerSource.includes('clearLinkedDoc')) {
    fail('linked Google Docs: missing validated open/append or stale-link invalidation');
  }
  const imageRecoveryBlock = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf("if (message.mode === 'images')"),
    serviceWorkerSource.indexOf('let docResult = null;')
  );
  if (imageRecoveryBlock.includes('patchRecoveredImagesToLinkedDoc') ||
      !imageRecoveryBlock.includes('документ Google Docs не изменялся')) {
    fail('image recovery: binary recovery must stay local and must not auto-modify Google Docs');
  }
  const linkedExportBlock = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('async function exportConversationToLinkedDoc'),
    serviceWorkerSource.indexOf('async function exportConversation({')
  );
  if (!linkedExportBlock.includes('appendMessagesToGoogleDocUrl') ||
      !linkedExportBlock.includes('patchRecoveredImagesToLinkedDoc') ||
      !linkedExportBlock.includes('recoveredImagePatchCandidateCount')) {
    fail('manual linked-doc export: one user action must append text delta and separately paste recovered images');
  }
  if (!serviceWorkerSource.includes("type: 'ARCHIVER_PING'") ||
      !serviceWorkerSource.includes('ping.version !== expectedVersion') ||
      !contentSource.includes("message.type === 'ARCHIVER_PING'")) {
    fail('capture runtime: missing content-script version handshake');
  }
  if (!serviceWorkerSource.includes('function withTimeout(') ||
      !serviceWorkerSource.includes("'Запись изображения в буфер обмена'") ||
      !serviceWorkerSource.includes("'Команда Google Docs ('")) {
    fail('Google Docs export: debugger/clipboard operations must be bounded by timeouts');
  }
  const offscreenSource = await readFile('offscreen.js', 'utf8');
  if (!offscreenSource.includes('function withTimeout(') ||
      !offscreenSource.includes("'Декодирование изображения для Google Docs'")) {
    fail('offscreen image export: image decode must have a hard timeout');
  }
  console.log('OK: service-worker runtime helper declarations and reasoning adapter');
} catch (error) {
  fail(`service-worker.js runtime helper guard failed: ${error.message}`);
}

try {
  const popupHtml = await readFile('popup.html', 'utf8');
  const updaterVbs = await readFile('Update ChatGPT Archiver.vbs', 'utf8');
  if (!popupHtml.includes('id="updateExtension"') ||
      !popupHtml.includes('href="updater.html"') ||
      !popupHtml.includes('target="_blank"') ||
      popupHtml.includes('chatgpt-archiver:update')) {
    fail('popup.html: updater must use a direct new-tab link to updater.html');
  }
  if (!popupHtml.includes('id="reloadExtension"')) {
    fail('popup.html: missing extension reload action');
  }
  for (const id of ['openMarkingTab', 'clearMarkers', 'reconcileArchive']) {
    if (!popupHtml.includes('id="' + id + '"')) {
      fail('popup.html: missing capture-recovery control ' + id);
    }
  }
  const updaterHtml = await readFile('updater.html', 'utf8');
  const updaterJs = await readFile('updater.js', 'utf8');
  if (!updaterHtml.includes('id="runUpdate"') || !updaterHtml.includes('id="log"')) {
    fail('updater.html: missing update controls or live log');
  }
  if (!updaterJs.includes('showDirectoryPicker') ||
      !updaterJs.includes("const REPO='Naeirae/ChatGPT-Conversation-Archiver'") ||
      !updaterJs.includes('api.github.com/repos/') ||
      !updaterJs.includes('/commits/') ||
      !updaterJs.includes('/git/trees/') ||
      !updaterJs.includes('/git/blobs/') ||
      !updaterJs.includes("a.path==='manifest.json'")) {
    fail('updater.js: missing commit-pinned GitHub API update flow');
  }
  if (/powershell\.exe|shell\.Run|RegWrite/i.test(updaterVbs)) {
    fail('Update ChatGPT Archiver.vbs: legacy executable/protocol behavior must stay removed');
  }
  console.log('OK: in-browser updater integration');
} catch (error) {
  fail(`Updater UI/protocol guard failed: ${error.message}`);
}

try {
  const popupHtml = await readFile('popup.html', 'utf8');
  const popupJs = await readFile('popup.js', 'utf8');
  const popupCss = await readFile('popup.css', 'utf8');
  const serviceWorkerSource = await readFile('service-worker.js', 'utf8');
  const requiredUiIds = [
    'status',
    'interfaceSettings',
    'interfacePalette',
    'interfaceFontPreset',
    'interfaceAccent',
    'interfaceBackground',
    'interfacePanel',
    'interfaceText',
    'settingsSaved'
  ];
  for (const id of requiredUiIds) {
    if (!popupHtml.includes('id="' + id + '"')) {
      fail('popup.html: missing UI control ' + id);
    }
  }
  if (!popupHtml.includes('settings-menu') ||
      !popupHtml.includes('id="savedArchivesList"') ||
      !popupHtml.includes('id="unfinishedPassesList"') ||
      popupHtml.includes('id="viewDraft"') ||
      popupHtml.includes('id="includeReasoning"') ||
      popupHtml.includes('\\n\\n    <section')) {
    fail('popup.html: compact settings/archive/unfinished-capture structure regression');
  }
    if (!popupHtml.includes('id="continue"') ||
      !popupHtml.includes('id="savedArchivesList"') ||
      !popupHtml.includes('id="captureInfoToggle"') ||
      !popupHtml.includes('id="updateNotice"') ||
      !popupHtml.includes('id="showTour"') ||
      !popupHtml.includes('id="copyContact"') ||
      !popupHtml.includes('id="archiveDocStatus"') ||
      !popupHtml.includes('id="localVersion"') ||
      !popupHtml.includes('href="help.html"')) {
    fail('popup.html: compact capture/archive/help/update controls are incomplete');
  }
  if (!popupJs.includes('function applyInterfaceAppearance') ||
      !popupJs.includes('function normalizeInterfaceAppearance')) {
    fail('popup.js: missing interface appearance layer');
  }
  if (!popupJs.includes('ARCHIVER_OPEN_LINKED_DOC') ||
      !popupJs.includes('ARCHIVER_EXPORT_LINKED_DOC') ||
      popupJs.includes("$('patchRecoveredImages').onclick")) {
    fail('popup.js: linked Doc export must be one manual action without a separate image-patch button');
  }
  if (!popupJs.includes("type: 'ARCHIVER_CAPTURE_CURRENT'") ||
      popupJs.includes('ARCHIVER_CAPTURE_MANUAL_FULL') ||
      popupHtml.includes('id="captureManualFull"') ||
      !popupJs.includes('ARCHIVER_CLEAR_MARKERS_CURRENT') ||
      !popupHtml.includes('id="clearMarkers"') ||
      !serviceWorkerSource.includes('captureRange,')) {
    fail('fragment range UX: fragment markers must never hijack the primary full-capture button');
  }
  if (!popupJs.includes('ARCHIVER_TOGGLE_MARKING_CURRENT') ||
      !popupJs.includes('ARCHIVER_CLEAR_MARKERS_CURRENT') ||
      !popupJs.includes('ARCHIVER_OPEN_MARKING_TAB') ||
      !popupJs.includes('ARCHIVER_RECONCILE_CURRENT') ||
      !popupJs.includes('ARCHIVER_RECONCILE_SAVED_ARCHIVE')) {
    fail('popup.js: fragment-range and unified reconcile controls are not wired');
  }
  const disclosureCount = (popupHtml.match(/<details\b/g) || []).length;
  if (popupHtml.includes('id="recoverImages"') ||
      popupJs.includes("imagesButton.textContent = 'Сверить изображения'") ||
      !popupHtml.includes('id="reconcileArchive">Сверить</button>') ||
      !popupHtml.includes('id="savedArchivesPanel" class="workspace-section archives-panel"') ||
      !popupHtml.includes('id="archive" class="current-archive hidden"') ||
      disclosureCount > 3 ||
      !popupCss.includes('.inline-progress::before') ||
      !popupCss.includes('.status.busy::before') ||
      !popupCss.includes('.library-scroll')) {
    fail('archive UX: keep one sync action, flat archive/library sections, <=3 disclosures and visible progress');
  }
  if (popupJs.includes("$('reconcileArchive').disabled = Boolean(running || !archive || !state.canContinue)") ||
      !popupJs.includes("type: 'ARCHIVER_RECONCILE_SAVED_ARCHIVE',\n      archiveId: state.archive.id")) {
    fail('current archive sync must work from Google Docs/other tabs by reopening the archive source URL');
  }
  if (!popupJs.includes("passId: item.exportPassId") ||
      !popupJs.includes("job?.captureMode === 'images-draft'") ||
      !popupJs.includes("!job?.boundarySearchActive")) {
    fail('popup.js: unfinished image/boundary-search UI contract regressed');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_RECONCILE_SAVED_ARCHIVE'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_RECOVER_IMAGES_SAVED_ARCHIVE'")) {
    fail('service-worker.js: unified saved-archive reconcile and legacy image recovery routes are missing');
  }
  const offscreenSource = await readFile('offscreen.js', 'utf8');
  const contentSource = await readFile('content-chatgpt.js', 'utf8');
  const manifestSource = await readFile('manifest.json', 'utf8');
  if (!contentSource.includes("mode === 'reconcile'") ||
      !contentSource.includes('recoveredImageRefs.push({') ||
      !contentSource.includes("(mode === 'images' || mode === 'reconcile') && unresolvedBeforeHydration.length")) {
    fail('unified reconcile: one pass must reconcile text and recover/hydrate images');
  }
  if (!contentSource.includes('map.set(messageId, mergeRicherCapture(message, existing))') ||
      !contentSource.includes('map.set(id, mergeRicherCapture(message, map.get(id)))')) {
    fail('image capture: virtualized recapture must preserve richer prepared image binaries across collision-aware IDs');
  }
  if (!offscreenSource.includes('async function writeImageWithExecCommand') ||
      !offscreenSource.includes("message?.type === 'ARCHIVER_OFFSCREEN_WRITE_IMAGE'") ||
      !serviceWorkerSource.includes("type: 'ARCHIVER_OFFSCREEN_WRITE_IMAGE'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_FETCH_IMAGE_BINARY'") ||
      !serviceWorkerSource.includes('async function fetchImageBinaryForContent') ||
      !serviceWorkerSource.includes("case 'ARCHIVER_CAPTURE_RENDERED_IMAGE'") ||
      !serviceWorkerSource.includes('async function captureRenderedImageForContent') ||
      !contentSource.includes("type: 'ARCHIVER_FETCH_IMAGE_BINARY'") ||
      !contentSource.includes("type: 'ARCHIVER_CAPTURE_RENDERED_IMAGE'") ||
      !contentSource.includes('async function captureRenderedImageBlob') ||
      !manifestSource.includes('https://*.oaiusercontent.com/*')) {
    fail('Google Docs images: hydration and rendered-image recovery chain must remain wired');
  }

  const docsPasteStart = serviceWorkerSource.indexOf('async function pasteArchiveIntoGoogleDoc');
  const docsPasteEnd = serviceWorkerSource.indexOf('function normalizeDocSearchText', docsPasteStart);
  const docsPasteBlock = docsPasteStart >= 0 && docsPasteEnd > docsPasteStart
    ? serviceWorkerSource.slice(docsPasteStart, docsPasteEnd)
    : '';
  if (!docsPasteBlock ||
      !docsPasteBlock.includes('Restore the pre-34f7bcb path that was observed to work in Google Docs') ||
      !docsPasteBlock.includes("stripImages: false") ||
      !docsPasteBlock.includes("preferOriginalImageSrc: true") ||
      !docsPasteBlock.includes('await pasteBinaryImages(message)') ||
      docsPasteBlock.includes('binaryReadyCount')) {
    fail('Google Docs export: preserve 0.4.19 ordered rich-HTML primary path and keep binary insertion fallback-only');
  }

  const unfinishedExportStart = serviceWorkerSource.indexOf('async function exportUnfinishedPassToNewDoc');
  const unfinishedExportEnd = serviceWorkerSource.indexOf('async function resumeUnfinishedInSavedTab', unfinishedExportStart);
  const unfinishedExportBlock = unfinishedExportStart >= 0 && unfinishedExportEnd > unfinishedExportStart
    ? serviceWorkerSource.slice(unfinishedExportStart, unfinishedExportEnd)
    : '';
  if (!unfinishedExportBlock ||
      unfinishedExportBlock.includes('ARCHIVER_HYDRATE_DRAFT_IMAGES') ||
      unfinishedExportBlock.includes('resolveDraftRecoveryTab(') ||
      !unfinishedExportBlock.includes('syncPartialArchiveFromDraft(draft, { enable: false })') ||
      !unfinishedExportBlock.includes('exportConversation({')) {
    fail('unfinished Google Docs export: preserve pre-86c0b4fe direct snapshot export without blocking live-tab hydration');
  }

  const physicalScrollStart = serviceWorkerSource.indexOf("async function physicalScrollTab(tabId, direction = 'down', bursts = 7)");
  const physicalScrollEnd = serviceWorkerSource.indexOf('async function withChatDebugger', physicalScrollStart);
  const physicalScrollBlock = physicalScrollStart >= 0 && physicalScrollEnd > physicalScrollStart
    ? serviceWorkerSource.slice(physicalScrollStart, physicalScrollEnd)
    : '';
  if (!physicalScrollBlock ||
      !physicalScrollBlock.includes('chrome.debugger.sendCommand({ tabId }, method, params)') ||
      !physicalScrollBlock.includes("deltaY: sign * 860") ||
      !physicalScrollBlock.includes("await sleep(70)") ||
      physicalScrollBlock.includes('timedOut') ||
      physicalScrollBlock.includes('}, 3000)')) {
    fail('full capture: preserve the pre-timeout 0.4.17 debugger-wheel transport without silent partial bursts');
  }


  if (!serviceWorkerSource.includes('async function compactCompatibleDrafts') ||
      !serviceWorkerSource.includes('const passCounts = counts(passMessages)') ||
      !serviceWorkerSource.includes('onlyInUnfinishedPassCount += Math.max(0, passCount - archiveCount)')) {
    fail('unfinished drafts: compatible chains must compact and comparison counts must preserve duplicate occurrences');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_REPLACE_LINKED_DOC'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_CLEAR_LINKED_DOC'") ||
      !serviceWorkerSource.includes('async function replaceLinkedGoogleDoc') ||
      !popupJs.includes("type: 'ARCHIVER_REPLACE_LINKED_DOC'") ||
      !popupJs.includes("type: 'ARCHIVER_CLEAR_LINKED_DOC'") ||
      !popupHtml.includes('id="editCurrentDoc"') ||
      !popupHtml.includes('id="currentDocEditor"')) {
    fail('linked Google Docs: missing explicit replace/unlink UX on the current archive card');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_SELECT_SAVED_ARCHIVE'") ||
      !popupJs.includes("type: 'ARCHIVER_SELECT_SAVED_ARCHIVE'") ||
      !popupJs.includes("type: 'ARCHIVER_CONTINUE_SAVED_ARCHIVE'") ||
      !popupJs.includes("continueSaved.textContent = 'Продолжить'") ||
      popupJs.includes("moreActions.className = 'archive-link-tools'") ||
      popupJs.includes("secondaryActions.className = 'archive-link-secondary'") ||
      !popupJs.includes("openArchive.textContent = 'Открыть'") ||
      !popupJs.includes("saveToDoc.textContent = docUrl ? 'Обновить Google Doc' : 'В Google Doc'") ||
      !popupJs.includes("docUrl ? 'ARCHIVER_EXPORT_LINKED_DOC' : 'ARCHIVER_EXPORT_NEW_DOC'")) {
    fail('saved-chat UX: library rows must stay simple, selectable, and keep a direct Google Docs action');
  }
  if (serviceWorkerSource.includes('Пользователь / ${settings.userName}') ||
      serviceWorkerSource.includes('ChatGPT / ${settings.assistantName}') ||
      !serviceWorkerSource.includes("return settings.userName ? \`${settings.userName}:\` : 'Пользователь:'") ||
      !serviceWorkerSource.includes("return settings.assistantName ? \`${settings.assistantName}:\` : 'ChatGPT:'")) {
    fail('speaker labels: custom names must replace the default role label, not be appended to it');
  }
  const archiveStoreSource = await readFile('lib/archive-store.mjs', 'utf8');
  if (!archiveStoreSource.includes("archiveLibrary: 'archiveLibrary'") ||
      !archiveStoreSource.includes('async function registerArchive(conversation)') ||
      !serviceWorkerSource.includes('exactDocExportForArchive') ||
      !serviceWorkerSource.includes('docExportCoversArchive') ||
      !serviceWorkerSource.includes('validatedArchiveDestination') ||
      !serviceWorkerSource.includes('linkedDocUrl: linked?.url') ||
      !serviceWorkerSource.includes('await registerArchive(libraryArchive)')) {
    fail('saved archive library: completed captures must be registered independently of linked Google Docs and stale Doc exports must not label a newer snapshot as saved');
  }
  if (!serviceWorkerSource.includes("case 'ARCHIVER_DELETE_ARCHIVE_WITH_DOC'") ||
      !serviceWorkerSource.includes('async function moveGoogleDocToTrash') ||
      !serviceWorkerSource.includes('async function deleteArchiveWithGoogleDoc') ||
      !popupHtml.includes('id="deleteArchiveAndDoc"') ||
      !popupJs.includes("type: 'ARCHIVER_DELETE_ARCHIVE_WITH_DOC'")) {
    fail('archive deletion: explicit local-plus-Google-Doc trash action must remain separate from local-only deletion');
  }
  if (!popupJs.includes('state.archiveDestination || null') ||
      !popupJs.includes("destinationText.textContent = 'Только локально'") ||
      !popupJs.includes("openArchive.textContent = 'Открыть'") ||
      !popupHtml.includes('id="newDoc">Новый Google Doc</button>') ||
      popupJs.includes("$('archiveStateLabel').textContent = linkedUrl ? 'Сохранён в документ Google Docs'")) {
    fail('saved archive UI: local completion and conversation-level linked Docs must stay separate');
  }
  const iconSizes = new Map([
    ['icons/icon-16.png', 16],
    ['icons/icon-24.png', 24],
    ['icons/icon-32.png', 32],
    ['icons/icon-48.png', 48],
    ['icons/icon-64.png', 64],
    ['icons/icon-128.png', 128]
  ]);
  for (const [icon, expectedSize] of iconSizes) {
    await access(icon);
    const bytes = await readFile(icon);
    const pngSignature = [137,80,78,71,13,10,26,10];
    if (bytes.length < 24 || !pngSignature.every((value, index) => bytes[index] === value)) {
      fail(icon + ': invalid PNG signature');
      continue;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== expectedSize || height !== expectedSize) {
      fail(icon + ': expected ' + expectedSize + 'x' + expectedSize + ', got ' + width + 'x' + height);
    }
  }
  console.log('OK: popup structure, appearance controls and PNG icon dimensions');
} catch (error) {
  fail(`Popup appearance guard failed: ${error.message}`);
}

try {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const chatScripts = manifest.content_scripts?.find(item =>
    (item.matches || []).some(match => String(match).includes('chatgpt.com'))
  )?.js || [];
  if (chatScripts[0] !== 'content-chatgpt-scroll.js' || chatScripts[1] !== 'content-chatgpt.js') {
    fail('manifest.json: shared scroll runtime must load immediately before content-chatgpt.js');
  }
  if (manifest.manifest_version !== 3) {
    fail('manifest.json: manifest_version must be 3');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) {
    fail('manifest.json: version must use x.y.z');
  }
  if (!Array.isArray(manifest.permissions)) {
    fail('manifest.json: permissions must be an array');
  }
  const requiredHosts = [
    'https://api.github.com/*',
    'https://raw.githubusercontent.com/*'
  ];
  for (const host of requiredHosts) {
    if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes(host)) {
      fail('manifest.json: missing updater host permission ' + host);
    }
  }
  console.log('OK: manifest.json', manifest.version);
} catch (error) {
  fail(`manifest.json: ${error.message}`);
}

try {
  const packageSource = await readFile('scripts/package.mjs', 'utf8');
  for (const requiredFile of ['updater.html', 'updater.css', 'updater.js', 'help.html', 'help.css']) {
    if (!packageSource.includes("'" + requiredFile + "'")) {
      fail('scripts/package.mjs: missing packaged updater file ' + requiredFile);
    }
  }
  console.log('OK: packaged updater files declared');
} catch (error) {
  fail('scripts/package.mjs updater guard failed: ' + error.message);
}

for (const path of forbiddenArtifacts) {
  try {
    await access(path);
    fail(`${path}: local runtime artifact must not be committed`);
  } catch (error) {
    if (error?.code !== 'ENOENT') fail(`${path}: ${error.message}`);
  }
}

const tests = spawnSync(process.execPath, [
  '--test',
  'tests/text.test.mjs',
  'tests/urls.test.mjs',
  'tests/archive-store.test.mjs',
  'tests/google-docs-baseline.test.mjs',
  'tests/tab-plan.test.mjs',
  'tests/document-parts.test.mjs'
], {
  encoding: 'utf8'
});
if (tests.status !== 0) {
  fail(`Regression tests failed\n${tests.stderr || tests.stdout}`);
} else {
  console.log(tests.stdout.trim());
}

if (failed) process.exit(1);
console.log('Repository verification passed.');
