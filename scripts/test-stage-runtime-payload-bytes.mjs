import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {ensurePgliteAssets,PGLITE_PAYLOADS} from "../desktop/stage-inputs.mjs";

function fixture(t) {
  const app=fs.mkdtempSync(path.join(os.tmpdir(),"beezilla-empty-payload-fixture-"));
  t.after(()=>fs.rmSync(app,{force:true,recursive:true}));
  function pathTo(location,name) {
    return path.join(app, location === "bundle" ? ".output/server/_libs" : "node_modules/@electric-sql/pglite/dist",name);
  }
  for (const name of PGLITE_PAYLOADS) {
    const file=pathTo("fallback",name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`fixture ${name}`);
  }
  return {app,pathTo};
}
for(const location of ["bundle","fallback"]) {
  for(const name of PGLITE_PAYLOADS) {
    test(`staging rejects zero-byte ${location} ${name}`, t=>{
      const {app,pathTo}=fixture(t);
      const file=pathTo(location,name);
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,"");
      assert.throws(()=>ensurePgliteAssets(app),err=> err.message.includes(name)&&err.message.includes("empty"));
      if (location==="fallback") assert.equal(fs.existsSync(pathTo("bundle",name)),false,"do not copy an empty source");
      else assert.equal(fs.readFileSync(file).length,0,"do not silently substitute the failed bundle");
    });
  }
}
test("positive control: preserves a non-empty bundled payload and copies non-empty fallbacks",t=>{
  const {app,pathTo}=fixture(t);
  const existing=pathTo("bundle","pglite.data");
  fs.mkdirSync(path.dirname(existing),{recursive:true});fs.writeFileSync(existing,"bundled fixture");
  ensurePgliteAssets(app);
  assert.equal(fs.readFileSync(existing,"utf8"),"bundled fixture");
  for (const name of ["pglite.wasm","initdb.wasm"]) assert.deepEqual(fs.readFileSync(pathTo("bundle",name)),fs.readFileSync(pathTo("fallback",name)));
});
