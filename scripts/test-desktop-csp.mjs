/** Portable CSP regressions. No Electron/browser, network, credentials, or user data. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
  CSP_MANIFEST_PATH, CSP_PAGE_NAMES, createDesktopCsp, desktopContentSecurityPolicy,
  loadCspManifest, sha256, validateCspManifest,
} from "../desktop/csp.mjs";
import { createRuntimeAuth, isAppPage } from "../desktop/security.mjs";
import { buildCspManifest, pageScripts, shellInlineBatches, shellRunScriptsSource, writeCspManifest } from "./build-desktop-csp.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const nav = read("public/buzzy/nav.js");
const fixture = mkdtempSync(join(tmpdir(), "beezilla-csp-"));
after(() => rmSync(fixture, { recursive: true, force: true }));
for (const tree of ["public", ".output/public"]) {
  mkdirSync(join(fixture, tree, "buzzy"), { recursive: true });
  for (const file of readdirSync(join(ROOT, "public/buzzy")).filter((name) => /\.(html|js)$/.test(name))) {
    copyFileSync(join(ROOT, "public/buzzy", file), join(fixture, tree, "buzzy", file));
  }
}
const manifest = await writeCspManifest(fixture);
const runtime = { host: "127.0.0.1", port: 7331, token: "a".repeat(43) };
const base = "http://127.0.0.1:7331";
const makeContents = (id = 7) => ({ id, mainFrame: {}, isDestroyed: () => false });

function setup() {
  const wc = makeContents();
  const state = { runtime: { ...runtime }, contents: [wc] };
  const policy = createDesktopCsp({ manifest, getRuntime: () => state.runtime, getContents: () => state.contents });
  const auth = createRuntimeAuth({ getContents: () => state.contents });
  const request = {
    id: 1, resourceType: "mainFrame", url: `${base}/buzzy/talk`, webContentsId: wc.id,
    webContents: wc, frame: wc.mainFrame,
    requestHeaders: {},
    responseHeaders: { "Content-Type": ["text/html; charset=utf-8"], "X-Test": ["retained"] },
  };
  const authorize = (details = request, result) => {
    if (state.runtime) auth.bind(state.runtime);
    else auth.clear();
    return policy.authorizeRequest(details, result ?? auth.headers(details));
  };
  assert.equal(authorize().cancel, undefined);
  return { wc, state, policy, request, authorize };
}

test("generated manifest covers the actual shipped hard-load and shell script bytes", async () => {
  assert.equal(manifest.pages.length, 17);
  assert.equal(manifest.scriptHashes.length, 41);
  assert.equal(manifest.scriptPaths.length, 9);
  assert.ok(manifest.scriptPaths.includes("/buzzy/library-vault.js"), "only the exact packaged Library helper is added");
  assert.ok(!manifest.scriptPaths.includes("/buzzy/common.js"), "unused JS does not receive script authority");
  let inlineCount = 0;
  for (const name of CSP_PAGE_NAMES) {
    const scripts = pageScripts(readFileSync(join(ROOT, "public/buzzy", `${name}.html`)), name);
    for (const script of scripts) {
      if (script.src) assert.ok(manifest.scriptPaths.includes(script.src));
      else { inlineCount++; assert.ok(manifest.scriptHashes.includes(sha256(script.textContent)), `${name} initial`); }
    }
    for (const source of await shellInlineBatches(nav, scripts)) {
      assert.ok(manifest.scriptHashes.includes(sha256(source)), `${name} shell batch`);
    }
  }
  assert.equal(inlineCount, 32);
  assert.deepEqual(loadCspManifest(fixture), manifest);
  assert.deepEqual(await buildCspManifest(fixture), manifest, "manifest generation is deterministic");
  assert.ok(existsSync(join(fixture, CSP_MANIFEST_PATH)));
});

test("generator uses the actual shell batching, skips nav, and never executes page scripts", async () => {
  const source = '<html><head><script>headOnly()</script></head><body><script>throw Error("must never execute")</script><script>second()</script><script src="/buzzy/chat.js"></script><script>third()</script><script src="/buzzy/nav.js"></script><script>fourth()</script></body></html>';
  const scripts = pageScripts(Buffer.from(source));
  assert.deepEqual(await shellInlineBatches(nav, scripts), [
    '(function(){\nthrow Error("must never execute")\n;\nsecond()\n})();',
    '(function(){\nthird()\n;\nfourth()\n})();',
  ]);
  const changedNav = nav.replace('batch.join("\\n;\\n")', 'batch.join("\\n;/* changed */\\n")');
  assert.notEqual(changedNav, nav);
  assert.notDeepEqual(await shellInlineBatches(changedNav, scripts), await shellInlineBatches(nav, scripts), "actual renderer changes alter emitted hashes");
  assert.throws(() => shellRunScriptsSource(nav.replace("function runScripts(root)", "function renamed(root)")), /batching boundary changed/);
});

test("HTML comments/raw text/quoted attributes cannot manufacture extra script grants", () => {
  const html = '<!-- <script>bad1()</script> --><html><head><title>&lt;script&gt;</title><style>x::after{content:"<script>bad2()</script>"}</style></head><body><textarea><script>bad3()</script></textarea><script id="a>b">good()</script></body></html>';
  assert.deepEqual(pageScripts(Buffer.from(html)).map((script) => script.textContent), ["good()"]);
  const windows = Buffer.from('<body>\r\n<script>\r\nfirst();\rsecond();\r\n</script></body>');
  assert.equal(pageScripts(windows)[0].textContent, "\nfirst();\nsecond();\n");
});

test("unsupported HTML/script cases fail closed rather than authorizing guessed code", () => {
  for (const html of [
    '<body><script src="https://evil.example/a.js"></script>',
    '<body><script src="/api/buzzy/assets/1"></script>',
    '<body><script src="/buzzy/nav.js" src="/buzzy/chat.js"></script>',
    '<body><script src="/buzzy/nav.js" onload="evil()"></script>',
    '<body><script type="module">import("x")</script>',
    '<body><script><!-- escaped script</script>',
    '<body><script>unterminated',
    '<body><template><script>insideTemplate()</script></template>',
    '<body>\0<script>nul()</script>',
  ]) assert.throws(() => pageScripts(Buffer.from(html)), /desktop CSP:/, html);
});

test("source/built drift and stale installed bytes are refused", async () => {
  const file = join(fixture, "public/buzzy/settings.html");
  const original = readFileSync(file);
  try {
    writeFileSync(file, Buffer.concat([original, Buffer.from("\n<!-- changed -->")]));
    await assert.rejects(buildCspManifest(fixture), /differs from the built copy/);
    assert.throws(() => loadCspManifest(fixture), /public\/buzzy\/settings.html changed/);
  } finally { writeFileSync(file, original); }
  const built = join(fixture, ".output/public/buzzy/nav.js");
  const originalNav = readFileSync(built);
  try {
    writeFileSync(built, "// changed built shell");
    assert.throws(() => loadCspManifest(fixture), /\.output\/public\/buzzy\/nav.js changed/);
  } finally { writeFileSync(built, originalNav); }
});

test("missing/invalid manifests and file paths cannot disable or expand the policy", () => {
  assert.throws(() => loadCspManifest(join(fixture, "missing")), /missing or unreadable manifest/);
  for (const patch of [
    { version: 0 }, { pages: ["talk"] }, { scriptHashes: [] },
    { scriptHashes: ["'unsafe-eval'"] }, { scriptHashes: ["sha256-not-a-hash"] },
    { scriptHashes: [manifest.scriptHashes[0] + "\n"] },
    { scriptPaths: ["https://evil.example/a.js"] }, { scriptPaths: ["/buzzy/*.js"] },
    { scriptPaths: ["/buzzy/../evil.js"] }, { scriptPaths: ["/buzzy/nav.js; script-src *"] },
    { scriptPaths: ["/buzzy/nav.js\n"] },
    { files: { "../outside": sha256("bad") } },
  ]) assert.throws(() => validateCspManifest({ ...manifest, ...patch }), /policy is incomplete or stale/);
});

test("policy has no eval/inline/wildcard/scheme/directory script escape hatches", () => {
  const value = desktopContentSecurityPolicy(manifest, runtime);
  const directives = Object.fromEntries(value.split("; ").map((directive) => {
    const [name, ...sources] = directive.split(" ");
    return [name, sources];
  }));
  assert.deepEqual(directives["script-src"], [
    ...manifest.scriptPaths.map((path) => base + path), ...manifest.scriptHashes.map((hash) => `'${hash}'`),
  ]);
  assert.doesNotMatch(value, /unsafe-inline|unsafe-eval|wasm-unsafe-eval|strict-dynamic|'self'|\*/);
  for (const name of ["script-src-attr", "object-src", "base-uri", "frame-src", "frame-ancestors"]) assert.deepEqual(directives[name], ["'none'"]);
  assert.equal(directives["default-src"], undefined, "resource/style rollout is separate, not a hidden parity change");
  assert.throws(() => desktopContentSecurityPolicy(manifest, { host: "example.com", port: 7331 }), /invalid loopback endpoint/);
  assert.ok(!manifest.scriptHashes.includes(sha256("globalThis.unapproved = true")));
});

test("GET/HEAD, Settings, all app pages and .html aliases receive an enforced policy", () => {
  const { policy, request, authorize } = setup();
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/buzzy", "/buzzy/", ...CSP_PAGE_NAMES.flatMap((name) => [`/buzzy/${name}`, `/buzzy/${name}.html?test=1`])]) {
      assert.ok(isAppPage(base + path, base));
      const details = { ...request, method, url: base + path };
      assert.equal(authorize(details).cancel, undefined);
      const result = policy.headers(details);
      assert.deepEqual(result.responseHeaders["Content-Type"], request.responseHeaders["Content-Type"]);
      assert.equal(result.responseHeaders["Content-Security-Policy"].length, 1);
      assert.match(result.responseHeaders["Content-Security-Policy"][0], /^script-src /);
    }
  }
  const settings = makeContents(8);
  const second = createDesktopCsp({ manifest, getRuntime: () => runtime, getContents: () => [settings] });
  const settingsRequest = { ...request, url: `${base}/buzzy/settings`, webContentsId: 8, webContents: settings, frame: settings.mainFrame };
  second.authorizeRequest(settingsRequest, { requestHeaders: { Authorization: `Bearer ${runtime.token}` } });
  assert.ok(second.headers(settingsRequest).responseHeaders);
  authorize(request);
  for (const frame of [null, undefined, {}]) {
    assert.ok(policy.headers({ ...request, frame }).responseHeaders,
      "a replaced/absent requesting frame never omits CSP from a registered main-document response");
  }
});

test("existing enforced policies intersect; Report-Only, cookies and headers are preserved", () => {
  const { policy, request } = setup();
  const responseHeaders = {
    "content-security-policy": ["sandbox; default-src 'none'"],
    "Content-Security-Policy": ["object-src 'none'"],
    "Content-Security-Policy-Report-Only": ["default-src 'none'"],
    "Set-Cookie": ["one=1", "two=2"], "Content-Type": ["text/html"],
  };
  const before = structuredClone(responseHeaders);
  const result = policy.headers({ ...request, responseHeaders }).responseHeaders;
  assert.deepEqual(responseHeaders, before, "caller headers are not mutated");
  assert.deepEqual(result["content-security-policy"].slice(0, 1), before["content-security-policy"]);
  assert.equal(result["content-security-policy"].length, 2);
  for (const key of Object.keys(before).filter((key) => key !== "content-security-policy")) assert.deepEqual(result[key], before[key]);
});

test("remote, unseen loopback, assets, subframes, probes and unregistered windows are untouched", () => {
  const { wc, policy, request } = setup();
  const assetHeaders = { "Content-Security-Policy": ["sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"] };
  const cases = [
    { url: "https://app.devboards.ai/buzzy/login" },
    { url: "http://localhost:7331/buzzy/talk" },
    { url: "http://127.0.0.1:7332/buzzy/talk" },
    { url: "http://127.0.0.1.evil.example:7331/buzzy/talk" },
    { url: `${base}/api/buzzy/assets/1`, responseHeaders: assetHeaders },
    { url: `${base}/buzzy/unknown` }, { url: `${base}/buzzy/nav.js` },
    { url: "file:///test-settings.html" }, { url: "data:text/html,probe" },
    { resourceType: "subFrame" }, { resourceType: "xhr" }, { resourceType: "script" },
    { webContentsId: 999 }, { webContents: makeContents(wc.id) },
  ];
  for (const patch of cases) assert.deepEqual(policy.headers({ ...request, ...patch }), {}, JSON.stringify(patch));
  assert.deepEqual(assetHeaders, { "Content-Security-Policy": ["sandbox; default-src 'none'; base-uri 'none'; form-action 'none'"] });
});

test("closed windows remain excluded but delayed authorized documents are canceled after stop/restart", () => {
  const { wc, policy, state, request, authorize } = setup();
  state.contents = [];
  assert.deepEqual(policy.headers(request), {});
  state.contents = [{ ...wc, isDestroyed: () => true }];
  assert.deepEqual(policy.headers(request), {});
  state.contents = [wc];
  state.runtime = null;
  assert.deepEqual(policy.headers(request), { cancel: true }, "delayed headers from the stopped runtime never bypass CSP");
  assert.deepEqual(authorize({ ...request, id: 2 }), { cancel: true }, "reload during the null-runtime gap is also blocked");
  state.runtime = { host: "127.0.0.1", port: 7442, token: "b".repeat(43) };
  assert.deepEqual(policy.headers(request), { cancel: true });
  assert.deepEqual(authorize({ ...request, id: 3 }), { cancel: true }, "retired origin cannot regain document authority");
  const fresh = { ...request, id: 4, url: "http://127.0.0.1:7442/buzzy/talk" };
  assert.equal(authorize(fresh).cancel, undefined);
  const value = policy.headers(fresh).responseHeaders["Content-Security-Policy"][0];
  assert.ok(value.includes("http://127.0.0.1:7442/buzzy/nav.js"));
  assert.ok(!value.includes(base));
  assert.ok(!value.includes(state.runtime.token), "credentials never appear in CSP");
});

test("same-port restarts cannot reuse an old request's token generation", () => {
  const { policy, state, request, authorize } = setup();
  state.runtime = { ...runtime, token: "b".repeat(43) };
  assert.deepEqual(policy.headers(request), { cancel: true });
  const fresh = { ...request, id: 2 };
  assert.equal(authorize(fresh).cancel, undefined);
  assert.ok(policy.headers(fresh).responseHeaders);
  assert.deepEqual(policy.headers(request), { cancel: true }, "new authorization does not revive the previous request");
});

test("request id, URL, registered window and actual authorization must match", () => {
  const { policy, state, request, authorize } = setup();
  assert.deepEqual(policy.headers({ ...request, id: 99 }), { cancel: true });
  assert.deepEqual(policy.headers({ ...request, url: `${base}/buzzy/settings` }), { cancel: true });
  const another = makeContents(8);
  state.contents.push(another);
  assert.deepEqual(policy.headers({ ...request, webContentsId: 8, webContents: another }), { cancel: true });
  for (const result of [{ cancel: true }, { requestHeaders: {} }, { requestHeaders: { Authorization: "Bearer wrong" } }]) {
    assert.deepEqual(authorize({ ...request, id: 2 }, result), { cancel: true });
    assert.deepEqual(policy.headers({ ...request, id: 2 }), { cancel: true });
  }
  assert.deepEqual(authorize({ ...request, id: undefined }), { cancel: true });
  assert.ok(policy.headers(request).responseHeaders, "unrelated failures do not remove the good request binding");
});

test("redirect authorization replaces only that request binding and completion/error cleanup fails closed", () => {
  const { policy, request, authorize } = setup();
  const redirected = { ...request, url: `${base}/buzzy/settings` };
  assert.equal(authorize(redirected).cancel, undefined);
  assert.deepEqual(policy.headers(request), { cancel: true }, "the previous URL cannot inherit a later redirect binding");
  assert.ok(policy.headers(redirected).responseHeaders);
  policy.finished(redirected);
  assert.deepEqual(policy.headers(redirected), { cancel: true }, "a missing record never becomes an unprotected product response");
  assert.equal(authorize(redirected).cancel, undefined);
  policy.finished({ id: redirected.id, error: "net::ERR_ABORTED" });
  assert.deepEqual(policy.headers(redirected), { cancel: true });
});

test("tracking is bounded without evicting the authorization for delayed requests", () => {
  const { policy, request, authorize } = setup();
  for (let id = 2; id <= 128; id++) assert.equal(authorize({ ...request, id }).cancel, undefined);
  assert.deepEqual(authorize({ ...request, id: 129 }), { cancel: true });
  assert.ok(policy.headers(request).responseHeaders);
  policy.finished({ id: 128 });
  assert.equal(authorize({ ...request, id: 129 }).cancel, undefined);
});

test("build/package/start wiring includes the manifest and never suppresses warnings", () => {
  const main = read("desktop/main.mjs");
  const dist = read("desktop/dist.mjs");
  const pkg = JSON.parse(read("package.json"));
  const desktopPkg = JSON.parse(read("desktop/package.json"));
  assert.match(pkg.scripts.postbuild, /node scripts\/build-desktop-csp\.mjs/);
  assert.match(pkg.scripts["test:desktop-boundaries"], /test-desktop-csp\.mjs/);
  assert.ok(desktopPkg.build.files.includes("csp.mjs"));
  assert.ok(!desktopPkg.build.files.includes("build-desktop-csp.mjs"));
  assert.match(dist, /await writeCspManifest\(ROOT\)/);
  assert.ok(dist.indexOf("await writeCspManifest(ROOT)") < dist.indexOf('for (const dir of [".output"'));
  assert.match(dist, /await stage\(\)/);
  assert.match(main, /session\.defaultSession\.webRequest\.onHeadersReceived/);
  assert.ok(main.includes('urls: ["http://127.0.0.1:*/*"]'), "the transport filter includes runtime ports, while policy scope checks the exact current origin");
  assert.match(main, /manifest: loadCspManifest\(ROOT\)/);
  assert.match(main, /getRuntime: \(\) => supervisor\.runtime/);
  assert.match(main, /getContents: trustedContents/);
  assert.match(main, /callback\(desktopCsp\.authorizeRequest\(details, runtimeAuth\.headers\(details\)\)\)/);
  assert.match(main, /onCompleted\(\(details\) => desktopCsp\.finished\(details\)\)/);
  assert.match(main, /onErrorOccurred\(\(details\) => desktopCsp\.finished\(details\)\)/);
  assert.doesNotMatch(main, /connectSession\.webRequest\.onHeadersReceived|ELECTRON_DISABLE_SECURITY_WARNINGS|webSecurity:\s*false/);
  for (const file of desktopPkg.build.files) assert.ok(existsSync(join(ROOT, "desktop", file)), `${file} exists for packaging`);
});
