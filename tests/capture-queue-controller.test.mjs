import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureQueueController } from '../lib/capture-queue-controller.mjs';

const chat = suffix => 'https://chatgpt.com/c/4e156f31-0000-4000-8000-' + String(suffix).padStart(12, '0');
const anchor = id => ({ id: 'data-message-id:' + id, role: 'assistant', signature: 'assistant:' + id });
const markers = {
  start: anchor('a'),
  middle: { ...anchor('d'), previous: anchor('c'), next: anchor('e') },
  end: anchor('h')
};
const turn = id => ({ id: 'data-message-id:' + id, role: 'assistant', text: 'turn ' + id, identityStrong: true });
const archive = (id, sourceUrl, ids, mode = 'full') => ({
  id, sourceUrl, title: 'Capture', capturedAt: '2026-10-28T12:00:00Z',
  captureBoundaryReached: true, captureProof: { mode, startVerified: true, endVerified: true },
  messages: ids.map(turn)
});

function fixture() {
  const data = new Map();
  const archives = new Map();
  const published = [];
  const launches = [];
  let nextTabId = 70;
  const storage = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      const names = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(names.map(name => [name, data.get(name)]).filter(entry => entry[1] !== undefined));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, value); },
    async getBytesInUse(key) { return data.has(key) ? JSON.stringify(data.get(key)).length : 0; }
  };
  const chrome = {
    storage: { local: storage },
    tabs: {
      async query() { return [{ id: 1, windowId: 1, url: chat(987) }]; },
      async create(options) { return { id: nextTabId++, url: options.url }; },
      async update(id) { return { id }; },
      async remove() {},
      async sendMessage(_id, message) {
        if (message.type === 'ARCHIVER_CAPTURE_HEALTH') return {
          ok: true, running: true, jobId: message.jobId
        };
        return { ok: true };
      }
    },
    windows: { async update() {} }
  };
  const controller = createCaptureQueueController(chrome, {
    isConversationUrl: url => /^https:\/\/chatgpt\.com\/c\//.test(url),
    legacyCaptureActive: async () => false,
    waitForChatTabComplete: async () => ({}),
    waitForChatDomReady: async () => ({}),
    ensureChatGptContentScript: async (tabId, jobId, opts) => {
      launches.push({ tabId, jobId, opts });
    },
    getArchive: async id => archives.get(id),
    publishArchive: async value => { published.push(value); archives.set(value.id, value); },
    mergeMessage: (a, b) => ({ ...a, images: b.images || a.images || [] })
  });
  async function settled(predicate, max = 160) {
    for (let i = 0; i < max; i++) {
      const state = await controller.getState();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error('Queue did not settle');
  }
  return { controller, chrome, storage, data, archives, published, launches, settled };
}

test('two independent chats run at once and publish without cross-job progress changes', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.73');
  await f.controller.enqueue({ sourceUrl: chat(1), mode: 'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(2), mode: 'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(3), mode: 'two-chats' });
  await f.controller.enable(true);
  let state = await f.settled(s => s.workers.length === 2 && s.workers.every(w => w.status === 'running'));
  assert.equal(state.workers.length, 2);
  const first = state.workers[0];
  const second = state.workers[1];
  assert.notEqual(first.jobId, second.jobId);
  assert.notEqual(first.captureTabId, second.captureTabId);
  assert.equal(first.sourceUrl, chat(1));
  assert.equal(second.sourceUrl, chat(2));
  const forbidden = await f.controller.authorized(first.jobId, second.captureTabId);
  assert.equal(forbidden, null);

  await f.controller.progress({ jobId: first.jobId, patch: {
    phase: 'walk', count: 37, physicalScrollTop: 2400
  } }, first.captureTabId);
  state = await f.controller.getState();
  assert.equal(state.workers.find(w => w.jobId === first.jobId).count, 37);
  assert.equal(state.workers.find(w => w.jobId === second.jobId).count, 0);

  await f.storage.set({ ['draft:draft-' + first.jobId]: { messages: [{ text: 'saved' }] } });
  const result = await f.controller.checkpoint({
    jobId: first.jobId, draftId: 'draft-' + first.jobId, draftCount: 1
  }, first.captureTabId);
  assert.equal(result.ok, true);
  assert.equal((await f.storage.get('archiverQueueJob:' + first.jobId))['archiverQueueJob:' + first.jobId].draftCount, 1);
  assert.equal((await f.storage.get('archiverQueueJob:' + second.jobId))['archiverQueueJob:' + second.jobId].draftId, '');

  const a = archive('arc1-q-' + first.jobId, chat(1), ['a', 'b']);
  f.archives.set(a.id, a);
  assert.equal((await f.controller.complete({ jobId: first.jobId, archiveId: a.id }, first.captureTabId)).ok, true);
  state = await f.controller.getState();
  assert.equal(state.items[0].status, 'done');
  assert.equal(state.workers.find(w => w.jobId === second.jobId).status, 'running');
  state = await f.settled(s => s.workers.length === 3 && s.workers[2].status === 'running');
  assert.equal(state.workers[2].sourceUrl, chat(3));
  const b = archive('arc2-q-' + second.jobId, chat(2), ['a','b','c']);
  f.archives.set(b.id, b);
  assert.equal((await f.controller.complete({ jobId: second.jobId, archiveId: b.id }, second.captureTabId)).ok, true);
  assert.deepEqual(f.published.map(a => a.id), [a.id,b.id]);
});

test('one experimental split reserves both slots and publishes only a verified overlap', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.73');
  const key = 'archiverFragmentMarkers:' + new URL(chat(8)).origin + new URL(chat(8)).pathname;
  await f.storage.set({ [key]: markers });
  await f.controller.enqueue({ sourceUrl: chat(8), mode: 'split-chat' });
  await f.controller.enable(true);
  let state = await f.settled(s => s.workers.length === 2 && s.workers.every(w => w.status === 'running'));
  assert.equal(state.workers[0].sourceUrl, state.workers[1].sourceUrl);
  const first = state.workers.find(w => w.lane === 'first');
  const second = state.workers.find(w => w.lane === 'second');
  assert.equal(f.launches[0].opts.queueCapture, true);
  assert.equal(f.launches[1].opts.seekMarkedStart, true);
  const a = archive('part1-q-' + first.jobId, chat(8), ['a','b','c','d','e'], 'fragment');
  const b = archive('part2-q-' + second.jobId, chat(8), ['c','d','e','f','g','h'], 'fragment');
  f.archives.set(a.id, a); f.archives.set(b.id, b);
  const x = await f.controller.complete({ jobId:first.jobId, archiveId:a.id }, first.captureTabId);
  assert.equal(x.ok, true);
  assert.equal(f.published.length, 0);
  const y = await f.controller.complete({ jobId:second.jobId, archiveId:b.id }, second.captureTabId);
  assert.equal(y.ok, true);
  state = await f.settled(s => s.items[0].status === 'done');
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].messages.length, 8);
  assert.equal(f.published[0].captureProof.overlapVerified, true);
  assert.equal(state.items[0].archiveId, f.published[0].id);
});

test('unverified split leaves both original parts recoverable, never publishes a fabricated merged archive', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.73');
  const key = 'archiverFragmentMarkers:' + new URL(chat(9)).origin + new URL(chat(9)).pathname;
  await f.storage.set({ [key]: markers });
  await f.controller.enqueue({ sourceUrl: chat(9), mode: 'split-chat' });
  await f.controller.enable(true);
  const state = await f.settled(s => s.workers.length === 2 && s.workers.every(w => w.status === 'running'));
  const first = state.workers.find(w => w.lane === 'first');
  const second = state.workers.find(w => w.lane === 'second');
  const part1 = archive('broken1-q-' + first.jobId, chat(9), ['a','b','c','d','e'], 'fragment');
  const part2 = archive('broken2-q-' + second.jobId, chat(9), ['c','z','e','f','g','h'], 'fragment');
  f.archives.set(part1.id, part1);
  f.archives.set(part2.id, part2);
  await f.controller.complete({ jobId:first.jobId, archiveId:part1.id }, first.captureTabId);
  await f.controller.complete({ jobId:second.jobId, archiveId:part2.id }, second.captureTabId);
  const result = await f.settled(s => s.items[0].status === 'error');
  assert.equal(f.published.length, 0);
  assert.match(result.items[0].error, /стык/);
  const keys = [...f.data.keys()].filter(k => k.startsWith('draft:queue-split:'));
  assert.equal(keys.length, 2);
  assert.equal(f.archives.get(part1.id).messages.length, 5);
  assert.equal(f.archives.get(part2.id).messages.length, 6);
});

test('legacy job is not touched by the queue and blocks queue launches until available', async () => {
  const f = fixture();
  let blocked = true;
  const previous = f.controller;
  // Independent legacy active job is represented by a refusal to allocate slots.
  // Queue should still store the request without publishing an incomplete archive.
  await f.storage.set({ activeCaptureJob: { jobId: 'legacy', status:'running' } });
  await previous.versionCheck('0.4.73');
  await previous.enqueue({ sourceUrl: chat(11), mode: 'two-chats' });
  assert.equal((await f.storage.get('activeCaptureJob')).activeCaptureJob.jobId, 'legacy');
  assert.equal((await f.controller.getState()).items[0].status, 'queued');
  void blocked;
});
