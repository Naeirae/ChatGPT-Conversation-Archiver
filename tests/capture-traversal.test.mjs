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
    'mergeRicherCapture', 'matchesBoundary', 'turnTrailingEdgeVisible',
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
    'mergeRicherCapture', 'matchesBoundary', 'turnTrailingEdgeVisible',
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

function measuredScrollerFixture() {
  const advance = new Function(
    extract('measuredAdjacentScroll') + '; return measuredAdjacentScroll;'
  )();
  const element = { isConnected: true };
  const sample = top => ({
    element, top, clientHeight: 800, scrollHeight: 25000
  });
  const moved = { moved: true, direction: 'down' };
  return { advance, sample, moved };
}

test('physical motion through one very long message is progress without new messages', () => {
  const { advance, sample, moved } = measuredScrollerFixture();
  let top = 100;
  for (let i = 0; i < 40; i++) {
    assert.equal(advance(sample(top), sample(top + 120), moved), true);
    top += 120;
  }
});

test('short measured movement bridges adjacent multiple-turn windows', () => {
  const { advance, sample, moved } = measuredScrollerFixture();
  assert.equal(advance(sample(1200), sample(1320), moved), true);
});

test('physical evidence rejects jumps, reverse, missing motion and changed scroller', () => {
  const { advance, sample, moved } = measuredScrollerFixture();
  assert.equal(advance(sample(100), sample(780), moved), false);
  assert.equal(advance(sample(200), sample(100), moved), false);
  assert.equal(advance(sample(100), sample(120), { moved: false, direction: 'down' }), false);
  const otherScroller = { ...sample(120), element: {} };
  assert.equal(advance(sample(100), otherScroller, moved), false);
});

test('stationary long message is not mistaken for progress', () => {
  const { advance, sample, moved } = measuredScrollerFixture();
  assert.equal(advance(sample(100), sample(100), moved), false);
});

test('end marker is not physically reached when its tall message extends below viewport', () => {
  const check = new Function(
    'rectIntersectsCaptureViewport',
    extract('rectTrailingEdgeInsideCaptureViewport') +
    '; return rectTrailingEdgeInsideCaptureViewport;'
  )((rect, width, height, scrollportRect) => {
    const top = Math.max(0, scrollportRect?.top ?? 0);
    const bottom = Math.min(height, scrollportRect?.bottom ?? height);
    return rect.right > 0 && rect.left < width && rect.bottom > top &&
      rect.top < bottom;
  });
  assert.equal(check({ left: 0, right: 640, top: 110, bottom: 1800 }, 1280, 900), false);
  assert.equal(check({ left: 0, right: 640, top: -700, bottom: 820 }, 1280, 900), true);
});

test('end marker trailing edge must enter nested scrollport, not only page viewport', () => {
  const check = new Function(
    'rectIntersectsCaptureViewport',
    extract('rectTrailingEdgeInsideCaptureViewport') +
    '; return rectTrailingEdgeInsideCaptureViewport;'
  )((rect, width, height, port) =>
    rect.left < width && rect.right > 0 &&
    rect.bottom > Math.max(0, port?.top ?? 0) &&
    rect.top < Math.min(height, port?.bottom ?? height)
  );
  const scrollport = { top: 100, bottom: 650 };
  assert.equal(check({ left: 40, right: 800, top: 300, bottom: 820 }, 1280, 900, scrollport), false);
  assert.equal(check({ left: 40, right: 800, top: -300, bottom: 645 }, 1280, 900, scrollport), true);
});

test('unresponsive image/finalization acknowledgment is bounded by timeout', async () => {
  const withTimeout = new Function(
    'async ' + extract('withCaptureOperationTimeout') +
    '; return withCaptureOperationTimeout;'
  )();
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, 'Подтверждение обработки изображения'),
    /не получен ответ/
  );
});

test('end marker waits for sibling attachment beneath text root', () => {
  const doc = {
    documentElement: { clientWidth: 1280, clientHeight: 900 },
    body: {},
    scrollingElement: {}
  };
  const fakeWindow = { innerWidth: 1280, innerHeight: 900 };
  const root = { getBoundingClientRect: () => ({
    left: 0, right: 700, top: 100, bottom: 360
  }) };
  let imageBottom = 1400;
  const image = { getBoundingClientRect: () => ({
    left: 0, right: 700, top: 400, bottom: imageBottom,
    width: 700, height: imageBottom - 400
  }) };
  const turn = { isConnected: true };
  const reachesEnd = new Function(
    'contentRoot', 'roleOf', 'turnImageNodes', 'findScrollContainer',
    'rectIntersectsCaptureViewport', 'window', 'document',
    extract('rectTrailingEdgeInsideCaptureViewport') +
    extract('turnTrailingEdgeVisible') +
    '; return turnTrailingEdgeVisible;'
  )(
    () => root,
    () => 'assistant',
    () => [image],
    () => null,
    (rect, width, height) => rect.right > 0 && rect.left < width &&
      rect.bottom > 0 && rect.top < height,
    fakeWindow, doc
  );
  assert.equal(reachesEnd(turn), false);
  imageBottom = 800;
  assert.equal(reachesEnd(turn), true);
});
