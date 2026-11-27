/** Exact CLI/launcher path contract and foreground exit behavior. No network
 * or real packaged service starts. All data belongs to disposable fixtures.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bee-cli-serve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app=join(root,"installed app 雪","resources","app");
  const caller=join(root,"unrelated cwd");
  const data=join(root,"isolated data");
  for (const rel of [
    "bin/beezilla.mjs", "scripts/beezilla-local.mjs", "scripts/lib/inference.mjs",
    "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs",
  ]) {
    const out=join(app,rel);
    mkdirSync(dirname(out),{recursive:true});
    copyFileSync(new URL("../"+rel,import.meta.url),out);
  }
  const decoy=join(caller,".output","server","index.mjs");
  mkdirSync(dirname(decoy),{recursive:true});
  writeFileSync(decoy,'throw Error("the CLI must not use the caller cwd as its installed tree");');
  return { root, app, caller, data, launch:join(app,"scripts/beezilla-local.mjs") };
}

function run(f, flags=[]) {
  const result=spawnSync(process.execPath,[...flags,join(f.app,"bin/beezilla.mjs"),"serve","--port","7342"],{
    cwd:f.caller, encoding:"utf8", timeout:8000,
    env:{ PATH:join(f.root,"no-executables"), BZ_DATA_DIR:f.data,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT:process.env.SYSTEMROOT } : {}) },
  });
  assert.ifError(result.error);
  return result;
}

test("missing installed runtime from an unrelated cwd cannot return a successful serve exit",t=>{
  const f=fixture(t);
  const r=run(f);
  const expected=join(f.app,".output","server","index.mjs");
  assert.ok(r.stderr.includes("built server missing: "+expected),r.stderr);
  assert.equal(r.status,2,r.stdout+r.stderr);
  assert.ok(!existsSync(join(f.data,"runtime.json")));
});
for (const code of [0,19]) {
  test(`serve preserves launcher exit ${code} from its installed root`,t=>{
    const f=fixture(t);
    writeFileSync(f.launch,`
      if (process.cwd() !== ${JSON.stringify(f.app)}) process.exit(41);
      if (JSON.stringify(process.argv.slice(2)) !== '["--port","7342"]') process.exit(42);
      process.exit(${code});
    `);
    const r=run(f);
    assert.equal(r.status,code,r.stdout+r.stderr);
  });
}
test("serve reports a spawn refusal cleanly without an unhandled event",t=>{
  const f=fixture(t), preload=join(f.root,"no-child.cjs");
  writeFileSync(preload,`
    const { EventEmitter }=require("node:events");
    require("node:child_process").spawn=()=>{
      const child=new EventEmitter();
      queueMicrotask(()=>child.emit("error", new Error("fixture launcher denied")));
      return child;
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const r=run(f,["--require",preload]);
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/could not start.*fixture launcher denied/i);
  assert.doesNotMatch(r.stderr,/Unhandled 'error' event/i);
});
