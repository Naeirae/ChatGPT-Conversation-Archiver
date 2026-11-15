import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedCaptureNavigation } from '../lib/capture-navigation-guard.mjs';

const a = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const b = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const baseJob = {
  jobId: 'job-a', captureTabId: 42, sourceUrl: a,
  status: 'running', startedAt: 1000
};
const example = (changes = {}) => confirmedCaptureNavigation({
  job: baseJob,
  liveJob: baseJob,
  tabId: 42,
  eventUrl: b,
  liveUrl: b,
  eventObservedAt: 2000,
  ...changes
});

test('confirmed live navigation to another conversation aborts', () => {
  assert.equal(example(), true);
});

test('old tab snapshot is never treated as navigation', () => {
  assert.equal(example({ eventUrl: '' }), false);
  assert.equal(example({ eventUrl: b, liveUrl: a }), false);
  assert.equal(example({ eventUrl: a, liveUrl: b }), false);
});

test('events from previous job and outdated capture ownership are ignored', () => {
  assert.equal(example({ eventObservedAt: 999 }), false);
  assert.equal(example({ liveJob: { ...baseJob, jobId: 'job-b' } }), false);
  assert.equal(example({ liveJob: { ...baseJob, captureTabId: 50 } }), false);
  assert.equal(example({ tabId: 50 }), false);
  assert.equal(example({ liveJob: { ...baseJob, status: 'done' } }), false);
});

test('same conversation with changed query parameters is not navigation', () => {
  assert.equal(example({ eventUrl: a + '?g=plain', liveUrl: a }), false);
});
