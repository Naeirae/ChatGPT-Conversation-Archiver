import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the real content-script functions against an image that stays in
// the viewport across many physical scroll windows.
const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, 'Missing start marker: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, 'Missing end marker: ' + endMarker);
  return source.slice(start, end);
}

function sequentialFixture({ recoverOnAttempt = Infinity } = {}) {
  let requests = 0;
  const src = 'https://images.example/large-image.png';
  const message = {
    text: 'A very long, independently captured message',
    images: [{ src, binaryStatus: 'pending', dataUrl: '' }]
  };
  const fetchMock = async targets => {
    requests++;
    const ready = requests >= recoverOnAttempt;
    for (const target of targets) {
      for (const image of target.images || []) {
        image.binaryStatus = ready ? 'ready' : 'failed';
        image.dataUrl = ready ? 'data:image/png;base64,ZmFrZQ==' : '';
      }
    }
    return { embedded: ready ? 1 : 0, failed: ready ? 0 : 1, unique: 1 };
  };
  const hydrateSequentialImages = new Function(
    'hydrateMessageImages', 'physicallyVisibleImageSources',
    between('  async function hydrateSequentialImages(', '\n  async function expandVisible(') +
      '\nreturn hydrateSequentialImages;'
  )(fetchMock, () => new Set([src]));
  return {
    message,
    src,
    hydrateSequentialImages,
    get requests() { return requests; }
  };
}

test('one failing visible image has a finite in-pass retry budget across 80 scroll windows', async () => {
  const f = sequentialFixture();
  const state = new Map();
  for (let step = 0; step < 80; step++) {
    await f.hydrateSequentialImages([f.message], state, {
      visibleOnly: true, walkStep: step
    });
  }
  assert.equal(f.requests, 2, 'failed image must not delay all 80 windows');
  assert.equal(f.message.images[0].binaryStatus, 'failed');
});

test('a transient failure gets a later viewport retry, not an immediate retry on every frame', async () => {
  const f = sequentialFixture({ recoverOnAttempt: 2 });
  const state = new Map();
  for (let step = 0; step < 8; step++) {
    await f.hydrateSequentialImages([f.message], state, { visibleOnly: true, walkStep: step });
  }
  assert.equal(f.requests, 1);
  await f.hydrateSequentialImages([f.message], state, { visibleOnly: true, walkStep: 8 });
  assert.equal(f.requests, 2);
  assert.equal(f.message.images[0].binaryStatus, 'ready');
});

test('a successfully embedded image is never fetched twice during the same walk', async () => {
  const f = sequentialFixture({ recoverOnAttempt: 1 });
  const state = new Map();
  for (let step = 0; step < 40; step++) {
    await f.hydrateSequentialImages([f.message], state, { visibleOnly: true, walkStep: step });
  }
  assert.equal(f.requests, 1);
  assert.equal(f.message.images[0].binaryStatus, 'ready');
});

test('finalization can retry deferred images after the in-pass budget is exhausted', async () => {
  let fetches = 0;
  const hydrateMessageImages = new Function(
    'state', 'fetchImageBinary', 'blobToDataUrl',
    'withCaptureOperationTimeout', 'progress',
    between('  async function hydrateMessageImages(', '\n  function physicallyVisibleImageSources(') +
      '\nreturn hydrateMessageImages;'
  )(
    { cancel: false },
    async () => { fetches++; return { size: 4, type: 'image/png' }; },
    async () => 'data:image/png;base64,ZmFrZQ==',
    async operation => operation,
    async () => ({ ok: true })
  );
  const message = { text: 'Preserved text', images: [{
    src: 'https://images.example/deferred.png',
    binaryStatus: 'failed', dataUrl: ''
  }] };
  const result = await hydrateMessageImages([message], {
    onlyMissing: true, reportProgress: false
  });
  assert.equal(fetches, 1);
  assert.deepEqual(result, { embedded: 1, failed: 0, unique: 1 });
  assert.equal(message.images[0].binaryStatus, 'ready');
  assert.equal(message.text, 'Preserved text');
});

test('even a final image failure does not discard captured message text', async () => {
  const hydrateMessageImages = new Function(
    'state', 'fetchImageBinary', 'blobToDataUrl',
    'withCaptureOperationTimeout', 'progress',
    between('  async function hydrateMessageImages(', '\n  function physicallyVisibleImageSources(') +
      '\nreturn hydrateMessageImages;'
  )(
    { cancel: false },
    async () => { throw new Error('offline'); },
    async () => '',
    async operation => operation,
    async () => ({ ok: true })
  );
  const message = { text: 'Must survive', images: [{
    src: 'https://images.example/offline.png', binaryStatus: 'pending'
  }] };
  const result = await hydrateMessageImages([message], { onlyMissing: true, reportProgress: false });
  assert.equal(result.failed, 1);
  assert.equal(message.text, 'Must survive');
  assert.equal(message.images[0].binaryStatus, 'failed');
});
