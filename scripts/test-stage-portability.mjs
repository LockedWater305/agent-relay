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
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bee stage fixture "));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  function write(name, data) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, data);
  }
  function json(name, val) { write(name, JSON.stringify(val)); }
  for (const file of ["desktop/dist.mjs", "desktop/stage-inputs.mjs"])
    write(file, fs.readFileSync(path.join(root, file)));
  write("scripts/build-desktop-csp.mjs", "export async function writeCspManifest(){}\n");
  json("package.json", {version:"0.0.0-fixture",dependencies:{}});
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
  function run(mode) {
    const env = {...process.env, PATH:""};
    delete env.BZ_RECIPE_PUBLISHER_FILE;
    return spawnSync(process.execPath, [path.join(dir,"desktop/dist.mjs"), mode], {
      cwd:dir, env, encoding:"utf8", timeout:10000
    });
  }
  return {dir,write,run,manifest:path.join(dir,"desktop/stage/MANIFEST.json")};
}

test("a misspelled packaging target fails clearly without touching a previous stage", t => {
  const f = fixture(t); f.write("desktop/stage/previous", "retained");
  const p = f.run("diir");
  assert.notEqual(p.status, 0, p.stdout+p.stderr);
  assert.match(p.stderr, /stage.*all.*dir|stage.*dir.*all/);
  assert.equal(fs.readFileSync(path.join(f.dir,"desktop/stage/previous"),"utf8"), "retained");
});

test("staging refuses the CLI's missing pins helper instead of shipping a CLI that cannot load", t => {
  const f = fixture(t);
  // Match the checked-in CLI's static import syntax; no private keys or runtime launch involved.
  f.write("bin/beezilla.mjs", 'import { resolvePins } from "../scripts/lib/pins.mjs";\n');
  fs.unlinkSync(path.join(f.dir,"scripts/lib/pins.mjs"));
  const p = f.run("stage");
  assert.notEqual(p.status, 0, p.stdout+p.stderr);
  assert.match(p.stderr, /scripts\/lib\/pins\.mjs/);
  assert.equal(fs.existsSync(f.manifest), false);
});

test("missing Nitro server entry cannot pass on the public output and PGlite payloads alone", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir,".output/server/index.mjs"));
  const p = f.run("stage");
  assert.notEqual(p.status, 0, p.stdout+p.stderr);
  assert.match(p.stderr, /server[\/\\]index\.mjs/);
  assert.equal(fs.existsSync(f.manifest), false);
});

test("a directory ending in .sql is not a runnable migration, even alongside a valid file", t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir,"migrations/002.sql"));
  const p = f.run("stage");
  assert.notEqual(p.status, 0, p.stdout+p.stderr);
  assert.match(p.stderr, /002\.sql/);
  assert.equal(fs.existsSync(f.manifest), false);
});

test("size metadata measures file bytes with no du executable on PATH", t => {
  const f = fixture(t); f.write(".output/server/padding", Buffer.alloc(2_000_000));
  const p = f.run("stage");
  assert.equal(p.status, 0, p.stdout+p.stderr);
  const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
  assert.equal(manifest.megabytes, 2);
});
