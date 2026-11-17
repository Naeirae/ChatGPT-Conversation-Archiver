import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

test('fragment walk never starts CDP screenshots while wheel scrolls', () => {
  const start = source.indexOf('  async function walkDown(');
  const end = source.indexOf('  async function ', start + 30);
  assert.ok(start >= 0 && end > start);
  const walk = source.slice(start, end);
  assert.doesNotMatch(walk, /captureVisibleRenderedImages|queueRenderedImageCapture/);
  assert.doesNotMatch(walk, /ARCHIVER_CAPTURE_RENDERED_IMAGE/);
  assert.match(walk, /firstTouchedIds = collect\(/);
  assert.match(walk, /secondTouchedIds = collect\(/);
  assert.match(source, /const fragmentImageDeferred = mode === 'fragment'/);
  assert.doesNotMatch(source, /finishPendingRenderedImageCapture|pendingRenderedImageCapture/);
});

test('fragment records image references for separate recovery without fetching binaries', () => {
  const begin = source.indexOf('  function captureTurn(');
  const end = source.indexOf('  async function blobToDataUrl(', begin);
  const capture = source.slice(begin,end);
  assert.match(capture, /const imageNodes = turnImageNodes\(turn, role\)/);
  assert.match(capture, /binaryStatus: 'pending'/);
  assert.match(capture, /extraBefore/);
  assert.match(capture, /extraAfter/);
  const finish = source.slice(source.indexOf('      const fragmentImageDeferred ='), source.indexOf('      const fragmentImageDeferred =') + 1300);
  assert.match(finish, /embedded: 0, failed: 0, unique: deferredSources\.size/);
  assert.match(finish, /: await hydrateMessageImages\(binaryTargetMessages/);
});

test('image recovery still implements independent rendered screenshot fallback', () => {
  const start = source.indexOf('  async function fetchImageBinary(');
  const end = source.indexOf('  async function hydrateMessageImages(',start);
  const fetch = source.slice(start, end);
  assert.match(fetch, /ARCHIVER_FETCH_IMAGE_BINARY/);
  assert.match(fetch, /return await captureRenderedImageBlob\(image\.src\)/);
  assert.match(source, /ARCHIVER_CAPTURE_RENDERED_IMAGE/);
  assert.match(worker, /async function captureRenderedImageForContent\(/);
});

test('offscreen duplicate is ignored by standalone image screenshot recovery', () => {
  const begin = source.indexOf('  function renderedImageNode(');
  const end = source.indexOf('  async function captureRenderedImageBlob(', begin);
  const rects = [
    { left: 10, top: -300, right: 400, bottom: -20, width: 390, height: 280 },
    { left: 10, top: 80, right: 400, bottom: 480, width: 390, height: 400 }
  ];
  const images = rects.map(rect => ({ getBoundingClientRect: () => rect }));
  const resolve = runInNewContext(source.slice(begin,end) + '\nrenderedImageNode', {
    String,
    document: { querySelectorAll: () => images, documentElement: { clientWidth:1200,clientHeight:800 } },
    window: { innerWidth:1200,innerHeight:800 },
    imageSource: () => 'https://cdn.example.org/picture.png'
  });
  assert.equal(resolve('https://cdn.example.org/picture.png'),images[1]);
});

test('physical wheel probe avoids expensive innerText and has scripted fallback', () => {
  const start = worker.indexOf('async function chatScrollMetrics(');
  const end = worker.indexOf('async function scriptedScrollChatTab(',start);
  const probe=worker.slice(start,end);
  assert.doesNotMatch(probe,/turn\.innerText|turn\.textContent/);
  assert.match(probe,/scrollportRight/);
  const wheelStart=worker.indexOf('async function physicalScrollTab(');
  const wheelEnd=worker.indexOf('async function withChatDebugger(',wheelStart);
  const wheel=worker.slice(wheelStart,wheelEnd);
  assert.match(wheel,/beforeMetrics\?\.scrollportRight/);
  assert.match(wheel,/scriptedScrollChatTab\(/);
});
