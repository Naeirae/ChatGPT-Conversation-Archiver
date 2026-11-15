import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const content = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../lib/capture-queue-controller.mjs', import.meta.url), 'utf8');

const start = content.indexOf('  function measuredAdjacentScroll(');
const end = content.indexOf('  function createContinuityWatchdog(', start);
assert.ok(start >= 0 && end > start);
const { measuredAdjacentScroll, moderateDownwardProgress } = runInNewContext(
  content.slice(start, end) + '\n({measuredAdjacentScroll,moderateDownwardProgress})'
);
const node = {};
const before = { element: node, top: 100, clientHeight: 700, scrollHeight: 3500 };
const physical = { direction: 'down', ok: true };

test('long message with expanding image layout resets stall but does not prove seam', () => {
  const after = { ...before, top: 320, scrollHeight: 4300 };
  assert.equal(measuredAdjacentScroll(before, after, physical), false);
  assert.equal(moderateDownwardProgress(before, after, physical), true);
});

test('stable layout and adjacent physical motion can prove chronology', () => {
  const after = { ...before, top: 320 };
  assert.equal(measuredAdjacentScroll(before, after, physical), true);
  assert.equal(moderateDownwardProgress(before, after, physical), true);
});

test('no stall reset on a jump or a different scroll root', () => {
  assert.equal(moderateDownwardProgress(before, { ...before, top: 900 }, physical), false);
  assert.equal(moderateDownwardProgress(before, { ...before, top: 320, element: {} }, physical), false);
});

test('long-turn walk passes proven forward continuity to next iteration', () => {
  const begin = content.indexOf('  async function walkDown(');
  const stop = content.indexOf('  async function ', begin + 30);
  const walk = content.slice(begin, stop);
  assert.match(walk, /let previousVerifiedForwardStep = false/);
  assert.match(walk, /verifiedForwardStep: previousVerifiedForwardStep/);
  assert.match(walk, /previousVerifiedForwardStep = measuredAdjacentScroll/);
});

test('per-turn identity context reuses already enumerated turn window', () => {
  assert.match(content, /function turnIdentityContext\(turn, knownTurns = null\)/);
  assert.match(content, /const turns = knownTurns \|\| orderedTurns\(\)/);
  assert.match(content, /captureTurn\(turn, ordinal, settings, mountedTurns\)/);
});

test('copied split lane can acknowledge after durable save without waiting for merge', () => {
  const begin = queue.indexOf('async function complete(message, tabId)');
  const end = queue.indexOf('async function markFailed(', begin);
  const block = queue.slice(begin, end);
  assert.match(block, /current\.phase = 'finalizing'/);
  assert.match(block, /void finalizeSplit\(worker\.itemId\)/);
  assert.doesNotMatch(block, /await finalizeSplit\(worker\.itemId\)/);
  assert.match(block, /return \{ ok: true, status: 'done', archiveId: archive\.id \}/);
});


test('queued physical scroll has a bounded acknowledgement and preserves fail-closed handling', () => {
  const start = content.indexOf('    async function physicalScroll({');
  const end = content.indexOf('    return Object.freeze({', start);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /withCaptureOperationTimeout\\(\\s*chrome\\.runtime\\.sendMessage\\(/);
  assert.match(block, /20000,\\s*'Физическая прокрутка переписки'/);
  assert.match(block, /throw new Error\\(result\\?\\.error/);
});


test('checkpoint reads cannot silently block the marked-range walk', () => {
  const start = content.indexOf('  async function persistRecoveryCheckpoint(');
  const end = content.indexOf('  async function ', start + 20);
  assert.ok(start >= 0 && end > start);
  const block = content.slice(start, end);
  assert.match(block, /const readCheckpointKey = async key =>/);
  assert.match(block, /withCaptureOperationTimeout\\(\\s*chrome\\.storage\\.local\\.get\\(key\\),\\s*15000/);
  assert.match(block, /readCheckpointKey\\(activeKey\\)/);
  assert.match(block, /readCheckpointKey\\('draft:' \\+ draftId\\)/);
  assert.doesNotMatch(block, /await chrome\\.storage\\.local\\.get\\(/);
});

test('text signature does not clone entire long turn for every scroll poll', () => {
  const start = content.indexOf('  function turnMessageText(turn)');
  const end = content.indexOf('  function turnTextSignature(', start);
  assert.ok(start >= 0 && end > start);
  const body = content.slice(start, end);
  assert.doesNotMatch(body, /cloneNode\\(/);
  assert.match(body, /messageTextWithParagraphs\\(root, role\\)/);
});

test('downward capture retries a no-op physical wheel and reports measured position', () => {
  const start = content.indexOf('  async function walkDown(');
  const end = content.indexOf('  async function ', start + 30);
  assert.ok(start >= 0 && end > start);
  const body = content.slice(start, end);
  assert.match(body, /wheelAttempt < 2/);
  assert.match(body, /physicalAfterWheel = sampleCaptureScroller\\(\\)/);
  assert.match(body, /actualDelta >= 2/);
  assert.match(body, /проверка физического сдвига/);
  assert.match(body, /verifiedForwardStep: secondForwardStep/);
});

test('first marked walk steps emit ordered diagnostic stage boundaries', () => {
  const start = content.indexOf('  async function walkDown(');
  const end = content.indexOf('  async function ', start + 30);
  assert.ok(start >= 0 && end > start);
  const body = content.slice(start, end);
  const stages = ['wheel-verified', 'expand-enter', 'expand-done', 'collect-enter', 'collect-done'];
  let position = -1;
  for (const stage of stages) {
    const next = body.indexOf("traceWalkStage('" + stage + "'", position + 1);
    assert.ok(next > position, 'missing or unordered stage: ' + stage);
    position = next;
  }
});

test('unchanged mounted turn is reused, but changed content or images are recaptured', () => {
  const start = content.indexOf('  function reusableVisibleCapture(');
  const end = content.indexOf('  function collect(', start);
  assert.ok(start >= 0 && end > start);
  const source = content.slice(start, end) + '\nreusableVisibleCapture';
  const turn = { id: 'data-message-id:abc', text: 'long message', images: [] };
  const saved = { id: turn.id, role: 'assistant', text: turn.text, images: [] };
  const getCapture = runInNewContext(source, {
    turnStableKey: value => value.id,
    roleOf: () => 'assistant',
    isStrongMessageId: id => id.startsWith('data-message-id:'),
    turnIdentityContext: () => ({}),
    identityContextsCompatible: () => true,
    turnImageNodes: value => value.images,
    imageSource: image => image.src,
    contentRoot: value => value,
    messageTextWithParagraphs: value => value.text
  });
  const map = new Map([[turn.id, saved]]);
  assert.equal(getCapture(turn, map, {}, [turn]), saved);
  turn.text = 'long message updated';
  assert.equal(getCapture(turn, map, {}, [turn]), null);
  turn.text = saved.text;
  turn.images = [{ src: 'https://example.com/image.png' }];
  assert.equal(getCapture(turn, map, {}, [turn]), null);
  turn.images = [];
  assert.equal(getCapture(turn, map, { includeReasoning: true }, [turn]), null);
});

test('weak marked end rebinds only to a unique substantive matching turn', () => {
  const first = content.indexOf('  function uniqueMarkedEndAtPhysicalBottom(');
  const last = content.indexOf('  function trimMessagesThroughBoundary(', first);
  assert.ok(first >= 0 && last > first);
  const resolve = runInNewContext(
    content.slice(first, last) + '\nuniqueMarkedEndAtPhysicalBottom',
    {
      isStrongMessageId: id => /^data-message-id:/.test(id || ''),
      normalizeMatchText: value => String(value || '').trim(),
      messageTextSignature: message => message.role + ':' + message.text
    }
  );
  const long = 'This is a uniquely identifiable marked end message with enough text.';
  const rows = [
    { role: 'assistant', text: 'A different long message with its own identity.' },
    { role: 'user', text: long },
    { role: 'assistant', text: 'Another message after the marked end.' }
  ];
  const marker = { id: 'turn:virtual', role: 'user', signature: 'user:' + long,
    contextBefore: ['previous-mounted-turn-that-is-no-longer-present'] };
  assert.equal(resolve(rows, marker), 1);
  assert.equal(resolve([...rows, { role: 'user', text: long }], marker), -1,
    'repeated text is not a safe end marker');
  assert.equal(resolve(rows, { ...marker, id: 'data-message-id:immutable' }), -1,
    'do not override strong immutable identities');
  assert.equal(resolve([{ role: 'user', text: 'short' }],
    { ...marker, signature: 'user:short' }), -1);
  assert.equal(resolve([{ role: 'assistant', text: long }], marker), -1,
    'wrong role must never match');
});

test('physical bottom rebind still requires final marked range trimming', () => {
  const first = content.indexOf('  async function walkDown(');
  const last = content.indexOf('  async function ', first + 30);
  const walk = content.slice(first, last);
  assert.ok(walk.includes('uniqueMarkedEndAtPhysicalBottom(completeRows, markedEnd)'));
  assert.ok(walk.includes('boundary.contextBefore = []'));
  assert.ok(walk.includes('markedEndRebound: true'));
  assert.ok(content.includes('selectedFragment.end = {'));
  assert.ok(content.includes('trimMessagesThroughBoundary(capturedMessages, boundary)'));
});

test('unique weak identity remains canonical when only DOM neighbour context changes', () => {
  const first = content.indexOf('  function unchangedWeakOccurrence(');
  const last = content.indexOf('  function collect(', first);
  assert.ok(first >= 0 && last > first);
  const check = runInNewContext(content.slice(first,last) + '\nunchangedWeakOccurrence', {
    normalizeMatchText: text => String(text || '').trim(),
    messageTextSignature: item => item.role + ':' + item.text
  });
  const text = 'A substantial and unique assistant reply whose neighbour was virtualized away.';
  const saved = { id: 'turn:virtual:assistant:hash', role: 'assistant', text,
    identityStrong: false, identityContext: { previous: 'old' } };
  const newMessage = { ...saved, identityContext: { previous: 'new' } };
  const map = new Map([[saved.id,saved]]);
  assert.equal(check(newMessage, [newMessage], map), true);
  assert.equal(check(newMessage, [newMessage, {...newMessage,id:'repeat'}], map), false);
  assert.equal(check(newMessage, [newMessage], new Map([[saved.id,saved],['other', {...saved,id:'other'}]])), false);
  assert.equal(check({...newMessage,text:'short'}, [{...newMessage,text:'short'}],map), false);
  assert.equal(check({...newMessage,identityStrong:true}, [newMessage],map), false);
  assert.equal(check({...newMessage,id:'another-wrapper'},[newMessage],map), false);
});

test('weak identity context correction never mutates a saved map object', () => {
  const begin = content.indexOf('  function collect(');
  const end = content.indexOf('  function rebuildCaptureMap(',begin);
  const block = content.slice(begin,end);
  assert.ok(block.includes('message = { ...message, id: messageId,'));
  assert.ok(block.includes('weakOriginalId: existing.id'));
  assert.ok(block.includes('windowMessages[i] = { ...map.get(candidate.id) }'));
  assert.doesNotMatch(block,/message\.id = messageId/);
});
