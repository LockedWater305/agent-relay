// Synthetic summary privacy checks: shipped handler, policy, transport and UI.
// No real DB, account, URL request, socket, filesystem grant or provider key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const loadTs = async name => stripTypeScriptTypes(await read("src/lib/buzzy/" + name + ".ts"));
const [sessions, prefs, policy, llm, nitro, html] = await Promise.all([
  ...["sessions", "modelPrefs", "modelPolicy", "llm", "chat.nitro"].map(loadTs), read("public/buzzy/talk.html"),
]);
const section = (text, a, b) => {
  const begin = text.indexOf(a), end = text.indexOf(b, begin + a.length);
  assert.ok(begin >= 0 && end > begin, a);
  return text.slice(begin, end);
};
const handler = section(nitro, "  const summaryMatch = ", "  // ── GET /api/buzzy/papers");
const ui = section(html, "    function summarizeSession(s) {", "    // Start a truly new chat");
const remote = "https://provider.example.invalid/v1", loopback = "http://127.0.0.1:11434/v1";

async function fixture(options = {}) {
  const events = [], requests = [], completionOpts = [];
  const sql = async (parts, ...args) => {
    const query = parts.join("?");
    if (/SELECT id FROM buzzy_sessions/.test(query)) {
      events.push("ownership"); assert.deepEqual(args, ["fixture-session", "fixture-owner"]);
      return options.owned === false ? [] : [{ id: args[0] }];
    }
    if (/select prefs from ar_operator_prefs/.test(query)) {
      events.push("settings"); assert.deepEqual(args, ["fixture-owner"]);
      if (options.readError) throw Error("synthetic read unavailable");
      return options.absent ? [] : [{ prefs: "prefs" in options ? options.prefs : {} }];
    }
    if (/coalesce\(sum\(cost_usd\)/.test(query)) return [{ usd: 0 }];
    if (/SELECT role, content/.test(query)) {
      events.push("history"); assert.deepEqual(args, ["fixture-session", "fixture-owner"]);
      return options.empty ? [] : [{ role: "user", content: "Fixture packing notes." }];
    }
    if (/SELECT count\(\*\)/.test(query)) return [{ n: 1 }];
    if (/UPDATE buzzy_sessions/.test(query)) { events.push("write"); return []; }
    throw Error("unexpected fixture query");
  };
  const ctx = vm.createContext({
    URL, Date, console: { log() {}, warn() {}, error() {} },
    process: { env: { BZ_CHAT_BASE_URL: options.endpoint || remote,
      BZ_CHAT_MODEL: "fixture-chat", BZ_SUMMARY_MODEL: "fixture-summary" } },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, redirect: init.redirect, body });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Packing list." } }] }) };
    },
    getSessionUserFromHeaders: () => ({ id: "fixture-owner" }), getSql: async () => sql,
    headersFromEvent: () => ({}), setResponseStatus: (event, status) => { event.status = status; },
  });
  const module = (src, name) => new vm.SourceTextModule(src, { context: ctx, identifier: name });
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, val] of Object.entries(values)) this.setExport(key, val);
  }, { context: ctx });
  const transport = module(llm, "llm"), models = module(prefs, "modelPrefs"), selection = module(policy, "modelPolicy");
  const noDependency = spec => { throw Error("unexpected dependency " + spec); };
  await transport.link(noDependency); await transport.evaluate();
  await models.link(noDependency); await models.evaluate();
  const observedLlm = synthetic({
    chatCompletion: (messages, opts) => {
      completionOpts.push(plain(opts));
      return transport.namespace.chatCompletion(messages, opts);
    },
    getModels: transport.namespace.getModels,
  });
  const money = synthetic({ budgetVerdict: () => { throw Error("outside this fixture"); } });
  const deps = { "./llm": observedLlm, "./modelPolicy": selection, "./modelPrefs": models, "./money": money };
  const link = spec => deps[spec] ?? noDependency(spec);
  await selection.link(link); await selection.evaluate();
  const service = module(sessions, "sessions"); await service.link(link); await service.evaluate();
  ctx.summarizeSessionNow = service.namespace.summarizeSessionNow;
  const route = vm.runInContext("(async (event, path, method) => {" + handler + "})", ctx);
  const event = { status: 200 }, result = await route(event, "/api/buzzy/sessions/fixture-session/summary", "POST");
  return { events, requests, completionOpts, status: event.status, result: plain(result) };
}

for (const [name, options, status, code] of [
  ["local-only, remote endpoint", { prefs: { localOnly: true } }, 409, "summary_local_unavailable"],
  ["local-only, excluded provider", { prefs: { localOnly: true, provider: "retired" }, endpoint: loopback }, 409, "summary_local_unavailable"],
  ["malformed local-only preference", { prefs: { localOnly: "true" } }, 503, "summary_policy_unavailable"],
  ["settings unreadable", { readError: true }, 503, "summary_policy_unavailable"],
]) {
  test(name + ": policy refusal precedes transcript, model and writes", async () => {
    const r = await fixture(options);
    assert.equal(r.status, status); assert.equal(r.result.code, code);
    assert.deepEqual(r.events, ["ownership", "settings"]);
    assert.equal(r.requests.length, 0); assert.equal(r.completionOpts.length, 0);
  });
}
test("local-only uses the elected loopback model, guarded transport and no redirect", async () => {
  const r = await fixture({ prefs: { localOnly: true }, endpoint: loopback });
  assert.equal(r.status, 200); assert.equal(r.result.summary, "Packing list.");
  assert.deepEqual(r.events.slice(0, 3), ["ownership", "settings", "history"]);
  assert.equal(r.requests.length, 1); assert.equal(r.completionOpts[0].localOnly, true);
  assert.equal(r.requests[0].body.model, "fixture-chat"); assert.equal(r.requests[0].redirect, "error");
  assert.equal(r.requests[0].url, loopback + "/chat/completions"); assert.ok(r.events.includes("write"));
});
test("a stored non-object preference row refuses before transcript, model and writes", async () => {
  for (const malformed of [null, "fixture-stale-settings", false, 0, []]) {
    const r = await fixture({ prefs: malformed });
    assert.equal(r.status, 503); assert.equal(r.result.code, "summary_policy_unavailable");
    assert.deepEqual(r.events, ["ownership", "settings"]);
    assert.equal(r.requests.length, 0); assert.equal(r.completionOpts.length, 0);
  }
});
test("explicit false and absent preference keep the configured ordinary summary model", async () => {
  for (const opts of [{ prefs: { localOnly: false } }, { absent: true }]) {
    const r = await fixture(opts);
    assert.equal(r.status, 200); assert.equal(r.result.summary, "Packing list.");
    assert.equal(r.requests.length, 1); assert.equal(r.requests[0].body.model, "fixture-summary");
    assert.equal(r.requests[0].url, remote + "/chat/completions");
  }
});
test("ownership denial reads no preferences; empty session needs no inference", async () => {
  const foreign = await fixture({ owned: false }); assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.events, ["ownership"]); assert.equal(foreign.requests.length, 0);
  const empty = await fixture({ empty: true, prefs: { localOnly: true }, endpoint: loopback });
  assert.equal(empty.status, 200); assert.equal(empty.result.summary, null);
  assert.equal(empty.requests.length, 0); assert.ok(!empty.events.includes("write"));
});
test("Talk shows a policy refusal without claiming success or changing the old label", async () => {
  const denied = await fixture({ prefs: { localOnly: true } });
  const alerts = [], card = { id: "fixture-session", summary: "Existing label" };
  const ctx = vm.createContext({ SESSIONS_BASE: "/api/buzzy/sessions", alert: message => alerts.push(message),
    loadSessions: () => { assert.fail("refusal must not refresh the list"); },
    fetch: async () => ({ ok: false, status: denied.status, json: async () => denied.result }),
  });
  vm.runInContext(ui, ctx); await ctx.summarizeSession(card);
  assert.deepEqual(alerts, [denied.result.error]); assert.equal(card.summary, "Existing label");
});
