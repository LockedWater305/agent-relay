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

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(),"bee-desktop-prebuild-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const out = (path, text) => {const dest=join(dir,path); mkdirSync(dirname(dest),{recursive:true}); writeFileSync(dest,text)};
  for (const f of ["desktop/dist.mjs", "desktop/stage-inputs.mjs", "desktop/csp.mjs", "desktop/security.mjs", "scripts/build-desktop-csp.mjs", "scripts/sync-private.mjs", "scripts/assert-no-private-modules.mjs"]) {
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
function invoke(dir,requirePrivate=false) {
  const r=spawnSync(process.execPath,[join(dir,"desktop/dist.mjs"),"stage"],{
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
