// Real Linux process interruption around the exact credential store rename.
// No Electron, real keys, user files, provider requests or power-loss claim.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import * as fs from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import vm from "node:vm";
import * as normalStore from "./lib/inference.mjs";

const source=fs.readFileSync(new URL("./lib/inference.mjs",import.meta.url),"utf8");
const alpha={name:"Fixture Alpha",email:"alpha@example.invalid"};
const beta={name:"Fixture Beta",email:"beta@example.invalid"};
const profileCipher={
  // Deliberately simple test-only encoding for crash checks; the local-owner
  // suite separately uses AES-GCM and tests the ciphertext and no plaintext.
  encrypt(value){return Buffer.from("fixture:"+value);},
  encryptOwner(value){return Buffer.from("fixture:"+value);},
  decrypt(value){assert.match(value.toString(),/^fixture:/);return value.toString().slice(8);},
};
const childArgs=process.argv.slice(2);
const main=fs.readFileSync(new URL("../desktop/main.mjs",import.meta.url),"utf8");
const start=main.indexOf("function identityFile()");
const end=main.indexOf("// Only values this process injected",start);
assert.ok(start>=0&&end>start);
async function coldProfile(dir){
  const env={};
  const sandbox=vm.createContext({
    supervisor:{dataDir:dir},process:{env},join:path.join,readFileSync:fs.readFileSync,
    existsSync:fs.existsSync,Buffer,console:{log(){},warn(){}},
    runtimeLib:async()=>normalStore,
    safeStorage:{decryptString:profileCipher.decrypt},
  });
  vm.runInContext(main.slice(start,end),sandbox);
  await vm.runInContext("applyIdentityToEnv()",sandbox);
  return env.BZ_LOCAL_OWNER_EMAIL ? {name:env.BZ_LOCAL_OWNER_NAME,email:env.BZ_LOCAL_OWNER_EMAIL} : null;
}

async function runCrashChild(dir, cut) {
  const context=vm.createContext({Buffer});
  const realCrypto=await import("node:crypto");
  const filesystem={...fs,renameSync(from,to){
    assert.equal(to,path.join(dir,"inference.json"));
    assert.ok(fs.statSync(from).isFile(),"complete same-directory temp exists before publication");
    if(cut==="before")process.kill(process.pid,"SIGKILL");
    if(cut==="denied")throw Object.assign(Error("fixture refused atomic commit"),{code:"EACCES"});
    fs.renameSync(from,to);
    process.kill(process.pid,"SIGKILL");
  }};
  const builtins={"node:crypto":realCrypto,"node:fs":filesystem,"node:path":path};
  const module=new vm.SourceTextModule(source,{context});
  await module.link(specifier=>{
    assert.ok(Object.hasOwn(builtins,specifier));
    const entries=Object.entries(builtins[specifier]);
    return new vm.SyntheticModule(entries.map(([name])=>name),function(){
      for(const [name,value] of entries)this.setExport(name,value);
    },{context});
  });
  await module.evaluate();
  const adopt=()=>module.namespace.saveInference(dir,{provider:"beezilla",key:"fixture-beta-key"},
    profileCipher,{connectedOwner:cut==="empty"?null:beta});
  if(cut==="denied")assert.throws(adopt,{code:"EACCES"});
  else {adopt();throw Error("fixture must never reach after the rename");}
}

if(childArgs[0]==="--crash-child") {
  await runCrashChild(childArgs[1],childArgs[2]);
} else {
  for(const [cut, before] of [["before",true],["after",false],["empty",false],["denied",true]]){
    test(`raw credential and Profile remain consistent at the ${cut} publication boundary`,{skip:process.platform!=="linux"},async t=>{
      const dir=fs.mkdtempSync(path.join(tmpdir(),"bz-owner-commit-"));
      t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
      const storeFile=path.join(dir,"inference.json");
      const oldSidecar=path.join(dir,"identity.json");
      fs.writeFileSync(oldSidecar,JSON.stringify(alpha));
      normalStore.saveInference(dir,{provider:"beezilla",key:"fixture-alpha-key"},profileCipher,{connectedOwner:alpha});
      const original=fs.readFileSync(storeFile,"utf8");
      const oldId=normalStore.managedSearchConnection(dir);
      const outcome=spawnSync(process.execPath,["--experimental-vm-modules",fileURLToPath(import.meta.url),"--crash-child",dir,cut],{
        encoding:"utf8",timeout:5000,
      });
      if(cut==="denied"){
        assert.equal(outcome.signal,null);assert.equal(outcome.status,0,outcome.stderr);
        assert.deepEqual(fs.readdirSync(dir).sort(),["identity.json","inference.json"],"ordinary refusal cleans only its temp");
      } else {
        assert.equal(outcome.signal,"SIGKILL",outcome.stderr);assert.equal(outcome.status,null);
      }
      assert.equal(normalStore.loadInference(dir,profileCipher).key,before?"fixture-alpha-key":"fixture-beta-key");
      assert.deepEqual(await coldProfile(dir),cut==="empty"?null:before?alpha:beta);
      assert.equal(normalStore.managedSearchConnection(dir)===oldId,before);
      if(before)assert.equal(fs.readFileSync(storeFile,"utf8"),original);
      assert.deepEqual(JSON.parse(fs.readFileSync(oldSidecar,"utf8")),alpha,"no legacy file mutation or cleanup");
    });
  }
}
