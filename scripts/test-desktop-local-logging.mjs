// Disposable Node-only diagnostics fixtures; no Electron, provider, app, or native install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const asset = new URL("../desktop/logger.mjs", import.meta.url).href;
const limit = 2 * 1024 * 1024;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bz-local-logger-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const primary = path.join(root, "main.log");
  function run(extra = "") {
    const code = `
      import { installLogging, logLine, logPaths } from ${JSON.stringify(asset)};
      installLogging({version:" fixture"});
      ${extra}
      process.stdout.write("\\nreceipt:" + JSON.stringify(logPaths()));
    `;
    const child = spawnSync(process.execPath,["--input-type=module","-e",code],{
      env:{PATH:process.env.PATH,BZ_LOG_DIR:root}, encoding:"utf8",timeout:10000,
    });
    assert.equal(child.status,0,child.stdout+child.stderr);
    const line = child.stdout.split("\n").find(line=>line.startsWith("receipt:"));
    assert.ok(line,child.stdout);
    return JSON.parse(line.slice("receipt:".length));
  }
  return {root,primary,run};
}

test("startup rotation retains most recent history in .1, earlier history in .2", t=>{
  const f=fixture(t);
  const latest=Buffer.alloc(limit,65);
  const older=Buffer.from("prior retained log");
  fs.writeFileSync(f.primary,latest);
  fs.writeFileSync(f.primary+".1",older);
  fs.writeFileSync(f.primary+".2","expired log");
  const result=f.run();
  assert.equal(result.file,f.primary);
  assert.match(fs.readFileSync(f.primary,"utf8"),/session start/);
  const one=fs.readFileSync(f.primary+".1"),two=fs.readFileSync(f.primary+".2");
  assert.ok(one.equals(latest),`.1 wrong length: ${one.length} instead of ${latest.length}`);
  assert.ok(two.equals(older),`.2 wrong length: ${two.length} instead of ${older.length}`);
});

test("running logger rotates at the next append, without a restart", t=>{
  const f=fixture(t);
  f.run(`logLine("info",["oversized-marker:"+"x".repeat(${limit})]);
    logLine("info",["after-threshold"]); `);
  assert.ok(fs.existsSync(f.primary+".1"),"crossing the limit leaves a rollover on the next write");
  assert.match(fs.readFileSync(f.primary+".1","utf8"), /oversized-marker/);
  const active=fs.readFileSync(f.primary,"utf8");
  assert.match(active,/after-threshold/);
  assert.doesNotMatch(active,/oversized-marker/);
});

test("a non-file log destination is reported unavailable rather than advertised as main.log", t=>{
  const f=fixture(t);
  fs.mkdirSync(f.primary);
  const result=f.run('console.log("stdout still works");');
  assert.equal(result.dir,f.root);
  assert.equal(result.file,null,"do not point the startup error dialog at a directory");
  assert.equal(fs.lstatSync(f.primary).isDirectory(),true,"do not move or overwrite the invalid destination");
});

test("an ordinary existing small log keeps its content and accepts new lines",t=>{
  const f=fixture(t);fs.writeFileSync(f.primary,"older tail\n");
  const result=f.run('logLine("info",["new tail"]);');
  assert.equal(result.file,f.primary);
  const contents=fs.readFileSync(f.primary,"utf8");
  assert.match(contents,/^older tail\n/);
  assert.match(contents,/new tail/);
  assert.equal(fs.existsSync(f.primary+".1"),false);
});

test("a circular structured diagnostic that cannot be converted to a string never breaks logging",t=>{
  const f=fixture(t);
  f.run('const value=Object.create(null); value.self=value; logLine("info",[value]); logLine("info",["next diagnostic"]);');
  const text=fs.readFileSync(f.primary,"utf8");
  assert.match(text, /unprintable/);
  assert.match(text, /next diagnostic/);
});
