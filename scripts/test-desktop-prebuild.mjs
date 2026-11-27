/**
 * Offline desktop prebuild contract. The Node entry and recipe hooks are real;
 * a fake locked Vite exits as soon as control reaches it. No bundle is built.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { CSP_PAGE_NAMES } from "../desktop/csp.mjs";

const desktopBuild = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")).build;
const fixtureVersion = "2.3.4-preview.1"; // Intentionally different from the runtime version.
const installerPath = `dist-desktop/BeeZilla-Setup-${fixtureVersion}.exe`;

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(),"bee-desktop-prebuild-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const out = (path, text) => {const dest=join(dir,path); mkdirSync(dirname(dest),{recursive:true}); writeFileSync(dest,text)};
  for (const f of ["desktop/dist.mjs", "desktop/stage-inputs.mjs", "desktop/stage-receipt.mjs", "desktop/csp.mjs", "desktop/security.mjs", "scripts/build-desktop-csp.mjs", "scripts/sync-private.mjs", "scripts/assert-no-private-modules.mjs"]) {
    mkdirSync(dirname(join(dir,f)),{recursive:true}); cpSync(new URL("../"+f,import.meta.url),join(dir,f));
  }
  out("private.lock.json",JSON.stringify({repo:"test/invalid",commit:"unused"}));
  out(".private-stub/registry.ts","export const test = true");
  out("desktop/stage/old-marker","an old stage");
  const meta={name:"vite",version:"1.0.0",bin:{vite:"bin/vite.js"}};
  out("package-lock.json",JSON.stringify({packages:{"node_modules/vite":{...meta,integrity:"fixture"}}}));
  out("node_modules/vite/package.json",JSON.stringify(meta));
  out("node_modules/vite/bin/vite.js",'require("node:fs").writeFileSync("vite-ran","1");process.exit(82);');
  return {dir,out};
}
function invoke(dir,requirePrivate=false,mode="stage") {
  const r=spawnSync(process.execPath,[join(dir,"desktop/dist.mjs"),mode],{
    cwd:dir,encoding:"utf8",timeout:15000,
    env:{PATH:join(dir,"no-executables"),...(process.env.SYSTEMROOT ? {SYSTEMROOT:process.env.SYSTEMROOT} : {}),BZ_REQUIRE_PRIVATE:requirePrivate?"1":"0"}
  });
  assert.ifError(r.error);return r;
}
test("clean public desktop stage syncs stubs and runs private guard before reaching Vite",t=>{
  const {dir}=setup(t);const r=invoke(dir);
  assert.match(r.stdout,/STUB BUILD/);assert.match(r.stdout,/\[guard\] ok/);
  assert.equal(JSON.parse(readFileSync(join(dir,"src/lib/private/.manifest.json"))).mode,"stub");
  assert.ok(existsSync(join(dir,"vite-ran")));assert.ok(!existsSync(join(dir,"desktop/stage/old-marker")));
});
test("missing required private input refuses before Vite and preserves existing stage",t=>{
  const {dir}=setup(t);const r=invoke(dir,true);
  assert.notEqual(r.status,0);assert.match(r.stderr,/refusing to build from stubs/);
  assert.ok(!existsSync(join(dir,"vite-ran")));assert.ok(existsSync(join(dir,"desktop/stage/old-marker")));
});
test("public-tree leak guard refuses before Vite and preserves existing stage",t=>{
  const {dir,out}=setup(t);
  out("src/unrelated/routes.ts","// fixture file; production guard rejects its reserved basename");
  const r=invoke(dir);
  assert.notEqual(r.status,0);assert.match(r.stderr,/src\/unrelated\/routes\.ts/);
  assert.ok(!existsSync(join(dir,"vite-ran")));assert.ok(existsSync(join(dir,"desktop/stage/old-marker")));
});

test("pack:dir identifies a local test build without claiming pin or signature state",t=>{
  const {dir,out}=setup(t);
  const meta={name:"electron-builder",version:"1.0.0",bin:{"electron-builder":"cli.js"}};
  out("desktop/package-lock.json",JSON.stringify({packages:{"node_modules/electron-builder":{...meta,integrity:"fixture"}}}));
  out("desktop/node_modules/electron-builder/package.json",JSON.stringify(meta));
  out("desktop/node_modules/electron-builder/cli.js",'throw new Error("the fixture never runs a packager");');
  out("publishers.json",'{"publishers":[{"keyId":"fixture-key"}]}');
  const r=invoke(dir,false,"dir");
  assert.match(r.stdout,/LOCAL TEST BUILD.*unpacked.*no installer.*no publish/i);
  assert.doesNotMatch(r.stdout,/unsigned|no publisher pins/i);
  assert.ok(existsSync(join(dir,"vite-ran")));
});

function outputFixture(t,entry) {
  const ctx=setup(t), {out}=ctx;
  out("package.json",'{"version":"0.0.1"}');
  out("desktop/package.json",JSON.stringify({version:fixtureVersion,build:{...desktopBuild,files:["main.mjs"]}}));
  out("desktop/main.mjs","// shaped shell fixture");
  out("migrations/001.sql","-- shaped migration fixture");
  for (const path of [
    "bin/beezilla.mjs", "scripts/beezilla-local.mjs", "scripts/migrate.mjs",
    "scripts/lib/parent-watchdog.cjs", "scripts/lib/inference.mjs",
    "scripts/lib/search-keys.mjs", "scripts/lib/music-keys.mjs",
  ]) out(path,"// shaped runtime script fixture");
  const html='<body><script src="/buzzy/chat.js"></script><script src="/buzzy/companies.js"></script><script>0</script></body>';
  for (const page of CSP_PAGE_NAMES) out(`public/buzzy/${page}.html`,html);
  out("public/buzzy/chat.js","// inert fixture");
  out("public/buzzy/companies.js","// inert fixture");
  out("public/buzzy/nav.js",`  function runScripts(root) { return Promise.resolve(); }
  // Chrome-owned nodes must not ride in with the page.
  `);
  // Simulate a Vite command claiming success with setup-only output. Real CSP
  // generation, runtime script staging, and manifest writing still run.
  out("node_modules/vite/bin/vite.js",`
    const fs=require("node:fs");
    if(process.argv[2]!=="build")process.exit(90);
    fs.cpSync("public",".output/public",{recursive:true});
    fs.mkdirSync(".output/server/_libs",{recursive:true});
    for(const name of ["pglite.data","pglite.wasm","initdb.wasm"]) fs.writeFileSync(".output/server/_libs/"+name,"fixture loader payload");
    const entry=${JSON.stringify(entry)};
    if(entry==="directory")fs.mkdirSync(".output/server/index.mjs");
    if(entry==="empty")fs.writeFileSync(".output/server/index.mjs","");
    if(entry==="valid")fs.writeFileSync(".output/server/index.mjs","export const fixture = 1;");
  `);
  return ctx;
}
for (const entry of ["missing","directory","empty"]) {
  test(`incomplete generated server entry (${entry}) cannot write a successful stage receipt`,t=>{
    const {dir}=outputFixture(t,entry);
    const r=invoke(dir);
    assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stderr,/nonempty regular .output\/server\/index\.mjs/i);
    assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
  });
}
test("a nonempty regular server entry retains the stage receipt without Git",t=>{
  const {dir}=outputFixture(t,"valid");
  const r=invoke(dir);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const manifest=JSON.parse(readFileSync(join(dir,"desktop/stage/MANIFEST.json"),"utf8"));
  assert.match(manifest.stagedRuntime.sha256,/^[0-9a-f]{64}$/);
  assert.equal(manifest.source.state,"unavailable");
  assert.equal(readFileSync(join(dir,"desktop/stage/app/.output/server/index.mjs"),"utf8"),"export const fixture = 1;");
});

function acceptedStageFixture(t) {
  const ctx = outputFixture(t, "valid"), {dir,out}=ctx;
  out("package.json",'{"version":"0.0.1","dependencies":{"entry":"1.0.0"}}');
  out("node_modules/entry/package.json",'{"name":"entry","version":"1.0.0"}');
  const first = invoke(dir);
  assert.equal(first.status,0,first.stdout+first.stderr);
  const stage=join(dir,"desktop/stage"), app=join(stage,"app");
  const marker=join(app,".output/server/index.mjs");
  const receipt=join(stage,"MANIFEST.json");
  const prior=readFileSync(marker,"utf8");
  assert.match(JSON.parse(readFileSync(receipt,"utf8")).stagedRuntime.sha256,/^[0-9a-f]{64}$/);
  return {...ctx,stage,app,marker,receipt,prior};
}
test("a failed second stage leaves old bytes but the actual afterPack refuses their old receipt",async t=>{
  const {dir,app,marker,receipt,prior}=acceptedStageFixture(t);
  const attempted = invoke(dir,true);
  assert.notEqual(attempted.status,0,attempted.stdout+attempted.stderr);
  assert.match(attempted.stderr,/refusing to build from stubs/);
  assert.equal(readFileSync(marker,"utf8"),prior);
  const hook=join(dir,"desktop/after-pack.cjs");
  cpSync(new URL("../desktop/after-pack.cjs",import.meta.url),hook);
  const unpacked=join(dir,"synthetic output");
  cpSync(app,join(unpacked,"resources/app"),{recursive:true,filter:p=>basename(p)!=="node_modules"});
  const localRequire=createRequire(import.meta.url);
  await assert.rejects(localRequire(hook).default({appOutDir:unpacked,electronPlatformName:"win32"}),/no readable stage receipt/i);
  assert.equal(existsSync(receipt),false);
  assert.equal(existsSync(join(unpacked,"resources/app/node_modules")),false);
  const retry=invoke(dir);
  assert.equal(retry.status,0,retry.stdout+retry.stderr);
  assert.match(JSON.parse(readFileSync(receipt,"utf8")).stagedRuntime.sha256,/^[0-9a-f]{64}$/);
  await localRequire(hook).default({appOutDir:unpacked,electronPlatformName:"win32"});
});
test("a failed Vite pin check invalidates the prior stage receipt without deleting its bytes",t=>{
  const {dir,out,marker,receipt,prior}=acceptedStageFixture(t);
  out("node_modules/vite/package.json",'{"name":"vite","version":"0.0.0","bin":{"vite":"bin/vite.js"}}');
  const second=invoke(dir);
  assert.notEqual(second.status,0,second.stdout+second.stderr);
  assert.match(second.stderr,/does not match locked/);
  assert.equal(readFileSync(marker,"utf8"),prior);
  assert.equal(existsSync(receipt),false);
});
test("a failed builder preflight for pack:dir invalidates the old stage receipt too",t=>{
  const {dir,marker,receipt,prior}=acceptedStageFixture(t);
  const second=invoke(dir,false,"dir");
  assert.notEqual(second.status,0,second.stdout+second.stderr);
  assert.match(second.stderr,/desktop[\\/]package-lock\.json/);
  assert.equal(readFileSync(marker,"utf8"),prior);
  assert.equal(existsSync(receipt),false);
});

for (const [mode, output] of [["dir", "normal"], ["all", "normal"], ["dir", "mutated"], ["dir", "outside"]]) {
  const description = output==="normal" ? `${mode} passes only provisional evidence to its matching builder and promotes it after success` :
    `dir rejects ${output} unpacked runtime from the builder`;
  test(description, t => {
    const {dir,out}=outputFixture(t,"valid");
    const meta={name:"electron-builder",version:"1.0.0",bin:{"electron-builder":"cli.js"}};
    out("desktop/package-lock.json",JSON.stringify({packages:{"node_modules/electron-builder":{...meta,integrity:"fixture"}}}));
    out("desktop/node_modules/electron-builder/package.json",JSON.stringify(meta));
    out("package.json",'{"version":"0.0.1","dependencies":{"@electric-sql/pglite":"1.0.0"}}');
    out("node_modules/@electric-sql/pglite/package.json",'{"name":"@electric-sql/pglite","version":"1.0.0"}');
    // Exercise the real all-path pin gate using an inert fixture-only entry.
    if (mode==="all") out("dist-desktop/BeeZilla-Setup-2.3.3.exe","prior version retained by the build");
    out("publishers.json",'{"publishers":[{"keyId":"fixture-only"}]}');
    cpSync(new URL("../desktop/after-pack.cjs",import.meta.url),join(dir,"desktop/after-pack.cjs"));
    out("desktop/node_modules/electron-builder/cli.js",`
      const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
      const hook=require(path.resolve("after-pack.cjs"));
      const stage=path.resolve("stage"), lock=path.join(stage,".build-lock");
      const mode=${JSON.stringify(mode)}, platform=mode==="all"?"win32":process.platform;
      const output=${JSON.stringify(output)};
      const outputName=mode==="dir"?"exact-builder-selected-dir":"win-unpacked";
      const appOutDir=path.resolve("..",output==="outside"?"other-dir":"dist-desktop",outputName);
      const context={appOutDir,electronPlatformName:platform,packager:{appInfo:{productFilename:"BeeZilla"}}};
      assert.equal(process.argv.at(-2),"--publish");
      assert.equal(process.argv.at(-1),"never");
      assert.equal(fs.existsSync(path.join(stage,"MANIFEST.json")),false,
        "a stage must not look committed before its packer has succeeded");
      const attempt=process.env.BZ_DESKTOP_STAGE_ATTEMPT;
      assert.match(attempt,/^[0-9a-f]{32}$/);
      assert.deepEqual(fs.readdirSync(lock),["pending-"+process.ppid+"-"+attempt+".json"]);
      const app=path.join(hook.resourcesDir(context),"app");
      fs.cpSync(path.join(stage,"app"),app,{recursive:true,filter:p=>path.basename(p)!=="node_modules"});
      (async()=>{
        delete process.env.BZ_DESKTOP_STAGE_ATTEMPT;
        await assert.rejects(hook.default(context),/no live matching desktop build attempt/i);
        process.env.BZ_DESKTOP_STAGE_ATTEMPT=attempt==="0".repeat(32)?"1".repeat(32):"0".repeat(32);
        await assert.rejects(hook.default(context),/no live matching desktop build attempt/i);
        assert.equal(fs.existsSync(path.join(app,"node_modules")),false);
        process.env.BZ_DESKTOP_STAGE_ATTEMPT=attempt;
        await hook.default(context);
        if (mode==="all") {
          fs.writeFileSync(path.resolve("..",${JSON.stringify(installerPath)}),"fixture bytes, not an installer");
        } else {
          const marker=path.join(lock,"pending-"+process.ppid+"-"+attempt+".json.dir-output.json");
          assert.deepEqual(JSON.parse(fs.readFileSync(marker,"utf8")),{
            relativeApp:path.relative(path.resolve("..","dist-desktop"),app)
          });
          if (output==="mutated") fs.writeFileSync(path.join(app,"package.json"),'{"changed":true}');
        }
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `);
    const packed=invoke(dir,false,mode);
    if (output!=="normal") {
      assert.notEqual(packed.status,0,packed.stdout+packed.stderr);
      assert.match(packed.stderr,output==="mutated"?/unpacked runtime now differs/i:/outside the expected dist-desktop directory/i);
      assert.doesNotMatch(packed.stdout,/verified local unpacked app written/i);
      assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
      assert.equal(existsSync(join(dir,"desktop/stage/.build-lock")),false);
      return;
    }
    assert.equal(packed.status,0,packed.stdout+packed.stderr);
    assert.match(packed.stdout,/staged and unpacked runtime bytes verified/i);
    if (mode==="dir") assert.match(packed.stdout,/verified local unpacked app written at dist-desktop[\\/]exact-builder-selected-dir/);
    if (mode==="all") {
      assert.match(packed.stdout,/fresh Windows installer output present.*presence only/i);
      assert.equal(readFileSync(join(dir,installerPath),"utf8"),"fixture bytes, not an installer");
      assert.equal(readFileSync(join(dir,"dist-desktop/BeeZilla-Setup-2.3.3.exe"),"utf8"),"prior version retained by the build");
    } else {
      assert.doesNotMatch(packed.stdout,/fresh Windows installer output present/i);
      assert.equal(existsSync(join(dir,installerPath)),false);
    }
    const stageManifest = JSON.parse(readFileSync(join(dir,"desktop/stage/MANIFEST.json"),"utf8"));
    assert.match(stageManifest.stagedRuntime.sha256,/^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(stageManifest).sort(),["megabytes","productionPackages","source","stagedAt","stagedRuntime","version"]);
    assert.equal(existsSync(join(dir,"desktop/stage/.build-lock")),false);
  });
}

function allOutputFixture(t, shape) {
  const {dir,out}=outputFixture(t,"valid");
  const meta={name:"electron-builder",version:"1.0.0",bin:{"electron-builder":"cli.js"}};
  out("desktop/package-lock.json",JSON.stringify({packages:{"node_modules/electron-builder":{...meta,integrity:"fixture"}}}));
  out("desktop/node_modules/electron-builder/package.json",JSON.stringify(meta));
  out("publishers.json",'{"publishers":[{"keyId":"fixture-only"}]}');
  const existing="dist-desktop/BeeZilla-Setup-2.3.3.exe";
  out(existing,"old different version");
  out("desktop/node_modules/electron-builder/cli.js",`
    const fs=require("node:fs"), path=require("node:path");
    const installer=path.resolve("..",${JSON.stringify(installerPath)});
    fs.writeFileSync("../builder-called","called");
    fs.mkdirSync(path.dirname(installer),{recursive:true});
    switch (${JSON.stringify(shape)}) {
      case "empty": fs.writeFileSync(installer,""); break;
      case "directory": fs.mkdirSync(installer); break;
      case "link": fs.symlinkSync(path.resolve("..",${JSON.stringify(existing)}),installer,"file"); break;
      case "hard link": fs.linkSync(path.resolve("..",${JSON.stringify(existing)}),installer); break;
      case "unexpected": fs.writeFileSync(path.join(path.dirname(installer),"unrelated.exe"),"fixture"); break;
    }
  `);
  return {dir,out,existing};
}

for (const shape of ["missing","unexpected","empty","directory","link","hard link"]) {
  test(`all refuses a zero-exit builder with ${shape} canonical output`, {skip: shape==="link" && process.platform==="win32"}, t=>{
    const {dir,existing}=allOutputFixture(t,shape);
    const result=invoke(dir,false,"all");
    assert.notEqual(result.status,0,result.stdout+result.stderr);
    assert.match(result.stderr,/did not produce a fresh nonempty regular Windows installer output/i);
    assert.doesNotMatch(result.stdout,/installer (written|output present)/i);
    assert.equal(existsSync(join(dir,"builder-called")),true);
    assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
    assert.equal(readFileSync(join(dir,existing),"utf8"),"old different version");
  });
}

test("all refuses and preserves preexisting output from the same desktop version",t=>{
  const {dir,out,existing}=allOutputFixture(t,"missing");
  out(installerPath,"old same version");
  const result=invoke(dir,false,"all");
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/move the existing .*BeeZilla-Setup.* aside before building this version/i);
  assert.doesNotMatch(result.stdout,/installer (written|output present)/i);
  assert.equal(existsSync(join(dir,"builder-called")),false);
  assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
  assert.equal(readFileSync(join(dir,installerPath),"utf8"),"old same version");
  assert.equal(readFileSync(join(dir,existing),"utf8"),"old different version");
  // Both old installer files are harmless for the independent staging command.
  assert.equal(invoke(dir).status,0);
  assert.ok(existsSync(join(dir,"desktop/stage/MANIFEST.json")));
});

test("all will not overwrite an earlier same-version sidecar when the installer is absent",t=>{
  const {dir,out}=allOutputFixture(t,"missing");
  const sidecar=installerPath+".blockmap";
  out(sidecar,"older sidecar, format not verified");
  const result=invoke(dir,false,"all");
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/move the existing .*BeeZilla-Setup.*\.exe\.blockmap aside/i);
  assert.equal(existsSync(join(dir,"builder-called")),false);
  assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
  assert.equal(readFileSync(join(dir,sidecar),"utf8"),"older sidecar, format not verified");
});

test("all refuses a noncanonical builder configuration before invoking the packer",t=>{
  const {dir,out}=allOutputFixture(t,"missing");
  out("desktop/package.json",JSON.stringify({
    version:fixtureVersion,build:{...desktopBuild,files:["main.mjs"],nsis:{...desktopBuild.nsis,artifactName:"alternate.exe"}}
  }));
  const result=invoke(dir,false,"all");
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/does not use the pinned Windows installer output/i);
  assert.equal(existsSync(join(dir,"builder-called")),false);
  assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
});

test("a competing stage cannot invalidate the active owner receipt during packaging",async t=>{
  const {dir,out}=outputFixture(t,"valid");
  const meta={name:"electron-builder",version:"1.0.0",bin:{"electron-builder":"cli.js"}};
  out("desktop/package-lock.json",JSON.stringify({packages:{"node_modules/electron-builder":{...meta,integrity:"fixture"}}}));
  out("desktop/node_modules/electron-builder/package.json",JSON.stringify(meta));
  const ready=join(dir,"owner-in-builder"), finish=join(dir,"release-owner");
  out("desktop/node_modules/electron-builder/cli.js",`
    const fs=require("node:fs");
    fs.writeFileSync(${JSON.stringify(ready)},"synthetic pack started");
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))process.exit(83)},25);
    setTimeout(()=>process.exit(84),5000);
  `);
  const owner=spawn(process.execPath,[join(dir,"desktop/dist.mjs"),"dir"],{
    cwd:dir,stdio:"ignore",
    env:{PATH:join(dir,"no-executables"),...(process.env.SYSTEMROOT?{SYSTEMROOT:process.env.SYSTEMROOT}:{})}
  });
  const settled=once(owner,"exit");
  void settled.catch(()=>{});
  const receipt=join(dir,"desktop/stage/MANIFEST.json");
  const lock=join(dir,"desktop/stage/.build-lock");
  try {
    const deadline=Date.now()+3500;
    while(!existsSync(ready)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    assert.ok(existsSync(ready),"fixture owner never reached its synthetic builder");
    assert.equal(existsSync(receipt),false);
    const entries=readdirSync(lock);
    assert.equal(entries.length,1);
    const pending=join(lock,entries[0]);
    const active=readFileSync(pending,"utf8");
    const contender=invoke(dir);
    assert.notEqual(contender.status,0,contender.stdout+contender.stderr);
    assert.match(contender.stderr,/another desktop.*stage|another desktop.*packaging/i);
    assert.equal(readFileSync(pending,"utf8"),active);
    assert.equal(existsSync(receipt),false);
  } finally {
    writeFileSync(finish,"finish");
    await settled;
  }
  // This owner was scripted to fail, not to produce an app or installer.
  assert.equal(existsSync(receipt),false);
  assert.equal(existsSync(lock),false);
  const retry=invoke(dir);
  assert.equal(retry.status,0,retry.stdout+retry.stderr);
  assert.ok(existsSync(receipt));
});

test("pack:dir refuses stale unpacked runtime when this builder exits zero without afterPack",t=>{
  const {dir,out}=outputFixture(t,"valid");
  const meta={name:"electron-builder",version:"1.0.0",bin:{"electron-builder":"cli.js"}};
  out("desktop/package-lock.json",JSON.stringify({packages:{"node_modules/electron-builder":{...meta,integrity:"fixture"}}}));
  out("desktop/node_modules/electron-builder/package.json",JSON.stringify(meta));
  out("desktop/node_modules/electron-builder/cli.js",'require("node:fs").writeFileSync("../builder-called","called");');
  const output = {
    win32:"win-unpacked/resources/app",
    linux:"linux-unpacked/resources/app",
    darwin:"mac/BeeZilla.app/Contents/Resources/app",
  }[process.platform];
  assert.ok(output);
  out("dist-desktop/"+output+"/package.json",'{"name":"old unrelated unpacked stage"}');
  out("dist-desktop/"+output+"/node_modules/@electric-sql/pglite/package.json",'{"name":"old stub"}');
  const result=invoke(dir,false,"dir");
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/did not supply verified unpacked runtime evidence from this build/i);
  assert.doesNotMatch(result.stdout,/unpacked app written under dist-desktop/i);
  assert.equal(existsSync(join(dir,"builder-called")),true);
  assert.equal(existsSync(join(dir,"desktop/stage/MANIFEST.json")),false);
  assert.equal(readFileSync(join(dir,"dist-desktop",output,"package.json"),"utf8"),'{"name":"old unrelated unpacked stage"}');
});
