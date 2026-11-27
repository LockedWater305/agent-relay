/**
 * electron-builder afterPack hook (package.json build.afterPack).
 *
 * Puts the runtime's production node_modules into resources/app for EVERY
 * target: the Windows NSIS release (`node dist.mjs all`) and the local unpacked
 * test build (`node dist.mjs dir`).
 *
 * Why: build.extraResources copies stage/app to resources/app, but
 * app-builder-lib's copy filter always drops a top-level `node_modules` of the
 * source folder. Without this hook the packaged runtime has none of its
 * dependencies and cannot start. afterPack runs after the unpacked app is
 * written and BEFORE any installer is built from it, so the NSIS installer
 * carries the folder too.
 *
 * Build-time only: this file is not listed in build.files and never ships.
 */
"use strict";

const { cpSync, lstatSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/** Where resources/ lives inside the unpacked app for this platform. */
function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return join(appOutDir, "resources");
}

function stageReceiptFile(stage) {
  const lock = join(stage, ".build-lock");
  const lockStat = lstatSync(lock, { throwIfNoEntry: false });
  const attempt = process.env.BZ_DESKTOP_STAGE_ATTEMPT;
  if (!lockStat && attempt === undefined) return join(stage, "MANIFEST.json");

  // electron-builder 26 invokes afterPack in its own JS process, which dist
  // starts directly. The attempt ID is not a portable lock override: it must
  // name a real pending receipt bound to this child's still-live parent.
  const owner = process.ppid;
  if (lockStat?.isDirectory() && /^[a-f0-9]{32}$/.test(attempt ?? "") &&
      Number.isSafeInteger(owner) && owner > 1) {
    const pending = join(lock, `pending-${owner}-${attempt}.json`);
    if (lstatSync(pending, { throwIfNoEntry: false })?.isFile()) {
      try {
        process.kill(owner, 0); // Liveness check only; sends no signal.
        return pending;
      } catch { /* Refuse if the original parent cannot be verified. */ }
    }
  }
  throw new Error(
    "afterPack: no live matching desktop build attempt — wait for the owner or remove an abandoned " +
    "desktop/stage/.build-lock only after confirming all desktop builds have stopped; then run `node dist.mjs stage`"
  );
}

function readRuntimeReceipt(receiptFile) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptFile, "utf8")).stagedRuntime; }
  catch { throw new Error("afterPack: no readable stage receipt — rebuild with `node dist.mjs stage`"); }
  if (receipt?.scope !== "desktop/stage/app" || receipt.algorithm !== "sha256-tree-v1" ||
      typeof receipt.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.files) || receipt.files < 1 ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1) {
    throw new Error("afterPack: stage receipt has no usable runtime digest — rebuild with `node dist.mjs stage`");
  }
  return receipt;
}

exports.default = async function afterPack(context) {
  const app = join(resourcesDir(context), "app");
  const stage = join(__dirname, "stage");
  const stageApp = join(stage, "app");
  const src = join(stageApp, "node_modules");
  if (!lstatSync(app, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(join(app, "package.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`afterPack: no runtime at ${app} — extraResources did not copy stage/app`);
  }
  if (!lstatSync(src, { throwIfNoEntry: false })?.isDirectory() || readdirSync(src).length === 0) {
    throw new Error(`afterPack: no staged node_modules at ${src} — run \`node dist.mjs stage\` first`);
  }

  const { observeStagedRuntime } = await import("./stage-receipt.mjs");
  const receiptFile = stageReceiptFile(stage);
  const expected = readRuntimeReceipt(receiptFile);
  const verify = (directory, label) => {
    const observed = observeStagedRuntime(directory);
    if (observed.sha256 !== expected.sha256 || observed.files !== expected.files || observed.bytes !== expected.bytes) {
      throw new Error(`afterPack: ${label} does not match the stage receipt — rebuild the desktop output`);
    }
  };
  verify(stageApp, "staged runtime");

  const target = join(app, "node_modules");
  if (!lstatSync(target, { throwIfNoEntry: false })) {
    // Force the JS traversal rather than a native copy that can retain .bin
    // symlinks. A valid staged receipt already forbids links in these bytes.
    cpSync(src, target, { recursive: true, dereference: true, filter: () => true });
  }
  // Do not merge or overwrite dependencies left by an old unpacked app. The
  // exact final runtime (including extraResources) must match as one tree.
  verify(app, "unpacked runtime");
  const currentReceiptFile = stageReceiptFile(stage);
  const current = readRuntimeReceipt(currentReceiptFile);
  if (currentReceiptFile !== receiptFile || current.sha256 !== expected.sha256 ||
      current.files !== expected.files || current.bytes !== expected.bytes) {
    throw new Error("afterPack: stage receipt changed during packaging — rebuild the desktop output");
  }
  console.log(`  • afterPack: staged and unpacked runtime bytes verified at ${app}`);
};

// For tests.
exports.resourcesDir = resourcesDir;
