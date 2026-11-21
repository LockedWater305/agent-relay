#!/usr/bin/env node
/**
 * Actual chatLoop, saved prefs and lookup/dispatch policy with mocked providers/DB
 * (no network/deps, and every input is a synthetic fixture).
 * Does not establish offline mode or provider/Electron end-to-end parity.
 * Run: node --experimental-vm-modules --test scripts/test-local-runtime-inference-boundary.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../src/lib/buzzy/server.ts", import.meta.url), "utf8"));
const real = new Map([["./server", source]]);
for (const name of ["modelPrefs", "toolRegistry", "voiceTools"]) {
  real.set("./" + name, stripTypeScriptTypes(await readFile(new URL("../src/lib/buzzy/" + name + ".ts", import.meta.url), "utf8")));
}
const pure = {};
for (const name of ["intent", "context", "questions", "sanitizer", "calc"]) {
  pure[`./${name}`] = await import(new URL(`../src/lib/buzzy/${name}.ts`, import.meta.url));
}

async function harness(config = {}) {
  const calls = [];
  const sqlWrites = [];
  const summaryCalls = [];
  const toolEvents = [];
  const prefs = "rawPrefs" in config ? config.rawPrefs : { localOnly: config.localOnly ?? true };
  const sql = async (strings, ...values) => {
    const query = strings.join("?");
    sqlWrites.push(query);
    if (/select prefs from ar_operator_prefs/.test(query)) {
      assert.deepEqual(values, ["test-user"]);
      calls.push({ kind: "prefs" });
      if (config.prefsFailure) throw new Error("preferences unavailable");
      return [{ prefs }];
    }
    return [];
  };
  const replies = [...(config.replies ?? [])];
  const completion = () => ({
    content: "The result is four.", toolCalls: [], usage: null, latencyMs: 1,
    model: "local-model", finishReason: "stop", ...replies.shift(),
  });
  const recordCompletion = async (kind, messages, opts, onText) => {
    calls.push({ kind, messages, opts });
    if (kind === "extract") {
      if (config.extractFailure) throw new Error("local extraction unavailable");
      return "{}";
    }
    if (config.replyFailure) throw new Error("fixture model transport failure");
    const result = completion();
    onText?.(result.content);
    return result;
  };
  const schema = name => ({ type: "function", function: { name } });
  const syntheticPage = async () => {
    calls.push({ kind: "read_web_page" });
    return { ok: true, finalUrl: "https://fixture.example.invalid/", text: "Fixture result.", chars: 15 };
  };
  const deps = {
    ...pure,
    "@/lib/db": { getSql: async () => sql },
    "@/lib/runtime": { isLocalRuntime: () => true },
    "./llm": {
      resolveModel: (model) => model,
      chatCompletion: (messages, opts) => recordCompletion("extract", messages, opts),
      chatCompletionFull: (messages, opts) => recordCompletion("full", messages, opts),
      chatCompletionStream: (messages, opts, onText) => recordCompletion("stream", messages, opts, onText),
    },
    "./modelPolicy": { selectModel: (opts) => {
      calls.push({ kind: "policy", opts });
      return config.refused
        ? { refused: true, refusedReason: "no_local_models", reason: "No local models", model: "", phase: opts.phase }
        : { model: "local-model", label: "Local", reason: "Test selection", phase: opts.phase };
    } },
    "./memory": { DbMemory: class {
      async get_facts() { return []; }
      async remember() {}
    } },
    "./honcho": { ensurePeer: async () => {}, honchoAvailable: () => false },
    "./studio": { musicContextForAgent: async () => "" },
    "./music": { musicConfigured: () => false, GENERATE_MUSIC_TOOL: schema("generate_music") },
    "./art": { artConfigured: () => false },
    "./info": {
      shouldPlanFirst: () => false, PLAN_FIRST_INSTRUCTION: "",
      LOOKUP_MARKET_RATE_TOOL: schema("lookup_market_rate"), FETCH_WEBSITE_TOOL: schema("fetch_website"),
      SEARCH_KNOWLEDGE_TOOL: schema("search_knowledge"),
      fetchWebsitePage: async () => { calls.push({ kind: "fetch_website" }); return { ok: true, text: "Fixture result." }; },
      searchKnowledge: async () => { calls.push({ kind: "local_knowledge" }); return [{ label: "Fixture note" }]; },
    },
    "./search": {
      WEB_SEARCH_TOOL: schema("web_search"), searchAvailable: () => true,
      webSearch: async () => { calls.push({ kind: "web_search" }); return { ok: true, results: [] }; },
    },
    "./webpage": { READ_WEB_PAGE_TOOL: schema("read_web_page"), readWebPage: syntheticPage },
    "./playbooks": { playbookGuidance: () => "", playbookChecks: () => [] },
    "./voice": {
      voiceAvailable: () => true,
      VOICE_MODEL: "separate-audio-model",
      voiceCompletion: async (messages, opts) => {
        calls.push({ kind: "voice", messages, opts });
        return { text: "The result is four.", model: "separate-audio-model", totalMs: 1, ttftMs: 1, ttfaMs: 1 };
      },
    },
    "./sessions": { touchSession: async () => {}, maybeSummarizeSession: async (...args) => { summaryCalls.push(args); } },
    "./toolTelemetry": { recordToolCall: async (_sql, event) => { toolEvents.push(event); } },
    "./artifact": {
      parseToolArguments: JSON.parse, RENDER_DOCUMENT_TOOL: schema("render_document"),
      RENDER_PRESENTATION_TOOL: schema("render_presentation"), RENDER_SHEET_TOOL: schema("render_sheet"),
    },
  };
  const context = vm.createContext({
    process: { env: { BZ_EXTRACT_MODEL: "cloud-fast-model" } },
    console: { log() {}, warn() {}, error() {} },
    // Extraction resolves immediately in these tests; do not hold the test
    // process open for the losing time-budget promise.
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    clearTimeout,
  });
  const modules = new Map([...real].map(([id, text]) => [id, new vm.SourceTextModule(text, { context, identifier: id })]));
  const module = modules.get("./server");
  const link = (specifier, importer) => {
    if (modules.has(specifier)) return modules.get(specifier);
    const declaration = [...real.get(importer.identifier).matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
      .find((match) => match[2] === specifier);
    assert.ok(declaration, `named imports required for ${specifier}`);
    const exports = declaration[1].split(",").map((name) => name.trim()).filter(Boolean);
    return new vm.SyntheticModule(exports, function () {
      for (const name of exports) {
        const value = deps[specifier]?.[name] ?? (() => { throw new Error(`Unmocked call: ${specifier}.${name}`); });
        this.setExport(name, value);
      }
    }, { context });
  };
  // Observe entry to the real pre-pass separately from a transport helper. A
  // voice turn without lookup intent must not enter the pre-pass in Local Only.
  const lookup = modules.get("./voiceTools");
  await lookup.link(link);
  await lookup.evaluate();
  modules.set("./voiceTools", new vm.SyntheticModule(["needsWebLookup", "buildVoiceWebContext"], function () {
    this.setExport("needsWebLookup", lookup.namespace.needsWebLookup);
    this.setExport("buildVoiceWebContext", (...args) => {
      calls.push({ kind: "lookup_helper" });
      return lookup.namespace.buildVoiceWebContext(...args);
    });
  }, { context }));
  await module.link(link);
  await module.evaluate();
  const request = {
    userId: "test-user", sessionId: "test-session", jobId: null,
    message: "Explain the number four.", mode: "chat", ...config.request,
  };
  const result = await module.namespace.chatLoop(request);
  return { result, calls, sqlWrites, summaryCalls, toolEvents, toolRegistry: modules.get("./toolRegistry").namespace };
}

function modelCalls(calls) {
  return calls.filter((call) => ["extract", "full", "stream", "voice"].includes(call.kind));
}
function assertConstrained(calls) {
  const inference = modelCalls(calls);
  assert.ok(inference.length > 0);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.kind), ["prefs", "policy"]);
  for (const call of inference) {
    assert.equal(call.opts.localOnly, true, `${call.kind} must enforce localOnly`);
    assert.equal(call.opts.model, "local-model", `${call.kind} must use the eligible model`);
  }
}

test("model refusal happens before extraction or any reply inference", async () => {
  const { result, calls, sqlWrites } = await harness({ refused: true });
  assert.equal(result.code, "no_local_models");
  assert.equal(modelCalls(calls).length, 0);
  assert.ok(sqlWrites.some((text) => /INSERT INTO buzzy_chat_messages/.test(text) && /'user'/.test(text)), "refused user turn stays in transcript");
});

test("unreadable model preferences fail closed before inference", async () => {
  const { result, calls } = await harness({ prefsFailure: true });
  assert.equal(result.code, "model_policy_error");
  assert.equal(modelCalls(calls).length, 0);
});

test("buffered local-only turn constrains extraction and main reply; skips unconstrained summaries", async () => {
  const { result, calls, summaryCalls } = await harness();
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.deepEqual(modelCalls(calls).map((call) => call.kind), ["extract", "full"]);
  assert.equal(summaryCalls.length, 0);
});

test("streaming local-only turn propagates the boundary", async () => {
  const { result, calls } = await harness({ request: { onText() {} } });
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.deepEqual(modelCalls(calls).map((call) => call.kind), ["extract", "stream"]);
});

test("tool follow-up and prose repair retain the local-only constraint", async () => {
  const { result, calls } = await harness({ replies: [
    { content: "", toolCalls: [{ id: "tool-1", name: "calculate", arguments: '{"expression":"2+2"}' }] },
    { content: "read_web_page: https://example.invalid/result" },
    { content: "The result is four." },
  ] });
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.deepEqual(modelCalls(calls).map((call) => call.kind), ["extract", "full", "full", "full"]);
});

test("failed local extraction never retries the cloud fast model", async () => {
  const { result, calls } = await harness({ extractFailure: true });
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.equal(calls.filter((call) => call.kind === "extract").length, 1);
});

test("local-only voice request uses text without separate voice or readout inference", async () => {
  const { result, calls } = await harness({ request: { surface: "voice", speech: { onAudio() {} } } });
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.equal(result.timings.lane, "text");
  assert.equal(calls.filter((call) => call.kind === "voice").length, 0);
});

test("ordinary hosted turns retain fast extraction and background summaries", async () => {
  const { result, calls, summaryCalls } = await harness({ localOnly: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.find((call) => call.kind === "extract").opts.model, "cloud-fast-model");
  for (const call of modelCalls(calls)) assert.equal(call.opts.localOnly, false);
  assert.equal(summaryCalls.length, 1);
});

test("ordinary hosted voice lane remains available", async () => {
  const { result, calls } = await harness({ localOnly: false, request: { surface: "voice", speech: { onAudio() {} } } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.timings.lane, "audio");
  assert.equal(calls.filter((call) => call.kind === "voice").length, 1);
});

const online = new Set(["web_search", "read_web_page", "fetch_website"]);
const onlineCalls = calls => calls.filter(call => online.has(call.kind)).map(call => call.kind);
const benignNote = "Turn today’s packing notes into three bullets.";
const benignLink = "Review the handout at https://fixture.example.invalid/ for me.";
const tool = (name, args) => ({ id: "test-" + name, name, arguments: JSON.stringify(args) });

test("saved Local Only prevents automatic lookup for ordinary text and voice; no false notice", async () => {
  for (const message of [benignNote, benignLink, "Explain how to pack a box."]) {
    for (const surface of ["text", "voice"]) {
      const { result, calls } = await harness({ request: { message, surface, localOnly: false, onText() {} } });
      assert.equal(result.ok, true, result.error);
      assertConstrained(calls);
      assert.deepEqual(onlineCalls(calls), []);
      assert.ok(!calls.some(call => call.kind === "lookup_helper"));
      assert.equal(result.onlineLookupSkipped, message === benignNote || message === benignLink ? true : undefined);
      assert.match(modelCalls(calls).at(-1).messages[0].content, /Live web lookup is off/);
      assert.doesNotMatch(modelCalls(calls).at(-1).messages[0].content, /you can search the live web/);
      if (result.onlineLookupSkipped) assert.ok(!calls.some(call => call.kind === "stream"));
    }
  }
});

test("ordinary mode retains automatic search and page reads", async () => {
  for (const [message, expected] of [[benignNote, "web_search"], [benignLink, "read_web_page"]]) {
    const { result, calls } = await harness({ localOnly: false, request: { message } });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls.filter(call => call.kind === "lookup_helper").length, 1);
    assert.deepEqual(onlineCalls(calls), [expected]);
    assert.equal(result.onlineLookupSkipped, undefined);
    assert.match(modelCalls(calls).at(-1).messages[0].content, /you can search the live web/);
  }
});

test("an invalid saved preference row refuses the turn instead of unlocking lookup", async () => {
  const { result, calls } = await harness({ rawPrefs: null, request: { message: benignNote } });
  assert.equal(result.code, "model_policy_error");
  assert.deepEqual(calls.map(call => call.kind), ["prefs"]);
});

test("Local Only withholds online schemas and refuses calls before dispatch while local tools still run", async () => {
  const replies = [{ toolCalls: [
    tool("web_search", { query: "fixture packing notes" }),
    tool("read_web_page", { url: "https://fixture.example.invalid/" }),
    tool("fetch_website", { url: "https://fixture.example.invalid/" }),
    tool("calculate", { expression: "2+2" }),
    tool("search_knowledge", { query: "fixture note" }),
  ] }];
  const { result, calls, toolEvents, toolRegistry } = await harness({ replies });
  assert.equal(result.ok, true, result.error);
  assertConstrained(calls);
  assert.deepEqual(onlineCalls(calls), []);
  assert.equal(result.onlineLookupSkipped, true);
  const gated = [...toolRegistry.offeredToolNames({ draftGateOpen: true, localOnly: true })];
  const localSchemas = [...toolRegistry.offeredTools({ draftGateOpen: true, localOnly: true })].map(spec => spec.function.name);
  assert.deepEqual(localSchemas, gated);
  assert.ok(!gated.some(name => online.has(name)));
  assert.ok(gated.includes("calculate") && gated.includes("search_knowledge") && gated.includes("render_document"));
  const ordinary = [...toolRegistry.offeredToolNames({ draftGateOpen: true, localOnly: false })];
  assert.ok(ordinary.includes("web_search") && ordinary.includes("read_web_page") && !ordinary.includes("fetch_website"));
  assert.deepEqual(toolEvents.filter(event => online.has(event.tool)).map(event => event.errorCode), ["local_only", "local_only", "local_only"]);
  const followup = modelCalls(calls).at(-1).messages.map(item => item.content).join("\n");
  assert.match(followup, /Online lookup was skipped because Local Only is on/);
  assert.match(followup, /calculate result.*= 4/);
  assert.match(followup, /search_knowledge found/);
  assert.equal(calls.filter(call => call.kind === "local_knowledge").length, 1);
});

test("ordinary mode retains model-requested online dispatch", async () => {
  const replies = [{ toolCalls: [
    tool("web_search", { query: "fixture packing notes" }),
    tool("read_web_page", { url: "https://fixture.example.invalid/" }),
  ] }];
  const { result, calls } = await harness({ localOnly: false, replies });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(onlineCalls(calls), ["web_search", "read_web_page"]);
  assert.equal(result.onlineLookupSkipped, undefined);
});

test("a local model refusal or failure retains the lookup notice and stable copy", async () => {
  for (const [config, code, copy] of [
    [{ refused: true }, "no_local_models", /couldn't use a local model/],
    [{ replyFailure: true }, "llm_error", /local model couldn't finish/],
  ]) {
    const { result, calls } = await harness({ ...config, request: { message: benignNote, onText() {} } });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.onlineLookupSkipped, true);
    assert.match(result.reply, copy);
    assert.doesNotMatch(result.error, /fixture model transport failure|gathered the sources/i);
    assert.deepEqual(onlineCalls(calls), []);
    assert.ok(!calls.some(call => call.kind === "lookup_helper" || call.kind === "stream"));
  }
});

test("a denied structured lookup gets a notice without an English keyword; two echoes never claim sources", async () => {
  const message = "¿Puedes consultar el horario de hoy?";
  const opts = { request: { message, mode: "work" } };
  const before = await harness(opts);
  assert.equal(before.result.onlineLookupSkipped, undefined);
  const echo = { content: "read_web_page: https://fixture.example.invalid/" };
  const { result, calls, sqlWrites, toolEvents } = await harness({ ...opts, replies: [
    { toolCalls: [tool("web_search", { query: "horarios de ejemplo" })] }, echo, echo,
  ] });
  assert.equal(result.code, "empty_reply");
  assert.equal(result.onlineLookupSkipped, true);
  assert.match(result.reply, /couldn't turn that response into an answer/);
  assert.doesNotMatch(result.reply + result.error, /gathered|ran an online lookup|searched/i);
  assert.deepEqual(onlineCalls(calls), []);
  assert.deepEqual(toolEvents.map(event => event.errorCode), ["local_only"]);
  assert.ok(!sqlWrites.some(sql => /INSERT INTO buzzy_chat_messages/.test(sql) && /'assistant'/.test(sql)));
  const completions = modelCalls(calls);
  assert.doesNotMatch(completions[1].messages[0].content, /you can search the live web/);
  assert.match(completions.at(-1).messages.at(-1).content, /no online lookup ran/);
});

test("Talk renders the server-owned lookup notice before assistant prose", async () => {
  const html = await readFile(new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
  const start = html.indexOf("    function renderChatMessages() {");
  const stop = html.indexOf("      // BZ-F011: expert handoff suggestion", start);
  assert.ok(start >= 0 && stop > start);
  const node = { innerHTML: "" };
  const state = { messages: [] };
  const render = vm.runInNewContext(html.slice(start, stop) + "\n}\nrenderChatMessages", {
    document: { getElementById: () => node }, chatState: state,
  });
  state.messages = [{ role: "assistant", content: "Fixture answer.", onlineLookupSkipped: true }];
  render();
  assert.match(node.innerHTML, /role="status">Online lookup skipped because Local Only is on\.<\/div>.*Fixture answer/s);
  state.messages[0].onlineLookupSkipped = "true";
  render();
  assert.doesNotMatch(node.innerHTML, /Online lookup skipped/);
  assert.match(html, /onlineLookupSkipped: data\.onlineLookupSkipped === true/);
});

test("Talk renders model-policy no-send copy and local lookup failure instead of raw errors", async () => {
  const html = await readFile(new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
  const send = html.indexOf("    async function sendChatMessage(");
  const start = html.indexOf("        if (!data.ok) {", send);
  const stop = html.indexOf("        // Hide error if present", start);
  assert.ok(send >= 0 && start > send && stop > start);
  for (const cfg of [{ prefsFailure: true }, { replyFailure: true }]) {
    const { result } = await harness({ ...cfg, request: { message: benignNote } });
    const display = { textContent: "old warning", classList: { toggle: (key, show) => { display[key] = show; } } };
    const state = { messages: [] };
    const render = vm.runInNewContext("(function (data) {" + html.slice(start, stop) + "})", {
      document: { getElementById: () => display }, chatState: state, setChatMascot() {}, paintContext() {}, renderChatMessages() {},
      // This fixture evaluates only the failure branch, not the full sender.
      // Provide its same-mounted-owner bindings; the full shell race runs separately.
      owner: undefined, canPaint: () => true, notice: display, send: display,
    });
    render(result);
    assert.equal(state.messages[0].content, result.reply);
    if (cfg.prefsFailure) assert.match(state.messages[0].content, /Nothing was sent to an inference provider/);
    assert.equal(state.messages[0].onlineLookupSkipped, cfg.replyFailure === true);
    assert.equal(display.textContent, "");
    assert.equal(display.hidden, true);
  }
});
