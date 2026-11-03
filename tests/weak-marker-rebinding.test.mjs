import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const begin = source.indexOf('const matching = anchors.filter');
const end = source.indexOf('if (!visibleStart) {', begin);
assert.ok(begin > 0 && end > begin);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const resolve = new AsyncFunction(
  'anchors', 'selectedFragment', 'strongStart', 'markerIdentityMatches',
  'normalizeMatchText', 'turnMessageText', 'progress',
  source.slice(begin, end) +
    '\nreturn { visibleStart, start: selectedFragment.start, fallback: Boolean(uniqueWeakText) };'
);
const text = 'Я спокойно на неё смотрю. Потом говорю: — Приветствую тебя, Севара. Баечки — это весело и удобно здесь.';

async function attempt(texts, strong = false) {
  const start = {
    id: strong ? 'data-message-id:old' : 'turn:old:user:signature',
    role: 'user',
    signature: 'same-signature',
    contextBefore: ['obsolete-neighbour']
  };
  const anchors = texts.map((value, i) => ({
    turn: { text: value },
    visible: true,
    anchor: {
      id: 'turn:new-' + i, role: 'user',
      signature: 'same-signature', contextBefore: ['new-neighbour']
    }
  }));
  return resolve(
    anchors, { start }, strong,
    (a,b) => a.id === b.id && a.contextBefore[0] === b.contextBefore[0],
    value => value, turn => turn.text, async () => {}
  );
}

test('unique substantial visible weak-marker text recovers from stale context', async () => {
  const result = await attempt([text]);
  assert.ok(result.visibleStart);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.start.contextBefore, []);
});

test('two identical submitted turns remain ambiguous, not merged or guessed', async () => {
  const result = await attempt([text, text]);
  assert.equal(result.visibleStart, null);
});

test('short weak marker is not silently rebound by text', async () => {
  const result = await attempt(['Ну давай.']);
  assert.equal(result.visibleStart, null);
});

test('strong immutable ID is never overridden by textual similarity', async () => {
  const result = await attempt([text], true);
  assert.equal(result.visibleStart, null);
});

test('final marked-start trim demands unique occurrence if context has been rebased', () => {
  assert.match(source, /function trimMessagesFromMarkedStart\(/);
  assert.match(source, /const index = uniqueBoundaryIndex\(rows, boundary\)/);
  assert.match(source, /return matches.length === 1 \? matches\[0\] : -1/);
});
