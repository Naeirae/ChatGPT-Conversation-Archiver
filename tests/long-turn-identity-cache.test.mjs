import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('  function turnStableKey(');
const end = source.indexOf('  function isStrongMessageId(', start);
assert.ok(start > 0 && end > start);
const wrapper = { getAttribute: attr => attr === 'data-turn-key' ? 'virtual-wrapper' : '' };
const turn = {
  isConnected: true, parentElement: {},
  closest: sel => sel === '[data-turn-key]' ? wrapper : null,
  querySelector: () => null,
  matches: () => false,
  getAttribute: () => ''
};
let textReads = 0;
const records = [];
const unchangedTurnCache = new WeakMap();
const getId = runInNewContext(source.slice(start, end) + '\nturnStableKey', {
  unchangedTurnCache,
  ROLE_SELECTOR: 'x',
  roleOf: () => 'assistant',
  turnMessageText: () => { textReads++; return 'large response with a visible picture'; },
  hashText: text => text,
  normalizeMatchText: text => text,
  String
});

test('unchanged mounted turn avoids repeated layout-text computation', () => {
  const expected = getId(turn);
  assert.equal(textReads, 1);
  unchangedTurnCache.set(turn, {
    id: expected, dirty: false, parent: turn.parentElement,
    wrapperKey: 'virtual-wrapper', role: 'assistant',
    observer: { takeRecords: () => records.splice(0) }
  });
  for (let i=0; i<150; i++) assert.equal(getId(turn), expected);
  assert.equal(textReads, 1, 'wheel settle polls must not read giant innerText');
});

test('mutation invalidates cached identity and recomputes message text', () => {
  records.push({ type: 'characterData' });
  getId(turn);
  assert.equal(textReads, 2);
  assert.equal(unchangedTurnCache.get(turn).dirty, true);
});

test('scroll trace retains diagnostic stages beyond first three wheel iterations', () => {
  const start = source.indexOf('      const traceWalkStage = async');
  const end = source.indexOf("      await traceWalkStage('wheel-verified'", start);
  const trace = source.slice(start, end);
  assert.ok(trace.includes('i % 10 !== 0'));
  assert.ok(trace.includes('imageInWindow'));
  assert.ok(trace.includes('walkDiagnosticStage: stage'));
});
