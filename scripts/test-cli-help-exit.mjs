import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/beezilla.mjs", import.meta.url));

for (const [verb, expected] of [[undefined, 0], ["--help", 0], ["-h", 0], ["help", 0], ["unknown-example-command", 2]]) {
  test(`top-level ${verb ?? "no arguments"} prints CLI usage and exits ${expected}`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "beezilla-help-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const data = join(home, "unused-data");
    const result = spawnSync(process.execPath, [cli, ...(verb ? [verb] : [])], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, BZ_DATA_DIR: data },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.match(result.stdout, /^beezilla <command>\r?$/m);
    assert.equal(result.stderr, "");
    assert.equal(existsSync(data), false);
    assert.equal(result.status, expected, `unanticipated exit code for ${verb}`);
  });
}
