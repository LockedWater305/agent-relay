/**
 * Dependency-free alias policy, real page-handler body and plugin contract tests.
 * IO is real; Nitro/h3 registration adapters are not a built server. Native
 * verification must separately prove the installed fetch wrapper precedes static.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const helper = stripTypeScriptTypes(read("src/lib/buzzy/page-alias.ts")).replace(/^export /gm, "");
const aliases = runInNewContext(helper + "\n({ htmlAliasLocation, BUZZY_PAGE_NAMES })");
const { htmlAliasLocation } = aliases;
const names = [...aliases.BUZZY_PAGE_NAMES, "index"];
const destination = (name) => `/buzzy/${name === "index" ? "talk" : name}`;
const queries = ["", "?", "?job=fixture&tag=one&tag=two&encoded=%2f%20+%23&empty=", "?next=//untrusted.invalid/path&raw=C:\\folder"];

function pageHandler() {
  const handlerSource = process.env.BZ_ALIAS_HANDLER_SOURCE
    ? readFileSync(resolve(ROOT, process.env.BZ_ALIAS_HANDLER_SOURCE), "utf8")
    : read("src/lib/buzzy/pages.nitro.ts");
  const source = stripTypeScriptTypes(handlerSource)
    .replace(/^import .*;$/gm, "")
    .replace("export default", "globalThis.handler =");
  const context = {
    defineEventHandler: (fn) => fn,
    getMethod: (event) => event.method || "GET",
    setResponseStatus: (event, status) => { event.status = status; },
    sendRedirect: (_event, location, status = 302) => new Response(null, { status, headers: { location } }),
    readFile, join, resolve, Buffer, Uint8Array, Response, process: { cwd: () => ROOT },
  };
  runInNewContext(helper + "\n" + source, context);
  return context.handler;
}

function installPlugin(app) {
  const source = stripTypeScriptTypes(read("src/lib/buzzy/page-alias.plugin.ts"))
    .replace(/^import .*;$/gm, "")
    .replace("export default", "globalThis.plugin =");
  const context = { URL, Response, definePlugin: (fn) => fn };
  runInNewContext(helper + "\n" + source, context);
  context.plugin(app);
}

test("allowlist matches every actual page plus the explicit legacy index alias", () => {
  const files = readdirSync(join(ROOT, "public/buzzy")).filter((name) => name.endsWith(".html")).map((name) => name.slice(0, -5));
  assert.deepEqual([...aliases.BUZZY_PAGE_NAMES].sort(), files.sort());
  assert.equal(new Set(names).size, 18);
});

for (const method of ["GET", "HEAD"]) {
  test(`${method} once-encoded known spellings cannot fall through to raw static HTML`, async () => {
    const handler = pageHandler();
    const app = { fetch() { throw Error("encoded known alias reached static"); } };
    installPlugin(app);
    for (const name of names) {
      const encoded = `/%62uzzy/%${name.charCodeAt(0).toString(16)}${name.slice(1)}%2ehtml/?q=%2f&x=1&x=2`;
      const expected = destination(name) + "?q=%2f&x=1&x=2";
      assert.equal(htmlAliasLocation(encoded, method), expected);
      assert.equal((await handler({ path: encoded, method })).headers.get("location"), expected);
      assert.equal((await app.fetch(new Request("http://127.0.0.1:7331" + encoded, { method }))).headers.get("location"), expected);
    }
  });

  test(`${method} policy redirects all known aliases, with exact raw queries and no loop`, () => {
    for (const name of names) for (const slash of ["", "/"]) for (const query of queries) {
      const target = `/buzzy/${name}.html${slash}${query}`;
      const expected = destination(name) + query;
      assert.equal(htmlAliasLocation(target, method), expected, target);
      assert.equal(htmlAliasLocation(expected, method), null, "canonical paths cannot loop");
      assert.equal(new URL(expected, "https://app.example").origin, "https://app.example");
    }
  });

  test(`${method} real page handler redirects all aliases without reading or serving raw HTML`, async () => {
    const handler = pageHandler();
    for (const name of names) for (const slash of ["", "/"]) for (const query of queries) {
      const result = await handler({ path: `/buzzy/${name}.html${slash}${query}`, method });
      assert.equal(result.status, 302, name);
      assert.equal(result.headers.get("location"), destination(name) + query, name);
      assert.equal(await result.text(), "", "redirects are bodyless, including HEAD");
    }
  });

  test(`${method} public fetch wrapper intercepts known aliases before its original static pipeline`, async () => {
    let delegates = 0;
    const app = { fetch() { delegates++; return new Response("untransformed static HTML"); } };
    installPlugin(app);
    for (const name of names) for (const query of queries) {
      const request = new Request(`http://127.0.0.1:7331/buzzy/${name}.html${query}`, { method });
      const result = await app.fetch(request);
      assert.equal(result.status, 302, name);
      assert.equal(result.headers.get("location"), destination(name) + query, name);
      assert.equal(await result.text(), "");
    }
    assert.equal(delegates, 0, "the plugin contract never reaches the underlying static handler for aliases");
  });
}

const rejected = [
  "/buzzy/unknown.html", "/buzzy/form.html", "/buzzy/nav.js", "/buzzy/nav.css",
  "/buzzy/talk", "/buzzy/", "/buzzy", "/buzzy/talk.html//", "/buzzy/talk.HTML",
  "/buzzy/nested/talk.html", "/buzzy/../talk.html", "/buzzy/..html", "/buzzy/./talk.html",
  "/buzzy/\\talk.html", "//buzzy/talk.html", "/other/talk.html", "https://other.invalid/buzzy/talk.html",
  "/buzzy/%2e%2e/talk.html", "/buzzy/%2ftalk.html", "/buzzy/talk.html%00",
  "/buzzy%2ftalk.html", "/buzzy/%5ctalk.html", "/buzzy/%2574alk.html", "/buzzy/%74alk.html%2f",
  "/buzzy/%talk.html", "/buzzy/%C0%AE.html", "/%2562uzzy/talk.html",
  "/buzzy/talk.html#fragment", "/buzzy/talk.html?x=\r\nLocation:https://other.invalid",
];

test("unknown, malformed and arbitrary paths never become redirects", () => {
  for (const path of rejected) assert.equal(htmlAliasLocation(path, "GET"), null, path);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "get", ""]) {
    for (const name of names) assert.equal(htmlAliasLocation(`/buzzy/${name}.html?q=1`, method), null, method);
  }
});

test("page-handler aliases remain GET/HEAD-only; unknown HTML and normal assets retain existing behavior", async () => {
  const handler = pageHandler();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const name of names) {
      const event = { path: `/buzzy/${name}.html`, method };
      const result = await handler(event);
      assert.equal(event.status, 405);
      assert.equal(result.error, "method not allowed");
    }
  }
  for (const path of ["/buzzy/unknown.html", "/buzzy/form.html", "/buzzy/nested/talk.html"]) {
    const result = await handler({ path });
    assert.equal(result.status, 404);
    assert.equal(result.headers.get("location"), null);
  }
  for (const name of aliases.BUZZY_PAGE_NAMES) {
    const result = await handler({ path: destination(name) });
    assert.equal(result.status, 200);
    assert.equal((await result.text()).split('<script src="/buzzy/nav.js" defer></script>').length - 1, 1, name);
    const head = await handler({ path: destination(name), method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  const asset = await handler({ path: "/buzzy/nav.js" });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), read("public/buzzy/nav.js"));
});

test("non-alias fetches preserve the exact Request, context, auth headers, method and original receiver", async () => {
  const response = new Response("delegated", { status: 418 });
  const calls = [];
  const app = { fetch(request) { calls.push({ request, receiver: this }); return Promise.resolve(response); } };
  installPlugin(app);
  for (const path of ["/api/buzzy/chat", "/buzzy/talk", "/buzzy/unknown.html", "/buzzy/nav.js", "/outside"]) {
    const request = new Request(`http://127.0.0.1:7331${path}`, { headers: { authorization: "Bearer fixture-only" } });
    request.context = { marker: "fixture context" };
    assert.equal(await app.fetch(request), response);
    assert.equal(calls.at(-1).request, request);
    assert.equal(calls.at(-1).request.context, request.context);
    assert.equal(calls.at(-1).receiver, app);
    assert.equal(request.headers.get("authorization"), "Bearer fixture-only");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const request = new Request("http://127.0.0.1:7331/buzzy/talk.html", { method, body: "unchanged fixture body" });
    assert.equal(await app.fetch(request), response);
    assert.equal(calls.at(-1).request, request);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), "unchanged fixture body");
  }
});

test("redirect targets never reflect host headers or a return URL; fragments stay browser-owned", async () => {
  const app = { fetch() { throw Error("known alias should not reach static"); } };
  installPlugin(app);
  const request = new Request("https://app.example/buzzy/talk.html?next=https%3A%2F%2Fevil.invalid&x=1&x=2#draft", {
    headers: { host: "evil.invalid", "x-forwarded-host": "evil.invalid", authorization: "Bearer fixture-only" },
  });
  const result = await app.fetch(request);
  assert.equal(result.headers.get("location"), "/buzzy/talk?next=https%3A%2F%2Fevil.invalid&x=1&x=2");
  assert.equal(result.headers.get("authorization"), null);
  assert.equal(result.headers.get("location").includes("#"), false);
});

test("the production build registers the plugin without disabling static assets or changing dev routing", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /command === "build"[\s\S]*?nitro\(\{[\s\S]*?plugins: \["\.\/src\/lib\/buzzy\/page-alias\.plugin\.ts"\]/);
  assert.doesNotMatch(vite, /serveStatic:\s*false/, "do not disable static assets to make alias redirects win");
  assert.doesNotMatch(vite, /buzzyHtmlAliasesPlugin/, "do not add a dev redirect without a dev canonical handler");
});
