// Production route/auth/context/preference code, with only inert request,
// database, auth-store and provider fixtures. No audio, sockets or credentials.
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const lib = path => new URL("../src/lib/" + path, import.meta.url);
const ts = async path => stripTypeScriptTypes(await readFile(lib(path), "utf8"), { mode: "transform" });
const [nitro, prefs, verify, local, stamps] = await Promise.all([
  "buzzy/chat.nitro.ts", "buzzy/modelPrefs.ts", "auth/verify.server.ts", "local-owner.ts", "auth/request-context.server.ts",
].map(ts));
const start = nitro.indexOf('if (path === "/api/buzzy/audio-input-capability")');
const end = nitro.indexOf('if (path === "/api/buzzy/model3d"', start);
const contextSpec = nitro.match(/^const AUDIO_INPUT_CONTEXT = [^;]*;/m)?.[0];
assert.ok(start >= 0 && end > start && contextSpec, "test the shipped route branches");
const route = contextSpec + "\n;(async (event, method, path, fullPath) => {" + nitro.slice(start, end) + "})";
const GET = "/api/buzzy/audio-input-capability", POST = "/api/buzzy/transcribe";
const NAME = "fixture-owner", OTHER = "different-fixture-owner";
const NATIVE = "local_owner", A = "synthetic-launch-alpha-0000000000000", B = "synthetic-launch-bravo-0000000000000";
const SESSION = "synthetic-hosted-session", ROTATED = "other-synthetic-hosted-session";
const START = 1_800_000_000_000, TTL = 15_000;
const stampHeader = "x-bz-audio-context";
const capture = Buffer.alloc(1600, 0x39); // shape marker only, not a recording
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

async function fixture(opts = {}) {
  const state = {
    now: START, native: false, owner: NAME, token: SESSION, launch: A,
    signedIn: true, authorized: true, prefs: { localOnly: false }, ...opts,
  };
  const evidence = { body: 0, provider: 0, auth: [], prefs: [], nativeWrites: 0 };
  class FixtureDate extends Date { static now() { return state.now; } }
  const env = {};
  Object.defineProperty(env, "BZ_LOCAL_TOKEN", { get: () => state.launch });
  const sql = async (fragments, ...args) => {
    const query = fragments.join("?");
    if (/insert into "user"/i.test(query)) {
      evidence.nativeWrites++;
      assert.equal(args[0], NATIVE);
      if (state.localReady) await state.localReady;
      return [];
    }
    if (/select id, name, email from "user"/i.test(query)) {
      assert.deepEqual(args, [NATIVE]);
      return [{ id: NATIVE, name: "Fixture desktop", email: null }];
    }
    if (/select prefs from ar_operator_prefs/.test(query)) {
      evidence.prefs.push(args[0]);
      await state.onPref?.(evidence.prefs.length);
      if (state.storageDown) throw Error("synthetic storage unavailable");
      return state.missingRow ? [] : [{ prefs: state.prefs }];
    }
    if (/SELECT (title|name) AS term/.test(query)) return [];
    assert.fail("unexpected SQL: " + query);
  };
  const context = vm.createContext({
    console, Buffer, Headers, Uint8Array, Date: FixtureDate, process: { env },
    headersFromEvent: event => event.headers,
    setResponseHeader: (event, name, value) => event.resultHeaders.set(name, value),
    setResponseStatus: (event, status) => { event.status = status; },
    getHeader: (event, name) => event.headers.get(name),
    getSql: async () => sql,
    queryValue: () => null,
    formatFromContentType: type => type === "audio/wav" ? "wav" : null,
    ASR_MAX_BYTES: 8 * 1024 * 1024,
    normalizeVocab: () => [],
    recordVoiceMetrics: async () => {},
    transcribeAudio: async (bytes, format) => {
      assert.deepEqual(Buffer.from(bytes), capture);
      assert.equal(format, "wav");
      evidence.provider++;
      return { text: "synthetic fixture", ms: 1, model: "fixture" };
    },
    fetch: () => assert.fail("real fetch is not part of this fixture"),
  });
  const synthetic = obj => new vm.SyntheticModule(Object.keys(obj), function () {
    for (const key of Object.keys(obj)) this.setExport(key, obj[key]);
  }, { context });
  const deps = {};
  const compile = (name, body) => new vm.SourceTextModule(body, {
    context, identifier: name,
    importModuleDynamically: async id => {
      assert.equal(id, "../board-server");
      return deps.board;
    },
  });
  deps.board = synthetic({ boardOps: { isUserDisabled: async () => {
    if (state.accountStateDown) throw Error("synthetic disabled-account lookup unavailable");
    return !state.authorized;
  } } });
  await deps.board.link(() => assert.fail("unexpected board dependency"));
  await deps.board.evaluate();
  Object.assign(deps, {
    "node:crypto": synthetic({
      createHmac: crypto.createHmac, timingSafeEqual: crypto.timingSafeEqual, randomBytes: crypto.randomBytes,
    }),
    "@tanstack/react-start/server": synthetic({ getRequest: () => null }),
    "./server": synthetic({ authConfigured: true, auth: { api: { getSession: async ({ headers, query }) => {
      evidence.auth.push({ headers, query });
      await state.onAuth?.(evidence.auth.length);
      if (state.authDown) throw Error("synthetic authoritative auth unavailable");
      return state.signedIn ? {
        user: { id: state.owner, email: "fixture@example.invalid" },
        session: { userId: state.sessionOwner ?? state.owner, token: state.token },
      } : null;
    } } } }),
    "../runtime": synthetic({ isLocalRuntime: () => state.native }),
    "./runtime": synthetic({ isLocalRuntime: () => state.native }),
    "./db": synthetic({ getSql: async () => sql }),
    "./roles": synthetic({ gateCapability: () => {}, resolveOperatorRoleFromEnv: () => {} }),
  });
  deps["../local-owner"] = compile("local-owner", local);
  const modules = [compile("verify", verify), compile("stamps", stamps), compile("prefs", prefs)];
  for (const m of modules) {
    await m.link(name => {
      assert.ok(deps[name], "missing fixture import " + name);
      return deps[name];
    });
    await m.evaluate();
    for (const key of Object.keys(m.namespace)) context[key] = m.namespace[key];
  }
  const handle = vm.runInContext(route, context);
  function authHeaders(extras = {}) {
    return new Headers(state.native ? {
      host: "127.0.0.1:7331", authorization: "Bearer " + state.launch, ...extras,
    } : { "sec-fetch-site": "same-origin", "x-fixture-request": "original", ...extras });
  }
  async function request({ path = GET, method = "GET", headers, signal, aborted = false } = {}) {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const event = {
      status: 200, resultHeaders: new Headers(),
      headers: authHeaders({ ...(path === POST ? { "content-type": "audio/wav" } : {}), ...headers }),
      req: { signal: signal ?? controller.signal, async arrayBuffer() {
        evidence.body++;
        assert.equal(path, POST, "capability never reads a body");
        await state.onBody?.();
        return capture.buffer.slice(capture.byteOffset, capture.byteOffset + capture.byteLength);
      } },
    };
    const data = await handle(event, method, path, path);
    return { status: event.status, headers: event.resultHeaders, data };
  }
  const acquire = async () => {
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    return r.data.context;
  };
  const use = (value, init = {}) => request({
    path: POST, method: "POST", ...init, headers: { ...(value === undefined ? {} : { [stampHeader]: value }), ...init.headers },
  });
  return { state, evidence, context, request, acquire, use, authHeaders };
}

const cache = r => assert.equal(r.headers.get("cache-control"), "private, no-store");
const denied = (r, status, code) => {
  assert.equal(r.status, status);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.code, code);
};
const noAudio = h => assert.deepEqual([h.evidence.body, h.evidence.provider], [0, 0]);

test("file-free preflight returns only a bounded private capability from current same-owner privacy", async () => {
  const h = await fixture({ onPref(n) { if (n === 2) h.state.now += 240; } });
  const r = await h.request();
  cache(r);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ["context", "input", "maxAgeMs", "ok", "version"]);
  assert.equal(r.data.input, "guarded_server");
  assert.equal(r.data.version, 1);
  assert.equal(r.data.maxAgeMs, TTL - 240);
  assert.match(r.data.context, /^1800000015000\.[\w-]{16}\.[\w-]{43}$/);
  assert.doesNotMatch(JSON.stringify(r.data), /synthetic-hosted-session|fixture-owner|fixture@example/);
  assert.deepEqual(h.evidence.prefs, [NAME, NAME]);
  assert.equal(h.evidence.auth.length, 2);
  for (const call of h.evidence.auth) {
    assert.equal(call.headers.get("x-fixture-request"), "original");
    assert.equal(call.query.disableCookieCache, true);
    assert.equal(call.query.disableRefresh, true);
  }
  noAudio(h);
});

test("Local Only, malformed stored settings and read failure deny without media or signing", async () => {
  for (const [opts, status, code] of [
    [{ prefs: { localOnly: true } }, 409, "audio_input_local_only"],
    [{ prefs: { localOnly: "false" } }, 503, "audio_input_policy_unavailable"],
    [{ prefs: null }, 503, "audio_input_policy_unavailable"],
    [{ prefs: [] }, 503, "audio_input_policy_unavailable"],
    [{ storageDown: true }, 503, "audio_input_policy_unavailable"],
  ]) {
    const h = await fixture(opts), r = await h.request();
    cache(r); denied(r, status, code);
    assert.equal(Object.hasOwn(r.data, "context"), false);
    assert.deepEqual(h.evidence.prefs, [NAME]);
    noAudio(h);
  }
  const defaultPrefs = await fixture({ missingRow: true });
  assert.ok(await defaultPrefs.acquire()); // Existing documented default, not user consent.
});

test("unsupported methods and browser cross-origin preflights do no auth, body or policy work", async () => {
  const h = await fixture();
  const post = await h.request({ method: "POST" });
  cache(post); denied(post, 405, "audio_input_method");
  assert.equal(post.headers.get("allow"), "GET");
  for (const site of ["cross-site", "same-site"]) {
    const disallowed = await h.request({ headers: { "sec-fetch-site": site } });
    cache(disallowed); denied(disallowed, 403, "audio_input_origin");
  }
  assert.deepEqual([h.evidence.auth.length, h.evidence.prefs.length], [0, 0]); noAudio(h);
});

test("hosted preflight denies stale/disabled/missing persisted session before owner-policy SQL", async () => {
  for (const opts of [
    { signedIn: false }, { authorized: false }, { authDown: true }, { accountStateDown: true },
    { sessionOwner: OTHER }, { token: "" },
  ]) {
    const h = await fixture(opts), r = await h.request();
    cache(r); denied(r, 401, "audio_input_auth_unverified");
    assert.deepEqual(h.evidence.prefs, []); noAudio(h);
  }
});

test("desktop awaits the actual async local-owner verifier, without requiring a hosted account", async () => {
  const gate = deferred(), entered = deferred();
  const h = await fixture({ native: true, signedIn: false, localReady: gate.promise });
  h.state.onPref = () => entered.resolve();
  let settled = false;
  const pending = h.request().then(value => { settled = true; return value; });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(h.evidence.nativeWrites, 1);
  assert.equal(settled, false);
  assert.deepEqual(h.evidence.prefs, []);
  gate.resolve(); await entered.promise;
  const r = await pending;
  cache(r); assert.equal(r.data.input, "guarded_server");
  assert.deepEqual(h.evidence.prefs, [NATIVE, NATIVE]);
  assert.equal(h.evidence.auth.length, 0);
  const user = await h.context.getSessionUserFromHeaders(h.authHeaders(), { bindRequest: "audio-input" });
  assert.equal(user.id, NATIVE);
  assert.match(user.requestBinding, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(user), /synthetic-launch/);
  noAudio(h);
});

test("hostname alone, wrong token/host or a rotated async launch never mints a desktop stamp", async () => {
  for (const [launch, headers] of [
    [null, { authorization: "" }], ["legacy-short", {}], [A, { authorization: "" }],
    [A, { authorization: "Bearer " + B }], [A, { host: "wrong.example.invalid" }],
  ]) {
    const h = await fixture({ native: true, launch }), r = await h.request({ headers });
    cache(r); denied(r, 401, "audio_input_auth_unverified");
    assert.equal(h.evidence.nativeWrites, 0);
    assert.deepEqual(h.evidence.prefs, []); noAudio(h);
  }
  const gate = deferred(), h = await fixture({ native: true, localReady: gate.promise });
  const pending = h.request();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(h.evidence.nativeWrites, 1);
  h.state.launch = B; gate.resolve();
  denied(await pending, 401, "audio_input_auth_unverified");
  assert.deepEqual(h.evidence.prefs, []); noAudio(h);
});

test("reauth and final strict read refuse account/credential/mode changes while preflight waits", async () => {
  for (const [update, code] of [
    [{ owner: OTHER }, "audio_context_changed"],
    [{ token: ROTATED }, "audio_context_changed"],
    [{ signedIn: false }, "audio_context_changed"],
    [{ prefs: { localOnly: true } }, "audio_input_local_only"],
  ]) {
    const h = await fixture();
    h.state.onPref = n => {
      if (n === 1 && !update.prefs) Object.assign(h.state, update);
      if (n === 2 && update.prefs) Object.assign(h.state, update);
    };
    const r = await h.request(); cache(r); denied(r, 409, code); noAudio(h);
  }
});

test("optional refresh expects the same unexpired session, not a different account/current launch", async () => {
  const host = await fixture(), prior = await host.acquire();
  const replica = await fixture();
  replica.state.now += 120;
  const r = await replica.request({ headers: { [stampHeader]: prior } });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.context, prior);
  for (const update of [{ owner: OTHER }, { owner: NAME, token: ROTATED }]) {
    Object.assign(replica.state, update);
    denied(await replica.request({ headers: { [stampHeader]: prior } }), 409, "audio_context_changed");
  }
  host.state.now = START + TTL;
  denied(await host.request({ headers: { [stampHeader]: prior } }), 409, "audio_context_changed");
  for (const value of ["", "malformed", prior + "x", prior + ", " + prior]) {
    denied(await host.request({ headers: { [stampHeader]: value } }), 409, "audio_context_changed");
  }
  const native = await fixture({ native: true }), old = await native.acquire();
  native.state.launch = B;
  denied(await native.request({ headers: { [stampHeader]: old } }), 409, "audio_context_changed");
  noAudio(native); noAudio(host); noAudio(replica);
});

test("a slow or cancelled preflight cannot issue a fresh longer authorization", async () => {
  const h = await fixture();
  h.state.onPref = n => { if (n === 2) h.state.now = START + TTL; };
  denied(await h.request(), 503, "audio_input_policy_unavailable");
  h.state.onPref = null;
  denied(await h.request({ aborted: true }), 503, "audio_input_policy_unavailable");
  noAudio(h);
});

test("reauthenticates the original account and binding after the first privacy read, without opening the body", async () => {
  const prior = await (await fixture()).acquire();
  for (const [change, status, code] of [
    [{ token: ROTATED }, 409, "audio_context_changed"],
    [{ owner: OTHER }, 401, "transcription_session_changed"],
    [{ signedIn: false }, 401, "transcription_session_changed"],
    [{ authDown: true }, 401, "transcription_session_changed"],
  ]) {
    const h = await fixture(), read = deferred(), resume = deferred();
    h.state.onPref = n => {
      if (n === 1) { read.resolve(); return resume.promise; }
    };
    const pending = h.use(prior);
    await read.promise;
    Object.assign(h.state, change);
    resume.resolve();
    const r = await pending;
    cache(r); denied(r, status, code); noAudio(h);
    assert.deepEqual(h.evidence.prefs, [NAME]);
    assert.equal(h.evidence.auth.length, 2);
    for (const call of h.evidence.auth) {
      assert.equal(call.headers.get("x-fixture-request"), "original");
      assert.equal(call.query.disableCookieCache, true);
      assert.equal(call.query.disableRefresh, true);
    }
  }
});

test("an asynchronously verified native launch changed during the first privacy read cannot open the body", async () => {
  const h = await fixture({ native: true, signedIn: false });
  const prior = await h.acquire();
  const read = deferred(), resume = deferred();
  h.state.onPref = n => {
    if (n === 3) { read.resolve(); return resume.promise; }
  };
  const pending = h.use(prior);
  await read.promise;
  h.state.launch = B;
  resume.resolve();
  denied(await pending, 401, "transcription_session_changed"); noAudio(h);
  assert.deepEqual(h.evidence.prefs, [NATIVE, NATIVE, NATIVE]);
  assert.equal(h.evidence.auth.length, 0);
});

test("bound transcription does not open an already cancelled request or one cancelled/expired during final pre-body auth", async () => {
  const prior = await (await fixture()).acquire();
  const cancelled = await fixture();
  denied(await cancelled.use(prior, { aborted: true }), 499, "transcription_cancelled");
  noAudio(cancelled);
  for (const scenario of ["cancelled", "expired"]) {
    const h = await fixture(), controller = new AbortController(), auth = deferred(), resume = deferred();
    h.state.onAuth = n => {
      if (n === 2) { auth.resolve(); return resume.promise; }
    };
    const pending = h.use(prior, { signal: controller.signal });
    await auth.promise;
    if (scenario === "cancelled") controller.abort();
    else h.state.now += TTL;
    resume.resolve();
    const r = await pending;
    if (scenario === "cancelled") denied(r, 499, "transcription_cancelled");
    else denied(r, 409, "audio_context_changed");
    noAudio(h);
  }
});

test("opt-in ASR requires a matching stamp before the body and immediately before forwarding", async () => {
  const h = await fixture(), prior = await h.acquire();
  const crossOrigin = await fixture();
  const refused = await crossOrigin.use(prior, { headers: { "sec-fetch-site": "cross-site" } });
  cache(refused); denied(refused, 403, "audio_input_origin"); noAudio(crossOrigin);
  assert.equal(crossOrigin.evidence.auth.length, 0);
  const changed = await fixture({ token: ROTATED });
  denied(await changed.use(prior), 409, "audio_context_changed"); noAudio(changed);
  const expiresInLookup = await fixture();
  expiresInLookup.state.onPref = () => { expiresInLookup.state.now = START + TTL; };
  denied(await expiresInLookup.use(prior), 409, "audio_context_changed"); noAudio(expiresInLookup);
  const expiresInFinalLookup = await fixture();
  expiresInFinalLookup.state.onPref = n => { if (n === 2) expiresInFinalLookup.state.now = START + TTL; };
  denied(await expiresInFinalLookup.use(prior), 409, "audio_context_changed");
  assert.deepEqual([expiresInFinalLookup.evidence.body, expiresInFinalLookup.evidence.provider], [1, 0]);
  const rotatedInBody = await fixture();
  rotatedInBody.state.onBody = () => { rotatedInBody.state.token = ROTATED; };
  denied(await rotatedInBody.use(prior), 409, "audio_context_changed");
  assert.deepEqual([rotatedInBody.evidence.body, rotatedInBody.evidence.provider], [1, 0]);
  const localOnlyInBody = await fixture();
  localOnlyInBody.state.onBody = () => { localOnlyInBody.state.prefs = { localOnly: true }; };
  denied(await localOnlyInBody.use(prior), 409, "transcription_local_only");
  assert.deepEqual([localOnlyInBody.evidence.body, localOnlyInBody.evidence.provider], [1, 0]);
  const success = await h.use(prior);
  cache(success); assert.equal(success.status, 200); assert.equal(success.data.ok, true);
  assert.deepEqual([h.evidence.body, h.evidence.provider], [1, 1]);
  assert.equal(h.evidence.auth.length, 5); // Two preflight; three clip checks.
  assert.deepEqual(h.evidence.prefs, [NAME, NAME, NAME, NAME]);
});

test("legacy ASR still uses its established auth and saved-mode guard without the optional binding", async () => {
  const old = await fixture({ token: "" });
  const result = await old.use(undefined);
  assert.equal(result.status, 200);
  assert.equal(result.headers.has("cache-control"), false);
  assert.deepEqual([old.evidence.body, old.evidence.provider], [1, 1]);
  assert.equal(old.evidence.auth.length, 2);
  assert.deepEqual(old.evidence.prefs, [NAME, NAME]);
  const blocked = await fixture({ prefs: { localOnly: true } });
  denied(await blocked.use(undefined), 409, "transcription_local_only"); noAudio(blocked);
  const cancelled = await fixture();
  const r = await cancelled.use(undefined, { aborted: true });
  denied(r, 499, "transcription_cancelled");
  assert.equal(r.headers.has("cache-control"), false);
  assert.deepEqual([cancelled.evidence.body, cancelled.evidence.provider], [1, 0]);
  assert.equal(cancelled.evidence.auth.length, 2);
  assert.deepEqual(cancelled.evidence.prefs, [NAME, NAME]);
});

test("the proposed attachment adapter retains exact V2 key and proof format, isolated from audio", async () => {
  for (const native of [false, true]) {
    const h = await fixture({ native });
    const token = native ? A : SESSION, scope = native ? "device" : "hosted";
    const destination = native ? "device" : "server";
    const verifyUser = bindRequest => h.context.getSessionUserFromHeaders(h.authHeaders(), { bindRequest });
    const file = await verifyUser("talk-attachment");
    const audio = await verifyUser("audio-input");
    const unbound = await verifyUser(undefined);
    assert.equal(unbound.requestBinding, undefined);
    const keyV2 = crypto.createHmac("sha256", token).update("beezilla/talk-attachment-session/v1:" + scope).digest("hex");
    assert.equal(file.requestBinding, keyV2);
    assert.notEqual(file.requestBinding, audio.requestBinding);
    const spec = { purpose: "talk-attachment-v1", scope: destination, ttlMs: 120_000, clockSkewMs: 5_000 };
    const prefix = (START + 120_000) + "." + Buffer.alloc(12, 7).toString("base64url");
    const v2 = crypto.createHmac("sha256", keyV2).update(JSON.stringify([spec.purpose, file.id, destination, prefix])).digest("base64url");
    assert.equal(h.context.acceptsRequestContext(file, spec, prefix + "." + v2), true);
    assert.equal(h.context.acceptsRequestContext(audio, spec, prefix + "." + v2), false);
    const issued = h.context.issueRequestContext(file, spec);
    const [expiry, nonce, proof] = issued.split(".");
    assert.equal(crypto.createHmac("sha256", keyV2)
      .update(JSON.stringify([spec.purpose, file.id, destination, expiry + "." + nonce])).digest("base64url"), proof);
  }
});
