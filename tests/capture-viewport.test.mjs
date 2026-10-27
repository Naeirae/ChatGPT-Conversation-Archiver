import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rectIntersectsCaptureViewport,
  matchesStrongBoundaryIdentity
} from '../lib/capture-viewport.mjs';

const rect = (top, bottom, left = 15, right = 600) =>
  ({ top, bottom, left, right });

test('a DOM-mounted marked end well below the screen is not physically reached', () => {
  assert.equal(rectIntersectsCaptureViewport(rect(1800, 2400), 1200, 850), false);
});

test('a DOM-mounted marked end already passed above the screen is not reached', () => {
  assert.equal(rectIntersectsCaptureViewport(rect(-1200, -50), 1200, 850), false);
});

test('the visible part of a long message counts as physical boundary arrival', () => {
  assert.equal(rectIntersectsCaptureViewport(rect(-400, 300), 1200, 850), true);
});

test('a real tiny chat may contain both marks without a wheel movement', () => {
  assert.equal(rectIntersectsCaptureViewport(rect(150, 350), 1200, 850), true);
  assert.equal(rectIntersectsCaptureViewport(rect(480, 700), 1200, 850), true);
});

test('a message outside the inner ChatGPT scrollport is not visible despite being on screen', () => {
  assert.equal(rectIntersectsCaptureViewport(
    rect(700, 820), 1200, 900, rect(90, 670)
  ), false);
});

test('a message partly in the inner scrollport is truly visible', () => {
  assert.equal(rectIntersectsCaptureViewport(
    rect(620, 740), 1200, 900, rect(90, 670)
  ), true);
});

test('strong immutable message ID remains sufficient when previous turns disappear', () => {
  assert.equal(matchesStrongBoundaryIdentity(
    'data-message-id:abc', 'data-message-id:abc', 'modified-content', 'old-content'
  ), true);
  assert.equal(matchesStrongBoundaryIdentity(
    'data-message-id:abc', 'data-message-id:def', 'same-content', 'same-content'
  ), false);
  assert.equal(matchesStrongBoundaryIdentity(
    'turn:weak-id', 'turn:weak-id', 'same-content', 'same-content'
  ), null);
});
