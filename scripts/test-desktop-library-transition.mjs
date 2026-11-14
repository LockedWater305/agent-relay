/** Actual migration barrier with isolated renderer VMs and a transactional local
 * API double. No Electron, real documents, credentials, sockets or disk DB. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { canonicalRecord, decodeSnapshot, createLibraryTransition, LEGACY_KEY, PENDING_PREFIX } from '../desktop/library-vault.mjs';
const STORE='00000000-0000-4000-8000-000000000001';
const record=(md='VERSION ONE',n=1)=>({jobId:'job_fixture',document:{name:'report.md',md,createdAt:n,updatedAt:n}});
const legacy=(rows)=>JSON.stringify(Object.fromEntries([...new Set(rows.map(r=>r.jobId))].map(id=>[id,rows.filter(r=>r.jobId===id).map(r=>r.document)])));
const env=(r,generation='0',storeId=STORE)=>JSON.stringify({version:1,storeId,generation,record:r});
function renderer(id,values={}) {
 const data=new Map(Object.entries(values)),reads=[],scripts=[],state={frozen:false,destroyed:false};
 const window={BeeZillaLibraryVault:{freeze(){state.frozen=true;},resume(){state.frozen=false;}}};
 const storage={get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:key=>{reads.push(key);return data.get(key)??null;},
  setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};
 const context=vm.createContext({window,localStorage:storage});
 const wc={id,mainFrame:{url:'http://127.0.0.1:7331/buzzy/library?job=job_fixture'},
  isDestroyed:()=>state.destroyed,getURL(){return this.mainFrame.url;},
  executeJavaScript:async source=>{scripts.push(source);return vm.runInContext(source,context);}};
 return {wc,state,window,data,reads,scripts};
}
function setup(values={}, count=1) {
 const ui=Array.from({length:count},(_,i)=>renderer(i+1,i===0?values:{}));
 const rows=new Map(),requests=[]; let generation='0',runtime={host:'127.0.0.1',port:7331,token:'syntheticToken'.repeat(4)},base='http://127.0.0.1:7331';
 let intercept=null;
 const fetchImpl=async(url,options)=>{
  requests.push({url,options});
  assert.equal(new URL(url).pathname,'/api/buzzy/library-vault');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,`Bearer ${runtime?.token}`);
  if(intercept){const answer=await intercept(url,options);if(answer)return answer;}
  const meta={ok:true,storeId:STORE,generation};
  if(options.method==='GET')return Response.json(meta);
  const body=JSON.parse(options.body);
  if(body.expectedGeneration!==generation||body.expectedStoreId!==STORE)return Response.json({ok:false,error:'vault_store_changed'},{status:409});
  const stored=body.records.map(r=>{
   const canonical=canonicalRecord(r);
   if(!rows.has(canonical.hash))rows.set(canonical.hash,{...canonical.record,hash:canonical.hash,id:String(rows.size+1)});
   return rows.get(canonical.hash);
  });
  return Response.json({...meta,stored});
 };
 const acquire=createLibraryTransition({getContents:()=>ui.map(x=>x.wc),getBase:()=>base,getRuntime:()=>runtime,fetchImpl});
 return {ui,rows,requests,acquire,get runtime(){return runtime;},set runtime(value){runtime=value;},set base(value){base=value;},
  set generation(value){generation=value;},set intercept(value){intercept=value;}};
}

test('exact canonical record keeps missing metadata distinct and refuses lossy DB text/timestamps',()=>{
 const a=canonicalRecord(record());
 assert.notEqual(a.hash,canonicalRecord(record('OTHER')).hash);
 assert.notEqual(a.hash,canonicalRecord(record('VERSION ONE',2)).hash);
 assert.notEqual(canonicalRecord({jobId:'job_fixture',document:{name:'report.md',md:''}}).hash,canonicalRecord(record('',0)).hash);
 for(const document of [{name:'x',md:'\0'}, {name:'x',md:'\ud800'}, {name:'x',md:'ok',updatedAt:0.5}, {name:'x',md:'ok',updatedAt:8.64e15+1}])assert.throws(()=>canonicalRecord({jobId:'j',document}));
 assert.equal(canonicalRecord({jobId:'j',document:{name:'emoji',md:'🐝'}}).record.document.md,'🐝');
});

test('barrier reads only scoped values, commits all conflicts, keeps legacy unchanged and never exposes bearer in JavaScript',async()=>{
 const source=legacy([record(),record('VERSION TWO'),record('VERSION TWO',3)]);
 const s=setup({[LEGACY_KEY]:source,'private-unrelated-key':'NEVER READ',[PENDING_PREFIX+'one']:env(record('PENDING'))},2);
 s.ui[1].data.set(LEGACY_KEY,source);
 const hold=await s.acquire();
 assert.equal(s.rows.size,4);assert.ok(s.ui.every(x=>x.state.frozen));
 assert.equal(s.ui[0].data.get(LEGACY_KEY),source);assert.equal(s.ui[0].data.has(PENDING_PREFIX+'one'),false);
 assert.ok(s.ui.every(x=>!x.reads.includes('private-unrelated-key')));
 assert.ok(s.ui.every(x=>!x.scripts.join('').includes(s.runtime.token)));
 assert.ok(s.requests.every(r=>r.url.startsWith('http://127.0.0.1:7331/api/buzzy/library-vault')));
 await hold.release();assert.ok(s.ui.every(x=>!x.state.frozen));
 const replay=await s.acquire();await replay.release();assert.equal(s.rows.size,4);
});

test('empty current pages freeze without network and unregistered/non-app contents are never read',async()=>{
 const s=setup();s.ui.push(renderer(7,{[LEGACY_KEY]:legacy([record()])}));
 s.ui[1].wc.mainFrame.url='http://127.0.0.1:7331/api/buzzy/assets/uploaded.html';
 const h=await s.acquire();assert.equal(s.requests.length,0);assert.equal(s.ui[1].scripts.length,0);await h.release();
});

for(const value of ['{broken',JSON.stringify({j:[{name:'x',md:'hi',createdAt:null}]}),JSON.stringify({j:'not-docs'})])test('malformed legacy fails without mutating source or stranding a freeze: '+value.slice(0,20),async()=>{
 const s=setup({[LEGACY_KEY]:value});await assert.rejects(s.acquire(),/Library history is not safely saved/);
 assert.equal(s.rows.size,0);assert.equal(s.ui[0].data.get(LEGACY_KEY),value);assert.equal(s.ui[0].state.frozen,false);
});

test('oversized record refuses before POST with original bytes retained',async()=>{
 const raw=legacy([record('x'.repeat(8*1024*1024))]);const s=setup({[LEGACY_KEY]:raw});
 await assert.rejects(s.acquire(),/too large/);assert.equal(s.requests.length,0);assert.equal(s.ui[0].data.get(LEGACY_KEY),raw);
});

test('partial batch failure preserves all source and pending, retry deduplicates committed prefix',async()=>{
 const all=Array.from({length:123},(_,i)=>record('V'+i,i));
 const raw=legacy(all),s=setup({[LEGACY_KEY]:raw,[PENDING_PREFIX+'one']:env(record('NEW',200))});let posts=0;
 s.intercept=async(_url,options)=>options.method==='POST'&&++posts===2?Response.json({ok:false,error:'storage unavailable'},{status:503}):null;
 const originalRuntime=s.runtime;await assert.rejects(s.acquire(),/storage unavailable/);
 assert.equal(s.runtime,originalRuntime);assert.equal(s.rows.size,50);assert.equal(s.ui[0].data.get(LEGACY_KEY),raw);assert.ok(s.ui[0].data.has(PENDING_PREFIX+'one'));assert.equal(s.ui[0].state.frozen,false);
 s.intercept=null;const hold=await s.acquire();await hold.release();assert.equal(s.rows.size,124);assert.equal(s.ui[0].data.has(PENDING_PREFIX+'one'),false);
});

for(const mutate of ['wrong-hash','missing-record','wrong-generation'])test('untrusted acknowledgment '+mutate+' never removes pending',async()=>{
 const key=PENDING_PREFIX+'one',raw=env(record()),s=setup({[key]:raw});
 s.intercept=async(_url,options)=>{
  if(options.method!=='POST')return null;
  const stored={...record(),hash:canonicalRecord(record()).hash,id:'1'};
  if(mutate==='wrong-hash')stored.hash='0'.repeat(64);
  return Response.json({ok:true,storeId:STORE,generation:mutate==='wrong-generation'?'1':'0',stored:mutate==='missing-record'?[]:[stored]});
 };
 await assert.rejects(s.acquire());assert.equal(s.ui[0].data.get(key),raw);assert.equal(s.ui[0].state.frozen,false);
});

for(const kind of ['runtime-token','runtime-port','frame','url','same-url-reload'])test('identity recheck rejects '+kind+' changed during network wait',async()=>{
 const key=PENDING_PREFIX+'one',raw=env(record()),s=setup({[key]:raw});let changed=false;
 s.intercept=async()=>{if(!changed){changed=true;
  if(kind==='runtime-token')s.runtime={...s.runtime,token:'OtherSyntheticToken'.repeat(3)};
  if(kind==='runtime-port')s.runtime={...s.runtime,port:7332};
  if(kind==='frame')s.ui[0].wc.mainFrame={...s.ui[0].wc.mainFrame};
  if(kind==='url')s.ui[0].wc.mainFrame.url='http://127.0.0.1:7331/buzzy/settings';
  if(kind==='same-url-reload')delete s.ui[0].window.__bzLibraryVaultBarrier;
 }return null;};
 await assert.rejects(s.acquire());assert.equal(s.ui[0].data.get(key),raw);
});

test('all windows are rechecked after metadata before an import can use stale identities',async()=>{
 const s=setup({[LEGACY_KEY]:legacy([record()])},2);let changed=false;
 s.intercept=async()=>{if(!changed){changed=true;s.ui[1].wc.mainFrame={...s.ui[1].wc.mainFrame};}return null;};
 await assert.rejects(s.acquire(),/window changed/);assert.equal(s.rows.size,0);
});

test('a late writer during POST is recaptured and committed before transition proceeds',async()=>{
 const key=PENDING_PREFIX+'first',s=setup({[key]:env(record())});let late=false;
 s.intercept=async(_url,options)=>{if(options.method==='POST'&&!late){late=true;s.ui[0].data.set(PENDING_PREFIX+'late',env(record('LATE')));}return null;};
 const h=await s.acquire();assert.equal(s.rows.size,2);assert.equal([...s.ui[0].data.keys()].filter(x=>x.startsWith(PENDING_PREFIX)).length,0);await h.release();
});

test('modified pending value is not removed by an earlier acknowledgment',async()=>{
 const key=PENDING_PREFIX+'one',s=setup({[key]:env(record())});let changed=false;
 s.intercept=async(_url,options)=>{if(options.method==='POST'&&!changed){changed=true;s.ui[0].data.set(key,env(record('REPLACED')));}return null;};
 const h=await s.acquire();assert.equal(s.rows.size,2);assert.equal(s.ui[0].data.has(key),false);await h.release();
});

test('continuous outside writes refuse the transition after bounded drain, retaining newest copy',async()=>{
 const s=setup({[LEGACY_KEY]:legacy([record()])});let i=0;
 s.intercept=async(_url,options)=>{if(options.method==='POST')s.ui[0].data.set(PENDING_PREFIX+'late'+i,env(record('LATE'+i,++i)));return null;};
 await assert.rejects(s.acquire(),/kept changing/);assert.ok([...s.ui[0].data.keys()].some(x=>x.startsWith(PENDING_PREFIX)));assert.equal(s.ui[0].state.frozen,false);
});

test('account reset does not resurrect legacy or stale outbox; different-store pending blocks transition',async()=>{
 const key=PENDING_PREFIX+'one',raw=env(record()),s=setup({[LEGACY_KEY]:legacy([record()]),[key]:raw});s.generation='1';
 const h=await s.acquire();await h.release();assert.equal(s.rows.size,0);assert.equal(s.ui[0].data.get(key),raw);
 s.ui[0].data.set(key,env(record(),'1','00000000-0000-4000-8000-000000000002'));
 await assert.rejects(s.acquire(),/different local database/);assert.equal(s.rows.size,0);
});

test('stopped runtime can be started without discarding old-origin data before migration',async()=>{
 const raw=legacy([record(),record('TWO')]),s=setup({[LEGACY_KEY]:raw}),rt=s.runtime;s.runtime=null;
 const h=await s.acquire({allowDeferred:true});assert.equal(s.rows.size,0);assert.equal(s.ui[0].state.frozen,true);
 s.runtime={...rt,port:7332};await h.flush(s.runtime);assert.equal(s.rows.size,2);assert.equal(s.ui[0].data.get(LEGACY_KEY),raw);await h.release();
});

test('normal close with stopped runtime stays open rather than silently skipping history',async()=>{
 const s=setup({[LEGACY_KEY]:legacy([record()])});s.runtime=null;
 await assert.rejects(s.acquire(),/Restart the stopped runtime from Settings/);assert.equal(s.ui[0].state.frozen,false);
});

test('serialized concurrent transitions cannot unfreeze one another',async()=>{
 const s=setup();const first=await s.acquire();let second=null;
 const waiting=s.acquire().then(h=>{second=h;return h;});await new Promise(resolve=>setImmediate(resolve));assert.equal(second,null);
 await first.release();await waiting;assert.equal(s.ui[0].state.frozen,true);await first.release();assert.equal(s.ui[0].state.frozen,true);await second.release();assert.equal(s.ui[0].state.frozen,false);
});

for(const large of ['header','stream'])test('bounded response '+large+' refuses while preserving records',async()=>{
 const raw=legacy([record()]),s=setup({[LEGACY_KEY]:raw});
 s.intercept=async()=>large==='header'?new Response('{}',{headers:{'Content-Length':String(11*1024*1024)}}):new Response('x'.repeat(10*1024*1024+1));
 await assert.rejects(s.acquire(),/too large/);assert.equal(s.ui[0].data.get(LEGACY_KEY),raw);assert.equal(s.ui[0].state.frozen,false);
});

test('malformed pending and unauthorized key references cannot become generic storage reads',()=>{
 assert.throws(()=>decodeSnapshot({legacy:null,pending:[{key:'other',raw:env(record())}]}));
 assert.throws(()=>decodeSnapshot({legacy:null,pending:[{key:PENDING_PREFIX+'one',raw:'{bad'}]}));
});

test('packaging includes the barrier and actual main places it before authentication clearing and navigation',()=>{
 const main=readFileSync(new URL('../desktop/main.mjs',import.meta.url),'utf8');
 const before=main.slice(main.indexOf('beforeRestart:'),main.indexOf('afterRestart:'));
 assert.ok(before.indexOf('await acquireLibraryTransition')<before.indexOf('runtimeAuth.clear()'));
 assert.ok(before.indexOf('await acquireLibraryTransition')<before.indexOf('await applyStoredInferenceToEnv'));
 const after=main.slice(main.indexOf('afterRestart:'),main.indexOf('afterRestartFinally:'));
 assert.ok(after.indexOf('await settingsHistoryTransition?.flush')<after.indexOf('bindRuntime'));
 assert.ok(JSON.parse(readFileSync(new URL('../desktop/package.json',import.meta.url),'utf8')).build.files.includes('library-vault.mjs'));
});

test('successful retired-origin release unlocks coordinator without reopening the old writer',async()=>{
 const s=setup({[LEGACY_KEY]:legacy([record()])});const hold=await s.acquire();s.base='http://127.0.0.1:7332';
 await hold.release({keepRetiredFrozen:true});assert.equal(s.ui[0].state.frozen,true);assert.ok(s.ui[0].window.__bzLibraryVaultBarrier);
 // A new current-origin page can acquire the coordinator; the old document is
 // still frozen until it is unloaded by preload navigation.
 s.ui[0].wc.mainFrame.url='http://127.0.0.1:7332/buzzy/library';s.runtime={...s.runtime,port:7332};
 const next=await s.acquire();await next.release();assert.equal(s.ui[0].state.frozen,false);
});
test('same-origin successful restart resumes the still-current document',async()=>{
 const s=setup();const hold=await s.acquire();await hold.release({keepRetiredFrozen:true});assert.equal(s.ui[0].state.frozen,false);
});
