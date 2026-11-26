/** Exact doctor CLI in disposable trees. No runtime or provider is ever launched. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const names=["pglite.data","pglite.wasm","initdb.wasm"];
const staged=".output/server/_libs";
const installed="node_modules/@electric-sql/pglite/dist";

function fixture(t, mode) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"bee CLI doctor "));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,"disposable-data");
 function write(rel,text){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
 for (const file of ["bin/beezilla.mjs","scripts/lib/inference.mjs","scripts/lib/search-keys.mjs","scripts/lib/pins.mjs"]) {
   write(file,fs.readFileSync(new URL("../"+file,import.meta.url)));
 }
 // Existing CLI only checks the file and never executes it for doctor.
 write(".output/server/index.mjs","throw new Error('Doctor must not start the runtime');");
 assert.equal(fs.existsSync(path.join(data,"runtime.json")),false);
 if(mode!=="missing-destination")fs.mkdirSync(path.join(root,staged),{recursive:true});
 for(const name of names){
  if(mode==="ready")write(staged+"/"+name,"fixture present");
  if(mode!=="ready" && !(mode==="missing" && name==="initdb.wasm"))write(installed+"/"+name,"fixture installed fallback");
  if(mode==="invalid" && name==="pglite.wasm")write(staged+"/"+name,"");
  if(mode==="non-file" && name==="pglite.data")fs.mkdirSync(path.join(root,staged,name));
 }
 const run=()=>spawnSync(process.execPath,[path.join(root,"bin/beezilla.mjs"),"doctor"],{
  cwd:root,env:{PATH:process.env.PATH,HOME:root,BZ_DATA_DIR:data},timeout:10000,encoding:"utf8",
 });
 return {root,data,run};
}

test("a staged local install reports nonempty loader assets", t=>{
 const f=fixture(t,"ready"), r=f.run();
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/^PASS  pglite assets/m);
 assert.match(r.stdout,/already bundled/);
});

test("an ordinary build with only the installed fallback payloads reports where they will come from",t=>{
 const f=fixture(t,"fallback"),r=f.run();
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(r.stdout,/^PASS  pglite assets.*available for launcher restore/m);
 assert.deepEqual(fs.readdirSync(path.join(f.root,staged)),[],"doctor inspects without restoring");
 assert.ok(!fs.existsSync(path.join(f.data,"runtime.json")));
});

test("doctor does not endorse an empty staged file merely because a fallback exists",t=>{
 const f=fixture(t,"invalid"),r=f.run();
 assert.equal(r.status,1,r.stdout+r.stderr);
 assert.match(r.stdout,/^warn  pglite assets.*pglite\.wasm.*empty/m);
 assert.equal(fs.statSync(path.join(f.root,staged,"pglite.wasm")).size,0);
});

test("doctor reports a directory at a PGlite file path instead of presenting it as restorable",t=>{
 const f=fixture(t,"non-file"),r=f.run();
 assert.equal(r.status,1,r.stdout+r.stderr);
 assert.match(r.stdout,/^warn  pglite assets.*pglite\.data.*not a regular file/m);
});

test("doctor names the missing payload and where it looked",t=>{
 const f=fixture(t,"missing"),r=f.run();
 assert.equal(r.status,1,r.stdout+r.stderr);
 assert.match(r.stdout,/^warn  pglite assets.*initdb\.wasm.*missing from.*_libs.*node_modules/m);
});

test("fallback availability does not conceal a missing loader directory",t=>{
 const f=fixture(t,"missing-destination"),r=f.run();
 assert.equal(r.status,1,r.stdout+r.stderr);
 assert.match(r.stdout,/^warn  pglite assets.*_libs.*directory is unavailable/m);
 assert.ok(!fs.existsSync(path.join(f.root,staged)));
});
