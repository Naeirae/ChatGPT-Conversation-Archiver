import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const content = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const begin = content.indexOf('  let unchangedTurnCache = new WeakMap();');
const end = content.indexOf('  function reusableVisibleCapture(', begin);
assert.ok(begin >= 0 && end > begin);

function build() {
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.records = []; }
    observe() {}
    disconnect() {}
    takeRecords() { return this.records.splice(0); }
  }
  let scans = 0;
  let images = [{ src: 'https://cdn.example.org/picture.png', alt: 'Illustration' }];
  const parent = {};
  const root = { textContent: 'A long answer with a visible illustration', querySelector: () => images.length ? {} : null };
  const turn = {
    isConnected: true, parentElement: parent,
    querySelector: () => images.length ? {} : null,
    closest: () => null
  };
  const map = new Map([['data-message-id:one', {
    id: 'data-message-id:one', role: 'assistant',
    text: 'A long answer with a visible illustration',
    images: [{ src: images[0].src, alt: images[0].alt }]
  }]]);
  const functions = runInNewContext(content.slice(begin, end) +
      '\n({ rememberUnchangedTurn, existingUnchangedTurn, unchangedTurnCache })', {
    WeakMap, Set, String, MutationObserver: FakeObserver,
    state: { fragmentTextFirst: true },
    roleOf: () => 'assistant',
    contentRoot: () => root,
    turnImageNodes: () => { scans++; return images; },
    imageSource: image => image.src,
    isStrongMessageId: id => id.startsWith('data-message-id:')
  });
  functions.rememberUnchangedTurn(turn, 'data-message-id:one', [turn]);
  return { functions, map, turn, root, parent, get scans() { return scans; },
    setImages: next => { images = next; },
    markDirty: () => functions.unchangedTurnCache.get(turn).observer.records.push({type:'attributes'})
  };
}

test('visual image loader mutation reuses captured message without cloning or layout text', () => {
  const h = build();
  const original = h.map.get('data-message-id:one');
  h.markDirty();
  assert.equal(h.functions.existingUnchangedTurn(h.turn, h.map, {}, [h.turn]), original);
  assert.equal(h.functions.unchangedTurnCache.get(h.turn).dirty, false);
});

test('changed image source forces full recapture rather than silently using stale src', () => {
  const h = build();
  h.setImages([{src:'https://cdn.example.org/new-image.png', alt:'Illustration'}]);
  h.markDirty();
  assert.equal(h.functions.existingUnchangedTurn(h.turn,h.map,{},[h.turn]),null);
});

test('changed text forces full recapture while image source remains the same', () => {
  const h = build();
  h.root.textContent += ' New text';
  h.markDirty();
  assert.equal(h.functions.existingUnchangedTurn(h.turn,h.map,{},[h.turn]),null);
});

test('changed image alt forces recapture of metadata', () => {
  const h = build();
  h.setImages([{src:'https://cdn.example.org/picture.png', alt:'Different'}]);
  h.markDirty();
  assert.equal(h.functions.existingUnchangedTurn(h.turn,h.map,{},[h.turn]),null);
});

test('repeated collection avoids reinstalling observer when unchanged', () => {
  const h = build();
  const first = h.functions.unchangedTurnCache.get(h.turn);
  h.functions.rememberUnchangedTurn(h.turn, 'data-message-id:one', [h.turn]);
  assert.equal(h.functions.unchangedTurnCache.get(h.turn), first);
});
