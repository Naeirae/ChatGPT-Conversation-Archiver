import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
function between(source, start, end, last = false) {
  const a = last ? source.lastIndexOf(start) : source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Could not isolate real executable source: ' + start);
  return source.slice(a, b);
}

function workerFixture({ status = 'running', pagePause, pageResume, health } = {}) {
  let job = {
    jobId: 'capture-117', status, captureTabId: 40, sourceTabId: 35,
    tabId: 35, draftId: 'draft-capture-117', captureMode: 'fragment',
    count: 117, phase: status === 'paused' ? 'paused' : 'walk',
    resumePhase: 'walk', sourceUrl: 'https://chatgpt.com/c/example'
  };
  let finishCalls = 0;
  const calls = [];
  const chrome = {
    tabs: {
      async sendMessage(tab, message) {
        calls.push([tab, message.type]);
        if (message.type === 'ARCHIVER_PAUSE_CAPTURE') return pagePause ?? {
          ok: true, paused: true, running: true, jobId: job.jobId,
          checkpointSaved: true, draftCount: 117
        };
        if (message.type === 'ARCHIVER_RESUME_CAPTURE') return pageResume ?? {
          ok: true, resumed: true, running: true, jobId: job.jobId
        };
        throw new Error('Unknown request');
      }
    }
  };
  const methods = new Function(
    'getJob', 'chrome', 'probeLiveCapture', 'getDraft',
    'finishJobWithError', 'appendRunLog',
    between(workerSource, 'async function pauseCapture() {', '\nasync function resetCaptureState() {') +
    '\nreturn { pauseCapture, resumeCapture };'
  )(
    async () => job,
    chrome,
    async () => health === undefined
      ? { ok: true, running: true, paused: true, jobId: job.jobId } : health,
    async () => ({ id: job.draftId, messages: Array.from({ length: 117 }, (_, i) => ({ id: i })) }),
    async (_jobId, _tabId, message, draftId, count) => {
      finishCalls++;
      job = { ...job, status: 'error', draftId, draftCount: count, message };
      return { job };
    },
    async patch => {
      job = { ...job, ...patch };
      return job;
    }
  );
  return { ...methods, get job() { return job; }, get finishCalls() { return finishCalls; }, calls };
}

test('dead content script cannot be turned into a ghost paused job', async () => {
  const f = workerFixture({
    pagePause: { ok: true, paused: false, running: false, jobId: 'capture-117' },
    health: { ok: true, paused: false, running: false, jobId: 'capture-117' }
  });
  await assert.rejects(() => f.pauseCapture(), /Скрипт сбора уже не работает/);
  assert.equal(f.job.status, 'error');
  assert.equal(f.finishCalls, 1);
  assert.equal(f.job.draftCount, 117);
});

test('stale running badge is reconciled when another collector owns the page', async () => {
  const f = workerFixture({
    pagePause: { ok: false, paused: false, running: false,
      jobId: 'previous-collector', error: 'Активный сбор для постановки на паузу не найден.' },
    health: { ok: true, running: true, paused: false,
      jobId: 'another-collector' }
  });
  await assert.rejects(() => f.pauseCapture(), /Статус обновлён/);
  assert.equal(f.job.status, 'error');
  assert.equal(f.job.draftCount, 117);
  assert.equal(f.finishCalls, 1);
});

test('pause is only marked after live acknowledgement and forced checkpoint', async () => {
  const f = workerFixture();
  const paused = await f.pauseCapture();
  assert.equal(paused.job.status, 'paused');
  assert.equal(paused.job.pauseCheckpointSaved, true);
  assert.equal(paused.job.pauseCheckpointCount, 117);
  assert.deepEqual(f.calls.map(x => x[1]), ['ARCHIVER_PAUSE_CAPTURE']);
  const resumed = await f.resumeCapture();
  assert.equal(resumed.job.status, 'running');
  assert.equal(resumed.job.phase, 'walk');
  assert.deepEqual(f.calls.map(x => x[1]), [
    'ARCHIVER_PAUSE_CAPTURE', 'ARCHIVER_RESUME_CAPTURE'
  ]);
});

test('a dead collector on resume becomes a recoverable error, never false success', async () => {
  const f = workerFixture({
    status: 'paused',
    health: { ok: true, paused: false, running: false, jobId: 'capture-117' }
  });
  await assert.rejects(() => f.resumeCapture(), /Контрольная точка оставлена/);
  assert.equal(f.job.status, 'error');
  assert.equal(f.job.draftCount, 117);
  assert.equal(f.finishCalls, 1);
});

test('an ambiguous slow health probe preserves the paused job and its draft', async () => {
  const f = workerFixture({ status: 'paused', health: null });
  await assert.rejects(() => f.resumeCapture(), /не подтвердила живой сбор/);
  assert.equal(f.job.status, 'paused');
  assert.equal(f.finishCalls, 0);
});

test('already-running content script reconciles an outdated paused worker status', async () => {
  const f = workerFixture({
    status: 'paused',
    health: { ok: true, running: true, paused: false, jobId: 'capture-117' }
  });
  const resumed = await f.resumeCapture();
  assert.equal(resumed.job.status, 'running');
  assert.equal(f.calls.length, 0);
});

test('worker acknowledges buffered progress after pause without changing status', async () => {
  const source = between(
    workerSource, "      case 'ARCHIVER_CAPTURE_PROGRESS': {",
    "      case 'ARCHIVER_PHYSICAL_SCROLL': {", true
  );
  let writes = 0;
  const exec = new AsyncFunction('message', 'sender', 'getJob', 'setJob', 'appendRunLog',
    'switch(message.type) {\n' + source + '\n}\nreturn null;');
  const current = {
    status: 'paused', jobId: 'capture-117', captureTabId: 40
  };
  const result = await exec({
    type: 'ARCHIVER_CAPTURE_PROGRESS', jobId: current.jobId,
    patch: { status: 'running', phase: 'walk', count: 118 }
  }, { tab: { id: 40 } }, async () => current,
  async () => { writes++; }, async () => { writes++; });
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
  assert.equal(writes, 0);
  assert.equal(current.status, 'paused');
});

test('paused worker identifies a wheel race distinctly without moving the page', async () => {
  const source = between(
    workerSource, "      case 'ARCHIVER_PHYSICAL_SCROLL': {",
    "      case 'ARCHIVER_PHYSICAL_CLICK': {", true
  );
  let scrolled = 0;
  const exec = new AsyncFunction('message', 'sender', 'getJob', 'chrome',
    'conversationKey', 'setJob', 'physicalScrollTab',
    'switch(message.type) {\n' + source + '\n}\nreturn null;');
  const reply = await exec({
    type: 'ARCHIVER_PHYSICAL_SCROLL', jobId: 'capture-117'
  }, { tab: { id: 40 } },
  async () => ({ status: 'paused', jobId: 'capture-117', captureTabId: 40 }),
  { tabs: { async get() { return { url: 'https://chatgpt.com/c/example' }; } } },
  url => url, async () => {},
  async () => { scrolled++; });
  assert.deepEqual(reply, { ok: false, paused: true, error: 'CAPTURE_PAUSED' });
  assert.equal(scrolled, 0);
});

test('content script retries an in-flight paused wheel step after resume', async () => {
  const source = between(
    pageSource, '    async function physicalScroll({',
    '\n    return Object.freeze({'
  );
  let requests = 0, settles = 0, waits = 0;
  const fn = new Function('chrome', 'state', 'waitIfPaused', 'sleep', 'waitForTurnSettle',
    source + '\nreturn physicalScroll;'
  )(
    { runtime: { async sendMessage() {
      requests++;
      return requests === 1
        ? { ok: false, paused: true, error: 'CAPTURE_PAUSED' }
        : { ok: true, moved: true };
    } } },
    { queueCapture: false },
    async () => { waits++; },
    async () => {},
    async () => { settles++; }
  );
  const result = await fn({ jobId: 'capture-117', direction: 'down' });
  assert.equal(result.moved, true);
  assert.equal(requests, 2);
  assert.equal(settles, 1);
  assert.ok(waits >= 2);
});

test('content script refuses to acknowledge a pause if no collector runs', () => {
  const source = between(
    pageSource, "    if (message && message.type === 'ARCHIVER_PAUSE_CAPTURE') {",
    "    if (message && message.type === 'ARCHIVER_CANCEL_CAPTURE') {"
  );
  let reply;
  const handle = new Function('message', 'state', 'sendResponse', 'makePauseCheckpoint', 'chrome',
    source + '\nreturn false;');
  const result = handle({ type: 'ARCHIVER_PAUSE_CAPTURE', jobId: 'capture-117' },
    { running: false, jobId: null }, value => { reply = value; }, () => ({}), {});
  assert.equal(result, false);
  assert.equal(reply.ok, false);
  assert.equal(reply.paused, false);
});

test('content script writes a pause snapshot before acknowledging the live collector', async () => {
  const source = between(
    pageSource, "    if (message && message.type === 'ARCHIVER_PAUSE_CAPTURE') {",
    "    if (message && message.type === 'ARCHIVER_CANCEL_CAPTURE') {"
  );
  let saveCount = 0, draft = null;
  const state = {
    running: true, jobId: 'capture-117', paused: false, queueCapture: false,
    pauseSnapshotWriter: async () => {
      saveCount++;
      draft = { messages: Array.from({ length: 117 }, (_, i) => ({ id: i })) };
    }
  };
  const chrome = { storage: { local: {
    async get(key) {
      if (key === 'activeCaptureJob') return {
        activeCaptureJob: { jobId: 'capture-117', draftId: 'draft-capture-117' }
      };
      if (key === 'draft:draft-capture-117') return { [key]: draft };
      return {};
    }
  } } };
  const handler = new Function('message', 'state', 'sendResponse', 'makePauseCheckpoint', 'chrome',
    source + '\nreturn false;');
  const reply = await new Promise(resolve => {
    assert.equal(handler({ type: 'ARCHIVER_PAUSE_CAPTURE', jobId: 'capture-117' },
      state, resolve, () => ({ tail: ['one'] }), chrome), true);
  });
  assert.equal(saveCount, 1);
  assert.equal(state.paused, true);
  assert.equal(reply.ok, true);
  assert.equal(reply.running, true);
  assert.equal(reply.checkpointSaved, true);
  assert.equal(reply.draftCount, 117);
});

test('paused UI summary retains the saved walk phase and offers export of its draft', () => {
  const summary = between(
    workerSource, 'function liveUnfinishedSummary(job) {',
    '\nasync function deleteUnfinishedGroup('
  );
  const fn = new Function('unfinishedGroupKey',
    summary + '\nreturn liveUnfinishedSummary;'
  )(() => 'known-boundary');
  const value = fn({
    jobId: 'capture-117', status: 'paused', phase: 'paused', resumePhase: 'walk',
    draftId: 'draft-capture-117', draftCount: 117,
    imageCount: 42, imageBinaryReady: 17,
    captureBoundary: { kind: 'stable', key: 'data-message-id:end' }
  });
  assert.equal(value.capturePhase, 'walk');
  assert.equal(value.canExportCurrent, true);
  assert.equal(value.exportPassId, 'draft-capture-117');
  assert.equal(value.messageCount, 117);
});
