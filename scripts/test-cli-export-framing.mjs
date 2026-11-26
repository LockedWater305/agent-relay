import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const zip = Buffer.from("UEsDBBQAAAAAAAAAIVDvB/oCHwAAAB8AAAAKAAAAUkVBRE1FLnR4dG9ubHkgc3ludGhldGljIGZpeHR1cmUgY29udGVudApQSwECFAMUAAAAAAAAACFQ7wf6Ah8AAAAfAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAABHAAAAAAA=", "base64");
const commentedZip = Buffer.from("UEsDBBQAAAAAAAAAIVDvB/oCHwAAAB8AAAAKAAAAUkVBRE1FLnR4dG9ubHkgc3ludGhldGljIGZpeHR1cmUgY29udGVudApQSwECFAMUAAAAAAAAACFQ7wf6Ah8AAAAfAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAABHAAAAFwBmaXh0dXJlIGFyY2hpdmUgY29tbWVudA==", "base64");

function run(t, response) {
  const root = mkdtempSync(join(tmpdir(), "bee CLI export fixture "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = "bin/beezilla.mjs";
  const target = "existing backup.zip";
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
  write(target, original);
  // Every response is synthetic; no launcher, real exports, socket or token.
  write("mock-fetch.mjs", `
    import { readFileSync } from "node:fs";
    const bytes = readFileSync(new URL("./fixture-response", import.meta.url));
    globalThis.fetch = async (url) => {
      if (url === "http://inert.invalid:7331/api/agent/health") return { ok:true };
      if (url === "http://inert.invalid:7331/api/buzzy/export")
        return { ok:true, arrayBuffer:async () => Uint8Array.from(bytes).buffer };
      throw Error("unexpected URL in hermetic fake fetch");
    };
  `);
  const result = spawnSync(process.execPath, ["--import", join(root, "mock-fetch.mjs"), join(root, cli), "export", target], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, BZ_DATA_DIR: join(root, "fixture data") },
    encoding: "utf8", timeout: 5_000,
  });
  assert.ifError(result.error);
  return { result, saved: readFileSync(join(root, target)), original };
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
