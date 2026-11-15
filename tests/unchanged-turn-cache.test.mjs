import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('  let unchangedTurnCache = new WeakMap();');
const end = source.indexOf('  function reusableVisibleCapture(', start);
assert.ok(start > 0 && end > start);
let observers = [];
class MockMutationObserver {
  constructor(callback) { this.callback = callback; this.records = []; this.disconnected = false; observers.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  takeRecords() { const records = this.records; this.records = []; return records; }
}
const funcs = runInNewContext(source.slice(start, end) +
  '\n({rememberUnchangedTurn,existingUnchangedTurn,resetUnchangedTurnCache})', {
  WeakMap, Set, MutationObserver: MockMutationObserver,
  roleOf: turn => turn.role
});
const parent = {};
const turn = { isConnected: true, parentElement: parent, role: 'assistant' };
const saved = { id: 'data-message-id:test', role: 'assistant', text: 'large' };
const map = new Map([[saved.id, saved]]);

test('unchanged DOM reuses exact captured object without re-parsing text', () => {
  funcs.rememberUnchangedTurn(turn, saved.id);
  assert.equal(funcs.existingUnchangedTurn(turn, map, {}), saved);
});

test('queued DOM mutations invalidate the unchanged capture', () => {
  const observer = observers.at(-1);
  observer.records.push({ type: 'characterData' });
  assert.equal(funcs.existingUnchangedTurn(turn, map, {}), null);
});

test('recycled parent, reasoning and disappeared map data never reuse capture', () => {
  funcs.rememberUnchangedTurn(turn, saved.id);
  assert.equal(funcs.existingUnchangedTurn(turn, map, { includeReasoning: true }), null);
  turn.parentElement = {};
  assert.equal(funcs.existingUnchangedTurn(turn, map, {}), null);
  turn.parentElement = parent;
  map.clear();
  assert.equal(funcs.existingUnchangedTurn(turn, map, {}), null);
});

test('observer cache is cleared after a run', () => {
  map.set(saved.id, saved);
  funcs.rememberUnchangedTurn(turn, saved.id);
  funcs.resetUnchangedTurnCache();
  assert.equal(funcs.existingUnchangedTurn(turn, map, {}), null);
  assert.ok(observers.every(item => item.disconnected));
});

test('collector selects mutation cache before expensive text/image signature', () => {
  const index = source.indexOf('  function collect(');
  const block = source.slice(index, source.indexOf('  function rebuildCaptureMap(', index));
  const quick = block.indexOf('existingUnchangedTurn(turn, map, settings)');
  const slow = block.indexOf('reusableVisibleCapture(turn, map, settings, mountedTurns)');
  assert.ok(quick >= 0 && slow > quick);
  assert.ok(block.includes('rememberUnchangedTurn(turn, messageId)'));
});
