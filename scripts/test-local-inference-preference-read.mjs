#!/usr/bin/env node
/**
 * Stored local-only preferences through the real chat loop, model policy and
 * LLM request construction. DB, providers and other services are in-memory
 * mocks: no sockets, process lifecycle, real credentials or settings writes.
 * Run directly (no test-runner child):
 * node --experimental-vm-modules scripts/test-local-inference-preference-read.mjs
 * An optional source root allows the same assertions to test a pre-fix tree.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = process.argv[2] || fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const realModules = new Set([
  "server", "modelPrefs", "modelPolicy", "llm", "intent", "context", "questions", "sanitizer", "calc",
]);
const sources = new Map();
for (const name of realModules) {
  const source = await readFile(resolve(root, `src/lib/buzzy/${name}.ts`), "utf8");
  sources.set(name, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}

async function harness({ prefs = {}, missingRow = false, endpoint = "https://cloud.example.invalid/v1", stream = false } = {}) {
  const requests = [], queries = [], auxiliary = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?");
    queries.push({ query, values });
    if (/select prefs from ar_operator_prefs/.test(query)) {
      assert.equal(values[0], "fixture-user", "preferences stay scoped to the turn owner");
      return missingRow ? [] : [{ prefs }];
    }
    if (/coalesce\(sum\(cost_usd\)/.test(query)) return [{ usd: 0 }];
    return [];
  };
  const context = vm.createContext({
    process: { env: {
      BZ_CHAT_BASE_URL: endpoint,
      BZ_CHAT_KEY: "synthetic-key-never-sent",
      BZ_CHAT_MODEL: "fixture-model",
      BZ_EXTRACT_MODEL: "fixture-fast-model",
      // Deliberately untrusted catalog metadata: locality comes from the URL.
      BZ_CHAT_MODELS: JSON.stringify([{ label: "Fixture", model: "fixture-model", local: true }]),
    } },
    URL, TextDecoder, Date, console: { log() {}, warn() {}, error() {} },
    // Extractor time budgets never retain the process; no real lifecycle work.
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), redirect: init.redirect, body });
      const content = body.max_tokens === 200 ? "{}" : "The number four is even.";
      if (body.stream) {
        return new Response(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: "stop" }] }));
    },
  });
  const deps = {
    "@/lib/db": { getSql: async () => sql },
    "@/lib/runtime": { isLocalRuntime: () => true },
    "./money": { budgetVerdict() { throw new Error("Budget is outside this fixture"); } },
    "./memory": { DbMemory: class { async get_facts() { return []; } async remember() {} } },
    "./honcho": { ensurePeer: async () => {}, honchoAvailable: () => false },
    "./studio": { musicContextForAgent: async () => "" },
    "./music": { musicConfigured: () => false },
    "./art": { artConfigured: () => false },
    "./info": { shouldPlanFirst: () => false, PLAN_FIRST_INSTRUCTION: "" },
    "./playbooks": { playbookGuidance: () => "", playbookChecks: () => [] },
    "./voiceTools": { needsWebLookup: () => false, buildVoiceWebContext: async () => ({ calls: [], block: "" }) },
    "./voice": {
      voiceAvailable: () => true, VOICE_MODEL: "fixture-voice-model",
      voiceCompletion: async () => { auxiliary.push("voice"); throw new Error("Unexpected voice route"); },
    },
    "./sessions": { touchSession: async () => {}, maybeSummarizeSession: async () => { auxiliary.push("summary"); } },
    "./toolRegistry": {
      offeredTools: () => [], refusalFor: () => null,
      policyFor: () => ({ gate: "always" }),
      withToolBudget: async (_name, callback) => ({ ok: true, value: await callback(), ms: 1 }),
    },
    "./toolTelemetry": { recordToolCall: async () => {} },
    "./artifact": { parseToolArguments: JSON.parse },
  };
  const modules = new Map();
  function sourceModule(name) {
    if (!modules.has(name)) modules.set(name, new vm.SourceTextModule(sources.get(name), { context, identifier: name }));
    return modules.get(name);
  }
  const entry = sourceModule("server");
  await entry.link((specifier, importer) => {
    const name = specifier.replace(/^\.\//, "");
    if (realModules.has(name)) return sourceModule(name);
    const declaration = [...sources.get(importer.identifier).matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
      .find((match) => match[2] === specifier);
    assert.ok(declaration, `mock requires a named import: ${specifier}`);
    const exports = declaration[1].split(",").map((item) => item.trim()).filter(Boolean);
    return new vm.SyntheticModule(exports, function () {
      for (const exported of exports) {
        this.setExport(exported, deps[specifier]?.[exported] ?? (() => { throw new Error(`Unmocked call: ${specifier}.${exported}`); }));
      }
    }, { context });
  });
  await entry.evaluate();
  const result = await entry.namespace.chatLoop({
    userId: "fixture-user", sessionId: "fixture-session", jobId: null,
    message: "Explain the number four.", mode: "chat",
    ...(stream ? { onText() {} } : {}),
  });
  return { result, requests, queries, auxiliary };
}

for (const [label, value] of [
  ["string true", "true"], ["string false", "false"], ["number one", 1],
  ["number zero", 0], ["null", null], ["empty string", ""], ["object", {}], ["array", []],
]) {
  test(`malformed stored localOnly (${label}) refuses before all inference`, async () => {
    const actual = await harness({ prefs: { localOnly: value } });
    assert.equal(actual.result.code, "model_policy_error");
    assert.match(actual.result.error, /local-only preference is invalid/);
    assert.match(actual.result.reply, /Nothing was sent/);
    assert.equal(actual.requests.length, 0);
    assert.deepEqual(actual.auxiliary, []);
    assert.ok(actual.queries.some(({ query }) => /INSERT INTO buzzy_chat_messages/.test(query)), "the refused user turn is retained");
  });
}

test("absent localOnly and explicit false preserve ordinary configured routing", async () => {
  for (const options of [{ missingRow: true }, { prefs: {} }, { prefs: { localOnly: false } }]) {
    const actual = await harness(options);
    assert.equal(actual.result.ok, true, actual.result.error);
    assert.ok(actual.requests.length >= 2);
    assert.ok(actual.requests.every((request) => request.url === "https://cloud.example.invalid/v1/chat/completions"));
    assert.equal(actual.requests[0].body.model, "fixture-fast-model");
  }
});

test("valid local-only preference refuses remote routing despite claimed local metadata", async () => {
  const actual = await harness({ prefs: { localOnly: true } });
  assert.equal(actual.result.code, "no_local_models");
  assert.equal(actual.requests.length, 0);
  assert.deepEqual(actual.auxiliary, []);
});

test("saved local-only preference reaches buffered and streaming loopback requests", async () => {
  for (const stream of [false, true]) {
    const actual = await harness({ prefs: { localOnly: true }, endpoint: "http://127.0.0.1:11434/v1", stream });
    assert.equal(actual.result.ok, true, actual.result.error);
    assert.ok(actual.requests.length >= 2);
    for (const request of actual.requests) {
      assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
      assert.equal(request.body.model, "fixture-model");
      assert.equal(request.redirect, "error");
    }
    assert.deepEqual(actual.auxiliary, []);
  }
});

test("an unsupported saved provider refuses instead of selecting the loopback default", async () => {
  const actual = await harness({ prefs: { localOnly: true, provider: "retired-provider" }, endpoint: "http://127.0.0.1:11434/v1" });
  assert.equal(actual.result.code, "unknown_provider");
  assert.equal(actual.requests.length, 0);
});

test("ambiguous endpoint authorities cannot satisfy the saved local-only preference", async () => {
  for (const endpoint of [
    "https://localhost.example.invalid/v1", "http://localhost@cloud.example.invalid/v1",
    "http://user:password@localhost/v1", "http://0.0.0.0/v1", "file:///localhost/v1",
  ]) {
    const actual = await harness({ prefs: { localOnly: true }, endpoint });
    assert.equal(actual.result.code, "no_local_models", endpoint);
    assert.equal(actual.requests.length, 0, endpoint);
  }
});
