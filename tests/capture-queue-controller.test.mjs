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

function fixture({
  legacyActive = async () => false,
  waitForDomReady = async () => {},
  waitForInjection = async () => {}
} = {}) {
  const data = new Map();
  let failFinalStateWrite = false;
  const failNextDoneStateWrite = () => { failFinalStateWrite = true; };
  const archives = new Map();
  const published = [];
  const launches = [];
  const backgroundWindows = [];
  const cancelledMessages = [];
  const removedTabs = [];
  const pausedJobs = new Set();
  let nextTabId = 70;
  let nextWindowId = 200;
  const storage = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(
        [...data].map(([key, value]) => [key, structuredClone(value)])
      );
      const names = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(names.map(name => [name, data.get(name)])
        .filter(entry => entry[1] !== undefined)
        .map(([key, value]) => [key, structuredClone(value)]));
    },
    async set(values) {
      const queueState = values.archiverCaptureQueueV1;
      if (failFinalStateWrite && queueState?.items?.some(item =>
        item.mode === 'split-chat' && item.status === 'done'
      )) {
        failFinalStateWrite = false;
        throw new Error('simulated MV3 service worker termination during final state write');
      }
      for (const [key, value] of Object.entries(values)) {
        data.set(key, structuredClone(value));
      }
    },
    async getBytesInUse(key) { return data.has(key) ? JSON.stringify(data.get(key)).length : 0; },
    async remove(key) { data.delete(key); }
  };
  const chrome = {
    storage: { local: storage },
    tabs: {
      async query() { return [{ id: 1, windowId: 1, url: chat(987) }]; },
      async create(options) { return { id: nextTabId++, url: options.url }; },
      async update(id) { return { id }; },
      async get(id) { return { id, url: chat(1), status:'complete' }; },
      async remove(id) { removedTabs.push(id); },
      async sendMessage(_id, message) {
        if (message.type === 'ARCHIVER_CANCEL_CAPTURE') {
          cancelledMessages.push({ tabId: _id, jobId: message.jobId });
          return { ok: true };
        }
        if (message.type === 'ARCHIVER_CAPTURE_HEALTH') return {
          ok: true, running: true, paused: pausedJobs.has(message.jobId),
          jobId: message.jobId
        };
        if (message.type === 'ARCHIVER_PAUSE_CAPTURE') {
          pausedJobs.add(message.jobId);
          return { ok: true, running: true, paused: true,
            jobId: message.jobId, checkpointSaved: true, draftCount: 12 };
        }
        if (message.type === 'ARCHIVER_RESUME_CAPTURE') {
          pausedJobs.delete(message.jobId);
          return { ok: true, running: true, resumed: true,
            jobId: message.jobId };
        }
        return { ok: true };
      }
    },
    windows: {
      async update() {},
      async remove() {},
      async create(options) {
        const created = {
          id: nextWindowId++,
          tabs: [{ id: nextTabId++, url: options.url }]
        };
        backgroundWindows.push({ ...options, windowId: created.id, tabId: created.tabs[0].id });
        return created;
      }
    }
  };
  const dependencies = {
    isConversationUrl: url => /^https:\/\/chatgpt\.com\/c\//.test(url),
    legacyCaptureActive: legacyActive,
    createUnfocusedCaptureWindow: async sourceUrl => {
      const created = await chrome.windows.create({
        url: sourceUrl, focused: false, type: 'normal', state: 'normal'
      });
      return { tab: created.tabs[0], windowId: created.id };
    },
    waitForChatTabComplete: async () => ({}),
    waitForChatDomReady: waitForDomReady,
    ensureChatGptContentScript: async (tabId, jobId, opts) => {
      launches.push({ tabId, jobId, opts });
      await waitForInjection(tabId, jobId, opts);
    },
    getArchive: async id => archives.get(id),
    publishArchive: async value => { published.push(value); archives.set(value.id, value); },
    mergeMessage: (a, b) => ({ ...a, images: b.images || a.images || [] })
  };
  const controller = createCaptureQueueController(chrome, dependencies);
  async function settled(predicate, max = 160) {
    for (let i = 0; i < max; i++) {
      const state = await controller.getState();
      if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error('Queue did not settle');
  }
  return {
    controller, chrome, storage, data, archives, published, launches, settled,
    backgroundWindows, cancelledMessages, removedTabs,
    failNextDoneStateWrite,
    freshController: () => createCaptureQueueController(chrome, dependencies)
  };
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

test('one failed chat does not stop its sibling or replace the completed archive index', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.73');
  await f.controller.enqueue({ sourceUrl: chat(21), mode: 'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(22), mode: 'two-chats' });
  await f.controller.enable(true);
  const state = await f.settled(s => s.workers.length === 2 && s.workers.every(w => w.status === 'running'));
  const [first, second] = state.workers;
  await f.controller.failed({
    jobId: first.jobId, error: 'network fail', draftId: 'draft-' + first.jobId
  }, first.captureTabId);
  const after = await f.controller.getState();
  assert.equal(after.workers[0].status, 'error');
  assert.equal(after.workers[1].status, 'running');
  assert.equal(after.items[0].status, 'error');
  assert.equal(after.items[1].status, 'running');
  const completed = archive('ok-q-' + second.jobId, chat(22), ['a','b']);
  f.archives.set(completed.id, completed);
  const result = await f.controller.complete({
    jobId: second.jobId, archiveId: completed.id
  }, second.captureTabId);
  assert.equal(result.ok, true);
  assert.deepEqual(f.published.map(a => a.id), [completed.id]);
});

test('a worker cannot publish a foreign or unverified archive', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.73');
  await f.controller.enqueue({ sourceUrl: chat(31), mode: 'two-chats' });
  await f.controller.enable(true);
  const s = await f.settled(q => q.workers.length === 1 && q.workers[0].status === 'running');
  const worker = s.workers[0];
  const foreign = archive('foreign-q-' + worker.jobId, chat(32), ['a']);
  f.archives.set(foreign.id, foreign);
  const result = await f.controller.complete({
    jobId: worker.jobId, archiveId: foreign.id
  }, worker.captureTabId);
  assert.equal(result.ok, false);
  assert.equal(f.published.length, 0);
  assert.equal((await f.controller.getState()).items[0].status, 'error');
});

test('the legacy capture blocks new queue slots without being overwritten', async () => {
  let blocked = true;
  const f = fixture({ legacyActive: async () => blocked });
  await f.storage.set({ activeCaptureJob: { jobId: 'legacy', status: 'running' } });
  await f.controller.versionCheck('0.4.73');
  await f.controller.enqueue({ sourceUrl: chat(11), mode: 'two-chats' });
  await f.controller.enable(true);
  assert.equal((await f.controller.getState()).workers.length, 0);
  assert.equal((await f.storage.get('activeCaptureJob')).activeCaptureJob.jobId, 'legacy');
  blocked = false;
  await f.controller.tick();
  await f.settled(s => s.workers.length === 1 && s.workers[0].status === 'running');
  assert.equal((await f.storage.get('activeCaptureJob')).activeCaptureJob.jobId, 'legacy');
});

test('independent queue lane pauses without freezing its sibling or losing a checkpoint', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.75');
  await f.controller.enqueue({ sourceUrl: chat(41), mode: 'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(42), mode: 'two-chats' });
  await f.controller.enable(true);
  let state = await f.settled(s => s.workers.length === 2 &&
    s.workers.every(w => w.status === 'running'));
  const [first, second] = state.workers;
  await f.storage.set({ ['draft:draft-' + first.jobId]: {
    id:'draft-' + first.jobId, messages:Array.from({length:12}, (_,i)=>({id:i}))
  } });
  await f.controller.checkpoint({
    jobId:first.jobId, draftId:'draft-' + first.jobId, draftCount:12
  },first.captureTabId);
  assert.equal((await f.controller.pause(first.itemId, first.lane)).ok, true);
  state = await f.controller.getState();
  assert.equal(state.workers[0].status, 'paused');
  assert.equal(state.workers[1].status, 'running');
  assert.equal(state.workers[0].draftCount, 12);
  assert.equal(state.items[0].status, 'paused');
  assert.equal(state.items[1].status, 'running');

  // In-flight progress from the paused page must not resurrect it.
  assert.equal((await f.controller.progress({
    jobId:first.jobId, patch: { phase:'walk', count:50 }
  },first.captureTabId)).ok, true);
  state = await f.controller.getState();
  assert.equal(state.workers[0].status, 'paused');
  assert.equal(state.workers[0].count, 0);
  await f.controller.progress({
    jobId:second.jobId, patch: { phase:'walk', count:40 }
  },second.captureTabId);
  assert.equal((await f.controller.getState()).workers[1].count,40);
  assert.equal((await f.controller.resume(first.itemId, first.lane)).ok,true);
  state = await f.controller.getState();
  assert.equal(state.workers[0].status,'running');
  assert.equal(state.workers[0].phase,'top');
});

test('retry one failed full chat reuses its saved draft without modifying the original', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.75');
  await f.controller.enqueue({ sourceUrl: chat(43), mode: 'two-chats' });
  await f.controller.enable(true);
  const before = await f.settled(s=>s.workers.length===1 && s.workers[0].status==='running');
  const worker = before.workers[0];
  const savedId = 'draft-' + worker.jobId;
  const saved = {
    id:savedId, sourceUrl:chat(43), captureMode:'full', capturePhase:'walk',
    captureBoundary:{kind:'stable',key:'data-message-id:final'},
    captureStartProof:{
      mode:'full',startVerified:true,snapshotEndVerified:true,startSource:'visible-first-turn'
    },
    messages:['a','b','c'].map(turn)
  };
  await f.storage.set({ ['draft:'+savedId]: saved });
  await f.controller.checkpoint({
    jobId:worker.jobId,draftId:savedId,draftCount:3
  },worker.captureTabId);
  await f.controller.failed({jobId:worker.jobId,error:'connection',draftId:savedId},worker.captureTabId);
  await f.controller.retry(worker.itemId);
  const after = await f.settled(s=>s.workers.length===1 &&
    s.workers[0].jobId!==worker.jobId && s.workers[0].status==='running');
  const next = after.workers[0];
  assert.equal(f.launches.length,2);
  assert.equal(f.launches[1].opts.mode,'resume-draft');
  assert.equal(f.launches[1].opts.existingDraftId,savedId);
  assert.deepEqual(f.launches[1].opts.fixedCaptureBoundary,saved.captureBoundary);
  assert.equal(next.recoveryDraftId,savedId);
  assert.deepEqual((await f.storage.get('draft:'+savedId))['draft:'+savedId],saved);
});

test('failed split lane resumes independently while verified completed lane is retained', async () => {
  const f=fixture();
  await f.controller.versionCheck('0.4.75');
  const sourceUrl=chat(44);
  const key='archiverFragmentMarkers:'+new URL(sourceUrl).origin+new URL(sourceUrl).pathname;
  await f.storage.set({[key]:markers});
  await f.controller.enqueue({sourceUrl,mode:'split-chat'});
  await f.controller.enable(true);
  const start=await f.settled(s=>s.workers.length===2 &&
    s.workers.every(w=>w.status==='running'));
  const first=start.workers.find(w=>w.lane==='first');
  const second=start.workers.find(w=>w.lane==='second');
  const part=archive('part-q-'+first.jobId,sourceUrl,['a','b','c','d','e'],'fragment');
  f.archives.set(part.id,part);
  assert.equal((await f.controller.complete({
    jobId:first.jobId,archiveId:part.id
  },first.captureTabId)).ok,true);
  const savedId='draft-'+second.jobId;
  const last=['c','d','e','f'].map(turn);
  const checkpoint={
    id:savedId,sourceUrl,captureMode:'fragment',capturePhase:'walk',
    captureRange:{start:markers.middle.previous,end:markers.end},
    captureBoundary:{kind:'stable',key:markers.end.id},
    captureStartProof:{
      mode:'fragment',startVerified:true,snapshotEndVerified:true,
      markedStartId:markers.middle.previous.id,markedEndId:markers.end.id
    },
    messages:last
  };
  await f.storage.set({['draft:'+savedId]:checkpoint});
  await f.controller.checkpoint({
    jobId:second.jobId,draftId:savedId,draftCount:last.length
  },second.captureTabId);
  await f.controller.failed({
    jobId:second.jobId,error:'offline',draftId:savedId
  },second.captureTabId);
  assert.equal((await f.controller.getState()).items[0].status,'error');
  await f.controller.retry(second.itemId);
  const resumed=await f.settled(s=>s.workers.length===2 &&
    s.workers.some(w=>w.lane==='second'&&w.jobId!==second.jobId&&w.status==='running'));
  assert.equal(resumed.workers.find(w=>w.lane==='first').jobId,first.jobId);
  assert.equal(f.launches.length,3);
  assert.equal(f.launches[2].opts.existingDraftId,savedId);
  assert.equal(f.launches[2].opts.mode,'resume-draft');
  const newer=resumed.workers.find(w=>w.lane==='second');
  const continued=archive('resumed-q-'+newer.jobId,sourceUrl,
    ['c','d','e','f','g','h'],'fragment');
  f.archives.set(continued.id,continued);
  assert.equal((await f.controller.complete({
    jobId:newer.jobId,archiveId:continued.id
  },newer.captureTabId)).ok,true);
  const result=await f.settled(s=>s.items[0].status==='done');
  assert.equal(result.items[0].archiveId,f.published[0].id);
  assert.deepEqual(f.published[0].messages.map(t=>t.text),
    ['a','b','c','d','e','f','g','h'].map(t=>'turn '+t));
  assert.equal((await f.storage.get('draft:'+savedId))['draft:'+savedId].messages.length,4);
});

test('a second successful split attempt publishes a new ID without overwriting the first archive', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.76');
  const sourceUrl = chat(57);
  const key = 'archiverFragmentMarkers:' + new URL(sourceUrl).origin +
    new URL(sourceUrl).pathname;
  await f.storage.set({ [key]: markers });
  await f.controller.enqueue({ sourceUrl, mode: 'split-chat' });
  await f.controller.enable(true);

  async function completeCurrentPair() {
    const state = await f.settled(s =>
      s.workers.length === 2 && s.workers.every(w => w.status === 'running'));
    const first = state.workers.find(w => w.lane === 'first');
    const second = state.workers.find(w => w.lane === 'second');
    const a = archive('first-q-' + first.jobId, sourceUrl, ['a','b','c','d','e'], 'fragment');
    const b = archive('second-q-' + second.jobId, sourceUrl, ['c','d','e','f','g','h'], 'fragment');
    f.archives.set(a.id,a); f.archives.set(b.id,b);
    assert.equal((await f.controller.complete({
      jobId:first.jobId, archiveId:a.id
    },first.captureTabId)).ok, true);
    assert.equal((await f.controller.complete({
      jobId:second.jobId, archiveId:b.id
    },second.captureTabId)).ok, true);
    return (await f.settled(s=>s.items[0].status==='done')).items[0].archiveId;
  }

  const firstId = await completeCurrentPair();
  const firstArchive = f.archives.get(firstId);
  await f.controller.retry((await f.controller.getState()).items[0].id);
  const secondId = await completeCurrentPair();
  assert.notEqual(firstId, secondId);
  assert.equal(f.published.length, 2);
  assert.strictEqual(f.archives.get(firstId),firstArchive);
  assert.deepEqual(f.archives.get(secondId).messages.map(m=>m.id),
    ['a','b','c','d','e','f','g','h'].map(id=>'data-message-id:'+id));
});

test('an interrupted service worker can finish the same split publication without new capture', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.76');
  const sourceUrl=chat(58);
  const key = 'archiverFragmentMarkers:' + new URL(sourceUrl).origin + new URL(sourceUrl).pathname;
  await f.storage.set({[key]:markers});
  await f.controller.enqueue({sourceUrl,mode:'split-chat'});
  await f.controller.enable(true);
  const state=await f.settled(s=>s.workers.length===2 &&
    s.workers.every(w=>w.status==='running'));
  const first=state.workers.find(w=>w.lane==='first');
  const second=state.workers.find(w=>w.lane==='second');
  const a=archive('a-q-'+first.jobId,sourceUrl,['a','b','c','d','e'],'fragment');
  const b=archive('b-q-'+second.jobId,sourceUrl,['c','d','e','f','g','h'],'fragment');
  f.archives.set(a.id,a);f.archives.set(b.id,b);
  await f.controller.complete({jobId:first.jobId,archiveId:a.id},first.captureTabId);
  // Simulate Chrome terminating the background worker after the merged
  // archive was published but before the final status write completed.
  f.failNextDoneStateWrite();
  await f.controller.complete({jobId:second.jobId,archiveId:b.id},second.captureTabId);
  let interrupted=await f.controller.getState();
  assert.equal(interrupted.items[0].status,'finalizing');
  assert.equal(interrupted.items[0].finalizationStarted,true);
  assert.equal(f.published.length,1);
  const publishedId=f.published[0].id;
  const other=f.freshController();
  await other.versionCheck('0.4.76');
  const recovered=await other.getState();
  assert.equal(recovered.items[0].status,'done');
  assert.equal(recovered.items[0].archiveId,publishedId);
  assert.equal(f.published.length,2); // same ID republished to finish incomplete index
  assert.equal(f.published[1].id,publishedId);
  assert.equal(f.archives.size,3);
  assert.equal(f.launches.length,2); // never re-scroll either page
});

test('two failed attempts never overwrite an earlier independently saved split-part draft', async () => {
  const f=fixture();
  await f.controller.versionCheck('0.4.76');
  const sourceUrl=chat(59);
  const key='archiverFragmentMarkers:'+new URL(sourceUrl).origin+new URL(sourceUrl).pathname;
  await f.storage.set({[key]:markers});
  await f.controller.enqueue({sourceUrl,mode:'split-chat'});
  await f.controller.enable(true);
  const itemId=(await f.controller.getState()).items[0].id;
  for(let attempt=0;attempt<2;attempt++){
    const state=await f.settled(s=>s.workers.length===2 &&
      s.workers.every(w=>w.status==='running'));
    const first=state.workers.find(w=>w.lane==='first');
    const second=state.workers.find(w=>w.lane==='second');
    const a=archive('bad-a-q-'+first.jobId,sourceUrl,['a','b','c','d','e'],'fragment');
    const b=archive('bad-b-q-'+second.jobId,sourceUrl,['c','z','e','f','g','h'],'fragment');
    f.archives.set(a.id,a); f.archives.set(b.id,b);
    await f.controller.complete({jobId:first.jobId,archiveId:a.id},first.captureTabId);
    await f.controller.complete({jobId:second.jobId,archiveId:b.id},second.captureTabId);
    const after=await f.settled(s=>s.items[0].status==='error');
    assert.match(after.items[0].error,/стык/);
    if(attempt===0) {
      const keys=[...f.data.keys()].filter(k=>k.startsWith('draft:queue-split:'));
      assert.equal(keys.length,2);
      await f.controller.retry(itemId);
    }
  }
  const keys=[...f.data.keys()].filter(k=>k.startsWith('draft:queue-split:'));
  assert.equal(keys.length,4);
  for(const id of keys) assert.ok(f.data.get(id).messages.length>=5);
  assert.equal(f.published.length,0);
});

test('navigation to a non-chat page retires just the affected worker', async () => {
  const f=fixture();
  await f.controller.versionCheck('0.4.76');
  await f.controller.enqueue({sourceUrl:chat(61),mode:'two-chats'});
  await f.controller.enqueue({sourceUrl:chat(62),mode:'two-chats'});
  await f.controller.enable(true);
  const state=await f.settled(s=>s.workers.length===2 &&
    s.workers.every(w=>w.status==='running'));
  await f.controller.tabNavigated(state.workers[0].captureTabId,'https://example.org/');
  const next=await f.controller.getState();
  assert.equal(next.workers[0].status,'error');
  assert.equal(next.workers[1].status,'running');
});

test('cancel during DOM readiness never launches a collector and releases its slot', async () => {
  let releaseDom, markDomReached;
  const domReached = new Promise(resolve => { markDomReached = resolve; });
  const blocked = new Promise(resolve => { releaseDom = resolve; });
  const f = fixture({
    waitForDomReady: async () => { markDomReached(); await blocked; }
  });
  await f.controller.versionCheck('0.4.76');
  await f.controller.enqueue({ sourceUrl: chat(71), mode: 'two-chats' });
  await f.controller.enable(true);
  await domReached;
  let state = await f.controller.getState();
  assert.equal(state.workers[0].status, 'starting');
  assert.ok(state.workers[0].captureTabId != null); // Window is allocated before DOM hydration.
  await f.controller.cancel(state.items[0].id);
  releaseDom();
  state = await f.settled(s => s.items[0].status === 'cancelled');
  assert.equal(state.workers[0].status, 'cancelled');
  assert.equal(f.launches.length, 0);
  assert.equal(f.removedTabs.length, 1);
  assert.equal(f.published.length, 0);
});

test('cancel while content-script injection is pending is delivered after injection too', async () => {
  let releaseInjection, markInjectionReached;
  const injectionReached = new Promise(resolve => { markInjectionReached = resolve; });
  const blocked = new Promise(resolve => { releaseInjection = resolve; });
  const f = fixture({
    waitForInjection: async () => { markInjectionReached(); await blocked; }
  });
  await f.controller.versionCheck('0.4.76');
  await f.controller.enqueue({ sourceUrl: chat(72), mode: 'two-chats' });
  await f.controller.enable(true);
  await injectionReached;
  const state = await f.controller.getState();
  const worker = state.workers[0];
  assert.equal(worker.status, 'starting');
  assert.ok(worker.captureTabId != null);
  await f.controller.cancel(worker.itemId);
  releaseInjection();
  await f.settled(s => f.cancelledMessages.length >= 2);
  assert.equal(f.cancelledMessages[0].jobId, worker.jobId);
  assert.equal(f.cancelledMessages[1].jobId, worker.jobId);
  await f.controller.failed({
    jobId:worker.jobId,status:'cancelled',error:'stopped'
  },worker.captureTabId);
  assert.equal((await f.controller.getState()).workers[0].status,'cancelled');
  assert.equal(f.published.length,0);
});

test('a stranded starting slot with no working tab is retired without touching drafts', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.76');
  const previousDraft = { id:'draft-old',messages:[{text:'save me'}] };
  await f.storage.set({
    'draft:draft-old':previousDraft,
    archiverCaptureQueueV1:{
      enabled:false,
      items:[{id:'stuck-item',sourceUrl:chat(73),mode:'two-chats',status:'starting'}],
      workers:[{
        jobId:'stuck-worker', itemId:'stuck-item', sourceUrl:chat(73),
        lane:'single', status:'starting', captureTabId:null,
        updatedAt:Date.now()-600000,startedAt:Date.now()-700000,
        draftId:'draft-old'
      }]
    }
  });
  await f.controller.tick();
  const state=await f.controller.getState();
  assert.equal(state.items[0].status,'error');
  assert.equal(state.workers[0].status,'error');
  assert.deepEqual((await f.storage.get('draft:draft-old'))['draft:draft-old'],previousDraft);
});

test('two queue collectors open their own visible unfocused windows and do not switch the user tab', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.77');
  await f.controller.enqueue({ sourceUrl: chat(81), mode: 'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(82), mode: 'two-chats' });
  await f.controller.enable(true);
  const state = await f.settled(s => s.workers.length === 2 &&
    s.workers.every(w => w.status === 'running'));
  assert.equal(f.backgroundWindows.length, 2);
  assert.ok(f.backgroundWindows.every(w => w.focused === false &&
    w.state === 'normal' && w.type === 'normal'));
  assert.notEqual(state.workers[0].captureWindowId, state.workers[1].captureWindowId);
  assert.equal(state.workers[0].captureWindowId, f.backgroundWindows[0].windowId);
  assert.equal(state.workers[1].captureWindowId, f.backgroundWindows[1].windowId);
});

test('both workers begin DOM hydration concurrently instead of waiting for each other', async () => {
  let entered = 0;
  let release;
  const block = new Promise(resolve => { release = resolve; });
  const f = fixture({
    waitForDomReady: async () => { entered++; await block; }
  });
  await f.controller.versionCheck('0.4.77');
  await f.controller.enqueue({ sourceUrl: chat(83), mode:'two-chats' });
  await f.controller.enqueue({ sourceUrl: chat(84), mode:'two-chats' });
  await f.controller.enable(true);
  const started = await f.settled(() => entered === 2);
  assert.equal(started.workers.length, 2);
  assert.equal(f.backgroundWindows.length,2);
  release();
  await f.settled(s => s.workers.every(w => w.status === 'running'));
});

test('automatic split first launches only a background planner with two user markers', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.77');
  const sourceUrl = chat(85);
  const key = 'archiverFragmentMarkers:' + new URL(sourceUrl).origin + new URL(sourceUrl).pathname;
  await f.storage.set({
    [key]: { start:markers.start, end:markers.end }
  });
  await f.controller.enqueue({ sourceUrl, mode:'split-chat' });
  await f.controller.enable(true);
  const planned = await f.settled(state =>
    state.workers.length===1 && state.workers[0].status==='running');
  assert.equal(planned.workers[0].lane,'planner');
  assert.equal(f.launches[0].opts.mode,'split-plan');
  assert.equal(planned.items[0].status,'running');
  const job = planned.workers[0];
  const result = await f.controller.planned({
    jobId:job.jobId,startId:markers.start.id,endId:markers.end.id,
    middle:markers.middle,visitedCount:8
  },job.captureTabId);
  assert.equal(result.ok,true);
  const next = await f.settled(state => state.workers.length===2 &&
    state.workers.every(worker => worker.status==='running'));
  assert.equal(next.items[0].captureRange.middle.id,markers.middle.id);
  assert.deepEqual(next.workers.map(w=>w.lane).sort(),['first','second']);
  assert.equal(f.backgroundWindows.length,3);
  assert.equal(f.launches.length,3);
});

test('split planner cannot alter the original marked boundaries or forge its sender', async () => {
  const f = fixture();
  await f.controller.versionCheck('0.4.77');
  const sourceUrl = chat(86);
  const key = 'archiverFragmentMarkers:' + new URL(sourceUrl).origin + new URL(sourceUrl).pathname;
  await f.storage.set({ [key]: { start:markers.start,end:markers.end } });
  await f.controller.enqueue({ sourceUrl,mode:'split-chat' });
  await f.controller.enable(true);
  const state = await f.settled(s=>s.workers.length===1&&s.workers[0].status==='running');
  const planner=state.workers[0];
  await assert.rejects(
    () => f.controller.planned({
      jobId:planner.jobId,startId:markers.start.id,endId:'data-message-id:wrong',
      middle:markers.middle
    },planner.captureTabId), /исходный диапазон/
  );
  await assert.rejects(
    () => f.controller.planned({
      jobId:planner.jobId,startId:markers.start.id,endId:markers.end.id,
      middle:markers.middle
    },planner.captureTabId+1), /не из его рабочей вкладки/
  );
  assert.equal((await f.controller.getState()).workers[0].lane,'planner');
});
