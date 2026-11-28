/** Newly reconstructed after the 2026-11-15 executor rollback. This is NOT the
 * lost lifetime fixture. Whole actual main/settings modules and actual Sketch /
 * art route / emitted SQLite-adapted SQL execute against declared Electron,
 * supervisor, credential-store and CSP I/O doubles. No native renderer, provider,
 * credentials, socket, user database or process exit is used. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture,drain} from './test-sketch-save.mjs';

const root=resolve(process.env.BZ_SKETCH_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const clone=value=>JSON.parse(JSON.stringify(value));
export const deferred=()=>Promise.withResolvers();
const event=()=>({prevented:false,preventDefault(){this.prevented=true;}});

export async function desktop(t,fixtures,options={}) {
 assert.ok(fixtures.length,'an actual page fixture is required');
 const errors=[],logs=[],windows=[],requests=[],messages=[],timers=new Set(),ipc=new Map(),menu={};
 let ready=null,exitCode=null,requestHandler=null,headersHandler=null,nextId=1,currentRuntime=null,starts=0,stops=0;
 const proc=new EventEmitter();proc.platform=options.platform||'darwin';proc.env={BZ_CHAT_KEY:'synthetic-fixture-only-no-provider',BZ_PROBE_PATH:new URL(fixtures[0].h.location.href).pathname+new URL(fixtures[0].h.location.href).search};
 const app=new EventEmitter();
 Object.assign(app,{isPackaged:true,getVersion:()=> 'synthetic-reconstruction',requestSingleInstanceLock:()=>true,
  commandLine:{appendSwitch(){}},whenReady:()=>({then(fn){ready=fn;return Promise.resolve();}}),
  exit(code){exitCode=code;},quit(){return quit();}});
 const scheduled=(fn,ms,...args)=>{const id=setTimeout(()=>{timers.delete(id);fn(...args);},options.timerDelay?.(ms)??ms);id.unref?.();timers.add(id);return id;};
 const cancel=id=>{clearTimeout(id);timers.delete(id);};
 const auth=details=>{assert.equal(typeof requestHandler,'function','actual main request listener is installed');let result;requestHandler(details,x=>{result=x;});assert.ok(result);return result;};
 let api;
 function attachStorage(f){
  if(!f.h.context.localStorage){const data=f.desktopStorage||new Map();f.desktopStorage=data;f.h.context.localStorage={get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(String(k),String(v)),removeItem:k=>data.delete(k)};}
 }
 function frame(win){return {get url(){return win.fixture.h.location.href;},get parent(){return null;}};}
 class Window extends EventEmitter {
  constructor(config={}){
   super();this.id=nextId++;this.config=config;this.destroyed=false;this.preventUnload=false;this.sent=[];
   this.fixture=fixtures[windows.length]||fixtures[0];attachStorage(this.fixture);
   this.preloadTimers=[];this.preloadListeners=new Map();this.preloadBridge=null;this.navigationErrors=[];
   const wc=new EventEmitter();this.webContents=wc;wc.id=this.id;wc.mainFrame=frame(this);
   wc.isDestroyed=()=>this.destroyed;wc.getURL=()=>this.fixture.h.location.href;
   wc.executeJavaScript=async code=>{this.scripts.push(code);return vm.runInContext(code,this.context,{timeout:1000});};
   wc.setWindowOpenHandler=fn=>{wc.windowOpenHandler=fn;};
   wc.downloadURL=()=>{throw Error('Downloads are outside this test');};
   wc.send=(channel,data)=>{const m={wc,channel,data:clone(data)};messages.push(m);this.sent.push(m);this.preloadListeners.get(channel)?.({},clone(data));if(options.autoNavigate)queueMicrotask(()=>void this.flushPreload());};
   wc.loadURL=async url=>{
    const details={url,webContentsId:wc.id,webContents:wc,frame:wc.mainFrame,resourceType:'mainFrame',requestHeaders:{}};
    const policy=requestHandler?auth(details):{};requests.push({url,policy,kind:'loadURL'});
    if(policy.cancel){wc.emit('did-fail-load',{},-3,'ERR_ABORTED',url,true);throw Error('Navigation cancelled by actual main request policy');}
    if(options.beforeLoad)await options.beforeLoad(url);
    this.fixture.h.location.href=url;wc.mainFrame=frame(this);
    wc.emit('did-navigate',{},url,200,'OK');wc.emit('did-finish-load');
    // Electron emits one ready-to-show per host; allow targeted tests to
    // release first paint explicitly after navigation completes.
    if (!this.firstPaintModeled) {
      this.firstPaintModeled = true;
      if (!options.deferMainFirstPaint?.(this)) this.emit('ready-to-show');
    }
    return undefined;
   };
   wc.reload=()=>wc.loadURL(wc.getURL());
   this.scripts=[];windows.push(this);
   this.fixture.authorizeRequest=req=>{
    const policy=auth({url:new URL(req.url,this.fixture.h.location.href).href,webContentsId:wc.id,webContents:wc,frame:wc.mainFrame,resourceType:'xhr',requestHeaders:{}});
    if(policy.cancel||!currentRuntime||policy.requestHeaders?.Authorization!==`Bearer ${currentRuntime.token}`)throw Error('Synthetic transport obeyed actual main authorization refusal');
   };
   // The unchanged production preload owns pending-IPC navigation timing. Only
   // its timer and location I/O are modeled; no handler is substituted.
   vm.runInNewContext(readFileSync(resolve(root,'desktop/preload.cjs'),'utf8'),{
    require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>{this.preloadBridge=value;}},ipcRenderer:{on:(name,fn)=>this.preloadListeners.set(name,fn),invoke:async(name,payload)=>{assert.ok(ipc.has(name),name);return ipc.get(name)({sender:wc,senderFrame:wc.mainFrame},payload);}}}),
    process:{isMainFrame:true},URL,window:{location:{replace:url=>{void wc.loadURL(url).catch(error=>this.navigationErrors.push(error.message));}}},
    setTimeout:fn=>{const id={fn};this.preloadTimers.push(id);return id;},clearTimeout:id=>{this.preloadTimers=this.preloadTimers.filter(x=>x!==id);}
   },{filename:'actual-preload.cjs'});
  }
  async flushPreload(){const tasks=this.preloadTimers.splice(0);for(const task of tasks)task.fn();await drain();}
  get context(){return this.fixture.h.context;}
  get url(){return this.webContents.getURL();}
  useDocument(f,{sameFrame=false}={}){this.fixture=f;attachStorage(f);if(!sameFrame)this.webContents.mainFrame=frame(this);}
  replaceFrame(){
   // Unlike useDocument's explicit external fixture, this clean reload retains
   // the same SQL fixture but creates a fresh whole renderer VM synchronously.
   this.replacementReady=this.fixture.resetDocument();attachStorage(this.fixture);this.webContents.mainFrame=frame(this);
  }
  isDestroyed(){return this.destroyed;}
  loadURL(url){return this.webContents.loadURL(url);}
  show(){} focus(){} isVisible(){return true;} isMinimized(){return false;} restore(){}
  close(){
   const closing=event();this.emit('close',closing);if(closing.prevented)return;
   if(options.interceptNativeClose?.(this))return;
   let refused=this.preventUnload;
   this.fixture.event('beforeunload',{preventDefault(){refused=true;}});
   if(refused){const prevented=event();this.lastUnloadEvent=prevented;this.webContents.emit('will-prevent-unload',prevented);if(!prevented.prevented)return;}
   this.destroyed=true;this.emit('closed');this.webContents.emit('destroyed');
  }
 }
 Window.getAllWindows=()=>windows.filter(w=>!w.destroyed);
 Window.getFocusedWindow=()=>Window.getAllWindows()[0]||null;
 class Supervisor {
  constructor(){this.dataDir='/synthetic/no-disk-user-data';}
  get runtime(){return currentRuntime;}
  set runtime(v){currentRuntime=v;}
  async start(){if(!currentRuntime){starts++;currentRuntime={host:'127.0.0.1',port:7330+starts,token:('synthetic_generation_'+starts+'_').padEnd(43,'x')};}return currentRuntime;}
  async stop(){stops++;currentRuntime=null;}
  async isHealthy(rt){return Boolean(rt&&rt===currentRuntime);}
 }
 const state={inference:null,music:null,search:null};
 const runtimeLibraries={
  'scripts/lib/inference.mjs':{loadInference:()=>state.inference,hasRemovableInference:()=>state.inference!==null,saveInference:(_d,cfg)=>state.inference={...cfg,encrypted:false},clearInference:()=>{state.inference=null;},resolveInference:()=>state.inference,isExpired:()=>false,redactKey:()=> '[synthetic redacted]',storePath:d=>d+'/inference.json'},
  'scripts/lib/search-keys.mjs':{resolveSearch:()=>state.search,saveSearchKey:(_d,cfg)=>state.search={...cfg,encrypted:false},clearSearchKey:()=>{state.search=null;},saveManagedSearch:()=>{throw Error('Managed account forbidden');},loadManagedSearch:()=>null},
  'scripts/lib/music-keys.mjs':{loadMusicKey:()=>state.music,resolveMusicKey:()=>state.music,saveMusicKey:(_d,cfg)=>state.music={...cfg,encrypted:false},clearMusicKey:()=>{state.music=null;}},
 };
 const paths={ROOT:'/synthetic/runtime',runtimeLib:async name=>{assert.ok(runtimeLibraries[name],name);return runtimeLibraries[name];}};
 const ses={webRequest:{onBeforeSendHeaders(_filter,fn){assert.equal(requestHandler,null,'do not overwrite a competing request listener');requestHandler=fn;},onHeadersReceived(_filter,fn){headersHandler=fn;},onCompleted(){},onErrorOccurred(){}},setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){}};
 const electron={app,BrowserWindow:Window,Menu:{buildFromTemplate:template=>template,setApplicationMenu:value=>{menu.template=value;}},session:{defaultSession:ses,fromPartition(){throw Error('Cloud session forbidden');}},shell:{openExternal(){throw Error('External navigation forbidden');},openPath:async()=>''},dialog:{showErrorBox:(title,message)=>errors.push({title,message}),showMessageBox:async()=>({response:0})},safeStorage:{encryptString:value=>Buffer.from(value),decryptString:value=>Buffer.from(value).toString()},ipcMain:{handle:(key,fn)=>ipc.set(key,fn)},systemPreferences:{getMediaAccessStatus:()=> 'not-determined'}};
 const fetchImpl=async(url,init={})=>{
  assert.equal(new URL(url).pathname,'/api/buzzy/library-vault','main fetch remains scoped to Library');
  requests.push({url,kind:'library',method:init.method||'GET'});
  if(options.libraryFetch)return options.libraryFetch(url,init);
  throw Error('Unexpected Library data in empty-store fixture');
 };
 const context=vm.createContext({URL,URLSearchParams,Buffer,Response,Request,Headers,AbortSignal,TextDecoder,TextEncoder,crypto:globalThis.crypto,
  process:proc,console:{log:(...a)=>logs.push(a),warn:(...a)=>logs.push(a),error:(...a)=>logs.push(a)},fetch:fetchImpl,
  setTimeout:scheduled,clearTimeout:cancel,setInterval,clearInterval,queueMicrotask,structuredClone});
 const modules=new Map();
 function synthetic(key,exports){if(modules.has(key))return modules.get(key);const mod=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:key});modules.set(key,mod);return mod;}
 const mocks={electron,'./supervisor.mjs':{RuntimeSupervisor:Supervisor},'./paths.mjs':paths,
  './logger.mjs':{installLogging(){},logLine(){},logPaths:()=>({file:null,dir:null})},
  './connect.mjs':{connectAccount(){throw Error('Account provider forbidden');},cloudBaseUrl:()=> 'https://unused.invalid',managedAccountConnectCapability:()=>({enabled:false})},
  // Deliberately isolated CSP I/O double; real CSP/source suites are separate.
  './csp.mjs':{loadCspManifest:()=>({}),createDesktopCsp:()=>({authorizeRequest:(_d,decision)=>decision,headers:()=>({}),finished(){}})},
  'node:fs':{existsSync:()=>false,mkdirSync(){},readFileSync(){throw Error('Main must not read real files');},writeFileSync(){throw Error('Main must not write real files');}},
 };
 async function load(id,referencing){
  if(mocks[id])return synthetic('mock:'+id,mocks[id]);
  if(id.startsWith('node:'))return synthetic(id,await import(id));
  const path=resolve(referencing?dirname(referencing.identifier):root,id);
  if(modules.has(path))return modules.get(path);
  let source=readFileSync(path,'utf8');
  if(path===resolve(root,'desktop/main.mjs'))source+=`\nglobalThis.__desktopTest={
    supervisor:()=>supervisor,restart:()=>settingsHandlers.clear('search'),
    bind:(rt,notify=false)=>bindRuntime(rt,notify),
    clearBinding:()=>typeof clearRuntimeAuth==='function'?clearRuntimeAuth():runtimeAuth.clear(),
    bindingState:()=>({present:typeof runtimeBinding!=='undefined'&&Boolean(runtimeBinding),generation:typeof runtimeBindingGeneration==='undefined'?null:runtimeBindingGeneration}),
    openSettings,createWindow,handleAppLink,
    settingsWindowFor:(url)=>settingsWindowFor(url),
    acquire:(options)=>acquireLibraryTransition(options),
    currentMain:()=>mainWindow,currentSettings:()=>settingsWindow, rememberedMainRoute:()=>mainReopenPage,
    runtimeBase:()=>runtimeBase,
    retargets:()=>typeof pendingRuntimeRetargets==='undefined'?null:pendingRuntimeRetargets,
    flushRetargets:()=>typeof flushRuntimeRetargets==='function'?flushRuntimeRetargets():undefined,
    held:()=>typeof acquireLibraryTransition.held==='function'?acquireLibraryTransition.held():false
  };`;
  const mod=new vm.SourceTextModule(source,{context,identifier:path,initializeImportMeta(meta){meta.url=pathToFileURL(path).href;},importModuleDynamically:async(spec,ref)=>{const imported=await load(spec,ref);if(imported.status==='unlinked')await imported.link(load);if(imported.status==='linked')await imported.evaluate();return imported;}});
  modules.set(path,mod);await mod.link(load);return mod;
 }
 const main=await load(resolve(root,'desktop/main.mjs'));await main.evaluate();assert.equal(typeof ready,'function');await ready();api=context.__desktopTest;assert.ok(api);assert.equal(errors.length,0,'main startup: '+JSON.stringify(errors));
 const initialMain=api.currentMain();assert.ok(initialMain);
 if(options.bootProbeOnly)delete proc.env.BZ_PROBE_PATH;
 async function quit(){const e=event();await Promise.all(app.listeners('before-quit').map(fn=>fn(e)));return e;}
 const d={api:{...api,auth},main:initialMain,windows,errors,logs,requests,messages,menu,app,ipc,
  runtime:()=>currentRuntime,didExit:()=>exitCode!==null,exitCode:()=>exitCode,quit,
  get starts(){return starts;},get stops(){return stops;},
  close:async(win=initialMain)=>{win.close();await drain();},
  nextNavigation:async(win=initialMain)=>win.flushPreload(),
  requestHandler:()=>requestHandler,headersHandler:()=>headersHandler,
  replaceRuntime:rt=>{currentRuntime=rt;},
 };
 t.after(()=>{for(const id of timers)clearTimeout(id);timers.clear();});
 return d;
}

// Tests below execute the actual installed main/Settings lifecycle and actual
// page mutation/route/SQL. DOM events and Electron timing remain declared doubles.
test('reconstructed actual normal Quit drains a completed mark before runtime stop',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);await p.draw();assert.equal(f.data().board.strokes.length,2);
 await d.quit();assert.equal(d.didExit(),true);assert.equal(f.posts().length,1);assert.equal(f.data().board.strokes.length,3);assert.equal(d.stops,1);
});
test('reconstructed actual Quit storage failure preserves runtime and draft for explicit retry',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),original=d.runtime();await p.draw();f.failSave(true);
 await d.quit();assert.equal(d.didExit(),false);assert.equal(d.runtime(),original);assert.equal(d.stops,0);assert.equal(f.data().board.strokes.length,2);assert.ok(d.errors.length);
 f.failSave(false);await d.quit();assert.equal(d.didExit(),true);assert.equal(f.data().board.strokes.length,3);
});
test('native Quit gives one database-stop message, not save guidance when saves succeeded', async t => {
  const f = await fixture(t), page = await f.mount(), d = await desktop(t, [f]);
  assert.ok(d.menu.template.flatMap(item => item.submenu || []).some(item => item.role === 'quit'));
  const sup = d.api.supervisor(), originalStop = sup.stop.bind(sup);
  const entered = f.defer(), finish = f.defer();
  let attempts = 0;
  sup.stop = async () => {
    attempts++;
    entered.resolve();
    await finish.promise;
    throw Error('fixture: local database has not stopped at /private/profile/path');
  };
  await page.draw();
  const quitting = d.quit();
  await entered.promise;
  assert.equal(f.data().board.strokes.length, 3, 'save passed before database stop');
  await d.quit(); await d.quit();
  assert.equal(attempts, 1);
  assert.equal(d.errors.length, 0, 'no prompt while shutdown is still in progress');
  finish.resolve(); await quitting;
  assert.equal(d.didExit(), false);
  assert.equal(d.stops, 0);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /Sketch and Library.*finished saving/i);
  assert.match(d.errors[0].message, /database.*wait.*Quit again/i);
  assert.doesNotMatch(d.errors[0].message, /private\/profile|changes can be saved/);
  assert.equal(d.api.held(), false);
  sup.stop = originalStop;
  await d.quit();
  assert.equal(d.didExit(), true);
  assert.equal(d.errors.length, 1);
  assert.equal(f.posts().length, 1, 'retry does not submit the accepted save again');
});

test('reconstructed actual Quit waits for a pending response body and does not duplicate an accepted Save',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),gate=f.defer();let accepted=false;
 f.transport=async(req,next)=>{const response=await next();if(req.method==='POST'){accepted=true;return {ok:true,status:200,json:async()=>{await gate.promise;return response.json();}};}return response;};
 await p.draw();await p.save();assert.equal(accepted,true);const quitting=d.quit();await drain();assert.equal(d.didExit(),false);assert.equal(d.stops,0);assert.equal(f.posts().length,1);
 gate.resolve();await quitting;assert.equal(d.didExit(),true);assert.equal(f.posts().length,1);assert.equal(f.data().board.strokes.length,3);
});

function header(d,rt=d.runtime(),resourceType='xhr'){
 const wc=d.main.webContents;
 return d.api.auth({url:`http://127.0.0.1:${rt.port}/api/buzzy/art?job=job_board`,webContentsId:wc.id,webContents:wc,frame:wc.mainFrame,resourceType,requestHeaders:{}}).requestHeaders?.Authorization;
}
function input(wc,type='before-mouse-event'){
 const e=event();wc.emit(type,e,{type:'mouseDown'});return e.prevented;
}
for(const failure of ['transport','json','missing-ack','lost-after-commit'])test('reconstructed Quit '+failure+' failure retains retry ownership',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),rt=d.runtime();await p.draw();
 f.transport=async(req,next)=>{if(req.method!=='POST')return next();if(failure==='transport')throw Error('offline');const r=await next();if(failure==='lost-after-commit')throw Error('lost response after actual SQL');return {ok:true,status:200,json:async()=>{if(failure==='json')throw Error('broken body');return {};}};};
 await d.quit();assert.equal(d.didExit(),false);assert.equal(d.runtime(),rt);assert.equal(d.stops,0);assert.match(p.el('savedFlag').textContent,/Not saved/);assert.equal(p.el('save').disabled,false);
 f.transport=null;await p.draw();await d.quit();assert.equal(d.didExit(),true);assert.equal(f.data().board.strokes.length,4);
});
test('reconstructed Quit drains newer edits following the pending immutable revision',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),gate=f.defer();let first=true;
 f.transport=async(req,next)=>{if(first&&req.method==='POST'){first=false;await gate.promise;}return next();};
 await p.draw();await p.save();await p.draw();const quitting=d.quit();await drain();assert.equal(d.stops,0);assert.equal(p.el('save').disabled,true);
 gate.resolve();await quitting;assert.equal(d.didExit(),true);assert.deepEqual(f.posts().map(x=>x.body.board.strokes.length),[3,4]);assert.equal(f.data().board.strokes.length,4);
});
test('reconstructed Quit completes an active gesture before freezing',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);await p.start();p.el('board').dispatch('pointermove',{clientX:160,clientY:170});
 await d.quit();assert.equal(d.didExit(),true);assert.equal(f.data().board.strokes.length,3);assert.equal(f.posts().length,1);
});
for(const mode of ['failed','pending'])test('reconstructed Quit '+mode+' initial hydration never writes an empty board',async t=>{
 const f=await fixture(t),gate=f.defer();if(mode==='failed')f.failRead();else f.transport=async(req,next)=>{const r=await next();if(req.method==='GET')await gate.promise;return r;};
 await f.mount();const d=await desktop(t,[f]);await d.quit();gate.resolve();await drain();assert.equal(d.didExit(),true);assert.equal(f.posts().length,0);assert.equal(f.data().board.strokes.length,2);
});
test('reconstructed cold first Save canonicalization preserves one created job on Quit',async t=>{
 const f=await fixture(t),p=await f.mount(null),d=await desktop(t,[f]);
 await p.draw();await d.quit();assert.equal(d.didExit(),true);
 const creates=f.requests.filter(x=>x.url==='/api/buzzy/jobs');assert.equal(creates.length,1);assert.equal(f.data(creates[0].body.id).board.strokes.length,1);assert.equal(f.posts().length,1);
});
test('repeated actual Quit cannot bypass the pending Save or create another transition',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),gate=f.defer();f.transport=async(req,next)=>{if(req.method==='POST')await gate.promise;return next();};await p.draw();
 const first=d.quit();await drain();await d.quit();await d.quit();assert.equal(d.stops,0);assert.equal(d.didExit(),false);assert.equal(f.uiRequests.filter(x=>x.method==='POST').length,1);
 gate.resolve();await first;assert.equal(d.didExit(),true);assert.equal(d.stops,1);
});
test('main-owned input and navigation hold starts synchronously and lasts through release',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),wc=d.main.webContents,original=wc.getURL();const acquiring=d.api.acquire();
 assert.equal(input(wc),true);assert.equal(input(wc,'before-input-event'),true);
 const navigating=event();wc.emit('will-navigate',navigating,'http://127.0.0.1:7331/buzzy/memory');assert.equal(navigating.prevented,true);
 const hold=await acquiring;assert.equal(input(wc),true);await assert.rejects(wc.reload(),/cancelled/);assert.equal(wc.getURL(),original);
 await d.api.handleAppLink(wc,'http://127.0.0.1:7331/buzzy/memory');assert.equal(wc.getURL(),original);await hold.release();assert.equal(input(wc),false);assert.equal(input(wc,'before-input-event'),false);
});
test('queued leases retain input ownership and an older release cannot unlock the newer lease',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),wc=d.main.webContents,h1=await d.api.acquire();let acquired=false;
 const p=d.api.acquire().then(h=>{acquired=true;return h;});await drain();assert.equal(acquired,false);await h1.release();const h2=await p;assert.equal(input(wc),true);await h1.release();assert.equal(input(wc),true);await h2.release();assert.equal(input(wc),false);
});
test('a cold whole-document replacement cannot receive modeled pointer input during retirement',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),fresh=await fixture(t),p=await fresh.mount(null),hold=await d.api.acquire();d.main.useDocument(fresh);
 const wc=d.main.webContents;assert.equal(input(wc),true);assert.equal(p.el('save').disabled,false,'cold page itself is editable without any GET');
 if(!input(wc))await p.draw();assert.doesNotMatch(p.el('savedFlag').textContent,/Unsaved/);assert.equal(fresh.uiRequests.length,0);await hold.release();
});
test('normal window close saves, observes destruction, and does not stop the shared runtime',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);await p.draw();await d.close();assert.equal(d.main.isDestroyed(),true);assert.equal(f.data().board.strokes.length,3);assert.equal(d.stops,0);
});
test('prevented window close releases the matching writer and can be retried without overriding unload',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);d.main.preventUnload=true;await p.draw();await d.close();assert.equal(d.main.isDestroyed(),false);assert.equal(d.main.lastUnloadEvent.prevented,false,'no override of Electron unload prevention');assert.equal(d.errors.length,0,'user-cancelled close is not a save error');assert.equal(d.api.held(),false);assert.equal(p.el('save').disabled,false);assert.equal(f.data().board.strokes.length,3);
 await p.draw();d.main.preventUnload=false;await d.close();assert.equal(d.main.isDestroyed(),true);assert.equal(f.data().board.strokes.length,4);
});
test('guarded close retirement: renderer disappears during native close, releasing the queue without forcing the window shut', async t => {
  const f = await fixture(t), page = await f.mount();
  let nativeCloses = 0, gone = false, deadEvaluations = 0;
  const d = await desktop(t, [f], { interceptNativeClose: win => {
    if (++nativeCloses !== 1) return false;
    queueMicrotask(() => {
      gone = true;
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    });
    return true; // No closed/unload reply: the host window still exists.
  } });
  const wc = d.main.webContents, evaluate = wc.executeJavaScript;
  wc.executeJavaScript = async code => {
    if (!gone) return evaluate(code);
    deadEvaluations++;
    return new Promise(() => {});
  };
  await page.draw();
  await d.close();
  assert.equal(nativeCloses, 1);
  assert.equal(f.data().board.strokes.length, 3, 'save finished before dispatching close');
  assert.equal(d.main.isDestroyed(), false, 'host was not force-closed');
  assert.equal(d.api.held(), false, 'renderer disappearance cannot strand the document transition');
  assert.equal(deadEvaluations, 0, 'do not run lease cleanup against the disappeared renderer');
  assert.equal(wc.listenerCount('will-prevent-unload'), 0);
  assert.equal(wc.listenerCount('render-process-gone'), 0);
  assert.equal(d.errors.length, 0);
  gone = false;
  d.main.replaceFrame(); await d.main.replacementReady;
  await d.close();
  assert.equal(nativeCloses, 2);
  assert.equal(d.main.isDestroyed(), true);
  await d.quit();
  assert.equal(d.didExit(), true);
  assert.equal(d.stops, 1);
});

for (const whileSaving of [false, true]) {
  test(`guarded close retirement: destruction while ${whileSaving ? 'saving' : 'queued'} does not prompt for a vanished window`, async t => {
    const f = await fixture(t), page = await f.mount(), d = await desktop(t, [f]);
    const entered = f.defer(), proceed = f.defer();
    let held;
    if (whileSaving) {
      f.transport = async (req, next) => {
        const response = await next();
        if (req.method === 'POST') { entered.resolve(); await proceed.promise; }
        return response;
      };
      await page.draw();
    } else {
      held = await d.api.acquire();
    }
    const attempting = d.close();
    if (whileSaving) await entered.promise;
    else await attempting;
    // A native owner/renderer can destroy a child before its queued close runs.
    const win = d.main;
    if (!whileSaving) win.close = () => { throw Error('Object has been destroyed'); };
    win.destroyed = true;
    win.emit('closed');
    win.webContents.emit('destroyed');
    proceed.resolve(); await held?.release(); await attempting; await drain();
    assert.equal(d.api.held(), false);
    assert.equal(d.errors.length, 0);
    if (whileSaving) assert.equal(f.data().board.strokes.length, 3, 'the accepted save remains committed');
    await d.quit();
    assert.equal(d.didExit(), true);
    assert.equal(d.stops, 1);
  });
}

test('multiwindow Quit drains both captured mounted pages before stopping',async t=>{
 const f=await fixture(t),g=await fixture(t),p=await f.mount(),q=await g.mount(),d=await desktop(t,[f,g]);d.api.settingsWindowFor(g.h.location.href);await drain();await p.draw();await q.draw();await d.quit();
 assert.equal(d.didExit(),true);assert.equal(f.data().board.strokes.length,3);assert.equal(g.data().board.strokes.length,3);assert.equal(d.stops,1);
});
for(const samePort of [false,true])test('reconstructed authority sequence reaches real second stop refusal, same port='+samePort,async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),start=sup.start.bind(sup);
 sup.start=async()=>{const rt=await start();if(samePort)rt.port=7331;d.main.replaceFrame();return rt;};
 const first=await d.api.restart();assert.equal(first.restarted,false);assert.match(first.reason,/window changed/);const replacement=d.runtime();assert.equal(header(d,replacement),undefined);
 let stopReached=false;sup.stop=async()=>{stopReached=true;throw Error('synthetic exact second stop refusal');};const second=await d.api.restart();assert.equal(stopReached,true);assert.match(second.reason,/synthetic exact second stop refusal/);assert.equal(header(d,replacement),undefined);
});
test('genuinely bound original stop refusal restores before draft resume and explicit retry succeeds',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),sup=d.api.supervisor(),rt=d.runtime(),stop=sup.stop.bind(sup);sup.stop=async()=>{throw Error('synthetic original stays live');};
 await p.draw();const outcome=await d.api.restart();assert.match(outcome.reason,/original stays live/);assert.equal(header(d),`Bearer ${rt.token}`);assert.equal(d.api.bindingState().present,true);assert.equal(p.el('save').disabled,false);
 await p.draw();await p.save();assert.equal(f.data().board.strokes.length,4);sup.stop=stop;const retried=await d.api.restart();assert.equal(retried.restarted,true);assert.equal(d.runtime().port,7332);
});
for(const action of ['clear','bind-clear','replacement','token-mutation','port-mutation'])test('binding restoration refuses intervening '+action,async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),rt=d.runtime();
 sup.stop=async()=>{
  if(action==='clear')d.api.clearBinding();
  if(action==='bind-clear'){d.api.bind(rt);d.api.clearBinding();}
  if(action==='replacement')d.replaceRuntime({...rt});
  if(action==='token-mutation')rt.token='changed_synthetic_token'.padEnd(43,'y');
  if(action==='port-mutation')rt.port=7333;
  throw Error('synthetic changed authority');
 };
 const answer=await d.api.restart();assert.match(answer.reason,/changed authority/);assert.equal(header(d,rt),undefined);assert.equal(d.api.bindingState().present,false);
});
test('underlying bind rejection never mints a new successful binding proof',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),before=clone(d.api.bindingState()),rt=d.runtime();assert.throws(()=>d.api.bind({...rt,token:'short'}),/invalid session token/);assert.deepEqual(clone(d.api.bindingState()),before);assert.equal(header(d),`Bearer ${rt.token}`);
});
test('runtime-unavailable request cleanup and successful Quit invalidate binding proof',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),rt=d.runtime();assert.equal(d.api.bindingState().present,true);d.replaceRuntime(null);assert.equal(header(d,rt),undefined);assert.equal(d.api.bindingState().present,false);
 d.replaceRuntime(rt);d.api.bind(rt);assert.equal(d.api.bindingState().present,true);await d.quit();assert.equal(d.didExit(),true);assert.equal(d.api.bindingState().present,false);
});
test('two queued failed Settings attempts each restore only the genuinely bound original',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),rt=d.runtime();let calls=0;sup.stop=async()=>{calls++;throw Error('synthetic retained original '+calls);};
 const [a,b]=await Promise.all([d.api.restart(),d.api.restart()]);assert.match(a.reason,/original 1/);assert.match(b.reason,/original 2/);assert.equal(calls,2);assert.equal(header(d),`Bearer ${rt.token}`);assert.equal(d.api.held(),false);
});
test('actual preload cancelled under a later lease retries retarget after matching release and clears only on commit',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),old=d.main.url;const answer=await d.api.restart();assert.equal(answer.restarted,true);assert.equal(d.main.url,old);assert.equal(d.api.retargets().size,1);
 const hold=await d.api.acquire();await d.nextNavigation();assert.equal(d.main.url,old);assert.equal(d.main.navigationErrors.length,1);assert.equal(d.api.retargets().size,1);
 await hold.release();await d.nextNavigation();assert.match(d.main.url,/:7332\/buzzy\/sketch\?job=job_board$/);assert.equal(d.api.retargets().size,0);
});
test('queued Settings retargets coalesce to the latest runtime while retaining the original job route',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]);const [first,second]=await Promise.all([d.api.restart(),d.api.restart()]);assert.equal(first.restarted,true);assert.equal(second.restarted,true);assert.equal(d.runtime().port,7333);await d.nextNavigation();assert.match(d.main.url,/:7333\/buzzy\/sketch\?job=job_board$/);assert.equal(d.api.retargets().size,0);
});
test('failed destination commit does not acknowledge a retained Settings retarget',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]);await d.api.restart();const pending=[...d.api.retargets().values()][0],wc=d.main.webContents;assert.ok(pending);
 wc.emit('did-navigate',{},pending.url,500,'Error');assert.equal(d.api.retargets().size,1);wc.emit('did-navigate',{},pending.url,200,'OK');assert.equal(d.api.retargets().size,0);
});
test('queued restart reusing the pending port refreshes generation after a canceled actual preload navigation',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor();assert.equal((await d.api.restart()).restarted,true);const first=d.runtime();assert.equal(first.port,7332);
 const hold=await d.api.acquire();await d.nextNavigation();assert.match(d.main.url,/:7331\//);assert.equal(d.main.navigationErrors.length,1);
 const start=sup.start.bind(sup);sup.start=async()=>{const rt=await start();rt.port=7332;return rt;};
 const next=d.api.restart();await drain();await hold.release();assert.equal((await next).restarted,true);const current=d.runtime();assert.notEqual(current,first);assert.notEqual(current.token,first.token);assert.equal(current.port,7332);
 await d.nextNavigation();assert.match(d.main.url,/:7332\/buzzy\/sketch\?job=job_board$/);assert.equal(d.api.retargets().size,0,'successful matching commit acknowledges new-generation intent');
});
test('intervening successful binding is not overwritten by a failed older Settings attempt',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),original=d.runtime(),replacement={...original,token:'new_successful_synthetic_binding'.padEnd(43,'z')};
 sup.stop=async()=>{d.replaceRuntime(replacement);d.api.bind(replacement);throw Error('synthetic interrupted older attempt');};
 const answer=await d.api.restart();assert.match(answer.reason,/interrupted older attempt/);assert.equal(header(d),`Bearer ${replacement.token}`);assert.equal(d.api.bindingState().present,true);
});
test('Settings save barrier failure preserves original bound runtime and editable draft',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),rt=d.runtime();await p.draw();f.failSave(true);const result=await d.api.restart();assert.equal(result.restarted,false);assert.match(result.reason,/Sketch/);assert.equal(d.runtime(),rt);assert.equal(d.stops,0);assert.equal(header(d),`Bearer ${rt.token}`);assert.equal(p.el('save').disabled,false);
 f.failSave(false);await p.save();assert.equal(f.data().board.strokes.length,3);
});
test('Library parse failure after Sketch commit keeps runtime alive and retries without duplicate art writes',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),rt=d.runtime();await p.draw();f.desktopStorage.set('bz_docs_v1','{invalid');await d.quit();assert.equal(d.didExit(),false);assert.equal(d.runtime(),rt);assert.equal(d.stops,0);assert.equal(f.data().board.strokes.length,3);assert.equal(f.posts().length,1);assert.equal(p.el('save').disabled,false);
 f.desktopStorage.delete('bz_docs_v1');await d.quit();assert.equal(d.didExit(),true);assert.equal(f.posts().length,1);
});
test('createWindow already awaiting runtime start cannot register a new window during an acquired transition',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),rt=d.runtime(),gate=f.defer();sup.start=async()=>{await gate.promise;return rt;};
 const opening=d.api.createWindow();await drain();const hold=await d.api.acquire();gate.resolve();await opening;assert.equal(d.windows.length,1);assert.equal(d.api.currentMain(),d.main);await hold.release();
});
test('openSettings already awaiting stopped-runtime start cannot register a new window under a hold',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),sup=d.api.supervisor(),rt=d.runtime(),gate=f.defer();d.replaceRuntime(null);sup.start=async()=>{await gate.promise;d.replaceRuntime(rt);return rt;};
 const opening=d.api.openSettings();await drain();const hold=await d.api.acquire({allowDeferred:true});gate.resolve();await opening;assert.equal(d.windows.length,1);assert.equal(d.api.currentSettings(),null);await hold.release();
});
test('ordinary native Reload menu is suppressed only while the transition is held',async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]),item=d.menu.template.flatMap(x=>x.submenu||[]).find(x=>x.label==='Reload');assert.equal(typeof item?.click,'function');
 const hold=await d.api.acquire(),before=d.requests.length;item.click();await drain();assert.equal(d.requests.length,before);await hold.release();item.click();await drain();assert.equal(d.requests.filter(x=>x.kind==='loadURL').length,2);
});
test('second-instance restores and focuses an existing minimized main window without starting a runtime', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f]);
  let minimized = true, focused = 0;
  d.main.isMinimized = () => minimized;
  d.main.restore = () => { minimized = false; };
  d.main.focus = () => { focused++; };
  d.app.emit('second-instance');
  assert.equal(minimized, false);
  assert.equal(focused, 1);
  assert.equal(d.starts, 1);
  assert.equal(d.windows.length, 1);
});

for (const [platform, signal] of [['darwin', 'activate'], ['win32', 'second-instance']]) {
  for (const initial of ['hidden', 'minimized']) {
    test(`main visibility: ${signal} from ${initial} on ${platform} does not start another runtime`, async t => {
      const f = await fixture(t); await f.mount();
      const d = await desktop(t, [f], { platform });
      let visible = false, minimized = initial === 'minimized';
      const calls = [];
      d.main.isVisible = () => visible;
      d.main.isMinimized = () => minimized;
      d.main.show = () => { calls.push('show'); visible = true; };
      d.main.restore = () => { calls.push('restore'); minimized = false; visible = true; };
      d.main.focus = () => { calls.push('focus'); };
      // Electron's activate callback carries the OS's hasVisibleWindows bit.
      d.app.emit(signal, {}, false);
      assert.equal(visible, true);
      assert.equal(minimized, false);
      assert.deepEqual(calls, initial === 'hidden' ? ['show'] : ['restore', 'focus']);
      assert.equal(d.windows.length, 1);
      assert.equal(d.starts, 1);
    });
  }
}

for (const signal of ['activate', 'second-instance']) {
  test('unpainted main: ' + signal + ' does not reveal the white startup surface', async t => {
    const f = await fixture(t);
    const d = await desktop(t, [f], { deferMainFirstPaint: w => w.config.title === 'BeeZilla' });
    const calls = [];
    let visible = false;
    d.main.isVisible = () => visible;
    d.main.show = () => { visible = true; calls.push('show'); };
    d.main.focus = () => { calls.push('focus'); };
    assert.equal(d.main.config.show, false, 'ordinary startup waits for Electron first paint');

    // Observe the post-paint foreground request as a negative control even
    // if the pre-paint snapshot disagrees: the intended order is observable.
    d.app.emit(signal, {}, false);
    await drain();
    const beforePaint = [...calls];
    d.main.emit('ready-to-show');
    d.app.emit('second-instance');
    await drain();
    assert.deepEqual(beforePaint, [], 'never show/focus a not-yet-painted main window');
    assert.deepEqual(calls, ['show', 'focus']);
    assert.equal(d.starts, 1);
    assert.equal(d.windows.length, 1);
  });
}

test('main visibility: activate preserves another visible window without surfacing the hidden main', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g]);
  d.api.settingsWindowFor(new URL('/buzzy/settings', d.main.url).href); await drain();
  const calls = [];
  d.main.isVisible = () => false;
  d.main.show = () => { calls.push('show'); };
  d.main.focus = () => { calls.push('focus'); };
  d.app.emit('activate', {}, true);
  assert.deepEqual(calls, []);
  assert.equal(d.windows.length, 2);
  assert.equal(d.starts, 1);
});

test('second-instance reopens a closed main window without spawning another runtime', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); await g.mount();
  const d = await desktop(t, [f, g]), rt = d.runtime();
  await d.close();
  assert.equal(d.api.currentMain(), null);
  d.app.emit('second-instance'); await drain();
  assert.equal(d.windows.length, 2, 'a new main window replaces the closed one');
  assert.equal(d.api.currentMain(), d.windows[1]);
  assert.equal(d.runtime(), rt);
  assert.equal(d.starts, 1);
});

test('competing activate and second-instance callbacks share one pending main reopen', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); await g.mount();
  const d = await desktop(t, [f, g]), rt = d.runtime(), gate = f.defer();
  await d.close();
  let requests = 0;
  d.api.supervisor().start = async () => { requests++; await gate.promise; return rt; };
  d.app.emit('activate'); d.app.emit('second-instance'); d.app.emit('activate');
  assert.equal(d.windows.length, 1, 'only the closed window while reopen is pending');
  gate.resolve(); await drain();
  assert.equal(d.windows.length, 2, 'exactly one replacement main window');
  assert.equal(d.api.currentMain(), d.windows[1]);
  assert.equal(requests, 1);
});

test('pending main reopen cannot create a window after quit completes', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f]), rt = d.runtime(), gate = f.defer();
  await d.close();
  d.api.supervisor().start = async () => { await gate.promise; return rt; };
  d.app.emit('activate');
  await d.quit();
  assert.equal(d.didExit(), true);
  gate.resolve(); await drain();
  d.app.emit('second-instance'); await drain();
  assert.equal(d.windows.length, 1);
  assert.equal(d.api.currentMain(), null);
});

test('failed main reopen reports once and allows a later second-instance request to retry', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); await g.mount();
  const d = await desktop(t, [f, g]), gate = f.defer(), sup = d.api.supervisor();
  const realStart = sup.start.bind(sup);
  await d.close();
  sup.start = async () => { await gate.promise; throw Error('fixture: startup not ready'); };
  d.app.emit('second-instance'); d.app.emit('activate');
  gate.resolve(); await drain();
  assert.equal(d.api.currentMain(), null);
  assert.equal(d.didExit(), false);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /startup not ready/);
  sup.start = realStart;
  d.app.emit('second-instance'); await drain();
  assert.equal(d.api.currentMain(), d.windows[1]);
});

for(const replacement of ['frame','same-frame-document'])test('pending Save acknowledgement from retired '+replacement+' cannot retire the runtime',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]),gate=f.defer();let body=false;
 f.transport=async(req,next)=>{const r=await next();if(req.method==='POST')return {ok:true,status:200,json:async()=>{body=true;await gate.promise;return r.json();}};return r;};await p.draw();const quitting=d.quit();await drain();assert.equal(body,true);
 if(replacement==='frame')d.main.replaceFrame();else{const fresh=await fixture(t,clone(f.data().board));await fresh.mount();d.main.useDocument(fresh,{sameFrame:true});}
 gate.resolve();await quitting;assert.equal(d.didExit(),false);assert.equal(d.stops,0);assert.equal(f.posts().length,1);assert.equal(f.data().board.strokes.length,3,'accepted write is retained, not rolled back');
});
for(const url of ['https://untrusted.invalid/buzzy/sketch','http://127.0.0.1:7331/api/buzzy/assets/uploaded.html'])test('transition never evaluates fixed page script in an untrusted document '+url,async t=>{
 const f=await fixture(t);await f.mount();const d=await desktop(t,[f]);f.h.location.href=url;const before=d.main.scripts.length,hold=await d.api.acquire();assert.equal(d.main.scripts.length,before);await hold.release();assert.equal(d.main.scripts.length,before);
});
test('already hydrated replacement remains read-only throughout the post-acquire runtime stop interval',async t=>{
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);await p.draw();await p.save();
 const fresh=await fixture(t,clone(f.data().board));fresh.transport=req=>f.api(req.url,{method:req.method,...(req.body?{body:JSON.stringify(req.body)}:{})});const page=await fresh.mount();assert.equal(page.el('save').disabled,false);
 const sup=d.api.supervisor(),stop=sup.stop.bind(sup),entered=f.defer(),finish=f.defer();sup.stop=async()=>{entered.resolve();await finish.promise;return stop();};
 const quitting=d.quit();await entered.promise;d.main.useDocument(fresh);const wc=d.main.webContents;
 assert.equal(input(wc),true);assert.equal(input(wc,'before-input-event'),true);if(!input(wc))await page.draw();assert.doesNotMatch(page.el('savedFlag').textContent,/Unsaved/);
 finish.resolve();await quitting;assert.equal(d.didExit(),true);assert.equal(f.data().board.strokes.length,3);assert.equal(f.posts().length,1);
});

// Recovery from an exited runtime is reachable from the ordinary Settings menu.
// Interleave actual menu invocations while the replacement runtime is starting.
test('Settings menu coalesces concurrent opens and restores a minimized Settings window', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t), d = await desktop(t, [f, g]);
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  const oldRuntime = d.runtime(), gate = f.defer();
  d.replaceRuntime(null);
  let starts = 0;
  d.api.supervisor().start = async () => { starts++; await gate.promise; d.replaceRuntime(oldRuntime); return oldRuntime; };
  command.click(); command.click(); command.click();
  assert.equal(d.windows.length, 1, 'only the main window while starting');
  gate.resolve(); await drain();
  assert.equal(d.windows.length, 2, 'exactly one Settings window');
  assert.equal(starts, 1);
  const win = d.api.currentSettings();
  assert.equal(new URL(win.url).pathname, '/buzzy/settings');
  let minimized = true, focused = 0;
  win.isMinimized = () => minimized;
  win.restore = () => { minimized = false; };
  win.focus = () => { focused++; };
  command.click();
  assert.equal(minimized, false); assert.equal(focused, 1);
});

test('failed Settings recovery is reported once and can be retried', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t), d = await desktop(t, [f, g]);
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  const oldRuntime = d.runtime(), gate = f.defer();
  d.replaceRuntime(null);
  d.api.supervisor().start = async () => { await gate.promise; throw Error('fixture: recovery unavailable'); };
  command.click(); command.click();
  gate.resolve(); await drain();
  assert.equal(d.errors.length, 1); assert.match(d.errors[0].message, /recovery unavailable/);
  assert.equal(d.windows.length, 1); assert.equal(d.didExit(), false);
  d.api.supervisor().start = async () => { d.replaceRuntime(oldRuntime); return oldRuntime; };
  command.click(); await drain();
  assert.equal(d.windows.length, 2);
});

test('an in-flight Settings open cannot resurrect a window after quit', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f]);
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  const oldRuntime = d.runtime(), gate = f.defer();
  d.replaceRuntime(null);
  d.api.supervisor().start = async () => { await gate.promise; return oldRuntime; };
  command.click();
  // The window request is waiting, but the runtime has now recovered, so the
  // ordinary quit path can complete its save/stop barrier before we resume it.
  d.replaceRuntime(oldRuntime); await d.quit();
  assert.equal(d.didExit(), true);
  gate.resolve(); await drain();
  command.click(); await drain();
  assert.equal(d.windows.length, 1);
  assert.equal(d.api.currentSettings(), null);
});


test('first Settings page load failure after runtime recovery is visible, retriable, and can close and quit normally', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  let attempts = 0;
  const d = await desktop(t, [f, g], { beforeLoad: async url => {
    if (new URL(url).pathname === '/buzzy/settings' && ++attempts === 1) throw Error('fixture: ERR_CONNECTION_REFUSED');
  } });
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  d.replaceRuntime(null);
  command.click(); await drain();
  assert.equal(d.starts, 2, 'recovered the stopped runtime once');
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /open Settings.*try again/i);
  assert.equal(d.didExit(), false);
  assert.equal(d.windows.length, 2);
  const win = d.api.currentSettings();
  command.click(); await drain();
  assert.equal(attempts, 2);
  assert.equal(d.starts, 2);
  assert.equal(d.windows.length, 2, 'retry in the existing window');
  assert.equal(new URL(win.url).pathname, '/buzzy/settings');
  await d.close(win);
  assert.equal(win.destroyed, true);
  assert.equal(d.api.currentSettings(), null);
  assert.equal(d.stops, 0, 'closing Settings does not stop the shared runtime');
  await d.quit();
  assert.equal(d.didExit(), true);
  assert.equal(d.stops, 1);
});

test('ordinary close while the initial Settings page is loading suppresses its late failure', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  const gate = f.defer();
  const d = await desktop(t, [f, g], { beforeLoad: async url => {
    if (new URL(url).pathname === '/buzzy/settings') { await gate.promise; throw Error('fixture: ERR_ABORTED'); }
  } });
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  command.click(); await drain();
  const win = d.api.currentSettings();
  await d.close(win);
  assert.equal(win.destroyed, true);
  gate.resolve(); await drain();
  assert.equal(d.errors.length, 0);
  assert.equal(d.didExit(), false);
  await d.quit();
  assert.equal(d.didExit(), true);
});

test('successful runtime retarget suppresses failure from the superseded Settings page load', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  const gate = f.defer();
  let attempts = 0;
  const d = await desktop(t, [f, g], { beforeLoad: async url => {
    if (new URL(url).pathname === '/buzzy/settings' && ++attempts === 1) {
      await gate.promise;
      throw Error('fixture: superseded load');
    }
  } });
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  command.click(); await drain();
  const win = d.api.currentSettings(), replacement = { ...d.runtime(), port: 7441 };
  d.replaceRuntime(replacement); d.api.bind(replacement, true);
  await d.nextNavigation(win);
  assert.equal(new URL(win.url).port, String(replacement.port));
  gate.resolve(); await drain();
  assert.equal(d.errors.length, 0);
  command.click(); await drain();
  assert.equal(attempts, 2, 'successful replacement did not schedule another retry');
  await d.quit();
  assert.equal(d.didExit(), true);
});

test('runtime recovery UX: Reload refuses the dead endpoint and leaves the draft open', async t => {
  const f = await fixture(t), page = await f.mount(), d = await desktop(t, [f]);
  await page.draw();
  d.replaceRuntime(null);
  const oldRoute = d.main.url;
  const before = d.requests.filter(request => request.kind === 'loadURL').length;
  const reload = d.menu.template.flatMap(item => item.submenu || []).find(item => item.label === 'Reload');
  reload.click(); await drain();
  assert.equal(d.requests.filter(request => request.kind === 'loadURL').length, before, 'do not reload a dead server');
  assert.equal(d.main.url, oldRoute);
  assert.match(page.el('savedFlag').textContent, /Unsaved/);
  assert.equal(d.didExit(), false);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /open Settings.*reconnect/i);
});

test('runtime recovery UX: loaded Settings reconnects a same-port runtime without replacing unsaved Sketch', async t => {
  const f = await fixture(t), page = await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g]), oldRoute = d.main.url, old = d.runtime();
  d.api.settingsWindowFor(new URL('/buzzy/settings', oldRoute).href); await drain();
  const settings = d.api.currentSettings();
  await page.draw();
  const replacement = { ...old, token: 'synthetic_new_runtime_token'.padEnd(43, 'm') };
  const sup = d.api.supervisor();
  d.replaceRuntime(null);
  let starts = 0;
  sup.start = async () => { starts++; d.replaceRuntime(replacement); return replacement; };
  d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,').click();
  await drain();
  assert.equal(starts, 1, 'Opening already-visible Settings recovers the stopped runtime');
  assert.equal(d.runtime(), replacement);
  assert.equal(d.api.currentSettings(), settings);
  assert.equal(d.windows.length, 2);
  assert.equal(d.main.url, oldRoute);
  assert.equal(d.api.retargets().size, 0);
  assert.equal(d.errors.length, 0);
  await page.save();
  assert.equal(f.data().board.strokes.length, 3, 'the original in-memory draft can still be saved');
});

test('runtime recovery UX: changed-port Settings recovery does not navigate away from a draft it cannot save', async t => {
  const f = await fixture(t), page = await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g]), oldRoute = d.main.url;
  await page.draw();
  d.replaceRuntime(null);
  const settings = d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,');
  settings.click(); await drain(); await d.nextNavigation();
  assert.equal(d.main.url, oldRoute);
  assert.equal(d.api.retargets().size, 0);
  assert.match(page.el('savedFlag').textContent, /Unsaved|Could not save|Not saved/);
  assert.equal(page.el('save').disabled, false);
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /work.*open|window.*open/i);
  assert.equal(d.didExit(), false);
});

test('runtime recovery UX: clean changed-port replacement retargets the existing main route', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g]), original = d.runtime();
  d.replaceRuntime(null);
  d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,').click();
  await drain(); await d.nextNavigation();
  assert.notEqual(d.runtime().port, original.port);
  assert.equal(new URL(d.main.url).port, String(d.runtime().port));
  assert.match(d.main.url, /\/buzzy\/sketch\?job=job_board$/);
  assert.equal(new URL(d.api.currentSettings().url).port, String(d.runtime().port));
  assert.equal(d.errors.length, 0);
  assert.equal(d.didExit(), false);
});

test('runtime recovery UX: Settings does not assume ownership of an unrelated unbound replacement', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g]), original = d.runtime();
  const unrelated = { ...original, port: 7459, token: 'unrelated_fixture_runtime'.padEnd(43, 'q') };
  d.api.clearBinding();
  d.replaceRuntime(unrelated);
  d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,').click();
  await drain();
  assert.equal(d.windows.length, 1);
  assert.equal(d.api.retargets().size, 0);
  assert.equal(d.api.bindingState().present, false);
  assert.equal(d.runtime(), unrelated);
  assert.equal(d.stops, 0);
  assert.equal(d.didExit(), false);
  assert.match(d.errors[0].message, /not ready.*window/i);
});

for (const platform of ['darwin', 'win32']) {
  test(`keyboard Settings shows an existing hidden window on ${platform} without reloading its controls`, async t => {
    const f = await fixture(t); await f.mount();
    const g = await fixture(t);
    const d = await desktop(t, [f, g], { platform });
    const command = d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,');
    command.click(); await drain();
    const win = d.api.currentSettings();
    let visible = false;
    const calls = [];
    win.isVisible = () => visible;
    win.isMinimized = () => false;
    win.show = () => { calls.push('show'); visible = true; };
    win.focus = () => { calls.push('focus'); };
    const requests = d.requests.length;
    command.click(); await drain();
    assert.equal(visible, true, 'keyboard command must actually show the hidden Settings');
    assert.deepEqual(calls, ['show']);
    assert.equal(d.windows.length, 2);
    assert.equal(d.api.currentSettings(), win);
    assert.equal(d.requests.length, requests, 'keep the same Settings document and keyboard state');
    assert.equal(d.starts, 1);
    assert.equal(d.errors.length, 0);
  });
}

for (const changePort of [false, true]) {
  test(`resident navigation: guarded main close and reopen remembers the app route, port change=${changePort}`, async t => {
    const f = await fixture(t); await f.mount();
    const g = await fixture(t);
    const d = await desktop(t, [f, g], { bootProbeOnly: true }), oldRuntime = d.runtime();
    const target = new URL('/buzzy/library?view=work#pinned', d.main.url);
    assert.equal(d.main.webContents.windowOpenHandler({ url: target.href }).action, 'deny');
    await drain();
    assert.equal(d.main.url, target.href);
    await d.close();
    assert.equal(d.main.isDestroyed(), true);
    assert.equal(d.stops, 0);
    assert.equal(d.didExit(), false);
    if (changePort) d.replaceRuntime(null);
    d.app.emit(changePort ? 'second-instance' : 'activate', {}, false);
    await drain();
    assert.equal(d.windows.length, 2);
    const reopened = new URL(d.api.currentMain().url);
    assert.equal(reopened.port, String(d.runtime().port));
    assert.equal(reopened.port === target.port, !changePort);
    assert.equal(reopened.pathname + reopened.search + reopened.hash, '/buzzy/library?view=work#pinned');
    assert.equal(d.starts, changePort ? 2 : 1);
  });
}

test('resident navigation: a document outside the application allowlist is not remembered', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t);
  const d = await desktop(t, [f, g], { bootProbeOnly: true });
  f.h.location.href = new URL('/api/buzzy/assets/uploaded.html', d.main.url).href;
  await d.close();
  assert.equal(d.main.isDestroyed(), true);
  d.app.emit('activate', {}, false); await drain();
  assert.equal(new URL(d.api.currentMain().url).pathname, '/buzzy/talk');
  assert.equal(d.starts, 1);
});

test('last window close uses normal Quit on win32', async t => {
  const f = await fixture(t), page = await f.mount();
  const d = await desktop(t, [f], { platform: 'win32' });
  await page.draw();
  await d.close();
  assert.equal(d.main.isDestroyed(), true);
  assert.equal(f.data().board.strokes.length, 3);
  d.app.emit('window-all-closed'); await drain();
  assert.equal(d.didExit(), true);
  assert.equal(d.stops, 1);
  assert.equal(f.posts().length, 1);
  assert.equal(d.errors.length, 0);
});

test('a stalled Settings navigation gives one retry path and does not strand the existing window', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  const gate = f.defer();
  let attempts = 0;
  const d = await desktop(t, [f, g], {
    timerDelay: ms => ms === 30_000 ? 5 : ms,
    beforeLoad: async url => {
      if (new URL(url).pathname === '/buzzy/settings' && ++attempts === 1) {
        await gate.promise;
        throw Error('fixture: delayed initial navigation was superseded');
      }
    },
  });
  const command = d.menu.template.flatMap(x => x.submenu || []).find(x => x.accelerator === 'CmdOrCtrl+,');
  command.click(); command.click();
  const win = d.api.currentSettings();
  assert.ok(win);
  assert.equal(attempts, 1, 'do not duplicate an in-progress load');
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(d.errors.length, 1, 'a load that has not settled still gets one actionable notice');
    assert.match(d.errors[0].message, /taking longer.*open Settings.*try again/i);
    assert.equal(d.didExit(), false);
    command.click(); await drain();
    assert.equal(attempts, 2, 'a later shortcut retries without closing the window');
    assert.equal(d.api.currentSettings(), win);
    assert.equal(new URL(win.url).pathname, '/buzzy/settings');
  } finally {
    gate.resolve();
    await drain();
  }
  assert.equal(d.errors.length, 1, 'a late rejection from the first load does not add a warning');
  assert.equal(d.windows.length, 2);
  assert.equal(d.starts, 1);
});

for (const callback of ['second-instance', 'activate']) {
  test(`main-page retry: ${callback} retries a failed resident reopen in the same window`, async t => {
    const f = await fixture(t); await f.mount();
    const g = await fixture(t); g.h.location.href = 'about:blank';
    let reopened = false, attempts = 0;
    const d = await desktop(t, [f, g], { bootProbeOnly: true, beforeLoad: async () => {
      if (reopened && ++attempts === 1) throw Error('fixture: first reopened main page refused the connection');
    } });
    const target = d.main.url;
    await d.close(); reopened = true;
    d.app.emit('second-instance'); await drain();
    assert.equal(d.windows.length, 2);
    assert.equal(d.errors.length, 1);
    const win = d.api.currentMain();
    assert.equal(win.url, 'about:blank');
    assert.equal(win.isDestroyed(), false);
    d.app.emit(callback, {}, true); d.app.emit(callback, {}, true); await drain();
    assert.equal(attempts, 2, 'explicit activation must retry instead of only focusing the blank window');
    assert.match(d.errors[0].message, /open BeeZilla.*retry/i);
    assert.equal(d.errors.length, 1);
    assert.equal(d.windows.length, 2);
    assert.equal(d.api.currentMain(), win);
    assert.equal(win.url, target);
    assert.equal(d.starts, 1);
    assert.equal(d.didExit(), false);
  });
}

test('main-page retry: timed-out resident main can reload without stale follow-up', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  const gate = f.defer();
  let reopening = false, attempts = 0;
  const d = await desktop(t, [f, g], { bootProbeOnly: true, timerDelay: ms => ms === 30_000 ? 5 : ms, beforeLoad: async () => {
    if (reopening && ++attempts === 1) {
      await gate.promise;
      throw Error('fixture: timed-out first load settled late');
    }
  } });
  const target = d.main.url;
  await d.close(); reopening = true;
  d.app.emit('second-instance');
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(d.errors.length, 1);
    assert.equal(d.api.currentMain().url, 'about:blank');
    d.app.emit('second-instance'); await drain();
    assert.equal(attempts, 2);
    assert.equal(d.api.currentMain().url, target);
  } finally { gate.resolve(); await drain(); }
  assert.equal(d.errors.length, 1);
  assert.equal(d.windows.length, 2);
  assert.equal(d.starts, 1);
});

test('main-page retry: app activation leaves an already visible secondary window alone', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  const secondary = await fixture(t);
  let fail = false;
  const d = await desktop(t, [f, g, secondary], { bootProbeOnly: true, beforeLoad: async url => {
    if (fail && !url.includes('/buzzy/settings')) throw Error('fixture: page unavailable');
  } });
  await d.close(); fail = true;
  d.app.emit('second-instance'); await drain();
  d.api.settingsWindowFor(new URL('/buzzy/settings', f.h.location.href).href); await drain();
  const requests = d.requests.length;
  d.app.emit('activate', {}, true); await drain();
  assert.equal(d.requests.length, requests);
  assert.equal(d.api.currentMain().url, 'about:blank');
  assert.equal(d.errors.length, 1);
});

test('reopening a hidden main window after runtime exit restores an unsaved Sketch without a reload', async t => {
  const f = await fixture(t), page = await f.mount(), g = await fixture(t), d = await desktop(t, [f, g]);
  const original = d.runtime(), oldRoute = d.main.url;
  await page.draw();
  let visible = false, attempts = 0;
  d.main.isVisible = () => visible;
  d.main.show = () => { visible = true; };
  const replacement = { ...original, token: 'synthetic_reopen_recovery_token'.padEnd(43, 'r') };
  const gate = f.defer();
  d.replaceRuntime(null);
  d.api.supervisor().start = async () => {
    attempts++;
    await gate.promise;
    d.replaceRuntime(replacement);
    return replacement;
  };
  d.app.emit('activate', {}, false);
  assert.equal(visible, true, 'the native callback surfaces the original window immediately');
  d.app.emit('second-instance');
  const settings = d.menu.template.flatMap(item => item.submenu || []).find(item => item.accelerator === 'CmdOrCtrl+,');
  assert.equal(attempts, 1, 'opening the app requests a single replacement runtime');
  settings.click();
  gate.resolve();
  await drain();
  assert.equal(attempts, 1, 'the concurrent Settings action shares this recovery');
  assert.equal(d.runtime(), replacement);
  assert.equal(d.main.url, oldRoute);
  assert.equal(d.requests.filter(item => item.kind === 'loadURL' && item.url === oldRoute).length, 1);
  assert.equal(d.messages.filter(item => item.wc === d.main.webContents && item.channel === 'beezilla:runtime:changed').length, 0);
  assert.equal(d.errors.length, 0);
  await page.save();
  assert.equal(f.data().board.strokes.length, 3, 'the existing unsaved draft is still usable with the replacement');
});

test('second launch after runtime exit reconnects a clean main window on the replacement port', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f], { bootProbeOnly: true }), original = d.runtime();
  const target = new URL('/buzzy/library?view=work#pinned', d.main.url);
  assert.equal(d.main.webContents.windowOpenHandler({ url: target.href }).action, 'deny');
  await drain();
  d.replaceRuntime(null);
  d.app.emit('second-instance');
  await drain(); await d.nextNavigation();
  assert.ok(d.runtime(), 'a native second launch reconnects the stopped runtime');
  assert.notEqual(d.runtime().port, original.port);
  assert.equal(d.windows.length, 1);
  assert.equal(d.api.currentMain(), d.main);
  const reopened = new URL(d.main.url);
  assert.equal(reopened.port, String(d.runtime().port));
  assert.equal(reopened.pathname + reopened.search + reopened.hash, '/buzzy/library?view=work#pinned');
  assert.equal(d.errors.length, 0);
});

test('activation does not adopt an unrelated unbound runtime or discard a dirty Sketch on a changed port', async t => {
  const f = await fixture(t), page = await f.mount(), d = await desktop(t, [f]);
  const original = d.runtime(), oldRoute = d.main.url;
  await page.draw();
  d.api.clearBinding();
  d.replaceRuntime({ ...original, port: 7459, token: 'synthetic_other_unbound_token'.padEnd(43, 'q') });
  d.app.emit('activate', {}, true);
  await drain(); await d.nextNavigation();
  assert.equal(d.api.bindingState().present, false, 'unrelated custody is not accepted');
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0].message, /not ready.*window/i);
  assert.equal(d.starts, 1);
  d.replaceRuntime(null);
  d.app.emit('activate', {}, true);
  await drain(); await d.nextNavigation();
  assert.equal(d.starts, 2);
  assert.equal(d.api.bindingState().present, false);
  assert.equal(d.main.url, oldRoute);
  assert.equal(d.api.retargets().size, 0);
  assert.equal(d.stops, 0);
  assert.equal(page.el('save').disabled, false);
  assert.match(page.el('savedFlag').textContent, /Unsaved|Could not save|Not saved/);
  assert.equal(d.errors.length, 2);
  assert.match(d.errors[1].message, /kept your window open.*could not finish saving/i);
});

test('reopen after runtime exit waits for the previous launcher to drain and allows an explicit retry', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f]), sup = d.api.supervisor(), original = d.runtime();
  const start = sup.start.bind(sup);
  let draining = true, attempts = 0;
  sup.start = async () => {
    attempts++;
    if (draining) throw Error('The previous local runtime is still stopping. Wait before trying again.');
    return start();
  };
  d.replaceRuntime(null);
  d.app.emit('second-instance');
  d.app.emit('activate', {}, true);
  await drain();
  assert.equal(attempts, 1);
  assert.equal(d.runtime(), null);
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].title, 'BeeZilla could not reconnect');
  assert.match(d.errors[0].message, /still stopping.*wait/i);
  assert.equal(d.starts, 1, 'no replacement started while prior ownership remained');
  assert.equal(d.didExit(), false);
  draining = false;
  d.app.emit('second-instance');
  await drain(); await d.nextNavigation();
  assert.equal(attempts, 2);
  assert.ok(d.runtime());
  assert.notEqual(d.runtime().port, original.port);
  assert.equal(new URL(d.main.url).port, String(d.runtime().port));
  assert.equal(d.windows.length, 1);
  assert.equal(d.errors.length, 1);
});

test('main-page retry after runtime exit reconnects once and opens only the saved resident route', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t); g.h.location.href = 'about:blank';
  let retries = 0, reopened = false;
  const d = await desktop(t, [f, g], { bootProbeOnly: true, autoNavigate: true, beforeLoad: async () => {
    if (reopened && ++retries === 1) throw Error('fixture: first resident load failed');
  } });
  const original = d.runtime(), target = new URL('/buzzy/library?view=work#pinned', d.main.url);
  d.main.webContents.windowOpenHandler({ url: target.href });
  await drain();
  assert.equal(d.main.url, target.href);
  await d.close();
  reopened = true;
  d.app.emit('second-instance');
  await drain();
  const blank = d.api.currentMain();
  assert.equal(blank.url, 'about:blank');
  assert.equal(d.errors.length, 1);

  const sup = d.api.supervisor(), start = sup.start.bind(sup);
  const allowedToStart = f.defer();
  let starts = 0;
  sup.start = async () => { starts++; await allowedToStart.promise; return start(); };
  d.replaceRuntime(null);
  d.app.emit('activate', {}, true);
  d.app.emit('second-instance');
  assert.equal(starts, 1, 'the blank window retry and native launch share guarded runtime recovery');
  assert.equal(blank.url, 'about:blank', 'do not navigate until a replacement is ready');
  allowedToStart.resolve();
  await drain(); await d.nextNavigation(blank);
  assert.equal(d.api.currentMain(), blank, 'do not allocate a third window');
  assert.equal(d.windows.length, 2);
  assert.equal(d.didExit(), false);
  assert.notEqual(d.runtime().port, original.port);
  const next = new URL(blank.url);
  assert.equal(next.port, String(d.runtime().port));
  assert.equal(next.pathname + next.search + next.hash, target.pathname + target.search + target.hash);
  assert.equal(retries, 2, 'recovery must not also navigate the blank page to the generic fallback');
  assert.equal(d.messages.filter(item => item.wc === blank.webContents && item.channel === 'beezilla:runtime:changed').length, 0);
  assert.equal(d.errors.length, 1);
});

test('main-page retry after runtime exit leaves a late successful Sketch commit and its draft intact', async t => {
  const f = await fixture(t); await f.mount();
  const g = await fixture(t), page = await g.mount();
  g.h.location.href = 'about:blank';
  const firstResponse = f.defer(), entered = f.defer(), delayedRecovery = f.defer();
  let active = false, attempts = 0;
  const d = await desktop(t, [f, g], {
    bootProbeOnly: true, timerDelay: ms => ms === 30_000 ? 10 : ms,
    beforeLoad: async () => {
      if (active && ++attempts === 1) { entered.resolve(); await firstResponse.promise; }
    },
  });
  const old = d.runtime(), originalUrl = d.main.url;
  await d.close();
  active = true;
  d.app.emit('second-instance');
  await entered.promise;
  try {
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(d.errors.length, 1);
    const win = d.api.currentMain();
    assert.equal(win.url, 'about:blank');

    const replacement = { ...old, token: 'synthetic_page_retry_recovery'.padEnd(43, 'n') };
    let starts = 0;
    d.api.supervisor().start = async () => {
      starts++;
      await delayedRecovery.promise;
      d.replaceRuntime(replacement);
      return replacement;
    };
    d.replaceRuntime(null);
    d.app.emit('second-instance');
    assert.equal(starts, 1);
    firstResponse.resolve();
    await drain();
    assert.equal(win.url, originalUrl, 'response from original timed-out request commits before recovery');
    await page.draw();
    delayedRecovery.resolve();
    await drain(); await d.nextNavigation(win);
    assert.equal(attempts, 1, 'do not retry at all once the original document commits');
    assert.equal(d.api.currentMain(), win);
    assert.equal(win.url, originalUrl);
    assert.equal(d.errors.length, 1);
    await page.save();
    assert.equal(g.data().board.strokes.length, 3, 'the committed draft can save with the new binding');
  } finally {
    firstResponse.resolve();
    delayedRecovery.resolve();
    await drain();
  }
});

test('saved Sketch survives native close before its owned runtime retarget reaches the renderer', async t => {
  const f = await fixture(t), page = await f.mount();
  const d = await desktop(t, [f], { bootProbeOnly: true });
  const originalUrl = new URL(d.main.url);
  await page.draw(); await page.save();
  const saved = clone(f.data().board);
  assert.equal(saved.strokes.length, 3);
  assert.equal(f.posts().length, 1);

  // The actual preload holds a runtime-change navigation while a normal IPC
  // call is outstanding. Model its reply, not the renderer navigation decision.
  const gate = f.defer();
  d.ipc.set('beezilla:app:log', () => gate.promise);
  const pendingIPC = d.main.preloadBridge.app.log('Synthetic pending desktop callback');
  try {
    d.replaceRuntime(null);
    d.app.emit('second-instance');
    await drain();
    const current = d.runtime(), target = d.api.retargets().get(d.main.webContents);
    assert.ok(current && target);
    assert.equal(target.rt, current);
    assert.notEqual(String(current.port), originalUrl.port);
    assert.equal(d.main.url, originalUrl.href, 'old document remains while preload awaits IPC');
    assert.equal(d.main.preloadTimers.length, 0);
    assert.equal(d.errors.length, 0);

    await d.close();
    assert.equal(d.main.isDestroyed(), true);
    assert.equal(d.stops, 0);
    assert.equal(d.didExit(), false);
    d.app.emit('activate', {}, false); await drain();
    const reopened = d.api.currentMain(), url = new URL(reopened.url);
    assert.notEqual(reopened, d.main);
    assert.equal(url.port, String(current.port));
    assert.equal(url.pathname + url.search, originalUrl.pathname + originalUrl.search, 'return to the actually saved Sketch, not Talk');
    reopened.replaceFrame();
    const hydrated = await reopened.replacementReady; await drain();
    assert.match(hydrated.el('status').textContent, /Board loaded/);
    assert.deepEqual(f.reads().at(-1).response.board, saved, 'the fresh renderer retrieved the original saved data');
    assert.equal(f.posts().length, 1, 'reopening never writes a replacement board');
  } finally {
    gate.resolve();
    await pendingIPC;
  }
});

test('resident reopen never restores a stale pending target when the runtime binding was revoked', async t => {
  const f = await fixture(t); await f.mount();
  const d = await desktop(t, [f], { bootProbeOnly: true });
  d.replaceRuntime(null);
  d.app.emit('second-instance'); await drain();
  assert.ok(d.api.retargets().get(d.main.webContents));
  d.api.clearBinding();
  await d.close();
  assert.equal(d.main.isDestroyed(), true);
  d.app.emit('activate', {}, false); await drain();
  assert.equal(new URL(d.api.currentMain().url).pathname, '/buzzy/talk', 'revoked retarget must not choose the route');
  assert.equal(d.errors.length, 0);
});

test('native close first saves a cold Sketch and resident reopen uses its new job', async t => {
  const f = await fixture(t), page = await f.mount(null);
  const d = await desktop(t, [f], { bootProbeOnly: true });
  await page.draw();
  await d.close();
  const creates = f.requests.filter(request => request.url === '/api/buzzy/jobs');
  assert.equal(creates.length, 1);
  assert.equal(d.main.isDestroyed(), true);
  assert.equal(d.stops, 0);
  d.app.emit('activate', {}, false); await drain();
  const window = d.api.currentMain(), target = new URL(window.url);
  assert.equal(target.pathname, '/buzzy/sketch');
  assert.equal(target.searchParams.get('job'), creates[0].body.id);
  window.replaceFrame(); await window.replacementReady; await drain();
  assert.equal(f.reads().at(-1).response.board.strokes.length, 1);
  assert.equal(f.posts().length, 1);
});

async function openRoute(d, win, route) {
  const target = new URL(route, win.url);
  assert.equal(win.webContents.windowOpenHandler({ url: target.href }).action, 'deny');
  await drain();
  assert.equal(win.url, target.href);
}
const route = (url) => { const u = new URL(url); return u.pathname + u.search + u.hash; };

for (const signal of ['activate', 'second-instance']) {
  test('Library-only resident audit: ' + signal + ' restores linked folder after an owned retarget and completed close', async t => {
    const f = await fixture(t), g = await fixture(t);
    const d = await desktop(t, [f, g], { bootProbeOnly: true });
    const target = '/buzzy/library?job=library_fixture#saved-docs';
    await openRoute(d, d.main, target);
    const from = new URL(d.main.url).port, held = f.defer();
    d.ipc.set('beezilla:app:log', () => held.promise);
    const ipc = d.main.preloadBridge.app.log('isolated Library fixture');
    try {
      d.replaceRuntime(null);
      d.app.emit('second-instance');
      await drain();
      const current = d.runtime(), pending = d.api.retargets().get(d.main.webContents);
      assert.notEqual(String(current.port), from);
      assert.equal(route(pending.url), target);
      assert.equal(d.main.preloadTimers.length, 0);
      assert.equal(new URL(d.main.url).port, from);

      await d.close();
      assert.ok(d.main.isDestroyed());
      assert.equal(d.api.retargets().size, 0, 'old renderer destroyed');
      d.app.emit(signal, {}, false);
      await drain();
      const reopened = d.api.currentMain();
      assert.equal(route(reopened.url), target);
      assert.equal(new URL(reopened.url).port, String(current.port));
      assert.equal(d.starts, 2);
      assert.equal(d.stops, 0);
      assert.equal(d.errors.length, 0);
      assert.equal(f.posts().length + g.posts().length, 0, 'route restoration never writes a Sketch');
    } finally { held.resolve(); await ipc; }
  });
}

test('Library-only resident audit: a cancelled close records no new reopen route and a later successful close uses its own folder', async t => {
  const f = await fixture(t), g = await fixture(t), h = await fixture(t);
  const d = await desktop(t, [f, g, h], { bootProbeOnly: true });
  const prior = '/buzzy/library?job=first_library_folder', refused = '/buzzy/library?job=cancelled_library_folder', done = '/buzzy/library?job=final_library_folder';
  await openRoute(d, d.main, prior);
  await d.close();
  assert.equal(route(d.api.rememberedMainRoute().url), prior);
  d.app.emit('second-instance'); await drain();
  const resident = d.api.currentMain();
  assert.equal(route(resident.url), prior);

  await openRoute(d, resident, refused);
  resident.preventUnload = true;
  await d.close(resident);
  assert.equal(resident.isDestroyed(), false);
  assert.equal(resident.lastUnloadEvent.prevented, false, 'main never overrides the renderer/native unload refusal');
  assert.equal(d.api.held(), false);
  assert.equal(route(d.api.rememberedMainRoute().url), prior, 'only the closed event records the next route');
  d.app.emit('second-instance'); await drain();
  assert.equal(d.api.currentMain(), resident);
  assert.equal(route(resident.url), refused);

  await openRoute(d, resident, done);
  resident.preventUnload = false;
  await d.close(resident);
  d.app.emit('activate', {}, false); await drain();
  assert.equal(route(d.api.currentMain().url), done);
  assert.equal(d.windows.length, 3);
  assert.equal(d.starts, 1);
  assert.equal(d.stops, 0);
  assert.equal(d.errors.length, 0);
});
