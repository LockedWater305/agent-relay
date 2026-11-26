/**
 * Exercise the exact main module and its real Settings menu/onboarding paths.
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
const modes = ["runtime", "load", "onboarding", "closed", "success", "transition"];

async function runFixture(mode) {
  const trace = { dialogs: [], errors: [], logs: [], unhandled: [], windowOptions: [], URLs: [], exits: 0, quits: 0, starts: 0, focus: 0 };
  const onRejected = (e) => trace.unhandled.push(String(e?.message ?? e));
  process.on("unhandledRejection", onRejected);
  const base="http://127.0.0.1:7331";
  let menu, runtime;
  class Window extends EventEmitter {
    constructor(options) {
      super();this.options=options;trace.windowOptions.push(options.title);
      this.webContents=Object.assign(new EventEmitter(),{getURL:()=>this.url??"",isDestroyed:()=>this.destroyed===true,setWindowOpenHandler() {}});
    }
    isDestroyed() {return this.destroyed === true;}
    focus() {trace.focus++;}
    async loadURL(url) {
      trace.URLs.push(url);this.url=url;
      if (url===base+"/buzzy/settings" && ["load","onboarding","closed"].includes(mode)) {
        if (mode === "closed") { this.destroyed=true;this.emit("closed"); }
        throw new Error("ERR_FAILED synthetic settings document");
      }
    }
  }
  const app = Object.assign(new EventEmitter(),{
    isPackaged:true,getVersion:()=> "fixture",commandLine:{appendSwitch(){}},requestSingleInstanceLock:()=>true,
    // Don't execute startup, install hooks, or attach a real Electron session.
    whenReady:()=>new Promise(()=>{}),exit:()=>trace.exits++,quit:()=>trace.quits++
  });
  const noop=()=>{};
  const substitutes = {
    electron:{app,BrowserWindow:Window,Menu:{setApplicationMenu:v=>{menu=v},buildFromTemplate:x=>x},
      session:{},shell:{},dialog:{showErrorBox:(...a)=>trace.dialogs.push(a)},safeStorage:{},ipcMain:{},systemPreferences:{}},
    "node:fs":{existsSync:()=>false,mkdirSync:noop,readFileSync:noop,writeFileSync:noop},
    "node:path": await import("node:path"),
    "node:url":{fileURLToPath,pathToFileURL},
    "./supervisor.mjs":{RuntimeSupervisor:class {
      constructor(){ runtime=this;this.runtime=null; }
      async start(){trace.starts++;if(mode==="runtime")throw new Error("cannot start synthetic local runtime");
        return this.runtime={host:"127.0.0.1",port:7331,token:"synthetic-unused"};}
    }},
    "./paths.mjs":{ROOT:"mock-root",runtimeLib:noop},
    "./logger.mjs":{installLogging:noop,logLine:noop,logPaths:()=>({file:"fixture/main.log"})},
    "./connect.mjs":{connectAccount:noop,cloudBaseUrl:noop,managedAccountConnectCapability:()=>({enabled:false})},
    "./csp.mjs":{createDesktopCsp:noop,loadCspManifest:noop},
    "./library-vault.mjs":{createLibraryTransition:noop},
    "./document-transition.mjs":{createDocumentTransition:()=>({held:()=>mode==="transition",register:noop})},
    "./original-download.mjs":{createOriginalDownloadRefusal:()=>({clear:noop})},
    "./security.mjs":{allowAudioPermission:noop,connectBaseUrl:noop,createRuntimeAuth:()=>({bind:()=>base}),
      isAppDownload:noop,isAppPage:(url)=>url.startsWith(base+"/buzzy/"),isConnectNavigation:noop,isTrustedSender:noop,
      retargetAppPage:noop,safeExternalUrl:noop,sameOrigin:noop,webUrl:noop}
  };
  const context=vm.createContext({
    process:{env:{},on:noop,get platform(){return "linux";}},
    console:{log:(...a)=>trace.logs.push(a.join(" ")),error:(...a)=>trace.errors.push(a.join(" "))},
    // createWindow starts a 30-second fallback timer. The mocked load always
    // settles on its own; leave the unrelated timer inert in this fixture.
    setTimeout:noop, clearTimeout:noop
  });
  try {
    const subject=new vm.SourceTextModule(fs.readFileSync(source,"utf8")+"\nexport {installMenu,createWindow};",{
      context,identifier:source.href,initializeImportMeta(meta){meta.url=source.href}
    });
    await subject.link((name)=>{
      assert.ok(Object.hasOwn(substitutes,name),`unexpected dependency ${name}`);
      const values=substitutes[name];
      return new vm.SyntheticModule(Object.keys(values),function(){
        for (const [k,v] of Object.entries(values)) this.setExport(k,v);
      },{context});
    });
    await subject.evaluate();
    assert.ok(runtime);
    if (mode === "onboarding") {
      await subject.namespace.createWindow();
    } else {
      subject.namespace.installMenu();
      const click=menu[0].submenu.find(item=>item.label==="Settings…").click;
      click();
      if(mode==="success") {await new Promise(setImmediate);click();}
    }
    await new Promise(setImmediate);await new Promise(setImmediate);
    return trace;
  } finally {process.off("unhandledRejection",onRejected);}
}

if (process.argv[2]==="--fixture") {
  console.log(JSON.stringify(await runFixture(process.argv[3])));
} else {
  for (const mode of modes) {
    test(`Settings launch: ${mode}`, ()=>{
      const child=spawnSync(process.execPath,["--experimental-vm-modules",fileURLToPath(import.meta.url),"--fixture",mode],
        {encoding:"utf8",timeout:10000});
      assert.equal(child.status,0,child.stdout+child.stderr);
      const info=JSON.parse(child.stdout);
      if (["runtime","load","onboarding"].includes(mode)) {
        assert.equal(info.dialogs.length,1,JSON.stringify(info));
        assert.match(info.dialogs[0][0],/could not open Settings/i);
        assert.match(info.dialogs[0][1],mode==="runtime"?/cannot start synthetic local runtime/:/ERR_FAILED synthetic settings document/);
        assert.match(info.dialogs[0][1],/fixture\/main.log/);
        assert.equal(info.errors.length,1,JSON.stringify(info));
        assert.ok(!info.logs.some(line=>line.includes("settings window opened")));
      } else {
        assert.deepEqual(info.dialogs,[]);
        assert.deepEqual(info.errors,[]);
      }
      assert.deepEqual(info.unhandled,[]);
      assert.equal(info.exits,0);assert.equal(info.quits,0);
      if (mode==="success") {
        assert.deepEqual(info.windowOptions,["BeeZilla — Settings"]);
        assert.deepEqual(info.URLs,["http://127.0.0.1:7331/buzzy/settings"]);
        assert.equal(info.starts,1);assert.equal(info.focus,1);
      } else if(mode==="transition") {
        assert.equal(info.starts,0);assert.deepEqual(info.windowOptions,[]);assert.deepEqual(info.URLs,[]);
      }
    });
  }
}
