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
