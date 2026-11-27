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
  if (opts.BZ_FIXTURE_EXISTING !== "none") writeFileSync(join(dir, "dist-desktop", name), file);
  writeFileSync(join(dir, "publishers.json"), JSON.stringify({publishers:[{keyId:opts.BZ_FIXTURE_PIN ?? "fixture-dev"}]}));
  writeFileSync(join(dir, "calls.txt"), "");
  const relativePins = opts.BZ_FIXTURE_RELATIVE_PIN === "1";
  const caller = relativePins ? join(dir,"different-cwd") : dir;
  if (relativePins) {
    mkdirSync(caller);
    writeFileSync(join(caller,"publishers.json"),JSON.stringify({publishers:[{keyId:"fixture-production"}]}));
    writeFileSync(join(dir,"publishers.json"),JSON.stringify({publishers:[{keyId:"fixture-dev"}]}));
  }
  // All git/gh processes are replaced before release.mjs can import execFileSync.
  // No executable can be found through the child's PATH even on a fixture error.
  writeFileSync(join(dir, "mock.cjs"), `
    const cp = require("node:child_process"), fs = require("node:fs");
    const assets=JSON.parse(process.env.BZ_FIXTURE_ASSETS);
    let built=false;
    const prerelease=process.env.BZ_FIXTURE_PRE==="true";
    cp.execFileSync = (cmd, args, options) => {
      fs.appendFileSync(process.env.BZ_FIXTURE_LOG,JSON.stringify([cmd,...args])+"\\n");
      if((cmd==="node" || cmd===process.execPath) && args[1]==="all"){
        const path=require("node:path");
        const pins=(options.env ?? process.env).BZ_RECIPE_PUBLISHER_FILE;
        const staged=process.env.BZ_FIXTURE_STAGED_PINS;
        fs.writeFileSync(process.env.BZ_FIXTURE_BUILD_OUTPUT, "test artifact");
        fs.mkdirSync(path.dirname(staged),{recursive:true});
        fs.writeFileSync(staged,process.env.BZ_FIXTURE_SWAPPED_PINS==="1"
          ? JSON.stringify({publishers:[{keyId:"fixture-dev"}]})
          : fs.readFileSync(path.resolve(options.cwd,pins)));
        built=true;return "";
      }
      if(cmd==="git" && args.includes("rev-parse")) {
        if(args.includes("--abbrev-ref")) return "fixture";
        if(args.includes("--verify")) return built && process.env.BZ_FIXTURE_MOVED === "1" ? "b".repeat(40) : "a".repeat(40);
        return "00abcde";
      }
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
        return JSON.stringify({assets, prerelease:process.env.BZ_FIXTURE_FINAL_CHANNEL === "stable" ? false : prerelease, html_url:"fixture://release"});
      throw Error("Unexpected fixture command: "+[cmd,...args].join(" "));
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const proc = spawnSync(process.execPath, ["--require", join(dir,"mock.cjs"), join(dir,"desktop","release.mjs"), ...(opts.BZ_FIXTURE_CLI ? JSON.parse(opts.BZ_FIXTURE_CLI) : ["--skip-build","--allow-dev-pin"])], {
    cwd: caller, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PATH: join(dir,"no-executables"), BZ_RECIPE_PUBLISHER_FILE: relativePins ? "publishers.json" : join(dir,"publishers.json"),
      NODE_OPTIONS:"", BZ_FIXTURE_BUILD_OUTPUT:join(dir,"dist-desktop",name), BZ_FIXTURE_STAGED_PINS:join(dir,"desktop","stage","app","publishers.json"), BZ_FIXTURE_LOG:join(dir,"calls.txt"), BZ_FIXTURE_PRE:String(prerelease), BZ_FIXTURE_ASSETS:JSON.stringify(assets), ...opts }
  });
  assert.ifError(proc.error);
  const calls = readFileSync(join(dir,"calls.txt"),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  let stagedPin;
  try { stagedPin=JSON.parse(readFileSync(join(dir,"desktop","stage","app","publishers.json"),"utf8")).publishers[0].keyId; } catch {}
  return { code: proc.status, text: proc.stdout+proc.stderr, calls, stagedPin };
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

test("an old dotted-name installer cannot stand in for the named upload",t=>{
  const r=run(t,[{name:"BeeZilla.Setup.0.0.1.exe",size:file.length,digest:"sha256:"+sha}]);
  assert.notEqual(r.code,0,r.text);assert.doesNotMatch(r.text,/verified on GitHub/i);
});
test("verify the canonical upload even when a legacy asset precedes it",t=>{
  const legacy={name:"BeeZilla.Setup.0.0.1.exe",size:file.length,digest:"sha256:"+sha};
  const r=run(t,[legacy,{name,size:file.length,digest:"sha256:"+"0".repeat(64)}]);
  assert.notEqual(r.code,0,r.text);assert.doesNotMatch(r.text,/verified on GitHub/i);
});

test("do not report success if the release channel changed after preflight",t=>{
  const r=run(t,expected,true,{BZ_FIXTURE_FINAL_CHANNEL:"stable"});
  assert.notEqual(r.code,0,r.text);assert.doesNotMatch(r.text,/verified on GitHub/i);
});

function stable(t, cli, opts={}) {
  return run(t,expected,false,{BZ_FIXTURE_PIN:"fixture-production", BZ_FIXTURE_CLI:JSON.stringify(cli),...opts});
}
test("stable skip-build cannot treat a previously created installer as stable based on today's pins",t=>{
  const r=stable(t,["--skip-build"]);
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/stable.*fresh build/i);
  assert.deepEqual(r.calls,[]);
});
test("stable release cannot retag freshly built bytes as a --ref override",t=>{
  const r=stable(t,["--ref","old-ref"],{BZ_FIXTURE_EXISTING:"none"});
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/stable.*--ref/i);
  assert.deepEqual(r.calls,[]);
});
test("stable fresh-build path refuses old canonical output rather than relabel it or delete it",t=>{
  const r=stable(t,[]);
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/move the existing.*output/i);
  assert.deepEqual(r.calls,[]);
});
test("stable release proceeds in the offline harness only when a clean fresh build creates the installer",t=>{
  const r=stable(t,[],{BZ_FIXTURE_EXISTING:"none"});
  assert.equal(r.code,0,r.text);
  assert.ok(r.calls.some(([cmd,...args])=>(cmd==="node"||cmd===process.execPath)&&args.includes("all")));
  assert.equal(r.calls.filter(changed).length,1);
});
test("stable release refuses if HEAD changes during the fresh build",t=>{
  const r=stable(t,[],{BZ_FIXTURE_EXISTING:"none",BZ_FIXTURE_MOVED:"1"});
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/HEAD changed/i);
  assert.deepEqual(r.calls.filter(changed),[]);
});

test("relative pin override selects the same bytes from a different caller and build cwd",t=>{
  const r=stable(t,[],{BZ_FIXTURE_EXISTING:"none",BZ_FIXTURE_RELATIVE_PIN:"1"});
  assert.equal(r.code,0,r.text);
  assert.equal(r.stagedPin,"fixture-production");
});
test("stable release verifies actual staged pins match the preflight bytes",t=>{
  const r=stable(t,[],{BZ_FIXTURE_EXISTING:"none",BZ_FIXTURE_SWAPPED_PINS:"1"});
  assert.notEqual(r.code,0,r.text);
  assert.match(r.text,/staged publisher pins.*changed/i);
  assert.deepEqual(r.calls.filter(changed),[]);
});
