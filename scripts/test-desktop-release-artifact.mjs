/**
 * Exercise the real release entry point offline, inside a disposable fixture.
 * Git and gh calls are captured, never executed. The synthetic .exe is text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const name = "BeeZilla-Setup-0.0.1.exe";
const file = Buffer.from("test artifact");
const sha = createHash("sha256").update(file).digest("hex");
const release = new URL("../desktop/release.mjs", import.meta.url);

function run(t, assets, prerelease = true, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beezilla-release-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "desktop")); mkdirSync(join(dir, "dist-desktop"));
  copyFileSync(release, join(dir, "desktop", "release.mjs"));
  writeFileSync(join(dir, "desktop", "package.json"), '{"version":"0.0.1"}');
  writeFileSync(join(dir, "dist-desktop", name), file);
  writeFileSync(join(dir, "publishers.json"), '{"publishers":[{"keyId":"fixture-dev"}]}');
  // All git/gh processes are replaced before release.mjs can import execFileSync.
  // No executable can be found through the child's PATH even on a fixture error.
  writeFileSync(join(dir, "mock.cjs"), `
    const cp = require("node:child_process"), fs = require("node:fs");
    const assets=JSON.parse(process.env.BZ_FIXTURE_ASSETS);
    const prerelease=process.env.BZ_FIXTURE_PRE==="true";
    cp.execFileSync = (cmd, args) => {
      fs.appendFileSync(process.env.BZ_FIXTURE_LOG,JSON.stringify([cmd,...args])+"\\n");
      if(cmd==="git" && args.includes("rev-parse")) return args.includes("--abbrev-ref") ? "fixture" : "00abcde";
      if(cmd==="git" && args.includes("status")) return "";
      if(cmd==="git" && args.includes("--list")) return "desktop-v0.0.1";
      if(cmd==="gh" && args[0]==="release" && args[1]==="view"){
        if (process.env.BZ_FIXTURE_LOOKUP === "forbidden") throw Object.assign(Error("lookup failed"),{stderr:"HTTP 403: forbidden"});
        if (process.env.BZ_FIXTURE_LOOKUP === "missing") throw Object.assign(Error("lookup failed"),{stderr:"release not found"});
        if (process.env.BZ_FIXTURE_LOOKUP === "invalid") return "{}";
        if(args.includes("--json")) return JSON.stringify({assets, isPrerelease:prerelease, url:"fixture://release"});
        return "";
      }
      if(cmd==="gh" && args[0]==="release" && ["create","upload"].includes(args[1])) return "";
      if(cmd==="gh" && args[0]==="api" && args[1].endsWith("/releases/tags/desktop-v0.0.1"))
        return JSON.stringify({assets, prerelease, html_url:"fixture://release"});
      throw Error("Unexpected fixture command: "+[cmd,...args].join(" "));
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const proc = spawnSync(process.execPath, ["--require", join(dir,"mock.cjs"), join(dir,"desktop","release.mjs"), "--skip-build", "--allow-dev-pin"], {
    cwd: dir, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PATH: join(dir,"no-executables"), BZ_RECIPE_PUBLISHER_FILE: join(dir,"publishers.json"),
      NODE_OPTIONS:"", BZ_FIXTURE_LOG:join(dir,"calls.txt"), BZ_FIXTURE_PRE:String(prerelease), BZ_FIXTURE_ASSETS:JSON.stringify(assets), ...opts }
  });
  assert.ifError(proc.error);
  const calls = readFileSync(join(dir,"calls.txt"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  return { code: proc.status, text: proc.stdout+proc.stderr, calls };
}
test("source release entry verifies exact remote asset bytes by digest", t=>{
  const result = run(t,[{name,size:file.length,digest:"sha256:"+sha}]);
  assert.equal(result.code,0,result.text); assert.match(result.text,/verified on GitHub/i);
});
test("source release entry rejects different bytes of the same size", t=>{
  const other = createHash("sha256").update(Buffer.alloc(file.length,1)).digest("hex");
  const result=run(t,[{name,size:file.length,digest:"sha256:"+other}]);
  assert.notEqual(result.code,0,result.text); assert.doesNotMatch(result.text,/verified on GitHub/i);
});
for (const digest of [undefined,null,"sha256:","md5:"+sha]) {
  test("source release entry rejects unavailable or malformed digest: "+digest,t=>{
    const result=run(t,[{name,size:file.length,digest}]);
    assert.notEqual(result.code,0,result.text); assert.doesNotMatch(result.text,/verified on GitHub/i);
  });
}
test("source release entry still rejects size mismatch",t=>{
  const result=run(t,[{name,size:file.length+1,digest:"sha256:"+sha}]);
  assert.notEqual(result.code,0,result.text); assert.match(result.text,/size/i);
});
test("unrelated asset with the expected digest cannot stand in for the installer",t=>{
  const result=run(t,[{name:"another.exe",size:file.length,digest:"sha256:"+sha}]);
  assert.notEqual(result.code,0,result.text);assert.doesNotMatch(result.text,/verified on GitHub/i);
});

const expected = [{name,size:file.length,digest:"sha256:"+sha}];
const changed = ([cmd,...args]) =>
  cmd==="gh" && args[0]==="release" && ["create","upload","edit","delete"].includes(args[1]) ||
  cmd==="git" && (args.includes("push") || (args.includes("tag") && !args.includes("--list")));
test("a dev build cannot clobber a stable release even if its size and digest match", t=>{
  const r=run(t,expected,false); assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/channel mismatch/i); assert.deepEqual(r.calls.filter(changed),[]);
});
for (const lookup of ["forbidden","invalid"]) {
  test("an inconclusive channel lookup ("+lookup+") fails before git or release mutations",t=>{
    const r=run(t,expected,true,{BZ_FIXTURE_LOOKUP:lookup});
    assert.notEqual(r.code,0,r.text); assert.deepEqual(r.calls.filter(changed),[]);
  });
}
test("a missing release is created as a prerelease rather than clobbered",t=>{
  const r=run(t,expected,true,{BZ_FIXTURE_LOOKUP:"missing"});
  assert.equal(r.code,0,r.text);
  const writes=r.calls.filter(changed); assert.equal(writes.length,1);
  assert.deepEqual(writes[0].slice(0,3),["gh","release","create"]); assert.ok(writes[0].includes("--prerelease"));
});
