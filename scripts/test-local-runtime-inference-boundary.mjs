#!/usr/bin/env node
/**
 * Actual chatLoop caller wiring with mocked providers/DB (no network/deps).
 * Does not establish offline mode or provider/Electron end-to-end parity.
 * Run: node --experimental-vm-modules --test scripts/test-local-runtime-inference-boundary.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../src/lib/buzzy/server.ts", import.meta.url), "utf8"));
const pure = {};
for (const name of ["intent", "context", "questions", "sanitizer", "calc"]) {
  pure[`./${name}`] = await import(new URL(`../src/lib/buzzy/${name}.ts`, import.meta.url));
}

async function harness(config = {}) {
  const calls = [];
  const sqlWrites = [];
  const summaryCalls = [];
  const prefs = { preference: "value", preferenceSource: "stored", spentCents: 0, localOnly: config.localOnly ?? true };
  const sql = async (strings) => {
    sqlWrites.push(strings.join("?"));
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
    const result = completion();
    onText?.(result.content);
    return result;
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
    "./modelPrefs": { readModelPrefs: async () => {
      calls.push({ kind: "prefs" });
      if (config.prefsFailure) throw new Error("preferences unavailable");
      return prefs;
    } },
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
    "./music": { musicConfigured: () => false },
    "./art": { artConfigured: () => false },
    "./info": { shouldPlanFirst: () => false, PLAN_FIRST_INSTRUCTION: "" },
    "./playbooks": { playbookGuidance: () => "", playbookChecks: () => [] },
    "./voiceTools": { needsWebLookup: () => false, buildVoiceWebContext: async () => ({ calls: [], block: "" }) },
    "./voice": {
      voiceAvailable: () => true,
      VOICE_MODEL: "separate-audio-model",
      voiceCompletion: async (messages, opts) => {
        calls.push({ kind: "voice", messages, opts });
        return { text: "The result is four.", model: "separate-audio-model", totalMs: 1, ttftMs: 1, ttfaMs: 1 };
      },
    },
    "./sessions": { touchSession: async () => {}, maybeSummarizeSession: async (...args) => { summaryCalls.push(args); } },
    "./toolRegistry": {
      offeredTools: () => [],
      refusalFor: () => null,
      policyFor: () => ({ gate: "always" }),
      withToolBudget: async (_name, callback) => ({ ok: true, value: await callback(), ms: 1 }),
    },
    "./toolTelemetry": { recordToolCall: async () => {} },
    "./artifact": { parseToolArguments: JSON.parse },
  };
  const context = vm.createContext({
    process: { env: { BZ_EXTRACT_MODEL: "cloud-fast-model" } },
    console: { log() {}, warn() {}, error() {} },
    // Extraction resolves immediately in these tests; do not hold the test
    // process open for the losing time-budget promise.
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const declaration = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
      .find((match) => match[2] === specifier);
    assert.ok(declaration, `named imports required for ${specifier}`);
    const exports = declaration[1].split(",").map((name) => name.trim()).filter(Boolean);
    return new vm.SyntheticModule(exports, function () {
      for (const name of exports) {
        const value = deps[specifier]?.[name] ?? (() => { throw new Error(`Unmocked call: ${specifier}.${name}`); });
        this.setExport(name, value);
      }
    }, { context });
  });
  await module.evaluate();
  const request = {
    userId: "test-user", sessionId: "test-session", jobId: null,
    message: "Explain the number four.", mode: "chat", ...config.request,
  };
  const result = await module.namespace.chatLoop(request);
  return { result, calls, sqlWrites, summaryCalls };
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
