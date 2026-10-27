import test from 'node:test';
import assert from 'node:assert/strict';
import { fullTopEvidence, completedBoundedPass } from '../lib/capture-evidence.mjs';

test('a stationary virtualized viewport is never sufficient to prove full-chat top', () => {
  const evidence = fullTopEvidence({
    explicitConversationStart: false,
    manuallyConfirmed: false,
    upwardTravelObserved: false,
    stableChecks: 10
  });
  assert.equal(evidence.verified, false);
  assert.match(evidence.reason, /первая реплика не подтверждена/);
  assert.equal(completedBoundedPass({
    mode: 'full',
    verifiedStart: evidence.verified,
    verifiedEnd: true
  }), false);
});

test('a real seven-message chat can finish without scrolling when first and end are proven', () => {
  const evidence = fullTopEvidence({ explicitConversationStart: true });
  assert.equal(evidence.verified, true);
  assert.equal(completedBoundedPass({
    mode: 'full',
    verifiedStart: evidence.verified,
    verifiedEnd: true
  }), true);
});

test('manual start and end on the same viewport are valid without scroll steps', () => {
  assert.equal(completedBoundedPass({
    mode: 'fragment',
    markerStartVisible: true,
    markerEndVisible: true,
    verifiedEnd: true
  }), true);
});

test('unconfirmed manual end never produces a completed archive', () => {
  assert.equal(completedBoundedPass({
    mode: 'fragment',
    markerStartVisible: true,
    markerEndVisible: false,
    verifiedEnd: false
  }), false);
});

test('full capture cannot finish when an initial viewport supplied an unverified end', () => {
  const evidence = fullTopEvidence({
    upwardTravelObserved: true,
    stableChecks: 5
  });
  assert.equal(evidence.verified, true);
  assert.equal(completedBoundedPass({
    mode: 'full',
    verifiedStart: evidence.verified,
    verifiedEnd: false
  }), false);
});

test('sustained real upward travel and stable viewport can establish full top', () => {
  assert.equal(fullTopEvidence({
    upwardTravelObserved: true,
    stableChecks: 4
  }).verified, false);
  assert.equal(fullTopEvidence({
    upwardTravelObserved: true,
    stableChecks: 5
  }).verified, true);
});

test('user-confirmed top permits short conversations without fake scroll movement', () => {
  assert.equal(fullTopEvidence({ manuallyConfirmed: true }).verified, true);
});
