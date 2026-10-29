import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sw = readFileSync(new URL('../service-worker.js',import.meta.url),'utf8');
const popup = readFileSync(new URL('../popup.js',import.meta.url),'utf8');
const begin=sw.indexOf('async function inspectStalledSingleCapture() {');
const end=sw.indexOf('\nasync function getRunHistory()',begin);
assert.ok(begin>=0 && end>begin,'Need executable production health handler');

function harness({health={ok:true,running:false,jobId:'capture-132'},deadline=Date.now()}={}) {
  const job={
    jobId:'capture-132',status:'running',phase:'walk',count:132,
    sourceTabId:35,captureTabId:40,tabId:35,
    draftId:'draft-capture-132',draftCount:130
  };
  const events=[],finish=[];
  const fn=new Function(
    'captureRuntimeReady','getJob','shouldInspectCapture',
    'chrome','probeLiveCapture','backgroundFocus','getDraft',
    'finishJobWithError','captureStallEvidence',
    'stallDiagnosticText','appendRunLog','Date',
    sw.slice(begin,end)+'\nreturn inspectStalledSingleCapture;'
  )(
    Promise.resolve(),async()=>job,()=>true,
    {tabs:{get:async()=>({frozen:false,id:40})}},
    async()=>health,
    {details:()=>null,awakenFrozen:async()=>({ok:true})},
    async()=>({id:'draft-capture-132',
      messages:Array.from({length:132},(_,i)=>({id:i}))}),
    async(...args)=>{finish.push(args);},
    ()=>({status:'no-health-response'}),
    ()=> 'No page health response',
    async(...args)=>events.push(args),
    class extends Date {static now(){return deadline;}}
  );
  return {fn,events,finish};
}

test('stale running UI is reconciled from explicit dead content-script health',async()=>{
  const f=harness();
  await f.fn();
  assert.equal(f.finish.length,1);
  assert.equal(f.finish[0][0],'capture-132');
  assert.equal(f.finish[0][3],'draft-capture-132');
  assert.equal(f.finish[0][4],132);
  assert.equal(f.finish[0][5],'error');
  assert.equal(f.events.length,0);
});

test('different live content job cannot keep old capture in ghost running state',async()=>{
  const f=harness({health:{ok:true,running:true,jobId:'different-job'}});
  await f.fn();
  assert.equal(f.finish.length,1);
  assert.equal(f.finish[0][4],132);
});

test('health timeout alone does not delete or stop a long-message capture',async()=>{
  const f=harness({health:null});
  await f.fn();
  assert.equal(f.finish.length,0);
  assert.equal(f.events.length,1);
  assert.equal(f.events[0][1].code,'CAPTURE_NO_COUNT_ADVANCE');
});

test('popup refreshes a stale running label even when Pause fails',()=>{
  const start=popup.indexOf("$('pauseCapture').onclick = async () => {");
  const end=popup.indexOf("$('resumeCapture').onclick",start);
  assert.ok(start>=0&&end>start);
  const block=popup.slice(start,end);
  assert.match(block,/catch \(error\) \{\s*\/\/[\s\S]*?await getState\(\)\.catch\(\(\) => \{\}\);/);
});
