#!/usr/bin/env node
/** Exercise the public/private leak gate without git, credentials, or packages. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "bz-private-boundary-"));
const env = {
  ...process.env,
  BZ_PRIVATE_LOCAL_PATH: "", BZ_PRIVATE_REPO_TOKEN: "", BZ_PRIVATE_DEPLOY_KEY: "", BZ_REQUIRE_PRIVATE: "",
};
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`PASS  ${name}`); };
const run = (script, args = []) => spawnSync(process.execPath, [join(fixture, "scripts", script), ...args], {
  cwd: fixture, env, encoding: "utf8",
});
const failsWith = (result, expected) => result.status === 1 && (result.stdout + result.stderr).includes(expected);
try {
  mkdirSync(join(fixture, "scripts"));
  for (const script of ["sync-private.mjs", "assert-no-private-modules.mjs"]) {
    cpSync(join(ROOT, "scripts", script), join(fixture, "scripts", script));
  }
  cpSync(join(ROOT, ".private-stub"), join(fixture, ".private-stub"), { recursive: true });
  cpSync(join(ROOT, "private.lock.json"), join(fixture, "private.lock.json"));
  check("credential-free sync creates only stubs", run("sync-private.mjs").status === 0);
  const manifest = JSON.parse(readFileSync(join(fixture, "src/lib/private/.manifest.json"), "utf8"));
  check("manifest identifies the open build", manifest.mode === "stub" && manifest.commit === "stub");
  check("stub manifest checks offline", run("sync-private.mjs", ["--check"]).status === 0);
  check("clean public build passes the filesystem guard without git", run("assert-no-private-modules.mjs").status === 0);
  check("private-required check cannot pass with stubs", failsWith(run("sync-private.mjs", ["--check", "--require-private"]), "built from stubs"));

  const legacy = join(fixture, "src/lib/recipe-seal/recipes.nitro.ts");
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, "export default () => null;\n");
  check("restored legacy commercial filename is caught without git", failsWith(run("assert-no-private-modules.mjs"), "sits outside src/lib/private"));
  rmSync(legacy);

  const sentinel = join(fixture, "src/lib/recipe-seal/copied.ts");
  writeFileSync(sentinel, "// BZ-" + "PRIVATE module: test fixture, not real private code\n");
  check("a renamed private-module sentinel is refused", failsWith(run("assert-no-private-modules.mjs"), "carries the private-module sentinel"));
  rmSync(sentinel);

  const extra = join(fixture, "src/lib/private/extra.ts");
  writeFileSync(extra, "export {};\n");
  check("unmanifested private-tree files are refused", failsWith(run("assert-no-private-modules.mjs"), "not recorded in the manifest"));
  rmSync(extra);
  const generated = join(fixture, "src/lib/private/registry.ts");
  writeFileSync(generated, "export {};\n");
  check("editing a synced module fails the manifest guard", failsWith(run("assert-no-private-modules.mjs"), "does not match the manifest"));

  const config = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
  const handlers = [...config.matchAll(/route:\s*"([^"]+)"\s*,\s*handler:\s*"([^"]+)"/g)].map((match) => ({ path: match[1], handler: match[2] }));
  const local = handlers.findIndex((entry) => entry.path === "/api/recipes/local");
  const localWildcard = handlers.findIndex((entry) => entry.path === "/api/recipes/local/**");
  const marketplace = handlers.findIndex((entry) => entry.path === "/api/recipes/**");
  check("local cache routes are explicitly registered before marketplace wildcard", local >= 0 && localWildcard >= 0 && local < marketplace && localWildcard < marketplace);
  check("local routes use the public adapter", handlers[local].handler === "./src/lib/recipe-seal/local.nitro.ts" && handlers[localWildcard].handler === handlers[local].handler);
  check("marketplace remains behind the synced private boundary", handlers[marketplace].handler === "./src/lib/private/recipes.nitro.ts");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log(`\nPrivate split: ${checks} checks passed`);
