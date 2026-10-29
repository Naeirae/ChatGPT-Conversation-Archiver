import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const service = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

function between(source, begin, end) {
  const a = source.indexOf(begin), b = source.indexOf(end, a + begin.length);
  assert.ok(a >= 0 && b > a, 'Missing executable source: ' + begin);
  return source.slice(a, b);
}

const midpointSource = between(content,
  '  function chooseAutomaticSplitMiddle(witnesses = []) {',
  '  async function planAutomaticSplit('
);
const chooseMidpoint = new Function('isStrongMessageId',
  midpointSource + '\nreturn chooseAutomaticSplitMiddle;'
)(value => /^(data-message-id|data-turn-id):/.test(String(value || '')));

const witness = id => ({id:'data-message-id:'+id, signature:'sig-'+id, role:'assistant'});

test('automatic midpoint is a real turn with two different stable neighbors', () => {
  const all = 'abcdefghijk'.split('').map(witness);
  const middle = chooseMidpoint(all);
  assert.equal(middle.id, witness('f').id);
  assert.equal(middle.previous.id, witness('e').id);
  assert.equal(middle.next.id, witness('g').id);
  assert.notEqual(middle.id, all[0].id);
  assert.notEqual(middle.id, all[all.length-1].id);
});

test('automatic midpoint selects nearest certified triple when center ID is weak', () => {
  const all = 'abcdefghijklm'.split('').map(witness);
  all[6] = {...all[6], id:'weak:mid'};
  const mid = chooseMidpoint(all);
  assert.ok(mid.id.startsWith('data-message-id:'));
  assert.ok(mid.previous.id.startsWith('data-message-id:'));
  assert.ok(mid.next.id.startsWith('data-message-id:'));
  assert.notEqual(mid.id, 'weak:mid');
});

test('automark refuses weak or insufficient middle instead of merging incomplete data', () => {
  assert.throws(() => chooseMidpoint([witness('a'),witness('b')]),/недостаточно/);
  assert.throws(() => chooseMidpoint([
    witness('a'),witness('b'),{id:'weak:1'}, {id:'weak:2'},
    witness('c'),witness('d')
  ]),/Не найдена безопасная середина/);
});

test('single background capture and concurrent queue capture use separate active unfocused windows', async () => {
  const windowSource = between(service,
    'async function createUnfocusedCaptureWindow(sourceUrl) {',
    'async function waitForChatTabComplete('
  );
  const calls = [];
  const chrome = {
    windows:{
      async create(args) {
        calls.push({api:'createWindow',args});
        return {id:210,tabs:[{id:77,url:args.url}]};
      },
      async remove(id) {calls.push({api:'removeWindow',id});}
    },
    tabs:{
      async query() {return [];},
      async update(id,changes) {calls.push({api:'updateTab',id,changes});}
    }
  };
  const createWindow = new Function('chrome',
    windowSource + '\nreturn createUnfocusedCaptureWindow;'
  )(chrome);
  const launched = await createWindow('https://chatgpt.com/c/example');
  assert.equal(launched.tab.id,77);
  assert.equal(launched.windowId,210);
  assert.equal(calls[0].args.focused,false);
  assert.equal(calls[0].args.state,'normal');
  assert.equal(calls[0].args.type,'normal');
  assert.deepEqual(calls[1],{
    api:'updateTab',id:77,changes:{autoDiscardable:false}
  });
  assert.match(service,/captureTab = opened\.tab/);
  assert.match(service,/createUnfocusedCaptureWindow,/);
  assert.doesNotMatch(service,/for \(const worker of tasks\) await launchWorker\(worker\)/);
});

test('content has distinct planning command and never publishes an archive from planner', () => {
  const planner=between(content,
    '  async function planAutomaticSplit(jobId, captureRange) {',
    '  async function seekQueueMarkedStart('
  );
  assert.match(planner,/ARCHIVER_SPLIT_PLAN_READY/);
  assert.match(planner,/ARCHIVER_CAPTURE_FAILED/);
  assert.match(planner,/navigationWindowsOverlap/);
  assert.match(planner,/measuredAdjacentScroll/);
  assert.match(planner,/boundaryIsVisible/);
  assert.match(planner,/chooseAutomaticSplitMiddle/);
  assert.doesNotMatch(planner,/ARCHIVER_CAPTURE_COMPLETE/);
});

test('manual fragment capture honors background selection instead of silently forcing current tab', () => {
  const popup = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
  const begin = service.indexOf('async function startCapture({');
  const end = service.indexOf('async function scheduleAutomaticRecovery(', begin);
  const startup = service.slice(begin, end);
  assert.match(startup, /captureTarget = captureTarget === 'current' \? 'current' : 'copy'/);
  assert.doesNotMatch(startup, /\(mode === 'fragment' \|\|/);
  assert.match(startup, /seekMarkedStart: mode === 'fragment' && captureTarget === 'copy'/);
  const fragmentCase = between(service, "case 'ARCHIVER_CAPTURE_FRAGMENT':",
    "case 'ARCHIVER_CAPTURE_CURRENT':");
  assert.match(fragmentCase, /captureTarget: message\.captureTarget \|\| 'copy'/);
  const popupStart=popup.indexOf("$('captureFragment').onclick");
  const popupEnd=popup.indexOf("$('copyFragment').onclick",popupStart);
  assert.match(popup.slice(popupStart,popupEnd),/captureTarget: \$\('captureTarget'\)\.value/);
  const seek = between(content,
    "        } else if (mode === 'fragment') {",
    "        } else {"
  );
  assert.match(seek,/if \(options\.seekMarkedStart\)/);
  assert.doesNotMatch(seek,/state\.queueCapture/);
});


test('focus emulation precedes ChatGPT DOM hydration in single and queued launch paths', () => {
  const single = between(service, 'async function startCapture({',
    'async function cancelCapture()');
  const copy = between(single,
    "const opened = await createUnfocusedCaptureWindow(inspection.href);",
    '    const modeLabel');
  assert.ok(copy.indexOf('await backgroundFocus.enable(captureTab.id') >= 0);
  assert.ok(copy.indexOf('await backgroundFocus.enable(captureTab.id') <
    copy.indexOf('domProbe = await waitForChatDomReady(captureTab.id'));
  const queue = readFileSync(new URL('../lib/capture-queue-controller.mjs', import.meta.url), 'utf8');
  const launch = between(queue, '  async function launchWorker(worker) {',
    '  async function pump() {');
  assert.ok(launch.indexOf('await deps.prepareBackgroundCapture(tab.id') <
    launch.indexOf('await deps.waitForChatDomReady(tab.id'));
});

test('MV3 activity cannot silently revert to transient CDP or attach to arbitrary image tabs', () => {
  assert.match(service,/async function ensureCaptureDebuggerSession\(/);
  assert.match(service,/type: 'ARCHIVER_CAPTURE_HEALTH', jobId/);
  assert.match(service,/health\.jobId !== jobId \|\| health\.running !== true/);
  assert.match(service,/await ensureCaptureDebuggerSession\(tabId, worker\.jobId, worker\.sourceUrl\)/);
  assert.match(service,/if \(managed && changeInfo\.url &&/);
  assert.match(service,/conversationKey\(changeInfo\.url\) !== conversationKey\(managed\.expectedUrl \|\| ''\)/);
  const image = between(service, "case 'ARCHIVER_CAPTURE_RENDERED_IMAGE': {",
    "case 'ARCHIVER_CHECK_UPDATE':");
  assert.match(image,/job\.jobId !== message\.jobId/);
  assert.match(image,/job\.captureTabId !== tabId/);
});

test('automatic midpoint ignores offscreen DOM messages as physical evidence', () => {
  const planner = between(content, '  async function planAutomaticSplit(jobId, captureRange) {',
    '  async function seekQueueMarkedStart(');
  const addWindow = between(planner, '      const addWindow = () => {',
    '      for (let step =');
  assert.match(addWindow,/if \(!turnIntersectsCaptureViewport\(turn\)\) continue;/);
  assert.match(planner,/navigationWindowsOverlap/);
  assert.match(planner,/measuredAdjacentScroll/);
});


test('manual current-tab collectors retain CDP ownership across a tab switch', () => {
  const startup = between(service, 'async function startCapture({',
    'async function cancelCapture()');
  const inCurrent = between(startup,
    "if (captureTarget === 'current') {",
    '} else {');
  assert.match(inCurrent,/await backgroundFocus\.enable\(captureTab\.id, jobId, inspection\.href\)/);
  assert.ok(inCurrent.indexOf('await backgroundFocus.enable(') <
    inCurrent.indexOf('domProbe = await waitForChatDomReady('));
  const transport = between(service,
    "case 'ARCHIVER_PHYSICAL_SCROLL': {",
    "case 'ARCHIVER_CAPTURE_FAILED':");
  assert.doesNotMatch(transport, /if \(job\.captureTarget === 'copy'\) \{\s*await ensureCaptureDebuggerSession/);
  assert.equal((transport.match(/await ensureCaptureDebuggerSession\(job\.captureTabId/g)||[]).length,3);
  const rendered = between(service, "case 'ARCHIVER_CAPTURE_RENDERED_IMAGE': {",
    "case 'ARCHIVER_CHECK_UPDATE':");
  assert.match(rendered,/await ensureCaptureDebuggerSession\(tabId, job\.jobId, job\.sourceUrl\)/);
  const cancellation = between(service,
    'async function cancelCapture()', 'async function scheduleAutomaticRecovery(');
  assert.match(cancellation,/if \(job\.captureTabId != null\) \{\s*await backgroundFocus\.release/);
  const completion = between(service,'async function handleCaptureComplete(',
    'async function chatScrollMetrics(');
  assert.match(completion,/if \(job\.captureTabId != null\) \{\s*await backgroundFocus\.release/);
  const failed = between(service,'async function finishJobWithError(',
    'async function focusRecoverableCaptureTab(');
  assert.match(failed,/if \(job\.captureTabId != null\) \{\s*await backgroundFocus\.release/);
});

test('run log exposes distinct progress and scroll timestamps and excludes old worker errors', () => {
  const formatting = between(service,'function formatRunLog(job) {',
    'async function cleanupTemporaryBaseline(');
  for (const expected of ['lastProgressAt:', 'lastPhysicalScrollAt:',
      'lastScrollPositions:', 'WORKER ERRORS DURING THIS RUN',
      'Historical worker errors from other runs']) {
    assert.ok(formatting.includes(expected));
  }
  assert.match(formatting,/Number\(item\?\.at \|\| 0\) >= startedAt/);
});
