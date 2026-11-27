#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  allowAudioPermission, connectBaseUrl, createRuntimeAuth, isAppPage, isConnectNavigation,
  isTrustedSender, retargetAppPage, runtimeOrigin, safeExternalUrl, webUrl,
} from "../desktop/security.mjs";
import { createSettingsHandlers } from "../desktop/settings.mjs";
import { loadInference } from "./lib/inference.mjs";

const base = "http://127.0.0.1:7331";
const token = "a".repeat(43);
const runtime = { host: "127.0.0.1", port: 7331, token };
const makeContents = (url = `${base}/buzzy/talk`) => ({
  id: 7, mainFrame: { url }, getURL() { return this.mainFrame.url; }, isDestroyed: () => false,
});

// Use the actual main-process logger without taking over this test runner's
// console or writing anywhere outside a disposable, per-test profile.
function startLogging(root, logOverride) {
  const env = {
    ...process.env,
    HOME: root, USERPROFILE: root, APPDATA: root, XDG_STATE_HOME: root,
  };
  delete env.BZ_LOG_DIR;
  if (logOverride) env.BZ_LOG_DIR = logOverride;
  const logger = new URL("../desktop/logger.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { installLogging } from ${JSON.stringify(logger)};
    if (process.platform !== "win32") process.umask(0o022);
    process.resourcesPath = "/fixture/app-resource-location";
    const paths = installLogging({
      version: "test-version",
      facts: { workspace: "/fixture/attached-project-location" },
    });
    console.log("opening bundled UI");
    console.error("could not start", new Error("Could not open bundled launcher"));
    process.stdout.write(JSON.stringify(paths) + "\\n");
  `, "--", "--project=fixture-private-project-argument"], {
    cwd: root, env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const paths = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.ok(paths.file, "diagnostic file is still discoverable");
  assert.match(result.stdout, /opening bundled UI/);
  assert.match(result.stderr, /Could not open bundled launcher/);
  return { ...paths, log: readFileSync(paths.file, "utf8") };
}

test("desktop startup log keeps support facts without copying locations or arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-log-fixture-"));
  try {
    const { log } = startLogging(root, join(root, "logs"));
    const header = JSON.parse(log.split("\n")[1].replace(/^[^{]+/, ""));
    assert.deepEqual(Object.keys(header).sort(), ["chrome", "electron", "node", "packaged", "platform", "version"]);
    assert.equal(header.version, "test-version");
    assert.equal(header.node, process.versions.node);
    assert.equal(header.platform, `${process.platform} ${process.arch}`);
    assert.equal(typeof header.packaged, "boolean");
    for (const marker of ["fixture-private-project-argument", "app-resource-location", "attached-project-location"]) {
      assert.equal(log.includes(marker), false, marker);
    }
    assert.match(log, /INFO +opening bundled UI/);
    assert.match(log, /ERROR +could not start Error: Could not open bundled launcher/);
    assert.match(log, /INFO +process exit code=0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const mode = (path) => statSync(path).mode & 0o777;

test("default desktop diagnostics start private on POSIX with an ordinary umask", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-log-fixture-"));
  try {
    const { dir, file } = startLogging(root);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(file), 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desktop diagnostics protect the existing default log directory without touching an override", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-log-fixture-"));
  try {
    const defaultDir = startLogging(root).dir;
    chmodSync(defaultDir, 0o755); // an ordinary directory created by the old logger
    writeFileSync(join(defaultDir, "main.1.log"), "fixture archived diagnostic");
    assert.equal(mode(startLogging(root).dir), 0o700);
    assert.equal(readFileSync(join(defaultDir, "main.1.log"), "utf8"), "fixture archived diagnostic");

    const override = join(root, "support-export");
    mkdirSync(override);
    chmodSync(override, 0o750);
    const overridden = startLogging(root, override);
    assert.equal(overridden.dir, override);
    assert.equal(mode(override), 0o750);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only exact loopback app pages receive privileges", () => {
  for (const path of ["/buzzy", "/buzzy/", "/buzzy/talk", "/buzzy/settings", "/buzzy/project?job=a#files", "/buzzy/studio.html"]) assert.ok(isAppPage(base + path, base));
  for (const url of ["http://127.0.0.1.evil.example:7331/buzzy/talk", "http://localhost:7331/buzzy/talk", "http://127.0.0.1:7332/buzzy/talk", `${base}/api/buzzy/assets/1`, `${base}/buzzy/not-a-page`, `${base}/buzzy/talk/extra`, "file:///tmp/talk.html", `${base}/buzzy/%74alk`, "http://user@127.0.0.1:7331/buzzy/talk"]) assert.equal(isAppPage(url, base), false, url);
  assert.equal(runtimeOrigin(runtime), base);
  assert.throws(() => runtimeOrigin({ host: "evil.example", port: 7331 }));
  assert.throws(() => runtimeOrigin({ host: "127.0.0.1", port: "7331" }));
});

test("external links reject shell protocols, credentials and malformed URLs", () => {
  assert.equal(safeExternalUrl("https://example.com/a?q=b"), "https://example.com/a?q=b");
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ms-settings:privacy", "mailto:a@example.com", "https://user:pass@example.com", " https://example.com", "https://example.com\n", "https:\\example.com"]) assert.equal(safeExternalUrl(value), null, value);
});

test("cloud sign-in is HTTPS and token scripts remain on the selected origin", () => {
  assert.equal(connectBaseUrl("https://app.devboards.ai"), "https://app.devboards.ai");
  assert.equal(connectBaseUrl("http://127.0.0.1:8500"), "http://127.0.0.1:8500");
  for (const value of ["http://example.com", "https://app.devboards.ai/anything", "https://user@app.devboards.ai", "http://localhost.evil.example", "file:///tmp/login.html"]) assert.throws(() => connectBaseUrl(value));
  assert.ok(isConnectNavigation("https://accounts.example.com/oauth", "https://app.devboards.ai"));
  assert.equal(isConnectNavigation("http://accounts.example.com/oauth", "https://app.devboards.ai"), false);
  assert.equal(isConnectNavigation("file:///tmp/login.html", base), false);
});

test("IPC rejects unregistered windows, subframes, missing frames and uploaded HTML", () => {
  const wc = makeContents();
  const config = { base, contents: [wc] };
  assert.ok(isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, config));
  assert.equal(isTrustedSender({ sender: wc, senderFrame: { url: wc.getURL() } }, config), false);
  assert.equal(isTrustedSender({ sender: wc }, config), false);
  const stranger = makeContents();
  assert.equal(isTrustedSender({ sender: stranger, senderFrame: stranger.mainFrame }, config), false);
  wc.mainFrame.url = `${base}/api/buzzy/assets/1`;
  assert.equal(isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, config), false);
  wc.mainFrame.url = "https://app.devboards.ai/login";
  assert.equal(isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, config), false);
  wc.mainFrame.url = "file:///test-settings.html";
  assert.equal(isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, config), false);
  assert.ok(isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, { ...config, testPageUrl: wc.getURL() }));
});

test("only top-level audio requests from a registered app page are allowed", () => {
  const wc = makeContents();
  const args = { contents: [wc], webContents: wc, base, permission: "media", origin: base, details: { isMainFrame: true, mediaType: "audio", requestingUrl: wc.getURL() } };
  assert.ok(allowAudioPermission(args));
  assert.ok(allowAudioPermission({ ...args, request: true, details: { ...args.details, mediaTypes: ["audio"] } }));
  for (const patch of [
    { webContents: null }, { contents: [] }, { origin: "https://evil.example" },
    { permission: "display-capture" }, { permission: "usb" },
    { details: { ...args.details, isMainFrame: false } },
    { details: { ...args.details, mediaType: "video" } },
    { details: { ...args.details, mediaType: "unknown" } },
    { details: { ...args.details, securityOrigin: "https://evil.example" } },
    { request: true, details: { ...args.details, mediaTypes: ["audio", "video"] } },
    { request: true, details: { ...args.details, mediaTypes: [] } },
  ]) assert.equal(allowAudioPermission({ ...args, ...patch }), false, JSON.stringify(patch));
});

test("auth attaches only to trusted frames and rebinds without leaking retired tokens", () => {
  const wc = makeContents();
  const auth = createRuntimeAuth({ getContents: () => [wc] });
  auth.bind(runtime);
  const request = { url: `${base}/api/buzzy/jobs`, resourceType: "xhr", webContentsId: wc.id, webContents: wc, frame: wc.mainFrame, requestHeaders: {} };
  assert.equal(auth.headers(request).requestHeaders.Authorization, `Bearer ${token}`);
  assert.equal(auth.headers({ ...request, frame: { url: wc.getURL() } }).cancel, true);
  assert.equal(auth.headers({ ...request, frame: null }).cancel, true);
  assert.equal(auth.headers({ ...request, webContentsId: 99 }).cancel, true);
  assert.equal(auth.headers({ ...request, initiatorOrigin: "https://evil.example" }).cancel, true);
  assert.equal(auth.headers({ ...request, resourceType: "mainFrame", url: `${base}/api/buzzy/assets/1` }).cancel, true);
  assert.equal(auth.headers({ ...request, url: "https://example.com", requestHeaders: { authorization: `Bearer ${token}`, Other: "kept" } }).requestHeaders.authorization, undefined);
  const next = { host: "127.0.0.1", port: 7332, token: "b".repeat(43) };
  auth.bind(next);
  assert.equal(auth.headers({ ...request, requestHeaders: { Authorization: `Bearer ${token}` } }).requestHeaders.Authorization, undefined);
  const nextUrl = "http://127.0.0.1:7332/buzzy/talk";
  assert.equal(auth.headers({ ...request, url: nextUrl, resourceType: "mainFrame" }).requestHeaders.Authorization, `Bearer ${next.token}`);
  wc.mainFrame.url = nextUrl;
  assert.equal(auth.headers({ ...request, url: "http://127.0.0.1:7332/api/buzzy/jobs" }).requestHeaders.Authorization, `Bearer ${next.token}`);
  auth.clear();
  assert.equal(auth.headers({ ...request, requestHeaders: { Authorization: `Bearer ${next.token}` } }).requestHeaders.Authorization, undefined);
});

test("native file downloads use a one-shot, URL-bound permit, not a privileged preview", () => {
  const wc = makeContents();
  const auth = createRuntimeAuth({ getContents: () => [wc] });
  auth.bind(runtime);
  const url = `${base}/api/buzzy/assets/12`;
  const headers = auth.prepareDownload(wc, url);
  const request = { url, resourceType: "other", webContentsId: wc.id, requestHeaders: headers, frame: null };
  const accepted = auth.headers(request);
  assert.equal(accepted.requestHeaders.Authorization, `Bearer ${token}`);
  assert.equal(accepted.requestHeaders["X-BeeZilla-Download"], undefined);
  assert.equal(auth.headers(request).cancel, true);
  assert.throws(() => auth.prepareDownload(wc, "https://example.com/file"));
  assert.throws(() => auth.prepareDownload(wc, `${base}/api/buzzy/jobs`));
});

test("runtime retarget preserves page/query/hash and refuses unsafe fallbacks", () => {
  assert.equal(retargetAppPage(`${base}/buzzy/settings?tab=keys#search`, base, "http://127.0.0.1:7332"), "http://127.0.0.1:7332/buzzy/settings?tab=keys#search");
  assert.equal(retargetAppPage("https://evil.example", base, "http://127.0.0.1:7332", "/buzzy/settings"), "http://127.0.0.1:7332/buzzy/settings");
  assert.throws(() => retargetAppPage("https://evil.example", base, base, "/api/buzzy/assets/1"));
});

test("preload waits for IPC replies before runtime navigation and exposes no subframe bridge", async () => {
  const src = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  let bridge;
  let finish;
  const ipc = new EventEmitter();
  ipc.invoke = () => new Promise((resolve) => { finish = resolve; });
  const timers = [];
  const navigations = [];
  const context = {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: ipc }),
    process: { isMainFrame: true }, URL,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    window: { location: { replace: (url) => navigations.push(url) } },
  };
  runInNewContext(src, context);
  const result = bridge.settings.saveSearch({ key: "test" });
  ipc.emit("beezilla:runtime:changed", {}, { url: "http://127.0.0.1:7332/buzzy/settings" });
  assert.equal(timers.length, 0);
  finish({ ok: true });
  await result;
  timers.shift()();
  assert.deepEqual(navigations, ["http://127.0.0.1:7332/buzzy/settings"]);
  ipc.emit("beezilla:runtime:changed", {}, { url: "https://evil.example/buzzy/settings" });
  assert.equal(timers.length, 0);
  bridge = null;
  runInNewContext(src, { ...context, process: { isMainFrame: false } });
  assert.equal(bridge, null);
});

test("Save/Clear transactions are serialized through health, restart and endpoint rebinding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bz-settings-hardening-"));
  const trace = [];
  const rt = { ...runtime };
  let active = 0;
  const supervisor = {
    runtime: rt,
    async isHealthy(value) { assert.equal(value, this.runtime); return Boolean(value); },
    async stop() { assert.equal(active++, 0); trace.push("stop"); await new Promise((r) => setTimeout(r, 10)); this.runtime = null; },
    async start() { trace.push("start"); active--; this.runtime = { ...rt, port: 7332 }; return this.runtime; },
  };
  const handlers = createSettingsHandlers({
    dataDir: () => dir, supervisor,
    beforeRestart: () => trace.push(loadInference(dir)?.key ?? "cleared"),
    afterRestart: (value) => { assert.equal(value, supervisor.runtime); trace.push("rebind"); },
  });
  try {
    const [saved, cleared] = await Promise.all([handlers.saveInference({ key: "test-serialized-key" }), handlers.clear("inference")]);
    assert.equal(saved.restarted, true);
    assert.equal(cleared.restarted, true);
    assert.deepEqual(trace, ["test-serialized-key", "stop", "start", "rebind", "cleared", "stop", "start", "rebind"]);
    assert.equal(loadInference(dir), null);
    supervisor.stop = async () => { throw new Error("still flushing"); };
    assert.match((await handlers.saveSearch({ key: "search-test" })).reason, /still flushing/);
    await assert.rejects(handlers.clear("unknown"), /unknown credential/);
    supervisor.stop = async () => {};
    assert.equal((await handlers.clear("search")).cleared, "search");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("main wiring retains guards, isolated cloud session and extensionless settings route", () => {
  const src = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(src, /isTrustedSender\(event,/);
  assert.match(src, /confineAppWindow\(mainWindow\)/);
  assert.match(src, /confineAppWindow\(settingsWindow\)/);
  assert.match(src, /fromPartition\("persist:beezilla-connect"\)/);
  assert.match(src, /settingsWindowFor\(`\$\{runtimeBase\}\/buzzy\/settings`\)/);
  assert.equal((src.match(/onBeforeSendHeaders\(/g) ?? []).length, 1);
});

// Exercise the callbacks as Electron registers them, without opening real devices.
function mediaSessionFixture() {
  const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const block = /function installMediaPermissions\(\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(block, "main must wire the tested session policy");
  const wc = makeContents(base + "/buzzy/project?job=fixture-willow#private-notes");
  const callbacks = {}, logs = [];
  const defaultSession = {
    setPermissionRequestHandler(fn) { callbacks.request = fn; },
    setPermissionCheckHandler(fn) { callbacks.check = fn; },
    setDevicePermissionHandler(fn) { callbacks.device = fn; },
  };
  runInNewContext(block[0] + "\ninstallMediaPermissions();", {
    session: { defaultSession }, trustedContents: () => [wc], runtimeBase: base,
    allowAudioPermission, webUrl, logLine: (_level, args) => logs.push(args.join(" ")),
    setTimeout: () => {}, // OS availability is independent of a permission decision.
  });
  return { wc, callbacks, logs };
}

test("permission diagnostics retain decisions and requester origins, not document locations", () => {
  const { wc, callbacks, logs } = mediaSessionFixture();
  const results = [];
  const details = { isMainFrame: true, mediaTypes: ["audio"], requestingUrl: wc.getURL() };
  callbacks.request(wc, "media", result => results.push(result), details);
  callbacks.request(wc, "media", result => results.push(result), {
    ...details, isMainFrame: false, requestingUrl: "https://other.example/private/fixture-finch?name=fixture-coral",
  });
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(logs, [
    "[perm] request media ← " + base + " → allow",
    "[perm] request media ← https://other.example → deny",
  ]);
  assert.equal(callbacks.check(wc, "media", base, { isMainFrame: true, mediaType: "audio" }), true);
  assert.equal(callbacks.check(wc, "media", "file:///fixture-private/draft.txt", { isMainFrame: true, mediaType: "audio" }), false);
  assert.deepEqual(logs.slice(-2), [
    "[perm] check media(audio) ← " + base + " → allow",
    "[perm] check media(audio) ← unknown → deny",
  ]);
});

test("permission denial still calls Electron back once when the window is retired", () => {
  const { wc, callbacks, logs } = mediaSessionFixture();
  wc.isDestroyed = () => true;
  wc.getURL = () => { throw new Error("fixture: disposed WebContents"); };
  const results = [];
  callbacks.request(wc, "media", result => results.push(result), {});
  assert.deepEqual(results, [false]);
  assert.deepEqual(logs, ["[perm] request media ← unknown → deny"]);
});
