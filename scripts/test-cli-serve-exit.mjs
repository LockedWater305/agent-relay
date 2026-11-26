import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function run(t, inertLauncher) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI exit fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "unused data");
  const cli = "bin/beezilla.mjs";
  function write(rel, bytes) {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  }
  for (const f of [cli, "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
    write(f, readFileSync(new URL("../" + f, import.meta.url)));
  }
  if (inertLauncher !== undefined) write("scripts/beezilla-local.mjs", inertLauncher);
  const result = spawnSync(process.execPath, [join(root, cli), "serve"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: data }, encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(existsSync(data), false, "the fixture must never create runtime data");
  return result;
}

test("serve returns the foreground launcher's nonzero numeric exit status", (t) => {
  const result = run(t, 'console.error("fixture launch failed"); process.exitCode = 23;');
  assert.match(result.stderr, /^fixture launch failed/m);
  assert.equal(result.status, 23, "serve must not turn a launcher failure into success");
});

test("serve returns failure when its launcher file is absent", (t) => {
  const result = run(t);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.notEqual(result.status, 0, "missing launcher must not exit successfully");
});

test("serve reports success after a clean foreground launcher exit", (t) => {
  const result = run(t, 'console.log("fixture clean exit");');
  assert.match(result.stdout, /^fixture clean exit/m);
  assert.equal(result.status, 0);
});

test("serve does not report success after a terminated launcher", { skip: process.platform === "win32" }, (t) => {
  const result = run(t, 'process.kill(process.pid, "SIGTERM");');
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null, "only the inert launcher was signaled");
});
