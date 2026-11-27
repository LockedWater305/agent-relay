import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

// Run the shipped paper submission and session request together. The only
// paper data is synthetic; all fetches are intercepted before an HTTP request.
const html=readFileSync(process.env.BZ_PAPER_TALK_FIXTURE ??
 new URL('../public/buzzy/talk.html',import.meta.url),'utf8');
function cut(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+1);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
const code=cut('    function submitPaper(payload) {','    function readThisBody(')+'\n'+
 cut('    function ensureChatSession(','    // The composer\'s "Do it" control.')+
 '\nreturn {send:submitPaper,isBusy(){return paperBusy;},setEpoch(value){chatEpoch=value;}};';
async function scenario(spec){
 const ids={fresh:'sess_'+'1'.repeat(20),original:'sess_'+'2'.repeat(20),newer:'sess_'+'3'.repeat(20)};
 let co='co_fixture_a',jobUrlCalls=0,paperRenderCalls=0;
 const s={sessionId:spec.established?ids.original:null,jobId:spec.established?'job_original':null,boundCompanyId:co,messages:[],paper:null};
 const store=new Map(spec.established?[['bz_session_id',ids.original]]:[]);
 const ls={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 const note={textContent:''},paste={value:'fixture source draft'},file={value:''};
 const doc={getElementById:id=>({paperNote:note,paperPaste:paste,paperFile:file}[id]??null)}, win={location:{href:'/buzzy/talk'}};
 const tasks=[];const gate=()=>{let release;const promise=new Promise(r=>release=r);return {release,promise};};
 const lookup=w=>tasks.find(t=>t.where===w);
 const fetch=async(url,init)=>{
   assert.ok(['/fixture/sessions','/api/buzzy/papers'].includes(url));
   const where=url==='/fixture/sessions'?'session':'paper',input=JSON.parse(init.body);
   const req={where,input,header:gate(),body:gate(),bodyStarted:false};tasks.push(req);
   if(spec.wait===where+'-headers'&&(!spec.recovery||tasks.filter(x=>x.where===where).length===1))await req.header.promise;
   if(spec.reject&&where==='paper')throw Error('Synthetic reply failure');
   return {ok:!spec.unauthorized,status:spec.unauthorized?401:200,json:async()=>{
     req.bodyStarted=true;if(spec.wait===where+'-json')await req.body.promise;
     if(where==='session')return {session:spec.malformed?null:{id:ids.fresh,companyId:input.companyId}};
     return {ok:true,paper:{id:'paper_fixture',jobId:input.jobId||'job_first_paper',companyId:input.companyId},reply:'Synthetic proposed lines'};
   }};
 };
 const make=new Function('document','window','chatState','localStorage','activeCompanyId','fetch','SESSIONS_BASE','renderChatMessages','renderPaper','bzJobUrl','chatEpoch','paperBusy','paperLoad',code);
 const ctl=make(doc,win,s,ls,()=>co,fetch,'/fixture/sessions',()=>{},p=>{paperRenderCalls++;s.paper=p;},()=>jobUrlCalls++,0,false,0);
 const send=()=>ctl.send({filename:'',fileKind:'paste',text:'Synthetic paper text only.'});
 const sent=send(),[where,boundary]=(spec.wait||'').split('-');
 if(where){for(let i=0;i<50&&(!lookup(where)||(boundary==='json'&&!lookup(where).bodyStarted));i++)await Promise.resolve();assert.ok(lookup(where)&&(boundary!=='json'||lookup(where).bodyStarted));}
 if(spec.switchTo){
   if(spec.switchTo==='company')co='co_fixture_b';
   Object.assign(s,{sessionId:ids.newer,jobId:'job_newer',boundCompanyId:co,paper:{id:'newer_paper'},messages:[{role:'user',content:'The newer message'}]});
   ls.setItem('bz_session_id',ids.newer);ctl.setEpoch(1);paste.value='The newer draft';note.textContent='The newer note';
 }
 if(spec.recovery){assert.equal(ctl.isBusy(),true);const n=tasks.length;await send();assert.equal(tasks.length,n);}
 for(const t of tasks){t.header.release();t.body.release();}await sent;assert.equal(ctl.isBusy(),false);
 const out={first:lookup('paper')?.input,ids,session:s.sessionId,stored:ls.getItem('bz_session_id'),job:s.jobId,company:s.boundCompanyId,paper:s.paper?.id,paste:paste.value,note:note.textContent,historyCount:s.messages.length,jobUrlCalls,paperRenderCalls,href:win.location.href};
 if(spec.recovery){await send();assert.equal(ctl.isBusy(),false);out.last=tasks.filter(x=>x.where==='paper').at(-1)?.input;}
 return out;
}
for(const [label,spec] of [['fresh',{}],['named',{established:true}],['null-session',{malformed:true}]]){
 test('a current '+label+' paper follows its original scope',async()=>{
  const a=await scenario(spec);
  assert.equal(a.first.companyId,'co_fixture_a',label);
  assert.equal(a.first.sessionId,label==='fresh'?a.ids.fresh:label==='named'?a.ids.original:undefined,label);
  assert.equal(a.job,label==='named'?'job_original':'job_first_paper');
  assert.equal(a.paper,'paper_fixture');assert.equal(a.paste,'');assert.equal(a.historyCount,2);
  assert.equal(a.jobUrlCalls,1);assert.equal(a.paperRenderCalls,1);assert.equal(a.href,'/buzzy/talk');
 });
}
for(const established of [false,true]){
 test('current authorization denial still redirects ('+(established?'paper':'session')+')',async()=>{
  const a=await scenario({established,unauthorized:true});
  assert.equal(!!a.first,established);assert.equal(a.href,'/buzzy/landing');
 });
}
for(const spec of [
 {wait:'session-headers',switchTo:'named'}, {wait:'session-json',switchTo:'company'},
 {established:true,switchTo:'named'}, {established:true,wait:'paper-headers',switchTo:'company'},
 {established:true,wait:'paper-json',switchTo:'named'},
 {established:true,wait:'paper-headers',switchTo:'named',unauthorized:true},
 {wait:'session-headers',switchTo:'named',unauthorized:true},
 {established:true,wait:'paper-headers',switchTo:'named',reject:true},
 {established:true,wait:'paper-headers',switchTo:'company',recovery:true},
]){
 test('a superseded paper keeps the new scope: '+JSON.stringify(spec),async()=>{
  const a=await scenario(spec),issued=spec.wait?.startsWith('paper-')??false;
  assert.equal(!!a.first,issued,JSON.stringify(spec));
  if(issued){assert.equal(a.first.companyId,'co_fixture_a');assert.equal(a.first.sessionId,a.ids.original);assert.equal(a.first.jobId,'job_original');}
  assert.equal(a.session,a.ids.newer);assert.equal(a.stored,a.ids.newer);assert.equal(a.job,'job_newer');
  assert.equal(a.company,spec.switchTo==='company'?'co_fixture_b':'co_fixture_a');assert.equal(a.paper,'newer_paper');
  assert.equal(a.paste,'The newer draft');assert.equal(a.note,'The newer note');assert.equal(a.historyCount,1);
  assert.equal(a.jobUrlCalls,0);assert.equal(a.paperRenderCalls,0);assert.equal(a.href,'/buzzy/talk');
  if(spec.recovery){assert.equal(a.last.companyId,'co_fixture_b');assert.equal(a.last.sessionId,a.ids.newer);assert.equal(a.last.jobId,'job_newer');}
 });
}
