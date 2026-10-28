import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('  function createContinuityWatchdog(');
const end = source.indexOf('  async function recoverDownwardContinuity(', start);
assert.ok(start >= 0 && end > start, 'Watchdog must be the executable runtime implementation');
const make = new Function(source.slice(start, end) + '\nreturn createContinuityWatchdog;')();
const scroller = {};
const sample = top => ({ element: scroller, top, clientHeight: 800, scrollHeight: 1000000 });
const ref = id => ({ strongId: 'data-message-id:' + id, signature: id });

test('a huge single message can advance for thousands of viewport steps without count changing', () => {
  const guard = make();
  for (let i = 0; i < 2500; i++) {
    guard.noteStep({
      before: sample(120 * i), after: sample(120 * (i + 1)),
      beforeRefs: [ref('one')], afterRefs: [ref('one')],
      adjacent: true, overlapping: true
    });
  }
  assert.equal(guard.metrics().forwardSteps, 2500);
  assert.equal(guard.metrics().stationarySteps, 0);
  assert.equal(guard.metrics().recoveriesWithoutAdvance, 0);
});

test('revisiting the same missing seam stops before an unbounded oscillation', () => {
  const guard = make();
  const first = sample(5130);
  const refs = [ref('a'), ref('b')];
  assert.equal(guard.beforeRecovery(first, refs).repeats, 1);
  assert.equal(guard.beforeRecovery(first, refs).repeats, 2);
  assert.throws(() => guard.beforeRecovery(first, refs), /Один и тот же стык/);
});

test('alternating different disconnected windows eventually stops unless real progression is proven', () => {
  const guard = make();
  for (let i = 0; i < 6; i++) {
    assert.doesNotThrow(() => guard.beforeRecovery(sample(i * 100), [ref('x' + i)]));
  }
  assert.throws(() => guard.beforeRecovery(sample(900), [ref('last')]), /Один и тот же стык/);
});

test('verified physical movement clears the recovery history and permits new frontiers', () => {
  const guard = make();
  for (let i = 0; i < 2; i++) guard.beforeRecovery(sample(300), [ref('a')]);
  const advance = guard.noteStep({
    before: sample(400), after: sample(520), beforeRefs: [ref('a')],
    afterRefs: [ref('a')], adjacent: true
  });
  assert.equal(advance.verifiedMovement, true);
  assert.equal(guard.beforeRecovery(sample(300), [ref('a')]).repeats, 1);
  assert.equal(guard.metrics().recoveriesWithoutAdvance, 1);
});

test('repeated stationary scrolls fail rather than burn the four-hour traversal timeout', () => {
  const guard = make();
  const snap = sample(1500);
  for (let i = 0; i < 7; i++) {
    guard.noteStep({ before:snap, after:snap, beforeRefs:[ref('one')], afterRefs:[ref('one')] });
  }
  assert.throws(() => guard.noteStep({
    before:snap, after:snap, beforeRefs:[ref('one')], afterRefs:[ref('one')]
  }), /Прокрутка не продвигается/);
});

test('DOM loading that changes content does not look like a stationary repeated viewport', () => {
  const guard = make();
  for (let i = 0; i < 100; i++) {
    guard.noteStep({
      before: sample(0), after: sample(0),
      beforeRefs:[ref('a'+i)], afterRefs:[ref('b'+i)]
    });
  }
  assert.equal(guard.metrics().stationarySteps, 0);
});

test('both the legacy full and marked-range traversal use watchdog recovery safeguards', () => {
  const fullStart = source.indexOf('  async function walkDownFullLegacy(');
  const fullEnd = source.indexOf('  async function walkDown(', fullStart);
  const markedStart = fullEnd;
  const markedEnd = source.indexOf('  async function seekQueueMarkedStart(', markedStart);
  const full = source.slice(fullStart, fullEnd);
  const marked = source.slice(markedStart, markedEnd);
  for (const [mode, code] of [['full',full], ['marked',marked]]) {
    assert.match(code, /createContinuityWatchdog\(\)/, mode);
    assert.match(code, /watchdog\.beforeRecovery\(/, mode);
    assert.match(code, /watchdog\.noteStep\(/, mode);
    assert.match(code, /recoverDownwardContinuity\(/, mode);
  }
});
