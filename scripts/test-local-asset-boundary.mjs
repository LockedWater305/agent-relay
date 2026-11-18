#!/usr/bin/env node
/**
 * Stored-asset response hardening, exercising the real Nitro handler with
 * authenticated-user/database/H3 mocks. No network or installed dependencies.
 * Does not replace browser/Electron integration tests.
 * Run: node --experimental-vm-modules --test scripts/test-local-asset-boundary.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { cleanFilename } from "../src/lib/buzzy/paper.ts";

const source = stripTypeScriptTypes(await readFile(new URL("../src/lib/buzzy/chat.nitro.ts", import.meta.url), "utf8"));

async function requestAsset({ mime = "text/html", filename = "sample.html", signedIn = true, exists = true, body = "<script>attack()</script>" } = {}) {
  let queries = 0;
  const sql = async (strings, ...params) => {
    queries++;
    assert.match(strings.join("?"), /WHERE id = \? AND user_id = \?/);
    assert.deepEqual(params, [42, "asset-owner"]);
    return exists ? [{ filename, content_type: mime, body: Buffer.from(body) }] : [];
  };
  const event = {
    path: "/api/buzzy/assets/42",
    req: new Request("http://127.0.0.1/api/buzzy/assets/42"),
    responseHeaders: new Headers(),
    status: 200,
  };
  const deps = {
    h3: {
      defineEventHandler: (handler) => handler,
      getMethod: (request) => request.req.method,
      getHeader: (request, name) => request.req.headers.get(name),
      setResponseHeader: (request, name, value) => request.responseHeaders.set(name, value),
      setResponseStatus: (request, status) => { request.status = status; },
    },
    "@/lib/auth/verify.server": { getSessionUserFromHeaders: async () => signedIn ? { id: "asset-owner" } : null },
    "@/lib/db": { getSql: async () => sql },
    "./paper": { cleanFilename },
  };
  const context = vm.createContext({ Headers, Buffer, Uint8Array });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const declaration = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
      .find((match) => match[2] === specifier);
    assert.ok(declaration, `named imports required for ${specifier}`);
    const names = declaration[1].split(",").map((name) => name.trim()).filter(Boolean);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) {
        this.setExport(name, deps[specifier]?.[name] ?? (() => { throw new Error(`Unexpected call: ${specifier}.${name}`); }));
      }
    }, { context });
  });
  await module.evaluate();
  const result = await module.namespace.default(event);
  return { result, headers: event.responseHeaders, status: event.status, queries };
}

for (const mime of [
  "text/html", "application/xhtml+xml", "image/svg+xml", "image/svg+xml; charset=utf-8",
  "application/xml", "text/xml", "text/javascript", "application/javascript", "text/css",
  "application/pdf", "application/octet-stream", "model/gltf-binary", "image/unknown", "audio/unknown",
  "image/png, text/html", "image/png\r\nX-Injected: yes", "", null,
]) {
  test(`${JSON.stringify(mime)} is an inert, sandboxed download`, async () => {
    const { result, headers, status } = await requestAsset({ mime });
    assert.equal(status, 200);
    assert.equal(Buffer.from(result).toString(), "<script>attack()</script>");
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.match(headers.get("content-disposition"), /^attachment;/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("content-security-policy"), "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
    assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(headers.get("cache-control"), "private, no-store");
  });
}

for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4"]) {
  test(`${mime} retains the existing inline media URL`, async () => {
    const { result, headers, status } = await requestAsset({ mime, body: "media-bytes", filename: "media.dat" });
    assert.equal(status, 200);
    assert.equal(Buffer.from(result).toString(), "media-bytes");
    assert.equal(headers.get("content-type"), mime);
    assert.match(headers.get("content-disposition"), /^inline;/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
  });
}

test("media MIME is canonicalised without reflecting arbitrary parameters", async () => {
  const { headers } = await requestAsset({ mime: " IMAGE/PNG ; arbitrary=untrusted " });
  assert.equal(headers.get("content-type"), "image/png");
});

test("filename headers cannot inject lines, quotes, or paths", async () => {
  const { headers } = await requestAsset({ filename: '../unsafe";\r\nX-Injected: yes.html' });
  const disposition = headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="unsafe_;X-Injected: yes\.html";/);
  assert.equal(headers.has("x-injected"), false);
  assert.equal(/[\r\n]/.test(disposition), false);
  assert.equal(disposition.includes("../"), false);
});

test("Unicode filenames have an encoded value and a safe ASCII fallback", async () => {
  const { headers } = await requestAsset({ filename: "résumé 日本語.pdf" });
  const disposition = headers.get("content-disposition");
  assert.match(disposition, /filename="r_sum_ ___\.pdf"/);
  assert.match(disposition, /filename\*=UTF-8''r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E\.pdf/);
});

test("a truncated surrogate in a display filename does not break the response", async () => {
  const { headers, status } = await requestAsset({ filename: `${"a".repeat(179)}😀.pdf` });
  assert.equal(status, 200);
  assert.match(headers.get("content-disposition"), /filename\*=UTF-8''/);
});

test("unsigned asset access is refused before querying stored content", async () => {
  const { result, status, queries } = await requestAsset({ signedIn: false });
  assert.equal(status, 401);
  assert.equal(result.code, "signed_out");
  assert.equal(queries, 0);
});

test("other-account or missing asset remains a scoped 404", async () => {
  const { result, status, queries } = await requestAsset({ exists: false });
  assert.equal(status, 404);
  assert.equal(result.code, "not_found");
  assert.equal(queries, 1);
});
