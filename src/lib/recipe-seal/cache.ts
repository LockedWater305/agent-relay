/**
 * On-disk recipe cache — offline-first, and never trusted on read.
 *
 * The desktop promise is "your day does not block on a network call". Recipes
 * arrive from our cloud, land here, and keep working offline. But a file on disk
 * is just a file: anything can rewrite it. So a cache hit is re-verified against
 * the pinned publishers on every read — a cached bundle that no longer verifies
 * is deleted, not executed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyTrustedBundle, type TrustAnchor, type TrustVerdict } from "./trust";

export interface CachedRecipe {
  id: string;
  version: string;
  keyId: string;
  title: string;
  sha256: string;
  cachedAt: string;
  file: string;
}

export function cacheDir(dataDir: string): string {
  return join(dataDir, "recipes");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

class InvalidCachePath extends Error {}

/**
 * The configured data root may deliberately be a symlink (or live beneath an
 * OS alias such as /var). Resolve that trusted root first, then never follow a
 * symlink in its cache directory. All file operations use the canonical path,
 * not the original alias, and re-check the parent before committing a write.
 */
function checkedCacheDir(dataDir: string, create: boolean): string {
  if (create) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = join(realpathSync(dataDir), "recipes");
  if (create) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  assertCacheDir(dir);
  return dir;
}

function assertCacheDir(dir: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== resolve(dir)) {
    throw new InvalidCachePath("recipe cache directory must not redirect outside the configured data root");
  }
}

/**
 * Never open a deterministic cache filename for writing: it may be a symlink
 * (or a hard link). An exclusive temporary file owns its own inode; rename
 * replaces the directory entry itself instead of modifying the linked target.
 */
function writeCacheFile(dir: string, name: string, value: string | Uint8Array): void {
  assertCacheDir(dir);
  const target = join(dir, name);
  const temporary = join(dir, `.write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, value);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertCacheDir(dir);
    renameSync(temporary, target);
    created = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        assertCacheDir(dir);
        rmSync(temporary, { force: true });
      } catch {
        // A changed parent is not a safe place to perform cleanup either.
      }
    }
  }
}

/**
 * Verify + store a bundle. Refuses anything not anchored to a pinned publisher,
 * so the cache can never become a laundering path for an unpinned recipe.
 */
export function putRecipe(
  dataDir: string,
  bytes: Uint8Array,
  anchors?: TrustAnchor[],
): { ok: boolean; verdict: TrustVerdict; cached?: CachedRecipe } {
  const verdict = verifyTrustedBundle(bytes, anchors);
  if (!verdict.ok || !verdict.manifest) return { ok: false, verdict };

  try {
    const m = verdict.manifest;
    const dir = checkedCacheDir(dataDir, true);
    const digest = sha256(bytes);
    const name = `${safeName(m.id)}@${safeName(m.version)}.${digest.slice(0, 12)}.bezz`;
    const file = join(dir, name);
    writeCacheFile(dir, name, bytes);

    const entry: CachedRecipe = {
      id: m.id,
      version: m.version,
      keyId: m.author.key_id,
      title: typeof m.listing?.title === "string" ? m.listing.title : m.id,
      sha256: digest,
      cachedAt: new Date().toISOString(),
      file,
    };
    const index = listRecipeFiles(dir).filter((f) => f.file !== file);
    index.push(entry);
    writeCacheFile(dir, "index.json", JSON.stringify(index, null, 2) + "\n");
    return { ok: true, verdict, cached: entry };
  } catch (err) {
    return {
      ok: false,
      verdict: {
        ...verdict, ok: false,
        reason: err instanceof InvalidCachePath ? "INVALID_CACHE_PATH" : "CACHE_WRITE_FAILED",
        detail: err instanceof Error ? err.message : "could not write the recipe cache",
      },
    };
  }
}

function listRecipeFiles(dir: string): CachedRecipe[] {
  try {
    assertCacheDir(dir);
    const index = join(dir, "index.json");
    const stat = lstatSync(index);
    // An import can replace this link safely, but must not read its target to
    // assemble the replacement index.
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const parsed: unknown = JSON.parse(readFileSync(index, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CachedRecipe => entry && typeof entry === "object" &&
      ["id", "version", "keyId", "title", "sha256", "cachedAt", "file"].every((key) => typeof entry[key] === "string"));
  } catch {
    return [];
  }
}

/** An index is untrusted too: never read/delete a path outside this cache. */
function isCacheFile(dir: string, file: string): boolean {
  if (dirname(resolve(file)) !== resolve(dir) || !file.endsWith(".bezz")) return false;
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * List cached recipes, re-verifying each against the pinned publishers.
 * A bundle that fails verification is removed and reported as `rejected`.
 */
export function listRecipes(
  dataDir: string,
  anchors?: TrustAnchor[],
): { valid: CachedRecipe[]; rejected: Array<{ file: string; reason: string; detail?: string }> } {
  let dir: string;
  const valid: CachedRecipe[] = [];
  const rejected: Array<{ file: string; reason: string; detail?: string }> = [];
  try {
    dir = checkedCacheDir(dataDir, false);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      rejected.push({ file: cacheDir(dataDir), reason: "INVALID_CACHE_PATH" });
    }
    return { valid, rejected };
  }

  for (const entry of listRecipeFiles(dir)) {
    if (!existsSync(entry.file)) continue;
    if (!isCacheFile(dir, entry.file)) {
      rejected.push({ file: entry.file, reason: "INVALID_CACHE_PATH" });
      continue; // in particular, never unlink a path supplied by a corrupt index
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(entry.file);
    } catch {
      continue; // another process may have removed it since the stat
    }
    const verdict = verifyTrustedBundle(bytes, anchors);
    if (verdict.ok && verdict.manifest) {
      // Display and select the signed identity, not editable index metadata.
      const manifest = verdict.manifest;
      valid.push({
        ...entry, id: manifest.id, version: manifest.version, keyId: manifest.author.key_id,
        title: manifest.listing?.title ?? manifest.id, sha256: sha256(bytes),
      });
    } else {
      rejected.push({ file: entry.file, reason: String(verdict.reason), detail: verdict.detail });
      try {
        rmSync(entry.file, { force: true });
      } catch {
        /* leave it; it is already refused */
      }
    }
  }
  return { valid, rejected };
}

/** Read a cached bundle by id (optionally version), re-verified. */
export function readRecipe(
  dataDir: string,
  id: string,
  version?: string,
  anchors?: TrustAnchor[],
): { ok: boolean; bytes?: Uint8Array; entry?: CachedRecipe; reason?: string; detail?: string } {
  const { valid, rejected } = listRecipes(dataDir, anchors);
  const match = valid.find((r) => r.id === id && (!version || r.version === version));
  if (!match) {
    const bad = rejected.find((r) => r.file.includes(safeName(id)));
    return bad
      ? { ok: false, reason: bad.reason, detail: bad.detail }
      : { ok: false, reason: "NOT_CACHED", detail: `no cached recipe ${id}${version ? `@${version}` : ""}` };
  }
  // Verify the exact bytes returned; the file may have changed after listing.
  try {
    if (!isCacheFile(checkedCacheDir(dataDir, false), match.file)) return { ok: false, reason: "INVALID_CACHE_PATH" };
    const bytes = readFileSync(match.file);
    const verdict = verifyTrustedBundle(bytes, anchors);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };
    if (verdict.manifest?.id !== id || (version && verdict.manifest.version !== version)) {
      return { ok: false, reason: "CACHE_IDENTITY_CHANGED" };
    }
    return { ok: true, bytes, entry: { ...match, sha256: sha256(bytes) } };
  } catch {
    return { ok: false, reason: "NOT_CACHED" };
  }
}
