// Whole shipped Studio IIFE + complete Nitro route + actual Studio service.
// Synthetic DOM/auth/H3/transport, disposable SQLite executing emitted SQL with
// explicit PostgreSQL parameter/JSONB adaptations. No provider/audio activity.
// Real PGlite and packaged Electron remain separate acceptance gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.env.BZ_STUDIO_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(root,p),'utf8');
const html=read('public/buzzy/studio.html');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('function planFromForm()'))?.[1];
assert.ok(script,'whole production Studio IIFE');
const plain=v=>JSON.parse(JSON.stringify(v));
const drain=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const original={prompt:'Original saved brief',lyrics:'Original saved lyrics',tempo:'80 BPM',key:'C major',seconds:30,instruments:['piano'],sections:[{label:'verse',fromSec:0,toSec:20}],currentAssetId:null};
const desired={prompt:'Corrected client brief 日本語',lyrics:'Corrected lyric &copy;',tempo:'96 BPM',key:'A minor',seconds:'55'};
const fields=Object.keys(desired);

async function fixture(t){
 const db=new DatabaseSync(':memory:'),queries=[],requests=[],uiRequests=[],holds=[];
 let providerCalls=0,user='owner',failUpdate=false;
 db.function('now',()=> '2026-11-15T12:00:00Z');
 db.function('jsonb_set',(data,path,value,create)=>{assert.equal(path,'{music}');assert.equal(create,1);return JSON.stringify({...JSON.parse(data),music:JSON.parse(value)});});
 db.exec(`CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,status TEXT,data TEXT,updated_at TEXT);
 CREATE TABLE buzzy_assets(id INTEGER,filename TEXT,content_type TEXT,bytes INTEGER,created_at TEXT,user_id TEXT,job_id TEXT);
 CREATE TABLE buzzy_music_edits(id INTEGER,actor TEXT,instruction TEXT,region_from_ms INTEGER,region_to_ms INTEGER,before_asset_id TEXT,after_asset_id TEXT,note TEXT,created_at TEXT,user_id TEXT,job_id TEXT);
 CREATE TABLE protected_history(id TEXT PRIMARY KEY,body TEXT);
 INSERT INTO protected_history VALUES('accepted_document','Preserve accepted output'),('transcript','Preserve conversation');`);
 for(const [id,owner] of [['job_track','owner'],['job_other','owner'],['job_foreign','foreign']]){
  const plan=id==='job_other'?{...original,prompt:'Other track brief',instruments:['guitar']}:original;
  db.prepare('INSERT INTO buzzy_jobs VALUES(?,?,?,?,?,?)').run(id,owner,id,'In progress',JSON.stringify({music:plan,unrelated:{keep:'original'}}),'original-time');
 }
 const protectedRows=()=>JSON.stringify([db.prepare("SELECT * FROM buzzy_jobs WHERE id<>'job_track' ORDER BY id").all(),db.prepare('SELECT * FROM protected_history ORDER BY id').all()]);
 const beforeProtected=protectedRows();
 const execute=(text,params)=>{
  queries.push({text,params:plain(params)});
  if(failUpdate&&/UPDATE buzzy_jobs/.test(text))throw Error('Synthetic storage failure');
  const rows=db.prepare(text.replace(/::jsonb/g,'').replace(/\$(\d+)/g,':p$1')).all(Object.fromEntries(params.map((value,i)=>['p'+(i+1),value])));
  return rows.map(row=>Object.hasOwn(row,'data')?{...row,data:JSON.parse(row.data)}:row);
 };
 const sql=async(strings,...params)=>{let text=strings[0];params.forEach((_,i)=>{text+='$'+(i+1)+strings[i+1];});return execute(text,params);};
 sql.query=async(text,params=[])=>execute(text,params);
 const context=vm.createContext({Response,Request,Headers,URLSearchParams,Buffer});
 const provider=()=>{providerCalls++;throw Error('Provider activity forbidden in Studio draft tests');};
 function dependency(exports){return new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context});}
 const service=new vm.SourceTextModule(stripTypeScriptTypes(read('src/lib/buzzy/studio.ts')),{context});
 await service.link(id=>{
  if(id==='@/lib/db')return dependency({getSql:async()=>sql});
  if(id==='./music')return dependency({gatedMusic:provider,storeAudio:provider});
  throw Error(id);
 });await service.evaluate();
 const route=new vm.SourceTextModule(stripTypeScriptTypes(read('src/lib/buzzy/studio.nitro.ts')),{context});
 await route.link(id=>{
  if(id==='./studio')return service;
  if(id==='h3')return dependency({defineEventHandler:f=>f,getMethod:event=>event.req.method,readBody:event=>event.req.json()});
  if(id==='@/lib/auth/verify.server')return dependency({getSessionUserFromHeaders:async()=>user?{id:user}:null});
  if(id==='./music')return dependency({musicConfigured:()=>false});
  throw Error(id);
 });await route.evaluate();
 async function api(url,init={}){
  assert.match(url,/^\/api\/buzzy\/studio(?:\?|$)/);
  const method=init.method||'GET',body=init.body?JSON.parse(init.body):undefined;
  if(method==='POST')assert.equal(body.action,'save','no render/edit/provider execution');
  const record={url,method,body};requests.push(record);
  let response;
  try{response=await route.namespace.default({path:url,req:new Request('http://synthetic'+url,{method,...(init.body?{body:init.body}:{}),headers:init.headers})});}
  catch{response=new Response(JSON.stringify({error:'Synthetic storage failure'}),{status:500});}
  record.status=response.status;record.response=await response.clone().json();return response;
 }
 const f={db,queries,requests,uiRequests,api,service:service.namespace,transport:null,mounts:[],hops:[],as:id=>{user=id;},failUpdate:v=>{failUpdate=v;}};
 f.defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});holds.push(resolve);return {promise,resolve,reject};};
 const intervals=new Map(),windowHandlers={};let intervalId=0,active=null;
 class Element{
  constructor(id='',owner=active){this.id=id;this.owner=owner;this.children=[];this.handlers={};this.style={};this._value='';this.textContent='';this.disabled=false;this.clientWidth=700;this.classList={add(){},remove(){}};this.parent=null;}
  get isConnected(){return !!this.owner?.connected&&!this.detached;}
  set value(v){this._value=String(v);}get value(){return this._value;}
  set innerHTML(v){for(const child of this.children)child.detached=true;this.children=[];this._html=v;}get innerHTML(){return this._html||'';}
  appendChild(node){this.children.push(node);node.parent=this;return node;}
  addEventListener(name,fn){(this.handlers[name]??=[]).push(fn);}
  dispatch(name,props={}){for(const fn of this.handlers[name]||[])fn.call(this,{target:this,preventDefault(){},...props});}
  click(){if(!this.disabled)this.dispatch('click');}
  getAttribute(name){return this[name]??null;}
  getContext(){return new Proxy({},{get:()=>()=>{}});}
  getBoundingClientRect(){return {left:0,top:0,width:700,height:120};}
  setPointerCapture(){}load(){}play(){}pause(){}
 }
 const location={pathname:'/buzzy/studio',search:'?job=job_track'};
 const document={getElementById:id=>id==='bzPage'?(active?.hard?null:active?.root):active?.elements.get(id)||null,querySelectorAll:()=>[...active.elements.values()],createElement:()=>new Element(),head:new Element()};
 const window={devicePixelRatio:1,addEventListener:(name,fn)=>{(windowHandlers[name]??=[]).push(fn);},BeeZillaChat:{mount:(...args)=>f.mounts.push(args)},BeeZillaShell:{go:url=>{f.hops.push(url);}}};
 const ui=vm.createContext({document,location,URLSearchParams,fetch:(url,init={})=>{
  const req={url,init,method:init.method||'GET',body:init.body?JSON.parse(init.body):null};uiRequests.push(req);
  return Promise.resolve().then(()=>f.transport?f.transport(req,()=>api(url,init)):api(url,init));
 },setInterval:(fn,ms)=>{const id=++intervalId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),window});
 f.mount=async(job='job_track',options={})=>{
  if(active)active.connected=false;
  active={elements:new Map(),connected:true,hard:!!options.hard};
  const page=active;page.root=new Element('bzPage',page);page.root.querySelectorAll=()=>[...page.elements.values()];
  for(const m of html.matchAll(/\bid="([^"]+)"/g))page.elements.set(m[1],new Element(m[1],page));
  for(const[id,label]of Object.entries({savePlan:'Save brief',saveLyrics:'Save lyrics',renderBtn:'Create track',editBtn:'Change this passage'}))page.elements.get(id).textContent=label;
  location.pathname=options.pathname||'/buzzy/studio';location.search=job?'?job='+encodeURIComponent(job):'';
  page.el=id=>page.elements.get(id);
  page.set=values=>{for(const[id,value]of Object.entries(values)){page.el(id).value=value;page.el(id).dispatch('input');}};
  page.form=()=>Object.fromEntries(fields.map(id=>[id,page.el(id).value]));
  page.instruments=()=>page.el('instList').children.map(child=>child.textContent);
  page.add=name=>{page.el('instInput').value=name;page.el('instInput').dispatch('keydown',{key:'Enter'});};
  page.remove=name=>{const chip=page.el('instList').children.find(child=>child.textContent===name);assert.ok(chip,'visible instrument '+name);chip.children[0].click();};
  page.save=async(id='savePlan')=>{page.el(id).click();await drain();};
  page.refresh=async()=>{for(const {fn,ms}of [...intervals.values()])if(ms===5000)fn();await drain();};
  vm.runInContext(script,ui,{filename:'actual-studio-page.js'});
  if(options.wait!==false)await drain();
  return page;
 };
 f.navigate=(path='/buzzy/library')=>{location.pathname=path;location.search='';};
 f.pagehide=()=>{for(const fn of windowHandlers.pagehide||[])fn();};
 f.pageshow=()=>{for(const fn of windowHandlers.pageshow||[])fn();};
 f.returnToTrack=()=>{location.pathname='/buzzy/studio';location.search='?job=job_track';for(const fn of windowHandlers.popstate||[])fn();};
 f.returnToCold=()=>{location.pathname='/buzzy/studio';location.search='';for(const fn of windowHandlers.popstate||[])fn();};
 f.detach=()=>{active.connected=false;};
 f.data=(id='job_track')=>JSON.parse(db.prepare('SELECT data FROM buzzy_jobs WHERE id=?').get(id).data);
 f.serverSave=plan=>service.namespace.savePlan('owner','job_track',plan);
 f.intervalCount=()=>intervals.size;
 f.drain=drain;
 t.after(async()=>{holds.forEach(resolve=>resolve());await drain();assert.equal(providerCalls,0);assert.equal(protectedRows(),beforeProtected);assert.equal(f.data().unrelated.keep,'original');db.close();});
 return f;
}

const assertDesired=p=>assert.deepEqual(p.form(),desired);
const postCount=f=>f.uiRequests.filter(r=>r.method==='POST').length;

test('typing all fields then Add preserves the draft and the actual stored plan',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add('cello');assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);
 await p.save();assert.equal(f.data().music.prompt,desired.prompt);assert.equal(f.data().music.lyrics,desired.lyrics);assert.equal(f.data().music.seconds,55);assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('confirmed Save → Add → Save never reverts persisted corrected fields',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);await p.save();assert.equal(f.requests.at(-1).status,200);assert.equal(f.data().music.prompt,desired.prompt);
 p.add('cello');assertDesired(p);await p.save();for(const field of fields)assert.equal(String(f.data().music[field]),desired[field]);
});
test('repeated Add/Remove affects instruments only, including duplicate/blank input',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add(' cello ');p.add('violin');p.add('cello');p.add('   ');p.remove('piano');p.remove('cello');p.add('flute');
 assertDesired(p);assert.deepEqual(p.instruments(),['violin','flute']);await p.save();assert.deepEqual(f.data().music.instruments,['violin','flute']);
});
test('five-second refresh cannot silently remove a visible unsaved instrument',async t=>{
 const f=await fixture(t),p=await f.mount();p.add('cello');await p.refresh();assert.deepEqual(p.instruments(),['piano','cello']);await p.save();assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('clean fields adopt an external plan refresh even when edit count is unchanged',async t=>{
 const f=await fixture(t),p=await f.mount();await f.serverSave({...desired,seconds:55,instruments:['viola']});await p.refresh();assertDesired(p);assert.deepEqual(p.instruments(),['viola']);assert.equal(p.el('draftStatus').textContent,'');
});
test('refresh merges clean fields but keeps conflicting local text and instruments dirty',async t=>{
 const f=await fixture(t),p=await f.mount();p.set({prompt:'Local unsaved brief',lyrics:'Local unsaved lyrics'});p.add('cello');
 await f.serverSave({prompt:'Server changed brief',lyrics:'Server changed lyrics',tempo:'120 BPM',instruments:['synth']});
 f.db.prepare('INSERT INTO buzzy_music_edits VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(1,'agent','Metadata refresh only',null,null,null,null,'No provider used','2026-11-15','owner','job_track');
 await p.refresh();assert.equal(p.el('prompt').value,'Local unsaved brief');assert.equal(p.el('lyrics').value,'Local unsaved lyrics');assert.equal(p.el('tempo').value,'120 BPM');assert.deepEqual(p.instruments(),['piano','cello']);assert.match(p.el('draftStatus').textContent,/unsaved/i);assert.equal(p.el('log').children[0].children[1].textContent,'Metadata refresh only');
 await p.save();assert.equal(f.data().music.prompt,'Local unsaved brief');assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('edits made while refresh headers/body are pending win over the late refresh',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();
 await f.serverSave({prompt:'Server refresh',tempo:'100 BPM',instruments:['drums']});
 f.transport=async(req,next)=>{const r=await next();return {ok:r.ok,status:r.status,json:async()=>{await held.promise;return r.json();}};};
 await p.refresh();p.set({prompt:'Typed during refresh'});p.add('cello');held.resolve();await drain();
 assert.equal(p.el('prompt').value,'Typed during refresh');assert.equal(p.el('tempo').value,'100 BPM');assert.deepEqual(p.instruments(),['piano','cello']);
 f.transport=null;await p.save();assert.equal(f.data().music.prompt,'Typed during refresh');assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('pending Save acknowledges only submitted values, preserving newer text and instruments',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set(desired);
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};
 await p.save();assert.equal(f.data().music.prompt,desired.prompt);p.set({prompt:'Newer brief',lyrics:'Newer lyrics',seconds:'72'});p.add('cello');p.remove('piano');
 held.resolve();await drain();assert.equal(p.el('prompt').value,'Newer brief');assert.equal(p.el('lyrics').value,'Newer lyrics');assert.equal(p.el('seconds').value,'72');assert.deepEqual(p.instruments(),['cello']);assert.match(p.el('status').textContent,/not saved yet/);assert.match(p.el('draftStatus').textContent,/unsaved/i);
 f.transport=null;await p.save();assert.equal(f.data().music.prompt,'Newer brief');assert.deepEqual(f.data().music.instruments,['cello']);assert.equal(p.el('draftStatus').textContent,'');
});
test('a pending Save followed by reverting to the old baseline remains an unsaved edit',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set({prompt:'Submitted revision'});
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};await p.save();p.set({prompt:original.prompt});held.resolve();await drain();
 assert.equal(p.el('prompt').value,original.prompt);assert.equal(f.data().music.prompt,'Submitted revision');assert.match(p.el('draftStatus').textContent,/unsaved/i);
 f.transport=null;await p.save();assert.equal(f.data().music.prompt,original.prompt);
});
test('Save lyrics is partial, adopts its acknowledgement and leaves other draft fields unsaved',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add('cello');await p.save('saveLyrics');
 assert.deepEqual(f.uiRequests.at(-1).body.plan,{lyrics:desired.lyrics});assert.equal(f.data().music.lyrics,desired.lyrics);assert.equal(f.data().music.prompt,original.prompt);assert.deepEqual(f.data().music.instruments,['piano']);assertDesired(p);assert.match(p.el('draftStatus').textContent,/unsaved/i);
 await p.refresh();assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);await p.save();assert.equal(f.data().music.prompt,desired.prompt);
});
test('pending Save lyrics retains newer lyrics and never claims the newer value saved',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set({lyrics:'Submitted lyrics'});
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};await p.save('saveLyrics');p.set({lyrics:'Newer lyrics'});held.resolve();await drain();
 assert.equal(f.data().music.lyrics,'Submitted lyrics');assert.equal(p.el('lyrics').value,'Newer lyrics');assert.match(p.el('status').textContent,/not saved yet/);
});
test('repeated Save and cross-button clicks create one request; inputs remain editable',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};p.set(desired);await p.save();
 assert.equal(p.el('prompt').disabled,false);assert.equal(p.el('savePlan').disabled,true);assert.equal(p.el('saveLyrics').disabled,true);assert.equal(p.el('renderBtn').disabled,true);
 p.el('savePlan').dispatch('click');p.el('saveLyrics').dispatch('click');p.el('renderBtn').dispatch('click');await drain();assert.equal(postCount(f),1);
 held.resolve();await drain();assert.equal(p.el('savePlan').disabled,false);assert.equal(p.el('saveLyrics').disabled,false);
});
test('a GET begun before Save cannot roll back the acknowledged state or a following Save',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();let oldGet=true;
 f.transport=async(req,next)=>{const r=await next();if(req.method==='GET'&&oldGet){oldGet=false;await held.promise;}return r;};
 await p.refresh();p.set(desired);await p.save();held.resolve();await drain();assertDesired(p);p.add('cello');assertDesired(p);await p.save();assert.equal(f.data().music.prompt,desired.prompt);
});
test('polling skips in-flight Save and overlapping GETs, then resumes',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();f.transport=async(req,next)=>{const r=await next();await held.promise;return r;};
 await p.refresh();const n=f.uiRequests.length;await p.refresh();assert.equal(f.uiRequests.length,n);held.resolve();await drain();
 const saveHeld=f.defer();f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await saveHeld.promise;return r;};await p.save();const before=f.uiRequests.length;await p.refresh();assert.equal(f.uiRequests.length,before);saveHeld.resolve();await drain();f.transport=null;await p.refresh();assert.equal(f.uiRequests.length,before+1);
});
for(const failure of ['HTTP 500','transport','malformed JSON','malformed success'])test(failure+' Save keeps draft, unlocks both saves and permits an actual successful retry',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add('cello');
 if(failure==='HTTP 500')f.failUpdate(true);
 else f.transport=async(req,next)=>{
  if(req.method!=='POST')return next();
  if(failure==='transport')throw Error('Synthetic network failure');
  if(failure==='malformed JSON')return new Response('{',{status:200});
  return new Response(JSON.stringify({ok:true,plan:{}}),{status:200});
 };
 await p.save();assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);assert.equal(p.el('status').className,'status bad');assert.match(p.el('status').textContent,/kept/);assert.equal(p.el('savePlan').disabled,false);assert.equal(p.el('saveLyrics').disabled,false);
 f.failUpdate(false);f.transport=null;await p.refresh();assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);await p.save();assert.equal(f.data().music.prompt,desired.prompt);assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('unknown post-commit transport outcome is not reported saved; retry retains newer edits',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')throw Error('Lost after commit');return r;};
 await p.save();assert.equal(f.data().music.prompt,desired.prompt);assert.equal(p.el('status').className,'status bad');p.set({prompt:'Retry revision'});p.add('cello');f.transport=null;await p.save();assert.equal(f.data().music.prompt,'Retry revision');assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
for(const failure of ['HTTP 500','transport','malformed JSON','wrong job','malformed plan'])test(failure+' refresh never replaces a draft and next refresh can recover',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add('cello');f.transport=async(req,next)=>{
  if(failure==='transport')throw Error('Refresh disconnected');
  if(failure==='malformed JSON')return new Response('{',{status:200});
  if(failure==='HTTP 500')return new Response(JSON.stringify({error:'Refresh failed'}),{status:500});
  const body=await(await next()).json();if(failure==='wrong job')body.jobId='job_foreign';else body.plan={};return new Response(JSON.stringify(body),{status:200});
 };
 await p.refresh();assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);f.transport=null;await p.refresh();assertDesired(p);await p.save();assert.equal(f.data().music.prompt,desired.prompt);
});
for(const phase of ['headers','body'])test('late '+phase+' Save after switching tracks cannot paint or rewrite the new track',async t=>{
 const f=await fixture(t),old=await f.mount(),held=f.defer();old.set(desired);
 f.transport=async(req,next)=>{const r=await next();if(req.method!=='POST')return r;if(phase==='headers'){await held.promise;return r;}return {ok:r.ok,status:r.status,json:async()=>{await held.promise;return r.json();}};};
 await old.save();assert.equal(f.data().music.prompt,desired.prompt);const newer=await f.mount('job_other');newer.set({prompt:'Other unsaved edit'});newer.add('flute');const status=newer.el('status').textContent;
 held.resolve();await drain();assert.equal(newer.el('prompt').value,'Other unsaved edit');assert.deepEqual(newer.instruments(),['guitar','flute']);assert.equal(newer.el('status').textContent,status);assert.equal(f.data('job_other').music.prompt,'Other track brief');assert.equal(postCount(f),1);
 // Accepted old writes may persist, but a later reload reads the right owned job.
 f.transport=null;const reloaded=await f.mount('job_track');assertDesired(reloaded);
});
for(const outcome of ['success','failure'])test('late '+outcome+' Save after URL navigation leaves visible old/new controls alone',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set(desired);
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST'){await held.promise;if(outcome==='failure')throw Error('Late disconnect');}return r;};
 await p.save();const status=p.el('status').textContent;f.navigate();held.resolve();await drain();assert.equal(p.el('status').textContent,status);const count=f.uiRequests.length;await p.refresh();assert.equal(f.uiRequests.length,count);assert.equal(p.el('savePlan').disabled,false);f.detach();await p.refresh();assert.equal(f.intervalCount(),0);
});
for(const phase of ['initial','refresh'])test('late '+phase+' GET after mounting another Studio cannot hydrate the new form',async t=>{
 const f=await fixture(t),held=f.defer();let wait=phase==='initial';f.transport=async(req,next)=>{const r=await next();if(req.method==='GET'&&req.url.includes('job_track')&&wait)await held.promise;return r;};
 const old=await f.mount('job_track',{wait:phase!=='initial'});await drain();if(phase==='refresh'){wait=true;await old.refresh();}
 const newer=await f.mount('job_other');newer.set({prompt:'Other unsaved brief'});newer.add('flute');held.resolve();await drain();assert.equal(newer.el('prompt').value,'Other unsaved brief');assert.deepEqual(newer.instruments(),['guitar','flute']);assert.equal(newer.el('title').textContent,'job_other');
});
test('pagehide pauses operations, pageshow resumes, and detached controls retire polling',async t=>{
 const f=await fixture(t),p=await f.mount();f.pagehide();p.el('savePlan').dispatch('click');p.el('saveLyrics').dispatch('click');p.add('cello');await p.refresh();assert.equal(postCount(f),0);assert.deepEqual(p.instruments(),['piano']);f.pageshow();p.add('cello');assert.deepEqual(p.instruments(),['piano','cello']);f.detach();await p.refresh();assert.equal(f.intervalCount(),0);
});
test('same-URL remount has a new page owner, not the pending old save owner',async t=>{
 const f=await fixture(t),old=await f.mount(),held=f.defer();old.set({prompt:'Committed old page'});f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};await old.save();
 const newer=await f.mount();newer.set({prompt:'Current page draft'});newer.add('cello');held.resolve();await drain();assert.equal(newer.el('prompt').value,'Current page draft');assert.deepEqual(newer.instruments(),['piano','cello']);assert.equal(newer.el('status').textContent,'No track yet — fill in the brief and press Create track.');
});
test('initial load controls cannot save an empty plan before the owned plan arrives',async t=>{
 const f=await fixture(t),held=f.defer();f.transport=async(req,next)=>{const r=await next();await held.promise;return r;};const p=await f.mount('job_track',{wait:false});await drain();
 assert.equal(p.el('prompt').disabled,true);p.el('savePlan').dispatch('click');p.add('cello');assert.equal(postCount(f),0);held.resolve();await drain();assert.equal(p.el('prompt').disabled,false);assert.equal(p.el('prompt').value,original.prompt);assert.deepEqual(p.instruments(),['piano']);
});
for(const invalid of ['foreign','missing','malformed','wrong job'])test(invalid+' initial load cannot enable authoring',async t=>{
 const f=await fixture(t);if(invalid==='malformed'||invalid==='wrong job')f.transport=async(req,next)=>{const body=await(await next()).json();if(invalid==='malformed')body.plan={};else body.jobId='job_other';return new Response(JSON.stringify(body),{status:200});};
 const p=await f.mount(invalid==='foreign'?'job_foreign':invalid==='missing'?'missing':'job_track');p.el('savePlan').dispatch('click');assert.equal(postCount(f),0);assert.equal(p.el('savePlan').disabled,true);assert.equal(p.el('status').className,'status bad');
});
test('hard-loaded .html alias and cold reload retain exactly the confirmed owned save',async t=>{
 const f=await fixture(t),p=await f.mount('job_track',{hard:true,pathname:'/buzzy/studio.html'});p.set(desired);p.add('cello');await p.save();
 const reloaded=await f.mount('job_track',{hard:true});assertDesired(reloaded);assert.deepEqual(reloaded.instruments(),['piano','cello']);assert.equal(reloaded.el('draftStatus').textContent,'');assert.deepEqual(f.data().music.sections,original.sections);assert.equal(f.data().music.currentAssetId,null);
});
test('server clamping/trim adoption follows actual response without resending sections or asset pointers',async t=>{
 const f=await fixture(t),p=await f.mount();p.set({prompt:'  Literal &copy; 日本語  ',tempo:'  100 BPM  ',key:'',seconds:'999'});await p.save();
 const sent=f.uiRequests.at(-1).body.plan;assert.equal(sent.prompt,'Literal &copy; 日本語');assert.equal(sent.tempo,'100 BPM');assert.equal(Object.hasOwn(sent,'key'),false);assert.equal(Object.hasOwn(sent,'sections'),false);assert.equal(Object.hasOwn(sent,'currentAssetId'),false);
 assert.equal(p.el('seconds').value,'300');assert.equal(p.el('prompt').value,'Literal &copy; 日本語');assert.equal(p.el('key').value,original.key);assert.equal(p.el('draftStatus').textContent,'');assert.deepEqual(f.data().music.sections,original.sections);
});
test('control: actual partial route save preserves omitted fields, sections and current-asset metadata',async t=>{
 const f=await fixture(t);const response=await f.api('/api/buzzy/studio',{method:'POST',body:JSON.stringify({action:'save',jobId:'job_track',plan:{lyrics:'Only changed lyrics'}})});assert.equal(response.status,200);
 const saved=await response.json();assert.equal(saved.plan.prompt,original.prompt);assert.deepEqual(saved.plan.instruments,original.instruments);assert.deepEqual(saved.plan.sections,original.sections);assert.equal(saved.plan.currentAssetId,null);assert.equal(f.data().music.lyrics,'Only changed lyrics');
});
test('control: route ownership, missing job and signed-out boundaries remain enforced',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.data());
 assert.equal((await f.api('/api/buzzy/studio?job=job_foreign')).status,404);
 assert.equal((await f.api('/api/buzzy/studio',{method:'POST',body:JSON.stringify({action:'save',jobId:'job_foreign',plan:{prompt:'No'}})})).status,404);
 assert.equal((await f.api('/api/buzzy/studio',{method:'POST',body:JSON.stringify({action:'save',jobId:'missing',plan:{prompt:'No'}})})).status,404);
 f.as(null);assert.equal((await f.api('/api/buzzy/studio?job=job_track')).status,401);assert.equal((await f.api('/api/buzzy/studio',{method:'POST',body:JSON.stringify({action:'save',jobId:'job_track',plan:{prompt:'No'}})})).status,401);assert.equal(JSON.stringify(f.data()),before);
});
test('new focused gate is included in the existing CI desktop gate',()=>{
 const {scripts}=JSON.parse(read('package.json'));assert.equal(scripts['test:studio-plan'],'node --experimental-vm-modules --test scripts/test-studio-plan.mjs');assert.match(scripts['test:desktop-boundaries'],/npm run test:studio-plan/);assert.match(scripts['test:ci'],/npm run test:desktop-boundaries/);
});

test('Back to a still-mounted page after an unpainted save can retry and continue refreshing',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set(desired);f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')await held.promise;return r;};await p.save();f.navigate();await p.refresh();held.resolve();await drain();f.returnToTrack();f.transport=null;await p.refresh();assertDesired(p);assert.equal(p.el('savePlan').disabled,false);assert.equal(p.el('draftStatus').textContent,'');p.add('cello');await p.save();assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('no-op Save and clean repeated refresh retain state without creating a dirty draft',async t=>{
 const f=await fixture(t),p=await f.mount();assert.equal(p.el('draftStatus').textContent,'');await p.save();await p.refresh();await p.refresh();assert.equal(p.el('draftStatus').textContent,'');assert.equal(p.el('status').textContent,'Brief saved.');assert.deepEqual(f.data().music,original);
});
test('unchanged Save lyrics acknowledgement survives a later instrument add and full Save',async t=>{
 const f=await fixture(t),p=await f.mount();p.set({lyrics:'Confirmed new lyrics'});await p.save('saveLyrics');assert.equal(p.el('draftStatus').textContent,'');p.add('cello');assert.equal(p.el('lyrics').value,'Confirmed new lyrics');await p.save();assert.equal(f.data().music.lyrics,'Confirmed new lyrics');
});
test('unknown post-commit response followed by polling reconciles only the actual committed snapshot',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);p.add('cello');f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')throw Error('Response lost');return r;};await p.save();assert.equal(p.el('status').className,'status bad');
 f.transport=null;await p.refresh();assertDesired(p);assert.deepEqual(p.instruments(),['piano','cello']);assert.equal(p.el('draftStatus').textContent,'');assert.equal(p.el('status').className,'status bad','poll does not fabricate a successful save response');
});
test('synthetic render refusal keeps the same payload, draft and write controls without invoking a provider',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.set(desired);p.add('cello');
 f.transport=async(req,next)=>{if(req.body?.action!=='render')return next();await held.promise;return new Response(JSON.stringify({error:'Synthetic unconfigured provider'}),{status:502});};
 p.el('renderBtn').click();await drain();assert.equal(p.el('savePlan').disabled,true);p.el('savePlan').dispatch('click');p.set({prompt:'Newer plan during synthetic render'});p.add('violin');assert.equal(postCount(f),1);assert.deepEqual(f.uiRequests.at(-1).body,{action:'render',jobId:'job_track',plan:{...desired,seconds:55,instruments:['piano','cello']},actor:'user'});
 held.resolve();await drain();assert.equal(p.el('prompt').value,'Newer plan during synthetic render');assert.deepEqual(p.instruments(),['piano','cello','violin']);assert.equal(p.el('savePlan').disabled,false);assert.equal(p.el('renderBtn').disabled,false);assert.equal(f.data().music.prompt,original.prompt);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});
test('synthetic passage-edit refusal retains selection rules and cannot overlap a Save',async t=>{
 const f=await fixture(t),p=await f.mount(),held=f.defer();p.el('player').duration=30;p.el('wave').dispatch('pointerdown',{clientX:0,pointerId:1});p.el('wave').dispatch('pointermove',{clientX:350});p.el('wave').dispatch('pointerup');p.el('instruction').value='Keep the original tempo';
 f.transport=async(req,next)=>{if(req.body?.action!=='edit')return next();await held.promise;return new Response(JSON.stringify({error:'Synthetic edit refused'}),{status:502});};
 p.el('editBtn').click();await drain();p.el('saveLyrics').dispatch('click');p.el('wave').dispatch('pointerdown',{clientX:0,pointerId:1});p.el('wave').dispatch('pointermove',{clientX:280});assert.equal(p.el('editBtn').disabled,true);assert.equal(postCount(f),1);assert.equal(f.uiRequests.at(-1).body.fromMs,0);assert.equal(f.uiRequests.at(-1).body.toMs,15000);assert.equal(f.uiRequests.at(-1).body.instruction,'Keep the original tempo');held.resolve();await drain();assert.equal(p.el('editBtn').disabled,false);assert.equal(p.el('saveLyrics').disabled,false);assert.equal(f.requests.filter(r=>r.method==='POST').length,0);
});
test('late cold-project creation acknowledgement does not navigate away from a newer page',async t=>{
 const f=await fixture(t),held=f.defer();f.transport=async(req)=>{assert.equal(req.url,'/api/buzzy/jobs');assert.equal(req.body.title,'Untitled track');await held.promise;return new Response('{}',{status:200});};
 await f.mount(null);f.navigate();held.resolve();await drain();assert.deepEqual(f.hops,[]);assert.equal(f.requests.length,0,'synthetic create transport only');
});

// Review regressions: f8cb47e1 discarded the only initial GET while temporarily
// away, and accepted malformed optional plan fields into the next saved draft.
for(const phase of ['headers','body'])test('initial '+phase+' response discarded while temporarily away recovers on same-mounted Back',async t=>{
 const f=await fixture(t),held=f.defer();let first=true;
 f.transport=async(req,next)=>{const r=await next();if(!first)return r;first=false;if(phase==='headers'){await held.promise;return r;}return {ok:r.ok,status:r.status,json:async()=>{await held.promise;return r.json();}};};
 const p=await f.mount('job_track',{wait:false});await drain();f.navigate();held.resolve();await drain();assert.equal(p.el('prompt').isConnected,true);assert.equal(p.el('prompt').value,'');assert.equal(p.el('prompt').disabled,true);assert.equal(f.intervalCount(),0);
 f.returnToTrack();await drain();assert.equal(p.el('prompt').value,original.prompt);assert.equal(p.el('prompt').disabled,false);assert.equal(p.el('savePlan').disabled,false);assert.equal(f.requests.length,2);assert.equal(postCount(f),0);assert.equal(f.intervalCount(),1);assert.equal(f.mounts.length,1);
 p.set(desired);p.add('cello');await p.save();assert.equal(f.data().music.prompt,desired.prompt);assert.deepEqual(f.data().music.instruments,['piano','cello']);
});
test('initial completion while pagehidden recovers through a fresh owned GET on pageshow',async t=>{
 const f=await fixture(t),held=f.defer();let first=true;f.transport=async(req,next)=>{const r=await next();if(first){first=false;await held.promise;}return r;};
 const p=await f.mount('job_track',{wait:false});await drain();f.pagehide();held.resolve();await drain();assert.equal(p.el('prompt').value,'');assert.equal(p.el('prompt').disabled,true);f.pageshow();await drain();assert.equal(p.el('prompt').value,original.prompt);assert.equal(p.el('savePlan').disabled,false);assert.equal(f.requests.length,2);assert.equal(f.mounts.length,1);
});
for(const restore of ['Back','pageshow'])test('repeated '+restore+' while initial GET is pending never duplicates the read',async t=>{
 const f=await fixture(t),held=f.defer();f.transport=async(req,next)=>{const r=await next();await held.promise;return r;};const p=await f.mount('job_track',{wait:false});await drain();
 if(restore==='Back'){f.navigate();for(let i=0;i<4;i++)f.returnToTrack();}else{f.pagehide();for(let i=0;i<4;i++)f.pageshow();}
 await drain();assert.equal(f.requests.length,1);assert.equal(p.el('prompt').disabled,true);held.resolve();await drain();assert.equal(p.el('prompt').value,original.prompt);assert.equal(f.requests.length,1);assert.equal(f.mounts.length,1);assert.equal(f.intervalCount(),1);
});
test('a retry pending after discarded initial GET is single-flight and cannot paint a newly mounted track',async t=>{
 const f=await fixture(t),firstHeld=f.defer(),retryHeld=f.defer();let trackGets=0;
 f.transport=async(req,next)=>{const r=await next();if(req.url.includes('job_track')){trackGets++;await(trackGets===1?firstHeld.promise:retryHeld.promise);}return r;};
 const old=await f.mount('job_track',{wait:false});await drain();f.navigate();firstHeld.resolve();await drain();f.returnToTrack();await drain();f.returnToTrack();f.pageshow();await drain();assert.equal(trackGets,2);
 const newer=await f.mount('job_other');newer.set({prompt:'New track draft'});retryHeld.resolve();await drain();assert.equal(newer.el('prompt').value,'New track draft');assert.equal(newer.el('title').textContent,'job_other');assert.equal(old.el('prompt').value,'');assert.equal(f.mounts.length,1);
});
for(const failure of ['HTTP error','malformed JSON','transport'])test('initial recovery '+failure+' remains honest and can retry on a later restore',async t=>{
 const f=await fixture(t),held=f.defer();let gets=0;
 f.transport=async(req,next)=>{gets++;const r=await next();if(gets===1){await held.promise;return r;}if(gets===2){if(failure==='HTTP error')return new Response(JSON.stringify({error:'Synthetic load outage'}),{status:503});if(failure==='malformed JSON')return new Response('{',{status:200});throw Error('Synthetic connection loss');}return r;};
 const p=await f.mount('job_track',{wait:false});await drain();f.navigate();held.resolve();await drain();f.returnToTrack();await drain();assert.equal(p.el('prompt').value,'');assert.equal(p.el('savePlan').disabled,true);assert.equal(p.el('status').className,'status bad');assert.equal(f.intervalCount(),0);await drain();assert.equal(gets,2,'no automatic failure loop');f.pagehide();f.pageshow();await drain();assert.equal(p.el('prompt').value,original.prompt);assert.equal(gets,3);assert.equal(p.el('savePlan').disabled,false);
});
test('restore events from a detached initial owner never retry or paint a same-job replacement',async t=>{
 const f=await fixture(t),held=f.defer();let first=true;f.transport=async(req,next)=>{const r=await next();if(first){first=false;await held.promise;}return r;};const old=await f.mount('job_track',{wait:false});await drain();const newer=await f.mount('job_track');newer.set({prompt:'Same-job replacement draft'});f.returnToTrack();f.pageshow();held.resolve();await drain();assert.equal(f.requests.length,2);assert.equal(newer.el('prompt').value,'Same-job replacement draft');assert.equal(old.el('prompt').value,'');assert.equal(f.mounts.length,1);
});
for(const outcome of ['accepted','failed','unknown'])test('cold creation '+outcome+' is never replayed by Back/pageshow recovery',async t=>{
 const f=await fixture(t),held=f.defer();f.transport=async req=>{assert.equal(req.url,'/api/buzzy/jobs');await held.promise;if(outcome==='unknown')throw Error('Unconfirmed creation');return new Response('{}',{status:outcome==='accepted'?200:500});};
 await f.mount(null,{wait:false});await drain();f.navigate();held.resolve();await drain();for(let i=0;i<3;i++){f.returnToCold();f.pageshow();}await drain();assert.equal(postCount(f),1);assert.deepEqual(f.hops,[],'a discarded create acknowledgement never hijacks later navigation');assert.equal(f.requests.length,0,'synthetic creation transport only');
});

const malformedOptionalValues=[['object',{unexpected:'object'}],['array',['bad']],['number',120],['boolean',false],['null',null]];
for(const field of ['tempo','key'])for(const [kind,bad]of malformedOptionalValues)for(const stage of ['initial','refresh','Save'])test(stage+' rejects '+kind+' optional '+field+' before any hydration or subsequent persistence',async t=>{
 const f=await fixture(t);let p;
 const corrupt=async(req,next)=>{const r=await next();const body=await r.json();body.plan[field]=bad;return new Response(JSON.stringify(body),{status:r.status});};
 if(stage==='initial'){
  f.transport=corrupt;p=await f.mount();assert.equal(p.el('prompt').value,'');assert.equal(p.el(field).value,'');assert.equal(p.el('savePlan').disabled,true);assert.equal(p.el('status').className,'status bad');assert.equal(f.data().music[field],original[field]);f.transport=null;f.returnToTrack();await drain();assert.equal(p.el(field).value,original[field]);assert.equal(p.el('savePlan').disabled,false);
 }else if(stage==='refresh'){
  p=await f.mount();p.set({lyrics:'Keep local lyrics'});await f.serverSave({prompt:'Remote clean brief',tempo:'112 BPM',key:'D minor'});f.transport=corrupt;await p.refresh();assert.equal(p.el(field).value,original[field]);assert.equal(p.el('prompt').value,original.prompt,'reject the whole malformed plan, not just one field');assert.equal(p.el('lyrics').value,'Keep local lyrics');f.transport=null;await p.refresh();assert.equal(p.el('tempo').value,'112 BPM');assert.equal(p.el('key').value,'D minor');assert.equal(p.el('prompt').value,'Remote clean brief');assert.equal(p.el('lyrics').value,'Keep local lyrics');
 }else{
  p=await f.mount();p.set(desired);p.add('cello');f.transport=corrupt;await p.save();assertDesired(p);assert.equal(f.data().music[field],desired[field],'actual first Save stored valid text');assert.equal(p.el('status').className,'status bad');assert.match(p.el('status').textContent,/not confirmed/);assert.equal(p.el('savePlan').disabled,false);assert.equal(p.el('saveLyrics').disabled,false);f.transport=null;await p.save();assert.equal(f.data().music[field],desired[field],'next actual Save must not persist response corruption');assert.deepEqual(f.data().music.instruments,['piano','cello']);
 }
});
for(const field of ['tempo','key'])for(const stage of ['initial','refresh','Save'])test(stage+' accepts legitimately absent or empty optional '+field+' without object coercion',async t=>{
 const f=await fixture(t);await f.serverSave({[field]:''});let p;
 if(stage==='initial'){
  p=await f.mount();assert.equal(p.el(field).value,'');assert.equal(p.el('savePlan').disabled,false);assert.equal(f.requests[0].response.plan[field],undefined,'normal GET omits optional empty field');
 }else if(stage==='refresh'){
  p=await f.mount();f.transport=async(req,next)=>{const r=await next();const body=await r.json();body.plan[field]='';return new Response(JSON.stringify(body),{status:200});};await p.refresh();assert.equal(p.el(field).value,'');assert.equal(p.el('draftStatus').textContent,'');
 }else{
  p=await f.mount();f.transport=async(req,next)=>{const r=await next();const body=await r.json();body.plan[field]='';return new Response(JSON.stringify(body),{status:200});};await p.save();assert.equal(p.el(field).value,'');assert.equal(p.el('status').textContent,'Brief saved.');assert.equal(p.el('draftStatus').textContent,'');
 }
});
test('a malformed nonboolean Save confirmation cannot certify its otherwise valid plan',async t=>{
 const f=await fixture(t),p=await f.mount();p.set(desired);f.transport=async(req,next)=>{const r=await next();const body=await r.json();body.ok='yes';return new Response(JSON.stringify(body),{status:200});};await p.save();assertDesired(p);assert.equal(p.el('status').className,'status bad');assert.equal(p.el('savePlan').disabled,false);f.transport=null;await p.save();assert.equal(f.data().music.prompt,desired.prompt);assert.equal(p.el('status').textContent,'Brief saved.');
});
