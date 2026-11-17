import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const content = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start=content.indexOf('  async function walkDown(');
const end=content.indexOf('  function chooseAutomaticSplitMiddle(',start);
assert.ok(start>0&&end>start);
const walk=content.slice(start,end);
test('every prewheel operation is traced after image-bearing 19th message',()=>{
  for(const stage of [
    'iteration-enter','prescroll-expand-enter','prescroll-expand-done',
    'prescroll-collect-enter','prescroll-collect-done',
    'prescroll-refs-enter','prescroll-refs-done',
    'prescroll-observation-enter','prescroll-observation-done',
    'prescroll-checkpoint-enter','prescroll-checkpoint-done',
    'postcollect-checkpoint-enter','postcollect-checkpoint-done'
  ])assert.ok(walk.includes("'"+stage+"'"),stage);
  assert.match(walk,/map\.size >= 16/);
});
test('same viewport is reused only with unmutated observer-backed captures',()=>{
  assert.match(walk,/const previousWindowStillMounted = i > 0/);
  assert.match(walk,/currentPosition\?\.top === lastCollectedPosition\?\.top/);
  assert.match(walk,/cached\.observer\.takeRecords\(\)\.length === 0/);
  assert.match(walk,/map\.has\(cached\.id\)/);
  assert.match(walk,/\? lastCollectedWindowIds\s*: collect\(/);
});
test('all physically moved post-scroll windows are still captured',()=>{
  assert.match(walk,/const secondTouchedIds = collect\(map, order, settings, boundary/);
  assert.match(walk,/lastCollectedWindowIds = secondTouchedIds/);
  assert.match(walk,/lastCollectedPosition = sampleCaptureScroller\(\)/);
});
