import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const zip = Buffer.from("UEsDBBQAAAAAAAAAIVDvB/oCHwAAAB8AAAAKAAAAUkVBRE1FLnR4dG9ubHkgc3ludGhldGljIGZpeHR1cmUgY29udGVudApQSwECFAMUAAAAAAAAACFQ7wf6Ah8AAAAfAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAABHAAAAAAA=", "base64");
const commentedZip = Buffer.from("UEsDBBQAAAAAAAAAIVDvB/oCHwAAAB8AAAAKAAAAUkVBRE1FLnR4dG9ubHkgc3ludGhldGljIGZpeHR1cmUgY29udGVudApQSwECFAMUAAAAAAAAACFQ7wf6Ah8AAAAfAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAABHAAAAFwBmaXh0dXJlIGFyY2hpdmUgY29tbWVudA==", "base64");

function run(t, response, pathMode) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI export fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = "bin/beezilla.mjs";
  const target = pathMode === "missing parent" ? "missing/backup.zip"
    : pathMode === "file parent" ? "regular-file/backup.zip"
      : pathMode === "directory target" ? "existing directory" : "existing backup.zip";
  const calls = join(root, "fetch-calls");
  const original = Buffer.from("prior fixture file\n");
  const write = (rel, bytes) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  for (const rel of [cli, "scripts/lib/inference.mjs", "scripts/lib/pins.mjs", "scripts/lib/search-keys.mjs"]) {
    write(rel, readFileSync(new URL("../" + rel, import.meta.url)));
  }
  write("fixture data/runtime.json", JSON.stringify({ host: "inert.invalid", port: 7331 }));
  write("fixture-response", response);
  if (pathMode === "directory target") mkdirSync(join(root, target));
  else if (pathMode === "file parent") write("regular-file", original);
  else if (!pathMode) write(target, original);
  // Every response is synthetic; no launcher, real exports, socket or token.
  write("mock-fetch.mjs", `
    import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
    const bytes = readFileSync(new URL("./fixture-response", import.meta.url));
    globalThis.fetch = async (url) => {
      appendFileSync(process.env.CLI_FIXTURE_CALLS, url + "\\n");
      if (url === "http://inert.invalid:7331/api/agent/health") return { ok:true };
      if (url === "http://inert.invalid:7331/api/buzzy/export") {
        if (process.env.CLI_FIXTURE_PATH_MODE === "race") mkdirSync("existing backup.zip");
        return { ok:true, arrayBuffer:async () => Uint8Array.from(bytes).buffer };
      }
      throw Error("unexpected URL in hermetic fake fetch");
    };
  `);
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, cli), "export", target], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: join(root, "fixture data"), CLI_FIXTURE_CALLS: calls, CLI_FIXTURE_PATH_MODE: pathMode ?? "" },
    encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  return {
    result, saved: pathMode ? null : readFileSync(join(root, target)), original,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

for (const [label, response] of [
  ["truncated ZIP ending", zip.subarray(0, -1)],
  ["only the ZIP header", zip.subarray(0, 4)],
]) {
  test(`export refuses ${label} before touching an existing output file`, (t) => {
    const {result, saved, original} = run(t, response);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /^export did not return a complete ZIP archive/m);
    assert.doesNotMatch(result.stdout, /^wrote /m);
    assert.deepEqual(saved, original);
  });
}
for (const [label, response] of [["normal archive", zip], ["archive with a comment", commentedZip]]) {
  test(`export writes a ${label} unchanged`, (t) => {
    const {result, saved} = run(t, response);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^wrote existing backup\.zip /m);
    assert.deepEqual(saved, response);
  });
}

for (const [pathMode, expected] of [
  ["missing parent", "export destination folder missing does not exist"],
  ["file parent", "export destination folder regular-file is not a directory"],
  ["directory target", "export destination existing directory is a directory; choose a file name"],
]) {
  test(`export explains ${pathMode} without requesting workspace data`, (t) => {
    const { result, calls } = run(t, zip, pathMode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp("^" + expected));
    assert.doesNotMatch(result.stderr, /node:internal|at Object\.openSync/);
    assert.doesNotMatch(result.stdout, /^wrote /m);
    assert.deepEqual(calls, [], "failure is detected before probing runtime or requesting export");
  });
}


test("export explains a write failure even if the destination changed after preflight", (t) => {
  const { result, calls } = run(t, zip, "race");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^could not write export to existing backup[.]zip [(][^)]+[)]\n$/);
  assert.doesNotMatch(result.stdout, /^wrote /m);
  assert.equal(calls.length, 2, "probe and export reached the mock before the local error");
});
