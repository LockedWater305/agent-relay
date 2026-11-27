import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const load = (name) => readFileSync(new URL('../public/buzzy/' + name, import.meta.url), 'utf8');
const wb=load('whiteboard.js'), vs=load('voice-stage.js');
const talk=process.env.BZ_FRESH_SEND_TALK_FIXTURE
  ? readFileSync(process.env.BZ_FRESH_SEND_TALK_FIXTURE,'utf8') : load('talk.html');
function cut(s,a,b) {
 const start=s.indexOf(a),end=s.indexOf(b,start+1);
 assert.ok(start>=0&&end>start,a);
 return s.slice(start,end);
}
const helpers=cut(vs,'  function boardId() {','  // The bee in the corner')+
 cut(vs,'  window.bzFoldBoard = function () {','  if (toggle) {');
const turnStart=cut(vs,'  window.__bzTurnStart = function () {','  window.__bzFlow = function');
const bridge=cut(vs,'  window.bzBoardInstructions = function () {','  // The board\'s browser nodes');
const poll=cut(vs,'  var lastKey = boardId();','  sync();\n  // A visit starts');
const boundary=talk.includes('    var latestFreshChatSend = null;')
 ? '    var latestFreshChatSend = null;' : '    function ensureChatSession() {';
// Keep the actual composer through constructing and dispatching its first POST.
// Beyond that boundary replies/streaming are not part of the ownership test.
const sender=cut(talk,boundary,'        // Voice turns take the streaming lane')+
 '\nreturn await postOnce(); } finally {} }\nreturn {sendChatMessage,setEpoch(value){chatEpoch=value;}};';
function deferred(){let release;const promise=new Promise(r=>{release=r;});return {promise,release};}
const freshId=i=>'sess_'+i.toString(16).padStart(20,'0');
const oldInput='Use my board';
const named='The newer conversation draft';
const switched='The newer company draft';

async function pathCase({
 display='open', change, phase, wrongCompany, wrongId, nullSession, stale401, parallel, unscoped
}={}){
 const map=new Map(), captured=[], timers=[], carries=[], requests=[];
 const localStorage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),
  key:i=>[...map.keys()][i]??null,get length(){return map.size;}};
 const cards=[{id:'a',kind:'agent',title:'agent.md',body:'Use the fixture palette.',user:true,x:10,y:10},
  {id:'b',kind:'skill',title:'Inspect',body:'Name three fixture colors.',user:true,x:20,y:20}];
 const established=display==='established';
 const write=(id,value)=>localStorage.setItem('bz.board.'+id,JSON.stringify({v:2,cards:value,links:[],view:{x:0,y:0,z:1}}));
 const read=id=>JSON.parse(localStorage.getItem('bz.board.'+id)||'null')?.cards??[];
 write(established?freshId(77):'talk',cards);
 const window={location:{href:'/buzzy/talk'}}, no=()=>{};
 const chatState={mode:'chat',messages:[],sessionId:established?freshId(77):null};
 if(established)localStorage.setItem('bz_session_id',chatState.sessionId);
 window.bzTabSession=()=>chatState.sessionId;
 new Function('window','document','localStorage','fetch','setTimeout','clearTimeout','location','navigator',wb)(
  window,undefined,localStorage,async()=>{throw Error('unexpected network');},()=>0,no,
  {origin:'http://fixture.local'},{onLine:false});
 const api=window.BeeZillaWhiteboard,carry=api.carry;
 api.carry=(a,b)=>{carries.push([a,b]);return carry(a,b);};
 api.mount=(_,{boardId})=>({instructions:()=>api.instructionsFor(boardId),destroy:no,
  dock:{appendChild:no},root:{querySelector:()=>null}});
 const input={value:oldInput,disabled:false},sendBtn={disabled:false},messages={insertBefore:no};
 const stage={classList:{toggle:no}};
 const chatError={textContent:'',visible:false,classList:{remove(){chatError.visible=true;}}};
 const document={documentElement:stage,getElementById:id=>({chatInput:input,chatMessages:messages,chatSend:sendBtn,chatError}[id]),
  createElement:()=>({}),querySelector:()=>null};
 const stageCode='var board=null,boardKey=null,folded=false,wanted=false,asked=false,threadCol=null,start=null,boardHost=stage,composer={},parking=null,toggle=null;\n'+
  'var $=()=>null,voiceOn=()=>false,state=()=>({}),hasConversation=()=>false,paintSeeBoard=no,paintWords=no,paintStatus=no,paintFace=no;\n'+
  [helpers,turnStart,bridge,poll,'return {openBoard};'].join('\n');
 const lifecycle=new Function('window','localStorage','document','stage','no','setInterval',stageCode)(
  window,localStorage,document,stage,no,fn=>timers.push(fn));
 lifecycle.openBoard();if(display==='folded')window.bzFoldBoard();
 let company=unscoped ? null : 'co_fixture_a';
 const fetch=async(url,init)=>{
   if(url==='/fixture/sessions'){
    const requested=JSON.parse(init.body);
    const q={requested,head:deferred(),body:deferred(),jsonStarted:false};
    const id=freshId(requests.push(q));
    if(phase==='headers'||parallel)await q.head.promise;
    if(stale401)return {ok:false,status:401};
    return {ok:true,status:200,json:async()=>{
      q.jsonStarted=true;if(phase==='json')await q.body.promise;
      return {session:nullSession?null:{
        id:wrongId?'fixture_invalid_fresh_session':id,
        companyId:wrongCompany?'co_fixture_other':requested.companyId??null
      }};
    }};
   }
   if(url==='/fixture/chat'){captured.push(JSON.parse(init.body));return {ok:true,status:200};}
   throw Error('unexpected fixture route');
 };
 const make=new Function('window','document','chatState','localStorage','fetch','SESSIONS_BASE','CHAT_BASE','activeCompanyId','readThisBody','bzTakeView','pendingExecute','pendingChoice','chatEpoch','setChatMascot','renderChatMessages','voice','crypto','AbortSignal','selectedModel','getAuthHeaders','setInterval','clearInterval',sender);
 const ctl=make(window,document,chatState,localStorage,fetch,
  '/fixture/sessions','/fixture/chat',()=>company,()=>null,()=>({open:display!=='folded'}),
  false,null,0,no,no,{turnSeq:0},{randomUUID:()=>'a'.repeat(32)},{timeout:()=>null},()=>null,()=>({}),()=>0,no);
 const sending=ctl.sendChatMessage();
 if(phase==='json') {
  for(let i=0;i<40&&!requests[0].jsonStarted;i++)await Promise.resolve();
  assert.ok(requests[0].jsonStarted,'waited for the real composer JSON read');
 }
 if(change==='named'){
  chatState.sessionId=freshId(78);localStorage.setItem('bz_session_id',freshId(78));ctl.setEpoch(1);input.value=named;
 }
 if(change==='company'){
  company='co_fixture_b';chatState.sessionId=null;localStorage.removeItem('bz_session_id');ctl.setEpoch(1);input.value=switched;
 }
 let newer;
 if(parallel){input.value='The newer request';newer=ctl.sendChatMessage();}
 if(requests[0]) {requests[0].head.release();requests[0].body.release();}
 await sending;
 if(newer){requests[1].head.release();requests[1].body.release();await newer;}
 timers.forEach(fn=>fn());
 return {captured,carries,scratch:read('talk').map(c=>c.id),target:read(freshId(1)).map(c=>c.id),
  finalSession:chatState.sessionId,stored:localStorage.getItem('bz_session_id'),
  input:input.value,error:chatError.textContent,errorVisible:chatError.visible,location:window.location.href,
  requested:requests.map(q=>q.requested)};
}

test('open same-company scratch board continues to attach edited cards exactly once',async()=>{
 const p=await pathCase();
 assert.equal(p.captured.length,1);
 assert.match(p.captured[0].boardInstructions,/Use the fixture palette.*\nStep 1 — Inspect: Name three fixture colors/);
 assert.equal(p.captured[0].companyId,'co_fixture_a');
 assert.deepEqual(p.carries,[['talk',freshId(1)]]);
 assert.deepEqual(p.target,['a','b']);
 assert.deepEqual(p.scratch,[]);
});
test('folded legacy scratch remains untouched by this guard',async()=>{
 const p=await pathCase({display:'folded'});
 assert.equal(p.captured.length,1);
 assert.equal(p.captured[0].boardInstructions,undefined);
 assert.deepEqual(p.scratch,['a','b']);assert.deepEqual(p.target,[]);assert.deepEqual(p.carries,[]);
});
test('already selected named session needs no fresh-session request',async()=>{
 const p=await pathCase({display:'established'});
 assert.deepEqual(p.requested,[]);assert.equal(p.captured[0].sessionId,freshId(77));
 assert.match(p.captured[0].boardInstructions,/Use the fixture palette/);
});
test('unscoped chat accepts a genuine response with no company',async()=>{
 const p=await pathCase({unscoped:true});
 assert.equal(p.captured[0].sessionId,freshId(1));
 assert.equal(p.captured[0].companyId,null);
});
for(const change of ['named','company'])for(const phase of ['headers','json']){
 test('delayed '+phase+' cannot move an older send into a newer '+change+' scope',async()=>{
  const p=await pathCase({display:'folded',change,phase});
  assert.deepEqual(p.captured,[]);assert.deepEqual(p.carries,[]);
  assert.equal(p.finalSession,change==='named'?freshId(78):null);
  assert.equal(p.stored,change==='named'?freshId(78):null);
  assert.equal(p.input,change==='named'?named:switched);
  assert.equal(p.location,'/buzzy/talk');assert.equal(p.error,'');assert.equal(p.errorVisible,false);
 });
}
for(const bad of ['wrongId','wrongCompany','nullSession'])test('unusable '+bad+' preserves the current draft',async()=>{
 const p=await pathCase({display:'folded',[bad]:true});
 assert.deepEqual(p.captured,[]);assert.deepEqual(p.carries,[]);
 assert.equal(p.finalSession,null);assert.equal(p.stored,null);assert.equal(p.input,oldInput);
 assert.match(p.error,/Your message is still here/);assert.equal(p.errorVisible,true);
});
test('late 401 cannot redirect a newer conversation',async()=>{
 const p=await pathCase({display:'folded',change:'named',phase:'headers',stale401:true});
 assert.deepEqual(p.captured,[]);assert.equal(p.location,'/buzzy/talk');
 assert.equal(p.finalSession,freshId(78));assert.equal(p.input,named);assert.equal(p.error,'');
});
test('current 401 still takes the existing sign-in path',async()=>{
 const p=await pathCase({display:'folded',stale401:true});
 assert.deepEqual(p.captured,[]);assert.equal(p.location,'/buzzy/landing');
 assert.equal(p.input,oldInput);assert.equal(p.error,'');
});
test('two pending fresh sends only admit the newer request',async()=>{
 const p=await pathCase({display:'folded',parallel:true});
 assert.equal(p.requested.length,2);assert.equal(p.captured.length,1);
 assert.equal(p.captured[0].message,'The newer request');
 assert.equal(p.captured[0].sessionId,freshId(2));
 assert.equal(p.finalSession,p.captured[0].sessionId);
});
