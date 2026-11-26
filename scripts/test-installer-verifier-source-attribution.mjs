/** Tests the real verifier with deliberately incomplete, inert file trees. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

for (const bad of ["launcher", "server", "neither"]) {
  test(`verify reports the right source and still audits independent markers: ${bad}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "bee verifier attribution "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (rel, bytes) => {
      const file = join(root, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    };
    const verifier = "scripts/verify-installer.mjs";
    write(verifier, readFileSync(new URL("./verify-installer.mjs", import.meta.url)));
    const resources = "dist-desktop/win-unpacked/resources";
    // These are plain strings the verifier scans, not executable assets.
    write(resources + "/app.asar", "api/search-token https://beezilla.example.railway.app could not reach BeeZilla at");
    const asar = "@electron/asar";
    const entry = "bin/asar.js";
    const version = "1.0.0-fixture";
    write("desktop/package-lock.json", JSON.stringify({
      packages: { ["node_modules/" + asar]: { version, integrity: "fixture", bin: { asar: entry } } },
    }));
    const pkg = "desktop/node_modules/" + asar;
    write(pkg + "/package.json", JSON.stringify({ name: asar, version, bin: { asar: entry } }));
    write(pkg + "/" + entry, 'for (const f of ["main.mjs","preload.cjs","settings.mjs","supervisor.mjs","connect.mjs"]) console.log("/" + f);');
    const launcher = resources + "/app/scripts/beezilla-local.mjs";
    const server = resources + "/app/.output/server/index.mjs";
    if (bad === "launcher") mkdirSync(join(root, launcher), { recursive: true });
    else write(launcher, "BZ_SEARCH_EXPIRED ensurePgliteAssets");
    if (bad === "server") mkdirSync(join(root, server), { recursive: true });
    else write(server, "needsReconnect");
    const r = spawnSync(process.execPath, [join(root, verifier)], {
      cwd: root, env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5_000,
    });
    assert.ifError(r.error);
    assert.equal(r.status, 1, "this fixture is incomplete and must still fail");
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^PASS  the connect flow also asks for a search token$/m);
    assert.doesNotMatch(r.stdout, /^FAIL  the connect flow also asks for a search token/m);
    assert.match(r.stdout, /^PASS  the app says so when BeeZilla is unreachable$/m);
    assert.match(r.stdout, bad === "launcher" ? /^FAIL  the launcher can distinguish an expired session.*not a regular file/m : /^PASS  the launcher can distinguish an expired session/m);
    assert.match(r.stdout, bad === "server" ? /^FAIL  the runtime API reports needsReconnect.*not a regular file/m : /^PASS  the runtime API reports needsReconnect/m);
    assert.match(r.stdout, /installer verification: \d+ failed/);
  });
}
