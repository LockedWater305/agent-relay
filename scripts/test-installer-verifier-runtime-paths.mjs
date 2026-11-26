/** Disposable wrong-type path fixtures; no installer or native code is produced or used. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const modeLabels = {
  server: "the server bundle exists",
  migrations: "migrations are staged",
  settings: "the settings page is staged",
};
for (const [mode, label] of Object.entries(modeLabels)) {
  test(`audit rejects wrong file type at ${mode} and continues with the other checks`,t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"bz-audit-paths "));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const runner=path.join(dir,"scripts/verify-installer.mjs");
    const app=path.join(dir,"dist-desktop/win-unpacked/resources/app");
    function write(file,body) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
    write(runner,fs.readFileSync(new URL("./verify-installer.mjs",import.meta.url)));
    const server=path.join(app,".output/server/index.mjs"), sql=path.join(app,"migrations"), page=path.join(app,"public/buzzy/settings.html");
    if (mode==="server") fs.mkdirSync(server,{recursive:true}); else write(server,"fixture server, not a real bundle");
    if (mode==="migrations") write(sql,"not a directory"); else write(path.join(sql,"001.sql"),"SELECT 1;");
    if (mode==="settings") fs.mkdirSync(page,{recursive:true}); else write(page,"fixture");
    write(path.join(app,"scripts/beezilla-local.mjs"),"// ensurePgliteAssets fixture");
    write(path.join(app,"bin/beezilla.mjs"),"// synthetic CLI path");
    const r=spawnSync(process.execPath,[runner],{cwd:dir,env:{...process.env,PATH:""},timeout:10000,encoding:"utf8"});
    assert.equal(r.status,1,"the incomplete fixture must be rejected");
    assert.match(r.stdout,new RegExp(`^FAIL  ${label}.*(?:EISDIR|ENOTDIR|not a regular file)`,"m"),r.stdout+r.stderr);
    assert.match(r.stdout,/^PASS  the CLI is staged/m,r.stdout+r.stderr);
    assert.match(r.stdout,/installer verification: \d+ failed/);
    assert.equal(r.stderr,"","no uncaught exception");
  });
}
