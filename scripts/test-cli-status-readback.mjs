// Exact status command with offline fixture data and an inert local health reply.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t, mode) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bee status test "));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,"disposable-data");
  const record=path.join(data,"runtime.json");
  function write(rel,bytes){const dst=path.join(root,rel);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,bytes);}
  for(const f of ["bin/beezilla.mjs","scripts/lib/inference.mjs","scripts/lib/pins.mjs","scripts/lib/search-keys.mjs"])
    write(f,fs.readFileSync(new URL("../"+f,import.meta.url)));
  // Only fake runtime.json and fake fetch; no files refer to real PIDs or ports.
  const entry={host:"127.0.0.1",port:45678,pid:123456,startedAt:"2026-01-02T03:04:56.789Z",dataDir:data};
  if(mode==="unreadable")fs.mkdirSync(record,{recursive:true});
  else if(mode==="malformed")write("disposable-data/runtime.json", 'fixture-invalid-body ');
  else if(mode==="incomplete")write("disposable-data/runtime.json", JSON.stringify({host:entry.host,port:entry.port}));
  else if(mode==="valid"||mode==="unreachable")write("disposable-data/runtime.json", JSON.stringify(entry));
  const init=`
    globalThis.fetch = async (url) => {
      if (url !== "http://127.0.0.1:45678/api/agent/health") throw new Error("unexpected synthetic fetch");
      console.log("fixture-health-probe");
      return {ok: ${mode!=="unreachable"}};
    };
  `;
  const output=spawnSync(process.execPath,["--import","data:text/javascript,"+encodeURIComponent(init),path.join(root,"bin/beezilla.mjs"),"status"],{
    cwd:root,env:{PATH:process.env.PATH,HOME:root,BZ_DATA_DIR:data},timeout:10000,encoding:"utf8",
  });
  assert.ifError(output.error);
  return output;
}

test("status still reports a truly absent runtime record as not running",t=>{
  const r=fixture(t,"missing");
  assert.equal(r.status,0);
  assert.equal(r.stdout.trim(),"not running");
  assert.equal(r.stderr,"");
});
for(const [mode,expected] of [
  ["malformed",/invalid JSON/],["unreadable",/could not be read/],["incomplete",/missing or invalid process details/],
]){
  test(`status reports ${mode} runtime record as unknown without a probe`,t=>{
    const r=fixture(t,mode);
    assert.equal(r.status,1,r.stdout+r.stderr);
    const out=r.stdout+r.stderr;
    assert.match(out,/runtime status unknown/);
    assert.match(out,expected);
    assert.doesNotMatch(out,/fixture-health-probe|fixture-invalid-body|^not running$/m);
  });
}
test("valid runtime record still uses the existing health result and prints its endpoint",t=>{
  const r=fixture(t,"valid");
  assert.equal(r.status,0);
  assert.match(r.stdout,/fixture-health-probe/);
  assert.match(r.stdout,/^running  http:\/\/127[.]0[.]0[.]1:45678/m);
  assert.match(r.stdout,/pid 123456 .*2026-01-02T03:04:56.789Z/);
});
test("ordinary health rejection still reports not answering for a valid record",t=>{
  const r=fixture(t,"unreachable");
  assert.equal(r.status,1);
  assert.match(r.stdout,/fixture-health-probe/);
  assert.match(r.stdout,/^not answering  http:\/\/127[.]0[.]0[.]1:45678/m);
});
