/**
 * Recipe catalog client — how a local install gets NEW recipes from our cloud.
 *
 * The product rule is "day-to-day runs locally; recipes are centralized". That
 * means the desktop app needs exactly one cloud call, and it must not be a trust
 * boundary it can be talked across:
 *
 *   GET  {BZ_CATALOG_URL}/catalog.json          -> a list, nothing more
 *   GET  {BZ_CATALOG_URL}{entry.url}            -> bundle bytes
 *
 * The catalog is UNTRUSTED, even though it is ours. A compromised catalog must not
 * be able to install code, so:
 *   - the entry's sha256 (when present) must match the bytes we downloaded;
 *   - the bundle must verify AND its author key must be pinned in this build;
 *   - nothing is written to the cache unless both pass.
 *
 * A catalog that lists a recipe we cannot fetch cleanly yields a refused entry,
 * never a partial install.
 */

import { createHash } from "node:crypto";
import { putRecipe, type CachedRecipe } from "./cache";
import { verifyTrustedBundle, type TrustAnchor, type TrustVerdict } from "./trust";

export interface CatalogEntry {
  id: string;
  version: string;
  title?: string;
  /** hex sha256 of the bundle bytes; verified when the catalog provides it */
  sha256?: string;
  /** path relative to the catalog base URL */
  url: string;
  keyId?: string;
}

export interface CatalogResult {
  ok: boolean;
  entries: CatalogEntry[];
  error?: string;
}

/** Hard cap on a downloaded bundle: 8 MB. A recipe is text + a small wasm check. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export function catalogBaseUrl(raw = process.env.BZ_CATALOG_URL): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  // Only http(s), with no embedded credentials or ambiguous query/fragment.
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("catalog URL must be http(s) without credentials, a query, or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

const asString = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Stream with a hard cap; Content-Length alone is not a size boundary. */
async function readLimitedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    throw new Error(`response is over the ${limit / 1024 / 1024} MB size limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("response exceeded the size limit while downloading");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

function fetchOptions(init?: RequestInit): RequestInit {
  return {
    ...init,
    // A compromised catalog must not redirect a desktop client to another
    // origin (or leak an explicitly configured Authorization header there).
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  };
}

/** Read the catalog listing. Never throws for a network/parse problem. */
export async function fetchCatalog(base = process.env.BZ_CATALOG_URL ?? "", init?: RequestInit): Promise<CatalogResult> {
  if (!base) return { ok: false, entries: [], error: "no catalog configured (set BZ_CATALOG_URL)" };
  let bytes: Uint8Array;
  try {
    base = catalogBaseUrl(base);
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    const res = await fetch(`${base}/catalog.json`, { ...fetchOptions(init), headers });
    if (!res.ok) return { ok: false, entries: [], error: `catalog responded ${res.status}` };
    bytes = await readLimitedBody(res, 1024 * 1024);
  } catch (err) {
    return { ok: false, entries: [], error: `could not reach the catalog: ${err instanceof Error ? err.message : err}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, entries: [], error: "catalog is not valid JSON" };
  }
  const list = (parsed as { recipes?: unknown })?.recipes;
  if (!Array.isArray(list)) return { ok: false, entries: [], error: "catalog has no recipes array" };

  const entries: CatalogEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    const id = asString(e.id);
    const version = asString(e.version);
    const url = asString(e.url);
    if (!id || !version || !url) continue;
    entries.push({
      id, version, url,
      title: asString(e.title) || undefined,
      sha256: asString(e.sha256).toLowerCase() || undefined,
      keyId: asString(e.keyId) || undefined,
    });
  }
  return { ok: true, entries };
}

export interface DownloadResult {
  ok: boolean;
  status: number;
  bytes?: Uint8Array;
  error?: string;
}

/** Download one entry's bytes, enforcing the size cap and (when given) the digest. */
export async function downloadBundle(
  base: string,
  entry: CatalogEntry,
  init?: RequestInit,
): Promise<DownloadResult> {
  let status = 0;
  let buf: Uint8Array;
  try {
    base = catalogBaseUrl(base);
    if (!base) throw new Error("no catalog configured");
    // Entries are paths under the configured base, or same-origin absolute
    // http(s) URLs. Never let catalog data choose a different network authority.
    if (entry.url.startsWith("//") || entry.url.includes("\\")) throw new Error("bundle URL must stay on the catalog origin");
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(entry.url)
      ? entry.url
      : `${base}/${entry.url.replace(/^\//, "")}`);
    if (url.origin !== new URL(base).origin || url.username || url.password || url.hash) {
      throw new Error("bundle URL must stay on the catalog origin without credentials or a fragment");
    }
    const res = await fetch(url, fetchOptions(init));
    status = res.status;
    if (!res.ok) return { ok: false, status, error: `download responded ${status}` };
    buf = await readLimitedBody(res, MAX_BUNDLE_BYTES);
  } catch (err) {
    return { ok: false, status, error: `download failed: ${err instanceof Error ? err.message : err}` };
  }
  if (buf.byteLength === 0) return { ok: false, status, error: "bundle was empty" };

  if (entry.sha256) {
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest !== entry.sha256) {
      return { ok: false, status, error: `bundle does not match the catalog digest (expected ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)` };
    }
  }
  return { ok: true, status, bytes: buf };
}

export interface InstallResult {
  ok: boolean;
  entry: CatalogEntry;
  verdict?: TrustVerdict;
  cached?: CachedRecipe;
  error?: string;
}

/**
 * Download one catalog entry and cache it — but only if it verifies AND is signed
 * by a publisher pinned in this build. Downloading is not installing.
 */
export async function installRecipe(
  dataDir: string,
  entry: CatalogEntry,
  opts: { anchors?: TrustAnchor[]; base?: string; init?: RequestInit } = {},
): Promise<InstallResult> {
  let base = opts.base;
  if (!base) {
    try {
      base = catalogBaseUrl();
    } catch (err) {
      return { ok: false, entry, error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (!base) return { ok: false, entry, error: "no catalog configured (set BZ_CATALOG_URL)" };

  const dl = await downloadBundle(base, entry, opts.init);
  if (!dl.ok || !dl.bytes) return { ok: false, entry, error: dl.error ?? "download produced no bytes" };

  const verdict = verifyTrustedBundle(dl.bytes, opts.anchors);
  if (!verdict.ok) return {
    ok: false, entry, verdict,
    error: `${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ""}`,
  };
  if (verdict.manifest?.id !== entry.id || verdict.manifest.version !== entry.version) {
    return { ok: false, entry, verdict, error: "bundle identity does not match the catalog id/version" };
  }
  const put = putRecipe(dataDir, dl.bytes, opts.anchors);
  if (!put.ok) {
    return {
      ok: false,
      entry,
      verdict: put.verdict,
      error: `${put.verdict.reason}${put.verdict.detail ? `: ${put.verdict.detail}` : ""}`,
    };
  }
  return { ok: true, entry, verdict: put.verdict, cached: put.cached };
}
