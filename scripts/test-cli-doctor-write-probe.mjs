// The existing CLI is invoked on disposable paths only. No runtime, network, or real store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t, mode) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bee doctor write fixture "));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,"data");
  const prior=Buffer.from([65,10,0,109,121,45,100,97,116,97,13,255]);
  function write(file,bytes){const dst=path.join(root,file);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,bytes);}
  for(const f of ["bin/beezilla.mjs","scripts/lib/inference.mjs","scripts/lib/pins.mjs","scripts/lib/search-keys.mjs"])
    write(f,fs.readFileSync(new URL("../"+f,import.meta.url)));
  write(".output/server/index.mjs","throw Error('doctor is not a runtime');");
  for(const f of ["pglite.data","pglite.wasm","initdb.wasm"])write(".output/server/_libs/"+f,"nonempty fixture");
  if(mode==="existing-file")write("data/.doctor",prior);
  if(mode==="existing-dir")fs.mkdirSync(path.join(data,".doctor"),{recursive:true});
  if(mode==="invalid-data-dir")write("data",prior);
  const run=()=>spawnSync(process.execPath,[path.join(root,"bin/beezilla.mjs"),"doctor"],{
    cwd:root,env:{PATH:process.env.PATH,HOME:root,BZ_DATA_DIR:data},timeout:10000,encoding:"utf8",
  });
  return {data,prior,run};
}
for(const mode of ["existing-file","existing-dir","new-dir"]){
 test(`doctor probe is disposable and preserves ${mode}`,t=>{
  const f=fixture(t,mode),r=f.run();
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/^PASS  data dir writable/m);
  assert.deepEqual(fs.readdirSync(f.data),mode==="new-dir"?[]:[".doctor"]);
  if(mode==="existing-file")
    assert.deepEqual(fs.readFileSync(path.join(f.data,".doctor")),f.prior);
  if(mode==="existing-dir")
    assert.equal(fs.lstatSync(path.join(f.data,".doctor")).isDirectory(),true);
 });
}
test("doctor still warns when data path is not a directory", t=>{
  const f=fixture(t,"invalid-data-dir"),r=f.run();
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stdout,/^warn  data dir writable/m);
  assert.deepEqual(fs.readFileSync(f.data),f.prior);
});
