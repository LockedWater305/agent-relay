#!/usr/bin/env node
/**
 * Publish the desktop installer as a GitHub Release.
 *
 * Why a script and not a habit: a release is four things that must agree —
 * the version in `desktop/package.json`, a tag on the commit that was actually
 * built, an artifact whose bytes match that commit, and notes that say which
 * trust anchor it carries. Doing that by hand is how a "latest" download ends up
 * being yesterday's build.
 *
 * Rules it enforces:
 *   - never commit a binary; the installer rides the release, git carries source
 *   - the tag is `desktop-v<version>` (the server keeps plain `v<version>`; two
 *     release lines, two tag namespaces, no ambiguity at a glance)
 *   - a build carrying a DEV publisher pin can only ship as a prerelease
 *     (`--allow-dev-pin` required; never eligible for the stable channel)
 *   - the uploaded asset is verified by size + sha256 against the local file
 *
 * Usage
 *   node desktop/release.mjs                    # build, tag, publish
 *   node desktop/release.mjs --skip-build --prerelease  # prerelease only
 *   node desktop/release.mjs --allow-dev-pin --prerelease
 *   node desktop/release.mjs --dry-run          # print what it would do
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DESKTOP, "..");
const REPO = "GumbyEnder/agent-relay";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const DRY = flag("--dry-run");
const SKIP_BUILD = flag("--skip-build");
const ALLOW_DEV = flag("--allow-dev-pin");
const MOVE_TAG = flag("--move-tag");
const FORCE_PRE = flag("--prerelease");
// The commit the artifact was built from. Defaults to HEAD; pass --ref when the
// packaging script or notes changed after the build (the app bytes did not).
const REF = (() => {
  const i = args.indexOf("--ref");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const log = (m) => console.log(`[release] ${m}`);
const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { cwd: opts.cwd ?? ROOT, stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });

const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
const version = pkg.version;
const tag = `desktop-v${version}`;
const installer = join(ROOT, "dist-desktop", `BeeZilla-Setup-${version}.exe`);
const blockmap = `${installer}.blockmap`;

/* -- trust anchor: never publish a dev pin as a normal release -------------- */
// Resolve once, using the caller cwd. dist.mjs runs with cwd=ROOT and must
// not resolve a relative override against a different pins file there.
const pinsPath = resolve(process.env.BZ_RECIPE_PUBLISHER_FILE ?? join(ROOT, "publishers.json"));
let pins = [], pinsBytes;
try {
  pinsBytes = readFileSync(pinsPath);
  pins = JSON.parse(pinsBytes.toString("utf8")).publishers ?? [];
} catch {
  pins = [];
}
const devPin = pins.some(
  (p) => /dev|test/i.test(`${p.keyId ?? ""} ${p.label ?? ""}`) || /devtest/i.test(JSON.stringify(p)),
);
if (!pins.length) {
  console.error(`refusing: no publisher pins in ${pinsPath} — a build with no trust anchor cannot verify a fetched recipe`);
  process.exit(1);
}
if (devPin && !ALLOW_DEV) {
  console.error(
    `refusing: the pins in ${pinsPath} look like DEV keys (${pins.map((p) => p.keyId).join(", ")}).\n` +
      `A release that trusts a test anchor cannot be a normal download. Re-run with --allow-dev-pin to publish it as a prerelease.`,
  );
  process.exit(1);
}
const prerelease = FORCE_PRE || devPin;

// An existing .exe does not carry a verified link to today's publisher pins
// or this source ref. Do not promote it based on local config or filename.
if (!prerelease && SKIP_BUILD) {
  console.error("refusing: stable releases require a fresh build; --skip-build is prerelease only");
  process.exit(1);
}
if (!prerelease && flag("--ref")) {
  console.error("refusing: stable releases must build and tag current HEAD; omit --ref");
  process.exit(1);
}

let stableHead = null;
if (!prerelease && !DRY) {
  if (existsSync(installer) || existsSync(blockmap)) {
    console.error("refusing: move the existing installer/blockmap output aside before a fresh stable build");
    process.exit(1);
  }
  stableHead = run("git", ["-C", ROOT, "rev-parse", "--verify", "HEAD^{commit}"], { capture: true }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(stableHead)) throw new Error("cannot identify stable release HEAD");
  const status = run("git", ["-C", ROOT, "status", "--porcelain"], { capture: true }).trim();
  if (status) throw new Error("working tree is dirty; stable release build was not started");
}


/* -- artifact --------------------------------------------------------------- */
if (!SKIP_BUILD) {
  log(`building ${tag}`);
  if (!DRY) run(process.execPath, [join(DESKTOP, "dist.mjs"), "all"], {
    env: { ...process.env, BZ_RECIPE_PUBLISHER_FILE: pinsPath },
  });
}
if (!existsSync(installer)) {
  console.error(`refusing: ${installer} does not exist — build it first (drop --skip-build)`);
  process.exit(1);
}
if (stableHead && run("git", ["-C", ROOT, "rev-parse", "--verify", "HEAD^{commit}"], { capture: true }).trim() !== stableHead) {
  console.error("refusing: HEAD changed during the stable build; no release was created");
  process.exit(1);
}
if (stableHead) {
  const stagedPath = join(DESKTOP, "stage", "app", "publishers.json");
  let matches = false;
  try { matches = readFileSync(stagedPath).equals(pinsBytes); } catch {}
  if (!matches) {
    console.error("refusing: staged publisher pins are missing or changed from stable preflight; no release was created");
    process.exit(1);
  }
}
const bytes = statSync(installer).size;
const sha = createHash("sha256").update(readFileSync(installer)).digest("hex");

/* -- the commit must be the one that was built ------------------------------ */
const sourceRef = stableHead ?? REF ?? "HEAD";
const head = run("git", ["-C", ROOT, "rev-parse", "--short", sourceRef], { capture: true }).trim();
const branch = run("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).trim();
const dirty = run("git", ["-C", ROOT, "status", "--porcelain"], { capture: true }).trim();
if (dirty && !DRY) {
  console.error(`refusing: working tree is dirty — a release must be buildable from its tag\n${dirty}`);
  process.exit(1);
}

const notes = `## BeeZilla Desktop ${version} — Windows x64

Electron shell over the local runtime (Nitro + embedded PGlite). Ships beside it, not instead of it:
the same pages, routes and migrations as the hosted app at https://app.devboards.ai.

- ${SKIP_BUILD ? "Reported source (existing artifact linkage not verified)" : "Built from"} \`${head}\` on \`${branch}\`
- Installer: \`BeeZilla Setup ${version}.exe\` — ${(bytes / 1024 / 1024).toFixed(1)} MB
- SHA-256 \`${sha}\`
- ${SKIP_BUILD ? "Configured publisher pins (not verified in the existing artifact)" : "Publisher pins"}: ${pins.map((p) => `\`${p.keyId}\` (${p.label ?? "no label"})`).join(", ")}
${devPin ? "- **Prerelease:** build configuration contains a DEV trust anchor. Not for general distribution." : ""}
- Authenticode status is not verified by this script. Check the installer signature independently.

Install: double-click, pick a directory, then connect a BeeZilla account (menu → *Connect BeeZilla account…*)
or paste your own provider key in Settings. Data lives in \`%APPDATA%\\BeeZilla\\data\`.
`;

log(`tag        ${tag}`);
log(`artifact   ${installer}`);
log(`bytes      ${bytes}`);
log(`sha256     ${sha}`);
log(`commit     ${head} (${branch})`);
log(`prerelease ${prerelease}${devPin ? " (dev pin)" : ""}`);

if (DRY) {
  log("dry run — nothing tagged or uploaded");
  process.exit(0);
}

// The upload path below uses --clobber; it inherits an existing release's
// visibility rather than the requested --prerelease flag. Check before any tag
// or release write, and distinguish a missing release from an unavailable API.
const existing = (() => {
  let json;
  try {
    json = run("gh", ["release", "view", tag, "-R", REPO, "--json", "isPrerelease"], { capture: true });
  } catch (err) {
    const stderr = String(err.stderr ?? "");
    if (/^release not found\s*$/im.test(stderr) || /\bHTTP 404\b/i.test(stderr)) return null;
    throw new Error("cannot determine existing release channel; nothing was changed", { cause: err });
  }
  const data = JSON.parse(json);
  if (typeof data?.isPrerelease !== "boolean") throw new Error("existing release has no channel metadata; nothing was changed");
  return data;
})();
if (existing && existing.isPrerelease !== prerelease) {
  console.error(`refusing: release channel mismatch for ${tag} (existing prerelease=${existing.isPrerelease}, requested prerelease=${prerelease}); the existing download was not replaced`);
  process.exit(1);
}

/* -- tag: idempotent -------------------------------------------------------- */
const hasTag = run("git", ["-C", ROOT, "tag", "--list", tag], { capture: true }).trim() === tag;
if (hasTag) {
  // A tag that points at a different commit than the one that was built is the
  // worst kind of lie: the download is real, the source link is not.
  const tagged = run("git", ["-C", ROOT, "rev-parse", "--short", `${tag}^{commit}`], { capture: true }).trim();
  if (tagged !== head) {
    if (!MOVE_TAG) {
      console.error(
        `refusing: ${tag} points at ${tagged} but this artifact was built from ${head}.\n` +
          `Re-run with --move-tag to move the tag onto the built commit.`,
      );
      process.exit(1);
    }
    run("git", ["-C", ROOT, "tag", "-f", "-a", tag, sourceRef, "-m", `BeeZilla Desktop ${version}`]);
    run("git", ["-C", ROOT, "push", "--force", "github", tag]);
    log(`tag ${tag} moved ${tagged} -> ${head}`);
  }
}
if (!hasTag) {
  run("git", ["-C", ROOT, "tag", "-a", tag, sourceRef, "-m", `BeeZilla Desktop ${version}`]);
  run("git", ["-C", ROOT, "push", "github", tag]);
  log(`tagged ${tag}`);
} else {
  log(`tag ${tag} already exists — publishing its artifact`);
}

/* -- release ---------------------------------------------------------------- */
const assets = [installer, existsSync(blockmap) ? blockmap : null].filter(Boolean);
if (existing) {
  log(`release ${tag} exists — uploading assets (clobber)`);
  run("gh", ["release", "upload", tag, ...assets, "--clobber", "-R", REPO]);
} else {
  const notesFile = join(ROOT, "dist-desktop", `RELEASE-${version}.md`);
  writeFileSync(notesFile, notes);
  run("gh", [
    "release", "create", tag,
    ...assets,
    "--title", `BeeZilla Desktop ${version} (Windows x64)`,
    "--notes-file", notesFile,
    ...(prerelease ? ["--prerelease"] : []),
    "-R", REPO,
  ]);
  log(`release ${tag} created`);
}

/* -- verify what the world will download ------------------------------------ */
// Query GitHub's REST asset metadata directly: some gh versions omit the
// server-computed digest when exporting assets via "release view --json".
const remote = run("gh", ["api", `repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`], { capture: true });
const parsed = JSON.parse(remote);
if (parsed.prerelease !== prerelease) {
  console.error(`FAILED: expected prerelease=${prerelease}, GitHub now reports prerelease=${parsed.prerelease}; check the release channel`);
  process.exit(1);
}
const wanted = `BeeZilla-Setup-${version}.exe`;
// This invocation uploads the canonical basename, not the dotted legacy file.
// A different asset with matching bytes does not verify the file just posted.
const asset = parsed.assets.find((a) => a.name === wanted);
if (!asset) {
  console.error(`FAILED: ${tag} has no installer asset`);
  process.exit(1);
}
if (asset.size !== bytes) {
  console.error(`FAILED: uploaded size ${asset.size} != local ${bytes}`);
  process.exit(1);
}
if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
  console.error(`FAILED: GitHub has not supplied a SHA-256 digest for ${asset.name}; uploaded bytes are unverified`);
  process.exit(1);
}
if (asset.digest.toLowerCase() !== `sha256:${sha}`) {
  console.error(`FAILED: uploaded digest ${asset.digest} != local sha256:${sha}`);
  process.exit(1);
}
log(`verified on GitHub: ${asset.name} ${asset.size} b · prerelease=${parsed.prerelease}`);
log(`download page: ${parsed.html_url}`);
log(`sha256 ${sha} — compare it after downloading`);
