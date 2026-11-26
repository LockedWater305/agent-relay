/**
 * Exercise the exact main module and its real initial/repeated window launch.
 * Electron, runtime and policy dependencies are inert VM substitutes. No app,
 * renderer, service, browser, filesystem other than this source, or install runs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const source = new URL("../desktop/main.mjs", import.meta.url);
const modes = ["cold-timeout", "reactivate-failure", "success"];

async function runFixture(mode) {
  const trace = { dialogs: [], errors: [], logs: [], unhandled: [], windowOptions: [], URLs: [], exits: 0, quits: 0, starts: 0, uncleared: 0 };
  const onRejected = (e) => trace.unhandled.push(String(e?.message ?? e));
  process.on("unhandledRejection", onRejected);
  const base="http://127.0.0.1:7331";
  let ready, runtime;
  const windows = [], activeTimers = new Set();
  class Window extends EventEmitter {
    constructor(options) {
      super();this.options=options;trace.windowOptions.push(options.title);windows.push(this);
      this.webContents=Object.assign(new EventEmitter(),{getURL:()=>this.url??"",isDestroyed:()=>this.destroyed===true,setWindowOpenHandler() {}});
    }
    isDestroyed() {return this.destroyed === true;}
    destroy() {this.destroyed=true;this.emit("closed");}
    static getAllWindows() {return windows.filter(w=>!w.isDestroyed());}
    async loadURL(url) {
      trace.URLs.push(url);this.url=url;
      if (url === base + "/buzzy/talk" && mode === "cold-timeout") return new Promise(()=>{});
    }
  }
  const app = Object.assign(new EventEmitter(),{
    isPackaged:true,getVersion:()=> "fixture",commandLine:{appendSwitch(){}},requestSingleInstanceLock:()=>true,
    // Don't execute startup, install hooks, or attach a real Electron session.
    whenReady:()=>({then:(fn)=>{ready=fn;}}),exit:()=>trace.exits++,quit:()=>trace.quits++
  });
  const noop=()=>{};
  const defaultSession={setPermissionRequestHandler:noop,setDevicePermissionHandler:noop,
    setPermissionCheckHandler:noop,webRequest:{onBeforeSendHeaders:noop,onHeadersReceived:noop,onCompleted:noop,onErrorOccurred:noop}};
  const substitutes = {
    electron:{app,BrowserWindow:Window,Menu:{setApplicationMenu:noop,buildFromTemplate:x=>x},
      session:{defaultSession},shell:{},dialog:{showErrorBox:(...a)=>trace.dialogs.push(a)},safeStorage:{},ipcMain:{handle:noop},systemPreferences:{}},
    "node:fs":{existsSync:()=>false,mkdirSync:noop,readFileSync:noop,writeFileSync:noop},
    "node:path": await import("node:path"),
    "node:url":{fileURLToPath,pathToFileURL},
    "./supervisor.mjs":{RuntimeSupervisor:class {
      constructor(){ runtime=this;this.runtime=null;this.dataDir="fixture/data"; }
      async start(){trace.starts++;if(mode==="reactivate-failure" && trace.starts > 1)throw new Error("cannot restart synthetic local runtime");
        return this.runtime={host:"127.0.0.1",port:7331,token:"synthetic-unused"};}
    }},
    "./paths.mjs":{ROOT:"mock-root",runtimeLib:()=>({loadInference:()=>null,loadMusicKey:()=>null})},
    "./logger.mjs":{installLogging:noop,logLine:noop,logPaths:()=>({file:"fixture/main.log"})},
    "./connect.mjs":{connectAccount:noop,cloudBaseUrl:noop,managedAccountConnectCapability:()=>({enabled:false})},
    "./csp.mjs":{createDesktopCsp:noop,loadCspManifest:noop},
    "./library-vault.mjs":{createLibraryTransition:noop},
    "./document-transition.mjs":{createDocumentTransition:()=>({held:()=>mode==="transition",register:noop})},
    "./original-download.mjs":{createOriginalDownloadRefusal:()=>({clear:noop})},
    "./security.mjs":{allowAudioPermission:noop,connectBaseUrl:noop,createRuntimeAuth:()=>({bind:()=>base}),
      isAppDownload:noop,isAppPage:(url)=>url.startsWith(base+"/buzzy/"),isConnectNavigation:noop,isTrustedSender:noop,
      retargetAppPage:noop,safeExternalUrl:noop,sameOrigin:noop,webUrl:noop},
    "./settings.mjs":{createSettingsHandlers:()=>({})},
  };
  const context=vm.createContext({
    process:{env:mode==="cold-timeout"?{}:{BZ_CHAT_KEY:"fixture"},on:noop,platform:"linux"},
    console:{log:(...a)=>trace.logs.push(a.join(" ")),error:(...a)=>trace.errors.push(a.join(" ")),warn:noop},
    setTimeout(fn, ms) {
      const handle={ms};
      if(ms===30_000) {
        activeTimers.add(handle);
        if (mode==="cold-timeout") queueMicrotask(()=>{if(activeTimers.delete(handle))fn();});
      }
      return handle;
    },
    clearTimeout(handle){activeTimers.delete(handle);}
  });
  const loader=(name)=>{
    assert.ok(Object.hasOwn(substitutes,name),`unexpected dependency ${name}`);
    const values=substitutes[name];
    return new vm.SyntheticModule(Object.keys(values),function(){
      for (const [k,v] of Object.entries(values)) this.setExport(k,v);
    },{context});
  };
  try {
    const subject=new vm.SourceTextModule(fs.readFileSync(source,"utf8"),{
      context,identifier:source.href,initializeImportMeta(meta){meta.url=source.href},
      importModuleDynamically:async name=>{const m=loader(name);await m.link(loader);await m.evaluate();return m;}
    });
    await subject.link(loader);
    await subject.evaluate();
    assert.ok(runtime); assert.equal(typeof ready,"function");
    await ready();
    if (mode==="reactivate-failure") {
      assert.deepEqual(trace.dialogs,[]);
      for (const win of windows) if (!win.isDestroyed()) win.destroy();
      app.emit("activate");
    }
    await new Promise(setImmediate);await new Promise(setImmediate);
    trace.uncleared=activeTimers.size;
    return trace;
  } finally {process.off("unhandledRejection",onRejected);}
}

if (process.argv[2]==="--fixture") {
  console.log(JSON.stringify(await runFixture(process.argv[3])));
} else {
  for (const mode of modes) {
    test(`main window: ${mode}`, ()=>{
      const child=spawnSync(process.execPath,["--experimental-vm-modules",fileURLToPath(import.meta.url),"--fixture",mode],
        {encoding:"utf8",timeout:10000});
      assert.equal(child.status,0,child.stdout+child.stderr);
      const info=JSON.parse(child.stdout);
      if (mode==="cold-timeout") {
        assert.equal(info.dialogs.length,1,JSON.stringify(info));
        assert.match(info.dialogs[0][0],/could not start/i);
        assert.match(info.dialogs[0][1],/did not finish loading|timed out/i);
        assert.ok(!info.URLs.some(url=>url.endsWith("/buzzy/settings")),"do not run onboarding on failed primary window");
        assert.equal(info.quits,1,"startup uses its existing graceful quit path");
      } else if(mode==="reactivate-failure") {
        assert.equal(info.dialogs.length,1,JSON.stringify(info));
        assert.match(info.dialogs[0][0],/could not reopen/i);
        assert.match(info.dialogs[0][1],/cannot restart synthetic local runtime/);
        assert.equal(info.quits,0,"reactivation error must leave the app open");
      } else {
        assert.deepEqual(info.dialogs,[]);
        assert.deepEqual(info.errors,[]);
        assert.deepEqual(info.URLs,["http://127.0.0.1:7331/buzzy/talk"]);
        assert.equal(info.quits,0);
      }
      if (mode!=="reactivate-failure") assert.equal(info.uncleared,0,"the launch deadline does not linger once the load settles");
      assert.deepEqual(info.unhandled,[]);
      assert.equal(info.exits,0,"no forced exit");
    });
  }
}
