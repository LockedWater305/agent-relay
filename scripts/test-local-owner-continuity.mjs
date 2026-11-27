// Run exact local identity, Connect, Settings, and H3 session code without Electron,
// providers, real accounts, or a DB. Disk writes are synthetic temporary identity records.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as inference from "./lib/inference.mjs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
assert.match(main,/connectedOwner:\s*outcome.account/);
assert.match(main,/beforeRestart:[\s\S]*?await applyIdentityToEnv\(\)/);
const identity=main.slice(start,end);
const alpha={name:"Fixture Alpha",email:"alpha@example.invalid"};
const beta={name:"Fixture Beta",email:"beta@example.invalid"};
const generic={name:"Owner",email:"owner@beezilla.local"};
const origin="http://127.0.0.1:8090";
const localToken="fixture-only-local-launch-token";
const names=["BZ_LOCAL_OWNER_NAME","BZ_LOCAL_OWNER_EMAIL"];
const testKey=Buffer.alloc(32,0x51); // Fixture only, never an app credential.
const encrypt=value=>{
  const iv=randomBytes(12);
  const aead=createCipheriv("aes-256-gcm",testKey,iv);
  return Buffer.concat([iv,aead.update(value,"utf8"),aead.final(),aead.getAuthTag()]);
};
const decrypt=value=>{
  const aead=createDecipheriv("aes-256-gcm",testKey,value.subarray(0,12));
  aead.setAuthTag(value.subarray(-16));
  return Buffer.concat([aead.update(value.subarray(12,-16)),aead.final()]).toString("utf8");
};
const secured={encrypt,encryptOwner:encrypt,decrypt};
const compile=path=>ts.transpileModule(read(path),{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
const localSource=compile("src/lib/local-owner.ts");
const authSource=compile("src/lib/auth-api.nitro.ts");
const load=(text,env,deps)=>{
  const exports={};
  vm.runInNewContext(text,{exports,process:{env},Request,Response,Headers,URL,Buffer,console,
    require(name){assert.ok(Object.hasOwn(deps,name),"closed fixture dependency: "+name);return deps[name];}});
  return exports;
};
async function setup(t, explicit={}, {cipher=secured, seeded}={}){
  const dir=mkdtempSync(join(tmpdir(),"bz-local-owner-fixture-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,"identity.json");
  if(seeded)writeFileSync(file,JSON.stringify(seeded));
  const stored=join(dir,"inference.json");
  const logs=[];
  const quiet={log:(...items)=>logs.push(items.join(" ")),warn:(...items)=>logs.push(items.join(" "))};
  let env, boots=0, persistedRow, app, mintCount=0, rejectDecrypt=false;
  const supervisor={dataDir:dir,runtime:{port:8090},async isHealthy(){return true;},async stop(){},async start(){
    boots++;
    await spawnLocal();
    return this.runtime;
  }};
  const newLauncher=()=>{
    env={...explicit};
    const launcher=vm.createContext({supervisor,process:{env},join,readFileSync,console:quiet,Buffer,
      runtimeLib:async()=>inference,safeStorage:{decryptString(value){
        if(rejectDecrypt)throw Error("fixture unavailable");
        return decrypt(value);
      }},
    });
    vm.runInContext(identity,launcher);
    return vm.runInContext("applyIdentityToEnv",launcher);
  };
  let apply=newLauncher();
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
    "scripts/lib/inference.mjs":inference,
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
  const settings=implemented.namespace.createSettingsHandlers({dataDir:()=>dir,supervisor,cipher,beforeRestart:async()=>apply()});
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
    if(got.ok){const change=await settings.saveInference({provider:"beezilla",key:got.token,baseUrl:got.baseUrl},{connectedOwner:got.account,search:null});assert.equal(change.restarted,true);}
    return got;
  }
  await apply();await spawnLocal();
  return {dir,connect,settings,owner:readOwner,file,stored,logs,boots:()=>boots,
    loseDecrypt(){rejectDecrypt=true;},
    async relaunch(){apply=newLauncher();await apply();await spawnLocal();},
  };
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
  await f.relaunch();
  assert.deepEqual(await f.owner(),generic,"fallback survives another boot");
});

for(const backup of ["missing","corrupt"]){
  test(`restoring a ${backup} display-identity backup withdraws only launcher-injected overrides`,async t=>{
    const manual={name:"Fixture Explicit Local",email:"explicit@example.invalid"};
    const f=await setup(t,{[names[0]]:manual.name,[names[1]]:manual.email},{seeded:alpha});
    assert.deepEqual(await f.owner(),alpha);
    if(backup==="missing")rmSync(f.file);else writeFileSync(f.file,"{not JSON: private marker");
    await f.relaunch();
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


test("legacy survives BYOK and Remove, then new Alpha -> BYOK/Remove -> Beta -> unavailable consistently relaunches",async t=>{
  const f=await setup(t,{}, {seeded:{name:"Fixture Legacy",email:"legacy@example.invalid"}});
  const legacy=await f.owner();
  const untouched=readFileSync(f.file,"utf8");
  await f.settings.saveInference({provider:"byok",key:"fixture-byok"});
  await f.settings.clear("inference");
  assert.ok(!existsSync(f.stored),"legacy clear still removes only old unmarked credential");
  await f.relaunch();
  assert.deepEqual(await f.owner(),legacy);

  await f.connect(alpha);
  const alphaMarker=inference.managedSearchConnection(f.dir);
  await f.settings.saveInference({provider:"byok",key:"fixture-independent-key"});
  assert.equal(inference.managedSearchConnection(f.dir),alphaMarker);
  await f.settings.clear("inference");
  assert.equal(inference.hasRemovableInference(f.dir),false);
  assert.equal(inference.managedSearchConnection(f.dir),alphaMarker);
  assert.equal(inference.loadInference(f.dir,secured),null);
  await f.relaunch();
  assert.deepEqual(await f.owner(),alpha);

  await f.connect(beta);
  assert.notEqual(inference.managedSearchConnection(f.dir),alphaMarker);
  await f.relaunch();
  assert.deepEqual(await f.owner(),beta);
  const raw=readFileSync(f.stored,"utf8");
  const protectedValue=JSON.parse(raw).connectedOwner;
  assert.equal(typeof protectedValue,"string");
  for(const value of [f.settings.status(),inference.loadInference(f.dir,secured),inference.resolveInference(f.dir,secured),inference.saveInference(f.dir,{provider:"byok",key:"fixture-later-key"},secured)]){
    const publicJson=JSON.stringify(value);
    for(const secret of [beta.name,beta.email,protectedValue,"connectedOwner"])assert.ok(!publicJson.includes(secret));
  }
  for(const fragment of [beta.name,beta.email,JSON.stringify(beta),Buffer.from(JSON.stringify(beta)).toString("base64")]){
    assert.ok(!raw.includes(fragment));
  }
  assert.equal(readFileSync(f.file,"utf8"),untouched,"legacy backup was not written or removed");
  await f.connect(null);
  assert.equal(JSON.parse(readFileSync(f.stored,"utf8")).connectedOwner,null);
  await f.relaunch();
  assert.deepEqual(await f.owner(),generic);
});

test("no protected identity encryption never writes plaintext or reopens the legacy owner",async t=>{
  const explicit={name:"Fixture Explicit",email:"explicit@example.invalid"};
  const env={[names[0]]:explicit.name,[names[1]]:explicit.email};
  const f=await setup(t,env,{cipher:{encrypt,decrypt},seeded:alpha});
  assert.deepEqual(await f.owner(),alpha);
  await f.connect(beta);
  assert.equal(JSON.parse(readFileSync(f.stored,"utf8")).connectedOwner,null);
  await f.relaunch();
  assert.deepEqual(await f.owner(),explicit);
});

test("protected identity encryption may fail independently without adopting stale plaintext",async t=>{
  const f=await setup(t,{}, {cipher:{encrypt,encryptOwner(){throw Error("private fixture marker");},decrypt},seeded:alpha});
  await f.connect(beta);await f.relaunch();
  assert.deepEqual(await f.owner(),generic);
  assert.equal(JSON.parse(readFileSync(f.stored,"utf8")).connectedOwner,null);
  assert.ok(f.logs.every(line=>!line.includes("private fixture marker")));
});

test("unavailable decryption of a bound profile does not reopen a valid legacy sidecar",async t=>{
  const f=await setup(t,{}, {seeded:alpha});
  await f.connect(beta);
  assert.deepEqual(await f.owner(),beta);
  f.loseDecrypt();
  await f.relaunch();
  assert.deepEqual(await f.owner(),generic);
  assert.match(readFileSync(f.file,"utf8"),/Fixture Alpha/);
});

test("a mismatched protected owner generation fails closed",async t=>{
  const f=await setup(t,{}, {seeded:alpha});
  await f.connect(beta);
  const raw=JSON.parse(readFileSync(f.stored,"utf8"));
  raw.managedConnectionId=randomUUID();
  writeFileSync(f.stored,JSON.stringify(raw));
  await f.relaunch();
  assert.deepEqual(await f.owner(),generic);
});

test("actual CLI diagnostics and key commands never expose connected display",async t=>{
  const f=await setup(t,{}, {seeded:alpha});
  await f.connect(beta);
  const expectedId=inference.managedSearchConnection(f.dir);
  const cli=fileURLToPath(new URL("../bin/beezilla.mjs",import.meta.url));
  const run=(...args)=>{
    const call=spawnSync(process.execPath,[cli,...args],{env:{PATH:process.env.PATH,BZ_DATA_DIR:f.dir},encoding:"utf8",timeout:5000});
    assert.equal(call.error,undefined);
    const output=call.stdout+call.stderr;
    const ownerCipher=JSON.parse(readFileSync(f.stored,"utf8")).connectedOwner;
    for(const fragment of [beta.name,beta.email,ownerCipher,"connectedOwner"].filter(Boolean))assert.ok(!output.includes(fragment));
    return {status:call.status,output};
  };
  assert.match(run("doctor").output,/inference configured/);
  assert.match(run("status").output,/not running/i);
  assert.match(run("key","show").output,/none configured/);
  assert.equal(run("key","set","--key","fixture-cli-byok-unencrypted").status,0);
  assert.equal(inference.managedSearchConnection(f.dir),expectedId);
  assert.match(run("key","show").output,/byok/);
  assert.equal(run("key","clear").status,0);
  assert.equal(inference.managedSearchConnection(f.dir),expectedId);
  await f.relaunch();
  assert.deepEqual(await f.owner(),beta);
  assert.equal(run("key","set","--provider","beezilla","--token","fixture-cli-managed-unverified").status,0);
  await f.relaunch();
  assert.deepEqual(await f.owner(),generic);
});
