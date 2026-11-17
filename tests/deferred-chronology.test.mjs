import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js', import.meta.url), 'utf8');
const start = source.indexOf('  function unresolvedChronologyMessages()');
const end = source.indexOf('  function collect(', start);
assert.ok(start>0 && end>start);
const state = { pendingChronology: new Map() };
const {reconcilePendingChronology, unresolvedChronologyMessages} = runInNewContext(
  source.slice(start,end) +
  '\n({reconcilePendingChronology, unresolvedChronologyMessages})',
  { state, Map, Set }
);

test('one-sided orphan remains out of canonical order until both anchors are visible', () => {
  const order = ['a','b','c'];
  const map = new Map(order.map(id=>[id,{id}]));
  const orphan = { id:'orphan', text:'important unsorted reply' };
  state.pendingChronology.set(orphan.id, {message:orphan,beforeId:'b',afterId:''});
  reconcilePendingChronology(map,order,[{id:'b'},orphan]);
  assert.deepEqual(order,['a','b','c']);
  assert.deepEqual(Array.from(unresolvedChronologyMessages(),x=>x.id),['orphan']);
  assert.equal(map.has('orphan'),false);
});

test('new second witness confirms exact adjacent position without arbitrary insertion', () => {
  const order=['a','b','c'];
  const map=new Map(order.map(id=>[id,{id}]));
  const orphan={id:'orphan',text:'important unsorted reply'};
  state.pendingChronology.set('orphan',{message:orphan,beforeId:'b',afterId:''});
  reconcilePendingChronology(map,order,[{id:'b'},orphan,{id:'c'}]);
  assert.deepEqual(order,['a','b','orphan','c']);
  assert.equal(map.get('orphan').text,orphan.text);
  assert.equal(state.pendingChronology.size,0);
});

test('an ambiguous interval with already saved messages never guesses a position', () => {
  const order=['a','b','c','d'];
  const map=new Map(order.map(id=>[id,{id}]));
  const orphan={id:'orphan'};
  state.pendingChronology.set('orphan',{message:orphan,beforeId:'b',afterId:'d'});
  reconcilePendingChronology(map,order,[{id:'b'},orphan,{id:'d'}]);
  assert.deepEqual(order,['a','b','c','d']);
  assert.equal(state.pendingChronology.size,1);
  state.pendingChronology.clear();
});

test('one-sided contradiction does not throw in collect and preserves position evidence',()=>{
  const begin=source.indexOf('  function collect(');
  const finish=source.indexOf('  function rebuildCaptureMap(',begin);
  const collect=source.slice(begin,finish);
  assert.doesNotMatch(collect,/throw new Error\('Односторонняя привязка/);
  assert.match(collect,/state\.pendingChronology\.set\(id, \{ message, beforeId, afterId \}\)/);
  assert.match(collect,/reconcilePendingChronology\(map, order, windowMessages\)/);
  assert.match(source,/pendingChronology: \[\.\.\.state\.pendingChronology\.values\(\)\]/);
  assert.match(source,/unplacedMessages,/);
});

test('capture terminates worker job before expensive recovery enrichment',()=>{
  const start=source.indexOf('    } catch (error) {',source.indexOf('  async function captureConversation('));
  const end=source.indexOf('    } finally {',start);
  const catchBody=source.slice(start,end);
  const report=catchBody.indexOf("type: 'ARCHIVER_CAPTURE_FAILED'");
  const salvage=catchBody.indexOf('let draftId =');
  assert.ok(report>0 && salvage>report);
  assert.match(catchBody,/5000, 'Сообщение об ошибке фоновой службе'/);
});
