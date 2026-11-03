import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('  function collect(map, order, settings, stopBoundary = null) {');
const end = source.indexOf('\n  function rebuildCaptureMap(', start);
assert.ok(start >= 0 && end > start, 'collector must be locatable in production content script');
const collectorSource = source.slice(start, end);

function harness() {
  let mounted = [];
  const state = { strictChronology: true };
  const sandbox = {
    orderedTurns: () => mounted,
    turnIntersectsCaptureViewport: turn => turn.visible !== false,
    captureTurn: turn => ({
      id: turn.id, role: turn.role || 'user',
      text: turn.text || turn.id, identityStrong: true
    }),
    identityContextsCompatible: () => true,
    mergeRicherCapture: (primary, previous) => ({ ...previous, ...primary }),
    turnTrailingEdgeVisible: () => true,
    matchesBoundary: () => false,
    messageTextSignature: item => item.id,
    hashText: text => text,
    state
  };
  const collect = runInNewContext(collectorSource + '\ncollect', sandbox);
  const map = new Map();
  const order = [];
  return {
    map, order, state,
    scan: turns => {
      mounted = turns.map(turn => typeof turn === 'string' ? { id: turn } : turn);
      return collect(map, order, {}, null);
    }
  };
}

test('later and earlier overlapping windows keep one chronological sequence', () => {
  const h = harness();
  h.scan(['a','b','c']);
  h.scan(['b','c','d']);
  h.scan(['a','b']);
  assert.deepEqual(h.order, ['a','b','c','d']);
});

test('late discovery of a middle turn inserts between proved neighbours', () => {
  const h = harness();
  h.scan(['a','b','d','e']);
  h.scan(['b','c','d']);
  assert.deepEqual(h.order, ['a','b','c','d','e']);
});

test('two user sends with exactly equal text but different IDs remain distinct', () => {
  const h = harness();
  h.scan([{ id: 'send-1', text: 'Повтор' }, { id: 'send-2', text: 'Повтор' }]);
  h.scan([{ id: 'send-2', text: 'Повтор' }, { id: 'reply', role: 'assistant' }]);
  assert.deepEqual(h.order, ['send-1', 'send-2', 'reply']);
});

test('an offscreen mounted turn is not saved', () => {
  const h = harness();
  h.scan([{ id: 'stale-sidebar', visible: false }, 'a', 'b']);
  assert.deepEqual(h.order, ['a','b']);
});

test('reversed known anchors stop capture without changing stored order', () => {
  const h = harness();
  h.scan(['a','b','c']);
  assert.throws(() => h.scan(['c','b']), /Нарушен порядок/);
  assert.deepEqual(h.order, ['a','b','c']);
});

test('disconnected window is not appended based on discovery time', () => {
  const h = harness();
  h.scan(['a','b']);
  assert.throws(() => h.scan(['x','y']), /не перекрывается/);
  assert.deepEqual(h.order, ['a','b']);
});

test('full verification does not collect a new final viewport after reconciliation', () => {
  assert.match(source, /const finalTouchedIds = mode === 'full'\s*\? \[\]\s*: collect\(/);
});
