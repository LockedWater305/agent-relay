/** No real installer, file utility, npx, ASAR, Windows, or network invocation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

function run(t, exe, args = []) {
  const dir=mkdtempSync(join(tmpdir(),"bee-shape-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  function out(path, bytes) {
    const file=join(dir,path); mkdirSync(dirname(file),{recursive:true}); writeFileSync(file,bytes);
  }
  out("scripts/verify-installer.mjs",readFileSync(new URL("./verify-installer.mjs",import.meta.url)));
  out("desktop/package.json",'{"version":"0.0.1"}');
  out("calls.txt","");
  out("dist-desktop/"+exe,"fixture executable only");
  // Sparse size so the real minimum-size condition is exercised without a file copy.
  const fd=openSync(join(dir,"dist-desktop",exe),"r+");
  try {ftruncateSync(fd,51*1024*1024);} finally {closeSync(fd);}
  const unpacked="dist-desktop/win-unpacked/resources";
  out(unpacked+"/app.asar","api/search-token https://beezilla.railway.app could not reach BeeZilla at");
  const app=unpacked+"/app/";
  out(app+".output/server/index.mjs","BZ_CATALOG_URL BZ_SEARCH_GATEWAY_URL BZ_MANAGED_EXPIRED needsReconnect ".repeat(8000));
  out(app+"migrations/stub.sql","-- test");
  for (const file of ["pglite.data","pglite.wasm","initdb.wasm"]) out(app+".output/server/_libs/"+file,"test");
  out(app+"public/buzzy/settings.html","connect-account ".repeat(400));
  out(app+"publishers.json",'{"publishers":[]}');
  out(app+"scripts/beezilla-local.mjs","ensurePgliteAssets BZ_SEARCH_EXPIRED");
  out(app+"scripts/lib/parent-watchdog.cjs","fixture watchdog");
  out(app+"bin/beezilla.mjs","fixture cli");
  out("mock.cjs",`
    const cp=require("node:child_process"),fs=require("node:fs");
    cp.execFileSync=(cmd,args)=>{
      fs.appendFileSync(process.env.BEE_SHAPE_LOG,cmd+"\\n");
      if(cmd==="file")return "PE32 executable";
      if(cmd==="npx")return "/main.mjs\\n/preload.cjs\\n/settings.mjs\\n/supervisor.mjs\\n/connect.mjs\\n";
      throw Error("unexpected child: "+cmd);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const r=spawnSync(process.execPath,["--require",join(dir,"mock.cjs"),join(dir,"scripts/verify-installer.mjs"),...args],{
    cwd:dir,encoding:"utf8",timeout:15000,
    env:{...(process.env.SYSTEMROOT?{SYSTEMROOT:process.env.SYSTEMROOT}:{}),PATH:join(dir,"no-executables"),BEE_SHAPE_LOG:join(dir,"calls.txt")},
  });
  assert.ifError(r.error);
  return {code:r.status,text:r.stdout+r.stderr,calls:readFileSync(join(dir,"calls.txt"),"utf8").trim()};
}
test("an arbitrary stale-version .exe can't satisfy the canonical installer shape check",t=>{
  const r=run(t,"BeeZilla-Setup-0.0.0.exe",["--allow-zero-pins"]);
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/BeeZilla-Setup-0\.0\.1\.exe/);
  assert.equal(r.calls,"","reject missing canonical path before launching inspection tools");
});
test("canonical installer and test pins only qualify as Windows output shape",t=>{
  const r=run(t,"BeeZilla-Setup-0.0.1.exe",["--allow-zero-pins"]);
  assert.equal(r.code,0,r.text);
  assert.match(r.text,/shape only.*not.*channel.*signature/i);
  assert.match(r.text,/Windows output shape check: passed/i);
  assert.match(r.text,/test only/i);
  assert.doesNotMatch(r.text,/server bundle is this build/i);
  assert.doesNotMatch(r.text,/installer verification: passed/i);
});
test("zero pin fixture still fails without explicit local test allowance",t=>{
  const r=run(t,"BeeZilla-Setup-0.0.1.exe");
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/at least one publisher is pinned/i);
});
