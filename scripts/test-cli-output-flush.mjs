import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const reply = "Fixture café 🔧 ".repeat(70_000) + "end of fixture";

function run(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI flush fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = "bin/beezilla.mjs";
  const write = (rel, bytes) => {
    const f = join(root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, bytes);
  };
  for (const rel of [cli, "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
    write(rel, readFileSync(new URL("../" + rel, import.meta.url)));
  }
  write("fixture data/runtime.json", JSON.stringify({ host: "inert.invalid", port: 7331 }));
  write("reply.txt", mode === "short" ? "Short control" : reply);
  // Stub all fetches in-process; the launcher and any actual credentials are absent.
  write("mock-fetch.mjs", `
    import { readFileSync } from "node:fs";
    const reply = readFileSync(new URL("./reply.txt", import.meta.url), "utf8");
    globalThis.fetch = async (url) => {
      if (url === "http://inert.invalid:7331/api/agent/health") return { ok:true };
      if (url === "http://inert.invalid:7331/api/buzzy/chat") {
        const body = process.env.CLI_FIXTURE_MODE === "error"
          ? { ok:false, reply, code:"fixture", error:"Expected refusal" }
          : { ok:true, reply };
        return { status:200, text:async () => JSON.stringify(body) };
      }
      throw Error("unexpected URL in hermetic fake fetch");
    };
  `);
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, cli), "run", "Fixture request"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: join(root, "fixture data"), CLI_FIXTURE_MODE: mode },
    maxBuffer: 8 * 1024 * 1024, encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  return result;
}

test("run drains a long reply to a stdout pipe before exiting", (t) => {
  const result = run(t, "success");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout), Buffer.byteLength(reply + "\n"), "all reply bytes reached the pipe");
  assert.equal(result.stdout, reply + "\n");
  assert.equal(result.stderr, "");
});

test("run drains long failure output to a stderr pipe without changing failure status", (t) => {
  const result = run(t, "error");
  const expected = reply + "\n[fixture] Expected refusal\n";
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(Buffer.byteLength(result.stderr), Buffer.byteLength(expected), "all failure bytes reached the pipe");
  assert.equal(result.stderr, expected);
});

test("run still returns a short reply with success status", (t) => {
  const result = run(t, "short");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Short control\n");
  assert.equal(result.stderr, "");
});
