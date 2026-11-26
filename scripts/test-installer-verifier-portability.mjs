// No installer is built/run or accepted. These deliberately incomplete fixtures must all fail verification.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bee verify fixture "));
  t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
  function write(name, value) { const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value); }
  write("scripts/verify-installer.mjs",fs.readFileSync(new URL("./verify-installer.mjs",import.meta.url)));
  fs.mkdirSync(path.join(dir,"dist-desktop"));
  function run() { return spawnSync(process.execPath,[path.join(dir,"scripts/verify-installer.mjs")],{cwd:dir,env:{...process.env,PATH:""},encoding:"utf8",timeout:10000}); }
  function asar(installedVersion="1.0.0-fixture") {
    const name="@electron/asar", version="1.0.0-fixture", bin={asar:"bin/asar.js"};
    write("desktop/package-lock.json",JSON.stringify({packages:{["node_modules/"+name]:{version,bin,integrity:"offline fixture"}}}));
    write("desktop/node_modules/@electron/asar/package.json",JSON.stringify({name,version:installedVersion,bin:{asar:"./bin/asar.js"}}));
    write("desktop/node_modules/@electron/asar/bin/asar.js",[
      "const assert=require('node:assert/strict');",
      "assert.equal(process.argv[2],'list');",
      "assert.equal(require('node:fs').readFileSync(process.argv[3],'utf8'),'fixture archive');",
      "for(const name of ['main.mjs','preload.cjs','settings.mjs','supervisor.mjs','connect.mjs']) process.stdout.write('\\\\'+name+'\\r\\n');"
    ].join("\n"));
    write("dist-desktop/win-unpacked/resources/app.asar","fixture archive");
  }
  return {write,run,asar};
}

test("reads app shell inventory offline from the locked desktop ASAR tool, including Windows listing separators",t=>{
  const f=fixture(t);f.asar();
  const r=f.run();
  assert.equal(r.status,1,"this incomplete fixture must never be accepted");
  for (const name of ["main.mjs","preload.cjs","settings.mjs","supervisor.mjs","connect.mjs"])
    assert.ok(r.stdout.includes("PASS  the shell ships "+name),r.stdout+r.stderr);
  assert.match(r.stdout,/installer verification: \d+ failed/);
});

test("a mismatched local ASAR tool fails closed without hiding the runtime checks",t=>{
  const f=fixture(t);f.asar("0.1.0-wrong");
  const r=f.run();assert.equal(r.status,1);
  assert.match(r.stdout,/FAIL[^\n]*ASAR inventory/i);
  assert.match(r.stdout,/FAIL  the runtime tree exists/);
  assert.doesNotMatch(r.stdout,/PASS  the shell ships/);
});

test("a missing PE-classification utility is reported as a failure, not an aborted audit",t=>{
  const f=fixture(t);f.write("dist-desktop/test-fixture.exe","Not an installer.");
  const r=f.run();assert.equal(r.status,1);
  assert.match(r.stdout,/FAIL  the installer is a PE executable/);
  assert.match(r.stdout,/FAIL  app.asar exists/);
  assert.match(r.stdout,/installer verification: \d+ failed/);
});

test("a missing launcher is reported together with later missing runtime assets",t=>{
  const f=fixture(t);f.write("dist-desktop/win-unpacked/resources/app/package.json","{}");
  const r=f.run();assert.equal(r.status,1);
  assert.match(r.stdout,/FAIL  the launcher is staged/);
  assert.match(r.stdout,/FAIL  the CLI is staged/);
  assert.match(r.stdout,/installer verification: \d+ failed/);
});
