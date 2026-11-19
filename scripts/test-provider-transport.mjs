// Offline invariants only. No DNS, sockets, provider keys, or real destinations.
// Node >=22.18 (native TypeScript stripping); run: node --test scripts/test-provider-transport.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { cleanBaseUrl, isPrivateHost, postProviderJson } from "../src/lib/buzzy/providerTransport.ts";

process.env.BZ_CHAT_BASE_URL = "https://deployment.example/v1";
delete process.env.BZ_ALLOW_LOCAL_AI_KEY_URL;
const publicV4 = { address: "8.8.8.8", family: 4 };
const publicV6 = { address: "2606:4700::1111", family: 6 };

function harness({ addresses = [publicV4], status = 200, headers = {}, data = '{"ok":true}' } = {}) {
  const calls = [], lookups = [];
  let response;
  const resolve = async (host) => { lookups.push(host); return addresses; };
  const request = (url, opts, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (err) => { if (err) req.emit("error", err); };
    req.end = (body) => {
      calls.push({ url, opts, body });
      response = Readable.from([Buffer.from(data)]);
      response.statusCode = status;
      response.headers = headers;
      queueMicrotask(() => callback(response));
    };
    return req;
  };
  return { calls, lookups, deps: { resolve, http: request, https: request }, get response() { return response; } };
}
const post = (h, url = "https://provider.example/v1/chat/completions") =>
  postProviderJson(url, "test-only-key-not-real", '{"messages":[]}', h.deps);
function pinned(fn, name, options) {
  return new Promise((resolve, reject) => fn(name, options, (err, address, family) =>
    err ? reject(err) : resolve({ address, family })));
}

test("normalizes mapped/expanded IPv6 before applying private classification", () => {
  for (const host of ["::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:a00:1", "0:0:0:0:0:0:0:1", "fd00::1", "ff02::1"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.equal(isPrivateHost("::ffff:808:808"), false);
  assert.equal(isPrivateHost(publicV6.address), false);
});

test("local opt-in matches the entire deployment host, not a prefix", () => {
  const prior = process.env.BZ_CHAT_BASE_URL;
  try {
    process.env.BZ_CHAT_BASE_URL = "https://localhost.example/v1";
    assert.equal(cleanBaseUrl("http://127.0.0.1/v1"), null);
    process.env.BZ_CHAT_BASE_URL = "http://[::1]:8000/v1";
    assert.equal(cleanBaseUrl("http://[::1]:8000/v1"), "http://[::1]:8000/v1");
  } finally { process.env.BZ_CHAT_BASE_URL = prior; }
});

test("fails closed for empty, mixed-private, and malformed resolver answers", async () => {
  for (const addresses of [[], [publicV4, { address: "10.0.0.1", family: 4 }], [{ address: "not-an-ip", family: 4 }], [{ ...publicV4, family: 6 }]]) {
    const h = harness({ addresses });
    await assert.rejects(post(h), /allowed address/);
    assert.equal(h.calls.length, 0);
  }
});

test("DNS failure cannot fall back to a second transport", async () => {
  const h = harness();
  h.deps.resolve = async () => { throw new Error("mock DNS unavailable"); };
  await assert.rejects(post(h), /mock DNS unavailable/);
  assert.equal(h.calls.length, 0);
});

test("DNS deadline fails closed before dispatch and ignores a late answer", async () => {
  const h = harness();
  let finish;
  h.deps.resolve = () => new Promise((resolve) => { finish = resolve; });
  h.deps.dnsTimeoutMs = 5;
  await assert.rejects(post(h), /DNS timed out/);
  finish([publicV4]);
  await Promise.resolve();
  assert.equal(h.calls.length, 0);
});

test("DNS deadline is retired before an intended long-lived stream", async () => {
  const h = harness();
  h.deps.dnsTimeoutMs = 1;
  const r = await post(h);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await r.json(), { ok: true });
});

test("pins only fresh checked answers and preserves URL/TLS hostname", async () => {
  const answers = [{ ...publicV4 }, { ...publicV6 }];
  const h = harness({ addresses: answers });
  const r = await post(h);
  assert.deepEqual(await r.json(), { ok: true });
  const { url, opts } = h.calls[0];
  assert.equal(url.hostname, "provider.example");
  assert.equal(url.pathname, "/v1/chat/completions");
  assert.equal(opts.agent, false);
  assert.equal(opts.rejectUnauthorized, undefined); // retain Node's verification
  assert.equal(opts.checkServerIdentity, undefined); // retain hostname verification
  assert.equal(opts.headers.Authorization, "Bearer test-only-key-not-real");
  answers[0].address = "10.0.0.1"; // resolver's mutable array is not the transport's
  assert.deepEqual((await pinned(opts.lookup, "provider.example", { all: true })).address, [publicV4, publicV6]);
  assert.equal((await pinned(opts.lookup, "provider.example", { family: 6 })).address, publicV6.address);
  await assert.rejects(pinned(opts.lookup, "different.example", {}), /Unexpected/);
  assert.equal(h.lookups.length, 1); // no lookup during dispatch
});

test("each request revalidates its own result instead of reusing a DNS approval", async () => {
  const h = harness();
  await (await post(h)).text();
  await (await post(h)).text();
  assert.equal(h.lookups.length, 2);
});

test("literal public IP is checked without any hostname lookup", async () => {
  const h = harness();
  await (await post(h, "https://8.8.8.8/v1/chat/completions")).text();
  assert.equal(h.lookups.length, 0);
  assert.equal(h.calls[0].url.hostname, "8.8.8.8");
});

test("all redirect statuses are refused without dispatching a follow-up", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const h = harness({ status, headers: { location: "https://other.example/" } });
    await assert.rejects(post(h), /redirects are not allowed/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.response.destroyed, true);
  }
});

test("preserves provider error status and SSE body", async () => {
  const bad = harness({ status: 401, data: "key refused" });
  const r = await post(bad);
  assert.equal(r.status, 401);
  assert.equal(r.ok, false);
  assert.equal(await r.text(), "key refused");
  const sse = harness({ headers: { "content-type": "text/event-stream" }, data: "data: {}\n\n" });
  assert.equal(await (await post(sse)).text(), "data: {}\n\n");
});

test("handles compressed provider replies without returning compressed JSON", async () => {
  const h = harness({ headers: { "content-encoding": "gzip" }, data: gzipSync('{"ok":true}') });
  assert.deepEqual(await (await post(h)).json(), { ok: true });
});

test("both completion paths share the guard and deployment fetch denies redirects", () => {
  const s = readFileSync(new URL("../src/lib/buzzy/llm.ts", import.meta.url), "utf8");
  assert.equal((s.match(/const res = await postJson\(ep,/g) || []).length, 2);
  assert.match(s, /if \(usingOwnKey\(\)\) return postProviderJson\(ep.url, ep.key, init.body\);/);
  assert.match(s, /redirect: "error"/);
  assert.equal((s.match(/fetch\(ep.url/g) || []).length, 1);
});
