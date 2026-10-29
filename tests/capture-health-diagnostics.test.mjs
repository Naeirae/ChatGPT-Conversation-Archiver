import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldInspectCapture, captureStallEvidence, stallDiagnosticText
} from '../lib/capture-health-diagnostics.mjs';

const now=2000000;
const running={
  jobId:'capture-98',status:'running',phase:'walk',
  startedAt:now-420000,lastCountAdvanceAt:now-350000,
  lastProgressAt:now-10000,lastPhysicalScrollAt:now-15000,
  lastPhysicalActivity:'scroll-moved',
  lastScrollBefore:1250,lastScrollAfter:1500,
  count:8,draftId:'draft-capture-98'
};

test('long unchanged message count is diagnostic even if physical scrolling continues',()=>{
  assert.equal(shouldInspectCapture(running,now),true);
  const evidence=captureStallEvidence(running,
    {id:41,frozen:false},{ok:true,jobId:running.jobId,running:true,paused:false,
      visibility:'hidden'},now);
  assert.equal(evidence.status,'running-in-page');
  assert.equal(evidence.countIdleSeconds,350);
  assert.equal(evidence.progressIdleSeconds,10);
  assert.equal(evidence.wheelIdleSeconds,15);
  assert.equal(evidence.pageVisibility,'hidden');
  assert.match(stallDiagnosticText(evidence),/Wheel result: scroll-moved \(1250 -> 1500\)/);
});

test('health timeout does not mean stopped collector',()=>{
  const evidence=captureStallEvidence({...running,lastProgressAt:0},
    {frozen:true},null,now);
  assert.equal(evidence.status,'no-health-response');
  assert.equal(evidence.tabFrozen,true);
  assert.equal(evidence.progressIdleSeconds,null);
  assert.match(stallDiagnosticText(evidence),/Content script: no-health-response/);
});

test('inspection throttles warnings and never touches paused or terminal jobs',()=>{
  assert.equal(shouldInspectCapture(running,now),true);
  assert.equal(shouldInspectCapture({...running,lastStallDiagnosticAt:now-45000},now),false);
  assert.equal(shouldInspectCapture({...running,lastStallDiagnosticAt:now-130000},now),true);
  assert.equal(shouldInspectCapture({...running,lastCountAdvanceAt:now-1000},now),false);
  assert.equal(shouldInspectCapture({...running,status:'paused'},now),false);
  assert.equal(shouldInspectCapture({...running,status:'error'},now),false);
  assert.equal(shouldInspectCapture(null,now),false);
});

test('user Pause and draft checkpoint are not mutated by health classification',()=>{
  const state={...running,status:'paused',pauseReason:'user',draftCount:8};
  const snapshot=JSON.stringify(state);
  assert.equal(shouldInspectCapture(state,now),false);
  captureStallEvidence(state,{frozen:false},null,now);
  assert.equal(JSON.stringify(state),snapshot);
});
