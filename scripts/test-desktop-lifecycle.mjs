#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { RuntimeSupervisor } from "../desktop/supervisor.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const dir = process.env.BZ_DATA_DIR;
mkdirSync(dir, {recursive:true});
appendFileSync(join(dir,'launches'), String(process.pid)+'\\n');
if (existsSync(join(dir,'exit-early'))) {
  process.send({type:'beezilla:runtime-not-started'},()=>process.exit(7));
} else if (existsSync(join(dir,'wait-forever'))) {
  process.on('message',message=>{
    if(message?.type==='beezilla:stop') process.send({type:'beezilla:runtime-not-started'},()=>process.exit(0));
  });
  process.send({type:'beezilla:launcher-ready'});
  setInterval(()=>{},1000);
} else {
  const server = createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});
  const previous = existsSync(join(dir,'previous-port')) ? Number(readFileSync(join(dir,'previous-port'),'utf8')) : 0;
  server.on('error', error => { if(error.code==='EADDRINUSE') server.listen(0,'127.0.0.1'); else throw error; });
  server.listen(previous && previous < 65535 ? previous+1 : 0,'127.0.0.1',()=>{
    const port=server.address().port;
    writeFileSync(join(dir,'previous-port'),String(port));
    writeFileSync(join(dir,'runtime.json'),JSON.stringify({pid:process.pid,host:'127.0.0.1',port,dataDir:dir,token:randomBytes(32).toString('base64url'),startedAt:new Date().toISOString()}));
  });
  process.on('SIGTERM',()=>{
    if(existsSync(join(dir,'ignore-stop'))) return;
    // HTTP is unavailable before the process/database flush is finished.
    server.closeAllConnections(); server.close();
    setTimeout(()=>{writeFileSync(join(dir,'flushed'),String(process.pid));rmSync(join(dir,'runtime.json'),{force:true});process.exit(0);},200);
  });
}
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bz-lifecycle-"));
  mkdirSync(join(root, "scripts"));
  const dir = join(root, "data");
  mkdirSync(dir);
  writeFileSync(join(root, "scripts", "beezilla-local.mjs"), fixture);
  const messages = [];
  const sup = new RuntimeSupervisor({ root, dataDir: dir, onLog: (line) => messages.push(line) });
  return { root, dir, sup, messages };
}

async function cleanup({ root, dir, sup, savedPort }) {
  // These are test-owned fake runtimes only, never the app's real data store.
  if (sup.child && sup.child.exitCode === null && sup.child.signalCode === null) {
    const child = sup.child;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  // Separate-process fixtures can deliberately outlive their launcher.
  if (dir && existsSync(join(dir, "server-pids"))) {
    for (const line of readFileSync(join(dir, "server-pids"), "utf8").trim().split("\n")) {
      const pid = Number(line);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
  if (savedPort) {
    if (savedPort.value === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort.value;
  }
  rmSync(root, { recursive: true, force: true });
}

test("concurrent startup, default health, graceful stop and changed-port restart", async () => {
  const ctx = setup();
  const { sup, dir } = ctx;
  try {
    const [first, duplicate] = await Promise.all([sup.start({ timeoutMs: 3000 }), sup.start({ timeoutMs: 3000 })]);
    assert.equal(first, duplicate);
    assert.equal(readFileSync(join(dir, "launches"), "utf8").trim().split("\n").length, 1);
    assert.equal(await sup.isHealthy(), true);
    const oldChild = sup.child;
    await Promise.all([sup.stop({ timeoutMs: 3000 }), sup.stop({ timeoutMs: 3000 })]);
    assert.equal(readFileSync(join(dir, "flushed"), "utf8"), String(oldChild.pid));
    assert.equal(existsSync(join(dir, "runtime.json")), false);
    assert.equal(await sup.isHealthy(), false);
    const second = await sup.start({ timeoutMs: 3000 });
    assert.notEqual(second.token, first.token);
    assert.notEqual(second.port, first.port);
    assert.equal(sup.stopping, false);
    // Simulate a delayed event from an old generation.
    oldChild.emit("exit", 0);
    assert.equal(sup.runtime, second);
    assert.equal(await sup.isHealthy(), true);
    await sup.stop({ timeoutMs: 3000 });
    assert.equal(ctx.messages.some((line) => line.includes("unexpectedly")), false);
  } finally { await cleanup(ctx); }
});

const separateServer = `
import { createServer } from 'node:http';
import { appendFileSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.env.BZ_DATA_DIR;
appendFileSync(join(dir,'server-pids'),String(process.pid)+'\\n');
const server=createServer((_req,res)=>{res.writeHead(existsSync(join(dir,'not-ready'))?503:200);res.end('{"ok":true}');});
server.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>{
  writeFileSync(join(dir,'stop-seen'),String(process.pid));
  server.closeAllConnections();server.close();
  setTimeout(()=>{writeFileSync(join(dir,'flushed'),String(process.pid));process.exit(0);},Number(readFileSync(join(dir,'flush-ms'),'utf8')));
});
writeFileSync(join(dir,'server-ready'),String(process.pid));
`;

async function setupSeparate({ ready = true, flushMs = 5000 } = {}) {
  const ctx = setup();
  // Exercise the ACTUAL launcher protocol, not a launcher=server approximation.
  cpSync(new URL("./beezilla-local.mjs", import.meta.url), join(ctx.root, "scripts", "beezilla-local.mjs"));
  cpSync(new URL("./lib", import.meta.url), join(ctx.root, "scripts", "lib"), { recursive: true });
  // This regression deliberately keeps the grandchild alive after launcher
  // exit. Disable only the fixture's orphan watchdog so it cannot hide the race.
  writeFileSync(join(ctx.root, "scripts", "lib", "parent-watchdog.cjs"), "// intentional test fixture\n");
  const output = join(ctx.root, ".output", "server");
  mkdirSync(join(output, "_libs"), { recursive: true });
  for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) writeFileSync(join(output, "_libs", name), "fixture");
  writeFileSync(join(output, "index.mjs"), separateServer);
  writeFileSync(join(ctx.dir, "flush-ms"), String(flushMs));
  if (!ready) writeFileSync(join(ctx.dir, "not-ready"), "1");
  const { createServer } = await import("node:net");
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  ctx.savedPort = { value: process.env.PORT };
  process.env.PORT = String(port);
  return ctx;
}

async function until(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), message);
}

for (const ready of [true, false]) {
  test(`separate server stays owned through cancellation ${ready ? "during a failed readiness probe" : "before runtime.json exists"}`, async () => {
    const ctx = await setupSeparate({ ready });
    const { sup, dir } = ctx;
    const originalProbe = sup.probe;
    let probing = false;
    sup.probe = async (rt) => {
      probing = true;
      await delay(250);
      return { ok: false, error: "held by regression", code: null, ms: 250, rt };
    };
    const starting = sup.start({ timeoutMs: 15_000 });
    const canceled = assert.rejects(starting, /canceled/);
    try {
      await until(() => existsSync(join(dir, "server-ready")) && Boolean(sup.launch?.serverPid), "server installs its flush handler before cancellation");
      const oldPid = Number(readFileSync(join(dir, "server-pids"), "utf8").trim());
      assert.notEqual(oldPid, sup.child.pid, "launcher and server are separate processes");
      assert.equal(sup.runtime, null);
      if (ready) await until(() => probing, "supervisor entered delayed readiness probe");
      else assert.equal(existsSync(sup.runtimeFile), false);
      await assert.rejects(sup.stop({ timeoutMs: 3700 }), /database process has not stopped/);
      await canceled;
      assert.equal(existsSync(sup.runtimeFile), false);
      process.kill(oldPid, 0); // Still flushing after the launcher's bounded exit.
      assert.equal(sup.exitingPid, oldPid);
      sup.probe = originalProbe;
      await assert.rejects(sup.start({ timeoutMs: 2000 }), /still stopping/);
      assert.equal(readFileSync(join(dir, "server-pids"), "utf8").trim().split("\n").length, 1);
    } finally { await cleanup(ctx); await starting.catch(() => {}); }
  });
}

test("separate server exit notification releases cancellation and permits a safe retry", async () => {
  const ctx = await setupSeparate({ ready: false, flushMs: 150 });
  const starting = ctx.sup.start({ timeoutMs: 15_000 });
  const canceled = assert.rejects(starting, /canceled/);
  try {
    await until(() => existsSync(join(ctx.dir, "server-ready")) && Boolean(ctx.sup.launch?.serverPid), "server installs its flush handler before cancellation");
    await ctx.sup.stop({ timeoutMs: 3000 });
    await canceled;
    assert.equal(ctx.sup.exitingPid, null);
    assert.ok(existsSync(join(ctx.dir, "flushed")));
    rmSync(join(ctx.dir, "not-ready"));
    assert.ok((await ctx.sup.start({ timeoutMs: 3000 })).port);
    await ctx.sup.stop({ timeoutMs: 3000 });
    assert.equal(readFileSync(join(ctx.dir, "server-pids"), "utf8").trim().split("\n").length, 2);
  } finally { await cleanup(ctx); await starting.catch(() => {}); }
});

test("immediate stop waits for launcher ownership before allowing another start", async () => {
  const ctx = await setupSeparate({ ready: false, flushMs: 150 });
  const { sup, dir } = ctx;
  const starting = sup.start({ timeoutMs: 15_000 });
  const canceled = assert.rejects(starting, /canceled/);
  try {
    assert.equal(sup.launch.controlReady, false);
    assert.equal(sup.launch.serverPid, null);
    await sup.stop({ timeoutMs: 3000 });
    await canceled;
    assert.equal(sup.shutdownUncertain, false);
    assert.equal(sup.exitingPid, null);
    assert.equal(sup.launch, null);
    assert.equal(existsSync(sup.runtimeFile), false);
    // Either the launcher acknowledged that no child was started, or stop
    // retained the child's ownership through its verified exit.
    const previousPids = existsSync(join(dir, "server-pids"))
      ? readFileSync(join(dir, "server-pids"), "utf8").trim().split("\n").map(Number) : [];
    for (const pid of previousPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    rmSync(join(dir, "not-ready"));
    assert.ok((await sup.start({ timeoutMs: 3000 })).port);
    await sup.stop({ timeoutMs: 3000 });
  } finally { await cleanup(ctx); await starting.catch(() => {}); }
});

test("startup failure is prompt, cleans up and can be retried", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.dir, "exit-early"), "1");
    const started = Date.now();
    await assert.rejects(ctx.sup.start({ timeoutMs: 3000 }), /exited during startup/);
    assert.ok(Date.now() - started < 1500);
    assert.equal(ctx.sup.child, null);
    rmSync(join(ctx.dir, "exit-early"));
    assert.ok((await ctx.sup.start({ timeoutMs: 3000 })).port);
    await ctx.sup.stop({ timeoutMs: 3000 });
  } finally { await cleanup(ctx); }
});

test("stop cancels a startup without waiting for the readiness deadline", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.dir, "wait-forever"), "1");
    const starting = ctx.sup.start({ timeoutMs: 20_000 });
    const rejected = assert.rejects(starting, /canceled/);
    await delay(120);
    const beforeStop = Date.now();
    await ctx.sup.stop({ timeoutMs: 3000 });
    await rejected;
    assert.ok(Date.now() - beforeStop < 1500);
    rmSync(join(ctx.dir, "wait-forever"));
    assert.ok((await ctx.sup.start({ timeoutMs: 3000 })).port);
    await ctx.sup.stop({ timeoutMs: 3000 });
  } finally { await cleanup(ctx); }
});

test("a stop timeout never starts a second runtime over a live database", async () => {
  const ctx = setup();
  try {
    writeFileSync(join(ctx.dir, "ignore-stop"), "1");
    await ctx.sup.start({ timeoutMs: 3000 });
    const pid = ctx.sup.child.pid;
    await assert.rejects(ctx.sup.stop({ timeoutMs: 50 }), /has not stopped/);
    await assert.rejects(ctx.sup.start({ timeoutMs: 3000 }), /still stopping/);
    assert.equal(ctx.sup.child.pid, pid);
    assert.equal(readFileSync(join(ctx.dir, "launches"), "utf8").trim().split("\n").length, 1);
    rmSync(join(ctx.dir, "ignore-stop"));
    await ctx.sup.stop({ timeoutMs: 3000 });
  } finally { await cleanup(ctx); }
});

test("invalid handshakes cannot point at remote hosts or another data directory", async () => {
  const ctx = setup();
  const valid = { pid: process.pid, host: "127.0.0.1", port: 7331, dataDir: ctx.dir, token: "x".repeat(43), startedAt: new Date().toISOString() };
  try {
    for (const patch of [{ host: "evil.example" }, { host: "0.0.0.0" }, { token: "short" }, { port: -1 }, { dataDir: tmpdir() }, { startedAt: "invalid" }]) {
      writeFileSync(ctx.sup.runtimeFile, JSON.stringify({ ...valid, ...patch }));
      assert.equal(ctx.sup.readRuntimeFile(), null);
    }
    writeFileSync(ctx.sup.runtimeFile, JSON.stringify(valid));
    await ctx.sup.stop(); // Must NOT signal the unowned PID in this file.
    assert.ok(existsSync(ctx.sup.runtimeFile));
    await assert.rejects(ctx.sup.start({ timeoutMs: 3000 }), /Another local runtime/);
    assert.equal(ctx.sup.child, null);
  } finally { await cleanup(ctx); }
});
