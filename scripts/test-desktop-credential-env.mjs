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
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { saveInference, clearInference, storePath } from "./lib/inference.mjs";
import { saveMusicKey, clearMusicKey, musicStorePath } from "./lib/music-keys.mjs";

const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
const envKeys = [
  "BZ_CHAT_KEY", "BZ_CHAT_BASE_URL", "BZ_CHAT_MODEL", "BZ_MANAGED_EXPIRED",
  "BZ_MUSIC_VIA_GATEWAY", "BZ_ELEVEN_KEY",
];

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
  const credentialContext = createContext(context);
  const credentialStart = source.indexOf("const injectedInferenceEnv =");
  const credentialEnd = source.indexOf("\n}", source.indexOf("async function applyStoredMusicToEnv()")) + 2;
  assert.ok(credentialStart >= 0 && credentialEnd > credentialStart);
  runInContext(source.slice(credentialStart, credentialEnd), credentialContext);
  return {
    dir, cipher,
    failDecryption: () => { decryptionFails = true; },
    applyInference: runInContext("applyStoredInferenceToEnv", credentialContext),
    applyMusic: runInContext("applyStoredMusicToEnv", credentialContext),
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

test("launch-time music overrides win even when Settings saves, removes or cannot read a key", async (t) => {
  const fixture = setup(t);
  // Equal values still have different ownership: Settings must not take over
  // the exported key or erase it when the saved credentials are cleared.
  const exported = "sk_synthetic_exported_music";
  process.env.BZ_ELEVEN_KEY = exported;
  for (const storeChange of [
    () => saveMusicKey(fixture.dir, { key: exported }, fixture.cipher),
    () => saveMusicKey(fixture.dir, { key: "sk_synthetic_other_music" }, fixture.cipher),
    () => clearMusicKey(fixture.dir),
    () => writeFileSync(musicStorePath(fixture.dir), "not JSON"),
  ]) {
    storeChange();
    await fixture.applyMusic();
    assert.equal(process.env.BZ_ELEVEN_KEY, exported);
  }
});

test("removing injected music configuration restores the original blank launch setting", async (t) => {
  const fixture = setup(t);
  process.env.BZ_ELEVEN_KEY = " ";
  saveMusicKey(fixture.dir, { key: "sk_synthetic_from_store" }, fixture.cipher);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_from_store");
  clearMusicKey(fixture.dir);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, " ");
});

test("a later music override is not cleared as if it were injected by the desktop", async (t) => {
  const fixture = setup(t);
  saveMusicKey(fixture.dir, { key: "sk_synthetic_injected_music" }, fixture.cipher);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_injected_music");
  process.env.BZ_ELEVEN_KEY = "sk_synthetic_updated_override";
  clearMusicKey(fixture.dir);
  await fixture.applyMusic();
  assert.equal(process.env.BZ_ELEVEN_KEY, "sk_synthetic_updated_override");
});
