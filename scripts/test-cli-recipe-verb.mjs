import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function run(t, args) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI recipe verb fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "fixture data");
  const calls = join(root, "mock-calls");
  const cli = "bin/beezilla.mjs";
  const write = (rel, bytes) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  for (const rel of [cli, "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
    write(rel, readFileSync(new URL("../" + rel, import.meta.url)));
  }
  write("fixture data/runtime.json", JSON.stringify({ host: "inert.invalid", port: 7331 }));
  write("fixture.bezz", "deliberately not a valid recipe");
  // Replace fetch completely. No launcher, runtime, credential, recipes, or sockets exist.
  write("mock-fetch.mjs", `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      appendFileSync(process.env.CLI_FIXTURE_CALLS, JSON.stringify({ path, method }) + "\\n");
      if (url === "http://inert.invalid:7331/api/agent/health" && method === "GET") return { ok:true };
      if (url === "http://inert.invalid:7331/api/recipes/local" && method === "GET")
        return { status:200, text:async () => '{"pins":1,"valid":[],"rejected":[]}' };
      if (url === "http://inert.invalid:7331/api/recipes/local/verify" && method === "POST")
        return { status:400, text:async () => '{"ok":false,"reason":"fixture invalid"}' };
      return { status:405, text:async () => '{"ok":false,"error":"mock permits no writes"}' };
    };
  `);
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, cli), "recipe", ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: data, CLI_FIXTURE_CALLS: calls },
    encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  const captured = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { result, captured };
}

for (const args of [["verfy"], ["verfy", "fixture.bezz"]]) {
  test(`recipe rejects unrecognized ${args.join(" ")} before contacting a runtime`, (t) => {
    const { result, captured } = run(t, args);
    assert.deepEqual(captured, [], "a bad verb should not reach even the mock service");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: beezilla recipe /m);
  });
}

test("recipe without arguments still lists cached recipes", (t) => {
  const { result, captured } = run(t, []);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no recipes cached/);
  assert.deepEqual(captured, [{ path:"/api/agent/health", method:"GET" }, { path:"/api/recipes/local", method:"GET" }]);
});

test("recipe verify still uses the existing verification route and refusal", (t) => {
  const { result, captured } = run(t, ["verify", "fixture.bezz"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^BAD .*fixture invalid/m);
  assert.deepEqual(captured, [{ path:"/api/agent/health", method:"GET" }, { path:"/api/recipes/local/verify", method:"POST"}]);
});
