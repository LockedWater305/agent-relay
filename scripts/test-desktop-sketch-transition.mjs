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
 const proc=new EventEmitter();proc.platform='darwin';proc.env={BZ_CHAT_KEY:'synthetic-fixture-only-no-provider',BZ_PROBE_PATH:new URL(fixtures[0].h.location.href).pathname+new URL(fixtures[0].h.location.href).search};
 const app=new EventEmitter();
 Object.assign(app,{isPackaged:true,getVersion:()=> 'synthetic-reconstruction',requestSingleInstanceLock:()=>true,
  commandLine:{appendSwitch(){}},whenReady:()=>({then(fn){ready=fn;return Promise.resolve();}}),
  exit(code){exitCode=code;},quit(){return quit();}});
 const scheduled=(fn,ms,...args)=>{const id=setTimeout(()=>{timers.delete(id);fn(...args);},ms);id.unref?.();timers.add(id);return id;};
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
    this.fixture.h.location.href=url;wc.mainFrame=frame(this);
    wc.emit('did-navigate',{},url,200,'OK');wc.emit('did-finish-load');return undefined;
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
  show(){} focus(){} isMinimized(){return false;} restore(){}
  close(){
   const closing=event();this.emit('close',closing);if(closing.prevented)return;
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
    currentMain:()=>mainWindow,currentSettings:()=>settingsWindow,
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
 const f=await fixture(t),p=await f.mount(),d=await desktop(t,[f]);d.main.preventUnload=true;await p.draw();await d.close();assert.equal(d.main.isDestroyed(),false);assert.equal(d.main.lastUnloadEvent.prevented,false,'no override of Electron unload prevention');assert.equal(d.api.held(),false);assert.equal(p.el('save').disabled,false);assert.equal(f.data().board.strokes.length,3);
 await p.draw();d.main.preventUnload=false;await d.close();assert.equal(d.main.isDestroyed(),true);assert.equal(f.data().board.strokes.length,4);
});
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
