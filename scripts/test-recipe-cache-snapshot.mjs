/** Pure cache replacement regressions. Run with node --experimental-vm-modules. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ts = createRequire(import.meta.url)("typescript");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.resolve(process.env.BZ_RECIPE_CACHE_TEST_SOURCE_ROOT || ROOT, "src/lib/recipe-seal");
const fixture = fs.mkdtempSync(path.join(tmpdir(), "bz-cache-snapshot-"));
const context = vm.createContext({ Buffer, TextEncoder, TextDecoder, Uint8Array, process });
const modules = new Map();
let beforeRead = () => {};
const builtins = new Map([
  ["node:crypto", crypto],
  ["node:path", path],
  ["node:fs", { ...fs, readFileSync(file, ...args) {
    beforeRead(file);
    return fs.readFileSync(file, ...args);
  } }],
]);

// Load the real verifier, signer, cache and format modules. Only filesystem
// timing is controlled; trust verdicts and bundle bytes are never mocked.
async function moduleFor(specifier, parent) {
  const id = builtins.has(specifier) ? specifier : path.resolve(path.dirname(parent), `${specifier}.ts`);
  if (modules.has(id)) return modules.get(id);
  let module;
  if (builtins.has(id)) {
    const values = builtins.get(id);
    module = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context, identifier: id });
  } else {
    assert.equal(path.dirname(id), SOURCE, `unexpected dependency: ${id}`);
    // Use the existing dev dependency across the declared Node >=22 range.
    const compiled = ts.transpileModule(fs.readFileSync(id, "utf8"), {
      fileName: id,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics ?? [], [], `TypeScript diagnostics: ${id}`);
    module = new vm.SourceTextModule(compiled.outputText, { context, identifier: id });
  }
  modules.set(id, module);
  await module.link((next, from) => moduleFor(next, from.identifier));
  return module;
}

const cacheModule = await moduleFor("./cache", path.join(SOURCE, "entry.ts"));
await cacheModule.evaluate();
const { putRecipe, readRecipe } = cacheModule.namespace;
const { generateAuthorKey, sealBundle } = modules.get(path.join(SOURCE, "bundle.ts")).namespace;
const { verifyTrustedBundle } = modules.get(path.join(SOURCE, "trust.ts")).namespace;
const originalAuthor = generateAuthorKey();
const secondAuthor = generateAuthorKey();
const foreignAuthor = generateAuthorKey();
const anchors = [originalAuthor, secondAuthor].map((key) => ({ keyId: key.keyId, publicKey: key.publicKeyRaw }));
const seal = ({ version = "1.0.0", title = "Cache snapshot fixture", author = originalAuthor,
  instruction = "Consider the violet lantern carefully before arranging the amber pebbles beside the quiet river." } = {}) => sealBundle({
  recipeId: "cache-snapshot", version,
  listing: { title },
  semantic: { instruction },
  // Format fixture only. No WASM or commercial recipe execution occurs.
  checksWasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  checks: { sha256: "", rules: 1, codes: { A01: "fixture check" }, engine: "fixture/1" },
  capability: { inputs: [], outputs: ["document"], tools: ["render_document"], forbidden_tools: ["send"], boundary_summary: "read only" },
  author: { id: "acct_fixture", name: "Fixture", keyId: author.keyId, privateKey: author.privateKey },
  kek: new Uint8Array(32).fill(7), createdAt: "2026-11-18T00:00:00.000Z",
  dek: new Uint8Array(32).fill(3), nonce: new Uint8Array(12).fill(5), dekNonce: new Uint8Array(12).fill(9),
}).bytes;
const original = seal();
const changedVersion = seal({ version: "2.0.0" });
const changedTitle = seal({ title: "Replacement fixture" });
const changedPublisher = seal({ author: secondAuthor });
const foreign = seal({ author: foreignAuthor });

for (const bytes of [original, changedVersion, changedTitle, changedPublisher]) {
  assert.equal(verifyTrustedBundle(bytes, anchors).ok, true, "signed fixture must pass the real trust verifier");
}

let sequence = 0;
function readDuringReplacement(replacement, version) {
  const dataDir = path.join(fixture, String(sequence++));
  const put = putRecipe(dataDir, original, anchors);
  assert.equal(put.ok, true);
  const file = put.cached.file;
  let reads = 0;
  beforeRead = (target) => {
    if (target === file && ++reads === 2) fs.writeFileSync(file, replacement);
  };
  try {
    const result = readRecipe(dataDir, "cache-snapshot", version, anchors);
    assert.equal(reads, 2, "replacement must occur between selection and the final read");
    return { result, file, dataDir };
  } finally {
    beforeRead = () => {};
  }
}

function assertChanged(result) {
  const actual = result.bytes ? verifyTrustedBundle(result.bytes, anchors).manifest : null;
  assert.equal(result.ok, false, JSON.stringify({
    returned: { version: result.entry?.version, title: result.entry?.title, keyId: result.entry?.keyId },
    bytes: { version: actual?.version, title: actual?.listing?.title, keyId: actual?.author?.key_id },
  }));
  assert.equal(result.reason, "CACHE_IDENTITY_CHANGED");
  assert.equal(result.bytes, undefined);
  assert.equal(result.entry, undefined);
}

try {
  await test("id-only selection refuses a signed version replacement between reads", () => {
    assertChanged(readDuringReplacement(changedVersion).result);
  });
  await test("explicit-version selection refuses a signed title replacement at the same version", () => {
    assertChanged(readDuringReplacement(changedTitle, "1.0.0").result);
  });
  await test("explicit-version selection refuses another pinned publisher at the same id/version", () => {
    assertChanged(readDuringReplacement(changedPublisher, "1.0.0").result);
  });
  await test("explicit-version selection still refuses a different signed version", () => {
    assertChanged(readDuringReplacement(changedVersion, "1.0.0").result);
  });
  await test("an unpinned replacement still fails publisher verification", () => {
    const { result } = readDuringReplacement(foreign);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "UNPINNED_PUBLISHER");
    assert.equal(result.bytes, undefined);
  });
  await test("byte-identical replacement preserves offline selection and coherent metadata", () => {
    const { result } = readDuringReplacement(original);
    assert.equal(result.ok, true);
    assert.equal(Buffer.compare(Buffer.from(result.bytes), Buffer.from(original)), 0);
    assert.equal(result.entry.sha256, crypto.createHash("sha256").update(original).digest("hex"));
    assert.equal(result.entry.version, "1.0.0");
    assert.equal(result.entry.title, "Cache snapshot fixture");
    assert.equal(result.entry.keyId, originalAuthor.keyId);
  });
  await test("a stable signed replacement can be selected coherently on the next call", () => {
    const { result, dataDir, file } = readDuringReplacement(changedVersion);
    assertChanged(result);
    assert.equal(fs.existsSync(file), true, "a concurrent valid update must not be deleted");
    const retry = readRecipe(dataDir, "cache-snapshot", undefined, anchors);
    assert.equal(retry.ok, true);
    assert.equal(retry.entry.version, "2.0.0");
    assert.equal(retry.entry.sha256, crypto.createHash("sha256").update(changedVersion).digest("hex"));
    assert.equal(Buffer.compare(Buffer.from(retry.bytes), Buffer.from(changedVersion)), 0);
  });
  await test("different signed content with identical public identity is refused", () => {
    const replacement = seal({ instruction: "Observe the silver meadow gently before placing the copper ribbons underneath the ancient bridge." });
    const first = verifyTrustedBundle(original, anchors);
    const second = verifyTrustedBundle(replacement, anchors);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.manifest.id, second.manifest.id);
    assert.equal(first.manifest.version, second.manifest.version);
    assert.equal(first.manifest.listing.title, second.manifest.listing.title);
    assert.equal(first.manifest.author.key_id, second.manifest.author.key_id);
    assert.notEqual(crypto.createHash("sha256").update(original).digest("hex"), crypto.createHash("sha256").update(replacement).digest("hex"));
    assertChanged(readDuringReplacement(replacement, "1.0.0").result);
  });
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
