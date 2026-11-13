import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const content = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../lib/capture-queue-controller.mjs', import.meta.url), 'utf8');

const start = content.indexOf('  function measuredAdjacentScroll(');
const end = content.indexOf('  function createContinuityWatchdog(', start);
assert.ok(start >= 0 && end > start);
const { measuredAdjacentScroll, moderateDownwardProgress } = runInNewContext(
  content.slice(start, end) + '\n({measuredAdjacentScroll,moderateDownwardProgress})'
);
const node = {};
const before = { element: node, top: 100, clientHeight: 700, scrollHeight: 3500 };
const physical = { direction: 'down', ok: true };

test('long message with expanding image layout resets stall but does not prove seam', () => {
  const after = { ...before, top: 320, scrollHeight: 4300 };
  assert.equal(measuredAdjacentScroll(before, after, physical), false);
  assert.equal(moderateDownwardProgress(before, after, physical), true);
});

test('stable layout and adjacent physical motion can prove chronology', () => {
  const after = { ...before, top: 320 };
  assert.equal(measuredAdjacentScroll(before, after, physical), true);
  assert.equal(moderateDownwardProgress(before, after, physical), true);
});

test('no stall reset on a jump or a different scroll root', () => {
  assert.equal(moderateDownwardProgress(before, { ...before, top: 900 }, physical), false);
  assert.equal(moderateDownwardProgress(before, { ...before, top: 320, element: {} }, physical), false);
});

test('long-turn walk passes proven forward continuity to next iteration', () => {
  const begin = content.indexOf('  async function walkDown(');
  const stop = content.indexOf('  async function ', begin + 30);
  const walk = content.slice(begin, stop);
  assert.match(walk, /let previousVerifiedForwardStep = false/);
  assert.match(walk, /verifiedForwardStep: previousVerifiedForwardStep/);
  assert.match(walk, /previousVerifiedForwardStep = measuredAdjacentScroll/);
});

test('per-turn identity context reuses already enumerated turn window', () => {
  assert.match(content, /function turnIdentityContext\(turn, knownTurns = null\)/);
  assert.match(content, /const turns = knownTurns \|\| orderedTurns\(\)/);
  assert.match(content, /captureTurn\(turn, ordinal, settings, mountedTurns\)/);
});

test('copied split lane can acknowledge after durable save without waiting for merge', () => {
  const begin = queue.indexOf('async function complete(message, tabId)');
  const end = queue.indexOf('async function markFailed(', begin);
  const block = queue.slice(begin, end);
  assert.match(block, /current\.phase = 'finalizing'/);
  assert.match(block, /void finalizeSplit\(worker\.itemId\)/);
  assert.doesNotMatch(block, /await finalizeSplit\(worker\.itemId\)/);
  assert.match(block, /return \{ ok: true, status: 'done', archiveId: archive\.id \}/);
});
