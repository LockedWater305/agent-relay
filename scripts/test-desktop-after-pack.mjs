/**
 * Synthetic filesystem regressions for the production-dependency afterPack hook.
 * No Electron, electron-builder, dependency install, or packaged app is run here.
 * Run: node --test scripts/test-desktop-after-pack.mjs
 */
import assert from "node:assert/strict";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("../desktop/", import.meta.url));
const hookSource = join(desktopDir, "after-pack.cjs");
const desktopPackage = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
const require = createRequire(import.meta.url);

function writeFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function fixture(t, platform = "win32") {
  const root = mkdtempSync(join(tmpdir(), "beezilla-after-pack-"));
  const hookPath = join(root, "desktop", "after-pack.cjs");
  t.after(() => {
    delete require.cache[hookPath];
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(dirname(hookPath), { recursive: true });
  // Copy the real hook unchanged so its __dirname-relative stage is isolated.
  copyFileSync(hookSource, hookPath);
  assert.deepEqual(readFileSync(hookPath), readFileSync(hookSource));
  const hook = require(hookPath);
  const context = {
    appOutDir: join(root, "output"),
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: "BeeZilla Test Product" } },
  };
  // Compute expectations independently of the helper under test.
  const resources = platform === "darwin" || platform === "mas"
    ? join(context.appOutDir, "BeeZilla Test Product.app", "Contents", "Resources")
    : join(context.appOutDir, "resources");
  return {
    hook, context, resources,
    app: join(resources, "app"),
    stagedDependencies: join(root, "desktop", "stage", "app", "node_modules"),
  };
}

const runtimeManifest = Buffer.from('{"name":"synthetic-runtime","private":true}\n');
const dependencyFiles = [
  ["plain/package.json", Buffer.from('{"name":"plain","version":"1.0.0"}\n')],
  ["plain/index.js", Buffer.from("module.exports = 'synthetic dependency';\n")],
  ["@scope/package/lib/index.js", Buffer.from("export const value = 17;\n")],
  ["outer/node_modules/inner/index.js", Buffer.from("module.exports = 'nested';\n")],
  // Binary bytes only: this is not a real native module or a native-loading test.
  ["native/build/fixture.node", Buffer.from([0, 1, 10, 127, 128, 255, 0])],
];

for (const platform of ["win32", "linux", "darwin", "mas"]) {
  test(`${platform}: copies nested and scoped dependency bytes to the platform resources path`, async (t) => {
    const f = fixture(t, platform);
    assert.equal(f.hook.resourcesDir(f.context), f.resources);
    writeFile(join(f.app, "package.json"), runtimeManifest);
    for (const [path, bytes] of dependencyFiles) {
      writeFile(join(f.stagedDependencies, path), bytes);
    }

    await f.hook.default(f.context);

    for (const [path, bytes] of dependencyFiles) {
      assert.deepEqual(readFileSync(join(f.app, "node_modules", path)), bytes, path);
      assert.deepEqual(readFileSync(join(f.stagedDependencies, path)), bytes, `source retained: ${path}`);
    }
    assert.deepEqual(readFileSync(join(f.app, "package.json")), runtimeManifest);
  });
}

test("missing packaged runtime manifest rejects even when staged dependencies exist", async (t) => {
  const f = fixture(t);
  writeFile(join(f.app, "index.mjs"), "// synthetic runtime without its manifest\n");
  writeFile(join(f.stagedDependencies, "plain", "index.js"), "module.exports = 17;\n");

  await assert.rejects(f.hook.default(f.context), (error) => {
    assert.match(error.message, /^afterPack: no runtime at /);
    assert.ok(error.message.includes(f.app));
    return true;
  });
  assert.equal(existsSync(join(f.app, "node_modules")), false);
});

for (const mode of ["missing", "empty"]) {
  test(`${mode} staged node_modules rejects without changing the packaged runtime`, async (t) => {
    const f = fixture(t);
    writeFile(join(f.app, "package.json"), runtimeManifest);
    if (mode === "empty") mkdirSync(f.stagedDependencies, { recursive: true });

    await assert.rejects(f.hook.default(f.context), (error) => {
      assert.match(error.message, /^afterPack: no staged node_modules at /);
      assert.ok(error.message.includes(f.stagedDependencies));
      return true;
    });
    assert.equal(existsSync(join(f.app, "node_modules")), false);
    assert.deepEqual(readFileSync(join(f.app, "package.json")), runtimeManifest);
  });
}

test("build configuration registers the tested hook and staged runtime destination", () => {
  const { afterPack, extraResources } = desktopPackage.build;
  assert.equal(typeof afterPack, "string");
  const configuredHook = resolve(desktopDir, afterPack);
  assert.equal(configuredHook, hookSource, "afterPack must register the hook exercised above");
  assert.equal(typeof require(configuredHook).default, "function");
  assert.ok(extraResources.some((entry) => entry.from === "stage/app" && entry.to === "app"),
    "extraResources must copy the staged runtime to resources/app before afterPack");
});

test("the explicit application file allowlist excludes the build-time hook", () => {
  const files = desktopPackage.build.files;
  assert.ok(Array.isArray(files) && files.length > 0, "build.files must be an explicit nonempty allowlist");
  for (const entry of files) {
    // Do not pretend that !files.includes('after-pack.cjs') evaluates builder
    // globs. If globs, directories, or FileSets are introduced, this guard must
    // be replaced with an electron-builder-level inclusion test.
    assert.equal(typeof entry, "string", "build.files FileSets need a builder-level inclusion test");
    const path = resolve(desktopDir, entry);
    assert.ok(existsSync(path) && statSync(path).isFile(),
      `build.files must name explicit existing files, not patterns or directories: ${entry}`);
    assert.notEqual(realpathSync(path), realpathSync(hookSource), "afterPack is build-time only");
  }
});
