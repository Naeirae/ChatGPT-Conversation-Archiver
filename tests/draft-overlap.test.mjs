import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sameStoredTurn,
  sameDraftCaptureScope,
  verifiedChronologicalOverlap,
  mergeVerifiedTurns,
  mergeNewestCapturedTurn,
  groupVerifiedDraftComponents,
  groupVerifiedDraftWindows
} from '../lib/draft-overlap.mjs';

const words = Object.fromEntries('abcdefgh'.split('').map(letter => [
  letter, 'A distinctive long archived message, key ' + letter + ' with enough unique evidence.'
]));
const msg = (name, opts = {}) => ({
  role: opts.role || 'assistant',
  id: opts.weak ? 'weak:' + name : 'data-message-id:' + name,
  identityStrong: !opts.weak,
  text: opts.text ?? words[name]
});
const seq = (...keys) => keys.map(key => msg(key));

const scope = (sourceUrl, key = 'last') => ({
  sourceUrl,
  title: 'Одинаковое название',
  captureMode: 'fragment',
  capturePhase: 'walk',
  captureBoundary: { kind: 'stable', key },
  captureRange: {
    start: { id: 'first' },
    end: { id: 'last' }
  }
});

test('recognizes full prefix/containment without duplicating turns', () => {
  const left = seq('a', 'b', 'c', 'd');
  const right = seq('b', 'c');
  const alignment = verifiedChronologicalOverlap(left, right);
  assert.equal(alignment?.offset, 1);
  assert.deepEqual(
    mergeVerifiedTurns(left, right, alignment).messages.map(x => x.id),
    left.map(x => x.id)
  );
});

test('merges verified suffix-prefix windows in chronological order', () => {
  const left = seq('a', 'b', 'c', 'd');
  const right = seq('c', 'd', 'e', 'f');
  const alignment = verifiedChronologicalOverlap(left, right);
  assert.equal(alignment?.offset, 2);
  const merged = mergeVerifiedTurns(left, right, alignment);
  assert.deepEqual(merged.messages.map(x => x.text), seq('a','b','c','d','e','f').map(x => x.text));
  assert.equal(merged.rightEndIndex, 5);
  assert.equal(merged.leftEndIndex, 3);
});

test('merges windows starting earlier than the canonical draft', () => {
  const left = seq('c', 'd', 'e');
  const right = seq('a', 'b', 'c', 'd');
  const alignment = verifiedChronologicalOverlap(left, right);
  assert.equal(alignment?.offset, -2);
  assert.deepEqual(
    mergeVerifiedTurns(left, right, alignment).messages.map(x => x.id),
    seq('a','b','c','d','e').map(x => x.id)
  );
});

test('transitively connects overlapping drafts only through verified adjacency', () => {
  let messages = seq('a', 'b', 'c');
  for (const next of [seq('b', 'c', 'd'), seq('c', 'd', 'e')]) {
    const alignment = verifiedChronologicalOverlap(messages, next);
    assert.ok(alignment);
    messages = mergeVerifiedTurns(messages, next, alignment).messages;
  }
  assert.deepEqual(messages.map(x => x.id), seq('a','b','c','d','e').map(x => x.id));
});

test('identical repeated text with distinct strong turn IDs is never identity', () => {
  const equal = 'Exact same repeated text, long enough to seem like a unique message but not one.';
  assert.equal(sameStoredTurn(msg('a', { text: equal }), msg('b', { text: equal })), false);
  assert.equal(verifiedChronologicalOverlap(
    [msg('a', { text: equal }), msg('b', { text: equal })],
    [msg('c', { text: equal }), msg('d', { text: equal })]
  ), null);
});

test('repeated weak pairs with two possible placements fail closed', () => {
  const first = msg('a', { weak: true });
  const second = msg('b', { weak: true });
  assert.equal(verifiedChronologicalOverlap(
    [first, second, { ...first }, { ...second }],
    [{ ...first }, { ...second }]
  ), null);
});

test('short weak utterances cannot provide sufficient alignment evidence', () => {
  assert.equal(verifiedChronologicalOverlap(
    [msg('a', { weak: true, text: 'Да' }), msg('b', { weak: true, text: 'Ок' })],
    [msg('c', { weak: true, text: 'Да' }), msg('d', { weak: true, text: 'Ок' })]
  ), null);
});

test('different conversation IDs with identical titles never share a draft scope', () => {
  const a = scope('https://chatgpt.com/c/chat-one');
  const b = scope('https://chatgpt.com/c/chat-two');
  assert.equal(sameDraftCaptureScope(a, b), false);
  assert.equal(sameDraftCaptureScope(a, { ...b, sourceUrl: a.sourceUrl }), true);
});

test('different fixed lower boundaries or manual marks are never merged', () => {
  const a = scope('https://chatgpt.com/c/chat-one');
  assert.equal(sameDraftCaptureScope(a, scope(a.sourceUrl, 'another-end')), false);
  const b = scope(a.sourceUrl);
  b.captureRange = { start: { id: 'different' }, end: { id: 'last' } };
  assert.equal(sameDraftCaptureScope(a, b), false);
});

test('conflicting text under the same stable ID stops the join', () => {
  assert.equal(sameStoredTurn(
    msg('a', { text: 'A distinctly long original message.' }),
    msg('a', { text: 'A distinctly long edited message.' })
  ), false);
});


test('groups shifted attempts as one logical card without mutating source drafts', () => {
  const url = 'https://chatgpt.com/c/one-chat';
  const first = { ...scope(url), id: 'draft-a', messages: seq('a','b','c','d') };
  const second = { ...scope(url), id: 'draft-b', messages: seq('c','d','e','f'), captureMode: 'resume-draft' };
  const groups = groupVerifiedDraftWindows([first, second]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(x => x.id), ['draft-a', 'draft-b']);
  assert.equal(first.messages.length, 4);
  assert.equal(second.messages.length, 4);
});

test('a later bridge joins previously separate draft groups transitively', () => {
  const url = 'https://chatgpt.com/c/one-chat';
  const first = { ...scope(url), id: 'draft-a', messages: seq('a','b','c') };
  const last = { ...scope(url), id: 'draft-last', messages: seq('d','e','f') };
  const bridge = { ...scope(url), id: 'draft-bridge', messages: seq('b','c','d','e') };
  const groups = groupVerifiedDraftWindows([first, last, bridge]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(x => x.id), ['draft-a', 'draft-bridge', 'draft-last']);
});

test('same title and even equal content never group different conversation IDs', () => {
  const messages = seq('a','b','c');
  const a = { ...scope('https://chatgpt.com/c/first-chat'), id: 'first', messages };
  const b = { ...scope('https://chatgpt.com/c/second-chat'), id: 'second', messages };
  assert.equal(groupVerifiedDraftWindows([a,b]).length, 2);
});

test('different lower capture bounds stay separate despite matching messages', () => {
  const a = { ...scope('https://chatgpt.com/c/same-chat', 'first-end'), id: 'a', messages: seq('a','b','c') };
  const b = { ...scope('https://chatgpt.com/c/same-chat', 'second-end'), id: 'b', messages: seq('a','b','c') };
  assert.equal(groupVerifiedDraftWindows([a,b]).length, 2);
});

test('ambiguous weak repeated text does not merge an arbitrary draft group', () => {
  const url = 'https://chatgpt.com/c/same-chat';
  const pair = [msg('a', { weak: true }), msg('b', { weak: true })];
  const a = { ...scope(url), id: 'a', messages: [...pair, ...pair] };
  const b = { ...scope(url), id: 'b', messages: pair };
  assert.equal(groupVerifiedDraftWindows([a,b]).length, 2);
});


test('formatting differences in enumerated messages are not merged as identity', () => {
  const a = msg('a', { weak: true, text: '- apple\n- banana' });
  const b = msg('b', { weak: true, text: '1. apple\n2. banana' });
  assert.equal(sameStoredTurn(a, b), false);
});

test('large partially shifted windows use their unique chronological overlap', () => {
  const make = i => ({
    role: i % 2 ? 'assistant' : 'user',
    id: 'data-message-id:long-' + i,
    identityStrong: true,
    text: 'Substantial original archive message number ' + i + ' with independent text.'
  });
  const full = Array.from({ length: 3000 }, (_, i) => make(i));
  const left = full.slice(0, 2400);
  const right = full.slice(1500);
  const match = verifiedChronologicalOverlap(left, right);
  assert.equal(match?.offset, 1500);
  assert.equal(mergeVerifiedTurns(left, right, match).messages.length, 3000);
});


test('long repeated weak text never proves an overlap without a stable ID', () => {
  const a = [
    msg('a', { weak: true }),
    msg('b', { weak: true }),
    msg('c', { weak: true })
  ];
  const b = [
    msg('x', { weak: true, text: words.a }),
    msg('y', { weak: true, text: words.b }),
    msg('z', { weak: true, text: words.c })
  ];
  assert.equal(verifiedChronologicalOverlap(a, b), null);
  const left = { ...scope('https://chatgpt.com/c/shared-chat'), id: 'left', messages: a };
  const right = { ...scope('https://chatgpt.com/c/shared-chat'), id: 'right', messages: b };
  assert.equal(groupVerifiedDraftWindows([left, right]).length, 2);
});

test('one stable matching turn anchors neighbouring weak turns uniquely', () => {
  const left = [msg('a', { weak: true }), msg('b'), msg('c', { weak: true })];
  const right = [msg('b'), msg('c', { weak: true }), msg('d')];
  const aligned = verifiedChronologicalOverlap(left, right);
  assert.equal(aligned?.offset, 1);
  assert.equal(mergeVerifiedTurns(left, right, aligned).messages.length, 4);
});

test('display group counts use the entire verified window union', () => {
  const url = 'https://chatgpt.com/c/example';
  const first = { ...scope(url), id: 'one', messages: seq('a', 'b', 'c', 'd') };
  const second = { ...scope(url), id: 'two', messages: [
    ...seq('c','d'), { ...msg('e'), images: [{ src: 'image-1', binaryStatus: 'ready', dataUrl: 'data:image/png;base64,AA==' }] },
    msg('f')
  ] };
  const groups = groupVerifiedDraftComponents([first, second], (a,b) => ({
    ...a, images: [...(a.images || []), ...(b.images || [])]
  }));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].messages.length, 6);
  assert.equal(groups[0].messages.reduce((n, turn) => n + (turn.images?.length || 0), 0), 1);
  assert.equal(first.messages.length, 4);
});

test('newer checkpoint image bytes override equally ready older image bytes', () => {
  const oldTurn = {
    ...msg('a'), __captureTime: 100,
    images: [{ src: 'img', binaryStatus: 'ready', dataUrl: 'old-image' }]
  };
  const newTurn = {
    ...msg('a'), __captureTime: 200,
    images: [{ src: 'img', binaryStatus: 'ready', dataUrl: 'new-image' }]
  };
  const merge = (primary, alternate) => ({
    ...primary,
    images: [...(primary.images || []), ...(alternate.images || []).filter(
      i => !(primary.images || []).some(j => j.src === i.src)
    )]
  });
  assert.equal(
    mergeNewestCapturedTurn(oldTurn, newTurn, merge).images[0].dataUrl,
    'new-image'
  );
  assert.equal(
    mergeNewestCapturedTurn(newTurn, oldTurn, merge).images[0].dataUrl,
    'new-image'
  );
});

test('joins saved drafts with one uniquely shared stable turn', () => {
  const left = seq('a', 'b', 'c');
  const right = seq('c', 'd', 'e');
  const aligned = verifiedChronologicalOverlap(left, right);
  assert.equal(aligned?.offset, 2);
  assert.deepEqual(mergeVerifiedTurns(left, right, aligned).messages.map(m => m.id),
    seq('a','b','c','d','e').map(m => m.id));
  const url = 'https://chatgpt.com/c/one-turn-bridge';
  const groups = groupVerifiedDraftWindows([
    { ...scope(url), id: 'old', messages: left },
    { ...scope(url), id: 'new', messages: right }
  ]);
  assert.equal(groups.length, 1);
});

test('does not merge single shared weak text or ambiguous repeated stable IDs', () => {
  assert.equal(verifiedChronologicalOverlap(
    [msg('a', { weak: true })], [msg('a', { weak: true })]), null);
  const duplicated = [msg('a'), msg('b'), msg('a')];
  assert.equal(verifiedChronologicalOverlap(duplicated, [msg('a')]), null);
});
