import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../content-chatgpt.js',import.meta.url),'utf8');
const start = source.indexOf('  function chatgptSearchMessageId(');
const end = source.indexOf('  function identityContextsCompatible(',start);
assert.ok(start>0 && end>start);
const userId='c1a50d3e-cb9f-40ff-a02f-cc36106574f2';
const assistantId='a7a999a2-5b60-4b76-9d4a-ae21b0e8032e';
const sharedWrapper={
  getAttribute: attr => attr==='data-turn-key' ? userId : '',
  querySelector:()=>null
};
function turn(role,ids,options={}) {
  const attrs={
    'data-chatgpt-search-unit-key': 'fallback-turn-0:' + (role==='user'?'0':'2') + ':'+role,
    'data-chatgpt-search-message-ids': ids,
    ...options
  };
  return {
    role,isConnected:true,parentElement:sharedWrapper,
    getAttribute:name=>attrs[name]||'',
    matches:selector=>selector==='[data-chatgpt-search-unit-key]',
    closest:selector=>selector==='[data-turn-key]' ? sharedWrapper : null,
    querySelector:()=>null
  };
}
let textReads=0;
const identity = runInNewContext(source.slice(start,end)+
  '\n({turnStableKey,isStrongMessageId,chatgptSearchMessageId,turnIdentityContext})',{
  WeakMap,Set,String,Array,
  ROLE_SELECTOR:'[data-message-author-role]',
  unchangedTurnCache:new WeakMap(),
  roleOf:node=>node.role,
  turnMessageText:()=>{textReads++;throw Error('should not compute DOM text for strong UUID')},
  normalizeMatchText:s=>s,hashText:s=>s,
  turnTextSignature:()=>{throw Error('strong message must not hash neighbour text')},
  orderedTurns:()=>{throw Error('strong message must not enumerate DOM neighbours')}
});

test('user and assistant share a virtualized wrapper but keep distinct strong message IDs',()=>{
 const user=turn('user',userId),assistant=turn('assistant',assistantId+' '+assistantId);
 assert.equal(identity.turnStableKey(user),'data-chatgpt-search-message-ids:'+userId);
 assert.equal(identity.turnStableKey(assistant),'data-chatgpt-search-message-ids:'+assistantId);
 assert.notEqual(identity.turnStableKey(user),identity.turnStableKey(assistant));
 assert.ok(identity.isStrongMessageId(identity.turnStableKey(assistant)));
 assert.equal(textReads,0);
});

test('ambiguous search units with two different UUIDs are not certified as one message',()=>{
 const ambiguous=turn('assistant',userId+' '+assistantId);
 assert.equal(identity.chatgptSearchMessageId(ambiguous),'');
});

test('strong UUID never recomputes context from virtualized neighbouring messages',()=>{
 const assistant=turn('assistant',assistantId+' '+assistantId);
 assert.deepEqual(JSON.parse(JSON.stringify(identity.turnIdentityContext(assistant))),
   {previous:'',next:''});
 assert.equal(textReads,0);
});

test('native data-message-id keeps precedence on clients exposing both formats',()=>{
 const user=turn('user',userId,{'data-message-id':'legacy-stable-123'});
 assert.equal(identity.turnStableKey(user),'data-message-id:legacy-stable-123');
});

test('hundreds of image-bearing identity checks need no DOM text reads',()=>{
 const assistant=turn('assistant',assistantId+' '+assistantId);
 for(let i=0;i<250;i++){
   assert.equal(identity.turnStableKey(assistant),'data-chatgpt-search-message-ids:'+assistantId);
 }
 assert.equal(textReads,0);
});

test('new search UUID support is wired into strong-ID based navigation',()=>{
 assert.match(source,/data-chatgpt-search-message-ids\\):/);
 assert.match(source,/signature: isStrongMessageId\\(id\\) \\? '' : String\\(turnTextSignature/);
});
