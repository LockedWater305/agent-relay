// Whole shipped Sketch IIFE, real shell navigation, and actual art Nitro route.
// Disposable SQLite runs emitted SQL with explicit PostgreSQL JSONB adaptations.
// DOM/canvas/title-query/auth/H3 I/O are synthetic; no image decoding or provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {harness as shellHarness} from './test-shell-history.mjs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(process.env.BZ_SKETCH_ROOT||resolve(here,'..'));
const read=p=>readFileSync(resolve(root,p),'utf8');
const html=read('public/buzzy/sketch.html');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('function boardJson()'))?.[1];assert.ok(script);
const plain=v=>JSON.parse(JSON.stringify(v));
export const drain=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const savedBoard={version:1,strokes:[{id:'road_1',tool:'line',color:'#ffd40d',width:3,x1:10,y1:20,x2:180,y2:80},{id:'note_1',tool:'text',text:'Keep this road',color:'#ffffff',x1:30,y1:15,anchor:'road_1'}],images:[]};
const imageBoard={version:1,strokes:[],images:[{id:'image_a',url:'/synthetic/first.png',x:10,y:20,w:100,h:100},{id:'image_b',url:'/synthetic/second.png',x:300,y:40,w:100,h:100}]};
export async function fixture(t,board=savedBoard){
 const db=new DatabaseSync(':memory:'),queries=[],requests=[];let providerCalls=0,mediaCalls=0,user='owner',failNextRead=false,failSave=false;
 db.function('now',()=> '2026-11-15T12:00:00Z');
 db.function('jsonb_set',(data,path,value,create)=>{assert.equal(create,1);const key=path.slice(1,-1);assert.ok(['board','sources'].includes(key));return JSON.stringify({...JSON.parse(data),[key]:JSON.parse(value)});});
 db.function('json_array_concat',(a,b)=>JSON.stringify([...JSON.parse(a),...JSON.parse(b)]));
 db.exec(`CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,status TEXT,data TEXT,updated_at TEXT);
 CREATE TABLE buzzy_assets(id INTEGER,filename TEXT,content_type TEXT,bytes INTEGER,created_at TEXT,user_id TEXT,job_id TEXT);
 CREATE TABLE preserved_history(id TEXT PRIMARY KEY,body TEXT);
 INSERT INTO preserved_history VALUES('approved_document','Keep accepted content'),('transcript','Keep original conversation');`);
 const sources=[{kind:'brief',label:'Keep original brief',url:'/buzzy/project?job=job_board'},{kind:'board',label:'Prior board source',url:'/buzzy/sketch?job=job_board'}];
 for(const[id,owner]of [['job_board','owner'],['job_other','owner'],['job_foreign','foreign']])db.prepare('INSERT INTO buzzy_jobs VALUES(?,?,?,?,?,?)').run(id,owner,id,'In progress',JSON.stringify({board,sources,unrelated:{preserve:'original'}}),'original-time');
 const createdIds=new Set();
 const protectedRows=()=>JSON.stringify([db.prepare("SELECT * FROM buzzy_jobs WHERE id<>'job_board' ORDER BY id").all().filter(row=>!createdIds.has(row.id)),db.prepare('SELECT * FROM buzzy_assets').all(),db.prepare('SELECT * FROM preserved_history ORDER BY id').all()]);const protectedBefore=protectedRows();
 const execute=(text,params)=>{
  queries.push({text,params:plain(params)});
  if(failSave&&/UPDATE buzzy_jobs/.test(text))throw Error('Synthetic save storage failure');
  if(failNextRead&&/SELECT id, title, status, data FROM buzzy_jobs/.test(text)){failNextRead=false;throw Error('Synthetic one-read storage outage');}
  // JSONB object-path mutation, array expansion/aggregation and JSON-array concat
  // preserve the emitted predicates/UPDATE. These are explicit dialect adapters,
  // not a replacement save implementation; real PGlite remains a separate gate.
  let translated=text.replace(/::jsonb/g,'').replace(/\$(\d+)/g,':p$1').replace(/jsonb_array_elements\(/g,'json_each(').replace(/jsonb_agg\(x\)/g,'json_group_array(json(x.value))').replace(/x->>'kind'/g,"json_extract(x.value, '$.kind')");
  translated=translated.replace(/(COALESCE\(\(SELECT[\s\S]*?\), '\[\]'\)) \|\| (:p\d+)/g,'json_array_concat($1, $2)');
  const rows=db.prepare(translated).all(Object.fromEntries(params.map((v,i)=>['p'+(i+1),v])));
  return rows.map(row=>Object.hasOwn(row,'data')?{...row,data:JSON.parse(row.data)}:row);
 };
 const sql=async(strings,...params)=>{let text=strings[0];params.forEach((_,i)=>text+='$'+(i+1)+strings[i+1]);return execute(text,params);};sql.query=async(text,params=[])=>execute(text,params);
 const context=vm.createContext({Response,Request,Headers,URLSearchParams,Buffer});
 function dependency(exports){return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});}
 const provider=()=>{providerCalls++;throw Error('Provider/generation activity forbidden');};
 const route=new vm.SourceTextModule(stripTypeScriptTypes(read('src/lib/buzzy/art.nitro.ts')),{context});
 await route.link(id=>{
  if(id==='h3')return dependency({defineEventHandler:f=>f,getMethod:e=>e.req.method,setResponseStatus(){}});
  if(id==='@/lib/db')return dependency({getSql:async()=>sql});
  if(id==='@/lib/auth/verify.server')return dependency({getSessionUserFromHeaders:async()=>user?{id:user}:null});
  // Board reads and saves must not enter the image-generation policy path.
  if(id==='./modelPrefs')return dependency({readLocalOnlyPreference:provider});
  if(id==='./entitlements')return dependency({checkQuota:provider,recordUsage:provider});
  if(id==='./art')return dependency({artConfigured:()=>false,imageModel:()=> 'no-provider-audit',generateImage:provider,storeImage:provider});
  throw Error(id);
 });await route.evaluate();
 async function api(url,init={}){
  const method=init.method||'GET',body=init.body?JSON.parse(init.body):undefined;
  // Cold job creation is a declared fixture boundary, not a claim to execute the
  // jobs router. Board reads/writes still use the full actual art Nitro + SQL.
  if(url==='/api/buzzy/jobs'){
   assert.equal(method,'POST');assert.match(body.id,/^job_art_/);assert.equal(body.title,'Sketch board');assert.deepEqual(body.data,{});assert.equal(user,'owner');
   createdIds.add(body.id);db.prepare('INSERT INTO buzzy_jobs VALUES(?,?,?,?,?,?)').run(body.id,user,body.title,body.status,'{}','created');
   requests.push({url,method,body,status:200,response:{ok:true}});return new Response('{"ok":true}',{status:200});
  }
  assert.match(url,/^\/api\/buzzy\/art(?:\?|$)/);
  if(method==='POST')assert.equal(body.action,'save','no render/edit/provider request');
  const record={url,method,body};requests.push(record);let response;
  try{response=await route.namespace.default({path:url,req:new Request('http://synthetic'+url,{method,...(init.body?{body:init.body}:{}),headers:init.headers})});}
  catch{response=new Response(JSON.stringify({error:true,status:500,unhandled:true}),{status:500});}
  record.status=response.status;record.response=await response.clone().json();return response;
 }
 const f={db,queries,requests,api,transport:null,as:id=>user=id,failRead:()=>{failNextRead=true;},failSave:value=>{failSave=value;}};
 f.data=(id='job_board')=>JSON.parse(db.prepare('SELECT data FROM buzzy_jobs WHERE id=?').get(id).data);

 let h=shellHarness('/buzzy/sketch?job=job_board');const timers=new Map(),holds=[];let timerId=0;
 f.h=h;f.uiRequests=[];
 f.defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});holds.push(resolve);return {promise,resolve,reject};};
 function prepareDocument(){
 const create=h.document.createElement.bind(h.document);
 h.document.createElement=function(tag){
  const el=create(tag);el.disabled=false;el.classList={add(){},remove(){},toggle(){}};
  Object.defineProperty(el,'isConnected',{get(){let p=this;while(p){if(p===h.document.root)return true;p=p.parentNode;}return false;}});
  Object.defineProperty(el,'innerHTML',{set(value){for(const child of [...this.children])child.remove();this._html=value;},get(){return this._html||'';}});
  el.getBoundingClientRect=()=>({left:0,top:0,width:700,height:500});el.setPointerCapture=()=>{};el.focus=()=>{};
  el.getContext=()=>new Proxy({},{get:()=>()=>{}});
  el.dispatch=(name,props={})=>el.dispatchEvent({type:name,target:el,preventDefault(){},stopPropagation(){},...props});
  el.click=()=>{if(!el.disabled)el.dispatch('click');};
  return el;
 };
 const shellFetch=h.context.fetch;
 h.context.fetch=(url,init={})=>{
  if(!url.startsWith('/api/'))return shellFetch(url,init);
  if(url.startsWith('/api/buzzy/projects/'))return Promise.resolve(new Response(JSON.stringify({project:{title:'Owned synthetic board'}}),{status:200}));
  const req={url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null};f.uiRequests.push(req);
  return Promise.resolve().then(async()=>{
   // Optional desktop-fixture adapter executes the actual main request policy
   // before transport/route. Standalone UI/route tests leave it unset.
   if(f.authorizeRequest)await f.authorizeRequest(req);
   return f.transport?f.transport(req,()=>api(url,init)):api(url,init);
  });
 };
 h.context.setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;};h.context.clearTimeout=id=>timers.delete(id);
 h.context.Image=class{constructor(){mediaCalls++;throw Error('Image decoding forbidden');}};h.context.confirm=()=>true;h.context.prompt=()=> 'Synthetic note';
 }
 prepareDocument();
 f.event=(name,props={})=>{for(const fn of h.events.get(name)||[])fn({type:name,preventDefault(){},...props});};
 f.hide=()=>{h.document.hidden=true;h.document.dispatchEvent({type:'visibilitychange'});};
 f.show=()=>{h.document.hidden=false;h.document.dispatchEvent({type:'visibilitychange'});};
 f.timers=async ms=>{for(const[id,timer]of [...timers])if(timer.ms===ms){timers.delete(id);timer.fn();}await drain();};
 f.mount=async(job='job_board',options={})=>{
  const path='/buzzy/sketch'+(job?'?job='+encodeURIComponent(job):'');
  if(h.location.pathname+h.location.search!==path){await h.shell.go(path);}
  const main=h.document.querySelectorAll('main')[0];assert.ok(main);
  for(const child of [...main.children])child.remove();
  const elements=new Map(),toolButtons=[];
  for(const m of html.matchAll(/\bid="([^"]+)"/g)){const el=h.document.createElement(m[1]==='board'?'canvas':'div');el.id=m[1];elements.set(m[1],el);main.appendChild(el);}
  const stage=elements.get('stage');for(const id of ['board','layers','result'])stage.appendChild(elements.get(id));
  for(const m of html.matchAll(/data-tool="([^"]+)"/g)){const el=h.document.createElement('button');el.setAttribute('data-tool',m[1]);toolButtons.push(el);main.appendChild(el);}
  const p={el:id=>elements.get(id),stage,tools:toolButtons};
  p.save=async()=>{p.el('save').click();await drain();};
  p.start=async()=>{p.tools.find(n=>n.getAttribute('data-tool')==='rect').click();p.el('board').dispatch('pointerdown',{clientX:25,clientY:30,pointerId:1});await drain();};
  p.finish=async()=>{p.el('board').dispatch('pointermove',{clientX:160,clientY:170});p.el('board').dispatch('pointerup');await drain();};
  p.draw=async()=>{await p.start();await p.finish();};
  p.markCount=()=>{ // inspect through explicit production Save, not private closure injection
   return f.uiRequests.filter(r=>r.method==='POST'&&r.body?.action==='save').at(-1)?.body.board.strokes.length;
  };
  vm.runInContext(script,h.context,{filename:'actual-sketch-page.js'});
  if(options.wait!==false)await drain();
  return p;
 };
 // Explicit reconstructed desktop test seam: replace the ENTIRE renderer VM /
 // document while retaining the same authoritative route/SQL fixture. This is
 // a model of document replacement, not a claim of native navigation timing.
 f.resetDocument=function(){
  const url=h.location.href;
  for(const child of [...h.document.root.children])child.remove();
  timers.clear();
  h=shellHarness(new URL(url).pathname+new URL(url).search);h.location.href=url;f.h=h;
  prepareDocument();
  return f.mount(new URL(url).searchParams.get('job'),{wait:false});
 };
 f.posts=()=>f.requests.filter(r=>r.method==='POST'&&r.url==='/api/buzzy/art');
 f.reads=()=>f.requests.filter(r=>r.method==='GET');
 t.after(async()=>{for(const resolve of holds)resolve();await drain();assert.equal(providerCalls,0);assert.equal(mediaCalls,0);assert.equal(protectedRows(),protectedBefore);assert.equal(f.data().unrelated.preserve,'original');assert.deepEqual(f.data().sources.filter(s=>s.kind!=='board'),sources.filter(s=>s.kind!=='board'));db.close();});
 return f;
}

for(const exit of ['hide','pagehide','soft'])test(`failed initial SELECT cannot overwrite an untouched board on ${exit}`,async t=>{
 const f=await fixture(t),before=plain(f.data());f.failRead();const p=await f.mount();assert.equal(f.reads()[0].status,500);
 if(exit==='hide')f.hide();else if(exit==='pagehide')f.event('pagehide');else await f.h.shell.go('/buzzy/memory');
 await drain();assert.equal(f.posts().length,0);assert.deepEqual(f.data(),before);
 if(exit!=='soft'){assert.equal(p.el('clear').disabled,true);assert.match(p.el('status').textContent,/Retry load/);}
});
for(const phase of ['headers','body'])for(const exit of ['hide','pagehide','soft'])test(`pending initial ${phase} cannot save empty on ${exit}`,async t=>{
 const f=await fixture(t),before=plain(f.data()),gate=f.defer();let first=true;
 f.transport=async(req,next)=>{const r=await next();if(first&&req.method==='GET'){first=false;if(phase==='headers')await gate.promise;else return {ok:true,json:async()=>{await gate.promise;return r.json();}};}return r;};
 const p=await f.mount();assert.equal(p.el('clear').disabled,true);p.el('clear').click();await p.draw();
 if(exit==='hide')f.hide();else if(exit==='pagehide')f.event('pagehide');else await f.h.shell.go('/buzzy/memory');
 await drain();assert.equal(f.posts().length,0);gate.resolve();await drain();assert.deepEqual(f.data(),before);assert.equal(f.posts().length,0);
});
for(const [name,value]of [['missing',{}],['error',{error:true}],['array',{ok:true,board:[],images:[]}],['missing-strokes',{ok:true,board:{images:[]},images:[]}],['bad-points',{ok:true,board:{strokes:[{tool:'pen',points:[{}]}],images:[]},images:[]}],['bad-image',{ok:true,board:{strokes:[],images:[{}]},images:[]}],['bad-assets',{ok:true,board:null,images:{}}],['future-version',{ok:true,board:{version:2,strokes:[],images:[]},images:[]}]])test(`malformed ${name} read is not an empty-board success`,async t=>{
 const f=await fixture(t),before=plain(f.data());f.transport=async(req,next)=>req.method==='GET'?new Response(JSON.stringify(value),{status:200}):next();const p=await f.mount();f.hide();await drain();assert.equal(f.posts().length,0);assert.deepEqual(f.data(),before);assert.equal(p.el('clear').disabled,true);assert.match(p.el('status').textContent,/Retry load/);
});
for(const status of [401,403,404,500])test(`non-success ${status} cannot authorize editing even with a valid board body`,async t=>{
 const f=await fixture(t),before=plain(f.data());f.transport=async(req,next)=>req.method==='GET'?new Response(JSON.stringify({ok:true,board:savedBoard,images:[]}),{status}):next();const p=await f.mount();await p.draw();f.hide();await drain();assert.equal(f.posts().length,0);assert.equal(p.el('clear').disabled,true);assert.deepEqual(f.data(),before);
});
test('Retry load reads once, preserves existing contents, then intentional clear is durably saved',async t=>{
 const f=await fixture(t);f.failRead();const p=await f.mount();assert.equal(p.el('save').textContent,'Retry load');await p.save();assert.equal(f.reads().length,2);assert.equal(p.el('clear').disabled,false);assert.equal(f.posts().length,0);p.el('clear').click();await f.timers(1200);assert.equal(f.data().board.strokes.length,0);assert.equal(f.posts().length,1);assert.equal(f.posts()[0].status,200);assert.match(p.el('savedFlag').textContent,/Saved to project/);
});
test('successful untouched visit never writes on Save, hide, pagehide or shell leave',async t=>{
 const f=await fixture(t),before=plain(f.data()),p=await f.mount();await p.save();f.hide();f.event('pagehide');await drain();f.event('pageshow');await f.h.shell.go('/buzzy/memory');assert.equal(f.posts().length,0);assert.deepEqual(f.data(),before);
});
for(const board of [null,{version:1,strokes:[],images:[]},{strokes:[],images:[]}])test(`valid ${board===null?'absent':board.version?'empty':'legacy empty'} board can accept its first mark`,async t=>{
 const f=await fixture(t,board),p=await f.mount();await p.draw();await f.timers(1200);assert.equal(f.posts().length,1);assert.equal(f.data().board.strokes.length,1);assert.equal(f.data().board.strokes[0].tool,'rect');
});
test('long stroke schedules its saved revision after pointerup, not before it',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.start();await f.timers(1200);assert.equal(f.posts().length,0);await p.finish();await f.timers(1200);assert.equal(f.posts().length,1);assert.equal(f.data().board.strokes.length,1);
});
test('Undo and Redo each schedule the completed board and survive a shell remount',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.draw();await f.timers(1200);assert.equal(f.data().board.strokes.length,1);p.el('undo').click();await f.timers(1200);assert.equal(f.data().board.strokes.length,0);p.el('redo').click();await f.timers(1200);assert.equal(f.data().board.strokes.length,1);p.el('undo').click();await f.h.shell.go('/buzzy/memory');assert.equal(f.data().board.strokes.length,0);const reopened=await f.mount();await reopened.save();assert.equal(f.data().board.strokes.length,0);
});
test('repeated completed add/undo/redo/clear keeps the latest board, not an earlier snapshot',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.draw();await p.draw();p.el('undo').click();p.el('redo').click();p.el('clear').click();p.el('undo').click();await f.timers(1200);assert.equal(f.data().board.strokes.length,2);assert.equal(f.posts().length,1);
});
test('actual shell waits for a dirty board save before removing its DOM',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount(),gate=f.defer();await p.draw();f.transport=async(req,next)=>{if(req.method==='POST')await gate.promise;return next();};const leaving=f.h.shell.go('/buzzy/memory');await drain();assert.equal(p.stage.isConnected,true);assert.equal(f.posts().length,0);assert.equal(p.el('clear').disabled,true);gate.resolve();assert.equal(await leaving,true);assert.equal(p.stage.isConnected,false);assert.equal(f.data().board.strokes.length,1);assert.equal(f.posts().length,1);
});
test('actual shell save failure retains draft and URL; explicit Save retry then leave succeeds',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.draw();f.failSave(true);assert.equal(await f.h.shell.go('/buzzy/memory'),false);assert.equal(p.stage.isConnected,true);assert.equal(f.h.location.pathname,'/buzzy/sketch');assert.equal(f.h.location.search,'?job=job_board');assert.match(p.el('status').textContent,/changes are still here/);assert.equal(p.el('clear').disabled,false);assert.equal(f.data().board.strokes.length,0);f.failSave(false);await p.save();assert.equal(f.data().board.strokes.length,1);assert.equal(await f.h.shell.go('/buzzy/memory'),true);
});
test('Back cancels an in-flight leave, releases only that page, and keeps its latest edit',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount(),gate=f.defer();await p.draw();f.transport=async(req,next)=>{if(req.method==='POST')await gate.promise;return next();};const leaving=f.h.shell.go('/buzzy/memory');await drain();f.h.history.back();await drain();gate.resolve();assert.equal(await leaving,false);await f.h.idle();assert.equal(p.stage.isConnected,true);assert.equal(p.el('clear').disabled,false);f.transport=null;await p.draw();await f.timers(1200);assert.equal(f.data().board.strokes.length,2);
});
for(const phase of ['headers','body'])test(`same-mounted Back recovers initial ${phase} read discarded off-route`,async t=>{
 const f=await fixture(t),gate=f.defer();let first=true;f.h.heldFetches.add('/buzzy/memory');
 f.transport=async(req,next)=>{const r=await next();if(first&&req.method==='GET'){first=false;if(phase==='headers')await gate.promise;else return {ok:true,json:async()=>{await gate.promise;return r.json();}};}return r;};
 const p=await f.mount();const leaving=f.h.shell.go('/buzzy/memory');gate.resolve();await drain();assert.equal(p.el('clear').disabled,true);f.h.history.back();await f.h.idle();await drain();assert.equal(p.el('clear').disabled,false);assert.equal(f.reads().length,2);f.h.requests.find(r=>r.key==='/buzzy/memory').resolve();assert.equal(await leaving,false);await p.save();assert.equal(f.posts().length,0);
});
test('pageshow resumes an uninitialized same document without writing an empty board',async t=>{
 const f=await fixture(t),gate=f.defer();let first=true;f.transport=async(req,next)=>{const r=await next();if(first&&req.method==='GET'){first=false;await gate.promise;}return r;};const p=await f.mount();f.event('pagehide');gate.resolve();await drain();assert.equal(p.el('clear').disabled,true);f.event('pageshow');await drain();assert.equal(p.el('clear').disabled,false);assert.equal(f.reads().length,2);assert.equal(f.posts().length,0);
});
for(const phase of ['before-commit','after-commit','body'])test(`new edits during pending Save ${phase} are serialized and acknowledged separately`,async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount(),gate=f.defer();let first=true;
 f.transport=async(req,next)=>{if(req.method!=='POST'||!first)return next();first=false;if(phase==='before-commit'){await gate.promise;return next();}const r=await next();if(phase==='after-commit'){await gate.promise;return r;}return {ok:true,json:async()=>{await gate.promise;return r.json();}};};
 await p.draw();await p.save();assert.doesNotMatch(p.el('status').textContent,/Board saved\./);await p.draw();p.el('undo').click();await p.draw();assert.match(p.el('savedFlag').textContent,/Unsaved/);await p.save();assert.equal(f.uiRequests.filter(r=>r.method==='POST').length,1);gate.resolve();await drain();assert.deepEqual(f.posts().map(r=>r.body.board.strokes.length),[1,2]);assert.equal(f.data().board.strokes.length,2);assert.match(p.el('savedFlag').textContent,/Saved to project/);
});
for(const failure of ['storage','transport','json','missing-ack'])test(`Save ${failure} failure retains dirty draft, reports no success, and can retry`,async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.draw();
 if(failure==='storage')f.failSave(true);else f.transport=async(req,next)=>{if(req.method!=='POST')return next();if(failure==='transport')throw Error('offline');if(failure==='json')return {ok:true,json:async()=>{throw Error('broken JSON');}};return new Response('{}',{status:200});};
 await p.save();assert.doesNotMatch(p.el('status').textContent,/Board saved\./);assert.match(p.el('savedFlag').textContent,/Not saved/);assert.equal(f.data().board.strokes.length,0);f.failSave(false);f.transport=null;await p.save();assert.equal(f.data().board.strokes.length,1);assert.match(p.el('status').textContent,/Board saved\./);
});
test('post-commit lost acknowledgement is not claimed as rollback; retry preserves the latest draft',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount();await p.draw();f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')throw Error('response lost after commit');return r;};await p.save();assert.equal(f.data().board.strokes.length,1);assert.match(p.el('savedFlag').textContent,/Not saved/);assert.doesNotMatch(p.el('status').textContent,/Board saved\./);f.transport=null;await p.draw();await p.save();assert.equal(f.data().board.strokes.length,2);
});
test('newer queued revision after failed save is retained without a false saved indicator',async t=>{
 const f=await fixture(t,{version:1,strokes:[],images:[]}),p=await f.mount(),gate=f.defer();f.transport=async(req,next)=>{if(req.method==='POST'){await gate.promise;throw Error('network');}return next();};await p.draw();await p.save();await p.draw();await p.save();gate.resolve();await drain();assert.equal(f.uiRequests.filter(r=>r.method==='POST').length,1);assert.match(p.el('savedFlag').textContent,/Not saved/);f.transport=null;await p.save();assert.equal(f.data().board.strokes.length,2);
});
test('old detached initial response and old global handlers cannot write or paint a newer board',async t=>{
 const f=await fixture(t),gate=f.defer();let first=true;f.transport=async(req,next)=>{const r=await next();if(first&&req.method==='GET'){first=false;await gate.promise;}return r;};const old=await f.mount();await f.h.shell.go('/buzzy/memory');const current=await f.mount();gate.resolve();await drain();f.event('keydown',{key:'z',ctrlKey:true});await current.save();f.hide();await drain();assert.equal(old.stage.isConnected,false);assert.equal(f.posts().length,0);assert.match(current.el('status').textContent,/Board saved/);assert.equal(f.data().board.strokes.length,2);
});
test('current hard-close warning is dirty-only and prior detached boards cannot warn',async t=>{
 const f=await fixture(t),p=await f.mount();let warnings=0;f.event('beforeunload',{preventDefault(){warnings++;}});assert.equal(warnings,0);await p.draw();f.event('beforeunload',{preventDefault(){warnings++;}});assert.equal(warnings,1);await p.save();f.event('beforeunload',{preventDefault(){warnings++;}});assert.equal(warnings,1);await f.h.shell.go('/buzzy/memory');f.event('beforeunload',{preventDefault(){warnings++;}});assert.equal(warnings,1);
});
test('foreign and signed-out routes remain denied without touching any stored board',async t=>{
 const f=await fixture(t),before=plain(f.data());f.as('foreign');assert.equal((await f.api('/api/buzzy/art',{method:'POST',body:JSON.stringify({action:'save',jobId:'job_board',board:{version:1,strokes:[],images:[]}})})).status,404);f.as(null);assert.equal((await f.api('/api/buzzy/art?job=job_board')).status,401);assert.deepEqual(f.data(),before);
});

test('viewing, saving or leaving a new unedited board creates no project and claims no saved board',async t=>{
 const f=await fixture(t),p=await f.mount(null);await p.save();assert.doesNotMatch(p.el('status').textContent,/Board saved\./);f.hide();await f.h.shell.go('/buzzy/memory');assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});
test('first completed marks create one job, then actual art saves and reloads the whole board',async t=>{
 const f=await fixture(t),p=await f.mount(null);await p.draw();await p.draw();await f.timers(1200);const creates=f.requests.filter(r=>r.url==='/api/buzzy/jobs');assert.equal(creates.length,1);const id=creates[0].body.id;assert.equal(f.data(id).board.strokes.length,2);assert.equal(f.h.location.search,'?job='+id);await f.h.shell.go('/buzzy/memory');const reopened=await f.mount(id);await reopened.save();assert.equal(f.data(id).board.strokes.length,2);assert.equal(f.posts().length,1);
});
test('navigation waits for first job creation without redirecting the destination or creating twice',async t=>{
 const f=await fixture(t),p=await f.mount(null),gate=f.defer();f.transport=async(req,next)=>{if(req.url==='/api/buzzy/jobs')await gate.promise;return next();};await p.draw();const leaving=f.h.shell.go('/buzzy/memory');await drain();assert.equal(p.stage.isConnected,true);assert.equal(f.uiRequests.filter(r=>r.url==='/api/buzzy/jobs').length,1);gate.resolve();assert.equal(await leaving,true);assert.equal(f.h.location.pathname,'/buzzy/memory');const id=f.requests.find(r=>r.url==='/api/buzzy/jobs').body.id;assert.equal(f.data(id).board.strokes.length,1);assert.equal(f.requests.filter(r=>r.url==='/api/buzzy/jobs').length,1);
});
test('first creation response failure retains scratch draft and does not retry once per stroke',async t=>{
 const f=await fixture(t),p=await f.mount(null);f.transport=async(req,next)=>req.url==='/api/buzzy/jobs'?new Response('{}',{status:500}):next();await p.draw();await p.save();await p.draw();await p.save();assert.equal(f.uiRequests.filter(r=>r.url==='/api/buzzy/jobs').length,1);assert.match(p.el('savedFlag').textContent,/Not saved/);assert.equal(p.stage.isConnected,true);await f.timers(5000);f.transport=null;await p.save();const id=f.requests.find(r=>r.url==='/api/buzzy/jobs').body.id;assert.equal(f.data(id).board.strokes.length,2);
});
test('first job accepted before board-save failure remains linked on retry without duplicate creation',async t=>{
 const f=await fixture(t),p=await f.mount(null);await p.draw();f.failSave(true);assert.equal(await f.h.shell.go('/buzzy/memory'),false);const creates=f.requests.filter(r=>r.url==='/api/buzzy/jobs');assert.equal(creates.length,1);const id=creates[0].body.id;f.failSave(false);await p.save();assert.equal(f.h.location.search,'?job='+id);assert.equal(f.data(id).board.strokes.length,1);assert.equal(f.requests.filter(r=>r.url==='/api/buzzy/jobs').length,1);
});
test('switching to another board drains old writes before the new read, and old callbacks remain inert',async t=>{
 const f=await fixture(t),p=await f.mount();await p.draw();const otherBefore=plain(f.data('job_other')),gate=f.defer();let held=true;f.transport=async(req,next)=>{if(held&&req.method==='POST'){held=false;await gate.promise;}return next();};const navigating=f.h.shell.go('/buzzy/sketch?job=job_other');await drain();assert.equal(p.stage.isConnected,true);gate.resolve();assert.equal(await navigating,true);const other=await f.mount('job_other');await other.save();f.hide();await drain();assert.equal(f.data().board.strokes.length,3);assert.deepEqual(f.data('job_other'),otherBefore);assert.equal(f.posts().length,1);assert.equal(p.stage.isConnected,false);
});
test('repeated leave requests share one pending write; a newer destination alone can mount',async t=>{
 const f=await fixture(t),p=await f.mount(),gate=f.defer();await p.draw();f.transport=async(req,next)=>{if(req.method==='POST')await gate.promise;return next();};const first=f.h.shell.go('/buzzy/memory');await drain();const same=f.h.shell.go('/buzzy/memory');assert.equal(first,same);const latest=f.h.shell.go('/buzzy/experts');gate.resolve();assert.equal(await first,false);assert.equal(await latest,true);assert.equal(f.posts().length,1);assert.equal(f.h.location.pathname,'/buzzy/experts');assert.equal(p.stage.isConnected,false);
});
test('failed Back leave keeps the active draft and matching URL; retry can traverse away',async t=>{
 const f=await fixture(t);await f.mount();await f.h.shell.go('/buzzy/memory');const p=await f.mount();await p.draw();f.failSave(true);f.h.history.back();await f.h.idle();await drain();assert.equal(p.stage.isConnected,true);assert.equal(f.h.location.pathname,'/buzzy/sketch');assert.match(p.el('savedFlag').textContent,/Not saved/);assert.ok(f.h.entries.some(entry=>new URL(entry.href).pathname==='/buzzy/memory'),'blocked Back does not overwrite its destination');f.failSave(false);await p.save();f.h.history.back();await f.h.idle();assert.equal(f.h.location.pathname,'/buzzy/memory');assert.equal(f.data().board.strokes.length,3);
});
test('failure after initial response parsing remains retryable without duplicate simultaneous reads',async t=>{
 const f=await fixture(t),gate=f.defer();let first=true;f.transport=async(req,next)=>{if(first&&req.method==='GET'){first=false;return {ok:true,json:async()=>{await gate.promise;throw Error('bad json');}};}return next();};const p=await f.mount();p.el('save').click();p.el('save').click();assert.equal(f.uiRequests.filter(r=>r.method==='GET').length,1);gate.resolve();await drain();assert.match(p.el('status').textContent,/Retry load/);await p.save();assert.equal(f.uiRequests.filter(r=>r.method==='GET').length,2);assert.equal(p.el('clear').disabled,false);assert.equal(f.posts().length,0);
});
test('retired page cannot start a delayed retry or emit its pending timer into a remounted board',async t=>{
 const f=await fixture(t),p=await f.mount();await p.draw();await f.h.shell.go('/buzzy/memory');const q=await f.mount();const before=f.posts().length;await f.timers(1200);p.el('save').click();p.el('clear').click();await drain();assert.equal(f.posts().length,before);await q.save();assert.equal(f.posts().length,before);assert.equal(f.data().board.strokes.length,3);
});

// Image identity is exercised as records/DOM geometry only. Actual <img> I/O is
// not implemented by this DOM, and the default Image decoder/provider forbid
// calls. The explicitly marked delayed-placement tests use a metadata-only
// Image/URL transport double, never image bytes or a generation endpoint.
const identityImages=()=>[
 {id:'image_a',url:'/synthetic/first.png',x:10,y:20,w:100,h:80,label:'First — keep é',extra:{original:true,note:'<keep> & "quotes"'}},
 {id:'image_b',url:'/synthetic/second.png',x:300,y:40,w:120,h:90,label:'Second',extra:{original:true,nested:['unchanged',42]}},
];
const identityBoard=images=>({version:1,strokes:[],images});
const imageWrappers=p=>p.el('layers').children;
const selectedImages=p=>[...imageWrappers(p)].flatMap((el,index)=>el.className.split(/\s+/).includes('selected')?[index]:[]);
function imageStart(p,index,mode='move'){
 p.tools.find(el=>el.getAttribute('data-tool')==='select').click();
 const wrap=imageWrappers(p)[index];assert.ok(wrap,'chosen image exists');
 wrap.dispatch('pointerdown',{target:mode==='resize'?wrap.children[1]:wrap,clientX:400,clientY:100});
}
async function imageMove(f,p,index,dx,dy,mode='move'){
 imageStart(p,index,mode);assert.deepEqual(selectedImages(p),[index]);
 f.event('pointermove',{clientX:400+dx,clientY:100+dy});f.event('pointerup');await drain();
 assert.deepEqual(selectedImages(p),[index]);
}
function metadataImageIO(f){
 const pending=[];
 // Each callback is controlled explicitly. Neither src nor this URL adapter
// reads bytes, performs I/O or decodes media; this is not native image proof.
 f.h.context.Image=class{set src(value){this.url=value;pending.push(this);}get src(){return this.url;}};
 f.h.context.URL=class extends URL{static createObjectURL(file){return '/synthetic/'+file.name;}};
 return pending;
}
function metadataDrop(p,name,x=50,y=60){p.stage.dispatch('drop',{clientX:x,clientY:y,dataTransfer:{files:[{type:'image/png',name}]}});}

test('image records including IDs and unknown metadata survive ordinary Save and reload unchanged',async t=>{
 const images=identityImages(),f=await fixture(t,identityBoard(images)),p=await f.mount();
 assert.equal(f.posts().length,0);await p.draw();await p.save();
 assert.deepEqual(f.data().board.images,images);assert.equal(f.posts().length,1);
 assert.equal(Object.hasOwn(f.data().board,'selectedImage'),false,'undo selection is not persisted board authority');
 await f.h.shell.go('/buzzy/memory');const q=await f.mount();await q.save();
 assert.equal(f.posts().length,1);assert.deepEqual(f.data().board.images,images);
});

const idCases=[
 ['ordinary',['first','second']],['absent',null],['duplicate',['same','same']],
 ['empty',['','']],['null',[null,null]],['numeric',[7,7]],['mixed',[7,'7']],
 ['boolean',[false,false]],['object',[{toString:'not callable',valueOf:null},{same:'shape'}]],
 ['array',[['old'],['old']]],['hostile-looking',['__proto__','constructor']],
];
for(const [label,ids]of idCases)test('image '+label+' IDs preserve exact records and target only the chosen move/resize after reload',async t=>{
 const images=identityImages();images.forEach((im,i)=>{if(ids)im.id=ids[i];else delete im.id;});
 const f=await fixture(t,identityBoard(images));let p=await f.mount();
 await imageMove(f,p,1,25,15);await p.save();
 const expected=plain(images);expected[1].x+=25;expected[1].y+=15;
 assert.deepEqual(f.data().board.images,expected);
 await f.h.shell.go('/buzzy/memory');p=await f.mount();
 await imageMove(f,p,1,30,20,'resize');await p.save();expected[1].w+=30;expected[1].h+=20;
 assert.deepEqual(f.data().board.images,expected);assert.equal(imageWrappers(p).length,2);
 await imageMove(f,p,0,-5,8);await p.save();expected[0].x-=5;expected[0].y+=8;
 assert.deepEqual(f.data().board.images,expected);assert.deepEqual(selectedImages(p),[0]);
});

test('duplicate IDs keep one selected entry through actual Undo/Redo clones and a new gesture',async t=>{
 const images=identityImages();images.forEach(im=>im.id='same');const f=await fixture(t,identityBoard(images)),p=await f.mount();
 imageStart(p,1);f.event('pointerup');await p.draw();
 p.el('undo').click();await drain();assert.deepEqual(selectedImages(p),[1]);
 p.el('redo').click();await drain();assert.deepEqual(selectedImages(p),[1]);
 await imageMove(f,p,1,14,-8);await p.save();const expected=plain(images);expected[1].x+=14;expected[1].y-=8;
 assert.deepEqual(f.data().board.images,expected);assert.equal(f.data().board.strokes.length,1);
});
test('Undo retires an in-progress image object and detached handles cannot redirect the restored clone',async t=>{
 const images=identityImages();delete images[0].id;delete images[1].id;
 const f=await fixture(t,identityBoard(images)),p=await f.mount();imageStart(p,1);f.event('pointerup');await p.draw();
 const stale=imageWrappers(p)[1];imageStart(p,1);f.event('pointermove',{clientX:430,clientY:115});
 p.el('undo').click();await drain();assert.deepEqual(selectedImages(p),[1]);
 f.event('pointermove',{clientX:500,clientY:200});f.event('pointerup');
 stale.dispatch('pointerdown',{clientX:400,clientY:100});f.event('pointermove',{clientX:600,clientY:300});f.event('pointerup');await p.save();
 assert.deepEqual(f.data().board.images,images);assert.equal(f.data().board.strokes.length,0);
 await imageMove(f,p,1,9,11);await p.save();const expected=plain(images);expected[1].x+=9;expected[1].y+=11;assert.deepEqual(f.data().board.images,expected);
});

test('image selection follows each immutable snapshot through reorder/deletion rather than a reused live index',()=>{
 // No image reorder/delete UI is invented. These direct extracted-function
 // controls cover the actual snapshot adoption contract for arbitrary order.
 const snapshotSource=script.slice(script.indexOf('    function snapshotJson()'),script.indexOf('    function snapshot()'));
 const applySource=script.slice(script.indexOf('    function applySnapshot(json)'),script.indexOf('    function undo()'));
 assert.ok(snapshotSource.includes('function snapshotJson()'));assert.ok(applySource.includes('function applySnapshot(json)'));
 const first={id:'duplicate',url:'first',x:1},second={id:'duplicate',url:'second',x:2};
 const c=vm.createContext({strokes:[],images:[first,second],selected:second,drag:{image:second},renderImages(){},redraw(){}});
 vm.runInContext(snapshotSource+applySource,c);
 const ordered=vm.runInContext('snapshotJson()',c);
 c.images.reverse();assert.equal(c.images.indexOf(c.selected),0);
 c.snapshotInput=ordered;vm.runInContext('applySnapshot(snapshotInput)',c);
 assert.equal(c.selected.url,'second');assert.equal(c.images.indexOf(c.selected),1);assert.equal(c.drag,null);
 c.images=[c.selected];c.drag={image:c.selected};const deleted=vm.runInContext('snapshotJson()',c);
 c.images=[{id:'duplicate',url:'replacement',x:100}];c.selected=c.images[0];c.snapshotInput=deleted;
 vm.runInContext('applySnapshot(snapshotInput)',c);assert.equal(c.selected.url,'second');assert.equal(c.drag,null);
 for(const bad of [-1,20,null,'0',0.5]){c.snapshotInput=JSON.stringify({strokes:[],images:[first],selectedImage:bad});vm.runInContext('applySnapshot(snapshotInput)',c);assert.equal(c.selected,null);}
});

test('Undo removal, Redo restore, then new image at a reused position cannot be moved by the removed entry',async t=>{
 const f=await fixture(t,identityBoard(identityImages())),p=await f.mount(),pending=metadataImageIO(f);
 imageStart(p,0);f.event('pointerup');metadataDrop(p,'third.png',70,80);assert.equal(pending.length,1);pending[0].onerror();await drain();
 assert.equal(imageWrappers(p).length,3);imageStart(p,2);f.event('pointerup');const removed=imageWrappers(p)[2];
 p.el('undo').click();await drain();assert.equal(imageWrappers(p).length,2);assert.deepEqual(selectedImages(p),[0]);
 p.el('redo').click();await drain();assert.equal(imageWrappers(p).length,3);assert.deepEqual(selectedImages(p),[2]);
 p.el('undo').click();metadataDrop(p,'replacement.png',150,160);pending[1].onerror();await drain();
 assert.equal(imageWrappers(p).length,3);assert.deepEqual(selectedImages(p),[0]);
 removed.dispatch('pointerdown',{clientX:400,clientY:100});f.event('pointermove',{clientX:500,clientY:200});f.event('pointerup');await p.save();
 assert.equal(f.data().board.images[2].url,'/synthetic/replacement.png');assert.equal(f.data().board.images[2].x,150);assert.equal(f.data().board.images[2].y,160);
 await imageMove(f,p,2,6,7);await p.save();assert.equal(f.data().board.images[2].x,156);assert.equal(f.data().board.images[2].y,167);
});

test('pending Save owns its immutable image revision while newer moves retain IDs and selection',async t=>{
 const images=identityImages(),f=await fixture(t,identityBoard(images)),p=await f.mount(),gate=f.defer();let first=true;
 f.transport=async(req,next)=>{if(first&&req.method==='POST'){first=false;await gate.promise;}return next();};
 await imageMove(f,p,1,20,25);await p.save();assert.equal(f.posts().length,0);
 await imageMove(f,p,0,-4,-6);await p.save();assert.deepEqual(selectedImages(p),[0]);
 assert.equal(f.uiRequests.filter(r=>r.method==='POST').length,1);
 const firstBoard=plain(f.uiRequests.find(r=>r.method==='POST').body.board);assert.deepEqual(firstBoard.images[0],images[0]);
 gate.resolve();await drain();const expected=plain(images);expected[1].x+=20;expected[1].y+=25;expected[0].x-=4;expected[0].y-=6;
 assert.equal(f.posts().length,2);assert.deepEqual(f.data().board.images,expected);assert.deepEqual(selectedImages(p),[0]);
});
for(const lost of [false,true])test('image '+(lost?'lost acknowledgement':'storage failure')+' retains exact draft and explicit retry does not duplicate records',async t=>{
 const images=identityImages(),f=await fixture(t,identityBoard(images)),p=await f.mount();
 if(lost)f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')throw Error('Synthetic lost acknowledgement');return r;};else f.failSave(true);
 await imageMove(f,p,1,18,9);await p.save();assert.match(p.el('savedFlag').textContent,/Not saved/);assert.deepEqual(selectedImages(p),[1]);
 if(!lost)assert.deepEqual(f.data().board.images,images);
 f.transport=null;f.failSave(false);await p.save();const expected=plain(images);expected[1].x+=18;expected[1].y+=9;
 assert.deepEqual(f.data().board.images,expected);assert.equal(f.data().board.images.length,2);assert.deepEqual(selectedImages(p),[1]);
});

test('out-of-order image callbacks during pending Save append only their own metadata and preserve the chosen entry',async t=>{
 const images=identityImages(),f=await fixture(t,identityBoard(images)),p=await f.mount(),pending=metadataImageIO(f),gate=f.defer();let first=true;
 imageStart(p,1);f.event('pointerup');metadataDrop(p,'slow-first.png',40,50);metadataDrop(p,'fast-second.png',200,210);assert.equal(pending.length,2);
 pending[1].naturalWidth=2;pending[1].naturalHeight=1;pending[1].onload();await drain();assert.deepEqual(selectedImages(p),[1]);
 f.transport=async(req,next)=>{if(first&&req.method==='POST'){first=false;await gate.promise;}return next();};await p.save();
 pending[0].onerror();await drain();assert.deepEqual(selectedImages(p),[1]);assert.equal(imageWrappers(p).length,4);
 gate.resolve();await drain();assert.equal(f.posts().length,2);
 const result=f.data().board.images;assert.deepEqual(result.slice(0,2),images);
 assert.deepEqual(result.slice(2).map(i=>[i.url,i.x,i.y,i.w,i.h]),[['/synthetic/fast-second.png',200,210,240,120],['/synthetic/slow-first.png',40,50,240,160]]);
 assert.ok(result.slice(2).every(i=>typeof i.id==='string'&&i.id.startsWith('im_')));
});
test('delayed image callback from a retired page cannot append into a new board',async t=>{
 const f=await fixture(t,identityBoard(identityImages())),p=await f.mount(),pending=metadataImageIO(f),before=plain(f.data());
 metadataDrop(p,'retired.png');await f.h.shell.go('/buzzy/memory');const q=await f.mount();
 pending[0].onerror();await drain();await q.save();assert.equal(p.stage.isConnected,false);assert.equal(imageWrappers(q).length,2);assert.equal(f.posts().length,0);assert.deepEqual(f.data(),before);
});
test('explicit API reorder/deletion survives reopening without a retired image handle targeting the replacement position',async t=>{
 // The current UI has no image reorder/delete control. These are deliberate
 // synthetic API edits, not an automatic repair, migration or UI feature.
 const images=identityImages();images.forEach(im=>im.id='duplicate');
 const f=await fixture(t,identityBoard(images)),reordered=plain(images).reverse();
 const write=board=>f.api('/api/buzzy/art',{method:'POST',body:JSON.stringify({action:'save',jobId:'job_board',board})});
 assert.equal((await write(identityBoard(reordered))).status,200);
 const p=await f.mount();await imageMove(f,p,1,4,5);await p.save();reordered[1].x+=4;reordered[1].y+=5;
 assert.deepEqual(f.data().board.images,reordered);const retired=imageWrappers(p)[0];
 await f.h.shell.go('/buzzy/memory');const remaining=[plain(reordered[1])];assert.equal((await write(identityBoard(remaining))).status,200);
 const q=await f.mount();retired.dispatch('pointerdown',{clientX:400,clientY:100});f.event('pointermove',{clientX:500,clientY:200});f.event('pointerup');await q.save();
 assert.deepEqual(f.data().board.images,remaining);assert.deepEqual(selectedImages(q),[]);
 await imageMove(f,q,0,6,7);await q.save();remaining[0].x+=6;remaining[0].y+=7;assert.deepEqual(f.data().board.images,remaining);
});
test('the existing desktop page drain finishes the exact active image gesture before acknowledging its revision',async t=>{
 const images=identityImages();images.forEach(im=>im.id='duplicate');const f=await fixture(t,identityBoard(images)),p=await f.mount();
 imageStart(p,1);f.event('pointermove',{clientX:422,clientY:113});
 const hook=p.stage.bzDesktopSketch;hook.begin('synthetic-image-drain');assert.equal(p.el('save').disabled,true);
 assert.equal(await hook.drain('synthetic-image-drain'),true);
 const expected=plain(images);expected[1].x+=22;expected[1].y+=13;assert.deepEqual(f.data().board.images,expected);
 assert.equal(hook.state('synthetic-image-drain').dirty,false);assert.equal(f.posts().length,1);
 f.event('pointermove',{clientX:600,clientY:300});f.event('pointerup');await drain();assert.deepEqual(f.data().board.images,expected);
 hook.release('synthetic-image-drain');assert.equal(p.el('save').disabled,false);assert.deepEqual(selectedImages(p),[1]);
});

test('Delete removes the last-selected placed image, not a previously selected drawing, and Undo restores it', async t=>{
 const images=identityImages();images[1].id=images[0].id;
 const board={...savedBoard,images},f=await fixture(t,board),p=await f.mount();
 p.tools.find(el=>el.getAttribute('data-tool')==='select').click();
 p.el('board').dispatch('pointerdown',{clientX:145,clientY:68,pointerId:1});
 imageStart(p,1);f.event('pointerup');assert.deepEqual(selectedImages(p),[1]);
 let prevented=false;
 f.event('keydown',{key:'Delete',target:p.el('board'),preventDefault(){prevented=true;}});
 await p.save();assert.equal(prevented,true);
 assert.deepEqual(f.data().board.strokes,savedBoard.strokes,'an older drawing selection is untouched');
 assert.deepEqual(f.data().board.images,[images[0]],'only the selected image is removed');
 p.el('undo').click();await p.save();
 assert.deepEqual(f.data().board.strokes,savedBoard.strokes);
 assert.deepEqual(f.data().board.images,images);assert.deepEqual(selectedImages(p),[1]);
});
test('Backspace while editing a prompt does not change the selected board object',async t=>{
 const board={...savedBoard,images:identityImages()},f=await fixture(t,board),p=await f.mount();
 p.tools.find(el=>el.getAttribute('data-tool')==='select').click();
 p.el('board').dispatch('pointerdown',{clientX:145,clientY:68,pointerId:1});
 const input=p.el('prompt');Object.defineProperty(input,'tagName',{value:'TEXTAREA'});
 let prevented=false;
 f.event('keydown',{key:'Backspace',target:input,preventDefault(){prevented=true;}});
 await p.save();assert.equal(prevented,false);assert.deepEqual(f.data().board,board);assert.equal(f.posts().length,0);
});
test('a canvas drawing selection clears the previous image and Delete preserves its anchored note',async t=>{
 const images=identityImages(),f=await fixture(t,{...savedBoard,images}),p=await f.mount();
 imageStart(p,0);f.event('pointerup');assert.deepEqual(selectedImages(p),[0]);
 p.el('board').dispatch('pointerdown',{clientX:145,clientY:68,pointerId:1});
 assert.deepEqual(selectedImages(p),[]);
 f.event('keydown',{key:'Delete',target:p.el('board')});await p.save();
 assert.deepEqual(f.data().board.images,images);
 assert.deepEqual(f.data().board.strokes,[{...savedBoard.strokes[1],anchor:null}]);
});
