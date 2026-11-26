import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

for (const [kind, expected, detail] of [
  ["nonempty-file", 0, ""], ["absent", 1, ""], ["directory", 1, "not a regular file"], ["empty-file", 1, "empty"],
]) {
  test(`doctor diagnoses the server entry when it is a ${kind}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "bee doctor build fixture "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const data = join(root, "fixture data");
    const entry = ".output/server/index.mjs";
    const write = (rel, bytes) => {
      const file = join(root, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    };
    for (const rel of ["bin/beezilla.mjs", "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
      write(rel, readFileSync(new URL("../" + rel, import.meta.url)));
    }
    for (const file of ["pglite.data", "pglite.wasm", "initdb.wasm"]) write(".output/server/_libs/" + file, "fixture payload");
    if (kind === "nonempty-file") write(entry, "throw Error('Doctor must never launch the app');");
    if (kind === "directory") mkdirSync(join(root, entry));
    if (kind === "empty-file") write(entry, "");

    const result = spawnSync(process.execPath, [join(root, "bin/beezilla.mjs"), "doctor"], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: data }, encoding: "utf8", timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^PASS  pglite assets/m, "no independent asset failure masks this test");
    assert.match(result.stdout, /^PASS  data dir writable/m, "no independent data failure masks this test");
    assert.equal(existsSync(join(data, "runtime.json")), false);
    const line = result.stdout.split(/\r?\n/).find((value) => value.includes("build present"));
    assert.ok(line?.startsWith(expected === 0 ? "PASS  " : "warn  "), result.stdout);
    assert.ok(line.includes(entry), line);
    if (detail) assert.ok(line.includes(detail), line);
    assert.equal(result.status, expected, result.stdout);
  });
}
