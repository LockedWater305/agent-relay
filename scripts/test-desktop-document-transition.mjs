/** New reconstruction: actual coordinator, isolated document/native-event model.
 * These are not recovered tests or native Electron input/renderer evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createDocumentTransition} from '../desktop/document-transition.mjs';
const drain=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>Promise.withResolvers();
function setup({count=1,timeoutMs=1000}={}){
 let runtime={host:'127.0.0.1',port:7331,token:'synthetic_only'.repeat(4)},base='http://127.0.0.1:7331',libraryGate=null,libraryError=null,idle=0;
 const library={acquires:0,flushes:0,releases:0};
 const pages=Array.from({length:count},(_,i)=>{
  const state={dirty:false,lease:null,begins:0,drains:0,releases:0,drainGate:null};
  const location=new URL(base+'/buzzy/sketch?job=job_board');
  const hook={begin(n){if(state.lease&&state.lease!==n)throw Error('wrong lease');state.begins++;state.lease=n;},state(n){if(n!==state.lease)throw Error('wrong lease');return {lease:n,jobId:location.searchParams.get('job'),dirty:state.dirty};},async drain(n){state.drains++;if(state.drainGate)await state.drainGate.promise;if(n!==state.lease)throw Error('wrong lease');state.dirty=false;return true;},release(n){if(n===state.lease){state.lease=null;state.releases++;}}};
  const stage={isConnected:true,bzDesktopSketch:hook},document={getElementById:id=>id==='stage'?stage:null};
  const context=vm.createContext({window:{},document,location,URL});
  const wc=new EventEmitter();Object.assign(wc,{id:i+1,mainFrame:{url:location.href},isDestroyed:()=>false,getURL:()=>location.href,executeJavaScript:async source=>vm.runInContext(source,p.context)});
  const p={wc,state,stage,context,location,document};return p;
 });
 const acquire=createDocumentTransition({getContents:()=>pages.map(p=>p.wc),getBase:()=>base,getRuntime:()=>runtime,timeoutMs,onIdle:()=>idle++,acquireLibrary:async()=>{library.acquires++;if(libraryGate)await libraryGate.promise;if(libraryError)throw libraryError;return {async flush(){library.flushes++;},async release(){library.releases++;}};}});
 return {pages,acquire,library,get idle(){return idle;},get runtime(){return runtime;},set runtime(v){runtime=v;},get base(){return base;},set base(v){base=v;},set libraryGate(v){libraryGate=v;},set libraryError(v){libraryError=v;}};
}
function request(p,type='xhr'){return {webContentsId:p.wc.id,webContents:p.wc,resourceType:type};}
function prevented(wc,name){let answer=false;wc.emit(name,{preventDefault(){answer=true;}});return answer;}

test('hold starts synchronously, drains before Library, seals only after accepted work',async()=>{
 const s=setup(),p=s.pages[0],g=gate();p.state.dirty=true;p.state.drainGate=g;
 const pending=s.acquire();assert.equal(s.acquire.held(),true);assert.equal(prevented(p.wc,'before-mouse-event'),true);
 assert.equal(s.acquire.blocksRequest(request(p,'mainFrame')),true);assert.equal(s.acquire.blocksRequest(request(p)),false);
 await drain();assert.equal(s.library.acquires,0);g.resolve();const h=await pending;
 assert.equal(p.state.dirty,false);assert.equal(s.library.acquires,1);assert.equal(s.acquire.blocksRequest(request(p)),true);
 await h.release();assert.equal(s.acquire.held(),false);assert.equal(p.state.lease,null);assert.equal(s.idle,1);
 assert.equal(prevented(p.wc,'before-input-event'),false);assert.equal(s.acquire.blocksRequest(request(p,'mainFrame')),false);
});
for(const name of ['before-input-event','before-mouse-event','will-navigate','will-frame-navigate','will-redirect'])test('main-owned '+name+' guard survives new same-frame document',async()=>{
 const s=setup(),p=s.pages[0],h=await s.acquire();
 p.context=vm.createContext({window:{},document:{},location:p.location});
 assert.equal(prevented(p.wc,name),true);assert.equal(s.acquire.blocksRequest(request(p)),true);
 await h.release();assert.equal(prevented(p.wc,name),false);
});
test('queued lease has no input/navigation gap and old release cannot unlock it',async()=>{
 const s=setup(),p=s.pages[0],a=await s.acquire();let b;
 const waiting=s.acquire().then(h=>{b=h;return h;});await drain();assert.equal(b,undefined);
 await a.release();assert.equal(s.acquire.held(),true);assert.equal(prevented(p.wc,'before-mouse-event'),true);
 await waiting;const nonce=p.state.lease;await a.release();assert.equal(p.state.lease,nonce);assert.equal(s.acquire.held(),true);
 await b.release();assert.equal(s.acquire.held(),false);assert.equal(s.idle,1);
});
for(const mutation of ['frame','route','document','runtime-object','runtime-token'])test('acquire fails closed for '+mutation+' during accepted drain',async()=>{
 const s=setup(),p=s.pages[0],g=gate();p.state.drainGate=g;const pending=s.acquire();await drain();
 if(mutation==='frame')p.wc.mainFrame={url:p.location.href};
 if(mutation==='route')p.location.pathname='/buzzy/talk';
 if(mutation==='document')p.context.window.__bzDesktopDocumentLease.document={};
 if(mutation==='runtime-object')s.runtime={...s.runtime};
 if(mutation==='runtime-token')s.runtime.token='changed_synthetic'.repeat(3);
 g.resolve();await assert.rejects(pending);assert.equal(s.acquire.held(),false);assert.equal(s.library.acquires,0);
});
test('Library failure resumes matching Sketch without stopping its runtime',async()=>{
 const s=setup(),p=s.pages[0],rt=s.runtime;s.libraryError=Error('Library refused');await assert.rejects(s.acquire(),/Library refused/);
 assert.equal(s.runtime,rt);assert.equal(p.state.lease,null);assert.equal(s.acquire.held(),false);s.libraryError=null;
 const h=await s.acquire();await h.release();
});
test('retired-origin successful release leaves old document frozen but unlocks main coordination',async()=>{
 const s=setup(),p=s.pages[0],h=await s.acquire();s.base='http://127.0.0.1:7332';await h.release({keepRetiredFrozen:true});
 assert.ok(p.state.lease);assert.ok(p.context.window.__bzDesktopDocumentLease);assert.equal(s.acquire.held(),false);
});
test('same-origin release resumes, while a skipped closed owner is never re-entered',async()=>{
 const s=setup({count:2}),h=await s.acquire();await h.release({skip:[s.pages[1].wc],keepRetiredFrozen:true});
 assert.equal(s.pages[0].state.lease,null);assert.ok(s.pages[1].state.lease);assert.equal(s.acquire.held(),false);
});
test('timeout fails closed and a later completion cannot release another nonce',async()=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate();p.state.drainGate=g;
 await assert.rejects(s.acquire(),/timed out/);assert.equal(s.acquire.held(),false);assert.equal(p.state.lease,null);
 p.state.drainGate=null;const h=await s.acquire(),nonce=p.state.lease;g.resolve();await drain();assert.equal(p.state.lease,nonce);
 await h.release();
});
test('flush rechecks original document identity even when Library has no pending records',async()=>{
 const s=setup(),p=s.pages[0],h=await s.acquire();p.wc.mainFrame={url:p.location.href};
 await assert.rejects(h.flush({...s.runtime,port:7332}),/window changed/);await h.release();
});
test('all captured windows must confirm clean state before sealing',async()=>{
 const s=setup({count:2});s.pages[1].stage.bzDesktopSketch.drain=async()=>true;s.pages[1].state.dirty=true;
 await assert.rejects(s.acquire(),/Sketch changed/);assert.equal(s.acquire.held(),false);assert.ok(s.pages.every(p=>p.state.lease===null));
});
test('unregistered and non-app surfaces are never read or granted an input hold',async()=>{
 const s=setup(),p=s.pages[0];p.location.pathname='/api/buzzy/assets/untrusted.html';const h=await s.acquire();
 assert.equal(p.state.begins,0);assert.equal(s.acquire.blocksRequest({webContentsId:999,resourceType:'xhr'}),false);await h.release();
});

// Timeout is not cancellation of executeJavaScript. Test both promise outcomes
// and partial begin effects without granting cleanup authority over another lease.
for(const outcome of ['success','reject-before-execution','reject-before-hook-effects','reject-after-hook-effects'])test('late begin '+outcome+' cleans only its retired nonce and permits explicit retry',async t=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc),begin=p.stage.bzDesktopSketch.begin;let pending,first=true;
 if(outcome.includes('hook-effects'))p.stage.bzDesktopSketch.begin=n=>{if(outcome==='reject-after-hook-effects')begin(n);throw Error('Synthetic hook rejected');};
 p.wc.executeJavaScript=source=>{
  if(first&&source.includes('hook?.begin(nonce)')){first=false;pending=g.promise.then(()=>{if(outcome==='reject-before-execution')throw Error('Synthetic admission rejected');return execute(source);});return pending;}
  return execute(source);
 };
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;p.stage.bzDesktopSketch.begin=begin;});
 await assert.rejects(s.acquire(),/timed out/);assert.equal(s.acquire.held(),false);assert.equal(p.context.window.__bzDesktopDocumentLease,undefined);
 g.resolve();if(outcome==='success')await pending;else await assert.rejects(pending,/rejected/);await drain();
 assert.equal(p.context.window.__bzDesktopDocumentLease,undefined);assert.equal(p.state.lease,null);
 p.stage.bzDesktopSketch.begin=begin;
 const h=await s.acquire();assert.equal(s.acquire.held(),true);assert.ok(p.state.lease);assert.equal(p.context.window.__bzDesktopDocumentLease.nonce,p.state.lease);
 await h.release();assert.equal(p.context.window.__bzDesktopDocumentLease,undefined);assert.equal(p.state.lease,null);
});

for(const outcome of ['success','rejection'])test('old late '+outcome+' cannot clear a newer acquired nonce',async t=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc);let pending,first=true;
 p.wc.executeJavaScript=source=>{
  const value=execute(source);
  if(first&&source.includes('hook?.begin(nonce)')){first=false;pending=value.then(result=>g.promise.then(()=>{if(outcome==='rejection')throw Error('Synthetic late rejection');return result;}));return pending;}
  return value;
 };
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;});
 await assert.rejects(s.acquire(),/timed out/);assert.equal(p.state.lease,null);
 const newer=await s.acquire(),nonce=p.state.lease;assert.ok(nonce);
 g.resolve();if(outcome==='success')await pending;else await assert.rejects(pending,/late rejection/);await drain();
 assert.equal(p.state.lease,nonce);assert.equal(p.context.window.__bzDesktopDocumentLease.nonce,nonce);assert.equal(s.acquire.held(),true);assert.equal(s.acquire.blocksRequest(request(p)),true);
 await newer.release();assert.equal(p.state.lease,null);
});

test('queued transition keeps its own hold when an old delayed begin rejects against its nonce',async t=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc);let pending,first=true;
 p.wc.executeJavaScript=source=>{
  if(first&&source.includes('hook?.begin(nonce)')){first=false;pending=g.promise.then(()=>execute(source));return pending;}
  return execute(source);
 };
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;});
 const old=s.acquire();const rejected=assert.rejects(old,/timed out/);const queued=s.acquire();await rejected;
 const newer=await queued,nonce=p.state.lease;assert.equal(s.acquire.held(),true);assert.equal(s.idle,0);
 g.resolve();await assert.rejects(pending,/Another desktop transition owns/);await drain();
 assert.equal(p.state.lease,nonce);assert.equal(p.context.window.__bzDesktopDocumentLease.nonce,nonce);assert.equal(prevented(p.wc,'before-mouse-event'),true);assert.equal(s.idle,0);
 await newer.release();assert.equal(s.acquire.held(),false);assert.equal(s.idle,1);
});

test('late rejection retries a failed initial cleanup without an unhandled rejection',async t=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc),begin=p.stage.bzDesktopSketch.begin;let pending,first=true,cleanups=0;
 p.stage.bzDesktopSketch.begin=n=>{begin(n);throw Error('Synthetic partial begin rejected');};
 p.wc.executeJavaScript=source=>{
  if(source.includes('delete window.__bzDesktopDocumentLease')&&++cleanups===1)return Promise.reject(Error('Synthetic cleanup unavailable'));
  if(first&&source.includes('hook?.begin(nonce)')){first=false;pending=g.promise.then(()=>execute(source));return pending;}
  return execute(source);
 };
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;p.stage.bzDesktopSketch.begin=begin;});
 await assert.rejects(s.acquire(),/timed out/);assert.equal(cleanups,1);
 g.resolve();await assert.rejects(pending,/partial begin rejected/);await drain();
 assert.equal(cleanups,2);assert.equal(p.state.lease,null);assert.equal(p.context.window.__bzDesktopDocumentLease,undefined);
 p.stage.bzDesktopSketch.begin=begin;const h=await s.acquire();await h.release();
});

test('failed late cleanup is contained and cannot release a newer held nonce',async t=>{
 const s=setup({timeoutMs:10}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc);let pending,first=true,refuseCleanup=false,refused=0;
 p.wc.executeJavaScript=source=>{
  if(refuseCleanup&&source.includes('delete window.__bzDesktopDocumentLease')){refused++;return Promise.reject(Error('Synthetic cleanup failed'));}
  const value=execute(source);
  if(first&&source.includes('hook?.begin(nonce)')){first=false;pending=value.then(()=>g.promise.then(()=>{throw Error('Synthetic late rejection');}));return pending;}
  return value;
 };
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;});
 await assert.rejects(s.acquire(),/timed out/);const h=await s.acquire(),nonce=p.state.lease;
 refuseCleanup=true;g.resolve();await assert.rejects(pending,/late rejection/);await drain();
 assert.equal(refused,1);assert.equal(p.state.lease,nonce);assert.equal(s.acquire.held(),true);
 refuseCleanup=false;await h.release();assert.equal(p.state.lease,null);assert.equal(s.acquire.held(),false);
});

test('fulfilled begin and pending owned drain do not trigger early release',async()=>{
 const s=setup(),p=s.pages[0],g=gate();p.state.dirty=true;p.state.drainGate=g;const pending=s.acquire();await drain();
 const nonce=p.state.lease;assert.ok(nonce);assert.equal(p.state.releases,0);assert.equal(s.acquire.held(),true);assert.equal(s.library.acquires,0);
 await drain();assert.equal(p.context.window.__bzDesktopDocumentLease.nonce,nonce);assert.equal(p.state.releases,0);
 g.resolve();const h=await pending;assert.equal(p.state.lease,nonce);assert.equal(p.state.releases,0);
 await h.release();assert.equal(p.state.releases,1);
});

test('stalled renderer cleanup does not hold main input or block other windows', async t => {
  const s = setup({ count: 2, timeoutMs: 50 }), p = s.pages[0], q = s.pages[1];
  const cleanup = gate(), execute = p.wc.executeJavaScript.bind(p.wc);
  let late;
  p.wc.executeJavaScript = source => {
    if (!late && source.includes('delete window.__bzDesktopDocumentLease')) {
      const result = execute(source);
      // Simulate the cleanup acknowledgement never returning to main yet.
      late = result.then(() => cleanup.promise);
      return late;
    }
    return execute(source);
  };
  t.after(() => cleanup.resolve());
  const handle = await s.acquire();
  let timer;
  try {
    await Promise.race([handle.release(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('The main-process input hold never cleared')), 750);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(s.acquire.held(), false);
  assert.equal(q.state.lease, null);
  assert.equal(prevented(q.wc, 'before-input-event'), false);
  assert.equal(s.idle, 1);
  const next = await s.acquire();
  const nextNonce = p.state.lease;
  cleanup.resolve();
  await late;
  await drain();
  assert.equal(p.state.lease, nextNonce);
  await next.release();
});

for(const when of ['before retry','during retry','after retry']) test('same-URL fresh document '+when+' never acquires the expired Sketch writer lease', async t => {
 const s=setup({timeoutMs:40}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc);
 let expired,first=true,h;
 p.wc.executeJavaScript=source=>{if(first&&source.includes('hook?.begin(nonce)')){first=false;expired=g.promise.then(()=>execute(source));return expired;}return execute(source);};
 t.after(async()=>{g.resolve();await h?.release();p.wc.executeJavaScript=execute;});
 await assert.rejects(s.acquire(),/timed out/);assert.equal(s.acquire.held(),false);
 const oldContext=p.context,originalFrame=p.wc.mainFrame,originalUrl=p.wc.getURL(),replacement=setup().pages[0];
 p.context=replacement.context;
 assert.notEqual(p.context.document,oldContext.document);assert.equal(p.wc.mainFrame,originalFrame);assert.equal(p.wc.getURL(),originalUrl);
 let expected=null;
 if(when!=='before retry'){h=await s.acquire();expected=replacement.state.lease;assert.ok(expected);if(when==='after retry'){await h.release();expected=null;}}
 const begins=replacement.state.begins;g.resolve();await expired.catch(()=>{});await drain();
 assert.equal(replacement.state.begins,begins,'a retired operation must not enter Sketch on a fresh document');assert.equal(replacement.state.lease,expected);
 if(when==='before retry'){h=await s.acquire();assert.ok(replacement.state.lease);}
 await h?.release();assert.equal(replacement.state.lease,null);
});
test('a committed same-URL navigation during identity capture cancels instead of draining the fresh Sketch document',async t=>{
 const s=setup({timeoutMs:100}),p=s.pages[0],g=gate(),execute=p.wc.executeJavaScript.bind(p.wc);let first=true;
 p.wc.executeJavaScript=source=>{if(first){first=false;return g.promise.then(()=>execute(source));}return execute(source);};
 t.after(()=>{g.resolve();p.wc.executeJavaScript=execute;});
 const pending=s.acquire();await drain();const replacement=setup().pages[0];p.context=replacement.context;p.wc.emit('did-navigate',{},p.wc.getURL(),200,'OK');g.resolve();
 await assert.rejects(pending,/window changed/);assert.equal(replacement.state.begins,0);assert.equal(s.library.acquires,0);assert.equal(s.acquire.held(),false);
});
test('cold Sketch still canonicalizes its own newly generated job during a same-document Save',async()=>{
 const s=setup(),p=s.pages[0];p.location.pathname='/buzzy/sketch.html';p.location.search='';p.wc.mainFrame.url=p.location.href;
 const drainSketch=p.stage.bzDesktopSketch.drain;
 p.stage.bzDesktopSketch.drain=async nonce=>{const result=await drainSketch(nonce);p.location.pathname='/buzzy/sketch';p.location.search='?job=job_art_local123';p.wc.mainFrame.url=p.location.href;p.wc.emit('did-navigate-in-page',{isMainFrame:true},p.location.href,true);return result;};
 const h=await s.acquire();assert.equal(h.targets[0].url,p.location.href);assert.equal(s.library.acquires,1);await h.verify();await h.release();assert.equal(p.state.lease,null);
});
