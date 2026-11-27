import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// Execute both actual first-session callers with a virtual clock. All I/O is
// stubbed and an intentionally misbehaving transport ignores AbortSignal.
const html=readFileSync(process.env.BZ_FRESH_DEADLINE_TALK_FIXTURE ??
 new URL('../public/buzzy/talk.html',import.meta.url),'utf8');
function cut(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+1);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
const source=cut('    function submitPaper(','    function readThisBody(')+'\n'+
 cut('    var latestFreshChatSend = null;','        // Voice turns take the streaming lane')+
 '\nreturn await postOnce(); } finally {} }\nreturn {text:sendChatMessage,paper:submitPaper,isBusy(){return paperBusy;},setEpoch(value){chatEpoch=value;}};';
async function scenario(spec){
 const sid=i=>'sess_'+String(i).padStart(20,'0'), tasks=[], marks=[], calls=[];
 let company='co_fixture_a', timerSeq=0;
 const deadlines=new Map(), state={sessionId:spec.established?sid(90):null,jobId:null,boundCompanyId:company,messages:[],paper:null};
 const store=new Map(),ls={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 if(spec.established)ls.setItem('bz_session_id',sid(90));
 const no=()=>{},gate=()=>{let release;const promise=new Promise(r=>release=r);return {release,promise};};
 const flush=async()=>{for(let i=0;i<45;i++)await Promise.resolve();};
 const setTimeout=(fn,ms)=>{deadlines.set(++timerSeq,{fn,ms});return timerSeq;};
 const clearTimeout=id=>deadlines.delete(id);
 const fire=()=>{for(const [id,{fn,ms}] of [...deadlines]){assert.equal(ms,15000);deadlines.delete(id);fn();}};
 class AbortController{constructor(){this.signal={aborted:false};marks.push(this.signal);}abort(){this.signal.aborted=true;}}
 const input={value:'Synthetic typed draft',disabled:false},sendBtn={disabled:false},messages={insertBefore:no};
 const note={textContent:''},paste={value:'Synthetic pasted paper draft'},file={value:''};
 const chatError={textContent:'',visible:false,classList:{remove(){chatError.visible=true;}}};
 const els={chatInput:input,chatSend:sendBtn,chatMessages:messages,paperNote:note,paperPaste:paste,paperFile:file,chatError};
 const doc={getElementById:id=>els[id]??null,createElement:()=>({}),querySelector:()=>null},win={location:{href:'/buzzy/talk'}};
 const fetch=async(url,init)=>{
   assert.ok(['/fixture/sessions','/fixture/chat','/api/buzzy/papers'].includes(url));
   const p=JSON.parse(init.body);
   if(url!=='/fixture/sessions'){
     calls.push({url,session:p.sessionId,company:p.companyId});
     return {ok:true,status:200,json:async()=>({ok:true,paper:{id:'paper_fixture',jobId:p.jobId||'job_fixture_auto',companyId:p.companyId}})};
   }
   const n=tasks.length+1,t={n,signal:init.signal,headers:gate(),jsonGate:gate(),jsonStarted:false};tasks.push(t);
   if(n===1&&spec.networkFailure)throw Error('Synthetic current socket closure');
   if(n===1&&spec.serverBusy)return {ok:false,status:503};
   const stalled=n===1&&spec.phase;
   if(stalled==='headers')await t.headers.promise;
   const is401=n===1&&spec.status401;
   return {ok:!is401,status:is401?401:200,json:async()=>{
      t.jsonStarted=true;if(stalled==='json')await t.jsonGate.promise;
      return {session:spec.nullSession&&n===1?null:{id:sid(n),companyId:p.companyId??null}};
   }};
 };
 const make=new Function('window','document','chatState','localStorage','fetch','SESSIONS_BASE','CHAT_BASE','activeCompanyId','readThisBody','bzTakeView','pendingExecute','pendingChoice','chatEpoch','setChatMascot','renderChatMessages','voice','crypto','AbortSignal','AbortController','selectedModel','getAuthHeaders','setInterval','clearInterval','setTimeout','clearTimeout','paperBusy','paperLoad','renderPaper','bzJobUrl',source);
 const ctl=make(win,doc,state,ls,fetch,'/fixture/sessions','/fixture/chat',()=>company,()=>null,()=>null,false,null,0,no,no,{turnSeq:0},{randomUUID:()=>'a'.repeat(32)},{timeout:()=>null},AbortController,()=>null,()=>({}),()=>0,no,setTimeout,clearTimeout,false,0,p=>{state.paper=p;},no);
 const send=()=>spec.kind==='paper'?ctl.paper({filename:'',fileKind:'paste',text:'Only fake text.'}):ctl.text();
 let done=false;const pending=send().then(()=>{done=true;});await flush();
 if(spec.phase==='json')assert.equal(tasks[0]?.jsonStarted,true);
 const duplicate=[];if(spec.duplicate){duplicate.push(send());await flush();}
 if(spec.switchScope){
   company='co_fixture_b';Object.assign(state,{sessionId:sid(99),jobId:'job_newer',boundCompanyId:company});
   ls.setItem('bz_session_id',state.sessionId);ctl.setEpoch(1);
   input.value='Synthetic newer typed draft';paste.value='Synthetic newer paper draft';note.textContent='Synthetic newer note';
 }
 const capture=()=>({done,busy:ctl.isBusy(),calls:[...calls],sessions:tasks.length,session:state.sessionId,stored:ls.getItem('bz_session_id'),href:win.location.href,
   input:input.value,paste:paste.value,note:note.textContent,error:chatError.visible?chatError.textContent:null,count:deadlines.size,aborted:marks.some(s=>s.aborted)});
 const before=capture();fire();await flush();const after=capture();
 if(spec.retry&&done){await send();await flush();}
 const retry=capture();for(const t of tasks){t.headers.release();t.jsonGate.release();}
 await pending;await Promise.all(duplicate);await flush();
 return {before,after,retry,late:capture(),first:sid(1),second:sid(2),newer:sid(99),existing:sid(90)};
}

for(const kind of ['text','paper']){
 test(kind+' completes a normal fresh request and clears its timer',async()=>{
  const r=await scenario({kind});assert.equal(r.after.done,true);assert.equal(r.after.calls.length,1);assert.equal(r.after.calls[0].session,r.first);assert.equal(r.after.count,0);assert.equal(r.after.aborted,false);
 });
 test(kind+' uses an established session without a new request',async()=>{
  const r=await scenario({kind,established:true});assert.equal(r.after.sessions,0);assert.equal(r.after.calls[0].session,r.existing);assert.equal(r.after.count,0);
 });
 test(kind+' preserves a current authorization denial redirect',async()=>{
  const r=await scenario({kind,status401:true});assert.equal(r.after.href,'/buzzy/landing');assert.equal(r.after.calls.length,0);assert.equal(r.after.count,0);
 });
 test(kind+' does not redirect on a denial arriving after its deadline',async()=>{
  const r=await scenario({kind,phase:'headers',status401:true});assert.equal(r.after.done,true);assert.equal(r.late.href,'/buzzy/talk');assert.equal(r.late.calls.length,0);
 });
 test(kind+' preserves existing duplicate-click handling with bounded waits',async()=>{
  const r=await scenario({kind,phase:'headers',duplicate:true});
  assert.equal(r.before.sessions,kind==='text'?2:1);assert.equal(r.after.done,true);assert.equal(r.late.calls.length,kind==='text'?1:0);
 });
 for(const phase of ['headers','json']){
  test(kind+' times out held '+phase+', preserves the draft and only sends on explicit retry',async()=>{
   const r=await scenario({kind,phase,retry:true});
   assert.equal(r.before.done,false);assert.equal(r.after.done,true);assert.equal(r.after.busy,false);assert.equal(r.after.aborted,true);
   assert.equal(r.after.count,0);assert.equal(r.after.calls.length,0);assert.equal(r.after.sessions,1);assert.equal(r.after.session,null);assert.equal(r.after.stored,null);
   assert.equal(r.after.input,'Synthetic typed draft');assert.equal(r.after.paste,'Synthetic pasted paper draft');
   assert.match(kind==='text'?r.after.error:r.after.note,kind==='text'?/message is still here/:/No paper was submitted/);
   assert.equal(r.retry.sessions,2);assert.equal(r.retry.calls.length,1);assert.equal(r.retry.calls[0].session,r.second);
   assert.equal(r.late.calls.length,1);assert.equal(r.late.session,r.second);assert.equal(r.late.stored,r.second);assert.equal(r.late.href,'/buzzy/talk');
  });
  test(kind+' held '+phase+' cannot affect a newer scope after the deadline',async()=>{
   const r=await scenario({kind,phase,switchScope:true});
   assert.equal(r.after.done,true);assert.equal(r.after.busy,false);assert.equal(r.after.aborted,true);assert.equal(r.after.session,r.newer);assert.equal(r.after.stored,r.newer);
   assert.equal(r.after.note,'Synthetic newer note');assert.equal(r.after.error,null);
   assert.equal(r.after.input,'Synthetic newer typed draft');assert.equal(r.after.paste,'Synthetic newer paper draft');
   assert.equal(r.late.href,'/buzzy/talk');assert.equal(r.late.calls.length,0);
  });
 }
}
for(const setting of ['nullSession','networkFailure','serverBusy'])test('current non-timeout '+setting+' retains the ordinary Paper fallback',async()=>{
 const r=await scenario({kind:'paper',[setting]:true});assert.equal(r.after.sessions,1);assert.equal(r.after.calls.length,1);
 assert.equal(r.after.calls[0].session,undefined);assert.equal(r.after.count,0);assert.equal(r.after.aborted,false);
});
