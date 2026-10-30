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
