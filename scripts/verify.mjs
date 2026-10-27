import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const jsFiles = [
  'service-worker.js',
  'content-chatgpt.js',
  'popup.js',
  'updater.js',
  'planner.js',
  'unfinished.js',
  'offscreen.js',
  'lib/text.mjs',
  'lib/urls.mjs',
  'lib/draft-overlap.mjs',
  'lib/capture-evidence.mjs',
  'lib/capture-viewport.mjs',
  'lib/capture-recovery.mjs',
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
  const contentSource = await readFile('content-chatgpt.js', 'utf8');
  if (!contentSource.includes('function createInlineScrollRuntime()') ||
      !contentSource.includes('function findVisibleLoadRetry()') ||
      !contentSource.includes('function waitForTurnSettle(') ||
      !contentSource.includes("transport: 'cdp-wheel'") ||
      !contentSource.includes("type: 'ARCHIVER_PHYSICAL_SCROLL'")) {
    fail('scroll transport: forensic candidate must use debugger/CDP wheel as the primary physical transport');
  }
  if (!contentSource.includes('const INLINE_SCROLL_RUNTIME = createInlineScrollRuntime()') ||
      !contentSource.includes('function scrollRuntime()') ||
      !contentSource.includes('return INLINE_SCROLL_RUNTIME;')) {
    fail('scroll transport: content script must use its inline runtime and must not require a separate runtime file');
  }
  // The end marker may be DOM-mounted offscreen, and after a scroll
  // continuity must be checked before accepting its arrival.
  if (!contentSource.includes('matchesBoundary(turn, stopBoundary) &&\n          turnIntersectsCaptureViewport(turn)')) {
    fail('capture: do not trim at an offscreen DOM-mounted end marker');
  }
  for (const [startToken, endToken] of [
    ['async function walkDownFullLegacy(', 'async function walkDown('],
    ['async function walkDown(', 'async function captureConversation(']
  ]) {
    const start = contentSource.indexOf(startToken);
    const end = contentSource.indexOf(endToken, start + startToken.length);
    const body = start >= 0 && end > start ? contentSource.slice(start, end) : '';
    const scroll = body.indexOf("await physicalScroll('down',");
    const continuity = body.indexOf('!navigationWindowsOverlap(beforeRefs, afterRefs)', scroll);
    const postScrollBoundary = body.indexOf('if (boundaryIsVisible(boundary))', scroll);
    if (scroll < 0 || continuity < scroll || postScrollBoundary < continuity) {
      fail('traversal: check continuity before accepting a newly arrived end marker');
    }
  }

  const visibleRefsStart = contentSource.indexOf('function visibleNavigationRefsLightweight()');
  const visibleRefsEnd = contentSource.indexOf('function navigationWindowsOverlap(', visibleRefsStart);
  if (visibleRefsStart < 0 || visibleRefsEnd < 0 ||
      !contentSource.slice(visibleRefsStart, visibleRefsEnd).includes('.filter(turn => turnIntersectsCaptureViewport(turn))')) {
    fail('traversal: offscreen mounted messages must not count as window overlap');
  }

  // Both metric and fallback transports must pick the visible chat window,
  // then measure the fallback result afresh rather than reusing stale metrics.
  const transportStart = serviceWorkerSource.indexOf('async function chatScrollMetrics(');
  const transportEnd = serviceWorkerSource.indexOf('async function withChatDebugger(', transportStart);
  const transportSource = serviceWorkerSource.slice(transportStart, transportEnd);
  if (transportStart < 0 || transportEnd < 0 ||
      (transportSource.match(/r.bottom > 0 && r.top < innerHeight/g) || []).length < 2 ||
      !transportSource.includes('const fallbackMetrics = await chatScrollMetrics(tabId, direction)') ||
      !transportSource.includes('fallbackMetrics?.atEnd')) {
    fail('scroll transport: physical viewport anchors and post-fallback edge verification required');
  }

  // Never silently skip the overlap check when virtualized DOM exposes no
  // physically visible navigable turns before or after scrolling.
  if ((contentSource.match(/!beforeRefs\\.length \\|\\| !afterRefs\\.length \\|\\|/g) || []).length !== 2) {
    fail('traversal: missing/empty viewport evidence must not bypass continuity recovery');
  }

  // Physical marker arrival must be distinguishable from DOM presence.
  // A large or virtualized chat may keep the marked end mounted off screen.
  const viewportModule = await readFile('lib/capture-viewport.mjs', 'utf8');
  const recoveryModule = await readFile('lib/capture-recovery.mjs', 'utf8');
  const visibleBoundaryStart = contentSource.indexOf('function boundaryIsVisible(');
  const visibleBoundaryEnd = contentSource.indexOf('function findScrollContainer()', visibleBoundaryStart);
  const visibleBoundaryBlock = contentSource.slice(visibleBoundaryStart, visibleBoundaryEnd);
  const endMatchStart = contentSource.indexOf('function matchesBoundary(');
  const endMatchEnd = contentSource.indexOf('function physicalScrollEndVisible()', endMatchStart);
  const endMatchBlock = contentSource.slice(endMatchStart, endMatchEnd);
  if (!viewportModule.includes('export function rectIntersectsCaptureViewport(') ||
      !recoveryModule.includes('export function buildRejectedCaptureDraft(') ||
      !contentSource.includes('function turnIntersectsCaptureViewport(turn)') ||
      !visibleBoundaryBlock.includes('turnIntersectsCaptureViewport(turn)') ||
      !endMatchBlock.includes('isStrongMessageId(boundary.key)') ||
      !contentSource.includes('anchor && turnIntersectsCaptureViewport(turn) &&') ||
      !serviceWorkerSource.includes('buildRejectedCaptureDraft(archive, job, reason)') ||
      !serviceWorkerSource.includes("STORAGE_KEYS.draftPrefix + rejected.id") ||
      !serviceWorkerSource.includes('return {\n          ok: verified,') ||
      !contentSource.includes("finalizationStep: 'write-archive'") ||
      !contentSource.includes("finalizationStep: 'confirm-complete'") ||
      !contentSource.includes("completion.status !== 'done'") ||
      contentSource.includes("lastArchiveId: archiveId")) {
    fail('0.4.65: marked boundaries must physically enter viewport; rejected capture remains a visible draft; finalization must require worker ACK');
  }

  const retryStart = contentSource.indexOf('async function recoverVisibleLoadError');
  const retryEnd = contentSource.indexOf('async function getSettings', retryStart);
  const retryBlock = retryStart >= 0 && retryEnd > retryStart
    ? contentSource.slice(retryStart, retryEnd)
    : '';
  if (!retryBlock ||
      !retryBlock.includes('physicalClickElement(retry)') ||
      !retryBlock.includes('attempt <= 2') ||
      !retryBlock.includes('ChatGPT дважды не смог догрузить этот участок') ||
      retryBlock.includes("physicalScroll(direction, 2")) {
    fail('load-error recovery: verified Retry must be clicked and persistent failures must abort instead of looping');
  }

  if (!contentSource.includes("transport: 'cdp-wheel'") ||
      !serviceWorkerSource.includes("type: 'mouseWheel'") ||
      !serviceWorkerSource.includes("deltaY: sign * 860")) {
    fail('scroll transport: debugger wheel must remain the primary traversal transport in this forensic candidate');
  }

  // Completion is boundary evidence, not a minimum message count. Seven
  // genuinely complete messages are valid; seven frozen virtualized turns
  // without confirmed start/end must not be marked as a full archive.
  const proofSource = await readFile('lib/capture-evidence.mjs', 'utf8');
  if (!proofSource.includes('export function fullTopEvidence(') ||
      !proofSource.includes('export function completedBoundedPass(') ||
      !contentSource.includes('async function reachSnapshotEndWithoutCapture(') ||
      !contentSource.includes('verifiedSnapshotEnd = await reachSnapshotEndWithoutCapture()') ||
      !contentSource.includes('verifiedFullStart = await reachTopWithoutCapture(') ||
      !contentSource.includes('verifiedMarkedStart = true') ||
      !contentSource.includes('captureProof: (mode === \'full\' || mode === \'fragment\')') ||
      !contentSource.includes('if (!observedUpwardTravel)') ||
      !contentSource.includes("kind: isStrongMessageId(selectedFragment.end.id) ? 'stable' : 'signature'") ||
      !serviceWorkerSource.includes('const top = message.mode === \'full\' ? fullTopEvidence(') ||
      !serviceWorkerSource.includes('const accepted = completedBoundedPass(') ||
      !serviceWorkerSource.includes('ok: fallbackMoved || fallbackAtEdge') ||
      !serviceWorkerSource.includes('moved,') ||
      !serviceWorkerSource.includes('await putArchive({ ...archive, partial: true, complete: false })')) {
    fail('capture completeness: require a verified snapshot end and proven start; never treat a frozen viewport as a completed chat');
  }

  const debuggerTopStart = contentSource.indexOf('async function reachTopWithoutCapture');
  const debuggerTopEnd = contentSource.indexOf('async function reachResumeAnchor', debuggerTopStart);
  const debuggerTopBlock = debuggerTopStart >= 0 && debuggerTopEnd > debuggerTopStart
    ? contentSource.slice(debuggerTopStart, debuggerTopEnd)
    : '';
  if (!debuggerTopBlock ||
      !debuggerTopBlock.includes("await physicalScroll(") ||
      !debuggerTopBlock.includes("'up',") ||
      !debuggerTopBlock.includes('16,') ||
      !debuggerTopBlock.includes('settleTimeout: 5000') ||
      !debuggerTopBlock.includes('quietWindow: 550') ||
      !debuggerTopBlock.includes('confirmedIdle >= 5') ||
      debuggerTopBlock.includes('physicalScrollStartVisible() &&')) {
    fail('full top navigation: preserve 0.3.87 navigation-only debugger ascent without the 0.3.98 physical-top heuristic');
  }
  if (!contentSource.includes('function elementLogicalRoles') ||
      !contentSource.includes('function unambiguousTurnContainer') ||
      !contentSource.includes('Ambiguous outer shells may contain both a user and assistant message') ||
      !contentSource.includes('getRoleNodes().forEach(node => add(getTurn(node)))')) {
    fail('turn discovery: ambiguous/mixed ChatGPT DOM shells must not collapse multiple logical messages');
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
      !contentSource.includes('strictStable: isStrongMessageId(selectedFragment.end.id)') ||
      !contentSource.includes('if (boundary.strictStable) return false')) {
    fail('fragment marking: explicit end marker must remain stable and marking exit must stay visible');
  }
  if (!contentSource.includes('resolveFragmentTurnFromTarget') ||
      !contentSource.includes("document.addEventListener('click'") ||
      !contentSource.includes("'archiver-fragment-overlay'") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_TOGGLE_MARKING_CURRENT'") ||
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
  if (!serviceWorkerSource.includes('sameDraftCaptureScope(draft, item)') ||
      !serviceWorkerSource.includes('captureRange: draft.captureRange || frontier.captureRange || null') ||
      !serviceWorkerSource.includes('pendingDocSource') ||
      !contentSource.includes("pendingDocUrl: current.pendingDocUrl || ''")) {
    fail('unfinished recovery: verified draft identity, manual range and pending-document metadata are not preserved');
  }
  if (!serviceWorkerSource.includes('draftId: draft.id') ||
      !serviceWorkerSource.includes('verifiedMergedFromDraftIds: originalIds') ||
      !serviceWorkerSource.includes("const mergeId = 'verified-merge:'") ||
      !serviceWorkerSource.includes('await chrome.storage.local.set({ [STORAGE_KEYS.draftPrefix + mergeId]: updated })') ||
      !contentSource.includes("current.draftId || existingDraftId || current.recoveryDraftId || ('draft-' + jobId)") ||
      !contentSource.includes('canonicalRecoveryDraft?.captureMode') ||
      !contentSource.includes('canonicalRecoveryDraft?.captureRange')) {
    fail('unfinished recovery: retries must use a separate provenance-tracked merged draft and preserve original capture identity');
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
      !fullCaptureWindow.includes('await reachTopWithoutCapture(0') ||
      !fullCaptureWindow.includes('fullCapture: true') ||
      contentSource.includes('async function reachTopFullLegacy') ||
      !contentSource.includes('navigationHighWater = 0;') ||
      !contentSource.includes('navigationMessages = [];') ||
      !contentSource.includes('navigationSequence = [];')) {
    fail('legacy full capture: upward travel must remain navigation-only when that technical mode is used');
  }

  const manualRangeStart = contentSource.indexOf("} else if (mode === 'fragment') {");
  const manualRangeEnd = contentSource.indexOf("} else {", manualRangeStart + 10);
  const manualRangeBlock = manualRangeStart >= 0 && manualRangeEnd > manualRangeStart
    ? contentSource.slice(manualRangeStart, manualRangeEnd)
    : '';
  if (!manualRangeBlock ||
      !manualRangeBlock.includes('const visibleStart = orderedTurns().find') ||
      !manualRangeBlock.includes('markerIdentityMatches(selectedFragment.start, anchor)') ||
      manualRangeBlock.includes('reachTop(') ||
      manualRangeBlock.includes('reachTopWithoutCapture(') ||
      manualRangeBlock.includes('locateBoundaryForUpwardScan(') ||
      !contentSource.includes("requireBoundary: mode === 'fragment'") ||
      !contentSource.includes("recoverLoadErrors: mode !== 'fragment'")) {
    fail('manual range: explicit start/end capture must begin from the visible start and move only downward without automatic Retry recovery');
  }
  const fullDownStart = contentSource.indexOf('async function walkDownFullLegacy');
  const fullDownEnd = contentSource.indexOf('async function walkDown(', fullDownStart);
  const fullDownBlock = fullDownStart >= 0 && fullDownEnd > fullDownStart
    ? contentSource.slice(fullDownStart, fullDownEnd)
    : '';
  if (!fullDownBlock ||
      !fullDownBlock.includes("recoverVisibleLoadError('walk'") ||
      !fullDownBlock.includes("await physicalScroll('down', 3)") ||
      !fullDownBlock.includes('visibleNavigationRefsLightweight()') ||
      !fullDownBlock.includes('navigationWindowsOverlap(beforeRefs, afterRefs)') ||
      !fullDownBlock.includes('recoverDownwardContinuity(') ||
      !fullDownBlock.includes('collect(map, order, settings, boundary)') ||
      fullDownBlock.includes('hydrateSequentialImages(') ||
      fullDownBlock.includes('firstPassCount')) {
    fail('full capture: preserve 0.3.87 debugger descent with capture-before-move and overlap verification');
  }

  if (!contentSource.includes('function hasStableResumeAnchor(id)') ||
      !contentSource.includes('if (!isStrongMessageId(strongId)) return false') ||
      !contentSource.includes('strongId: isStrongMessageId(id) ? id :') ||
      !contentSource.includes('for (let i = 0; i <= left.length - length; i++)') ||
      !contentSource.includes('for (let j = 0; j <= right.length - length; j++)') ||
      !contentSource.includes('if (!x.strongId) continue')) {
    fail('scroll/continuation identity: overlap must preserve the proven 0.3.87 contiguous-window rule while using strong IDs for one-message evidence');
  }

  const topOnlyStart = contentSource.indexOf('async function reachTopWithoutCapture');
  const topOnlyEnd = contentSource.indexOf('async function reachResumeAnchor', topOnlyStart);
  const topOnlyBlock = topOnlyStart >= 0 && topOnlyEnd > topOnlyStart
    ? contentSource.slice(topOnlyStart, topOnlyEnd)
    : '';
  if (!topOnlyBlock ||
      !topOnlyBlock.includes('explicitConversationStartVisible()') ||
      !topOnlyBlock.includes("await physicalScroll(") ||
      !topOnlyBlock.includes("'up',") ||
      !topOnlyBlock.includes('16,') ||
      !topOnlyBlock.includes('confirmedIdle >= 5') ||
      topOnlyBlock.includes('physicalScrollStartVisible() &&')) {
    fail('continuation navigation: candidate must retain navigation-only debugger ascent and avoid the 0.3.98 physical-top shortcut');
  }

  const startProofBegin = contentSource.indexOf('function explicitConversationStartVisible()');
  const startProofEnd = contentSource.indexOf('function firstVisibleTurnSignature()', startProofBegin);
  const startProofBlock = contentSource.slice(startProofBegin, startProofEnd);
  if (!startProofBlock.includes("document.querySelectorAll('[data-testid=\"conversation-turn-0\"]')") ||
      startProofBlock.includes("querySelectorAll('[data-chatgpt-search-unit-key")) {
    fail('top detection: only a globally indexed turn may prove first-message presence; virtual fallback-turn-0 is not the first conversation message');
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
    console.warn('WARN: known baseline Google Docs timeout guard is outside the scroll forensic candidate');
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
  const primaryCaptureStart = popupJs.indexOf("$('capture').onclick");
  const primaryCaptureEnd = popupJs.indexOf('async function refreshBoundaryMarkingControl', primaryCaptureStart);
  const primaryCaptureBlock = primaryCaptureStart >= 0 && primaryCaptureEnd > primaryCaptureStart
    ? popupJs.slice(primaryCaptureStart, primaryCaptureEnd)
    : '';
  const rangeCaptureStart = popupJs.indexOf("$('captureFragment').onclick");
  const rangeCaptureEnd = popupJs.indexOf("$('copyFragment').onclick", rangeCaptureStart);
  const rangeCaptureBlock = rangeCaptureStart >= 0 && rangeCaptureEnd > rangeCaptureStart
    ? popupJs.slice(rangeCaptureStart, rangeCaptureEnd)
    : '';
  if (!primaryCaptureBlock ||
      !primaryCaptureBlock.includes("type: 'ARCHIVER_TOGGLE_MARKING_CURRENT'") ||
      primaryCaptureBlock.includes("type: 'ARCHIVER_CAPTURE_CURRENT'") ||
      !rangeCaptureBlock ||
      !rangeCaptureBlock.includes("type: 'ARCHIVER_CAPTURE_FRAGMENT'") ||
      !rangeCaptureBlock.includes("captureTarget: 'current'") ||
      !popupHtml.includes('>Разметить диапазон</button>') ||
      !popupHtml.includes('>Собрать отмеченный диапазон</button>') ||
      !popupHtml.includes('capture-location hidden') ||
      !serviceWorkerSource.includes("case 'ARCHIVER_CAPTURE_FRAGMENT':") ||
      !serviceWorkerSource.includes("mode: 'fragment', captureTarget: 'current'") ||
      !serviceWorkerSource.includes("if (mode === 'fragment' && (!markers.start || !markers.end))")) {
    fail('manual range UX: primary capture must mark and collect an explicit current-tab range without automatic full-chat navigation');
  }
  // Verify the worker contract independently of the popup. Recovery alarms
  // and direct startCapture callers must not bypass the positioned-tab rule.
  const startCaptureStart = serviceWorkerSource.indexOf('async function startCapture({');
  const startCaptureEnd = serviceWorkerSource.indexOf('async function scheduleAutomaticRecovery(', startCaptureStart);
  const startCaptureBlock = startCaptureStart >= 0 && startCaptureEnd > startCaptureStart
    ? serviceWorkerSource.slice(startCaptureStart, startCaptureEnd)
    : '';
  const finishErrorStart = serviceWorkerSource.indexOf('async function finishJobWithError(');
  const finishErrorEnd = serviceWorkerSource.indexOf('async function ', finishErrorStart + 10);
  const finishErrorBlock = finishErrorStart >= 0 && finishErrorEnd > finishErrorStart
    ? serviceWorkerSource.slice(finishErrorStart, finishErrorEnd)
    : '';
  const autoRecoveryStart = serviceWorkerSource.indexOf('async function attemptAutomaticRecovery(');
  const autoRecoveryEnd = serviceWorkerSource.indexOf('async function finishJobWithError(', autoRecoveryStart);
  const autoRecoveryBlock = autoRecoveryStart >= 0 && autoRecoveryEnd > autoRecoveryStart
    ? serviceWorkerSource.slice(autoRecoveryStart, autoRecoveryEnd)
    : '';
  const navigationResumeStart = serviceWorkerSource.indexOf('async function resumeNavigationOnlyFromWorkingTab(');
  const navigationResumeEnd = serviceWorkerSource.indexOf('async function attemptAutomaticRecovery(', navigationResumeStart);
  const navigationResumeBlock = navigationResumeStart >= 0 && navigationResumeEnd > navigationResumeStart
    ? serviceWorkerSource.slice(navigationResumeStart, navigationResumeEnd)
    : '';
  if (!startCaptureBlock.includes("(mode === 'fragment' ||") ||
      !startCaptureBlock.includes("providedDraft?.captureMode === 'fragment'") ||
      !finishErrorBlock.includes("job.captureMode !== 'fragment'") ||
      !autoRecoveryBlock.includes("failedJob.captureMode === 'fragment'") ||
      navigationResumeBlock.includes("['full', 'fragment', 'reconcile', 'images'].includes(failedJob.captureMode)") ||
      finishErrorBlock.includes("['full', 'fragment', 'reconcile', 'images'].includes(job.captureMode)")) {
    fail('manual range isolation: force positioned current tab; never restart range through legacy navigation recovery or stale alarms');
  }
  const manualContentSource = await readFile('content-chatgpt.js', 'utf8');
  const captureStart = manualContentSource.indexOf('async function captureConversation(');
  const contentResumeBlock = captureStart < 0 ? '' : manualContentSource.slice(captureStart, captureStart + 40000);
  const savedResumeStart = serviceWorkerSource.indexOf('async function resumeSavedUnfinishedPass(');
  const savedResumeEnd = serviceWorkerSource.indexOf('async function ', savedResumeStart + 10);
  const savedResumeBlock = serviceWorkerSource.slice(savedResumeStart, savedResumeEnd);
  const failedResumeStart = serviceWorkerSource.indexOf('async function resumeFailedCaptureFromWorkingTab(');
  const failedResumeEnd = serviceWorkerSource.indexOf('async function ', failedResumeStart + 10);
  const failedResumeBlock = serviceWorkerSource.slice(failedResumeStart, failedResumeEnd);
  const completionStart = serviceWorkerSource.indexOf('async function handleCaptureComplete(');
  const completionEnd = serviceWorkerSource.indexOf('async function ', completionStart + 10);
  const completionBlock = serviceWorkerSource.slice(completionStart, completionEnd);
  if (!contentResumeBlock.includes("resumedDraft?.captureMode === 'fragment'") ||
      !contentResumeBlock.includes('isFragment: false') ||
      !contentResumeBlock.includes('manualRangeMarkers: manuallyBounded') ||
      !completionBlock.includes('[STORAGE_KEYS.lastArchiveId]: archive.id') ||
      !failedResumeBlock.includes("draft.captureMode === 'fragment'") ||
      !savedResumeBlock.includes("draft.captureMode !== 'fragment'") ||
      !completionBlock.includes("!archive.isFragment") ||
      !completionBlock.includes("if ((archive.manualRangeMarkers || archive.isFragment) && archive.sourceUrl)") ||
      !failedResumeBlock.includes("draft.capturePhase !== 'walk' && draft.capturePhase !== 'finalizing'") ||
      !savedResumeBlock.includes("!['walk', 'finalizing'].includes(draft.capturePhase)")) {
    fail('manual range draft resume: preserve canonical archive identity and range provenance, without legacy top traversal');
  }
  if (!serviceWorkerSource.includes("selectedArchiveId: archive.id,") ||
      !serviceWorkerSource.includes("const selectedArchive = selectionMatches") ||
      !serviceWorkerSource.includes("const archive = selectedArchive ||") ||
      !popupJs.includes("viewPlanner.textContent = 'Просмотр и вкладки'") ||
      !popupJs.includes("'planner.html?archiveId=' + encodeURIComponent(item.id)") ||
      !serviceWorkerSource.includes("linkedDoc = selectedArchive.isFragment") ||
      !serviceWorkerSource.includes("await getLinkedDoc(selectedArchive.sourceUrl || '')") ||
      !serviceWorkerSource.includes("canContinue: Boolean(archive?.messages?.length && !archive.isFragment)")) {
    fail('archive viewer regression: selected local archive must reach the popup and the tab planner without replacing canonical lastArchiveId');
  }
  // The primary end/start workflow must save as a normal archive, including
  // archives already collected with the incorrect 0.4.57 fragment flag.
  if (!serviceWorkerSource.includes('async function promoteMarkedPrimaryArchive(') ||
      !serviceWorkerSource.includes('manualRangeMarkers: archive.fragmentMarkers') ||
      !serviceWorkerSource.includes("lastCaptureMode: 'manual-range'") ||
      !serviceWorkerSource.includes('await indexArchive(promoted)') ||
      !serviceWorkerSource.includes('await registerArchive(promoted)') ||
      !serviceWorkerSource.includes('promoteMarkedPrimaryArchive(selectedCandidate)') ||
      !serviceWorkerSource.includes('const conversation = await promoteMarkedPrimaryArchive(') ||
      !contentResumeBlock.includes('isFragment: false') ||
      !completionBlock.includes('[STORAGE_KEYS.lastArchiveId]: archive.id')) {
    fail('manual full archive: bounded capture and legacy migration must allow normal Google Docs export and continuation');
  }
  if (!serviceWorkerSource.includes('const archive = await promoteMarkedPrimaryArchive(await getArchive(archiveId));') ||
      !serviceWorkerSource.includes("replace(/^Фрагмент\\s*[—–-]\\s*/i, '')") ||
      !serviceWorkerSource.includes('const selectionMatches = !activeIsConversation') ||
      !serviceWorkerSource.includes('conversationKey(selectedCandidate.sourceUrl) === conversationKey(tab.url)') ||
      !serviceWorkerSource.includes('selectedArchiveId: partialMerge.applied ? partialMerge.archiveId : archive.id') ||
      !serviceWorkerSource.includes('const actualText = await copyCurrentGoogleDocTabText(tabId)') ||
      !serviceWorkerSource.includes('if (!actual.includes(sample))')) {
    fail('post-0.4.58 regressions: legacy archive continuation, per-chat selection, partial ID and Docs paste confirmation');
  }
  if (!serviceWorkerSource.includes("return ['manual-range',") &&
      !serviceWorkerSource.includes("'manual-range',\n    'start:'")) {
    fail('draft grouping: manually bounded capture must retain the same range identity across resume modes');
  }
  const overlapModuleSource = await readFile('lib/draft-overlap.mjs', 'utf8');
  if (!serviceWorkerSource.includes("case 'ARCHIVER_GET_UNFINISHED_PASS':") ||
      !serviceWorkerSource.includes("const draft = await reconcileUnfinishedPrefix(") ||
      !serviceWorkerSource.includes("async function exportUnfinishedPassToNewDoc(passId = '') {") ||
      !serviceWorkerSource.includes("const draft = await reconcileUnfinishedPrefix(await getDraft(passId));") ||
      !serviceWorkerSource.includes("draftId: draft.id,") ||
      !serviceWorkerSource.includes("recoveryDraftId: draft.id,")) {
    fail('verified draft materialization: preview, export and saved-tab continuation must use the merged snapshot');
  }
  if (!overlapModuleSource.includes('export function verifiedChronologicalOverlap(') ||
      !overlapModuleSource.includes('export function groupVerifiedDraftWindows(') ||
      !overlapModuleSource.includes('export function sameDraftCaptureScope(') ||
      !serviceWorkerSource.includes('groupVerifiedDraftComponents(candidateDrafts, mergeStoredMessageCapture)') ||
      !serviceWorkerSource.includes('sameDraftCaptureScope(draft, item)') ||
      !serviceWorkerSource.includes('verifiedChronologicalOverlap(messages, candidateMessages)') ||
      !serviceWorkerSource.includes('mergeVerifiedTurns(') ||
      !serviceWorkerSource.includes("const mergeId = 'verified-merge:'") ||
      !serviceWorkerSource.includes('verifiedMergedFromDraftIds: originalIds') ||
      !serviceWorkerSource.includes('await chrome.storage.local.set({ [STORAGE_KEYS.draftPrefix + mergeId]: updated })') ||
      serviceWorkerSource.includes('await chrome.storage.local.set({ [STORAGE_KEYS.draftPrefix + draft.id]: updated })')) {
    fail('draft grouping: only uniquely verified chronological overlaps with exact chat/snapshot/range identity may merge into a new preserved snapshot');
  }
  const libraryStoreSource = await readFile('lib/archive-store.mjs', 'utf8');
  if (!serviceWorkerSource.includes('async function listLinkedArchivesFast()') ||
      !serviceWorkerSource.includes("case 'ARCHIVER_GET_SAVED_ARCHIVES_FAST':") ||
      !serviceWorkerSource.includes("case 'ARCHIVER_GET_SAVED_ARCHIVES_DETAILS':") ||
      !serviceWorkerSource.includes('savedArchives: await listLinkedArchivesFast()') ||
      !popupJs.includes('async function loadFastArchiveLibrary()') ||
      !popupJs.includes('async function hydrateSavedArchiveDetails()') ||
      !popupJs.includes("item.messageCount) ? item.messageCount : '…'") ||
      !popupJs.includes('void loadFastArchiveLibrary().catch(') ||
      !libraryStoreSource.includes('messageCount: Number(conversation.messages?.length || 0)')) {
    fail('saved archive library: show counts from lightweight metadata first and hydrate legacy details separately');
  }
  const popupStateStart = serviceWorkerSource.indexOf("case 'ARCHIVER_GET_STATE':");
  const popupStateEnd = serviceWorkerSource.indexOf("case 'ARCHIVER_GET_DRAFT':", popupStateStart);
  const popupStateBlock = serviceWorkerSource.slice(popupStateStart, popupStateEnd);
  if (popupStateBlock.includes('compactCompatibleDrafts(') ||
      popupStateBlock.includes('await listDrafts(') ||
      popupStateBlock.includes('buildUnfinishedCaptureGroups(') ||
      popupStateBlock.includes('await registerArchive(archive)') ||
      popupStateBlock.includes('savedArchives: await listLinkedArchives()')) {
    fail('popup startup performance: state read must not load message bodies or compare drafts');
  }
  if (!overlapModuleSource.includes('export function groupVerifiedDraftComponents(') ||
      !overlapModuleSource.includes('return id ? [\'id:\' + id] : []') ||
      !overlapModuleSource.includes('strongMatches < 1') ||
      !overlapModuleSource.includes('export function mergeNewestCapturedTurn(') ||
      !serviceWorkerSource.includes('const unfinishedDraftCount = await countUnfinishedDraftKeys()') ||
      !serviceWorkerSource.includes("case 'ARCHIVER_GET_UNFINISHED_GROUPS':") ||
      !serviceWorkerSource.includes('async function getDetailedUnfinishedGroups(job)') ||
      !serviceWorkerSource.includes('messageCount: mergedMessages.length') ||
      !serviceWorkerSource.includes('imageCount: mergedMessages.reduce(') ||
      !serviceWorkerSource.includes('mergeNewestCapturedTurn(oldMessage, newMessage, mergeStoredMessageCapture)') ||
      !serviceWorkerSource.includes('messages = messages.map(({ __captureTime, ...message }) => message)') ||
      !popupJs.includes('async function loadUnfinishedGroups()') ||
      !popupJs.includes("type: 'ARCHIVER_GET_UNFINISHED_GROUPS'") ||
      !popupHtml.includes('id="loadUnfinishedPasses"')) {
    fail('0.4.63: weak-only overlap protection, truthful union counters, explicit draft loading and complete payload refresh');
  }
  const unsafeDraftDeletionStart = serviceWorkerSource.indexOf('async function deleteUnfinishedGroup(');
  const unsafeDraftDeletionEnd = serviceWorkerSource.indexOf('async function refreshCaptureJobHealth(', unsafeDraftDeletionStart);
  const deletionBlock = serviceWorkerSource.slice(unsafeDraftDeletionStart, unsafeDraftDeletionEnd);
  const draftReconcileStart = serviceWorkerSource.indexOf('async function reconcileUnfinishedPrefix(');
  const draftReconcileEnd = serviceWorkerSource.indexOf('async function compactCompatibleDrafts(', draftReconcileStart);
  const reconcileBlock = serviceWorkerSource.slice(draftReconcileStart, draftReconcileEnd);
  if (!deletionBlock.includes('const ids = new Set((passIds || []).filter(Boolean))') ||
      deletionBlock.includes('ids.add(item.id)') ||
      !deletionBlock.includes('selected.length !== ids.size') ||
      !deletionBlock.includes('unfinishedGroupKey(item) !== baseKey') ||
      reconcileBlock.includes('await removeDraft(id)') ||
      reconcileBlock.includes('await removeDraftRecoveryTab(id)')) {
    fail('draft safety: deletion must use exact presented IDs; reconciliation must retain source drafts');
  }
  const fastArchiveStart = serviceWorkerSource.indexOf('async function listLinkedArchivesFast(');
  const fastArchiveEnd = serviceWorkerSource.indexOf('async function hydrateLegacyArchiveLibrary(', fastArchiveStart);
  const fastArchiveBlock = serviceWorkerSource.slice(fastArchiveStart, fastArchiveEnd);
  const hydrateStart = serviceWorkerSource.indexOf('async function hydrateLegacyArchiveLibrary(');
  const hydrateEnd = serviceWorkerSource.indexOf('async function listLinkedArchives(', hydrateStart);
  const hydrateBlock = serviceWorkerSource.slice(hydrateStart, hydrateEnd);
  if (!fastArchiveBlock.includes("item?.title || 'Загружаю сведения об архиве…'") ||
      !hydrateBlock.includes('Number.isFinite(card.messageCount)') ||
      !hydrateBlock.includes('await registerArchive(archive)') ||
      !serviceWorkerSource.includes('savedArchives: await hydrateLegacyArchiveLibrary()') ||
      !popupJs.includes('state.savedArchives = detailedSavedArchives')) {
    fail('legacy library: missing metadata must appear as placeholders and be hydrated only on demand');
  }
  if (!popupJs.includes('ARCHIVER_TOGGLE_MARKING_CURRENT') ||
      !popupJs.includes('ARCHIVER_CLEAR_MARKERS_CURRENT') ||
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

  const bgCreateStart = serviceWorkerSource.indexOf("captureTab = await chrome.tabs.create({ url: inspection.href, active: true })");
  const bgStartCollector = serviceWorkerSource.indexOf("await ensureChatGptContentScript(captureTab.id, jobId");
  const bgRestoreSource = serviceWorkerSource.indexOf("await chrome.tabs.update(sourceTab.id, { active: true })", bgStartCollector);
  if (bgCreateStart < 0 ||
      bgStartCollector < 0 ||
      bgRestoreSource < bgStartCollector ||
      !serviceWorkerSource.includes("files: ['content-chatgpt.js']")) {
    fail('background capture: warm working tab in foreground, start collector with both content scripts, then restore source tab');
  }

  const retryRuntimeStart = contentSource.indexOf('function findVisibleLoadRetry()');
  const retryRuntimeEnd = contentSource.indexOf('async function waitForTurnSettle', retryRuntimeStart);
  const retryRuntimeBlock = retryRuntimeStart >= 0 && retryRuntimeEnd > retryRuntimeStart
    ? contentSource.slice(retryRuntimeStart, retryRuntimeEnd)
    : '';
  const retryRecoveryStart = contentSource.indexOf('async function recoverVisibleLoadError');
  const retryRecoveryEnd = contentSource.indexOf('async function getSettings', retryRecoveryStart);
  const retryRecoveryBlock = retryRecoveryStart >= 0 && retryRecoveryEnd > retryRecoveryStart
    ? contentSource.slice(retryRecoveryStart, retryRecoveryEnd)
    : '';
  if (!retryRuntimeBlock ||
      !retryRuntimeBlock.includes("visibleElement(el, { interactive: true })") ||
      !contentSource.includes('document.elementFromPoint') ||
      !contentSource.includes("el.closest('[aria-hidden=\"true\"], [inert]')") ||
      !contentSource.includes('rect.top >= viewportHeight') ||
      !contentSource.includes('rect.left >= viewportWidth') ||
      !retryRuntimeBlock.includes('rect.height > Math.max(520, viewportHeight * 0.8)') ||
      !retryRecoveryBlock.includes('await sleep(120)') ||
      !retryRecoveryBlock.includes('retry = visibleRetryButton()')) {
    fail('load-error recovery: Retry must be a real in-viewport hit-tested control with a local visible error context and must be revalidated before click');
  }

  const workerRetryStart = serviceWorkerSource.indexOf('async function clickChatRetry(tabId)');
  const workerRetryEnd = serviceWorkerSource.indexOf('async function waitForChatDomReady', workerRetryStart);
  const workerRetryBlock = workerRetryStart >= 0 && workerRetryEnd > workerRetryStart
    ? serviceWorkerSource.slice(workerRetryStart, workerRetryEnd)
    : '';
  if (!workerRetryBlock ||
      !workerRetryBlock.includes('document.elementFromPoint') ||
      !workerRetryBlock.includes('rect.top >= viewportHeight') ||
      !workerRetryBlock.includes('rect.left >= viewportWidth') ||
      !workerRetryBlock.includes('errorPattern.test(text)')) {
    fail('background load recovery: worker must reject offscreen/occluded Retry controls and require local error evidence');
  }

  if (!contentSource.includes('function findVisibleLoadRetry()') ||
      !contentSource.includes("visibleElement(el, { interactive: true })") ||
      !contentSource.includes('document.elementFromPoint') ||
      !contentSource.includes('await sleep(120);') ||
      !serviceWorkerSource.includes('last?.retryAvailable') ||
      !serviceWorkerSource.includes('if (clicked) {') ||
      !serviceWorkerSource.includes('retryAvailable')) {
    fail('Retry recovery: only a real visible clickable local error Retry control may trigger click/backoff');
  }

  const physicalScrollStart = serviceWorkerSource.indexOf("async function physicalScrollTab(tabId, direction = 'down', bursts = 7)");
  const physicalScrollEnd = serviceWorkerSource.indexOf('async function withChatDebugger', physicalScrollStart);
  const physicalScrollBlock = physicalScrollStart >= 0 && physicalScrollEnd > physicalScrollStart
    ? serviceWorkerSource.slice(physicalScrollStart, physicalScrollEnd)
    : '';
  if (!serviceWorkerSource.includes('async function chatScrollMetrics') ||
      !serviceWorkerSource.includes('async function scriptedScrollChatTab') ||
      !physicalScrollBlock ||
      !physicalScrollBlock.includes('beforeMetrics = await chatScrollMetrics') ||
      !physicalScrollBlock.includes('afterMetrics = await chatScrollMetrics') ||
      !physicalScrollBlock.includes('Math.round(width * 0.68)') ||
      !physicalScrollBlock.includes('Math.round(height * 0.48)') ||
      !physicalScrollBlock.includes("deltaY: sign * 860") ||
      !physicalScrollBlock.includes('scriptedScrollChatTab(tabId, direction, count)') ||
      !physicalScrollBlock.includes("method: moved ? 'debugger-wheel' : 'debugger-wheel-edge'")) {
    fail('full capture: debugger wheel must verify real movement and fall back to the live ChatGPT scroller on acknowledged no-op input');
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
  if (chatScripts.length !== 1 || chatScripts[0] !== 'content-chatgpt.js') {
    fail('manifest.json: ChatGPT capture must load the single self-contained content-chatgpt.js runtime');
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
  for (const requiredFile of [
    'updater.html', 'updater.css', 'updater.js',
    'help.html', 'help.css',
    'unfinished.html', 'unfinished.css', 'unfinished.js'
  ]) {
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
  'tests/draft-overlap.test.mjs',
  'tests/capture-evidence.test.mjs',
  'tests/capture-viewport.test.mjs',
  'tests/capture-traversal.test.mjs',
  'tests/capture-recovery.test.mjs',
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
