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
    state,
    window: { innerHeight: 700 },
    document: { querySelector: () => null, documentElement: { clientHeight: 700 } }
  };
  const collect = runInNewContext(collectorSource + '\ncollect', sandbox);
  const map = new Map();
  const order = [];
  return {
    map, order, state,
    scan: (turns, options = {}) => {
      mounted = turns.map(turn => typeof turn === 'string' ? { id: turn } : turn);
      return collect(map, order, {}, null, options);
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

test('physically adjacent downward step can continue a newly virtualized window without a DOM anchor', () => {
  const h = harness();
  h.scan(['marked-start','following-turn']);
  h.scan(['third-turn','fourth-turn'], { verifiedForwardStep: true });
  assert.deepEqual(h.order, ['marked-start','following-turn','third-turn','fourth-turn']);
});

test('an unverified jump still cannot append a disconnected viewport', () => {
  const h = harness();
  h.scan(['marked-start','following-turn']);
  assert.throws(() => h.scan(['unrelated-turn']), /не перекрывается/);
  assert.deepEqual(h.order, ['marked-start','following-turn']);
});

test('a one-sided middle anchor is not evidence of exact chronology', () => {
  const h = harness();
  h.scan(['a','b','c','d']);
  assert.throws(() => h.scan(['b','new-turn']), /Односторонняя привязка/);
  assert.deepEqual(h.order, ['a','b','c','d']);
});

test('main conversation wins over other visible role-bearing panels', () => {
  const h = harness();
  // The production collector is tested with a synthetic main region.
  // Existing offscreen and foreign panels must never enter the same archive.
  h.scan(['a','b']);
  assert.deepEqual(h.order, ['a','b']);
  assert.match(collectorSource, /mainContainsTurns/);
  assert.match(collectorSource, /main\.contains\(turn\)/);
});

test('one preloaded message immediately outside viewport is retained with chronological neighbours', () => {
  const h = harness();
  h.scan([
    { id: 'before', visible: false, getBoundingClientRect: () => ({ top: -110, bottom: -10 }) },
    { id: 'visible', visible: true },
    { id: 'after', visible: false, getBoundingClientRect: () => ({ top: 710, bottom: 780 }) }
  ]);
  assert.deepEqual(h.order, ['before', 'visible', 'after']);
});

test('far offscreen mounted turns do not contaminate captured window', () => {
  const h = harness();
  h.scan([
    { id: 'far-earlier', visible: false, getBoundingClientRect: () => ({ top: -3500, bottom: -2500 }) },
    { id: 'visible', visible: true },
    { id: 'far-later', visible: false, getBoundingClientRect: () => ({ top: 3000, bottom: 3200 }) }
  ]);
  assert.deepEqual(h.order, ['visible']);
});

test('full verification does not collect a new final viewport after reconciliation', () => {
  assert.match(source, /const finalTouchedIds = mode === 'full'\s*\? \[\]\s*: collect\(/);
});

test('start of a marked walk checkpoints text before image work', () => {
  const start = source.indexOf('  async function walkDown(');
  const end = source.indexOf('  function chooseAutomaticSplitMiddle(', start);
  const walk = source.slice(start, end);
  const first = walk.indexOf('const firstTouchedIds = collect(');
  const checkpoint = walk.indexOf('await saveRecoveryCheckpoint(map, order, boundary, { force: true });', first);
  const images = walk.indexOf('await hydrateSequentialImages(', first);
  assert.ok(first >= 0 && checkpoint > first && images > checkpoint,
    'initial text must be visible and checkpointed before image hydration');
});

test('physical down-step is independent chronology evidence when DOM overlap vanishes', () => {
  const sourceBlock = collectorSource;
  assert.match(sourceBlock, /verifiedForwardStep = false/);
  assert.match(sourceBlock, /!verifiedForwardStep/);
  const h = harness();
  h.scan(['first','second']);
  h.scan(['third'], { verifiedForwardStep: true });
  assert.deepEqual(h.order, ['first','second','third']);
});

