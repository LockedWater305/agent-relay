// Whole shipped embedded chat + actual Project initializer / Studio mountAI.
// Full Nitro router and real chatLoop pre-provider path execute emitted SQL in
// disposable SQLite (explicit PostgreSQL interval/cast adapter). DOM/auth/H3,
// history compaction and model refusal are synthetic. No provider/network/media.
// BZ_EMBEDDED_ROOT selects a frozen baseline; real PGlite/native are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
const ROOT=resolve(process.env.BZ_EMBEDDED_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(ROOT,p),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
export const tick=async()=>{for(let i=0;i<16;i++)await new Promise(r=>setImmediate(r));};
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const response=(data,status=200)=>Response.json(data,{status});
const selected=(job='job_b',id='sess_b',company='co_bbbbbbbb')=>({session:{id,jobId:job,companyId:company}});
export async function backend(t){
 const db=new DatabaseSync(':memory:'),queries=[],requests=[],turnInputs=[],histories=[],effects=[];
 let user='owner',forbidden=0,failQuery=null;
 db.function('now',()=> '2026-11-15T12:00:00.000Z');
 db.exec(`
 CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,status TEXT,company_id TEXT,data TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE buzzy_sessions(id TEXT PRIMARY KEY,user_id TEXT,job_id TEXT,company_id TEXT,title TEXT,summary TEXT,created_at TEXT DEFAULT '2026-11-15T12:00:00.000Z',updated_at TEXT DEFAULT '2026-11-15T12:00:00.000Z');
 CREATE TABLE buzzy_chat_messages(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,session_id TEXT,role TEXT,content TEXT,created_at TEXT DEFAULT '2026-11-15T11:59:00.000Z');
 CREATE TABLE buzzy_user_memory(user_id TEXT,job_id TEXT,key TEXT,value TEXT);
 CREATE TABLE buzzy_companies(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,one_liner TEXT,website TEXT,created_at TEXT,updated_at TEXT,customer_memory TEXT);
 CREATE TABLE buzzy_company_facts(id TEXT,user_id TEXT,company_id TEXT,fact_key TEXT,label TEXT,value TEXT,status TEXT,source_label TEXT,source_page TEXT,original_value TEXT,created_at TEXT);
 CREATE TABLE buzzy_turn_log(user_id TEXT,session_id TEXT,job_id TEXT,surface TEXT,model TEXT,latency_ms INTEGER,stages TEXT,tools TEXT,artifacts TEXT);
 CREATE TABLE buzzy_job_events(job_id TEXT,user_id TEXT,actor TEXT,action TEXT,detail TEXT);
 INSERT INTO buzzy_jobs VALUES('job_a','owner','Company A work','In progress','co_aaaaaaaa','{}','old','old'),('job_b','owner','Company B work','In progress','co_bbbbbbbb','{}','old','old'),('job_same','owner','Other Company B work','In progress','co_bbbbbbbb','{}','old','old'),('job_legacy','owner','Legacy work','In progress',NULL,'{}','old','old'),('job_foreign','foreign','Foreign work','In progress','co_ffffffff','{}','old','old');
 INSERT INTO buzzy_sessions(id,user_id,job_id,company_id,title) VALUES('sess_a','owner','job_a','co_aaaaaaaa','A session'),('sess_b','owner','job_b','co_bbbbbbbb','B session'),('sess_same','owner','job_same','co_bbbbbbbb','Other B session'),('sess_legacy','owner','job_legacy',NULL,'Legacy session'),('sess_foreign','foreign','job_foreign','co_ffffffff','Foreign session');
 INSERT INTO buzzy_companies VALUES('co_aaaaaaaa','owner','Company A','','','old','old','[]'),('co_bbbbbbbb','owner','Company B','','','old','old','[]'),('co_ffffffff','foreign','Foreign','','','old','old','[]');
 INSERT INTO buzzy_company_facts VALUES('fact_a','owner','co_aaaaaaaa','voice','Voice','COMPANY A ONLY CONTEXT','confirmed','','','','old'),('fact_b','owner','co_bbbbbbbb','voice','Voice','COMPANY B ONLY CONTEXT','confirmed','','','','old');
 INSERT INTO buzzy_chat_messages(user_id,job_id,session_id,role,content) VALUES('owner','job_a','sess_a','user','COMPANY A ONLY HISTORY'),('owner','job_b','sess_b','user','COMPANY B ONLY HISTORY'),('owner','job_same','sess_same','user','OTHER COMPANY B PROJECT HISTORY'),('foreign','job_foreign','sess_foreign','user','FOREIGN ACCOUNT HISTORY');
 INSERT INTO buzzy_user_memory VALUES('owner','job_a','preserve','original'),('foreign',NULL,'profile_tone','foreign original');
 `);
 const protectedRows=()=>plain(['buzzy_jobs','buzzy_companies','buzzy_company_facts','buzzy_user_memory'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
 const before=protectedRows(),originalMessages=plain(db.prepare('SELECT * FROM buzzy_chat_messages ORDER BY id').all());
 const sql=async(strings,...params)=>{let text=strings[0];params.forEach((_,i)=>text+='$'+(i+1)+strings[i+1]);return sql.query(text,params);};
 sql.query=async(text,params=[])=>{
  queries.push({text,params:plain(params)});
  if(failQuery&&failQuery(text))throw Error('Synthetic metadata storage failure');
  const translated=text.replace(/now\(\) - interval '12 hours'/g,"'2026-11-15T00:00:00.000Z'").replace(/::(?:text|jsonb|int|bigint)/g,'').replace(/\$(\d+)/g,':p$1');
  return db.prepare(translated).all(Object.fromEntries(params.map((v,i)=>['p'+(i+1),v===undefined?null:v]))).map(row=>{for(const k of ['data','customer_memory'])if(typeof row[k]==='string'){try{row[k]=JSON.parse(row[k]);}catch{}}return row;});
 };
 const ctx=vm.createContext({console,Buffer,URL,URLSearchParams,Request,Response,Headers,TextEncoder,TextDecoder,ReadableStream,performance,crypto:webcrypto,process:{env:{}},setTimeout,clearTimeout});
 const unexpected=what=>()=>{forbidden++;throw Error('Forbidden dependency '+what);};
 function synthetic(values){return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});}
 function names(src,id){const m=[...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m=>m[2]===id);assert.ok(m,id);return m[1].split(',').map(s=>s.trim()).filter(Boolean);}
 // Node 26 removed transform mode. The real memory class has parameter
 // properties, so compile it with the existing TypeScript dev dependency
 // rather than erasing their runtime assignments or replacing the module.
 const memoryOutput=ts.transpileModule(read('src/lib/buzzy/memory.ts'),{fileName:'memory.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},reportDiagnostics:true});
 assert.deepEqual(memoryOutput.diagnostics??[],[],'actual memory.ts transpiles without diagnostics');
 const memory=new vm.SourceTextModule(memoryOutput.outputText,{context:ctx});await memory.link(id=>{throw Error(id);});await memory.evaluate();
 const serverSource=stripTypeScriptTypes(read('src/lib/buzzy/server.ts'));
 const serverDeps={
  '@/lib/db':{getSql:async()=>sql},'@/lib/runtime':{isLocalRuntime:()=>true},
  './honcho':{ensurePeer:async()=>{effects.push({kind:'memoryPeer'});}},'./studio':{musicContextForAgent:async()=>''},
  './context':{contextWindowFor:()=>128000,CONTEXT_COMPACT_AT:0.5,compactHistory:messages=>{histories.push(plain(messages));return {messages,compacted:false,droppedCount:0};}},
  './questions':{SLOT_IDS:[],REQUIRED_SLOTS:[],DEEPENING_IDS:[],classifyJobType:()=> 'general'},
  './intent':{isFileRequest:()=>false,isDraftRequest:()=>false},
  './modelPrefs':{readModelPrefs:async()=>({preference:'value',localOnly:true})},
  './modelPolicy':{selectModel:()=>({refused:true,reason:'Synthetic provider-free policy refusal',refusedReason:'test_provider_forbidden',phase:'discovery',policyVersion:'test'})},
 };
 const server=new vm.SourceTextModule(serverSource,{context:ctx});await server.link(id=>id==='./memory'?memory:synthetic(Object.fromEntries(names(serverSource,id).map(n=>[n,serverDeps[id]?.[n]??unexpected('server '+id+'.'+n)]))));await server.evaluate();
 const source=stripTypeScriptTypes(read('src/lib/buzzy/chat.nitro.ts')),deps={
  h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,getHeader:(e,k)=>e.req.headers.get(k),setResponseStatus:(e,n)=>e.status=n,setResponseHeader(){}},
  '@/lib/db':{getSql:async()=>sql},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},
  './server':{chatLoop:async req=>{turnInputs.push(plain({...req,onText:undefined,onTool:undefined,onStage:undefined,speech:undefined}));return server.namespace.chatLoop(req);}},
  './entitlements':{checkQuota:async value=>{effects.push({kind:'quota',value:plain(value)});return {ok:true};},recordUsage:async value=>{effects.push({kind:'usage',value:plain(value)});}},'./telemetry':{recordTelemetry:async(_sql,value)=>{effects.push({kind:'telemetry',value:plain(value)});}},
 };
 const route=new vm.SourceTextModule(source,{context:ctx});await route.link(id=>synthetic(Object.fromEntries(names(source,id).map(n=>[n,deps[id]?.[n]??unexpected('route '+id+'.'+n)]))));await route.evaluate();
 async function fetch(url,init={}){
  assert.ok(['/api/buzzy/sessions','/api/buzzy/chat'].includes(url),'only actual owned-session/chat routes');
  const entry={url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null};requests.push(entry);
  const e={path:url,status:200,req:new Request('http://synthetic'+url,init)},value=await route.namespace.default(e);entry.status=e.status;
  return value instanceof Response?value:response(value,e.status);
 }
 t.after(()=>{assert.equal(forbidden,0,'zero provider/network dependencies');assert.deepEqual(protectedRows(),before,'jobs/companies/facts/profile unchanged');assert.deepEqual(plain(db.prepare('SELECT * FROM buzzy_chat_messages WHERE id<=4 ORDER BY id').all()),originalMessages,'historical transcripts unchanged');db.close();});
 return {db,queries,requests,turnInputs,histories,effects,fetch,failQuery:predicate=>failQuery=predicate,snapshot:()=>plain(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])),user:v=>user=v,messages:()=>plain(db.prepare('SELECT * FROM buzzy_chat_messages WHERE id>4 ORDER BY id').all())};
}

class Element {
 constructor(tag,notify){this.tagName=tag;this.children=[];this.style={};this.listeners={};this.disabled=false;this.value='';this.textContent='';this.notify=notify;this.parentNode=null;this.connected=false;}
 get isConnected(){return this.connected||!!this.parentNode?.isConnected;}
 appendChild(n){if(n.parentNode)n.parentNode.removeChild(n);n.parentNode=this;this.children.push(n);return n;}
 removeChild(n){const i=this.children.indexOf(n);if(i>=0){this.children.splice(i,1);n.parentNode=null;this.notify();}return n;}
 addEventListener(n,f){(this.listeners[n]??=[]).push(f);}
 emit(n,p={}){for(const f of this.listeners[n]||[])f({key:'',preventDefault(){},...p});}
 set innerHTML(v){for(const n of this.children)n.parentNode=null;this.children=[];this._html=v;this.notify();}
 get innerHTML(){return this._html||'';}
}
export function ui(fetcher,options={}){
 const callbacks=new Set(),events={},calls=[],storage=new Map([['bz_session_id',options.stored??'sess_a']]);
 const notify=()=>queueMicrotask(()=>{for(const cb of [...callbacks])cb();});
 const element=t=>new Element(t,notify),body=element('body'),head=element('head');body.connected=head.connected=true;
 const host=body.appendChild(element('div')),location={pathname:'/buzzy/'+(options.surface||'project'),search:options.job===null?'':'?job='+encodeURIComponent(options.job||'job_b')};
 const document={body,head,createElement:element,getElementById:id=>id==='chatSlot'||id==='aiSlot'?host:id==='bz-chat-css'?head.children.find(n=>n.id===id):null};
 const window={addEventListener:(name,fn)=>(events[name]??=[]).push(fn),removeEventListener:(name,fn)=>events[name]=(events[name]||[]).filter(f=>f!==fn)};
 const ctx=vm.createContext({document,window,location,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},fetch:(url,init={})=>{calls.push({url,init,body:init.body?JSON.parse(init.body):null});return fetcher(url,init);},URLSearchParams,performance,TextDecoder,AbortController,MutationObserver:class{constructor(cb){this.cb=cb;}observe(){callbacks.add(this.cb);}disconnect(){callbacks.delete(this.cb);}},console});
 vm.runInContext(read('public/buzzy/chat.js'),ctx);
 function mount(job=options.job??'job_b',surface=options.surface||'project'){
  let handle;
  const original=window.BeeZillaChat.mount;window.BeeZillaChat.mount=(...args)=>handle=original(...args);
  try {
   if(surface==='project'){
    const project=read('public/buzzy/project.html'),start=project.indexOf('  (function () {'),end=project.indexOf('  })();',start)+7;assert.ok(start>0&&end>start);vm.runInContext(project.slice(start,end),ctx);
   }else if(surface==='studio'){
    // Actual Studio mount function, including poll setup. Plan hydration and
    // polling are tested by test-studio-plan; this fixture does not run audio.
    const html=read('public/buzzy/studio.html'),start=html.indexOf('    function mountAI()'),end=html.indexOf('\n    }',start)+6;
    Object.assign(ctx,{aiMounted:false,jobId:job,currentPage:()=>true,$:id=>document.getElementById(id),setInterval:()=>1});vm.runInContext(html.slice(start,end)+'\nmountAI();',ctx);
   }else handle=original(host,surface==='nav'?{}:{jobId:job});
  }finally{window.BeeZillaChat.mount=original;}
  const root=host.children[0],input=root.children[3].children[0],button=root.children[3].children[1];
  return {handle,root,input,button,log:root.children[1],stage:root.children[2],send(text='Question about this project'){input.value=text;button.emit('click');},enter(text){if(text!==undefined)input.value=text;input.emit('keydown',{key:'Enter'});},texts(){return root.children[1].children.map(n=>n.textContent);}};
 }
 const f={ctx,host,body,head,calls,storage,location,mount,emit(name){for(const fn of [...events[name]||[]])fn();},navigate(path='/buzzy/library',search=''){location.pathname=path;location.search=search;},detach(){body.removeChild(host);},async settled(){await tick();}};
 f.page=mount(options.job===null?null:options.job||'job_b');return f;
}

for(const surface of ['project','studio'])for(const stored of ['sess_a','sess_same','sess_b','sess_foreign','sess_absent',''])test(surface+' resolves owned job instead of global '+JSON.stringify(stored),async t=>{
 const h=await backend(t),u=ui(h.fetch,{surface,stored});u.page.send();await tick();
 assert.equal(h.requests[0].url,'/api/buzzy/sessions');assert.deepEqual(h.requests[0].body,{jobId:'job_b'});
 assert.equal(h.turnInputs.length,1);assert.equal(h.turnInputs[0].sessionId,'sess_b');assert.equal(h.turnInputs[0].jobId,'job_b');assert.equal(h.turnInputs[0].companyName,'Company B');
 assert.deepEqual(h.histories[0],[{role:'user',content:'COMPANY B ONLY HISTORY'}]);assert.equal(h.messages()[0].session_id,'sess_b');assert.equal(h.messages()[0].job_id,'job_b');assert.equal(u.storage.get('bz_session_id'),stored);
});
for(const job of ['job_a','job_same','job_legacy'])test('actual resolver supports owned '+job+' without reassigning records',async t=>{
 const h=await backend(t),u=ui(h.fetch,{job});u.page.send();await tick();assert.equal(h.turnInputs[0].jobId,job);assert.equal(h.messages()[0].job_id,job);assert.equal(h.messages()[0].session_id,job.replace('job_','sess_'));
});
for(const job of ['job_foreign','job_missing',' ','job_b/foreign'])test('actual resolver denies '+JSON.stringify(job)+' before chat or history',async t=>{
 const h=await backend(t),u=ui(h.fetch,{job});u.page.send('Keep this question');await tick();assert.equal(h.turnInputs.length,0);assert.equal(h.histories.length,0);assert.equal(h.messages().length,0);assert.equal(u.page.input.value,'Keep this question');assert.equal(u.page.button.disabled,false);assert.match(u.page.stage.textContent,/not opened|identify this project/);
});
test('actual signed-out resolver refuses before SQL and retry succeeds',async t=>{
 const h=await backend(t);h.user(null);const u=ui(h.fetch);u.page.send();await tick();assert.equal(h.queries.length,0);assert.equal(h.messages().length,0);assert.ok(u.page.input.value);h.user('owner');u.page.button.emit('click');await tick();assert.equal(h.messages().length,1);
});
test('expired job session resolves a new owned session without deleting history',async t=>{
 const h=await backend(t);h.db.prepare("UPDATE buzzy_sessions SET updated_at='2020' WHERE id='sess_b'").run();const u=ui(h.fetch);u.page.send();await tick();assert.notEqual(h.turnInputs[0].sessionId,'sess_a');assert.notEqual(h.turnInputs[0].sessionId,'sess_b');assert.equal(h.messages()[0].session_id,h.turnInputs[0].sessionId);assert.equal(h.db.prepare("SELECT count(*) n FROM buzzy_sessions WHERE job_id='job_b'").get().n,2);
});
test('unscoped nav Ask uses authenticated companyless resolver, never global Talk selection',async t=>{
 const h=await backend(t),u=ui(h.fetch,{job:null,surface:'nav'});u.page.send();await tick();assert.deepEqual(h.requests[0].body,{});assert.notEqual(h.turnInputs[0].sessionId,'sess_a');assert.equal(h.turnInputs[0].companyName,null);assert.equal(u.storage.get('bz_session_id'),'sess_a');
});

for(const status of [401,403,404,409,500])test('resolver HTTP '+status+' keeps question; explicit retry only',async()=>{
 let fail=true;const u=ui(async url=>url.endsWith('sessions')?response(fail?{error:'No selected conversation'}:selected(),fail?status:200):response({reply:'ok'}));u.page.send('kept');await tick();assert.equal(u.calls.length,1);assert.equal(u.page.input.value,'kept');assert.equal(u.page.log.children.length,0);assert.equal(u.page.input.disabled,false);fail=false;u.page.button.emit('click');await tick();assert.equal(u.calls.length,3);assert.equal(u.page.texts().at(-1),'ok');
});
for(const value of [null,[],{}, {session:{}},selected('job_a'),selected('job_b',''),{session:{id:'s',jobId:'job_b'}},{session:{id:'s',jobId:'job_b',companyId:{}}},{error:true,...selected()},{ok:false,...selected()}])test('malformed/mismatched resolver fails closed '+JSON.stringify(value),async()=>{
 const u=ui(async()=>response(value));u.page.send('kept');await tick();assert.equal(u.calls.length,1);assert.equal(u.page.input.value,'kept');assert.equal(u.page.log.children.length,0);assert.equal(u.page.button.disabled,false);
});
for(const failure of ['transport','json'])test('resolver '+failure+' failure preserves draft and unlocks',async()=>{
 const u=ui(async()=>{if(failure==='transport')throw Error('offline');return {ok:true,json:async()=>{throw Error('malformed JSON');}};});u.page.send('kept');await tick();assert.equal(u.page.input.value,'kept');assert.equal(u.page.button.disabled,false);assert.equal(u.page.log.children.length,0);
});
test('pending resolver holds Send and Enter before one actual SQL turn',async t=>{
 const h=await backend(t),gate=deferred();const u=ui(async(url,init)=>{if(url.endsWith('sessions'))await gate.promise;return h.fetch(url,init);});u.page.send('one');u.page.enter();u.page.button.emit('click');assert.equal(u.calls.length,1);assert.equal(u.page.button.disabled,true);assert.equal(u.page.input.value,'one');gate.resolve();await tick();assert.equal(h.turnInputs.length,1);assert.equal(h.messages().length,1);
});
test('pending resolver body is still unverified and repeated Send is held',async()=>{
 const gate=deferred(),u=ui(async url=>url.endsWith('sessions')?{ok:true,json:()=>gate.promise}:response({reply:'ok'}));u.page.send();await tick();u.page.enter();assert.equal(u.calls.length,1);assert.equal(u.page.log.children.length,0);gate.resolve(selected());await tick();assert.equal(u.calls.length,2);
});
for(const phase of ['headers','body'])for(const retire of ['remount','detach','navigate','pagehide','back'])test(phase+' resolver completion after '+retire+' cannot send or change replacement',async()=>{
 const gate=deferred();let first=true;const u=ui(async url=>{if(url.endsWith('sessions')&&first){first=false;return phase==='headers'?gate.promise:{ok:true,json:()=>gate.promise};}return url.endsWith('sessions')?response(selected()):response({reply:'new reply'});});const old=u.page;old.send('old question');await tick();let next;
 if(retire==='remount')next=u.mount();else if(retire==='detach')u.detach();else if(retire==='navigate')u.navigate();else if(retire==='pagehide')u.emit('pagehide');else {u.navigate();u.navigate('/buzzy/project','?job=job_b');u.emit('popstate');}
 await tick();gate.resolve(phase==='headers'?response(selected()):selected());await tick();assert.equal(u.calls.filter(r=>r.url.endsWith('/chat')).length,0);assert.equal(u.storage.get('bz_session_id'),'sess_a');
 if(next){assert.equal(next.log.children.length,0);next.send('new question');await tick();assert.equal(next.texts().at(-1),'new reply');old.handle.destroy();assert.equal(u.host.children[0],next.root);}
});
test('resolver failure after retired owner cannot unlock a newer pending turn',async()=>{
 const oldGate=deferred(),newGate=deferred();let count=0;const u=ui(async url=>url.endsWith('sessions')?(++count===1?oldGate.promise:newGate.promise):response({reply:'ok'}));u.page.send();const next=u.mount();next.send();oldGate.reject(Error('old failed'));await tick();assert.equal(next.button.disabled,true);newGate.resolve(response(selected()));await tick();assert.equal(next.button.disabled,false);
});
for(const phase of ['headers','body'])test('stale '+phase+' chat response cannot paint, adopt IDs or overwrite Talk',async()=>{
 const gate=deferred();let count=0;const u=ui(async url=>url.endsWith('sessions')?response(selected()):(++count===1?(phase==='headers'?gate.promise:{ok:true,headers:new Headers(),json:()=>gate.promise}):response({reply:'new'})));const old=u.page;old.send('old');await tick();const before=old.texts();const next=u.mount();next.send('new');await tick();gate.resolve(phase==='headers'?response({reply:'stale',sessionId:'sess_a',jobId:'job_a',artifacts:[{url:'forbidden'}]}):{reply:'stale',sessionId:'sess_a'});await tick();assert.deepEqual(old.texts(),before);assert.equal(next.texts().at(-1),'new');assert.equal(next.button.disabled,false);assert.equal(u.storage.get('bz_session_id'),'sess_a');
});
test('pending accepted chat owns repeat Enter/click and re-resolves on next explicit turn',async t=>{
 const h=await backend(t),gate=deferred();const u=ui(async(url,init)=>{if(url.endsWith('/chat'))await gate.promise;return h.fetch(url,init);});u.page.send();await tick();u.page.enter('second');u.page.button.emit('click');assert.equal(u.calls.length,2);gate.resolve();await tick();assert.equal(h.messages().length,1);u.page.send('second');await tick();assert.equal(h.messages().length,2);assert.equal(u.calls.filter(r=>r.url.endsWith('sessions')).length,2);
});
for(const status of [403,404,500])test('HTTP chat '+status+' cannot look like successful reply, next retry re-resolves',async()=>{
 const u=ui(async url=>url.endsWith('sessions')?response(selected()):response({reply:'not a success'},status));u.page.send();await tick();assert.match(u.page.texts().at(-1),/turn failed/);assert.equal(u.page.button.disabled,false);u.page.send('retry');await tick();assert.equal(u.calls.filter(r=>r.url.endsWith('sessions')).length,2);
});
for(const data of [{reply:'wrong session',sessionId:'sess_a'}, {reply:'wrong job',jobId:'job_a'}, null, [], {ok:false}, {error:true}])test('invalid final reply does not adopt context '+JSON.stringify(data),async()=>{
 const u=ui(async url=>url.endsWith('sessions')?response(selected()):response(data));u.page.send();await tick();assert.match(u.page.texts().at(-1),/turn failed/);assert.equal(u.storage.get('bz_session_id'),'sess_a');u.page.send('next');await tick();assert.deepEqual(u.calls.filter(r=>r.url.endsWith('sessions')).map(r=>r.body),[{jobId:'job_b'},{jobId:'job_b'}]);
});
function stream(){let c,cancelled=0;const body=new ReadableStream({start(controller){c=controller;},cancel(){cancelled++;}});return {response:new Response(body,{headers:{'content-type':'text/event-stream'}}),frame:(event,data)=>{try{c.enqueue(new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'));}catch{}},close:()=>{try{c.close();}catch{}},cancelled:()=>cancelled};}
test('matching live stream keeps stage, text and artifact behavior without Talk writes',async()=>{
 const s=stream(),u=ui(async url=>url.endsWith('sessions')?response(selected()):s.response);u.page.send();await tick();s.frame('stage',{label:'Reading'});s.frame('tool',{state:'running',name:'read_context'});s.frame('text',{t:'partial'});await tick();assert.equal(u.page.texts().at(-1),'partial');assert.match(u.page.stage.textContent,/read context/);s.frame('done',{reply:'final',jobId:'job_b',sessionId:'sess_b',artifacts:[{name:'Synthetic metadata',url:'/api/buzzy/assets/1',bytes:4}]});s.close();await tick();assert.equal(u.page.log.children[1].textContent,'final');assert.equal(u.page.log.children.length,3);assert.equal(u.storage.get('bz_session_id'),'sess_a');assert.equal(u.page.button.disabled,false);
});
for(const action of ['remount','detach','navigate','pagehide','back'])test('live stream after '+action+' cannot change a newer owner',async()=>{
 const s=stream();let first=true;const u=ui(async url=>url.endsWith('sessions')?response(selected()):first?(first=false,s.response):response({reply:'new'}));const old=u.page;old.send();await tick();s.frame('text',{t:'before'});await tick();let next;if(action==='remount')next=u.mount();else if(action==='detach')u.detach();else if(action==='navigate')u.navigate();else if(action==='pagehide')u.emit('pagehide');else u.emit('popstate');await tick();const before=old.texts();s.frame('text',{t:'stale'});s.frame('done',{reply:'stale',jobId:'job_a',sessionId:'sess_a'});s.close();await tick();assert.deepEqual(old.texts(),before);assert.equal(u.storage.get('bz_session_id'),'sess_a');if(next){next.send();await tick();assert.equal(next.texts().at(-1),'new');}
});
for(const event of ['error','incomplete'])test('stream '+event+' unlocks only its current turn',async()=>{
 const s=stream(),u=ui(async url=>url.endsWith('sessions')?response(selected()):s.response);u.page.send();await tick();if(event==='error')s.frame('error',{error:'synthetic stream failure'});s.close();await tick();assert.match(u.page.texts().at(-1),/turn failed/);assert.equal(u.page.button.disabled,false);assert.equal(u.page.input.disabled,false);
});
test('explicit destroy cancels pending request and old handle cannot clear next mount',async()=>{
 const gate=deferred(),u=ui(()=>gate.promise),old=u.page;old.send();old.handle.destroy();assert.equal(u.calls[0].init.signal.aborted,true);const next=u.mount();old.handle.destroy();assert.equal(u.host.children[0],next.root);old.handle.say('stale');assert.equal(next.log.children.length,0);gate.resolve(response(selected()));await tick();assert.equal(u.calls.length,1);
});
test('two independent current surfaces keep job-scoped SQL and never touch global Talk selection',async t=>{
 const h=await backend(t),a=ui(h.fetch,{job:'job_a'}),b=ui(h.fetch,{job:'job_b',surface:'studio'});a.page.send('A question');b.page.send('B question');await tick();assert.deepEqual(h.messages().map(m=>[m.job_id,m.session_id]).sort(),[['job_a','sess_a'],['job_b','sess_b']]);assert.equal(a.storage.get('bz_session_id'),'sess_a');assert.equal(b.storage.get('bz_session_id'),'sess_a');
});
test('reload/remount resumes the actual confirmed project session without overwriting Talk pointer',async t=>{
 const h=await backend(t),first=ui(h.fetch);first.page.send('first turn');await tick();first.page.handle.destroy();const second=ui(h.fetch,{stored:'sess_a'});second.page.send('continued');await tick();assert.deepEqual(h.messages().map(m=>m.session_id),['sess_b','sess_b']);assert.ok(h.histories[1].some(m=>m.content==='first turn'));assert.equal(second.storage.get('bz_session_id'),'sess_a');
});

for (const job of [42, {}, [], '', '   ']) test('explicit malformed component job never broadens to companyless '+JSON.stringify(job),async()=>{
 const u=ui(async()=>{throw Error('must not fetch');},{surface:'component'}),p=u.mount(job,'component');p.send('keep');await tick();assert.equal(u.calls.length,0);assert.equal(p.input.value,'keep');assert.match(p.stage.textContent,/identify this project/);
});
test('resolver does not erase a newer draft value while its original question waits',async()=>{
 const gate=deferred(),u=ui(async url=>url.endsWith('sessions')?gate.promise:response({reply:'ok'}));u.page.send('original');u.page.input.value='new draft';gate.resolve(response(selected()));await tick();assert.equal(u.page.input.value,'new draft');assert.equal(u.calls[1].body.message,'original');
});
test('resolver result for previous job cannot attach to newly mounted job or mutate its options',async t=>{
 const h=await backend(t),gate=deferred();let first=true;const u=ui(async(url,init)=>{const r=await h.fetch(url,init);if(url.endsWith('sessions')&&first){first=false;await gate.promise;}return r;});const old=u.page;old.send('old B');await tick();u.navigate('/buzzy/project','?job=job_a');const next=u.mount('job_a');next.send('new A');await tick();gate.resolve();await tick();assert.equal(h.messages().length,1);assert.equal(h.messages()[0].job_id,'job_a');assert.equal(h.messages()[0].session_id,'sess_a');assert.equal(h.histories[0][0].content,'COMPANY A ONLY HISTORY');assert.equal(next.button.disabled,false);assert.equal(u.storage.get('bz_session_id'),'sess_a');
});
test('a deleted job after a completed turn must be re-verified before the next Send',async t=>{
 const h=await backend(t),u=ui(h.fetch);u.page.send('first');await tick();const row=h.db.prepare("SELECT * FROM buzzy_jobs WHERE id='job_b'").get();h.db.prepare("DELETE FROM buzzy_jobs WHERE id='job_b'").run();u.page.send('keep second');await tick();assert.equal(h.messages().length,1);assert.equal(u.page.input.value,'keep second');assert.equal(h.requests.at(-1).status,404);h.db.prepare('INSERT INTO buzzy_jobs VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));
});
test('account changes cannot turn a previous owned job into an unscoped Send',async t=>{
 const h=await backend(t),u=ui(h.fetch);u.page.send('owner turn');await tick();h.user('foreign');u.page.send('do not send');await tick();assert.equal(h.messages().length,1);assert.equal(h.requests.at(-1).status,404);assert.equal(u.page.input.value,'do not send');
});
test('old live read after same-mounted Back cannot release or paint a newer turn',async()=>{
 const readGate=deferred();let chats=0,reads=0;const u=ui(async url=>url.endsWith('sessions')?response(selected()):++chats===1?{ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:{getReader:()=>({read:()=>++reads===1?readGate.promise:Promise.resolve({done:true}),cancel:async()=>{}})}}:response({reply:'new'}));const p=u.page;p.send('old');await tick();u.emit('popstate');p.send('new');await tick();const before=p.texts();readGate.resolve({done:false,value:new TextEncoder().encode('event: text\ndata: {"t":"old late"}\n\nevent: done\ndata: {"reply":"old"}\n\n')});await tick();assert.deepEqual(p.texts(),before);assert.equal(p.texts().at(-1),'new');assert.equal(p.button.disabled,false);
});
test('accepted old SQL turn may finish, but remount never changes its immutable job/session scope',async t=>{
 const h=await backend(t),gate=deferred();let first=true;const u=ui(async(url,init)=>{if(url.endsWith('/chat')&&first){first=false;await gate.promise;}return h.fetch(url,init);});const old=u.page;old.send('accepted B');await tick();u.navigate('/buzzy/project','?job=job_a');const next=u.mount('job_a');next.send('new A');await tick();gate.resolve();await tick();assert.deepEqual(h.messages().map(m=>[m.content,m.job_id,m.session_id]).sort(),[['accepted B','job_b','sess_b'],['new A','job_a','sess_a']]);assert.equal(next.button.disabled,false);assert.equal(u.storage.get('bz_session_id'),'sess_a');
});

test('Project with no selected job cannot silently send an account-wide question',async t=>{
 const h=await backend(t),u=ui(h.fetch,{job:null});u.page.send('which project?');await tick();assert.equal(h.requests.length,0);assert.equal(h.messages().length,0);assert.equal(u.page.input.value,'which project?');assert.match(u.page.stage.textContent,/identify this project/);
});


// Current-principal admission. Rejection must precede quota/usage as well as
// history, memory, telemetry and every table write; metadata reads alone are OK.
const postChat=(h,body)=>h.fetch('/api/buzzy/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Synthetic admission question',...body})});
function noAdmissionEffects(h,before){
 assert.equal(h.turnInputs.length,0);assert.equal(h.histories.length,0);assert.deepEqual(h.effects,[],'not even quota/usage/telemetry/memory bookkeeping');assert.deepEqual(h.snapshot(),before,'all SQL table values unchanged');
 assert.ok(h.queries.every(q=>/^\s*SELECT (?:company_id|id) FROM buzzy_(?:jobs|sessions|companies) WHERE/.test(q.text)),'only owner/scope metadata may be read');
}
for(const pair of [
 {jobId:'job_foreign'}, {jobId:'job_missing'}, {sessionId:'sess_foreign'}, {sessionId:'sess_missing'},
 {jobId:'job_foreign',sessionId:'sess_b'}, {jobId:'job_b',sessionId:'sess_foreign'},
 {jobId:'job_missing',sessionId:'sess_b'}, {jobId:'job_b',sessionId:'sess_missing'},
 {jobId:'job_foreign',sessionId:'sess_foreign'},
])test('admission rejects supplied foreign/missing identity '+JSON.stringify(pair),async t=>{
 const h=await backend(t),before=h.snapshot(),res=await postChat(h,pair),body=await res.json();assert.equal(res.status,404);assert.equal(body.code,'chat_scope_unavailable');noAdmissionEffects(h,before);
});
for(const field of ['jobId','sessionId','companyId'])for(const value of ['', '  ', 42, false, [], {}])test('malformed explicit '+field+' '+JSON.stringify(value)+' cannot become unscoped',async t=>{
 const h=await backend(t),before=h.snapshot(),res=await postChat(h,{[field]:value}),body=await res.json();assert.equal(res.status,400);assert.equal(body.code,'bad_chat_scope');noAdmissionEffects(h,before);assert.equal(h.queries.length,0);
});
for(const companyId of ['co_ffffffff','co_missing12','not-a-company'])test('admission rejects unowned/missing/malformed company '+companyId,async t=>{
 const h=await backend(t),before=h.snapshot(),res=await postChat(h,{companyId}),body=await res.json();assert.equal(res.status,companyId==='not-a-company'?400:404);assert.match(body.code,/chat_scope/);noAdmissionEffects(h,before);
});
for(const body of [
 {jobId:'job_b',sessionId:'sess_a'},
 {jobId:'job_b',sessionId:'sess_a',companyId:'co_bbbbbbbb'},
 {jobId:'job_b',sessionId:'sess_b',companyId:'co_aaaaaaaa'},
 {jobId:'job_legacy',sessionId:'sess_b',companyId:'co_aaaaaaaa'},
 {jobId:'job_b',sessionId:'sess_legacy',companyId:'co_aaaaaaaa'},
 {jobId:'job_b',companyId:'co_aaaaaaaa'},
 {sessionId:'sess_b',companyId:'co_aaaaaaaa'},
])test('same-owner conflicting non-null companies fail before context '+JSON.stringify(body),async t=>{
 const h=await backend(t),before=h.snapshot(),res=await postChat(h,body),data=await res.json();assert.equal(res.status,409);assert.equal(data.code,'chat_scope_mismatch');noAdmissionEffects(h,before);
});
for(const input of [
 {}, {jobId:null,sessionId:null,companyId:null}, {jobId:'job_b'}, {sessionId:'sess_b'},
 {jobId:'job_b',sessionId:'sess_b'}, {jobId:'job_same',sessionId:'sess_b'},
 {jobId:'job_b',sessionId:'sess_same'}, {jobId:'job_legacy',sessionId:'sess_b'},
 {jobId:'job_b',sessionId:'sess_legacy'}, {jobId:'job_legacy',sessionId:'sess_legacy'},
 {jobId:'job_legacy',sessionId:'sess_legacy',companyId:'co_bbbbbbbb'},
 {jobId:'job_b',sessionId:'sess_b',companyId:'co_bbbbbbbb'}, {companyId:'co_bbbbbbbb'},
])test('owned absent/null/multi-job/legacy admission preserves stored links '+JSON.stringify(input),async t=>{
 const h=await backend(t),sessions=plain(h.db.prepare('SELECT * FROM buzzy_sessions ORDER BY id').all()),res=await postChat(h,input),body=await res.json();assert.equal(res.status,200);assert.equal(body.code,'test_provider_forbidden','real chatLoop reached declared pre-provider policy refusal');assert.equal(h.messages().length,1);assert.equal(h.messages()[0].user_id,'owner');assert.equal(h.messages()[0].job_id,input.jobId||null);assert.equal(h.messages()[0].session_id,input.sessionId||null);assert.deepEqual(plain(h.db.prepare('SELECT * FROM buzzy_sessions ORDER BY id').all()),sessions,'never rewrite the latest-job pointer');
 const co=input.companyId||(['sess_b','sess_same'].includes(input.sessionId)?'Company B':null);assert.equal(h.turnInputs[0].companyName,co==='co_bbbbbbbb'?'Company B':co);
});
test('the authenticated foreign owner may use its own identities, never those from the old account',async t=>{
 const h=await backend(t);h.user('foreign');const res=await postChat(h,{jobId:'job_foreign',sessionId:'sess_foreign'});assert.equal(res.status,200);assert.equal(h.turnInputs[0].companyName,'Foreign');assert.deepEqual(h.histories[0],[{role:'user',content:'FOREIGN ACCOUNT HISTORY'}]);assert.equal(h.messages()[0].user_id,'foreign');
});
test('historical owned session latest pointer may differ from requested owned item',async t=>{
 const h=await backend(t);h.db.prepare("UPDATE buzzy_sessions SET job_id='job_same' WHERE id='sess_b'").run();const before=plain(h.db.prepare("SELECT * FROM buzzy_sessions WHERE id='sess_b'").get()),res=await postChat(h,{jobId:'job_b',sessionId:'sess_b'});assert.equal(res.status,200);assert.equal(h.messages()[0].job_id,'job_b');assert.equal(h.messages()[0].session_id,'sess_b');assert.deepEqual(plain(h.db.prepare("SELECT * FROM buzzy_sessions WHERE id='sess_b'").get()),before);
});
for(const table of ['buzzy_jobs','buzzy_sessions'])for(const company of ['co_ffffffff','co_missing12','invalid'])test('invalid non-null stored scope cannot fall back: '+table+' '+company,async t=>{
 const h=await backend(t),id=table==='buzzy_jobs'?'job_b':'sess_b',field=table==='buzzy_jobs'?'jobId':'sessionId',old=h.db.prepare('SELECT company_id FROM '+table+' WHERE id=?').get(id).company_id;h.db.prepare('UPDATE '+table+' SET company_id=? WHERE id=?').run(company,id);const before=h.snapshot(),res=await postChat(h,{[field]:id});try{assert.equal(res.status,company==='invalid'?400:404);noAdmissionEffects(h,before);}finally{h.db.prepare('UPDATE '+table+' SET company_id=? WHERE id=?').run(old,id);}
});
for(const phase of ['headers','body'])test('pending '+phase+' resolver account change rejects before SQL effects and keeps original question',async t=>{
 const h=await backend(t),gate=deferred();let held=true;const u=ui(async(url,init)=>{const res=await h.fetch(url,init);if(url.endsWith('sessions')&&held){held=false;if(phase==='headers'){await gate.promise;return res;}const data=await res.json();return {ok:res.ok,json:async()=>{await gate.promise;return data;}};}return res;});u.page.send('Owner question kept exactly');await tick();const before=h.snapshot();h.user('foreign');gate.resolve();await tick();assert.deepEqual(h.snapshot(),before);assert.equal(h.messages().length,0);assert.equal(h.effects.length,0);assert.equal(h.turnInputs.length,0);assert.equal(u.page.input.value,'Owner question kept exactly');assert.equal(u.page.log.children.length,0);assert.match(u.page.stage.textContent,/Question not sent/);assert.equal(u.page.button.disabled,false);assert.equal(u.storage.get('bz_session_id'),'sess_a');
 h.user('owner');u.page.button.emit('click');await tick();assert.equal(h.messages().length,1);assert.equal(h.messages()[0].user_id,'owner');assert.equal(h.messages()[0].session_id,'sess_b');
});
for(const error of [{status:400,code:'bad_chat_scope'},{status:401,code:'signed_out'},{status:404,code:'chat_scope_unavailable'},{status:409,code:'chat_scope_mismatch'}])test('definite admission '+error.code+' restores only the current original draft',async()=>{
 const u=ui(async url=>url.endsWith('sessions')?response(selected()):response({error:'Reopen it',code:error.code},error.status));u.page.send(' original whitespace ');await tick();assert.equal(u.page.input.value,' original whitespace ');assert.equal(u.page.log.children.length,0);assert.match(u.page.stage.textContent,/not sent/);assert.equal(u.page.button.disabled,false);
});
test('late admission refusal preserves a newer input and visibly labels the earlier question not sent',async()=>{
 const gate=deferred(),u=ui(async url=>url.endsWith('sessions')?response(selected()):gate.promise);u.page.send('original');await tick();u.page.input.value='newer draft';gate.resolve(response({error:'Scope changed',code:'chat_scope_unavailable'},404));await tick();assert.equal(u.page.input.value,'newer draft');assert.equal(u.page.texts()[0],'original');assert.match(u.page.texts()[1],/not sent/);assert.equal(u.page.button.disabled,false);
});
for(const action of ['remount','navigate','detach','pagehide'])test('admission refusal after '+action+' cannot restore an old question',async()=>{
 const gate=deferred();let first=true;const u=ui(async url=>url.endsWith('sessions')?response(selected()):first?(first=false,gate.promise):response({reply:'new'}));const old=u.page;old.send('old');await tick();let next;
 if(action==='remount'){next=u.mount();next.input.value='new draft';}else if(action==='navigate')u.navigate();else if(action==='detach')u.detach();else u.emit('pagehide');await tick();const before=old.texts();gate.resolve(response({error:'Scope changed',code:'chat_scope_unavailable'},404));await tick();assert.equal(old.input.value,'');assert.deepEqual(old.texts(),before);if(next){assert.equal(next.input.value,'new draft');assert.equal(next.log.children.length,0);assert.equal(next.button.disabled,false);}
});
for(const failure of ['transport','body','500','wrong-status-code'])test('unknown '+failure+' outcome never falsely promises not sent or auto-retries',async()=>{
 const u=ui(async url=>{if(url.endsWith('sessions'))return response(selected());if(failure==='transport')throw Error('lost connection');if(failure==='body')return {ok:false,status:404,headers:new Headers(),json:async()=>{throw Error('lost body');}};return response({error:'uncertain',code:'chat_scope_unavailable'},failure==='wrong-status-code'?403:500);});u.page.send('possibly accepted');await tick();assert.equal(u.calls.length,2);assert.equal(u.page.input.value,'');assert.equal(u.page.texts()[0],'possibly accepted');assert.match(u.page.texts()[1],/turn failed/);assert.doesNotMatch(u.page.texts()[1],/not sent/);assert.equal(u.page.button.disabled,false);
});
test('concurrent principal-switch refusal cannot erase a newer mounted owner draft',async t=>{
 const h=await backend(t),gate=deferred();let first=true;const u=ui(async(url,init)=>{if(url.endsWith('/chat')&&first){first=false;await gate.promise;}return h.fetch(url,init);});const old=u.page;old.send('old owner');await tick();h.user('foreign');u.navigate('/buzzy/project','?job=job_foreign');const next=u.mount('job_foreign');next.send('foreign own turn');await tick();gate.resolve();await tick();assert.equal(h.messages().length,1);assert.equal(h.messages()[0].job_id,'job_foreign');assert.equal(h.messages()[0].session_id,'sess_foreign');assert.equal(h.messages()[0].user_id,'foreign');assert.equal(next.button.disabled,false);assert.equal(old.input.value,'');
});

test('direct signed-out admission has zero SQL, usage and turn effects',async t=>{
 const h=await backend(t),before=h.snapshot();h.user(null);const res=await postChat(h,{jobId:'job_b',sessionId:'sess_b'}),body=await res.json();assert.equal(res.status,401);assert.equal(body.code,'signed_out');noAdmissionEffects(h,before);assert.equal(h.queries.length,0);
});
for(const table of ['buzzy_jobs','buzzy_sessions','buzzy_companies'])test('failed '+table+' admission lookup never falls back and explicit retry can succeed',async t=>{
 const h=await backend(t),before=h.snapshot();h.failQuery(text=>text.includes('FROM '+table));await assert.rejects(postChat(h,{jobId:'job_b',sessionId:'sess_b'}),/metadata storage failure/);noAdmissionEffects(h,before);h.failQuery(null);const res=await postChat(h,{jobId:'job_b',sessionId:'sess_b'});assert.equal(res.status,200);assert.equal(h.messages().length,1);
});
for(const table of ['buzzy_jobs','buzzy_sessions'])test('stored company changed during resolver wait fails closed: '+table,async t=>{
 const h=await backend(t),gate=deferred();const u=ui(async(url,init)=>{const res=await h.fetch(url,init);if(url.endsWith('sessions')){const data=await res.json();return {ok:res.ok,json:async()=>{await gate.promise;return data;}};}return res;});u.page.send('keep original intent');await tick();const id=table==='buzzy_jobs'?'job_b':'sess_b';h.db.prepare('UPDATE '+table+' SET company_id=? WHERE id=?').run('co_aaaaaaaa',id);const before=h.snapshot();gate.resolve();await tick();try{assert.equal(h.requests.at(-1).status,409);assert.equal(h.turnInputs.length,0);assert.equal(h.effects.length,0);assert.deepEqual(h.snapshot(),before);assert.equal(u.page.input.value,'keep original intent');assert.equal(u.page.log.children.length,0);}finally{h.db.prepare('UPDATE '+table+' SET company_id=? WHERE id=?').run('co_bbbbbbbb',id);}
});
