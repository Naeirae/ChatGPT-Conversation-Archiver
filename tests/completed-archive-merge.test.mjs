import test from 'node:test';
import assert from 'node:assert/strict';
import { planVerifiedCompletedMerges } from '../lib/completed-archive-merge.mjs';

const source = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
const other = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
const msg = (n, text = 'Text ' + n) => ({
  id: 'data-message-id:' + n, identityStrong: true,
  role: n % 2 ? 'user' : 'assistant', text, images: []
});
const archive = (id, messages, sourceUrl = source) => ({
  id, sourceUrl, title: 'Same title', complete: true,
  capturedAt: '2026-10-28T00:00:00Z', messages
});

test('verified overlapping saved windows merge in chronological order', () => {
  const a = archive('a', [msg(1), msg(2), msg(3)]);
  const b = archive('b', [msg(2), msg(3), msg(4)]);
  const results = planVerifiedCompletedMerges([a, b]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].messages.map(m => m.id), [1,2,3,4].map(n => 'data-message-id:' + n));
  assert.deepEqual(results[0].sourceIds, ['a','b']);
  assert.equal(a.messages.length, 3);
  assert.equal(b.messages.length, 3);
});

test('matching titles never merge different conversation URLs', () => {
  assert.equal(planVerifiedCompletedMerges([
    archive('a', [msg(1), msg(2), msg(3)]),
    archive('b', [msg(2), msg(3), msg(4)], other)
  ]).length, 0);
});

test('unanchored or disjoint windows remain separate and unchanged', () => {
  assert.equal(planVerifiedCompletedMerges([
    archive('a', [msg(1), msg(2), msg(3)]),
    archive('b', [msg(10), msg(11), msg(12)])
  ]).length, 0);
});

test('same text with distinct strong IDs cannot be silently collapsed', () => {
  assert.equal(planVerifiedCompletedMerges([
    archive('a', [msg(1,'repeat'), msg(2,'repeat')]),
    archive('b', [msg(3,'repeat'), msg(4,'repeat')])
  ]).length, 0);
});

test('verified bridge can join several saved segments', () => {
  const results = planVerifiedCompletedMerges([
    archive('a', [msg(1), msg(2), msg(3)]),
    archive('b', [msg(3), msg(4), msg(5)]),
    archive('c', [msg(5), msg(6), msg(7)]),
    archive('d', [msg(4), msg(5), msg(6)])
  ]);
  // The two-message overlaps a<->b and b<->d are enough to establish a
  // multi-window chain; c joins after the extended overlap.
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].messages.map(m=>m.id),[1,2,3,4,5,6,7].map(n=>'data-message-id:'+n));
});
