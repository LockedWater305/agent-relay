// Native-free tests of the real staging controller in a disposable filesystem.
// Both build producers are inert fixtures: no Electron, installer, server, network or release.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const silent = "export default {};\n";
function fixture(t, kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee stage fixture "));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  function write(name, data) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data);
  }
  function json(name, val) { write(name, JSON.stringify(val)); }
  for (const file of ["desktop/dist.mjs", "desktop/stage-inputs.mjs", "desktop/after-pack.cjs"])
    write(file, fs.readFileSync(path.join(root, file)));
  write("scripts/build-desktop-csp.mjs", "export async function writeCspManifest(){}\n");
  json("package.json", {version:"0.0.0-fixture",dependencies:{"@electric-sql/pglite":"0.0.0-fixture"}});
  json("desktop/package.json", {build:{files:[]}});
  json("package-lock.json", {packages:{"node_modules/vite":{
    version:"0.0.0-fixture", integrity:"fixture-only", bin:{vite:"bin/vite.js"}
  }}});
  json("node_modules/vite/package.json", {name:"vite",version:"0.0.0-fixture",bin:{vite:"bin/vite.js"}});
  write("node_modules/vite/bin/vite.js", "/* inert build fixture */");
  for (const file of ["scripts/migrate.mjs", "scripts/beezilla-local.mjs", "scripts/lib/inference.mjs",
    "scripts/lib/search-keys.mjs", "scripts/lib/music-keys.mjs", "scripts/lib/pins.mjs"]) write(file, silent);
  write("scripts/lib/pins.mjs", "export function resolvePins() { return []; }\n");
  write("bin/beezilla.mjs", "import { resolvePins } from '../scripts/lib/pins.mjs';\n");
  write("scripts/lib/parent-watchdog.cjs", "/* fixture */");
  write("migrations/001.sql", "SELECT 1;");
  write(".output/server/index.mjs", silent);
  for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) write(".output/server/_libs/"+file, "fixture");
  const pkgDir = "node_modules/@electric-sql/pglite";
  json(pkgDir + "/package.json", {name:"@electric-sql/pglite",version:"0.0.0-fixture"});
  json("desktop/package-lock.json", {packages:{"node_modules/electron-builder":{
    version:"0.0.0-fixture",integrity:"fixture-only",bin:{"electron-builder":"cli.js"}
  }}});
  json("desktop/node_modules/electron-builder/package.json", {name:"electron-builder",version:"0.0.0-fixture",bin:{"electron-builder":"cli.js"}});
  const platformDir = process.platform === "win32" ? "win" : "linux";
  const testArch = kind === "wrong-arch" ? (process.arch === "x64" ? "arm64" : "x64") : process.arch;
  const output = path.join(dir,"dist-desktop",platformDir+(testArch==="x64"?"":"-"+testArch)+"-unpacked");
  const rel = path.relative(dir,output);
  json(path.join(rel,"resources/app/package.json"),{name:"fixture"});
  if (kind === "no-hook") {
    json(path.join(rel,"resources/app/node_modules/@electric-sql/pglite/package.json"),{name:"old-artifact"});
    write("desktop/node_modules/electron-builder/cli.js", "/* simulated builder returned without producing an app */");
  } else {
    write("desktop/node_modules/electron-builder/cli.js", [
      "const hook=require('../../after-pack.cjs').default;",
      "const assert=require('node:assert/strict');",
      "assert.deepEqual(process.argv.slice(2),["+JSON.stringify(process.platform === "win32"?"--win":"--linux")+",'dir','--publish','never']);",
      "hook({appOutDir:"+JSON.stringify(output)+",electronPlatformName:process.platform}).catch(e=>{console.error(e);process.exitCode=1});"
    ].join("\n"));
  }
  function run(mode) {
    const env = {...process.env, PATH:""};
    delete env.BZ_RECIPE_PUBLISHER_FILE;
    return spawnSync(process.execPath, [path.join(dir,"desktop/dist.mjs"), mode], {
      cwd:dir, env, encoding:"utf8", timeout:10000
    });
  }
  return {dir,write,run,manifest:path.join(dir,"desktop/stage/MANIFEST.json")};
}

const supported = ["linux","win32"].includes(process.platform) && ["x64","arm64"].includes(process.arch);
for (const [kind,ok] of [["correct",true],["no-hook",false],["wrong-arch",false]]) {
  test(`unpacked output: ${kind}`, {skip:!supported}, t => {
    const p=fixture(t,kind).run("dir");
    if (ok) assert.equal(p.status,0,p.stdout+p.stderr);
    else {
      assert.notEqual(p.status,0,p.stdout+p.stderr);
      assert.match(p.stderr,/afterPack.*receipt|wrong.*output/i);
    }
  });
}
