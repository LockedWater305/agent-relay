// The actual transcription route, saved preferences and request construction.
// The request body is only synthetic marker bytes, not a recording. The virtual
// machine's fetch is a recorder; this test never opens a socket or mic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = async name =>
  stripTypeScriptTypes(await readFile(new URL("../src/lib/buzzy/" + name + ".ts", import.meta.url), "utf8"));
const [nitro, prefsSource, asrSource] = await Promise.all(["chat.nitro", "modelPrefs", "asr"].map(source));
const verifySource = stripTypeScriptTypes(await readFile(new URL("../src/lib/auth/verify.server.ts", import.meta.url), "utf8"));
const vStart = verifySource.indexOf("export async function getSessionUserFromHeaders(");
const vStop = verifySource.indexOf("/**\n * Resolve the signed-in user", vStart);
assert.ok(vStart >= 0 && vStop > vStart);
const start = nitro.indexOf('  if (method === "POST" && path === "/api/buzzy/transcribe") {');
const stop = nitro.indexOf("  // ── /api/buzzy/model3d", start);
assert.ok(start >= 0 && stop > start);
const handler = nitro.slice(start, stop);
const cloud = "https://speech.example.invalid/v1";
const loopback = "http://127.0.0.1:8089/v1";
const marker = Buffer.alloc(1600, 0x4a);

async function invoke(options = {}) {
  const events = [], requests = [], authCalls = [];
  let reads = 0;
  const controller = new AbortController();
  const headers = new Headers({ "x-fixture-request": "original" });
  const sql = async (parts, ...args) => {
    const q = parts.join("?");
    if (/select prefs from ar_operator_prefs/.test(q)) {
      events.push("preferences");
      assert.deepEqual(args, ["fixture-owner"]);
      reads++;
      if (options.abortOnPolicyRead === reads) controller.abort();
      if (options.failRead === reads) throw new Error("fixture storage unavailable");
      if (options.missing === true) return [];
      const saved = options.sequence ?? [{ localOnly: false }];
      return [{ prefs: saved[Math.min(reads - 1, saved.length - 1)] }];
    }
    if (/coalesce\(sum\(cost_usd\)/.test(q)) assert.fail("privacy must not read spend");
    if (/SELECT (title|name) AS term/.test(q)) {
      events.push("vocabulary");
      assert.deepEqual(args, ["fixture-owner"]);
      return [];
    }
    assert.fail("unexpected fixture query: " + q);
  };
  const identity = () => {
    const i = authCalls.length - 1;
    const identities = options.identities ?? ["fixture-owner"];
    return identities[Math.min(i, identities.length - 1)];
  };
  const context = vm.createContext({
    Buffer, Uint8Array, Date, Headers,
    process: { env: { BZ_CHAT_BASE_URL: options.endpoint ?? cloud, BZ_CHAT_KEY: "synthetic-no-key", BZ_ASR_MODEL: "fixture-model" } },
    authConfigured: options.authConfigured !== false,
    isLocalRuntime: () => options.local === true,
    resolveLocalRequester: async requestHeaders => {
      events.push("local-auth");
      authCalls.push({ headers: requestHeaders, local: true });
      const id = identity();
      return id ? { id, email: null } : null;
    },
    auth: { api: { getSession: async ({ headers, query }) => {
      events.push(query?.disableCookieCache === true ? "auth" : "cached-auth");
      authCalls.push({ headers, query });
      // The synthetic cache keeps returning the original owner even after the
      // authoritative fixture store revokes the original session.
      if (query?.disableCookieCache !== true) return { user: { id: "fixture-owner" } };
      if (options.failAuth === authCalls.length) throw new Error("fixture auth unavailable");
      const id = identity();
      return id ? { user: { id } } : null;
    } } },
    headersFromEvent: () => headers,
    getHeader: () => options.mime ?? "audio/wav",
    getSql: async () => sql,
    setResponseStatus: (event, status) => { event.status = status; },
    queryValue: () => null,
    recordVoiceMetrics: async () => { events.push("metrics"); },
    fetch: async (url, init) => {
      events.push("provider");
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Fixture words only." } }] }) };
    },
  });
  const board = new vm.SyntheticModule(["boardOps"], function () {
    this.setExport("boardOps", { isUserDisabled: async () => {
      events.push("account-state");
      if (options.failAccountState === authCalls.length) throw new Error("fixture account store unavailable");
      return options.disableAccountOn === authCalls.length;
    } });
  }, { context });
  await board.link(() => assert.fail("unexpected board dependency"));
  await board.evaluate();
  for (const [name, body] of [["modelPrefs", prefsSource], ["asr", asrSource], ["verify", verifySource.slice(vStart, vStop)]]) {
    const m = new vm.SourceTextModule(body, { context, identifier: name,
      importModuleDynamically: async id => {
        assert.equal(id, "../board-server");
        return board;
      },
    });
    await m.link(specifier => { assert.fail("unexpected dependency " + specifier); });
    await m.evaluate();
    for (const key of Object.keys(m.namespace)) context[key] = m.namespace[key];
  }
  const call = vm.runInContext("(async (event, method, path, fullPath) => {" + handler + "})", context);
  const event = { status: 200, req: { signal: controller.signal, async arrayBuffer() {
    events.push("body");
    return marker.buffer.slice(marker.byteOffset, marker.byteOffset + marker.byteLength);
  } } };
  const response = options.ordinaryAuth
    ? await context.getSessionUserFromHeaders(headers)
    : await call(event, "POST", "/api/buzzy/transcribe", "/api/buzzy/transcribe");
  for (const auth of authCalls) {
    assert.equal(auth.headers.get("x-fixture-request"), "original");
    if (!auth.local && !options.ordinaryAuth) {
      assert.equal(auth.query?.disableCookieCache, true);
      assert.equal(auth.query?.disableRefresh, true);
    }
  }
  return { response, status: event.status, events, requests, authCalls };
}

test("unauthenticated and Local Only refuse before examining the recorded body", async () => {
  const noUser = await invoke({ identities: [null] });
  assert.equal(noUser.status, 401);
  assert.deepEqual(noUser.events, ["auth"]);
  for (const endpoint of [cloud, loopback]) {
    const r = await invoke({ endpoint, sequence: [{ localOnly: true }] });
    assert.equal(r.status, 409);
    assert.equal(r.response.code, "transcription_local_only");
    assert.match(r.response.error, /no verified on-device transcription/i);
    assert.deepEqual(r.events, ["auth", "account-state", "preferences"]);
    assert.deepEqual(r.requests, []);
  }
});

test("unreadable or malformed saved preferences cannot unlock ASR", async () => {
  for (const bad of [{ failRead: 1 }, { sequence: [null] }, { sequence: [[]] }, { sequence: [{ localOnly: "false" }] }]) {
    const r = await invoke(bad);
    assert.equal(r.status, 503);
    assert.equal(r.response.code, "transcription_policy_unavailable");
    assert.deepEqual(r.events, ["auth", "account-state", "preferences"]);
    assert.deepEqual(r.requests, []);
  }
});

test("a mode change or failed check after the body arrived still blocks provider forwarding", async () => {
  for (const [opts, code, status] of [
    [{ sequence: [{ localOnly: false }, { localOnly: true }] }, "transcription_local_only", 409],
    [{ failRead: 2 }, "transcription_policy_unavailable", 503],
    [{ sequence: [{ localOnly: false }, null] }, "transcription_policy_unavailable", 503],
  ]) {
    const r = await invoke(opts);
    assert.equal(r.status, status);
    assert.equal(r.response.code, code);
    assert.deepEqual(r.events, ["auth", "account-state", "preferences", "body", "vocabulary", "vocabulary", "auth", "account-state", "preferences"]);
    assert.deepEqual(r.requests, []);
  }
});

test("a revoked, changed or unverifiable original hosted identity cannot forward the clip", async () => {
  for (const options of [
    { identities: ["fixture-owner", null] },
    { identities: ["fixture-owner", "fixture-other"] },
    { failAuth: 2 }, { failAccountState: 2 }, { disableAccountOn: 2 },
  ]) {
    const r = await invoke(options);
    assert.equal(r.status, 401);
    assert.equal(r.response.code, "transcription_session_changed");
    assert.equal(r.authCalls.length, 2);
    assert.equal(r.events.filter(name => name === "preferences").length, 1);
    assert.deepEqual(r.requests, []);
    assert.ok(!r.events.includes("cached-auth") && !r.events.includes("metrics"));
  }
});

test("a request aborted during the final policy read cannot forward its bytes", async () => {
  const r = await invoke({ abortOnPolicyRead: 2 });
  assert.equal(r.status, 499);
  assert.equal(r.response.code, "transcription_cancelled");
  assert.deepEqual(r.requests, []);
  assert.equal(r.events.at(-1), "preferences");
});

test("ordinary authenticated mode preserves the route and forwards once after the second check", async () => {
  for (const opts of [{ sequence: [{ localOnly: false }] }, { missing: true }]) {
    const r = await invoke(opts);
    assert.equal(r.status, 200);
    assert.equal(r.response.text, "Fixture words only.");
    assert.deepEqual(r.events, ["auth", "account-state", "preferences", "body", "vocabulary", "vocabulary", "auth", "account-state", "preferences", "provider", "metrics"]);
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].url, cloud + "/chat/completions");
    assert.equal(r.requests[0].body.messages[1].content[0].input_audio.data, marker.toString("base64"));
  }
});

test("desktop uses the native session authority on both checks, not the hosted cache", async () => {
  const r = await invoke({ local: true, authConfigured: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.events, ["local-auth", "preferences", "body", "vocabulary", "vocabulary", "local-auth", "preferences", "provider", "metrics"]);
  assert.equal(r.requests.length, 1);
  const denied = await invoke({ local: true, identities: ["fixture-owner", null] });
  assert.equal(denied.response.code, "transcription_session_changed");
  assert.deepEqual(denied.requests, []);
});

test("non-ASR callers of the verifier retain existing cookie-cache and account-store fallback behavior", async () => {
  const r = await invoke({ ordinaryAuth: true, failAccountState: 1 });
  assert.equal(r.response.id, "fixture-owner");
  assert.deepEqual(r.events, ["cached-auth", "account-state"]);
  assert.equal(r.authCalls[0].query, undefined);
  assert.deepEqual(r.requests, []);
});

test("a malformed ordinary request is still rejected without consuming bytes", async () => {
  const r = await invoke({ mime: "text/plain" });
  assert.equal(r.status, 415);
  assert.equal(r.response.code, "bad_audio_type");
  assert.deepEqual(r.events, ["auth", "account-state", "preferences"]);
  assert.deepEqual(r.requests, []);
});
