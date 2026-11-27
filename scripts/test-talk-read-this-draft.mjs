import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// The exact Talk composer, its paper route, and fresh-session helper. Every
// request is held or completed by the fixture; no text reaches an endpoint.
const html=readFileSync(process.env.BZ_READ_THIS_TALK_FIXTURE ??
 new URL('../public/buzzy/talk.html',import.meta.url),'utf8');
function cut(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+1);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
const source=cut('    function submitPaper(payload','    function renderSlotChecklist(')+'\n'+
 cut('    var latestFreshChatSend = null;','        // Voice turns take the streaming lane')+
 '\nreturn await postOnce(); } finally {} }\nreturn {send:sendChatMessage,isBusy(){return paperBusy;},setEpoch(value){chatEpoch=value;}};';
async function scenario(spec){
 const draft=spec.empty?'Read this:':spec.normalChat?'Synthetic ordinary chat':'  Read this:\nSynthetic receipt notes.  ';
 const sid=i=>'sess_'+String(i).padStart(20,'0'), tasks=[], payloads=[], chatPosts=[], timers=new Map();
 let serial=0, company=spec.noCompany?null:'co_fixture_a';
 const state={sessionId:spec.fresh?null:sid(90),jobId:null,boundCompanyId:company,messages:[],paper:null};
 const mem=new Map(), ls={getItem:k=>mem.get(k)??null,setItem:(k,v)=>mem.set(k,String(v)),removeItem:k=>mem.delete(k)};
 const no=()=>{},gate=()=>{let release;const promise=new Promise(r=>release=r);return {release,promise};};
 const flush=async()=>{for(let i=0;i<55;i++)await Promise.resolve();};
 const setTimeout=(cb,ms)=>{const id=++serial;timers.set(id,{cb,ms});return id;};
 const clearTimeout=id=>timers.delete(id);
 const fire=()=>{for(const [id,{cb,ms}] of [...timers]){assert.equal(ms,15000);timers.delete(id);cb();}};
 class AbortController{constructor(){this.signal={aborted:false};}abort(){this.signal.aborted=true;}}
 function makeInput(value){const listeners=new Map();return {value,disabled:false,listeners,
   addEventListener(type,cb,options){assert.equal(type,'input');listeners.set(cb,options);},
   removeEventListener(type,cb){assert.equal(type,'input');listeners.delete(cb);},
   edit(text){this.value=text;for(const [cb,o] of [...listeners]){if(o?.once)listeners.delete(cb);cb();}}};}
 const old=makeInput(draft);let input=old;
 const note={textContent:''},els={chatSend:{disabled:false},chatMessages:{insertBefore:no},paperNote:note,paperPaste:{value:''},paperFile:{value:''},chatError:{classList:{remove:no}}};
 const doc={getElementById:id=>id==='chatInput'?input:els[id]??null,createElement:()=>({}),querySelector:()=>null},win={location:{href:'/buzzy/talk'}};
 const fetch=async(url,init)=>{
   const p=JSON.parse(init.body);
   if(url==='/fake/sessions'){
     const i=tasks.filter(t=>t.kind==='session').length+1,t={kind:'session',gate:gate()};tasks.push(t);
     if(spec.stallSetup&&i===1)await t.gate.promise;
     return {ok:true,status:200,json:async()=>({session:{id:sid(i),companyId:p.companyId??null}})};
   }
   if(url==='/api/buzzy/papers'){
     assert.equal(p.text,'Synthetic receipt notes.');assert.equal(p.fileKind,'paste');
     payloads.push(true);const t={kind:'paper',gate:gate()};tasks.push(t);
     if(spec.stallPaper&&payloads.length===1)await t.gate.promise;
     return {ok:!spec.failPaper,status:spec.failPaper?500:200,json:async()=>spec.failPaper?{error:'Synthetic refusal'}:{ok:true,paper:{id:'paper_fixture',jobId:'job_fixture',companyId:p.companyId},reply:'Synthetic lines'}};
   }
   if(url==='/fake/chat'){chatPosts.push(p.message);return {ok:true,status:200};}
   throw Error('Unexpected fixture route');
 };
 const make=new Function('window','document','chatState','localStorage','fetch','SESSIONS_BASE','CHAT_BASE','activeCompanyId','bzTakeView','pendingExecute','pendingChoice','chatEpoch','setChatMascot','renderChatMessages','voice','crypto','AbortSignal','AbortController','selectedModel','getAuthHeaders','setInterval','clearInterval','setTimeout','clearTimeout','paperBusy','paperLoad','renderPaper','bzJobUrl',source);
 const ctl=make(win,doc,state,ls,fetch,'/fake/sessions','/fake/chat',()=>company,()=>null,false,null,0,no,no,{turnSeq:0},{randomUUID:()=>'a'.repeat(32)},{timeout:()=>null},AbortController,()=>null,()=>({}),()=>0,no,setTimeout,clearTimeout,false,0,p=>{state.paper=p;},no);
 let settled=false;const pending=ctl.send().then(()=>{settled=true;});await flush();
 const snapshot=()=>({draft:input.value,count:payloads.length,sessions:tasks.filter(t=>t.kind==='session').length,busy:ctl.isBusy(),listeners:old.listeners.size,note:note.textContent});
 const initial=snapshot();assert.equal(settled,true,'composer call still settles before held paper work');
 if(spec.duplicate){await ctl.send();await flush();}
 if(spec.edit==='value')old.edit('A newer inline draft');
 if(spec.edit==='same'){old.edit('A newer inline draft');old.edit(draft);}
 if(spec.edit==='dom')input=makeInput(draft);
 if(spec.edit==='session'){state.sessionId=sid(99);ctl.setEpoch(1);state.messages=[];old.edit(draft);}
 if(spec.stallSetup){fire();await flush();}const beforeRetry=snapshot();
 if(spec.retry&&input.value){if(spec.noCompany)company='co_fixture_a';await ctl.send();await flush();}
 for(const t of tasks)t.gate.release();await pending;await flush();
 return {draft,initial,beforeRetry,after:snapshot(),lines:state.messages,chatPosts};
}
for(const spec of [{noCompany:true},{fresh:true,stallSetup:true},{failPaper:true}]){
 test('Read this keeps the original draft after '+JSON.stringify(spec),async()=>{
  const r=await scenario(spec);assert.equal(r.initial.draft,r.draft);assert.equal(r.after.draft,r.draft);
  assert.equal(r.after.count,spec.failPaper?1:0);assert.equal(r.after.listeners,0);assert.equal(r.after.busy,false);
 });
}
for(const spec of [{noCompany:true,retry:true},{fresh:true,stallSetup:true,retry:true}]){
 test('Read this retries only when explicitly sent '+JSON.stringify(spec),async()=>{
  const r=await scenario(spec);assert.equal(r.beforeRetry.draft,r.draft);assert.equal(r.beforeRetry.count,0);
  assert.equal(r.after.count,1);assert.equal(r.after.draft,'');assert.equal(r.after.listeners,0);assert.equal(r.after.sessions,spec.fresh?2:0);
 });
}
for(const duplicate of [false,true]){
 test('Read this clears unchanged draft only on confirmation (duplicate='+duplicate+')',async()=>{
  const r=await scenario({stallPaper:true,duplicate});assert.equal(r.initial.draft,r.draft);assert.equal(r.initial.listeners,1);
  assert.equal(r.after.count,1);assert.equal(r.after.draft,'');assert.equal(r.after.listeners,0);
 });
}
for(const edit of ['value','same','dom','session']){
 test('Read this late reply does not clear a new '+edit+' draft',async()=>{
  const r=await scenario({stallPaper:true,edit});assert.equal(r.initial.draft,r.draft);assert.equal(r.after.count,1);
  assert.equal(r.after.draft,edit==='value'?'A newer inline draft':r.draft);assert.equal(r.after.listeners,0);
 });
}
test('empty Read this still shows existing guidance', async()=>{
 const r=await scenario({empty:true});assert.equal(r.after.draft,'');assert.equal(r.after.count,0);assert.match(r.lines[1].content,/Drop the invoice/);
});
test('ordinary Chat composer is unchanged',async()=>{
 const r=await scenario({normalChat:true});assert.equal(r.after.draft,'');assert.equal(r.after.count,0);assert.deepEqual(r.chatPosts,['Synthetic ordinary chat']);
});
