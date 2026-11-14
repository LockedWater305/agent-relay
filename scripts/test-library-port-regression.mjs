/** Red/green: actual Library helpers + main runtime binding + preload navigation.
 * BZ_LIBRARY_PORT_BASELINE_DIR selects the pre-fix tree. All storage, DB/API,
 * credentials, timers and window surfaces are isolated doubles; no network. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createRuntimeAuth, retargetAppPage } from '../desktop/security.mjs';
import { canonicalRecord, createLibraryTransition } from '../desktop/library-vault.mjs';
const root=resolve(process.env.BZ_LIBRARY_PORT_BASELINE_DIR||fileURLToPath(new URL('..',import.meta.url)));
const library=readFileSync(root+'/public/buzzy/library.html','utf8'),main=readFileSync(root+'/desktop/main.mjs','utf8'),preload=readFileSync(root+'/desktop/preload.cjs','utf8');
const helperPath=root+'/public/buzzy/library-vault.js';
const storeId='00000000-0000-4000-8000-000000000001';
const before='http://127.0.0.1:7331',after='http://127.0.0.1:7332';
const helperSource=library.slice(library.indexOf('    function jobComplete('),library.indexOf('    const catalog ='));
const docsSource=library.slice(library.indexOf('    const DOCS_KEY ='),library.indexOf('    function downloadText('));
async function scenario() {
 const stores=new Map(),rows=new Map(),requests=[];
 function storage(origin){
  if(!stores.has(origin))stores.set(origin,new Map());const data=stores.get(origin);
  return {get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
 }
 const api=async(url,init={})=>{
  requests.push(String(url));assert.equal(new URL(url,before).pathname,'/api/buzzy/library-vault');
  if(init.method==='POST'){
   const stored=JSON.parse(init.body).records.map(r=>{const row=canonicalRecord(r);if(!rows.has(row.hash))rows.set(row.hash,{...row.record,hash:row.hash,id:String(rows.size+1)});return rows.get(row.hash);});
   return Response.json({ok:true,storeId,generation:'0',stored});
  }
  if(String(url).includes('metadata=1'))return Response.json({ok:true,storeId,generation:'0'});
  const after=new URL(url,before).searchParams.get('after')||'0';
  return Response.json({ok:true,storeId,generation:'0',records:[...rows.values()].filter(r=>BigInt(r.id)>BigInt(after)),done:true,nextCursor:null});
 };
 async function page(origin) {
  const app={},window={beezilla:{},location:{search:'?job=audit_job',pathname:'/buzzy/library'}};
  const context=vm.createContext({localStorage:storage(origin),window,document:{getElementById:()=>app},URLSearchParams,Date,TEMPLATES:[],fetch:api,crypto:webcrypto,TextEncoder,
   setTimeout:()=>1,clearTimeout:()=>{},state:{screen:'docs'},console});
  if(existsSync(helperPath)){vm.runInContext(readFileSync(helperPath,'utf8'),context);await window.BeeZillaLibraryVault.refresh();}
  vm.runInContext(helperSource+'\n'+docsSource+'\nglobalThis.inspectDocs=loadDocs;globalThis.materialize=syncJobDocs;',context);
  // These tests inspect data rather than the full DOM. Native/UI tests cover painting.
  window.BeeZillaLibraryVault?.onChange(()=>{});
  return {context,window,storage:storage(origin)};
 }
 const first=await page(before),job={id:'audit_job',title:'Synthetic local draft',problem:'Synthetic local draft',screen:'draft',version:1,draftText:'AUDIT VERSION ONE'};
 first.context.materialize(job);job.version=2;job.draftText='AUDIT VERSION TWO';first.context.materialize(job);
 const sameOriginCount=first.context.inspectDocs().audit_job.length;
 // Deliberately do not refresh the pending client: the real main barrier must
 // drain before the origin is replaced, even if a scheduled save has not run.
 let currentUrl=before+'/buzzy/library?job=audit_job',runtime={host:'127.0.0.1',port:7331,token:'a'.repeat(43)};
 const listeners={},navigations=[],scheduled=[];
 vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld(){}},ipcRenderer:{on:(name,fn)=>{listeners[name]=fn;},invoke:async()=>({ok:true})}}),process:{isMainFrame:true},window:{location:{replace:url=>{navigations.push(url);currentUrl=url;}}},URL,setTimeout:fn=>scheduled.push(fn),clearTimeout(){}});
 const wc={id:1,mainFrame:{url:currentUrl},isDestroyed:()=>false,getURL:()=>currentUrl,send:(channel,data)=>listeners[channel]?.({},data),executeJavaScript:async code=>vm.runInContext(code,first.context)};
 const auth=createRuntimeAuth({getContents:()=>[wc]});auth.bind(runtime);
 const mainContext=vm.createContext({runtimeBase:before,runtimeAuth:auth,trustedContents:()=>[wc],settingsWindow:null,testPageUrl:null,retargetAppPage,console});
 vm.runInContext(main.slice(main.indexOf('function bindRuntime('),main.indexOf('function openSafeExternal(')),mainContext);
 let transition;
 if(main.includes('await acquireLibraryTransition'))transition=await createLibraryTransition({getContents:()=>[wc],getBase:()=>mainContext.runtimeBase,getRuntime:()=>runtime,fetchImpl:api})();
 runtime={host:'127.0.0.1',port:7332,token:'b'.repeat(43)};
 if(transition)await transition.flush(runtime);
 mainContext.bindRuntime(runtime,true);
 await transition?.release({keepRetiredFrozen:true});
 // Real Settings finally runs before preload is guaranteed to navigate. A late
 // catalog completion cannot enqueue a record on the retired origin.
 const countBeforeLate=first.context.inspectDocs().audit_job.length;
 first.context.materialize({...job,version:3,draftText:'TOO LATE ON RETIRED ORIGIN'});
 if(transition)assert.equal(first.context.inspectDocs().audit_job.length,countBeforeLate);
 while(scheduled.length)scheduled.shift()();
 assert.equal(navigations[0],after+'/buzzy/library?job=audit_job');
 const second=await page(new URL(currentUrl).origin);second.context.materialize(job);
 const afterBodies=(second.context.inspectDocs().audit_job||[]).map(r=>r.md);
 const third=await page(after);
 return {sameOriginCount,afterBodies,relaunchBodies:(third.context.inspectDocs().audit_job||[]).map(r=>r.md),requests,oldStore:stores.get(before),rows};
}
test('all materialized versions survive actual main/preload port replacement, not just durable latest job',async()=>{
 const result=await scenario();assert.equal(result.sameOriginCount,2);
 assert.deepEqual([...result.afterBodies].sort(),['AUDIT VERSION ONE','AUDIT VERSION TWO']);
 assert.deepEqual([...result.relaunchBodies].sort(),['AUDIT VERSION ONE','AUDIT VERSION TWO']);
});
test('same-name changed bodies remain distinct and selectable/downloadable by opaque identity',async()=>{
 const result=await scenario();
 assert.match(library,/find\(\(d\) => docRef\(d\) === docsOpenDoc\)/);
 assert.match(library,/find\(\(d\) => docRef\(d\) === el\.getAttribute\("data-dl"\)\)/);
 assert.match(library,/data-folder='" \+ escAttr\(f.id\)/);
 assert.match(library,/\.replace\(/);assert.equal(result.rows.size,2);
});

test('actual Library list/view/download keeps conflicting bodies distinct and escapes imported labels',()=>{
 const name="a' autofocus onfocus='evil <img>.md",folder="folder' onclick='evil";
 const docs=[{name,md:'FIRST <img src=x onerror=evil>',_vaultRef:'vault_1',createdAt:1},{name,md:'SECOND <script>evil</script>',_vaultRef:'vault_2',createdAt:2}];
 const buttons=new Map(),downloads=[];let selectors={};
 const app={html:'',set innerHTML(value){this.html=value;selectors={};
  for(const attr of ['data-open','data-doc','data-dl','data-folder'])selectors[attr]=[...value.matchAll(new RegExp(attr+"='([^']*)'",'g'))].map(m=>({getAttribute:()=>m[1]}));
 },get innerHTML(){return this.html;},querySelectorAll(selector){return selectors[selector==='.di-name'?'data-doc':selector.match(/\[(data-[a-z]+)/)?.[1]]??[];}};
 const context=vm.createContext({window:{BeeZillaLibraryVault:{}},document:{getElementById:id=>{if(id==='app')return app;if(!buttons.has(id))buttons.set(id,{});return buttons.get(id);}},catalog:{jobs:[]},docsOpenFolder:folder,docsOpenDoc:null,docsOpenFromLink:folder,showRecoveredFolders:true,
  setPhase(){},syncJobDocs(){},loadDocs:()=>({[folder]:docs}),paintLibrarySync(){},docRef:d=>d._vaultRef||d.name,
  downloadText:(name,md)=>downloads.push({name,md}),downloadWord(){},renderServerFiles(){},loadArtifactShelf(){},state:{screen:'docs'},render(){},Date});
 const source=library.slice(library.indexOf('    function escHtml('),library.indexOf('    // ── Artifact shelf'));
 vm.runInContext(source,context);context.goDocs();
 assert.equal(selectors['data-open'].length,2);assert.equal(selectors['data-dl'].length,2);
 assert.equal(app.innerHTML.includes("data-open='"+name),false);assert.equal(app.innerHTML.includes('<img>.md'),false);
 selectors['data-dl'][1].onclick();assert.deepEqual(downloads.at(-1),{name,md:docs[1].md});
 selectors['data-open'][0].onclick();assert.match(app.innerHTML,/FIRST &lt;img/);assert.doesNotMatch(app.innerHTML,/SECOND/);
 buttons.get('docDl').onclick();assert.deepEqual(downloads.at(-1),{name,md:docs[0].md});
 buttons.get('docsBackList').onclick();selectors['data-open'][1].onclick();assert.match(app.innerHTML,/SECOND &lt;script/);
 buttons.get('docDl').onclick();assert.deepEqual(downloads.at(-1),{name,md:docs[1].md});
 context.docsOpenDoc=null;context.docsOpenFolder=null;context.goDocs();
 assert.ok(app.innerHTML.includes("data-folder='folder&#39; onclick=&#39;evil'"));
 assert.equal(selectors['data-folder'].length,1);
});

test('cached Library page notices resolve the active restored DOM closure',()=>{
 let listener;const first={},second={},events=[];let current=first;
 const window={location:{pathname:'/buzzy/library'},BeeZillaLibraryVault:{onChange:fn=>{listener=fn;}}};
 const block=library.slice(library.indexOf('    if (window.BeeZillaLibraryVault) {\n      // The shell'),library.indexOf('    function slugify('));
 assert.ok(block.includes('__bzLibraryVaultUpdate'));
 const install=(node,label)=>{current=node;vm.runInNewContext(block,{window,document:{getElementById:()=>current},state:{screen:'docs'},goDocs:()=>events.push(label),paintLibrarySync(){}});};
 install(first,'first');install(second,'second');listener(true);assert.deepEqual(events,['second']);
 current=first;listener(true);assert.deepEqual(events,['second','first']);
 window.location.pathname='/buzzy/settings';listener(true);assert.deepEqual(events,['second','first']);
});

async function materializerFixture({generation='1',sourceExists=false,sourceStatus=200}={}) {
 const data=new Map(),rows=new Map(),jobs=new Map(),app={},status={};
 const job={id:'job_cached',title:'Synthetic cached report',version:1,draftText:'STALE PRIVATE BODY',screen:'docs',createdAt:1,updatedAt:2};
 let gen=generation,hook=null;
 if(sourceExists)jobs.set(job.id,{id:job.id,title:job.title,data:{...job}});
 const storage={get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
 const fetch=async(url,init={})=>{
  assert.equal(init.redirect,'error');assert.equal(init.credentials,'same-origin');
  if(url.startsWith('/api/buzzy/jobs/')){
   const row=structuredClone(jobs.get(decodeURIComponent(url.slice('/api/buzzy/jobs/'.length))));
   if(hook)await hook(url,init);
   return row&&sourceStatus===200?Response.json({job:row}):Response.json({error:'not_found'},{status:sourceStatus===200?404:sourceStatus});
  }
  assert.ok(url.startsWith('/api/buzzy/library-vault'));
  if(hook)await hook(url,init);
  if(init.method==='POST'){
   const body=JSON.parse(init.body);
   if(body.expectedGeneration!==gen)return Response.json({ok:false,error:'vault_store_changed'},{status:409});
   const stored=body.records.map(r=>{const item=canonicalRecord(r);if(!rows.has(item.hash))rows.set(item.hash,{...item.record,hash:item.hash,id:String(rows.size+1)});return rows.get(item.hash);});
   return Response.json({ok:true,storeId,generation:gen,stored});
  }
  if(url.includes('metadata=1'))return Response.json({ok:true,storeId,generation:gen});
  return Response.json({ok:true,storeId,generation:gen,records:[...rows.values()],done:true,nextCursor:null});
 };
 const window={beezilla:{},location:{search:'',pathname:'/buzzy/library'}},catalog={jobs:[job]};
 let context;
 const goDocs=()=>{for(const j of catalog.jobs)context.materialize(j);};
 context=vm.createContext({window,document:{getElementById:id=>id==='app'?app:status},localStorage:storage,URLSearchParams,Date,TEMPLATES:[],fetch,crypto:webcrypto,TextEncoder,AbortSignal,
  setTimeout:()=>1,clearTimeout(){},state:{screen:'docs'},catalog,goDocs,console});
 vm.runInContext(readFileSync(helperPath,'utf8'),context);
 const normalize=library.slice(library.indexOf('    function normalizeServerJob('),library.indexOf('    // Signed-in catalog follows'));
 vm.runInContext(helperSource+'\n'+normalize+'\n'+docsSource+'\nglobalThis.materialize=syncJobDocs;',context);
 const vault=window.BeeZillaLibraryVault;
 const checks=async()=>{for(let i=0;i<20;i++){const tail=context.archiveCheckTail;await tail;if(tail===context.archiveCheckTail)return;}throw Error('checks did not settle');};
 const refresh=async()=>{await vault.refresh();await checks();};
 return {data,rows,jobs,job,catalog,context,vault,window,checks,refresh,goDocs,status,
  reset(value){gen=value;rows.clear();jobs.clear();},setHook(fn){hook=fn;}};
}
for(const sourceStatus of [404,403])test('initial post-reset stale catalog cannot archive a missing/foreign current job ('+sourceStatus+')',async()=>{
 const f=await materializerFixture({sourceStatus});await f.refresh();f.goDocs();await f.checks();await f.refresh();
 assert.equal(f.rows.size,0);assert.equal([...f.data.keys()].filter(k=>k.startsWith('bz_docs_v2_pending:')).length,0);
 assert.match(f.status.textContent,/Older cached drafts were not restored/);
});
test('running helper cannot turn an old cached job into a fresh generation after data reset',async()=>{
 const f=await materializerFixture({generation:'0'});await f.refresh();await f.refresh();assert.equal(f.rows.size,1);
 f.reset('1');await f.refresh();await f.refresh();assert.equal(f.rows.size,0);assert.deepEqual(Object.keys(f.vault.load()),[]);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('bz_docs_v2_pending:')).length,0);
});
test('fresh authenticated post-reset job can create Library history, including exact fallback fields',async()=>{
 const f=await materializerFixture({sourceExists:true});await f.refresh();await f.refresh();assert.equal(f.rows.size,1);
 assert.equal([...f.rows.values()][0].document.md,f.job.draftText);
 f.job.draftText='';f.job.screen='result';f.job.problem='NEW FALLBACK PROBLEM';f.job.version=2;
 f.jobs.set(f.job.id,{id:f.job.id,title:f.job.title,data:{...f.job}});
 f.goDocs();await f.checks();await f.refresh();assert.equal(f.rows.size,2);
 assert.match([...f.rows.values()][1].document.md,/NEW FALLBACK PROBLEM/);
});
test('same job ID with a different current draft does not certify stale content',async()=>{
 const f=await materializerFixture({sourceExists:true});f.jobs.get(f.job.id).data.draftText='CURRENT SERVER BODY';
 await f.refresh();await f.refresh();assert.equal(f.rows.size,0);
});
test('generation reset during authenticated source verification cannot rebind its result',async()=>{
 const f=await materializerFixture({sourceExists:true});let reset=false;
 f.setHook(async(url)=>{if(url.startsWith('/api/buzzy/jobs/')&&!reset){reset=true;f.reset('2');}});
 await f.refresh();await f.refresh();assert.equal(f.rows.size,0);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('bz_docs_v2_pending:')).length,0);
});
test('an approval cached in an older generation cannot authorize a new reset generation',async()=>{
 const f=await materializerFixture({sourceExists:true});await f.refresh();await f.refresh();assert.equal(f.rows.size,1);
 f.reset('2');await f.refresh();await f.refresh();assert.equal(f.rows.size,0);
});
test('retired-origin freeze cancels a pending source approval instead of materializing late',async()=>{
 const f=await materializerFixture({sourceExists:true});let frozen=false;
 f.setHook(async(url)=>{if(url.startsWith('/api/buzzy/jobs/')&&!frozen){frozen=true;f.window.__bzLibraryVaultBarrier='synthetic-retired';f.vault.freeze();}});
 await f.refresh();await f.refresh();assert.equal(f.rows.size,0);
 assert.equal([...f.data.keys()].filter(k=>k.startsWith('bz_docs_v2_pending:')).length,0);
});
