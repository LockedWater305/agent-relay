// Launches only disposable Node programs under temp. No Electron, hosted API,
// production data or installer.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeSupervisor } from "../desktop/supervisor.mjs";

function fixture(t, src) {
  const root=mkdtempSync(join(tmpdir(),"bz-launch-diagnostics-")), dataDir=join(root,"data");
  mkdirSync(join(root,"scripts")); mkdirSync(dataDir);
  writeFileSync(join(root,"scripts/beezilla-local.mjs"),src);
  const logs=[];
  const sup=new RuntimeSupervisor({root,dataDir,onLog:l=>logs.push(l)});
  t.after(()=>{
    // This child is a test-owned disposable Node program only.
    if (sup.child?.exitCode === null && sup.child?.signalCode === null) sup.child.kill("SIGKILL");
    rmSync(root,{force:true,recursive:true});
  });
  return {sup,logs,dataDir};
}

test("OS failure before spawn includes the actual Node launch error", async t=>{
  const {sup}=fixture(t,"throw new Error('must not run');");
  // Use a path that cannot be an executable, not a fake running process.
  const desc=Object.getOwnPropertyDescriptor(process,"execPath");
  Object.defineProperty(process,"execPath",{...desc,value:join(sup.dataDir,"absent-node")});
  try {
    await assert.rejects(sup.startOwned({},new AbortController().signal), /Could not start the local runtime: .*ENOENT/);
  } finally {
    Object.defineProperty(process,"execPath",desc);
  }
});

for (const signal of [null,"SIGTERM"]) {
  test(`launcher exit diagnostic distinguishes ${signal||"exit code"}`, {skip:process.platform==="win32"&&signal}, async t=>{
    const tail=signal ? `process.kill(process.pid, "${signal}")` : "process.exit(7)";
    const {sup,logs}=fixture(t,`process.send({type:"beezilla:runtime-not-started"},()=>${tail});`);
    await assert.rejects(sup.start({timeoutMs:2500}),/exited during startup/);
    const line=logs.find(s=>s.includes("exited unexpectedly"));
    assert.ok(line,logs.join("\n"));
    if (signal) { assert.match(line,/signal SIGTERM/); assert.doesNotMatch(line,/code null/); }
    else assert.match(line,/code 7/);
  });
}

const idle=`
  process.send({type:"beezilla:launcher-ready"});
  process.on("message", msg=>{
    if (msg?.type==="beezilla:stop") process.send({type:"beezilla:runtime-not-started"},()=>process.exit(0));
  });
`;
const responding=`
  import {createServer} from "node:http";
  import {writeFileSync} from "node:fs";
  import {join} from "node:path";
  const dataDir=process.env.BZ_DATA_DIR;
  const server=createServer((req,res)=>{res.writeHead(503);res.end("fixture not ready");});
  server.listen(0,"127.0.0.1",()=>{
    writeFileSync(join(dataDir,"runtime.json"), JSON.stringify({
      host:"127.0.0.1",port:server.address().port,dataDir,pid:process.pid,
      token:"X".repeat(43),startedAt:new Date().toISOString()
    }));
  });
  process.on("SIGTERM",()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
`;
test("HTTP 503 is described as a responding runtime, not a blocked local connection",async t=>{
  const {sup}=fixture(t,responding);
  await assert.rejects(sup.start({timeoutMs:700}),err=>{
    assert.match(err.message,/HTTP 503/);
    assert.match(err.message,/responded|received an HTTP response/i);
    assert.doesNotMatch(err.message,/firewall|antivirus|BZ_SKIP_READY_PROBE/);
    return true;
  });
});

test("timeout before an endpoint exists does not advertise a network or readiness bypass",async t=>{
  const {sup}=fixture(t,idle);
  await assert.rejects(sup.start({timeoutMs:400}),err=>{
    assert.match(err.message,/runtime.json absent/);
    assert.match(err.message,/has not announced|has not announced an endpoint/i);
    assert.doesNotMatch(err.message,/firewall|antivirus|BZ_SKIP_READY_PROBE/);
    return true;
  });
});
