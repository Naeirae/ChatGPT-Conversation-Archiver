import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url),'utf8');
const recoveryStart=source.indexOf('  async function recoverDownwardContinuity(');
const recoveryEnd=source.indexOf('  async function walkDownFullLegacy(', recoveryStart);
const adjacentStart=source.indexOf('  function measuredAdjacentScroll(');
const adjacentEnd=source.indexOf('  function createContinuityWatchdog(', adjacentStart);
assert.ok(recoveryStart>0 && recoveryEnd>recoveryStart);
assert.ok(adjacentStart>0 && adjacentEnd>adjacentStart);

const adjacent = new Function(
  source.slice(adjacentStart, adjacentEnd) + '\nreturn measuredAdjacentScroll;'
)();

function fixture({ skipForward=false, jumpForward=false }={}) {
  const container={};
  let top=440;
  let collected=0;
  const beforeRefs=[{strongId:'data-message-id:old',signature:'old'}];
  const afterRefs=[{strongId:'data-message-id:new',signature:'new'}];
  const sample=()=>({
    element:container,top,clientHeight:700,scrollHeight:10000
  });
  const refs=()=>top<=280?beforeRefs:afterRefs;
  const overlap=(x,y)=>(x||[]).some(a=>(y||[]).some(b=>
    a.strongId && a.strongId===b.strongId));
  const movements=[];
  const deps={
    waitIfPaused:async()=>{},
    visibleNavigationRefsLightweight:refs,
    sampleCaptureScroller:sample,
    navigationWindowsOverlap:overlap,
    progress:async()=>{},
    physicalScroll:async(direction,bursts,options)=>{
      movements.push(direction);
      if(direction==='up')top=Math.max(0,top-120);
      else if (!skipForward) top+=jumpForward?700:Number(options?.wheelDelta||80);
      return {ok:true,moved:direction==='up'||!skipForward,direction};
    },
    expandVisible:async()=>{},
    expandReasoningVisible:async()=>{},
    collect:()=>{collected++},
    measuredAdjacentScroll:adjacent
  };
  const recovery = new Function('deps',
    'const {'+Object.keys(deps).join(',')+'}=deps;\n'+
    source.slice(recoveryStart,recoveryEnd)+
    '\nreturn recoverDownwardContinuity;'
  )(deps);
  return {
    run:()=>recovery(beforeRefs,afterRefs,sample(),new Map(),[],{
      includeReasoning:false
    },null),
    position:()=>top,
    collected:()=>collected,
    movements
  };
}

test('successful recovery walks back and then certifies every forward step to missed viewport',async()=>{
  const fx=fixture();
  assert.equal(await fx.run(),true);
  assert.equal(fx.position(),440);
  assert.deepEqual(fx.movements,['up','up','down','down','down']);
  assert.equal(fx.collected(),5);
});

test('rewinding onto an earlier known turn is never itself accepted as recovery',async()=>{
  const fx=fixture({skipForward:true});
  assert.equal(await fx.run(),false);
  assert.deepEqual(fx.movements.slice(0,3),['up','up','down']);
  assert.equal(fx.position(),200);
});

test('recovery refuses forward replay that jumps over a non-overlapping viewport',async()=>{
  const fx=fixture({jumpForward:true});
  assert.equal(await fx.run(),false);
  assert.equal(fx.movements.filter(x=>x==='down').length,1);
});

test('both traversal paths replay the entire missing window before continuing',()=>{
  const all=source.slice(recoveryEnd);
  const occurrences=all.match(/recoverDownwardContinuity\(\s*beforeRefs,\s*afterRefs,\s*physicalAfter,/g)||[];
  assert.equal(occurrences.length,2);
  assert.match(source.slice(recoveryStart,recoveryEnd),
    /Number\(nextSample\.top\) >= Number\(originalAfter\.top\) - 2/);
});
