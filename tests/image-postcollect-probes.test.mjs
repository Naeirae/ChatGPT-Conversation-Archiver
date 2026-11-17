import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const content=readFileSync(new URL('../content-chatgpt.js',import.meta.url),'utf8');
const begin=content.indexOf('  async function walkDown(');
const end=content.indexOf('  function chooseAutomaticSplitMiddle(',begin);
assert.ok(begin>0&&end>begin);
const walk=content.slice(begin,end);
test('post-collect physical progress avoids full message signature after-scroll',()=>{
  assert.match(walk,/const physicalAfter = sampleCaptureScroller\(\)/);
  assert.match(walk,/if \(!physicalMovedForward &&\s*!measuredAdjacentScroll\(/);
  assert.match(walk,/const afterRefs = visibleNavigationRefsLightweight\(\)/);
  assert.match(walk,/const after = physicallyAdvanced \? null : scrollObservation\(map.size\)/);
  assert.match(walk,/stall.stable >= 3 && after\?\.atEnd/);
  const refs=walk.indexOf('const afterRefs = visibleNavigationRefsLightweight()');
  const guard=walk.lastIndexOf('if (!physicalMovedForward &&',refs);
  assert.ok(guard>=0 && guard<refs,'text matching is guarded by no physical movement');
});
test('late post-collect diagnostics distinguish scroller, overlap and marked boundary',()=>{
  for(const stage of ['postcollect-enter','postcollect-physical-done','postcollect-overlap-enter','postcollect-overlap-done','postcollect-boundary-enter','postcollect-boundary-done']){
    assert.ok(walk.includes("'"+stage+"'"),stage);
  }
  assert.ok(walk.indexOf("'collect-done'")<walk.indexOf("'postcollect-enter'"));
});
