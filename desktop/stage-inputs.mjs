/** Build-time filesystem guards. Importing this module never builds or packages. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function packageDirectory(name, from, root) {
  for (let at = from; ; at = dirname(at)) {
    const directory = join(at, "node_modules", name);
    const within = relative(root, directory);
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
      throw new Error("production dependency is outside its source root");
    }
    const metadata = join(directory, "package.json");
    try {
      if (!fs.statSync(metadata).isFile()) throw new Error(`dependency metadata is not a file: ${metadata}`);
      return directory;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      if (entryExists(directory)) throw new Error(`dependency metadata is missing: ${metadata}`);
    }
    const parent = dirname(at), above = relative(root, parent);
    if (at === root || parent === at || isAbsolute(above) || above === ".." || above.startsWith(`..${sep}`)) return null;
  }
}

/** Preserve the existing root seed policy; absent optional edges are explicit. */
export function productionDependencyClosure(root) {
  root = resolve(root);
  const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
  const queue = Object.keys(pkg.dependencies ?? {}).map((name) => ({
    name, from: root, optional: Object.hasOwn(pkg.optionalDependencies ?? {}, name),
  }));
  const directories = [], optionalMissing = [], seen = new Set();
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const directory = packageDirectory(name, from, root);
    if (!directory) {
      if (!optional) throw new Error(`missing required production dependency ${name} from ${relative(root, from) || "."}`);
      optionalMissing.push({ name, from: relative(root, from) || "." });
      continue;
    }
    if (seen.has(directory)) continue;
    // A present optional package is included and must have a complete closure.
    const child = JSON.parse(fs.readFileSync(join(directory, "package.json"), "utf8"));
    seen.add(directory);
    directories.push(directory);
    for (const dependency of Object.keys({ ...child.dependencies, ...child.optionalDependencies })) {
      queue.push({ name: dependency, from: directory,
        optional: Object.hasOwn(child.optionalDependencies ?? {}, dependency) });
    }
  }
  return { directories, optionalMissing };
}

function treeIdentity(root, rejectLinks) {
  const entries = {};
  function visit(directory, prefix, ancestors) {
    const actual = fs.realpathSync(directory);
    if (ancestors.has(actual)) throw new Error(`dependency directory cycle: ${directory}`);
    const next = new Set(ancestors).add(actual);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = join(directory, name), key = prefix ? `${prefix}/${name}` : name;
      const link = fs.lstatSync(file);
      if (rejectLinks && link.isSymbolicLink()) throw new Error(`staged dependency contains a symlink: ${key}`);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) {
        entries[key] = { kind: "directory" };
        visit(file, key, next);
      } else if (stat.isFile()) {
        entries[key] = { kind: "file", executable: Boolean(stat.mode & 0o111),
          sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
      } else throw new Error(`unsupported dependency entry: ${key}`);
    }
  }
  if (rejectLinks && fs.lstatSync(root).isSymbolicLink()) throw new Error("staged dependency root is a symlink");
  if (!fs.statSync(root).isDirectory()) throw new Error("dependency root is not a directory");
  visit(root, "", new Set());
  return entries;
}

/** A pre-existing nested copy is accepted only after complete byte/kind identity. */
export function copyProductionDependency(source, target) {
  const expected = treeIdentity(source, false);
  let copied = false;
  if (!entryExists(target)) {
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: () => true });
    copied = true;
  }
  const actual = treeIdentity(target, true);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("staged dependency does not match its source");
  return copied;
}

export const PGLITE_PAYLOADS = ["pglite.data", "pglite.wasm", "initdb.wasm"];

function entryExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function regularFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() ? info : null;
  }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

/** The loader layout is server/_libs, not the mere existence of a module dir. */
export function ensurePgliteAssets(app) {
  const libraries = join(app, ".output", "server", "_libs");
  const source = join(app, "node_modules", "@electric-sql", "pglite", "dist");
  for (const name of PGLITE_PAYLOADS) {
    const target = join(libraries, name);
    if (!entryExists(target)) {
      const input = join(source, name);
      const sourceInfo = regularFile(input);
      if (!sourceInfo) throw new Error(`missing required PGlite payload: ${name}`);
      if (sourceInfo.size === 0) throw new Error(`source PGlite payload is empty: ${name}`);
      fs.mkdirSync(libraries, { recursive: true });
      fs.copyFileSync(input, target);
    }
    const outputInfo = regularFile(target);
    if (!outputInfo) throw new Error(`PGlite payload is not a regular file: ${name}`);
    if (outputInfo.size === 0) throw new Error(`staged PGlite payload is empty: ${name}`);
  }
}
