/** Synthetic launchers only. The supervisor runs, but no server binds a port. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeSupervisor } from "../desktop/supervisor.mjs";

const pause = (ms) => new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t, known=true) {
  const root=mkdtempSync(join(tmpdir(),"bee-stop-ipc-")), dataDir=join(root,"data");
  const marker=join(dataDir,"stop-kind");
  mkdirSync(join(root,"scripts")); mkdirSync(dataDir);
  writeFileSync(join(root,"scripts","beezilla-local.mjs"),`
    import {writeFileSync} from "node:fs";
    const finish=kind=>{writeFileSync(${JSON.stringify(marker)},kind);process.exit(0)};
    process.on("SIGTERM",()=>finish("signal"));
    process.on("message",message=>{if(message?.type==="beezilla:stop")finish("ipc")});
    process.send({type:"beezilla:launcher-ready"});
    if (${known}) writeFileSync(${JSON.stringify(join(dataDir,"runtime.json"))},JSON.stringify({
      pid:process.pid,host:"127.0.0.1",port:7331,dataDir:${JSON.stringify(dataDir)},
      startedAt:new Date().toISOString(),token:"x".repeat(43)
    }));
    setInterval(()=>{},1000);
  `);
  const sup=new RuntimeSupervisor({root,dataDir});
  sup.probe=async()=>({ok:true}); // never attempts HTTP
  const children=[];
  t.after(async()=>{
    for (const child of children) {
      if (child?.exitCode!==null || child?.signalCode!==null || !child?.pid) continue;
      const exited=once(child,"exit");
      child.kill("SIGKILL"); // only fixtures started by this test
      await exited;
    }
    rmSync(root,{recursive:true,force:true});
  });
  const start=()=>{
    const task=sup.start({timeoutMs:3500});
    if (sup.child && !children.includes(sup.child)) children.push(sup.child);
    return task;
  };
  const starting=start();
  if (known) await starting;
  else {
    // Install the rejection handler immediately, before issuing stop.
    void starting.catch(()=>{});
    const deadline=Date.now()+2000;
    while (!sup.launch?.controlReady && Date.now()<deadline) await pause(10);
    assert.ok(sup.launch?.controlReady);
  }
  return {sup,start,starting,marker};
}
function failSendAsynchronously(child) {
  let calls=0;
  child.send=(_message,done)=>{
    calls++;
    queueMicrotask(()=>done(Object.assign(new Error("closed fixture IPC"),{code:"ERR_IPC_CHANNEL_CLOSED"})));
    return false;
  };
  return ()=>calls;
}
test("async IPC send failure falls back only to the launcher with known ownership, allowing restart",async t=>{
  const {sup,start,marker}=await fixture(t);
  const closed=failSendAsynchronously(sup.child);
  await sup.stop({timeoutMs:600});
  assert.equal(closed(),1);
  assert.equal(readFileSync(marker,"utf8"),"signal");
  assert.equal(sup.runtime,null);
  assert.ok((await start()).port);
  await sup.stop({timeoutMs:1200});
});
test("IPC backpressure is not a failed send; delivered stop uses IPC without a signal",async t=>{
  const {sup,marker}=await fixture(t);
  const original=sup.child.send.bind(sup.child);
  sup.child.send=(message,done)=>{original(message,done);return false;};
  await sup.stop({timeoutMs:1200});
  assert.equal(readFileSync(marker,"utf8"),"ipc");
});
test("failed IPC before ownership is known never signals the uncertain launcher",async t=>{
  const {sup,starting,marker}=await fixture(t,false);
  const closed=failSendAsynchronously(sup.child);
  const canceled=assert.rejects(starting,/canceled/i);
  await assert.rejects(sup.stop({timeoutMs:180}),/not stopped/i);
  await canceled;
  assert.ok(closed()>=1);
  assert.equal(existsSync(marker),false);
  assert.equal(sup.child.exitCode,null);
});
