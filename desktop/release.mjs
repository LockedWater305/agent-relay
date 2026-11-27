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
 *   - stable NSIS differential output requires a coherent installer/blockmap pair
 *   - every uploaded member is verified by size + sha256 against local bytes
 *
 * Usage
 *   node desktop/release.mjs                    # build, tag, publish
 *   node desktop/release.mjs --skip-build --prerelease  # prerelease only
 *   node desktop/release.mjs --allow-dev-pin --prerelease
 *   node desktop/release.mjs --dry-run          # print what it would do
 */
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
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
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const MAX_COMPRESSED_BLOCKMAP = 16 * 1024 * 1024;
const MAX_BLOCKMAP_JSON = 32 * 1024 * 1024;

function blockmapHasher() {
  // Follow the same dependency edge as the builder, not a value accidentally
  // hoisted into this script's search path. Validate each node against the
  // desktop lock (a root-only dependency install isn't an equivalent input).
  try {
    const { packages } = JSON.parse(readFileSync(join(DESKTOP, "package-lock.json"), "utf8"));
    const fromLockedPackage = (from, owner, name, subpath = "package.json") => {
      if (typeof (owner.dependencies?.[name] ?? owner.devDependencies?.[name]) !== "string") {
        throw new Error(`missing declared edge: ${owner.name} -> ${name}`);
      }
      const entry = from.resolve(`${name}/${subpath}`);
      const directory = dirname(entry);
      const key = relative(DESKTOP, directory).split(sep).join("/");
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const pin = packages?.[key];
      if (!key.startsWith("node_modules/") || manifest.name !== name || pin?.version !== manifest.version || !pin.integrity) {
        throw new Error(`not the desktop install locked for ${name}`);
      }
      return { entry, manifest, require: createRequire(entry) };
    };
    const start = createRequire(import.meta.url);
    const builder = fromLockedPackage(start, packages[""], "electron-builder");
    const appBuilder = fromLockedPackage(builder.require, builder.manifest, "app-builder-lib");
    const hash = fromLockedPackage(appBuilder.require, appBuilder.manifest, "@noble/hashes", "blake2.js");
    return appBuilder.require(hash.entry).blake2b;
  } catch (error) {
    throw new Error("installer blockmap verifier requires the locked desktop dependencies (npm ci in desktop)", { cause: error });
  }
}

function readBlockmap(file, installerBytes, required) {
  const meta = lstatSync(file, { throwIfNoEntry: false });
  if (!meta) {
    if (required) throw new Error("stable differential NSIS build is missing its installer blockmap");
    return null;
  }
  if (!meta.isFile() || meta.size < 1 || meta.size > MAX_COMPRESSED_BLOCKMAP) {
    throw new Error("installer blockmap size or file type is outside expected bounds");
  }
  // Read through an fd with an explicit allocation limit. A file growing or
  // being replaced after lstat must not turn this into an unbounded read.
  const fd = openSync(file, "r");
  let compressed;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== meta.size || opened.dev !== meta.dev || opened.ino !== meta.ino) {
      throw new Error("installer blockmap size or identity changed before read");
    }
    compressed = Buffer.allocUnsafe(meta.size);
    for (let offset = 0; offset < compressed.length;) {
      const n = readSync(fd, compressed, offset, compressed.length - offset, null);
      if (!n) throw new Error("installer blockmap size changed while reading");
      offset += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("installer blockmap size changed while reading");
  } finally { closeSync(fd); }
  let map;
  try { map = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_BLOCKMAP_JSON }).toString("utf8")); }
  catch (error) { throw new Error("installer blockmap gzip/JSON invalid or exceeds the expansion bound", { cause: error }); }
  const entry = map?.files?.[0];
  // The locked app-builder-lib NSIS target emits an external gzip v2 map:
  // one file, offset zero, ordered sizes and BLAKE2b-144 checksums.
  if (map?.version !== "2" || !Array.isArray(map.files) || map.files.length !== 1 || entry?.name !== "file" ||
      entry.offset !== 0 || !Array.isArray(entry.sizes) || !Array.isArray(entry.checksums) ||
      !entry.sizes.length || entry.sizes.length !== entry.checksums.length) {
    throw new Error("unsupported installer blockmap shape");
  }
  const blake2b = blockmapHasher();
  let offset = 0;
  for (let i = 0; i < entry.sizes.length; i++) {
    const size = entry.sizes[i];
    if (!Number.isSafeInteger(size) || size < 1 || size > 32 * 1024 || size > installerBytes.length - offset) {
      throw new Error("installer blockmap sizes do not cover the installer bytes");
    }
    const expected = Buffer.from(blake2b(installerBytes.subarray(offset, offset + size), { dkLen: 18 })).toString("base64");
    if (entry.checksums[i] !== expected) throw new Error(`installer blockmap checksum mismatch at chunk ${i}`);
    offset += size;
  }
  if (offset !== installerBytes.length) throw new Error("installer blockmap does not fully cover the installer bytes");
  return compressed;
}

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
  if (lstatSync(installer, { throwIfNoEntry: false }) || lstatSync(blockmap, { throwIfNoEntry: false })) {
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
if (!lstatSync(installer, { throwIfNoEntry: false })?.isFile()) {
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
const installerBytes = readFileSync(installer);
const bytes = installerBytes.length;
const sha = sha256(installerBytes);
let blockmapBytes;
try {
  blockmapBytes = readBlockmap(blockmap, installerBytes, !prerelease && pkg.build?.nsis?.differentialPackage !== false);
} catch (error) {
  console.error(`refusing: ${error.message}`);
  process.exit(1);
}
const uploadFiles = [
  { path: installer, name: basename(installer), size: bytes, hash: sha },
  ...(blockmapBytes ? [{ path: blockmap, name: basename(blockmap), size: blockmapBytes.length, hash: sha256(blockmapBytes) }] : []),
];

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
${blockmapBytes ? `- Differential blockmap SHA-256 \`${uploadFiles[1].hash}\` (checked against the installer bytes)` : "- No differential blockmap for this download."}
- This release does not publish an automatic update feed.
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
if (blockmapBytes) log(`local blockmap matches installer bytes · sha256 ${uploadFiles[1].hash}`);
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
    json = run("gh", ["release", "view", tag, "-R", REPO, "--json", "isPrerelease,assets"], { capture: true });
  } catch (err) {
    const stderr = String(err.stderr ?? "");
    if (/^release not found\s*$/im.test(stderr) || /\bHTTP 404\b/i.test(stderr)) return null;
    throw new Error("cannot determine existing release channel; nothing was changed", { cause: err });
  }
  const data = JSON.parse(json);
  if (typeof data?.isPrerelease !== "boolean") throw new Error("existing release has no channel metadata; nothing was changed");
  if (!Array.isArray(data.assets)) throw new Error("existing release has no asset metadata; nothing was changed");
  return data;
})();
if (existing && existing.isPrerelease !== prerelease) {
  console.error(`refusing: release channel mismatch for ${tag} (existing prerelease=${existing.isPrerelease}, requested prerelease=${prerelease}); the existing download was not replaced`);
  process.exit(1);
}

if (existing && !blockmapBytes && existing.assets.some(asset => asset.name === basename(blockmap))) {
  console.error("refusing: existing release has a blockmap; supply the matching new blockmap before replacing its installer");
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
const assets = uploadFiles.map(file => file.path);
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
// Check every canonical asset, and don't emit a success receipt for half
// of an installer/blockmap pair. This does not prove an update feed or signer.
if (!Array.isArray(parsed.assets)) throw new Error("GitHub returned no asset metadata; uploads are unverified");
for (const file of uploadFiles) {
  const matches = parsed.assets.filter((asset) => asset.name === file.name);
  const asset = matches.length === 1 ? matches[0] : null;
  if (!asset || asset.size !== file.size) {
    console.error(`FAILED: missing, ambiguous or wrong size for uploaded asset ${file.name}`);
    process.exit(1);
  }
  if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    console.error(`FAILED: GitHub has not supplied a SHA-256 digest for ${file.name}; uploaded bytes are unverified`);
    process.exit(1);
  }
  if (asset.digest.toLowerCase() !== `sha256:${file.hash}`) {
    console.error(`FAILED: ${file.name} uploaded digest ${asset.digest} != local sha256:${file.hash}`);
    process.exit(1);
  }
}
for (const file of uploadFiles) log(`verified on GitHub: ${file.name} ${file.size} b · sha256 ${file.hash} · prerelease=${parsed.prerelease}`);
log("automatic update feed and installer signature not verified");
log(`download page: ${parsed.html_url}`);
