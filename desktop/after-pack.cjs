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

const { cpSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

/** Where resources/ lives inside the unpacked app for this platform. */
function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return join(appOutDir, "resources");
}

exports.default = async function afterPack(context) {
  const app = join(resourcesDir(context), "app");
  const src = join(__dirname, "stage", "app", "node_modules");
  if (!existsSync(join(app, "package.json"))) {
    throw new Error(`afterPack: no runtime at ${app} — extraResources did not copy stage/app`);
  }
  if (!existsSync(src) || readdirSync(src).length === 0) {
    throw new Error(`afterPack: no staged node_modules at ${src} — run \`node dist.mjs stage\` first`);
  }
  cpSync(src, join(app, "node_modules"), { recursive: true, dereference: true });
  console.log(`  • afterPack: production node_modules added under ${app}`);
};

// For tests.
exports.resourcesDir = resourcesDir;
