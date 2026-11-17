import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const begin = source.indexOf('  async function captureVisibleRenderedImages(');
const end = source.indexOf('  async function hydrateSequentialImages(', begin);
assert.ok(begin > 0 && end > begin);
const code = source.slice(begin, end) + '\ncaptureVisibleRenderedImages';

function harness({ response, visible = true } = {}) {
  const sent = [];
  const node = {
    complete: true, naturalWidth: 1024,
    getBoundingClientRect: () => visible
      ? { left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400 }
      : { left: 10, top: 20, right: 510, bottom: 1120, width: 500, height: 1100 }
  };
  const capture = runInNewContext(code, {
    Map, Set, String, Number,
    state: { fragmentTextFirst: true, jobId: 'job-1', queueCapture: false },
    document: { documentElement: { clientWidth: 1200, clientHeight: 800 } },
    window: { innerWidth: 1200, innerHeight: 800 },
    renderedImageNode: () => node,
    withCaptureOperationTimeout: operation => operation,
    chrome: { runtime: { sendMessage: async message => {
      sent.push(message);
      return response || { ok: true, dataUrl: 'data:image/png;base64,QUJD', byteSize: 3, mimeType: 'image/png' };
    } } }
  });
  const image = { src: 'https://cdn.example.org/protected.png', binaryStatus: 'pending', dataUrl: '' };
  const saved = { id: 'data-message-id:one', role: 'assistant', text: 'Text alongside image', images: [image] };
  const map = new Map([[saved.id, saved]]);
  return { capture, map, image, sent };
}

test('visible CDN image is captured as actual PNG bytes without fetching its 403 URL', async () => {
  const { capture, map, image, sent } = harness();
  const attempts = new Map();
  const result = await capture(map, ['data-message-id:one'], attempts, 4);
  assert.equal(result.ready, 1);
  assert.equal(image.binaryStatus, 'ready');
  assert.equal(image.dataUrl, 'data:image/png;base64,QUJD');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.src, 'https://cdn.example.org/protected.png');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ARCHIVER_CAPTURE_RENDERED_IMAGE');
  assert.equal(sent[0].rect.width, 500);
  assert.equal(map.get('data-message-id:one').text, 'Text alongside image');
  await capture(map, ['data-message-id:one'], attempts, 5);
  assert.equal(sent.length, 1, 'ready image is not re-requested on each scroll step');
});

test('clipped screenshot is never mislabeled as a complete image', async () => {
  const { capture, map, image, sent } = harness({ visible: false });
  const result = await capture(map, ['data-message-id:one'], new Map(), 4);
  assert.equal(result.pending, 1);
  assert.equal(image.binaryStatus, 'pending');
  assert.equal(sent.length, 0);
});

test('failed screenshot leaves original image and text for later recovery', async () => {
  const { capture, map, image, sent } = harness({ response: { ok: false, error: 'No pixels' } });
  const attempts = new Map();
  const result = await capture(map, ['data-message-id:one'], attempts, 4);
  assert.equal(result.pending, 1);
  assert.equal(image.binaryStatus, 'pending');
  assert.equal(image.dataUrl, '');
  assert.equal(image.src, 'https://cdn.example.org/protected.png');
  assert.equal(sent.length, 1);
  await capture(map, ['data-message-id:one'], attempts, 5);
  assert.equal(sent.length, 1, 'a failed image is not retried on every 220px step');
});

test('fragment walk visits rendered-image acquisition during unchanged long messages', () => {
  const start = source.indexOf('  async function walkDown(');
  const end = source.indexOf('  async function ', start + 30);
  const walk = source.slice(start, end);
  assert.match(walk, /captureVisibleRenderedImages\(map, firstTouchedIds, renderedImageAttempts, i \* 2\)/);
  assert.match(walk, /captureVisibleRenderedImages\(map, secondTouchedIds, renderedImageAttempts, i \* 2 \+ 1\)/);
  assert.match(source, /const fragmentImageDeferred = mode === 'fragment'/);
});

test('rendered image lookup ignores offscreen duplicate with matching source URL', () => {
  const first = source.indexOf('  function renderedImageNode(');
  const last = source.indexOf('  async function captureRenderedImageBlob(', first);
  const rects = [
    { left: 10, top: -300, right: 400, bottom: -20, width: 390, height: 280 },
    { left: 10, top: 80, right: 400, bottom: 480, width: 390, height: 400 }
  ];
  const images = rects.map(rect => ({ getBoundingClientRect: () => rect }));
  const resolve = runInNewContext(source.slice(first, last) + '\nrenderedImageNode', {
    String, document: { querySelectorAll: () => images,
      documentElement: { clientWidth: 1200, clientHeight: 800 } },
    window: { innerWidth: 1200, innerHeight: 800 },
    imageSource: () => 'https://cdn.example.org/protected.png'
  });
  assert.equal(resolve('https://cdn.example.org/protected.png'), images[1]);
});

test('background scroll probe does not read layout-forcing innerText of image turns', () => {
  const worker = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  const begin = worker.indexOf('async function chatScrollMetrics(');
  const end = worker.indexOf('async function scriptedScrollChatTab(', begin);
  const probe = worker.slice(begin, end);
  assert.ok(begin >= 0 && end > begin);
  assert.doesNotMatch(probe, /turn\.innerText|turn\.textContent/);
  assert.match(probe, /scrollportRight/);
  const wheelBegin = worker.indexOf('async function physicalScrollTab(');
  const wheelEnd = worker.indexOf('async function withChatDebugger(', wheelBegin);
  const wheel = worker.slice(wheelBegin, wheelEnd);
  assert.match(wheel, /beforeMetrics\?\.scrollportRight/);
  assert.match(wheel, /scriptedScrollChatTab\(/);
  assert.match(wheel, /fallbackMoved \|\| fallbackAtEdge/);
});
