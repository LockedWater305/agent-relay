/** Hermetic public desktop recipe API + trust-boundary regression coverage. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPES } from "../src/lib/buzzy/recipes";
import { compileRecipeChecks } from "../src/lib/recipe-checks";
import { generateAuthorKey, sealBundle, type SealInput } from "../src/lib/recipe-seal/bundle";
import { cacheDir, listRecipes, putRecipe, readRecipe } from "../src/lib/recipe-seal/cache";
import { downloadBundle, fetchCatalog, installRecipe } from "../src/lib/recipe-seal/catalog";
import { handleLocalRecipeRequest } from "../src/lib/recipe-seal/local-api";
import marketplaceDisabled from "../.private-stub/recipes.nitro";

let checks = 0;
const check = (name: string, condition: unknown) => { assert.ok(condition, name); checks++; console.log(`PASS  ${name}`); };
const recipe = RECIPES[0];
const compiled = compileRecipeChecks(recipe.id, { salt: new Uint8Array(8) });
const author = generateAuthorKey();
const foreignAuthor = generateAuthorKey();
const seal = (key: ReturnType<typeof generateAuthorKey>) => sealBundle({
  recipeId: recipe.id, version: "1.0.0",
  semantic: { discovery: recipe.discovery, checklist: recipe.checklist, firstQuestion: recipe.firstQuestion, outputContract: recipe.outputContract, boundary: recipe.boundary },
  checksWasm: compiled.wasm, checks: compiled.manifest,
  capability: {
    inputs: [{ name: "quotes", type: "file[]", required: true }], outputs: ["comparison-table"], tools: recipe.tools,
    forbidden_tools: ["send", "email", "submit", "publish", "pay", "sign"], boundary_summary: "read-only; nothing is sent",
  },
  author: { id: "acct_test", name: "Test", keyId: key.keyId, privateKey: key.privateKey },
  kek: new Uint8Array(32).fill(7),
} satisfies SealInput).bytes;
const bundle = seal(author);
const foreignBundle = seal(foreignAuthor);
const anchors = [{ keyId: author.keyId, publicKey: author.publicKeyRaw }];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base = "https://catalog.example.test";
const entry = { id: recipe.id, version: "1.0.0", url: "/bundles/good.bezz", sha256: digest(bundle) };
const root = mkdtempSync(join(tmpdir(), "bz-public-recipes-"));
const dataDir = join(root, "data");
const envKeys = ["BZ_RUNTIME", "BZ_DATA_DIR", "BZ_RECIPE_PUBLISHER_KEYS", "BZ_RECIPE_PUBLISHER_FILE", "BZ_CATALOG_URL"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
let requests = 0;
let authCalls = 0;
const resolveRequester = async (headers: Headers) => {
  authCalls++;
  return headers.get("authorization") === "Bearer test-launch-token" ? { id: "test-owner" } : null;
};
const call = async (path: string, method = "GET", body?: unknown, token = true) => {
  const request = new Request(`http://127.0.0.1${path}`, {
    method,
    headers: token ? { authorization: "Bearer test-launch-token", "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await handleLocalRecipeRequest(request, resolveRequester);
  return { status: response.status, body: await response.json() as Record<string, any> };
};
const payload = (bytes: Uint8Array) => ({ bundle: Buffer.from(bytes).toString("base64") });

try {
  process.env.BZ_RUNTIME = "local";
  process.env.BZ_DATA_DIR = dataDir;
  process.env.BZ_RECIPE_PUBLISHER_KEYS = `${author.keyId}:${author.publicKeyRaw}`;
  process.env.BZ_RECIPE_PUBLISHER_FILE = join(root, "no-pins.json");
  writeFileSync(process.env.BZ_RECIPE_PUBLISHER_FILE, JSON.stringify({ publishers: [] }));
  delete process.env.BZ_CATALOG_URL;

  const stub = marketplaceDisabled();
  check("public marketplace returns HTTP 503, not a success-shaped 200", stub.status === 503 && (await stub.json()).code === "marketplace_disabled");
  check("local client has no commercial run route", (await call("/api/recipes/local/run", "POST", {})).status === 404);
  check("prefix lookalikes are not local routes", (await call("/api/recipes/locality")).status === 404);
  const empty = await call("/api/recipes/local");
  check("public build lists an empty cache and its configured pin", empty.status === 200 && empty.body.valid.length === 0 && empty.body.pins === 1);
  check("unauthenticated requests cannot read the cache", (await call("/api/recipes/local", "GET", undefined, false)).status === 401);
  check("unauthenticated requests cannot import", (await call("/api/recipes/local", "POST", payload(bundle), false)).status === 401);
  process.env.BZ_RUNTIME = "cloud";
  const callsBefore = authCalls;
  check("hosted deployments cannot access this filesystem API", (await call("/api/recipes/local")).status === 404 && authCalls === callsBefore);
  process.env.BZ_RUNTIME = "local";

  const verified = await call("/api/recipes/local/verify", "POST", payload(bundle));
  check("pinned bundle verifies in a public build", verified.status === 200 && verified.body.trusted === true);
  check("verify is read-only", !existsSync(cacheDir(dataDir)));
  const imported = await call("/api/recipes/local", "POST", payload(bundle));
  check("pinned bundle imports without private modules", imported.status === 201 && imported.body.cached.id === recipe.id);
  check("unpinned bundle cannot import", (await call("/api/recipes/local", "POST", payload(foreignBundle))).status === 422);
  check("malformed base64 is rejected", (await call("/api/recipes/local", "POST", { bundle: "%%notbase64" })).status === 400);
  check("missing bundle is a named bad request", (await call("/api/recipes/local", "POST", {})).body.code === "bad_request");
  const badJson = await handleLocalRecipeRequest(new Request("http://127.0.0.1/api/recipes/local", {
    method: "POST", headers: { authorization: "Bearer test-launch-token" }, body: "{broken",
  }), resolveRequester);
  check("malformed JSON is rejected", badJson.status === 400);
  const oversized = await handleLocalRecipeRequest(new Request("http://127.0.0.1/api/recipes/local", {
    method: "POST", headers: { authorization: "Bearer test-launch-token", "content-length": String(12 * 1024 * 1024) }, body: "{}",
  }), resolveRequester);
  check("oversized import is rejected before decoding", oversized.status === 400);
  delete process.env.BZ_RECIPE_PUBLISHER_KEYS;
  const noPins = await call("/api/recipes/local/verify", "POST", payload(bundle));
  check("no publisher pins fails closed", noPins.body.reason === "NO_TRUST_ANCHOR" && !noPins.body.trusted);
  process.env.BZ_RECIPE_PUBLISHER_KEYS = `${author.keyId}:${author.publicKeyRaw}`;

  const unconfigured = await call("/api/recipes/local/catalog");
  check("missing catalog is explicit without breaking the API", unconfigured.status === 200 && unconfigured.body.configured === false);
  process.env.BZ_CATALOG_URL = base;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(init?.redirect, "error", "catalog requests cannot follow redirects");
    const url = String(input);
    if (url.endsWith("/catalog.json")) return Response.json({ recipes: [null, {}, "broken", entry] });
    if (url.endsWith("/bundles/good.bezz")) return new Response(Buffer.from(bundle));
    return new Response(null, { status: 404 });
  };
  const listedCatalog = await call("/api/recipes/local/catalog");
  check("catalog ignores malformed rows and lists a valid entry", listedCatalog.body.entries.length === 1 && listedCatalog.body.configured);
  const fetched = await call("/api/recipes/local/fetch", "POST", { id: recipe.id });
  check("public API fetches a pinned catalog bundle", fetched.status === 201 && fetched.body.cached.id === recipe.id);
  check("unknown catalog id returns 404", (await call("/api/recipes/local/fetch", "POST", { id: "missing" })).status === 404);
  check("fetch requires an id", (await call("/api/recipes/local/fetch", "POST", {})).status === 400);
  const wrongDigest = await installRecipe(dataDir, { ...entry, sha256: "0".repeat(64) }, { base, anchors });
  check("catalog digest is enforced", !wrongDigest.ok && /catalog digest/.test(wrongDigest.error ?? ""));
  const mismatched = await installRecipe(join(root, "mismatch"), { ...entry, id: "different" }, { base, anchors });
  check("signed bundle identity must match advertised id/version", !mismatched.ok && !existsSync(cacheDir(join(root, "mismatch"))));
  for (const url of ["https://other.example.test/secret", "file:///etc/passwd", "//127.0.0.1/admin", "https://user:password@catalog.example.test/bundle"]) {
    const before = requests;
    const result = await downloadBundle(base, { ...entry, url });
    check(`hostile catalog URL refused before network: ${url.split(":")[0]}`, !result.ok && requests === before);
  }
  globalThis.fetch = async () => new Response("{broken");
  check("invalid catalog JSON returns a result, not a thrown error", !(await fetchCatalog(base)).ok);
  process.env.BZ_CATALOG_URL = "file:///not-a-catalog";
  check("invalid catalog environment is reported without throwing", !(await fetchCatalog()).ok);
  let canceled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024)); },
    cancel() { canceled = true; },
  }));
  const streamed = await downloadBundle(base, entry);
  check("chunked downloads stop at the hard byte cap", !streamed.ok && /size limit/.test(streamed.error ?? "") && canceled);

  // The on-disk index cannot be used to spoof a recipe or delete arbitrary files.
  const cached = putRecipe(dataDir, bundle, anchors).cached!;
  const indexFile = join(cacheDir(dataDir), "index.json");
  writeFileSync(indexFile, JSON.stringify([{ ...cached, id: "spoofed", version: "999", title: "spoofed" }]));
  const canonical = listRecipes(dataDir, anchors);
  check("cache metadata comes from the signed manifest, not index.json", canonical.valid[0]?.id === recipe.id && canonical.valid[0]?.version === "1.0.0");
  check("spoofed id cannot be read from the cache", !readRecipe(dataDir, "spoofed", undefined, anchors).ok);
  const outside = join(root, "do-not-delete.bezz");
  writeFileSync(outside, "ordinary user file");
  writeFileSync(indexFile, JSON.stringify([{ ...cached, file: outside }]));
  const traversal = listRecipes(dataDir, anchors);
  check("corrupt cache index cannot read or delete outside files", traversal.valid.length === 0 && traversal.rejected[0]?.reason === "INVALID_CACHE_PATH" && readFileSync(outside, "utf8") === "ordinary user file");
  const link = join(cacheDir(dataDir), "linked.bezz");
  symlinkSync(outside, link);
  writeFileSync(indexFile, JSON.stringify([{ ...cached, file: link }]));
  check("cache refuses symlinks without following/deleting them", listRecipes(dataDir, anchors).rejected[0]?.reason === "INVALID_CACHE_PATH" && existsSync(outside));
  // Writes must replace final links, never follow them. Both targets are
  // predictable, so a prior valid import does not make them safe to reopen.
  for (const [label, target] of [["bundle", cached.file], ["index", indexFile]]) {
    const sentinel = join(root, `${label}-write-sentinel.txt`);
    writeFileSync(sentinel, `untouched ${label} target`);
    rmSync(target, { force: true });
    symlinkSync(sentinel, target);
    const result = putRecipe(dataDir, bundle, anchors);
    check(`${label} write replaces the symlink without overwriting its target`,
      result.ok && readFileSync(sentinel, "utf8") === `untouched ${label} target` && !lstatSync(target).isSymbolicLink());
  }
  check("atomic cache writes leave no temporary files", !readdirSync(cacheDir(dataDir)).some((file) => file.startsWith(".write-")));

  const redirectedData = join(root, "redirected-data");
  const outsideDirectory = join(root, "outside-directory");
  mkdirSync(redirectedData);
  mkdirSync(outsideDirectory);
  writeFileSync(join(outsideDirectory, "sentinel"), "untouched directory");
  symlinkSync(outsideDirectory, cacheDir(redirectedData), "dir");
  const redirected = putRecipe(redirectedData, bundle, anchors);
  check("a symlinked cache parent refuses writes without touching the target directory",
    !redirected.ok && redirected.verdict.reason === "INVALID_CACHE_PATH" &&
    readdirSync(outsideDirectory).join(",") === "sentinel" && readFileSync(join(outsideDirectory, "sentinel"), "utf8") === "untouched directory");
  check("a symlinked cache parent cannot redirect cache reads", listRecipes(redirectedData, anchors).rejected[0]?.reason === "INVALID_CACHE_PATH");

  const rootAlias = join(root, "configured-data-alias");
  symlinkSync(dataDir, rootAlias, "dir");
  const aliased = putRecipe(rootAlias, bundle, anchors);
  check("an intentional configured data-root alias still works", aliased.ok && readRecipe(rootAlias, recipe.id, undefined, anchors).ok);

  writeFileSync(indexFile, JSON.stringify({ not: "an array" }));
  check("corrupt index shape degrades to an empty cache", listRecipes(dataDir, anchors).valid.length === 0);
} finally {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nPublic recipe boundary: ${checks} checks passed`);
