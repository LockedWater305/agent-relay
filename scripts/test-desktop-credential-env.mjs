/**
 * Credential restart regressions, using only synthetic keys and temporary stores.
 * Runs the actual main-process function bodies with a fake safeStorage binding,
 * without loading Electron or starting any network/provider requests.
 * Run: node --test scripts/test-desktop-credential-env.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import test from "node:test";
import { saveInference, clearInference, storePath } from "./lib/inference.mjs";
import { saveMusicKey, clearMusicKey, musicStorePath } from "./lib/music-keys.mjs";

const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
const envKeys = [
  "BZ_CHAT_KEY", "BZ_CHAT_BASE_URL", "BZ_CHAT_MODEL", "BZ_MANAGED_EXPIRED",
  "BZ_MUSIC_VIA_GATEWAY", "BZ_ELEVEN_KEY",
];

function functionSource(name) {
  const start = source.indexOf(`async function ${name}() {`);
  assert.notEqual(start, -1, `main process still defines ${name}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `main process function ${name} is complete`);
  return `(${source.slice(start, end + 2)})`;
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bz-credential-env-"));
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  const logged = [];
  let decryptionFails = false;
  const cipher = {
    // A reversible fixture only, not production encryption.
    encrypt: (value) => Buffer.from(`fixture:${value}`),
    decrypt: (value) => {
      if (decryptionFails) throw new Error("fixture decryption unavailable");
      const text = Buffer.from(value).toString();
      assert.ok(text.startsWith("fixture:"));
      return text.slice("fixture:".length);
    },
  };
  const context = {
    process, Buffer,
    supervisor: { dataDir: dir },
    safeStorage: { decryptString: cipher.decrypt },
    runtimeLib: (path) => {
      assert.ok(["scripts/lib/inference.mjs", "scripts/lib/music-keys.mjs"].includes(path));
      return import(new URL(`../${path}`, import.meta.url));
    },
    console: {
      log: (...values) => logged.push(values.join(" ")),
      warn: (...values) => logged.push(values.join(" ")),
    },
  };
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    assert.equal(logged.some((line) => /synthetic-key|sk_synthetic/.test(line)), false, "credentials must not be logged");
  });
  const inferenceContext = createContext(context);
  const inferenceStart = source.indexOf("const injectedInferenceEnv =");
  const inferenceEnd = source.indexOf("\n}", source.indexOf("async function applyStoredInferenceToEnv()")) + 2;
  assert.ok(inferenceStart >= 0 && inferenceEnd > inferenceStart);
  runInContext(source.slice(inferenceStart, inferenceEnd), inferenceContext);
  return {
    dir, cipher,
    failDecryption: () => { decryptionFails = true; },
    applyInference: runInContext("applyStoredInferenceToEnv", inferenceContext),
    applyMusic: runInNewContext(functionSource("applyStoredMusicToEnv"), context),
  };
}

test("replacement inference key with blank optional fields cannot inherit the old gateway/model", async (t) => {
  const fixture = setup(t);
  saveInference(fixture.dir, {
    provider: "beezilla", key: "synthetic-key-old-managed",
    baseUrl: "https://old-gateway.example/v1", model: "old-model",
    expiresAt: "2099-01-01T00:00:00.000Z",
  }, fixture.cipher);
  await fixture.applyInference();
  assert.equal(process.env.BZ_CHAT_BASE_URL, "https://old-gateway.example/v1");
  assert.equal(process.env.BZ_CHAT_MODEL, "old-model");
  assert.equal(process.env.BZ_MUSIC_VIA_GATEWAY, "https://old-gateway.example/v1");

  saveInference(fixture.dir, {
    provider: "byok", key: "synthetic-key-replacement", baseUrl: "", model: "",
  }, fixture.cipher);
  await fixture.applyInference();
  assert.equal(process.env.BZ_CHAT_KEY, "synthetic-key-replacement");
  assert.equal(process.env.BZ_CHAT_BASE_URL, undefined);
  assert.equal(process.env.BZ_CHAT_MODEL, undefined);
  assert.equal(process.env.BZ_MUSIC_VIA_GATEWAY, undefined);
  assert.equal(process.env.BZ_MANAGED_EXPIRED, undefined);
});

test("explicit replacement inference endpoints and models still take effect", async (t) => {
  const fixture = setup(t);
  for (const [baseUrl, model] of [
    ["http://127.0.0.1:11434/v1", "local-model"],
    ["https://advocate.example/custom/v1", "remote-model"],
  ]) {
    saveInference(fixture.dir, { provider: "byok", key: "synthetic-key-explicit", baseUrl, model }, fixture.cipher);
    await fixture.applyInference();
    assert.equal(process.env.BZ_CHAT_KEY, "synthetic-key-explicit");
    assert.equal(process.env.BZ_CHAT_BASE_URL, baseUrl);
    assert.equal(process.env.BZ_CHAT_MODEL, model);
  }
});

test("cleared or unreadable inference stores remove applied credentials", async (t) => {
  const fixture = setup(t);
  for (const remove of [
    () => clearInference(fixture.dir),
    () => writeFileSync(storePath(fixture.dir), "not JSON"),
    () => fixture.failDecryption(),
  ]) {
    saveInference(fixture.dir, {
      provider: "beezilla", key: "synthetic-key-clear",
      baseUrl: "https://gateway.example/v1", model: "test-model",
    }, fixture.cipher);
    await fixture.applyInference();
    assert.equal(process.env.BZ_CHAT_KEY, "synthetic-key-clear");
    remove();
    await fixture.applyInference();
    for (const name of ["BZ_CHAT_KEY", "BZ_CHAT_BASE_URL", "BZ_CHAT_MODEL", "BZ_MUSIC_VIA_GATEWAY"]) {
      assert.equal(process.env[name], undefined, name);
    }
  }
});

test("expired managed inference refuses, then a fresh BYOK save clears expiration", async (t) => {
  const fixture = setup(t);
  saveInference(fixture.dir, {
    provider: "beezilla", key: "synthetic-key-expired",
    expiresAt: "2000-01-01T00:00:00.000Z",
  }, fixture.cipher);
  await fixture.applyInference();
  assert.equal(process.env.BZ_CHAT_KEY, undefined);
  assert.equal(process.env.BZ_MANAGED_EXPIRED, "1");
  saveInference(fixture.dir, { provider: "byok", key: "synthetic-key-fresh" }, fixture.cipher);
  await fixture.applyInference();
  assert.equal(process.env.BZ_CHAT_KEY, "synthetic-key-fresh");
  assert.equal(process.env.BZ_MANAGED_EXPIRED, undefined);
});

test("music replacement reads the new stored key, not the old applied environment", async (t) => {
  const fixture = setup(t);
  saveMusicKey(fixture.dir, { key: "sk_synthetic_old_music" }, fixture.cipher);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_old_music");
  saveMusicKey(fixture.dir, { key: "sk_synthetic_new_music" }, fixture.cipher);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_new_music");
});

test("removing the music key also removes the previously applied environment key", async (t) => {
  const fixture = setup(t);
  saveMusicKey(fixture.dir, { key: "sk_synthetic_removed_music" }, fixture.cipher);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_removed_music");
  clearMusicKey(fixture.dir);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, undefined);
});

test("unreadable or undecryptable music stores do not revive the old environment key", async (t) => {
  const fixture = setup(t);
  for (const invalidate of [
    () => writeFileSync(musicStorePath(fixture.dir), "not JSON"),
    () => fixture.failDecryption(),
  ]) {
    saveMusicKey(fixture.dir, { key: "sk_synthetic_unreadable_music" }, fixture.cipher);
    await fixture.applyMusic();
    assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_unreadable_music");
    invalidate();
    await fixture.applyMusic();
    assert.equal(process.env.BZ_ELEVEN_KEY, undefined);
  }
});
