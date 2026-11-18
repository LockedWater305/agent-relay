/**
 * Inference endpoint privacy regressions. Requires Node 22.18+ / 24 for built-in
 * TypeScript stripping; no package install, provider key, or internet required.
 * Run: node --test scripts/test-llm-boundary.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

let nextModule = 0;
const messages = [{ role: "user", content: "Private test prompt" }];
const completion = {
  model: "test-model",
  choices: [{ message: { content: "Test answer" }, finish_reason: "stop" }],
};
const stream = [
  'data: {"model":"test-model","choices":[{"delta":{"content":"Test answer"},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

async function loadLlm(baseUrl, models = [{ label: "Test", model: "test-model" }]) {
  const config = {
    BZ_CHAT_BASE_URL: baseUrl,
    BZ_CHAT_KEY: "test-only-key",
    BZ_CHAT_MODEL: "test-model",
    BZ_CHAT_MODELS: JSON.stringify(models),
  };
  const previous = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, config);
    const url = new URL("../src/lib/buzzy/llm.ts", import.meta.url);
    url.searchParams.set("boundary-test", String(nextModule++));
    const llm = await import(url.href);
    llm.getModels(); // Initialise the memoised catalog while this config is set.
    return llm;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("locality uses the parsed, exact HTTP(S) loopback host", async () => {
  const { isLoopbackModelEndpoint } = await loadLlm("https://cloud.example/v1");
  for (const url of [
    "http://localhost:11434/v1",
    "https://LOCALHOST/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.42.1.2/v1",
    "http://127.1/v1", // URL canonicalisation still sends to 127.0.0.1.
    "http://2130706433/v1",
    "http://[::1]:11434/v1",
    "https://[0:0:0:0:0:0:0:1]/v1",
  ]) {
    assert.equal(isLoopbackModelEndpoint(url), true, url);
  }
  for (const url of [
    "http://localhost.evil.example/v1",
    "https://localhost-evil.example/v1",
    "http://localhost%2eevil.example/v1",
    "http://127.0.0.1.evil.example/v1",
    "http://127.0.0.1@evil.example/v1",
    "http://localhost@evil.example/v1",
    "https://evil.example/v1?host=localhost",
    "https://evil.example/#http://127.0.0.1",
    "http://0.0.0.0:11434/v1",
    "http://host.docker.internal:11434/v1",
    "http://192.168.1.2/v1",
    "http://[::]/v1",
    "http://[::2]/v1",
    "http://localhost./v1",
    "http://user:password@localhost/v1",
    "ftp://localhost/v1",
    "file:///localhost/v1",
    "localhost:11434/v1",
    "//localhost/v1",
    "http://127.256.0.1/v1",
    "not a URL",
    "",
  ]) {
    assert.equal(isLoopbackModelEndpoint(url), false, url);
  }
});

test("catalog metadata cannot label any remote endpoint as local", async () => {
  for (const baseUrl of [
    "https://cloud.example/v1",
    "http://localhost.evil.example/v1",
    "http://127.0.0.1@evil.example/v1",
    "http://0.0.0.0/v1",
    "http://host.docker.internal/v1",
  ]) {
    const llm = await loadLlm(baseUrl, [
      { label: "Claimed local", model: "a", local: true, provider: "local" },
      { label: "Unspecified", model: "b" },
      { label: "Cloud", model: "c", local: false, provider: "advocate" },
    ]);
    assert.equal(llm.CATALOG_IS_LOCAL, false, baseUrl);
    assert.deepEqual(llm.getModels().map((entry) => entry.local), [false, false, false], baseUrl);
    assert.equal(llm.resolveModel("Cloud"), "c");
    assert.equal(llm.getModels()[2].provider, "advocate");
  }
});

test("loopback catalog defaults local but respects an explicit opt-out", async () => {
  const llm = await loadLlm("http://127.0.0.1:11434/v1", [
    { label: "Unspecified", model: "a" },
    { label: "Local", model: "b", local: true },
    { label: "Not local", model: "c", local: false },
    { label: "Invalid boolean", model: "d", local: "true" },
  ]);
  assert.equal(llm.CATALOG_IS_LOCAL, true);
  assert.equal(llm.CATALOG_DEFAULT_PROVIDER, "local");
  assert.deepEqual(llm.getModels().map((entry) => entry.local), [true, true, false, false]);
});

test("explicit local-only calls reject a remote endpoint before any fetch", async (t) => {
  const llm = await loadLlm("https://cloud.example/v1", [
    { label: "Claimed local", model: "test-model", local: true },
  ]);
  // Even a synthetic policy catalog cannot bypass the transport boundary.
  llm.__resetModelCatalogForTests([{ label: "Synthetic", model: "test-model", local: true }]);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  await assert.rejects(llm.chatCompletionFull(messages, { localOnly: true }), /nothing was sent/);
  await assert.rejects(llm.chatCompletion(messages, { localOnly: true }), /nothing was sent/);
  await assert.rejects(llm.chatCompletionStream(messages, { localOnly: true }, () => {}), /nothing was sent/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("configured remote / Advocate inference remains available with normal redirects", async (t) => {
  const llm = await loadLlm("https://advocate.example/custom/v1", [
    { label: "Advocate", model: "test-model", provider: "advocate" },
  ]);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return JSON.parse(init.body).stream
      ? new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      : Response.json(completion);
  });
  assert.equal((await llm.chatCompletionFull(messages, { model: "test-model" })).content, "Test answer");
  assert.equal(await llm.chatCompletion(messages, { localOnly: false }), "Test answer");
  const deltas = [];
  assert.equal((await llm.chatCompletionStream(messages, undefined, (delta) => deltas.push(delta))).content, "Test answer");
  assert.deepEqual(deltas, ["Test answer"]);
  assert.equal(requests.length, 3);
  for (const { url, init } of requests) {
    assert.equal(String(url), "https://advocate.example/custom/v1/chat/completions");
    assert.equal(init.redirect, "follow");
    assert.equal(init.headers.Authorization, "Bearer test-only-key");
    assert.deepEqual(JSON.parse(init.body).messages, messages);
    assert.equal(JSON.parse(init.body).model, "test-model");
    assert.equal("localOnly" in JSON.parse(init.body), false);
  }
});

test("buffered and streaming loopback calls disable redirects even without caller options", async (t) => {
  const llm = await loadLlm("http://127.0.0.1:11434/v1");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return JSON.parse(init.body).stream ? new Response(stream) : Response.json(completion);
  });
  await llm.chatCompletionFull(messages);
  await llm.chatCompletion(messages, { localOnly: true });
  await llm.chatCompletionStream(messages, undefined, () => {});
  await llm.chatCompletionStream(messages, { localOnly: true }, () => {});
  assert.equal(requests.length, 4);
  for (const { url, init } of requests) {
    assert.equal(String(url), "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(init.redirect, "error");
  }
});

async function listen(t, listener) {
  const server = createServer(listener);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("real fetch never forwards a local prompt to any redirect destination", async (t) => {
  let destinationRequests = 0;
  const destination = await listen(t, (req, res) => {
    destinationRequests++;
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(completion));
  });
  let sourceRequests = 0;
  const source = await listen(t, (req, res) => {
    sourceRequests++;
    req.resume();
    const status = Number(req.url.match(/^\/redirect-(\d+)\//)?.[1]);
    res.writeHead(status, { Location: `${destination}/cloud-proxy` });
    res.end();
  });
  // Both hosts are test-only loopback servers: no internet is used. Blocking
  // every redirect also prevents a real remote destination receiving a prompt.
  for (const status of [301, 302, 303, 307, 308]) {
    const llm = await loadLlm(`${source}/redirect-${status}/v1`);
    await assert.rejects(llm.chatCompletionFull(messages, { localOnly: true }), /fetch failed|redirect/i);
    await assert.rejects(llm.chatCompletionStream(messages, { localOnly: true }, () => {}), /fetch failed|redirect/i);
  }
  assert.equal(sourceRequests, 15); // Buffered calls retain their one retry.
  assert.equal(destinationRequests, 0);
});
