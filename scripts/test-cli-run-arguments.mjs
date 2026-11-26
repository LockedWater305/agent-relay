import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function run(t, args) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI argument fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "fixture data");
  const calls = join(root, "mock-calls");
  const cli = "bin/beezilla.mjs";
  const write = (rel, bytes) => {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  };
  for (const f of [cli, "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
    write(f, readFileSync(new URL("../" + f, import.meta.url)));
  }
  // No server, sockets, credential, launcher script, or live provider exists.
  write("fixture data/runtime.json", JSON.stringify({ host: "inert.invalid", port: 7331 }));
  write("mock-fetch.mjs", `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      const method = options?.method ?? "GET";
      const body = options?.body ? JSON.parse(options.body) : null;
      appendFileSync(process.env.CLI_FIXTURE_CALLS, JSON.stringify({ path, method, body }) + "\\n");
      if (url === "http://inert.invalid:7331/api/agent/health" && method === "GET") return { ok:true };
      if (url === "http://inert.invalid:7331/api/buzzy/chat" && method === "POST")
        return { status:200, text:async () => '{"ok":true,"reply":"fixture reply"}' };
      throw Error("unexpected request to in-process fake fetch");
    };
  `);
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, cli), "run", ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: data, CLI_FIXTURE_CALLS: calls },
    encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  const captured = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return { result, captured };
}

for (const [label, args, body] of [
  ["job after message", ["Fixture message", "--job", "job_A"], { message: "Fixture message", mode: "chat", jobId: "job_A" }],
  ["job before several message arguments", ["--job", "job_A", "Fixture", "message", "--work"], { message: "Fixture message", mode: "work", jobId: "job_A" }],
  ["repeated job option", ["Fixture", "--job", "job_A", "--job", "job_B", "message"], { message: "Fixture message", mode: "chat", jobId: "job_A" }],
  ["plain message", ["Fixture", "message"], { message: "Fixture message", mode: "chat" }],
  ["ordinary work mode", ["Fixture message", "--work"], { message: "Fixture message", mode: "work" }],
]) {
  test(`run parses ${label} before the inert API boundary`, (t) => {
    const { result, captured } = run(t, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture reply/);
    assert.deepEqual(captured, [
      { path: "/api/agent/health", method: "GET", body: null },
      { path: "/api/buzzy/chat", method: "POST", body },
    ]);
  });
}

for (const [label, args] of [
  ["no message", ["--job", "job_A"]],
  ["no job value", ["Fixture message", "--job"]],
  ["another option as the job value", ["Fixture message", "--job", "--work"]],
  ["no arguments", []],
]) {
  test(`run rejects ${label} without probing for a runtime`, (t) => {
    const { result, captured } = run(t, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /^usage: beezilla run /m);
    assert.deepEqual(captured, []);
  });
}
