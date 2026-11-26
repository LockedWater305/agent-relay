/** Exact main/Settings logic with inert substitutes; never opens a real folder or app. */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {EventEmitter} from "node:events";
import {readFileSync} from "node:fs";
import {fileURLToPath, pathToFileURL} from "node:url";
import test from "node:test";
import vm from "node:vm";

const mainUrl=new URL("../desktop/main.mjs",import.meta.url);
const settingsUrl=new URL("../public/buzzy/settings.html",import.meta.url);
async function fixture(mode) {
  const trace={opened:[], dialogs:[], ipc:null, unhandled:[], statuses:[], quit:0};
  const observers=(error)=>trace.unhandled.push(String(error?.message??error));
  process.on("unhandledRejection",observers);
  let menu;
  const noop=()=>{};
  const app=Object.assign(new EventEmitter(),{isPackaged:true,getVersion:()=> "fixture",
    commandLine:{appendSwitch:noop},requestSingleInstanceLock:()=>true,whenReady:()=>new Promise(()=>{}),
    quit:()=>trace.quit++,exit:()=>trace.quit++});
  const ipc=new Map(),dir="fixture/logs";
  const mods={
    electron:{app,BrowserWindow:class{},Menu:{buildFromTemplate:x=>x,setApplicationMenu:x=>{menu=x;}},
      session:{},shell:{openPath:async (p)=>{trace.opened.push(p);return mode==="os-refused"?"OS could not open the folder":"";}},
      dialog:{showErrorBox:(...args)=>trace.dialogs.push(args)},safeStorage:{},ipcMain:{handle:(name,fn)=>ipc.set(name,fn)},systemPreferences:{}},
    "node:fs":{existsSync:noop,mkdirSync:noop,readFileSync:noop,writeFileSync:noop},
    "node:path":await import("node:path"),
    "node:url":{fileURLToPath,pathToFileURL},
    "./supervisor.mjs":{RuntimeSupervisor:class{}},
    "./paths.mjs":{ROOT:"fixture",runtimeLib:noop},
    "./logger.mjs":{installLogging:noop,logLine:noop,logPaths:()=>mode==="no-folder"?{}:{dir,file:dir+"/main.log"}},
    "./connect.mjs":{connectAccount:noop,cloudBaseUrl:noop,managedAccountConnectCapability:()=>({enabled:false})},
    "./csp.mjs":{createDesktopCsp:noop,loadCspManifest:noop},
    "./library-vault.mjs":{createLibraryTransition:noop},
    "./document-transition.mjs":{createDocumentTransition:noop},
    "./original-download.mjs":{createOriginalDownloadRefusal:noop},
    "./security.mjs":{allowAudioPermission:noop,connectBaseUrl:noop,createRuntimeAuth:noop,isAppDownload:noop,
      isAppPage:noop,isConnectNavigation:noop,isTrustedSender:(ev)=>ev?.trusted===true,
      retargetAppPage:noop,safeExternalUrl:noop,sameOrigin:noop,webUrl:noop},
    "./settings.mjs":{createSettingsHandlers:()=>({})},
  };
  const ctx=vm.createContext({process:{env:{},on:noop},console:{log:noop,error:noop}});
  const loader=(name)=>{
    assert.ok(Object.hasOwn(mods,name),name);
    const values=mods[name];
    return new vm.SyntheticModule(Object.keys(values),function(){
      for(const [key,value] of Object.entries(values)) this.setExport(key,value);
    },{context:ctx});
  };
  try {
    const subject=new vm.SourceTextModule(readFileSync(mainUrl,"utf8")+"\nexport {registerSettingsIpc, installMenu};",{
      context:ctx,identifier:mainUrl.href,
      importModuleDynamically:async (name)=>{const m=loader(name);await m.link(loader);await m.evaluate();return m;}
    });
    await subject.link(loader);await subject.evaluate();await subject.namespace.registerSettingsIpc();
    subject.namespace.installMenu();
    const fn=ipc.get("beezilla:app:openLogs");
    if(mode==="untrusted") {trace.ipc=await fn({trusted:false});return trace;}
    const title=menu[0].submenu.find(x=>x.label==="Open Logs Folder");
    title.click();
    const html=readFileSync(settingsUrl,"utf8");
    const diagnostic=html.split("      // Diagnostics — desktop only.")[1]?.split("      // ── microphone diagnostics")[0];
    assert.ok(diagnostic,"settings logs block must be present");
    let click;
    const elements={
      "open-logs":{addEventListener:(_k,fn)=>{click=fn;}},
      "logs-path":{}, "logs-status":{}, diagnostics:{hidden:true}
    };
    vm.runInNewContext(diagnostic.substring(diagnostic.indexOf("\n")),{
      window:{beezilla:{app:{logs:async()=>({ok:true,data:{file:dir+"/main.log"}}),
        openLogs:async()=>{
          if(mode==="bridge-rejected") throw new Error("IPC unavailable");
          return trace.ipc=await fn({trusted:true});
        }}}},
      $:(id)=>elements[id],
      say:(_,text,kind)=>trace.statuses.push([text,kind])
    });
    await Promise.resolve(click()).catch((error)=>trace.unhandled.push(error.message));
    await new Promise(setImmediate);
    return trace;
  } finally {process.off("unhandledRejection",observers);}
}
if(process.argv[2]==="--fixture") {
  console.log(JSON.stringify(await fixture(process.argv[3])));
} else {
  for(const mode of ["opened","os-refused","no-folder","bridge-rejected","untrusted"]) {
    test(`Settings logs diagnostics: ${mode}`,()=>{
      const p=spawnSync(process.execPath,["--experimental-vm-modules",fileURLToPath(import.meta.url),"--fixture",mode],
        {encoding:"utf8",timeout:10000});
      assert.equal(p.status,0,p.stdout+p.stderr);
      const got=JSON.parse(p.stdout);
      assert.deepEqual(got.unhandled,[]);assert.equal(got.quit,0);
      if(mode==="opened") {
        assert.equal(got.ipc.ok,true);assert.deepEqual(got.opened,["fixture/logs","fixture/logs"]);
        assert.deepEqual(got.statuses,[["Opened.","ok"]]);assert.deepEqual(got.dialogs,[]);
      } else if(mode==="untrusted") {
        assert.equal(got.ipc.ok,false);assert.deepEqual(got.opened,[]);
      } else if(mode==="bridge-rejected") {
        assert.match(got.statuses[0][0],/could not open/i);assert.equal(got.statuses[0][1],"err");
      } else {
        assert.equal(got.ipc.ok,false,JSON.stringify(got));
        assert.equal(got.statuses[0][1],"err");assert.equal(got.dialogs.length,1);
        if(mode==="no-folder") assert.deepEqual(got.opened,[]);
        else assert.match(got.statuses[0][0],/OS could not open/);
      }
    });
  }
}
