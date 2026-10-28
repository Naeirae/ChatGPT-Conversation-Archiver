import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_MODES, queueLanePlan, splitLanePlan, chooseRunnableQueueItems,
  queueItemStatus, joinVerifiedSplitCapture, queueResumePlan
} from '../lib/capture-queue.mjs';
const url = 'https://chatgpt.com/c/4e156f31-0000-4000-8000-111111111111';
const other = 'https://chatgpt.com/c/4e156f31-0000-4000-8000-222222222222';
const anchor = id => ({ id: 'data-message-id:' + id, role: 'assistant', signature: 'assistant:sig-' + id });
const markers = {
  start: anchor('a'),
  middle: { ...anchor('d'), previous: anchor('c'), next: anchor('e') },
  end: anchor('h')
};
const item = (id, mode, sourceUrl = url, captureRange = markers) => ({
  id, mode, sourceUrl, captureRange, status: 'queued'
});
const turn = id => ({ id: anchor(id).id, role: 'assistant', text: 'message ' + id, identityStrong: true });
const archive = (name, messages) => ({
  id: name, sourceUrl: url, messages,
  captureProof: { startVerified: true, endVerified: true }
});

test('two chats selected independently occupy two slots; third is queued', () => {
  const rows = [
    item('1', QUEUE_MODES.TWO_CHATS, url),
    item('2', QUEUE_MODES.TWO_CHATS, other),
    item('3', QUEUE_MODES.TWO_CHATS, 'https://chatgpt.com/c/4e156f31-0000-4000-8000-333333333333')
  ];
  assert.deepEqual(chooseRunnableQueueItems(rows, []).map(v => v.id), ['1','2']);
  const active = [{ itemId: '1', sourceUrl: url, status: 'running' }];
  assert.deepEqual(chooseRunnableQueueItems(rows.slice(1), active).map(v => v.id), ['2']);
});

test('split item needs both slots and does not steal an ongoing second-chat slot', () => {
  const rows = [item('split', QUEUE_MODES.SPLIT_CHAT), item('other', QUEUE_MODES.TWO_CHATS, other)];
  const active = [{ itemId: 'ongoing', sourceUrl: 'https://chatgpt.com/c/9b834740-0000-4000-8000-000000000000', status: 'running' }];
  assert.deepEqual(chooseRunnableQueueItems(rows, active).map(v => v.id), ['other']);
  assert.deepEqual(chooseRunnableQueueItems(rows, []).map(v => v.id), ['split']);
});

test('one chat in experimental mode receives two overlapping verified ranges', () => {
  const [first, second] = queueLanePlan(item('split', QUEUE_MODES.SPLIT_CHAT));
  assert.equal(first.captureRange.start.id, anchor('a').id);
  assert.equal(first.captureRange.end.id, anchor('e').id);
  assert.equal(second.captureRange.start.id, anchor('c').id);
  assert.equal(second.captureRange.end.id, anchor('h').id);
});

test('weak, missing and duplicated midpoints fail closed', () => {
  assert.throws(() => splitLanePlan({ ...markers, middle: { ...markers.middle, previous: { id: 'turn:fallback-2' } } }), /устойчивые ID/);
  assert.throws(() => splitLanePlan({ ...markers, middle: { ...markers.middle, next: markers.start } }), /не должны совпадать/);
  assert.throws(() => splitLanePlan({ start: markers.start, end: markers.end }), /середину/);
});

test('split archives merge only after verified three-message overlap and both boundaries', () => {
  const left = archive('lane-a', ['a','b','c','d','e'].map(turn));
  const right = archive('lane-b', ['c','d','e','f','g','h'].map(turn));
  const joined = joinVerifiedSplitCapture(item('split', QUEUE_MODES.SPLIT_CHAT), left, right);
  assert.deepEqual(joined.messages.map(m => m.text), ['a','b','c','d','e','f','g','h'].map(v=>'message '+v));
  assert.equal(joined.overlap, 3);
  assert.deepEqual(joined.sourceIds, ['lane-a', 'lane-b']);
});

test('wrong source, unverified ends, wrong order and missing bridge never publish a full archive', () => {
  const left = archive('lane-a', ['a','b','c','d','e'].map(turn));
  const right = archive('lane-b', ['c','d','e','f','g','h'].map(turn));
  assert.throws(() => joinVerifiedSplitCapture(item('split', QUEUE_MODES.SPLIT_CHAT), left, {...right, sourceUrl:other}), /разным перепискам/);
  assert.throws(() => joinVerifiedSplitCapture(item('split', QUEUE_MODES.SPLIT_CHAT), left, {...right, captureProof: { startVerified: true, endVerified: false }}), /Не подтверждены границы/);
  assert.throws(() => joinVerifiedSplitCapture(item('split', QUEUE_MODES.SPLIT_CHAT), left, archive('lane-b',['c','x','e','f','g','h'].map(turn))), /стык/);
  assert.throws(() => joinVerifiedSplitCapture(item('split', QUEUE_MODES.SPLIT_CHAT), left, archive('lane-b',['d','e','f','g','h'].map(turn))), /границы/);
});

test('queue status distinguishes failure from partial or complete work', () => {
  const split = item('split', QUEUE_MODES.SPLIT_CHAT);
  assert.equal(queueItemStatus(split, [{itemId:'split',status:'done'}]), 'queued');
  assert.equal(queueItemStatus(split, [{itemId:'split',status:'done'},{itemId:'split',status:'running'}]), 'running');
  assert.equal(queueItemStatus(split, [{itemId:'split',status:'done'},{itemId:'split',status:'error'}]), 'error');
  assert.equal(queueItemStatus(split, [{itemId:'split',status:'done'},{itemId:'split',status:'done'}]), 'done');
});

test('queue resume accepts only a saved chronological draft with original start proof', () => {
  const full = {
    id: 'old-full', sourceUrl: url, captureMode: 'full',
    capturePhase: 'walk', captureBoundary: { kind: 'stable', key: anchor('h').id },
    captureStartProof: {
      mode: 'full', startVerified: true, snapshotEndVerified: true,
      startSource: 'visible-first-turn'
    },
    messages: ['a','b','c'].map(turn), resumeWindowSignatures: ['sig-b','sig-c']
  };
  const plan = queueLanePlan(item('single', QUEUE_MODES.TWO_CHATS))[0];
  const resume = queueResumePlan(full, url, plan);
  assert.equal(resume?.mode, 'resume-draft');
  assert.equal(resume?.existingDraftId, full.id);
  assert.equal(resume?.resumeAnchorId, anchor('c').id);
  assert.deepEqual(resume.resumeTailSignatures, ['sig-b','sig-c']);
  assert.equal(queueResumePlan({ ...full, captureStartProof: null }, url, plan), null);
  assert.equal(queueResumePlan({ ...full, capturePhase: 'top' }, url, plan), null);
  assert.equal(queueResumePlan({ ...full, sourceUrl: other }, url, plan), null);
  assert.equal(queueResumePlan({ ...full, messages: [{ id: 'turn:weak' }] }, url, plan), null);
});

test('split lane resume rejects a changed or unproved range, but can retain an earlier visible prefix', () => {
  const [plan] = splitLanePlan(markers);
  const draft = {
    id: 'old-fragment', sourceUrl: url, captureMode: 'fragment',
    capturePhase: 'walk',
    captureBoundary: { kind: 'stable', key: plan.captureRange.end.id },
    captureStartProof: {
      mode: 'fragment', startVerified: true, snapshotEndVerified: true,
      markedStartId: plan.captureRange.start.id,
      markedEndId: plan.captureRange.end.id
    },
    captureRange: plan.captureRange,
    messages: ['x','a','b','c'].map(turn)
  };
  assert.ok(queueResumePlan(draft, url, plan));
  assert.equal(queueResumePlan({ ...draft, captureBoundary: { kind:'stable',key:anchor('f').id } },url,plan),null);
  assert.equal(queueResumePlan({ ...draft, captureRange: { ...draft.captureRange, start: anchor('f') } },url,plan),null);
  assert.equal(queueResumePlan({ ...draft, messages:['x','b','c'].map(turn) },url,plan),null);
});

test('split queue with one verified lane already done needs only one free slot', () => {
  const split = item('split', QUEUE_MODES.SPLIT_CHAT);
  const active = [
    { itemId:'split',lane:'first',status:'done',sourceUrl:url },
    { itemId:'other',lane:'single',status:'running',sourceUrl:other }
  ];
  assert.deepEqual(chooseRunnableQueueItems([split],active).map(v=>v.id),['split']);
});
