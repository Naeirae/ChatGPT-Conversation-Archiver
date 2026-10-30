import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('content-chatgpt.js', 'utf8');

test('resume failure with empty new map can preserve the existing draft', () => {
  assert.match(source, /\(map\.size > 0 \|\|\s*\(\['resume-draft', 'retry-walk'\]\.includes\(mode\) && Boolean\(existingDraftId\)\)\)/);
  assert.match(source, /\? existingRecoveryDraft\.id\s*:\s*\(current\.draftId/);
});

test('resume navigation never checkpoints a temporary DOM slice', () => {
  const block = source.slice(source.indexOf('async function persistRecoveryCheckpoint('),
    source.indexOf('function visibleNavigationRefsLightweight()'));
  assert.match(block, /\['resume-draft', 'retry-walk'\]\.includes\(current\.captureMode\) &&\s*current\.phase === 'top'\) return/);
});

test('a shorter or different resumed prefix cannot overwrite stored messages', () => {
  const block = source.slice(source.indexOf('async function persistRecoveryCheckpoint('),
    source.indexOf('function visibleNavigationRefsLightweight()'));
  const guard = block.indexOf('const oldPrefix = storedBeforeWrite.messages');
  const write = block.indexOf("await chrome.storage.local.set({ ['draft:' + draftId]: draft })");
  assert.ok(guard > 0 && write > guard);
  assert.match(block.slice(guard,write), /draft\.messages\.length < oldPrefix\.length/);
  assert.match(block.slice(guard,write), /oldPrefix\.some\(\(oldMessage, index\)/);
  assert.match(block.slice(guard,write), /sameNavigationRef\(navigationRef\(oldMessage\), navigationRef\(draft\.messages\[index\]\)\)/);
});

test('a failed resumed pass does not replace a larger checkpoint', () => {
  const failure = source.slice(source.indexOf("if (!draftId && mode !== 'images-draft'"),
    source.indexOf('const fallbackDraftIds'));
  assert.match(failure, /previousCheckpoint\?\.messages\?\.length > draft\.messages\.length/);
  assert.match(failure, /draftCount = previousCheckpoint\.messages\.length/);
});

test('capture failure breadcrumbs survive a missing background acknowledgement', async () => {
  const worker = await readFile('service-worker.js', 'utf8');
  const write = source.indexOf("['archiverCaptureFailure:' + jobId]");
  const report = source.indexOf("type: 'ARCHIVER_CAPTURE_FAILED'", write);
  assert.ok(write > 0 && report > write);
  const read = worker.indexOf("const failureKey = 'archiverCaptureFailure:' + current.jobId");
  const show = worker.indexOf("'Первичная ошибка сборщика: '", read);
  assert.ok(read > 0 && show > read);
});

test('full capture uses a second independent bounded pass without replacing checkpoints', () => {
  const checkStart = source.indexOf('// Final verification is independent of the first canonical walk.');
  const finalStart = source.indexOf("mode === 'compare'\n          ? 'Этап 3/3: считаю новые сообщения", checkStart);
  assert.ok(checkStart > 0 && finalStart > checkStart);
  const block = source.slice(checkStart, finalStart);
  assert.match(block, /await reachTopWithoutCapture\(firstMessages\.length/);
  assert.match(block, /verifiedWalk = await walkDownFullLegacy\(/);
  assert.match(block, /state\.verificationPassActive = true/);
  assert.match(block, /state\.verificationPassActive = false/);
  assert.match(block, /reconcileNavigationCoverage\(/);
  assert.match(block, /rebuildCaptureMap\(map, order, verifiedMessages\)/);
  const checkpoint = source.slice(source.indexOf('async function persistRecoveryCheckpoint('),
    source.indexOf('function visibleNavigationRefsLightweight()'));
  assert.match(checkpoint, /state\.verificationPassActive\) return/);
});

test('a transient virtualized seam settles before recovery and preserves a checkpoint', () => {
  const walk = source.slice(source.indexOf('async function walkDown('),
    source.indexOf('async function captureConversation('));
  const start = walk.indexOf('if (!overlapping && !adjacent)');
  const finish = walk.indexOf('const recovered = await recoverDownwardContinuity(', start);
  const segment = walk.slice(start, finish);
  assert.ok(start >= 0 && finish > start);
  assert.match(segment, /await waitForTurnSettle\(2400, 450\)/);
  assert.match(segment, /navigationWindowsOverlap\(beforeRefs, settledRefs\)/);
  assert.doesNotMatch(segment, /navigationWindowsOverlap\(afterRefs, settledRefs\)/);
  assert.ok(segment.indexOf('await saveRecoveryCheckpoint(map, order, boundary, { force: true })') <
    segment.indexOf('watchdog.beforeRecovery('));
});

test('seam retry budget cannot be reset by weak fallback message inflation', () => {
  assert.match(source, /function verifiedStrongFrontierCount\(map\)/);
  const matches = source.match(/watchdog\.beforeRecovery\(physicalBefore, beforeRefs, verifiedStrongFrontierCount\(map\)\)/g) || [];
  assert.equal(matches.length, 2);
  const watchdog = source.slice(source.indexOf('function createContinuityWatchdog('),
    source.indexOf('async function recoverDownwardContinuity('));
  assert.match(watchdog, /const verifiedMovement = Boolean\(physicalForward && newStrongId\)/);
  assert.match(watchdog, /if \(topBeyondFrontier\) revisitedSteps = 0/);
});

test('recovery reuses the historical overlapping window without pixel replay', () => {
  const start = source.indexOf('async function recoverDownwardContinuity(');
  const end = source.indexOf('async function walkDownFullLegacy(', start);
  const block = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(block, /navigationWindowsOverlap\(beforeRefs, currentRefs\)/);
  assert.match(block, /await physicalScroll\(/);
  assert.doesNotMatch(block, /originalAfter\.top|replaySeen|reachedAfter/);
});

test('full chronological pass hydrates visible image binaries during traversal', () => {
  const start = source.indexOf('async function walkDownFullLegacy(');
  const end = source.indexOf('async function walkDown(', start);
  const segment = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(segment, /const imageAttempts = new Map\(\)/);
  assert.match(segment, /visibleIds\\.map\\(id => map\\.get\\(id\\)\\)/);
  assert.match(segment, /nextIds\\.map\\(id => map\\.get\\(id\\)\\)/);
  assert.equal((segment.match(/visibleOnly: true, walkStep: i/g) || []).length, 2);
});

test('full capture restores pre-0.3.97 forward-only traversal, with final verification separate', () => {
  const start = source.indexOf('async function walkDownFullLegacy(');
  const end = source.indexOf('async function walkDown(', start);
  const segment = source.slice(start, end);
  assert.match(segment, /await physicalScroll\('down', 1/);
  assert.match(segment, /settleTimeout: 5000, quietWindow: 850/);
  assert.doesNotMatch(segment, /recoverDownwardContinuity|watchdog\.beforeRecovery/);
  assert.match(segment, /await saveRecoveryCheckpoint\(map, order, boundary, \{ force: true \}\)/);
});
