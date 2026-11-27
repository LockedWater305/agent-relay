// Run exact local identity, Connect, Settings, and H3 session code without Electron,
// providers, real accounts, or a DB. Disk writes are synthetic temporary identity records.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as h3 from "h3";
import { connectAccount, MINT_SCRIPT, PROFILE_SCRIPT, SEARCH_MINT_SCRIPT, managedAccountConnectCapability } from "../desktop/connect.mjs";

const require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const main=read("desktop/main.mjs"), settingsSource=read("desktop/settings.mjs");
const start=main.indexOf("function identityFile()");
const end=main.indexOf("// Only values this process injected",start);
assert.ok(start>=0&&end>start);
assert.match(main,/onCommitted:\s*\(\)\s*=>\s*saveIdentity\(outcome.account\)/);
assert.match(main,/beforeRestart:[\s\S]*?applyIdentityToEnv\(\)/);
const identity=main.slice(start,end);
const alpha={name:"Fixture Alpha",email:"alpha@example.invalid"};
const beta={name:"Fixture Beta",email:"beta@example.invalid"};
const generic={name:"Owner",email:"owner@beezilla.local"};
const origin="http://127.0.0.1:8090";
const localToken="fixture-only-local-launch-token";
const names=["BZ_LOCAL_OWNER_NAME","BZ_LOCAL_OWNER_EMAIL"];
const compile=path=>ts.transpileModule(read(path),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
const localSource=compile("src/lib/local-owner.ts");
const authSource=compile("src/lib/auth-api.nitro.ts");
const load=(text,env,deps)=>{
  const exports={};
  vm.runInNewContext(text,{exports,process:{env},Request,Response,Headers,URL,Buffer,console,
    require(name){assert.ok(Object.hasOwn(deps,name),"closed fixture dependency: "+name);return deps[name];}});
  return exports;
};
async function setup(t, explicit={}){
  const dir=mkdtempSync(join(tmpdir(),"bz-local-owner-fixture-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,"identity.json");
  const logs=[];
  const quiet={log:(...items)=>logs.push(items.join(" ")),warn:(...items)=>logs.push(items.join(" "))};
  const env={...explicit};
  const supervisor={dataDir:dir,runtime:{port:8090},async isHealthy(){return true;},async stop(){},async start(){
    boots++;
    await spawnLocal();
    return this.runtime;
  }};
  let boots=0, persistedRow, app, credential=null, mintCount=0, rejectIdentityWrites=false;
  const launcher=vm.createContext({supervisor,process:{env},join,existsSync,mkdirSync,readFileSync,console:quiet,
    writeFileSync(path,data){
      assert.equal(path,file);
      if(rejectIdentityWrites)throw Object.assign(new Error("fixture-private-path"),{code:"EACCES"});
      writeFileSync(path,data);
    },
  });
  vm.runInContext(identity,launcher);
  const apply=vm.runInContext("applyIdentityToEnv",launcher);
  const save=vm.runInContext("saveIdentity",launcher);
  async function spawnLocal(){
    const snapshot={...env,BZ_LOCAL_TOKEN:localToken};
    const owner=load(localSource,snapshot,{
      "node:crypto":require("node:crypto"),"./runtime":{isLocalRuntime:()=>true},
      "./db":{async getSql(){return async(sql,...values)=>{
        if(sql[0].includes("insert into")){
          const [id,name,email]=values;persistedRow={id,name,email};return [];
        }
        assert.match(sql[0],/select id, name, email/);assert.equal(values[0],"local_owner");
        return [persistedRow];
      };}},
    });
    const adapter=load(authSource,snapshot,{
      h3,"./runtime":{isLocalRuntime:()=>true},"./local-owner":owner,
      "./auth/server":{handleAuthRequest(){throw Error("local fixture must never touch hosted auth");}},
    }).default;
    app=new h3.H3();app.get("/api/auth/get-session",async event=>await adapter(event));
  }
  const readOwner=async()=>{
    const response=await app.fetch(new Request(origin+"/api/auth/get-session",{headers:{host:"127.0.0.1:8090",authorization:"Bearer "+localToken}}));
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(response.headers.getSetCookie().length,0);
    const data=await response.json();
    assert.equal(data.session.id,"local-session");assert.equal(data.session.userId,"local_owner");assert.equal(data.user.id,"local_owner");
    assert.ok(!JSON.stringify(data).includes(localToken));
    return {name:data.user.name,email:data.user.email};
  };
  const libs={
    "scripts/lib/inference.mjs":{
      loadInference:()=>credential,resolveInference:()=>credential,
      redactKey:()=>"[fixture]",hasRemovableInference:()=>!!credential,isExpired:()=>false,
      saveInference:(_dir,data)=>credential={...data,source:"store",encrypted:true,managedConnectionId:"fixture-connection"},
      clearInference:()=>{credential=null;},
    },
    "scripts/lib/search-keys.mjs":{
      resolveSearch:()=>null,loadManagedSearch:()=>null,saveManagedSearch:()=>{throw Error("fixture has no search mint");},
    },
    "scripts/lib/music-keys.mjs":{resolveMusicKey:()=>null},
  };
  const context=vm.createContext({console:quiet});
  const expose=record=>new vm.SyntheticModule(Object.keys(record),function(){for(const [k,v] of Object.entries(record))this.setExport(k,v);},{context});
  const implemented=new vm.SourceTextModule(settingsSource,{context});
  await implemented.link(path=>{
    if(path==="./paths.mjs")return expose({runtimeLib:async key=>{assert.ok(libs[key]);return libs[key];}});
    if(path==="./connect.mjs")return expose({managedAccountConnectCapability:()=>managedAccountConnectCapability({})});
    throw Error("unexpected settings fixture import "+path);
  });
  await implemented.evaluate();
  const settings=implemented.namespace.createSettingsHandlers({dataDir:()=>dir,supervisor,beforeRestart:async()=>apply()});
  async function connect(profile,mintOk=true){
    const got=await connectAccount({
      baseUrl:origin,open:async url=>{assert.equal(new URL(url).origin,origin);},
      close:()=>{},signInDeadlineMs:1,pollMs:1,operationTimeoutMs:100,
      evaluate:async script=>{
        if(script===MINT_SCRIPT)return mintOk?{status:200,body:{ok:true,token:"fixture-lease-"+(++mintCount),baseUrl:origin+"/v1"}}:{status:503,body:{code:"not_configured"}};
        if(script===SEARCH_MINT_SCRIPT)return {status:503,body:{code:"not_configured"}};
        assert.equal(script,PROFILE_SCRIPT);
        return profile?{status:200,user:profile}:{status:503,user:null};
      },
    });
    if(got.ok){const change=await settings.saveInference({provider:"beezilla",key:got.token,baseUrl:got.baseUrl},{onCommitted:()=>save(got.account),search:null});assert.equal(change.restarted,true);}
    return got;
  }
  await spawnLocal();
  return {connect,settings,owner:readOwner,file,logs,boots:()=>boots,storedLease:()=>credential?.key,
    rejectIdentityWrites(shouldReject){rejectIdentityWrites=shouldReject;},
    async restart(){apply();await spawnLocal();},env};
}

test("local Profile adopts the successful linked identity and keeps it through BYOK and Remove key",async t=>{
  const f=await setup(t);
  assert.deepEqual(await f.owner(),generic);
  assert.equal((await f.connect(alpha)).ok,true);
  assert.deepEqual(await f.owner(),alpha);
  assert.equal((await f.settings.saveInference({provider:"byok",key:"synthetic-byok-only"})).status.inference.provider,"byok");
  assert.deepEqual(await f.owner(),alpha);
  assert.equal((await f.settings.clear("inference")).status.inference,null);
  assert.deepEqual(await f.owner(),alpha);
  assert.equal((await f.connect(beta,false)).ok,false,"failed Connect cannot alter local identity");
  assert.deepEqual(await f.owner(),alpha);
  assert.equal(f.boots(),3,"link, BYOK and Remove key are the only settings restarts");
});

test("a successful different account with a blank name cannot keep the prior account's name",async t=>{
  const f=await setup(t);
  await f.connect(alpha);
  assert.deepEqual(await f.owner(),alpha);
  assert.deepEqual((await f.connect({...beta,name:""})).account,{name:"",email:beta.email});
  assert.deepEqual(await f.owner(),{name:generic.name,email:beta.email});
});

test("a successful replacement connection with unavailable profile returns to local owner, not the prior account",async t=>{
  const f=await setup(t);
  await f.connect(alpha);
  const connection=await f.connect(null);
  assert.equal(connection.ok,true);
  assert.equal(connection.account,undefined);
  assert.deepEqual(await f.owner(),generic);
  await f.restart();
  assert.deepEqual(await f.owner(),generic,"fallback survives another boot");
});

for(const backup of ["missing","corrupt"]){
  test(`restoring a ${backup} display-identity backup withdraws only launcher-injected overrides`,async t=>{
    const manual={name:"Fixture Explicit Local",email:"explicit@example.invalid"};
    const f=await setup(t,{[names[0]]:manual.name,[names[1]]:manual.email});
    assert.deepEqual(await f.owner(),manual);
    await f.connect(alpha);
    assert.deepEqual(await f.owner(),alpha);
    if(backup==="missing")rmSync(f.file);else writeFileSync(f.file,"{not JSON: private marker");
    await f.restart();
    assert.deepEqual(await f.owner(),manual);
    assert.ok(f.logs.every(line=>!line.includes(alpha.email)&&!line.includes("private marker")));
  });
}

test("valid Beta identity replaces both fields and survives a later key switch",async t=>{
  const f=await setup(t);
  await f.connect(alpha);await f.connect(beta);
  assert.deepEqual(await f.owner(),beta);
  await f.settings.saveInference({provider:"byok",key:"synthetic-switch-only"});
  assert.deepEqual(await f.owner(),beta);
});

for(const profile of [beta,null]){
  test(`a failed sidecar write cannot reload the prior account after a replacement with ${profile?"a known profile":"no profile"}`,async t=>{
    const f=await setup(t);
    await f.connect(alpha);
    assert.deepEqual(await f.owner(),alpha);
    const oldLease=f.storedLease();
    const oldDisk=readFileSync(f.file,"utf8");

    f.rejectIdentityWrites(true);
    assert.equal((await f.connect(profile)).ok,true);
    assert.ok(f.storedLease()!==oldLease,"the replacement credential committed");
    assert.equal(f.boots(),2,"both Connect attempts restarted the local runtime");
    assert.equal(readFileSync(f.file,"utf8"),oldDisk,"simulated EACCES left the previous sidecar intact");
    assert.deepEqual(await f.owner(),profile??generic);
    await f.settings.saveInference({provider:"byok",key:"fixture-independent-key"});
    assert.deepEqual(await f.owner(),profile??generic,"another same-launcher restart cannot restore the old sidecar");
    assert.ok(f.logs.some(line=>line.includes("could not save identity.json")));
    assert.ok(f.logs.every(line=>!line.includes(alpha.email)&&!line.includes(beta.email)&&!line.includes("fixture-private-path")));
  });
}

test("a successful later write clears the lifetime fallback and returns to the disk-backed path",async t=>{
  const f=await setup(t);
  await f.connect(alpha);
  f.rejectIdentityWrites(true);
  await f.connect(null);
  assert.deepEqual(await f.owner(),generic);
  f.rejectIdentityWrites(false);
  await f.connect(beta);
  assert.deepEqual(await f.owner(),beta);
  assert.equal(JSON.parse(readFileSync(f.file,"utf8")).email,beta.email);
  rmSync(f.file); // Only the fixture-owned file; models an absent sidecar.
  await f.restart();
  assert.deepEqual(await f.owner(),generic);
});
