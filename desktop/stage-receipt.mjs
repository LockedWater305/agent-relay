// Advisory stage observations, never a source attestation or installer digest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

const objectId = value => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const unbound = state => ({ state, commit: null, tree: null, byteVerified: false });

export function observeCheckout(root) {
  try {
    // Consult this checkout, not redirected Git object or index environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args) => execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, windowsHide: true,
    });
    if (!existsSync(join(root, ".git"))) return unbound("unavailable");
    const top = realpathSync(git("rev-parse", "--show-toplevel").trim());
    if (relative(realpathSync(root), top) !== "") return unbound("unavailable");
    if (git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none", "-z")) return unbound("dirty");
    const commit = git("rev-parse", "--verify", "HEAD^{commit}").trim();
    const tree = git("rev-parse", "--verify", `${commit}^{tree}`).trim();
    if (!objectId(commit) || !objectId(tree)) return unbound("unavailable");
    // Git ignores generated code, environment and dependencies. Never imply
    // the staged bytes came from this commit just because status was clean.
    return { state: "git-clean", commit, tree, byteVerified: false };
  } catch {
    return unbound("unavailable");
  }
}

export function finishCheckout(before, after) {
  if (before.state === "dirty" || after.state === "dirty") return unbound("dirty");
  if (before.state !== "git-clean" || after.state !== "git-clean") return unbound("unavailable");
  if (before.commit !== after.commit || before.tree !== after.tree) return unbound("changed");
  return after;
}

// Hash normalized entry paths, kinds, executable state, and content in lexical
// order. This describes only the bytes observed inside desktop/stage/app when
// staging completed. Missing/unexpected entries do not get a partial digest.
export function observeStagedRuntime(app) {
  const digest = createHash("sha256");
  let files = 0;
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const disk = join(directory, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(disk);
      if (stat.isDirectory()) {
        digest.update(JSON.stringify(["d", path]) + "\n");
        visit(disk, path);
      } else if (stat.isFile()) {
        const content = createHash("sha256").update(readFileSync(disk)).digest("hex");
        digest.update(JSON.stringify(["f", path, Boolean(stat.mode & 0o111), content]) + "\n");
        files++;
      } else {
        throw new Error("staged runtime contains a link or unsupported file");
      }
    }
  }
  const scope = "desktop/stage/app";
  const algorithm = "sha256-tree-v1";
  try {
    if (!lstatSync(app).isDirectory()) throw new Error("missing staged runtime directory");
    visit(app, "");
    if (!files) throw new Error("empty staged runtime directory");
    return { scope, algorithm, sha256: digest.digest("hex"), files };
  } catch {
    return { scope, algorithm, sha256: null, files: null };
  }
}
