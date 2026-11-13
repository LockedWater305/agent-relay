/**
 * Capability broker for BeeZilla desktop's "work on my local files" feature.
 *
 * Authority lives only in the main process. A folder becomes readable when the main process
 * calls grantFolder() with a path the owner chose in a native folder picker. Nothing a model,
 * a web page, a recipe, a file, AGENTS.md or tool output says can make that call.
 *
 * Enforced here (each rule has a test in scripts/test-capability-broker.mjs):
 *   - read-only: there is no write operation
 *   - a new grant is inactive; activate() is an explicit step for the session
 *   - pause() and resume() are reversible; revoke() is final
 *   - every operation re-checks its grant between filesystem steps and again before it returns;
 *     a state change while it runs makes it fail with `superseded` and return nothing
 *   - paths are checked before they are joined: no NUL, absolute, drive, UNC or ".." forms
 *   - a path is used only when its real location (fs.realpath) is the grant root or lies under
 *     root + path.sep; a link is read through only when its target is inside the grant
 *   - listing and search never follow a symbolic link
 *   - a file is read through a descriptor opened with O_NOFOLLOW where the platform has it; the
 *     descriptor's fstat must match an lstat of the resolved path, and that path must still
 *     resolve inside the grant, before any byte is read
 *   - a granted folder that was moved, renamed or replaced is refused as stale_grant
 *
 * Not enforced (see the test file and the report): hard links from inside a grant to files
 * outside it; mount points or disk images inside a grant; a process running as the same user
 * that swaps folders during a listing (the swap is detected and the result discarded, but Node
 * cannot list a directory by descriptor); Windows junctions and reserved device names beyond the
 * rules above, which are untested on Windows. A pause or revoke that lands after an operation's
 * last check, but before the caller reads the result, does not undo that result.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const ERROR_CODES = Object.freeze([
  // The roadmap's list.
  "not_granted", "inactive", "paused", "revoked", "outside_grant", "bad_path",
  "symlink_escape", "not_found", "too_large", "not_text", "changed_during_read", "superseded",
  // Added for cases the roadmap list did not name.
  "stale_grant", "not_directory", "not_a_file", "root_refused", "bad_argument", "io_error",
]);

const ACTIVITY_LIMIT = 500;
const MAX_PATH_CHARS = 4096;
const MAX_LABEL_CHARS = 200;
const MAX_QUERY_CHARS = 256;
// A search keeps going past a folder it cannot read and past one that vanished mid-walk.
const SEARCH_SKIPS = new Set(["io_error", "not_found"]);
// O_NOFOLLOW does not exist on Windows. O_NONBLOCK stops open() from blocking on a FIFO.
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

class BrokerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "BrokerError";
    this.code = code;
  }
}

export function createBroker({ now = () => Date.now(), maxReadBytes = 2_000_000, onActivity } = {}) {
  if (typeof now !== "function") throw new BrokerError("bad_argument", "now must be a function");
  if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
    throw new BrokerError("bad_argument", "maxReadBytes must be a positive integer");
  }
  if (onActivity !== undefined && typeof onActivity !== "function") {
    throw new BrokerError("bad_argument", "onActivity must be a function");
  }

  const grants = new Map();
  const log = [];

  function record(op, grantId, relPath, ok, reason = null) {
    const entry = Object.freeze({
      at: now(),
      grantId: typeof grantId === "string" ? grantId : null,
      op,
      path: typeof relPath === "string" ? relPath.slice(0, MAX_PATH_CHARS) : null,
      ok,
      reason,
    });
    log.push(entry);
    if (log.length > ACTIVITY_LIMIT) log.splice(0, log.length - ACTIVITY_LIMIT);
    if (onActivity) {
      try {
        onActivity(entry);
      } catch {
        // A failing listener must not change what the operation did.
      }
    }
  }

  function refuse(op, id, relPath, code, message) {
    record(op, id, relPath, false, code);
    return new BrokerError(code, message);
  }

  function findGrant(id) {
    return typeof id === "string" ? grants.get(id) : undefined;
  }

  // An unknown id is never written to the log: the caller chose that string, and the activity
  // panel shows the log to the owner.
  function transition(op, id, apply) {
    const grant = findGrant(id);
    if (!grant) throw refuse(op, null, undefined, "not_granted", "no such grant");
    if (grant.revoked) throw refuse(op, grant.id, undefined, "revoked", "the grant has been revoked");
    apply(grant);
    grant.generation += 1;
    record(op, grant.id, undefined, true);
    return summary(grant);
  }

  // Runs one file operation. The grant is checked synchronously before the first await. body()
  // returns { value, logReason }. The last generation check discards a result that a state change
  // overtook while body() was waiting on the filesystem.
  async function run(op, id, relPath, body) {
    const grant = findGrant(id);
    if (!grant) throw refuse(op, null, relPath, "not_granted", "no such grant");
    const generation = grant.generation;
    try {
      assertUsable(grant);
      const outcome = await body(grant, generation);
      assertCurrent(grant, generation);
      record(op, grant.id, relPath, true, outcome.logReason ?? null);
      return outcome.value;
    } catch (err) {
      const error = toBrokerError(err);
      record(op, grant.id, relPath, false, error.code);
      throw error;
    }
  }

  return Object.freeze({
    async grantFolder(chosenPath, options) {
      const label = options?.label;
      try {
        if (typeof chosenPath !== "string" || chosenPath === "") {
          throw new BrokerError("bad_path", "the chosen folder must be a non-empty string");
        }
        if (chosenPath.includes("\0")) {
          throw new BrokerError("bad_path", "the chosen folder contains a NUL byte");
        }
        if (!path.isAbsolute(chosenPath)) {
          throw new BrokerError("bad_path", "the chosen folder must be an absolute path");
        }
        if (label != null && (typeof label !== "string" || label.length > MAX_LABEL_CHARS)) {
          throw new BrokerError("bad_argument", `label must be text of at most ${MAX_LABEL_CHARS} characters`);
        }
        const real = await realpathOrThrow(chosenPath, "chosen folder");
        const st = await statOrThrow(real, "chosen folder");
        if (!st.isDirectory()) throw new BrokerError("not_directory", "the chosen path is not a folder");
        if (path.parse(real).root === real) {
          throw new BrokerError("root_refused", "the filesystem root cannot be granted");
        }
        const home = homeDirectory();
        if (home === null) {
          throw new BrokerError("root_refused", "the home folder is unknown, so no folder can be granted");
        }
        const homeReal = await fsp.realpath(home).catch(() => home);
        if (isWithin(homeReal, real) || isWithin(home, real)) {
          throw new BrokerError(
            "root_refused",
            "the home folder and the folders above it cannot be granted; choose a folder inside home",
          );
        }
        const name =
          typeof label === "string" && label.trim() !== "" ? label.trim() : path.basename(real) || real;
        const grant = {
          id: randomUUID(),
          label: name,
          root: real,
          rootDev: st.dev,
          rootIno: st.ino,
          createdAt: now(),
          active: false,
          paused: false,
          revoked: false,
          generation: 0,
        };
        grants.set(grant.id, grant);
        record("grant", grant.id, undefined, true);
        return { id: grant.id, label: grant.label, root: grant.root, createdAt: grant.createdAt };
      } catch (err) {
        const error = toBrokerError(err);
        record("grant", null, undefined, false, error.code);
        throw error;
      }
    },

    activate(id) {
      return transition("activate", id, (grant) => {
        grant.active = true;
      });
    },

    pause(id) {
      return transition("pause", id, (grant) => {
        grant.paused = true;
      });
    },

    resume(id) {
      return transition("resume", id, (grant) => {
        grant.paused = false;
      });
    },

    revoke(id) {
      const grant = findGrant(id);
      if (!grant) throw refuse("revoke", null, undefined, "not_granted", "no such grant");
      if (!grant.revoked) {
        grant.revoked = true;
        grant.active = false;
        grant.generation += 1;
      }
      record("revoke", grant.id, undefined, true);
      return summary(grant);
    },

    list() {
      return [...grants.values()].map(summary);
    },

    async listDir(id, relPath = "") {
      return run("listDir", id, relPath, async (grant, generation) => {
        const segments = normalizeRelPath(relPath);
        const rootReal = await currentRoot(grant);
        assertCurrent(grant, generation);
        const dir = await resolveDirectory(rootReal, segments);
        const entries = await readDirectoryChecked(dir);
        const prefix = segments.join("/");
        return {
          value: {
            path: prefix,
            entries: sortByName(entries).map((ent) => ({
              name: ent.name,
              path: joinRel(prefix, ent.name),
              type: classify(ent),
            })),
          },
        };
      });
    },

    async readFile(id, relPath, options) {
      return run("readFile", id, relPath, async (grant, generation) => {
        const segments = normalizeRelPath(relPath);
        const cap = readCap(options, maxReadBytes);
        if (segments.length === 0) {
          throw new BrokerError("not_a_file", "the granted folder itself is not a file");
        }
        const rootReal = await currentRoot(grant);
        assertCurrent(grant, generation);
        const still = () => assertCurrent(grant, generation);
        const { handle, size } = await openInsideGrant(rootReal, segments, still);
        try {
          if (size > cap) throw new BrokerError("too_large", `the file is larger than ${cap} bytes`);
          const want = Math.min(size, cap) + 1; // the spare byte notices a file that grew past cap
          const buffer = Buffer.allocUnsafe(want);
          let total = 0;
          while (total < want) {
            const { bytesRead } = await handle.read(buffer, total, want - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > cap) throw new BrokerError("too_large", `the file is larger than ${cap} bytes`);
          still();
          const bytes = buffer.subarray(0, total);
          if (bytes.includes(0)) {
            throw new BrokerError("not_text", "the file is binary (it contains NUL bytes)");
          }
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new BrokerError("not_text", "the file is not UTF-8 text");
          }
          return { value: { path: segments.join("/"), bytes: total, text } };
        } finally {
          await handle.close().catch(() => {});
        }
      });
    },

    async search(id, query, options) {
      return run("search", id, undefined, async (grant, generation) => {
        if (typeof query !== "string" || query.length === 0 || query.length > MAX_QUERY_CHARS) {
          throw new BrokerError("bad_argument", `the query must be 1 to ${MAX_QUERY_CHARS} characters`);
        }
        const limit = intOption(options?.limit, 50, 1, 10_000, "limit");
        const maxFiles = intOption(options?.maxFiles, 5_000, 1, 1_000_000, "maxFiles");
        const needle = query.toLowerCase();
        const rootReal = await currentRoot(grant);
        assertCurrent(grant, generation);
        const found = { matches: [], scanned: 0, skipped: 0, stoppedBy: null };

        // Depth-first, names in order. Every entry examined counts toward maxFiles.
        const visit = async (entries, dirPath, prefix) => {
          for (const ent of sortByName(entries)) {
            if (found.stoppedBy) return;
            if (found.scanned >= maxFiles) {
              found.stoppedBy = "maxFiles";
              return;
            }
            found.scanned += 1;
            const rel = joinRel(prefix, ent.name);
            const type = classify(ent);
            if (ent.name.toLowerCase().includes(needle)) {
              if (found.matches.length >= limit) {
                found.stoppedBy = "limit";
                return;
              }
              found.matches.push({ path: rel, type });
            }
            if (type !== "dir") continue; // links and other entries are reported, never entered
            const childPath = path.join(dirPath, ent.name);
            let childEntries;
            try {
              childEntries = await readDirectoryChecked(childPath);
            } catch (err) {
              if (SEARCH_SKIPS.has(err.code)) {
                found.skipped += 1;
                continue;
              }
              throw err;
            }
            assertCurrent(grant, generation);
            await visit(childEntries, childPath, rel);
          }
        };

        const rootEntries = await readDirectoryChecked(rootReal);
        assertCurrent(grant, generation);
        await visit(rootEntries, rootReal, "");
        await currentRoot(grant);
        return {
          value: {
            query,
            matches: found.matches,
            scanned: found.scanned,
            skipped: found.skipped,
            truncated: found.stoppedBy !== null,
            stoppedBy: found.stoppedBy,
          },
          logReason: found.stoppedBy,
        };
      });
    },

    activity() {
      return log.slice();
    },
  });
}

function summary(grant) {
  return {
    id: grant.id,
    label: grant.label,
    root: grant.root,
    active: grant.active,
    paused: grant.paused,
    revoked: grant.revoked,
    createdAt: grant.createdAt,
  };
}

function assertUsable(grant) {
  if (grant.revoked) throw new BrokerError("revoked", "the grant has been revoked");
  if (grant.paused) throw new BrokerError("paused", "the grant is paused");
  if (!grant.active) throw new BrokerError("inactive", "the grant has not been activated in this session");
}

function assertCurrent(grant, generation) {
  if (grant.generation !== generation) {
    throw new BrokerError(
      "superseded",
      "the grant changed while this operation ran; its result was discarded",
    );
  }
}

function homeDirectory() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.isAbsolute(home) ? path.resolve(home) : null;
}

/** True when child is root itself or lies under root, comparing whole path segments. */
function isWithin(child, root) {
  if (child === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(prefix);
}

/** Checks a caller's relative path before it is joined onto a grant root. */
function normalizeRelPath(input) {
  if (typeof input !== "string") throw new BrokerError("bad_path", "the path must be a string");
  if (input.length > MAX_PATH_CHARS) throw new BrokerError("bad_path", "the path is too long");
  if (input.includes("\0")) throw new BrokerError("bad_path", "the path contains a NUL byte");
  const slashed = input.replace(/\\/g, "/");
  if (slashed.startsWith("/")) {
    throw new BrokerError("bad_path", "absolute and UNC paths are not allowed");
  }
  if (/^[A-Za-z]:/.test(slashed)) throw new BrokerError("bad_path", "drive-letter paths are not allowed");
  const segments = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (/^\.{2,}$/.test(part)) throw new BrokerError("bad_path", "'..' segments are not allowed");
    if (process.platform === "win32" && part.includes(":")) {
      throw new BrokerError("bad_path", "alternate data stream names are not allowed");
    }
    segments.push(part);
  }
  return segments;
}

function readCap(options, ceiling) {
  if (options === undefined || options === null) return ceiling;
  if (typeof options !== "object") throw new BrokerError("bad_argument", "options must be an object");
  if (options.maxBytes === undefined) return ceiling;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new BrokerError("bad_argument", "maxBytes must be a positive integer");
  }
  return Math.min(options.maxBytes, ceiling);
}

function intOption(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BrokerError("bad_argument", `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function sortByName(entries) {
  return entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function joinRel(prefix, name) {
  return prefix === "" ? name : `${prefix}/${name}`;
}

function classify(ent) {
  if (ent.isSymbolicLink()) return "symlink";
  if (ent.isDirectory()) return "dir";
  if (ent.isFile()) return "file";
  return "other";
}

function mapFsError(err, what) {
  if (err instanceof BrokerError) return err;
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "ELOOP") {
    return new BrokerError("not_found", `the ${what} was not found`);
  }
  return new BrokerError("io_error", `the ${what} could not be read (${err?.code ?? "unknown error"})`, {
    cause: err,
  });
}

function toBrokerError(err) {
  if (err instanceof BrokerError) return err;
  return new BrokerError("io_error", `unexpected failure: ${err?.message ?? String(err)}`, { cause: err });
}

async function lstatOrThrow(target, what) {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    throw mapFsError(err, what);
  }
}

async function statOrThrow(target, what) {
  try {
    return await fsp.stat(target);
  } catch (err) {
    throw mapFsError(err, what);
  }
}

async function realpathOrThrow(target, what) {
  try {
    return await fsp.realpath(target);
  } catch (err) {
    throw mapFsError(err, what);
  }
}

// Checks made after a read has started: any failure means the tree moved under the operation.
async function lstatAfter(target) {
  try {
    return await fsp.lstat(target);
  } catch {
    throw new BrokerError("changed_during_read", "a path changed during the operation");
  }
}

async function realpathAfter(target) {
  try {
    return await fsp.realpath(target);
  } catch {
    throw new BrokerError("changed_during_read", "a path changed during the operation");
  }
}

/** The grant root as it resolves now. A folder moved, renamed or replaced is stale. */
async function currentRoot(grant) {
  let real;
  let st;
  try {
    real = await fsp.realpath(grant.root);
    st = await fsp.stat(real);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "ELOOP") {
      throw new BrokerError("stale_grant", "the granted folder was moved, renamed or deleted");
    }
    throw mapFsError(err, "granted folder");
  }
  if (!st.isDirectory() || st.dev !== grant.rootDev || st.ino !== grant.rootIno) {
    throw new BrokerError("stale_grant", "the granted folder was replaced by a different folder");
  }
  return real;
}

/** Walks a requested folder one name at a time and refuses any link on the way. */
async function resolveDirectory(rootReal, segments) {
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    const st = await lstatOrThrow(current, "folder");
    if (st.isSymbolicLink()) {
      const target = await fsp.realpath(current).catch(() => null);
      if (target !== null && isWithin(target, rootReal)) {
        throw new BrokerError("not_directory", "symbolic links are not followed when listing");
      }
      throw new BrokerError("symlink_escape", "the symbolic link does not resolve inside the grant");
    }
    if (!st.isDirectory()) throw new BrokerError("not_directory", "the path is not a folder");
  }
  const real = await realpathOrThrow(current, "folder");
  if (!isWithin(real, rootReal)) {
    throw new BrokerError("symlink_escape", "the folder resolves outside the granted folder");
  }
  return real;
}

/**
 * Lists one folder. The folder must be the same directory before and after the read, and its
 * path must still resolve to itself, so a folder swapped for a link during the listing is
 * discarded rather than returned.
 */
async function readDirectoryChecked(dir) {
  const before = await lstatOrThrow(dir, "folder");
  if (!before.isDirectory()) {
    throw new BrokerError("changed_during_read", "the folder changed during the listing");
  }
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw mapFsError(err, "folder");
  }
  const after = await lstatAfter(dir);
  if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new BrokerError("changed_during_read", "the folder changed during the listing");
  }
  if ((await realpathAfter(dir)) !== dir) {
    throw new BrokerError("changed_during_read", "the folder changed during the listing");
  }
  return entries;
}

/**
 * Resolves a file inside the grant and opens it without following a final link. The caller gets
 * the descriptor only after the descriptor, the path and the grant all agree.
 */
async function openInsideGrant(rootReal, segments, still) {
  let real;
  try {
    real = await fsp.realpath(path.join(rootReal, ...segments));
  } catch (err) {
    throw mapFsError(err, "file");
  }
  if (real === rootReal) {
    throw new BrokerError("not_a_file", "the granted folder itself is not a file");
  }
  if (!isWithin(real, rootReal)) {
    throw new BrokerError(await explainEscape(rootReal, segments), "the file resolves outside the grant");
  }
  const before = await lstatOrThrow(real, "file");
  if (!before.isFile()) {
    throw before.isSymbolicLink()
      ? new BrokerError("changed_during_read", "the file changed while it was being checked")
      : new BrokerError("not_a_file", "the path is not a regular file");
  }
  still();
  let handle;
  try {
    handle = await fsp.open(real, OPEN_FLAGS);
  } catch (err) {
    if (err?.code === "ELOOP") {
      throw new BrokerError("changed_during_read", "the file was replaced by a link while it was opened");
    }
    throw mapFsError(err, "file");
  }
  try {
    const opened = await handle.stat();
    const linked = await lstatAfter(real);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino
    ) {
      throw new BrokerError("changed_during_read", "the file changed while it was being opened");
    }
    if ((await realpathAfter(real)) !== real) {
      throw new BrokerError("changed_during_read", "a folder on the path changed while the file was opened");
    }
    still();
    return { handle, size: opened.size };
  } catch (err) {
    await handle.close().catch(() => {});
    throw toBrokerError(err);
  }
}

/** Called only when a resolved path left the grant: names a link on the way, if there is one. */
async function explainEscape(rootReal, segments) {
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    let st;
    try {
      st = await fsp.lstat(current);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) return "symlink_escape";
  }
  return "outside_grant";
}
