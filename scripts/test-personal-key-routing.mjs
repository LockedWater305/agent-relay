// Offline mocks only. Run with: npx tsx --test scripts/test-personal-key-routing.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { overrideFor, requiredOverrideFor, sealSecret, PersonalKeyUnavailableError } from "../src/lib/buzzy/userKeys.ts";
import { withLlmOverride, usingOwnKey } from "../src/lib/buzzy/llm.ts";

process.env.BZ_CHAT_BASE_URL = "https://deployment.example/v1";
process.env.BZ_KEY_SEAL_SECRET = "offline-invariant-test-only";
delete process.env.BZ_ALLOW_LOCAL_AI_KEY_URL;
const row = () => ({ base_url: "https://8.8.8.8/v1", model: "mock-model", key_sealed: sealSecret("mock-key-not-real") });
const sql = (rows) => async () => rows;

test("only a verified missing row permits deployment selection", async () => {
  const o = await overrideFor(sql([]), "mock-user");
  assert.equal(o, null);
  let calls = 0;
  await withLlmOverride(o, async () => { calls++; assert.equal(usingOwnKey(), false); });
  assert.equal(calls, 1);
});

test("an invalid saved key cannot enter any completion/credential path", async () => {
  const cases = [
    { ...row(), key_sealed: "invalid-sealed-value" },
    { ...row(), key_sealed: sealSecret("") },
    { ...row(), key_sealed: sealSecret("not a valid key") },
    { ...row(), base_url: "not-a-url" },
    { ...row(), base_url: "http://provider.example/v1" },
    { ...row(), base_url: "https://10.0.0.1/v1" },
  ];
  for (const saved of cases) {
    let calls = 0;
    await assert.rejects(async () => {
      const o = await overrideFor(sql([saved]), "mock-user");
      await withLlmOverride(o, async () => { calls++; });
    }, PersonalKeyUnavailableError);
    assert.equal(calls, 0);
  }
});

test("database/read failure is not treated as absence", async () => {
  let calls = 0;
  await assert.rejects(async () => {
    const o = await overrideFor(async () => { throw new Error("mock unavailable table"); }, "mock-user");
    await withLlmOverride(o, async () => { calls++; });
  }, PersonalKeyUnavailableError);
  assert.equal(calls, 0);
});

test("required saved-key test cannot succeed on absent or invalid configuration", async () => {
  for (const rows of [[], [{ ...row(), key_sealed: "invalid" }]]) {
    let works = false, calls = 0;
    try {
      const o = await requiredOverrideFor(sql(rows), "mock-user");
      await withLlmOverride(o, async () => { calls++; });
      works = true;
    } catch (e) { assert.ok(e instanceof PersonalKeyUnavailableError); }
    assert.equal(works, false);
    assert.equal(calls, 0);
  }
});

test("valid saved key is retained as a personal override without any real request", async () => {
  const o = await requiredOverrideFor(sql([row()]), "mock-user");
  assert.equal(o.apiKey, "mock-key-not-real");
  await withLlmOverride(o, async () => { assert.equal(usingOwnKey(), true); });
  assert.equal(usingOwnKey(), false);
});

test("malformed explicit override does not silently run the callback", async () => {
  for (const o of [{ baseUrl: "", apiKey: "mock-key" }, { baseUrl: "https://provider.example", apiKey: " " }]) {
    let calls = 0;
    await assert.rejects(withLlmOverride(o, async () => { calls++; }), /incomplete/);
    assert.equal(calls, 0);
  }
});

test("personal completion failure propagates without invoking a fallback callback", async () => {
  const o = await requiredOverrideFor(sql([row()]), "mock-user");
  let calls = 0;
  await assert.rejects(withLlmOverride(o, async () => {
    calls++;
    assert.equal(usingOwnKey(), true);
    throw new Error("mock provider unavailable");
  }), /mock provider unavailable/);
  assert.equal(calls, 1);
  assert.equal(usingOwnKey(), false);
});

test("chat rejects key failures before starting a turn; saved-key test requires a key", () => {
  const source = readFileSync(new URL("../src/lib/buzzy/chat.nitro.ts", import.meta.url), "utf8");
  const start = source.indexOf('// ── POST /api/buzzy/chat');
  const chat = source.slice(start, source.indexOf('const runTurn =', start));
  const gate = chat.indexOf('ownKey = await overrideFor(sql, userId);');
  assert.ok(gate >= 0);
  assert.match(chat.slice(gate), /catch \{\s*setResponseStatus\(event, 503\);\s*return \{ ok: false, code: "personal_key_unavailable"/);
  assert.ok(gate < chat.indexOf('units: 1, ms: 0, status: "ok"'));
  const keyTest = source.slice(source.indexOf('if (body.test === true)'));
  assert.match(keyTest, /try \{\s*const o = await requiredOverrideFor\(sql, user.id\);\s*await withLlmOverride\(o,/);
});
