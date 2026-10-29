import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundFocusManager } from '../lib/background-focus-manager.mjs';

function harness() {
  const attached = new Set();
  const log = [];
  let currentVisibility = 'visible';
  const urls = new Map([[11,'https://chatgpt.com/c/one'],[12,'https://chatgpt.com/c/two']]);
  const chrome = {
    tabs: { async get(id) { return { id, url: urls.get(id) }; } },
    scripting: { async executeScript({ target }) {
      return [{ result: { visibility: currentVisibility, hidden: currentVisibility !== 'visible',
        url: urls.get(target.tabId), readyState: 'complete' } }];
    } },
    debugger: {
      async getTargets() { return [...attached].map(tabId => ({ tabId, attached: true })); },
      async attach({tabId}) {
        if (attached.has(tabId)) throw new Error('already attached');
        attached.add(tabId); log.push('attach:' + tabId);
      },
      async detach({tabId}) { attached.delete(tabId); log.push('detach:' + tabId); },
      async sendCommand({tabId}, method) {
        if (!attached.has(tabId)) throw new Error('not attached');
        log.push(method + ':' + tabId);
        return {};
      }
    }
  };
  return {chrome, attached, log, urls, setVisibility: v => {currentVisibility=v;}};
}

test('two background collectors share no debugger session', async () => {
  const h = harness();
  const manager = createBackgroundFocusManager(h.chrome);
  await Promise.all([
    manager.enable(11, 'job-1', h.urls.get(11)),
    manager.enable(12, 'job-2', h.urls.get(12))
  ]);
  assert.equal(h.attached.size, 2);
  await Promise.all([
    manager.withDebugger(11, () => h.chrome.debugger.sendCommand({tabId:11}, 'Input.dispatchMouseEvent')),
    manager.withDebugger(12, () => h.chrome.debugger.sendCommand({tabId:12}, 'Page.captureScreenshot'))
  ]);
  assert.deepEqual(h.log.filter(x=>x.startsWith('attach:')).sort(), ['attach:11','attach:12']);
  await manager.release(11, 'job-1');
  assert.equal(h.attached.has(12), true);
  assert.equal(h.attached.has(11), false);
  await manager.release(12, 'job-2');
});

test('same tab reuses an owned debugger and refuses other jobs', async () => {
  const h=harness(); const manager=createBackgroundFocusManager(h.chrome);
  await manager.enable(11,'first',h.urls.get(11));
  const again=await manager.enable(11,'first',h.urls.get(11));
  assert.equal(again.alreadyAttached,true);
  await assert.rejects(manager.enable(11,'second',h.urls.get(11)),/другому заданию/);
  await manager.withDebugger(11,() => h.chrome.debugger.sendCommand({tabId:11},'Input.dispatchMouseEvent'));
  assert.equal(h.log.filter(x => x==='attach:11').length,1);
  await manager.release(11,'first');
});

test('fail closed on hidden pages and changed conversations', async () => {
  const h=harness(); const manager=createBackgroundFocusManager(h.chrome);
  h.setVisibility('hidden');
  await assert.rejects(manager.enable(11,'a',h.urls.get(11)),/не подтвердил видимость/);
  assert.equal(h.attached.size,0);
  h.setVisibility('visible');
  h.urls.set(11,'https://chatgpt.com/c/other');
  await assert.rejects(manager.enable(11,'a','https://chatgpt.com/c/one'),/не исходную/);
  assert.equal(h.attached.size,0);
});

test('DevTools attachment is not stolen or detached', async () => {
  const h=harness(); h.attached.add(11);
  const manager=createBackgroundFocusManager(h.chrome);
  await assert.rejects(manager.enable(11,'a',h.urls.get(11)),/занята/);
  assert.equal(h.log.filter(x=>x==='detach:11').length,0);
});

test('unexpected detach invalidates the session', async () => {
  const h=harness(); const manager=createBackgroundFocusManager(h.chrome);
  await manager.enable(11,'a',h.urls.get(11));
  h.attached.delete(11);
  assert.equal(manager.forgetDetached(11)?.jobId,'a');
  assert.equal(manager.isManaged(11),false);
  assert.equal(await manager.release(11,'a'),false);
});

test('temporary debugger access is serialized and released after commands', async () => {
  const h=harness(); const manager=createBackgroundFocusManager(h.chrome);
  await Promise.all([
    manager.withDebugger(11,async()=>{await h.chrome.debugger.sendCommand({tabId:11},'Runtime.evaluate');}),
    manager.withDebugger(11,async()=>{await h.chrome.debugger.sendCommand({tabId:11},'Page.captureScreenshot');})
  ]);
  assert.equal(h.attached.size,0);
  assert.equal(h.log.filter(x=>x==='attach:11').length,2);
});


test('initial CDP focus attachment tolerates transient hidden frames, not persistent hiding', async () => {
  const h = harness();
  const original = h.chrome.scripting.executeScript;
  let calls = 0;
  h.chrome.scripting.executeScript = async args => {
    calls++;
    if (calls <= 2) {
      return [{ result: {
        visibility: 'hidden', hidden: true, url: h.urls.get(args.target.tabId),
        readyState: 'complete'
      } }];
    }
    return original(args);
  };
  const manager = createBackgroundFocusManager(h.chrome);
  const started = await manager.enable(11, 'delayed-visible', h.urls.get(11));
  assert.equal(started.ok, true);
  assert.ok(calls >= 3);
  assert.equal(h.log.filter(event => event === 'attach:11').length, 1);
  await manager.release(11, 'delayed-visible');
});


test('an owned frozen tab can be woken without touching its sibling or stealing focus', async () => {
  const h=harness();const manager=createBackgroundFocusManager(h.chrome);
  await manager.enable(11,'worker-a',h.urls.get(11));
  await manager.enable(12,'worker-b',h.urls.get(12));
  const originalGet=h.chrome.tabs.get;
  let frozen=true;
  h.chrome.tabs.get=async id=>({...(await originalGet(id)), frozen:id===11?frozen:false});
  const originalCommand=h.chrome.debugger.sendCommand;
  h.chrome.debugger.sendCommand=async (target,method,params)=>{
    if (method==='Page.setWebLifecycleState') {
      assert.equal(target.tabId,11);
      assert.equal(params.state,'active');
      frozen=false;
    }
    return originalCommand(target,method,params);
  };
  const woke=await manager.awakenFrozen(11,'worker-a',40000);
  assert.equal(woke.ok,true);
  assert.equal(woke.requested,true);
  assert.equal(frozen,false);
  assert.equal(h.attached.has(11),true);
  assert.equal(h.attached.has(12),true);
  assert.equal(h.log.some(x=>x==='Page.setWebLifecycleState:12'),false);
  assert.equal((await manager.awakenFrozen(11,'foreign-worker',55000)).reason,'not-owned');
  await manager.release(11,'worker-a');
  await manager.release(12,'worker-b');
});

test('frozen wake fails closed for wrong job and throttles repeated wake attempts', async () => {
  const h=harness();const manager=createBackgroundFocusManager(h.chrome);
  await manager.enable(11,'owner',h.urls.get(11));
  const originalGet=h.chrome.tabs.get;
  h.chrome.tabs.get=async id=>({...(await originalGet(id)), frozen:true});
  assert.equal((await manager.awakenFrozen(11,'other',30000)).reason,'not-owned');
  const first=await manager.awakenFrozen(11,'owner',40000);
  assert.equal(first.requested,true);
  assert.equal(first.ok,false);
  const second=await manager.awakenFrozen(11,'owner',41000);
  assert.equal(second.reason,'wake-cooldown');
  assert.equal(h.log.filter(x=>x==='Page.setWebLifecycleState:11').length,1);
  await manager.release(11,'owner');
});
