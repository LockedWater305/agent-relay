/**
 * Offline desktop prebuild contract. The Node entry and recipe hooks are real;
 * a fake locked Vite exits as soon as control reaches it. No bundle is built.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CSP_PAGE_NAMES } from "../desktop/csp.mjs";

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
  out("desktop/package.json",'{"build":{"files":["main.mjs"]}}');
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
