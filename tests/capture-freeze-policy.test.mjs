import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeTransition } from '../lib/capture-freeze-policy.mjs';

const running = {
  jobId:'capture-1', status:'running', phase:'walk',
  count:200, draftId:'draft-capture-1'
};

test('Chrome background freeze never converts a running capture into manual pause',()=>{
  const event = freezeTransition(running,true,1000);
  assert.equal(event.event,'CAPTURE_TAB_FROZEN');
  const stored = {...running,...event.patch};
  assert.equal(stored.status,'running');
  assert.equal(stored.phase,'walk');
  assert.equal(stored.count,200);
  assert.equal(stored.draftId,'draft-capture-1');
  assert.equal(stored.tabFrozen,true);
  assert.equal(freezeTransition(stored,true,1001),null);
  const thaw=freezeTransition(stored,false,2000);
  assert.equal(thaw.event,'CAPTURE_TAB_THAWED');
  assert.equal(thaw.requiresHealth,false);
  assert.equal({...stored,...thaw.patch}.status,'running');
  assert.equal({...stored,...thaw.patch}.phase,'walk');
  assert.equal({...stored,...thaw.patch}.tabFrozen,false);
});

test('legacy browser-created pause can resume only on a verified thaw',()=>{
  const legacy={...running,status:'paused',pauseReason:'frozen',
    phase:'paused',resumePhase:'walk',tabFrozen:true};
  const event=freezeTransition(legacy,false,2000);
  assert.equal(event.requiresHealth,true);
  assert.equal(event.patch.status,'running');
  assert.equal(event.patch.phase,'walk');
  assert.equal(event.patch.pauseReason,'');
  assert.equal(legacy.status,'paused');
});

test('explicit user Pause remains paused on freeze and thaw',()=>{
  const paused={...running,status:'paused',pauseReason:'user',
    phase:'paused',resumePhase:'walk'};
  const frozen=freezeTransition(paused,true,1000);
  const state={...paused,...frozen.patch};
  assert.equal(state.status,'paused');
  assert.equal(state.pauseReason,'user');
  assert.equal(state.phase,'paused');
  const thaw=freezeTransition(state,false,2000);
  assert.equal(thaw.requiresHealth,false);
  const end={...state,...thaw.patch};
  assert.equal(end.status,'paused');
  assert.equal(end.pauseReason,'user');
  assert.equal(end.phase,'paused');
});

test('freeze events ignore completed or unrelated jobs',()=>{
  assert.equal(freezeTransition({...running,status:'error'},true),null);
  assert.equal(freezeTransition(null,true),null);
  assert.equal(freezeTransition(running,null),null);
  assert.equal(freezeTransition(running,false),null);
});
