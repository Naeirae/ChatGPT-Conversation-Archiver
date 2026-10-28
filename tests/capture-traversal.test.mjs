import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the actual content-script functions with a deliberately virtualized
// DOM fixture. These checks exercise behavior, not only source-string presence.
const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');

function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Missing content function: ' + name);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let i = opening; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed function: ' + name);
}

function fixtureTurn(id, { visible = true, end = false } = {}) {
  return { id, visible, end };
}

test('offscreen end marker must not truncate mounted messages', () => {
  const turns = [
    fixtureTurn('one'),
    fixtureTurn('end', { visible: false, end: true }),
    fixtureTurn('two')
  ];
  const fn = new Function(
    'orderedTurns', 'captureTurn', 'identityContextsCompatible', 'hashText',
    'mergeRicherCapture', 'matchesBoundary', 'turnIntersectsCaptureViewport',
    extract('collect') + '; return collect;'
  )(
    () => turns,
    turn => ({ id: turn.id, identityStrong: true, text: turn.id }),
    () => true, value => value, (fresh) => fresh,
    turn => turn.end, turn => turn.visible
  );
  const map = new Map();
  const order = [];
  fn(map, order, {}, { key: 'end' });
  assert.deepEqual(order, ['one', 'end', 'two']);
});

test('visible end marker stops collection at its exact occurrence', () => {
  const turns = [
    fixtureTurn('one'),
    fixtureTurn('end', { visible: true, end: true }),
    fixtureTurn('newer')
  ];
  const fn = new Function(
    'orderedTurns', 'captureTurn', 'identityContextsCompatible', 'hashText',
    'mergeRicherCapture', 'matchesBoundary', 'turnIntersectsCaptureViewport',
    extract('collect') + '; return collect;'
  )(
    () => turns,
    turn => ({ id: turn.id, identityStrong: true, text: turn.id }),
    () => true, value => value, (fresh) => fresh,
    turn => turn.end, turn => turn.visible
  );
  const order = [];
  fn(new Map(), order, {}, { key: 'end' });
  assert.deepEqual(order, ['one', 'end']);
});

test('navigation overlap only uses physically visible turns', () => {
  const before = [
    fixtureTurn('one'),
    fixtureTurn('two'),
    fixtureTurn('three')
  ];
  const after = [
    fixtureTurn('two', { visible: false }),
    fixtureTurn('three', { visible: false }),
    fixtureTurn('ten'),
    fixtureTurn('eleven')
  ];
  let current = before;
  const refs = new Function(
    'orderedTurns', 'turnIntersectsCaptureViewport', 'turnStableKey',
    'isStrongMessageId', 'turnTextSignature',
    extract('visibleNavigationRefsLightweight') + '; return visibleNavigationRefsLightweight;'
  )(
    () => current,
    turn => turn.visible,
    turn => 'data-message-id:' + turn.id,
    id => id.startsWith('data-message-id:'),
    turn => turn.id
  );
  const overlap = new Function(
    extract('navigationWindowsOverlap') + '; return navigationWindowsOverlap;'
  )();
  const first = refs();
  current = after;
  const second = refs();
  assert.deepEqual(second.map(ref => ref.signature), ['ten', 'eleven']);
  assert.equal(overlap(first, second), false);
});

test('shared visible strong message proves genuine window overlap', () => {
  let turns = [fixtureTurn('one'), fixtureTurn('two')];
  const refs = new Function(
    'orderedTurns', 'turnIntersectsCaptureViewport', 'turnStableKey',
    'isStrongMessageId', 'turnTextSignature',
    extract('visibleNavigationRefsLightweight') + '; return visibleNavigationRefsLightweight;'
  )(
    () => turns,
    turn => turn.visible,
    turn => 'data-message-id:' + turn.id,
    id => id.startsWith('data-message-id:'),
    turn => turn.id
  );
  const overlap = new Function(
    extract('navigationWindowsOverlap') + '; return navigationWindowsOverlap;'
  )();
  const first = refs();
  turns = [fixtureTurn('two'), fixtureTurn('three')];
  assert.equal(overlap(first, refs()), true);
});

function boundaryFixture() {
  const hash = value => String(value);
  const signature = msg => msg.role + ':' + hash(msg.text);
  const strong = id => /^(?:data-message-id|data-turn-id):/.test(String(id || ''));
  return new Function(
    'messageTextSignature', 'isStrongMessageId',
    extract('messageBoundaryContextMatches') +
    extract('messageMatchesBoundary') +
    extract('uniqueBoundaryIndex') +
    extract('trimMessagesFromMarkedStart') +
    extract('trimMessagesThroughBoundary') +
    '; return { trimMessagesFromMarkedStart, trimMessagesThroughBoundary };'
  )(signature, strong);
}

test('marked start excludes older turns while retaining the selected message', () => {
  const { trimMessagesFromMarkedStart } = boundaryFixture();
  const rows = [
    { id: 'data-message-id:older', role: 'user', text: 'earlier' },
    { id: 'data-message-id:start', role: 'assistant', text: 'begin' },
    { id: 'data-message-id:later', role: 'user', text: 'later' }
  ];
  const result = trimMessagesFromMarkedStart(rows, { id: 'data-message-id:start' });
  assert.equal(result.found, true);
  assert.deepEqual(result.messages.map(x => x.text), ['begin', 'later']);
});

test('repeated weak end signatures without a unique context fail closed', () => {
  const { trimMessagesThroughBoundary } = boundaryFixture();
  const rows = [
    { id: 'weak:1', role: 'assistant', text: 'same' },
    { id: 'weak:2', role: 'user', text: 'middle' },
    { id: 'weak:3', role: 'assistant', text: 'same' }
  ];
  const result = trimMessagesThroughBoundary(rows, { kind: 'signature', key: 'assistant:same' });
  assert.equal(result.found, false);
  assert.equal(result.messages.length, 3);
});

test('neighbor context distinguishes weak end marker repetitions', () => {
  const { trimMessagesThroughBoundary } = boundaryFixture();
  const rows = [
    { id: 'weak:1', role: 'assistant', text: 'same' },
    { id: 'weak:2', role: 'user', text: 'middle' },
    { id: 'weak:3', role: 'assistant', text: 'same' },
    { id: 'weak:4', role: 'user', text: 'after' }
  ];
  const result = trimMessagesThroughBoundary(rows, {
    kind: 'signature', key: 'assistant:same', contextBefore: ['user:middle']
  });
  assert.equal(result.found, true);
  assert.deepEqual(result.messages.map(x => x.text), ['same', 'middle', 'same']);
});

test('strong marked end remains unique despite identical texts', () => {
  const { trimMessagesThroughBoundary } = boundaryFixture();
  const rows = [
    { id: 'data-message-id:one', role: 'assistant', text: 'same' },
    { id: 'data-message-id:two', role: 'assistant', text: 'same' }
  ];
  const result = trimMessagesThroughBoundary(rows, {
    kind: 'stable', key: 'data-message-id:two'
  });
  assert.equal(result.found, true);
  assert.equal(result.messages.length, 2);
});

test('repeated weak two-message windows cannot falsely prove continuity', () => {
  const overlap = new Function(
    extract('navigationWindowsOverlap') + '; return navigationWindowsOverlap;'
  )();
  const ref = signature => ({ signature, strongId: '' });
  const before = ['a', 'b', 'a', 'b'].map(ref);
  const after = ['a', 'b', 'a', 'b'].map(ref);
  assert.equal(overlap(before, after), false);
});

test('unique weak neighboring pair remains sufficient when IDs are absent', () => {
  const overlap = new Function(
    extract('navigationWindowsOverlap') + '; return navigationWindowsOverlap;'
  )();
  const ref = signature => ({ signature, strongId: '' });
  assert.equal(overlap(['a','b','c'].map(ref), ['b','c','d'].map(ref)), true);
});

test('different immutable IDs with identical text do not prove overlap', () => {
  const overlap = new Function(
    extract('navigationWindowsOverlap') + '; return navigationWindowsOverlap;'
  )();
  const before = [
    { strongId: 'data-message-id:one', signature: 'repeat' },
    { strongId: 'data-message-id:two', signature: 'repeat' }
  ];
  const after = [
    { strongId: 'data-message-id:three', signature: 'repeat' },
    { strongId: 'data-message-id:four', signature: 'repeat' }
  ];
  assert.equal(overlap(before, after), false);
});

test('a measured small down-step can bridge adjacent tall single-message viewports', () => {
  const bridge = new Function(
    extract('smallPhysicalStepCanBridgeSingleTurn') + '; return smallPhysicalStepCanBridgeSingleTurn;'
  )();
  const before = [{ strongId: 'data-message-id:a', signature: 'first' }];
  const after = [{ strongId: 'data-message-id:b', signature: 'second' }];
  assert.equal(bridge(before, after, {
    moved: true, direction: 'down', before: 1200, after: 1320
  }), true);
});

test('single-message bridge rejects leaps, reverse steps, and missing movement proof', () => {
  const bridge = new Function(
    extract('smallPhysicalStepCanBridgeSingleTurn') + '; return smallPhysicalStepCanBridgeSingleTurn;'
  )();
  const a = [{ strongId: 'a' }];
  const b = [{ strongId: 'b' }];
  assert.equal(bridge(a,b,{ moved: true, direction: 'down', before: 1200, after: 1900 }), false);
  assert.equal(bridge(a,b,{ moved: true, direction: 'up', before: 1300, after: 1200 }), false);
  assert.equal(bridge(a,b,{ moved: false, direction: 'down', before: 1200, after: 1320 }), false);
  assert.equal(bridge(a,b,{ moved: true, direction: 'down', before: null, after: 120 }), false);
});

test('multiple disjoint message windows cannot claim continuity by pixel delta alone', () => {
  const bridge = new Function(
    extract('smallPhysicalStepCanBridgeSingleTurn') + '; return smallPhysicalStepCanBridgeSingleTurn;'
  )();
  const a = [{ strongId: 'a' }, { strongId: 'b' }];
  const b = [{ strongId: 'c' }, { strongId: 'd' }];
  assert.equal(bridge(a,b,{ moved: true, direction: 'down', before: 100, after: 180 }), false);
});
