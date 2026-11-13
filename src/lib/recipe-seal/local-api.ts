/**
 * Public, local-only recipe client API. This imports no marketplace management
 * or execution modules: a public/stub desktop can verify and cache bundles but
 * cannot publish, license, decrypt, or run a commercial recipe here.
 *
 * The Nitro adapter supplies the shared local requester resolver. Keeping the
 * transport contract as Request -> Response also lets it be tested without the
 * private repository, an HTTP server, or a database.
 */
import { isLocalRuntime, localDataDir } from "../runtime";
import { listRecipes, putRecipe, type CachedRecipe } from "./cache";
import { catalogBaseUrl, fetchCatalog, installRecipe } from "./catalog";
import { defaultAnchors, verifyTrustedBundle } from "./trust";

const ROOT = "/api/recipes/local";
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 + 1024;
const json = (status: number, body: unknown) => Response.json(body, { status });
const notFound = () => json(404, { ok: false, error: "Not found", code: "not_found" });
const summary = (entry: CachedRecipe | undefined) => entry
  ? { id: entry.id, version: entry.version, title: entry.title, sha256: entry.sha256 }
  : undefined;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function bundleBytes(body: Record<string, unknown> | null): Uint8Array | null {
  const base64 = typeof body?.bundle === "string" ? body.bundle.trim() : "";
  if (!base64 || base64.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 0 && bytes.length <= MAX_BUNDLE_BYTES ? bytes : null;
}

export async function handleLocalRecipeRequest(
  request: Request,
  resolveRequester: (headers: Headers) => Promise<unknown>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  // These routes must never expose a hosted server's local filesystem cache.
  if (!isLocalRuntime() || (path !== ROOT && !path.startsWith(`${ROOT}/`))) return notFound();
  const user = await resolveRequester(request.headers).catch(() => null);
  if (!user) return json(401, { ok: false, error: "Unauthorized", code: "unauthorized" });

  const method = request.method;
  const dataDir = localDataDir();
  const anchors = defaultAnchors();

  if (path === ROOT && method === "GET") {
    return json(200, { ok: true, pins: anchors.length, ...listRecipes(dataDir, anchors) });
  }

  if ((path === ROOT || path === `${ROOT}/verify`) && method === "POST") {
    const bytes = bundleBytes(await readJson(request));
    if (!bytes) return json(400, {
      ok: false, error: "body.bundle must be base64 containing a bundle of at most 8 MB", code: "bad_request",
    });
    if (path === `${ROOT}/verify`) {
      const verdict = verifyTrustedBundle(bytes, anchors);
      return json(200, {
        ok: verdict.ok, trusted: verdict.trusted, reason: verdict.reason, detail: verdict.detail,
        anchor: verdict.anchor,
        recipe: verdict.manifest
          ? { id: verdict.manifest.id, version: verdict.manifest.version, title: verdict.manifest.listing?.title }
          : undefined,
      });
    }
    const result = putRecipe(dataDir, bytes, anchors);
    return json(result.ok ? 201 : 422, {
      ok: result.ok, reason: result.verdict.reason, detail: result.verdict.detail,
      anchor: result.verdict.anchor, cached: summary(result.cached),
    });
  }

  if (path === `${ROOT}/catalog` && method === "GET") {
    let base: string;
    try {
      base = catalogBaseUrl();
    } catch (err) {
      return json(200, { ok: false, configured: false, entries: [], error: err instanceof Error ? err.message : String(err) });
    }
    if (!base) return json(200, {
      ok: false, configured: false, entries: [], error: "no catalog configured (set BZ_CATALOG_URL)",
    });
    const result = await fetchCatalog(base);
    return json(200, { ...result, configured: true, catalog: base });
  }

  if (path === `${ROOT}/fetch` && method === "POST") {
    const body = await readJson(request);
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) return json(400, { ok: false, error: "body.id is required", code: "bad_request" });
    let base: string;
    try {
      base = catalogBaseUrl();
    } catch (err) {
      return json(400, { ok: false, error: err instanceof Error ? err.message : String(err), code: "bad_catalog" });
    }
    const listing = await fetchCatalog(base);
    if (!listing.ok) return json(502, { ok: false, error: listing.error, code: "catalog_unreachable" });
    const entry = listing.entries.find((item) => item.id === id);
    if (!entry) return json(404, { ok: false, error: `no recipe '${id}' in the catalog`, code: "not_found" });
    const installed = await installRecipe(dataDir, entry, { anchors, base });
    return json(installed.ok ? 201 : 422, {
      ok: installed.ok, reason: installed.verdict?.reason, detail: installed.verdict?.detail,
      error: installed.error,
      entry: { id: entry.id, version: entry.version, title: entry.title },
      cached: summary(installed.cached),
    });
  }
  return notFound();
}
