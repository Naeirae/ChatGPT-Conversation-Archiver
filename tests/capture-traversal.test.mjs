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
