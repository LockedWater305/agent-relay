/** The real CLI with isolated discovery data and a fetch stub; no network. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function run(t, entry, responding=false) {
  const root=mkdtempSync(join(tmpdir(),"bee-cli-status-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const app=join(root,"resources","app"), data=join(root,"isolated data"), cwd=join(root,"shell cwd");
  for (const rel of ["bin/beezilla.mjs","scripts/lib/inference.mjs","scripts/lib/pins.mjs","scripts/lib/search-keys.mjs"]) {
    const dest=join(app,rel);
    mkdirSync(dirname(dest),{recursive:true});
    copyFileSync(new URL("../"+rel,import.meta.url),dest);
  }
  mkdirSync(data); mkdirSync(cwd);
  const file=join(data,"runtime.json");
  if (entry === "directory") mkdirSync(file);
  else if (typeof entry === "string") writeFileSync(file,entry);
  const trace=join(root,"fetches.txt");
  writeFileSync(trace,"");
  const preload=join(root,"network.cjs");
  writeFileSync(preload,`
    const fs=require("node:fs");
    globalThis.fetch=async (url)=>{
      fs.appendFileSync(${JSON.stringify(trace)},String(url)+"\\n");
      return {ok:${responding}};
    };
  `);
  const r=spawnSync(process.execPath,["--require",preload,join(app,"bin/beezilla.mjs"),"status"],{
    cwd,encoding:"utf8",timeout:8000,
    env:{ PATH:join(root,"no-executables"), BZ_DATA_DIR:data,
      ...(process.env.SYSTEMROOT?{SYSTEMROOT:process.env.SYSTEMROOT}:{}) },
  });
  assert.ifError(r.error);
  return {...r,fetches:readFileSync(trace,"utf8").trim()};
}

const discovery=JSON.stringify({pid:12345,host:"127.0.0.1",port:7331,
  startedAt:"2026-11-27T00:00:00Z",dataDir:"fixture directory",token:"fixture-private-value"});

test("no discovery keeps the ordinary not-running result without probing",t=>{
  const r=run(t);
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout.trim(),"not running");
  assert.equal(r.fetches,"");
});
test("truncated discovery reports nonzero and does not echo secret JSON fragments",t=>{
  const r=run(t,discovery.slice(0,-1));
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/runtime\.json.*invalid JSON/i);
  assert.doesNotMatch(r.stderr+r.stdout,/fixture-private-value|not running/i);
  assert.equal(r.fetches,"");
});
test("an unreadable discovery file is not absence",t=>{
  const r=run(t,"directory");
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/could not read.*runtime\.json/i);
  assert.equal(r.fetches,"");
});
for (const [name,raw] of [
  ["null","null"],["partial",'{ "host": "127.0.0.1" }'],
  ["invalid endpoint",JSON.stringify({...JSON.parse(discovery),host:"elsewhere.invalid"})],
]) {
  test(`${name} discovery reports invalid data without probing`,t=>{
    const r=run(t,raw,true);
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stderr,/runtime\.json.*invalid.*endpoint|runtime\.json.*invalid.*discovery/i);
    assert.equal(r.fetches,"");
  });
}
for (const responds of [false,true]) {
  test(`valid loopback discovery keeps the ${responds?"running":"stale"} health result`,t=>{
    const r=run(t,discovery,responds);
    assert.equal(r.status,responds?0:1,r.stdout+r.stderr);
    assert.match(r.stdout,responds?/^running /:/stale handshake/i);
    assert.equal(r.fetches,"http://127.0.0.1:7331/api/agent/health");
    assert.doesNotMatch(r.stdout+r.stderr,/fixture-private-value/);
  });
}
