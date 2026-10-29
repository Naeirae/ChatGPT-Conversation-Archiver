// Real Chromium CDP smoke with two virtualized feeds and a separate user tab.
// No ChatGPT credentials, source archives or extension storage are involved.
// about:blank injection works in locked-down CI/browser environments.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ['google-chrome','google-chrome-stable','chromium','chromium-browser']) {
    if (spawnSync('which',[candidate],{encoding:'utf8'}).status===0) return candidate;
  }
  throw new Error('Chrome not found; set CHROME_BIN');
}
function pageHtml(id) {
  const label=String(id).replace(/[^a-z0-9-]/gi,'');
  return '<!doctype html><html><head><meta charset="utf-8"><style>'+
    'html,body{height:100%;margin:0;font:16px system-ui}'+
    '#scroller{position:absolute;top:20px;left:20px;right:20px;height:540px;overflow-y:auto;border:1px solid #888}'+
    '#spacer{position:relative;height:27000px}'+
    '.turn{position:absolute;left:0;right:0;height:89px;border-bottom:1px solid #ccc;box-sizing:border-box}'+
    '</style></head><body data-lane="'+label+'"><div id="scroller"><div id="spacer"></div></div><script>'+
    'const scroller=document.getElementById("scroller"),spacer=document.getElementById("spacer");'+
    'function render(){const first=Math.max(0,Math.floor(scroller.scrollTop/90)-2),last=Math.min(299,first+18);'+
    'spacer.replaceChildren();for(let i=first;i<=last;i++){const div=document.createElement("div");'+
    'div.className="turn";div.dataset.messageId="lane-'+label+'-"+i;div.style.top=(i*90)+"px";'+
    'div.textContent="lane-'+label+' message "+i;spacer.appendChild(div)}}'+
    'scroller.addEventListener("scroll",render);render();'+
    'window.__captureProbe=()=>({lane:document.body.dataset.lane,top:scroller.scrollTop,'+
    'first:spacer.firstElementChild?.dataset.messageId,count:spacer.childElementCount,'+
    'visibility:document.visibilityState,hidden:document.hidden,focused:document.hasFocus()});'+
    '</script></body></html>';
}
class CDP {
  constructor(socket) {
    this.socket=socket;this.seq=0;this.pending=new Map();
    socket.addEventListener('message',e=>{
      const packet=JSON.parse(String(e.data));
      if(!packet.id)return;
      const task=this.pending.get(packet.id);
      if(!task)return;
      this.pending.delete(packet.id);
      clearTimeout(task.timeout);
      if(packet.error)task.reject(new Error(packet.error.message));
      else task.resolve(packet.result||{});
    });
  }
  send(method,params={},sessionId,ms=15000) {
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        this.pending.delete(id);reject(new Error('CDP timeout: '+method));
      },ms);
      this.pending.set(id,{resolve,reject,timeout});
      const request={id,method,params};
      if(sessionId)request.sessionId=sessionId;
      this.socket.send(JSON.stringify(request));
    });
  }
  close(){this.socket.close();}
}
async function connect(url) {
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',()=>reject(new Error('CDP WebSocket failed')),{once:true});
  });
  return new CDP(socket);
}
async function poll(check,attempts=50,delay=100) {
  let last;
  for(let i=0;i<attempts;i++){
    try{const value=await check();if(value)return value;}catch(e){last=e;}
    await sleep(delay);
  }
  throw last||new Error('Poll did not reach expected state');
}
async function main() {
  const profile=await mkdtemp(join(tmpdir(),'archiver-browser-cdp-'));
  let browser=null,cdp=null,stderr='';
  try{
    browser=spawn(chromeBinary(),[
      '--headless=new','--no-sandbox','--disable-gpu',
      '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
      '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
    ],{stdio:['ignore','ignore','pipe']});
    browser.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8000);});
    const activePort=await poll(async()=>{
      const data=await readFile(join(profile,'DevToolsActivePort'),'utf8');
      return Number(data.split('\n')[0])||null;
    },100,150);
    const protocol=await poll(async()=>{
      const response=await fetch('http://127.0.0.1:'+activePort+'/json/version');
      return response.ok?response.json():null;
    });
    cdp=await connect(protocol.webSocketDebuggerUrl);
    const sessions=[];
    for(const lane of ['a','b','foreground']){
      const target=await cdp.send('Target.createTarget',{
        url:'about:blank',newWindow:true,width:900,height:720,
        background:false,focus:lane==='foreground'
      });
      const attached=await cdp.send('Target.attachToTarget',{
        targetId:target.targetId,flatten:true
      });
      sessions.push({lane,id:attached.sessionId,targetId:target.targetId});
    }
    const [a,b,user]=sessions;
    for(const lane of [a,b,user]){
      // Inject the local deterministic fixture into about:blank, without
      // outbound navigation or Google/ChatGPT account access.
      await cdp.send('Runtime.evaluate',{
        expression:'document.open();document.write('+
          JSON.stringify(pageHtml(lane.lane))+');document.close()',
        awaitPromise:true
      },lane.id);
      await cdp.send('Runtime.enable',{},lane.id);
      await poll(async()=>{
        const result=await cdp.send('Runtime.evaluate',{
          expression:'typeof window.__captureProbe === "function"',
          returnByValue:true
        },lane.id);
        return result.result?.value===true;
      });
    }
    for(const lane of [a,b]){
      await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},lane.id);
    }
    async function metrics(lane) {
      const result=await cdp.send('Runtime.evaluate',{
        expression:'window.__captureProbe()',returnByValue:true
      },lane.id);
      return result.result?.value;
    }
    const before=await Promise.all([metrics(a),metrics(b),metrics(user)]);
    for(const x of before)assert.equal(x.top,0,'Initial scroll offset');
    for(const x of before.slice(0,2)){
      assert.equal(x.visibility,'visible','Background collector not visible');
      assert.equal(x.hidden,false,'Background collector hidden');
    }
    await Promise.all([a,b].map(lane=>cdp.send('Input.dispatchMouseEvent',{
      type:'mouseWheel',x:350,y:240,deltaX:0,deltaY:750
    },lane.id)));
    const moved=await poll(async()=>{
      const state=await Promise.all([metrics(a),metrics(b)]);
      return state.every(x=>x.top>=50)?state:null;
    },50,120);
    assert.notEqual(moved[0].first,before[0].first,'Feed A did not advance');
    assert.notEqual(moved[1].first,before[1].first,'Feed B did not advance');
    assert.match(moved[0].first,/lane-a-/);
    assert.match(moved[1].first,/lane-b-/);
    const otherBefore=moved[1].top;
    await cdp.send('Input.dispatchMouseEvent',{
      type:'mouseWheel',x:350,y:240,deltaX:0,deltaY:680
    },a.id);
    const later=await poll(async()=>{
      const state=await metrics(a);
      return state.top>moved[0].top+30?state:null;
    },50,120);
    const bUnchanged=await metrics(b);
    const userUnchanged=await metrics(user);
    assert.equal(bUnchanged.top,otherBefore,'Scrolling A moved B');
    assert.equal(userUnchanged.top,0,'Scrolling A moved user tab');
    assert.equal(userUnchanged.lane,'foreground');
    // A service-worker restart can detach the old CDP session. Prove that
    // the same browser target and rendered scroll position survive a fresh
    // debugger attachment, without disturbing the other independent lane.
    await cdp.send('Target.detachFromTarget',{sessionId:a.id});
    const restored=await cdp.send('Target.attachToTarget',{
      targetId:a.targetId,flatten:true
    });
    const resumedA={...a,id:restored.sessionId};
    await cdp.send('Emulation.setFocusEmulationEnabled',
      {enabled:true},resumedA.id);
    const beforeResume=await metrics(resumedA);
    assert.equal(beforeResume.top,later.top,
      'Reattaching CDP lost the physical scroll position');
    await cdp.send('Input.dispatchMouseEvent',{
      type:'mouseWheel',x:350,y:240,deltaX:0,deltaY:400
    },resumedA.id);
    const afterResume=await poll(async()=>{
      const state=await metrics(resumedA);
      return state.top>beforeResume.top+30?state:null;
    },50,120);
    assert.equal((await metrics(b)).top,bUnchanged.top,
      'Reattaching A altered sibling B');
    assert.equal((await metrics(user)).top,0,
      'Reattaching A altered the user page');
    // Reproduce a real Chrome page lifecycle transition through CDP.
    // The transport must be able to return a frozen page to active without
    // a foreground tab switch. A synthetic page is not a full ChatGPT E2E.
    await cdp.send('Page.setWebLifecycleState',{state:'frozen'},resumedA.id);
    await cdp.send('Page.setWebLifecycleState',{state:'active'},resumedA.id);
    await cdp.send('Input.dispatchMouseEvent',{
      type:'mouseWheel',x:350,y:240,deltaX:0,deltaY:350
    },resumedA.id);
    const afterThaw=await poll(async()=>{
      const state=await metrics(resumedA);
      return state.top>afterResume.top+30?state:null;
    },50,120);
    assert.equal((await metrics(b)).top,bUnchanged.top,
      'Waking A altered sibling B');
    assert.equal((await metrics(user)).top,0,
      'Waking A activated the user foreground page');
    console.log(JSON.stringify({
      status:'PASS',chrome:protocol.Browser,
      lanes:{
        a:{initial:before[0].top,moved:moved[0].top,
          subsequent:later.top,resumed:afterResume.top,thawed:afterThaw.top,firstId:afterThaw.first},
        b:{initial:before[1].top,moved:moved[1].top,
          firstId:moved[1].first}
      },
      resumedSession:true,lifecycleThaw:true,
      userTabTop:userUnchanged.top,
      limitation:'Synthetic virtualized pages, not authenticated ChatGPT or extension E2E'
    }));
  }catch(error) {
    console.error('Browser CDP smoke failed:',error?.stack||error);
    if(stderr)console.error('Chrome stderr tail:',stderr.slice(-3000));
    process.exitCode=1;
  }finally {
    cdp?.close();
    if(browser)browser.kill('SIGKILL');
    await sleep(300);
    await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
  }
}
await main();
