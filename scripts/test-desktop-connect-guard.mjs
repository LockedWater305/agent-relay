/**
 * Managed-account Connect guard regressions. Node built-ins only.
 * Executes the actual main/Settings/preload/page code with in-memory Electron,
 * credential and network doubles: no app, socket, auth, credential or user data.
 * Run: npm run test:desktop-connect-guard
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { managedAccountConnectCapability } from "../desktop/connect.mjs";
import * as security from "../desktop/security.mjs";

const ROOT = process.env.BZ_CONNECT_GUARD_BASELINE_DIR
  ? resolve(process.env.BZ_CONNECT_GUARD_BASELINE_DIR)
  : fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const base = "http://127.0.0.1:7331";
const runtime = { host: "127.0.0.1", port: 7331, token: "t".repeat(43) };
const disabledReason = managedAccountConnectCapability({ BZ_CONNECT_DISABLED: "1" }).reason;
const disabled = { enabled: false, reason: disabledReason };
const enabled = { enabled: true, reason: null };
const state = (capability = enabled, other = {}) => ({
  capabilities: { managedAccountConnect: capability },
  inference: null, search: null, music: null, ...other,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const quiet = { log() {}, warn() {}, error() {} };

function stub(context, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
}

async function mainFixture(flag, connect = async () => ({ ok: false, error: "fixture canceled" })) {
  const trace = [], ipc = new Map(), menu = [];
  const env = {};
  Object.defineProperty(env, "BZ_CONNECT_DISABLED", { get: () => { trace.push("flag"); return flag; } });
  let inference = null, search = null, music = null;
  const store = (kind, value) => { trace.push(`save:${kind}`); return { ...value, source: "store", encrypted: true }; };
  const libraries = {
    "scripts/lib/inference.mjs": {
      loadInference: () => inference, resolveInference: () => inference, isExpired: () => false,
      redactKey: () => "redacted", clearInference: () => { inference = null; },
      saveInference: (_dir, cfg) => inference = store("inference", cfg),
    },
    "scripts/lib/search-keys.mjs": {
      resolveSearch: () => search, loadManagedSearch: () => null,
      clearSearchKey: () => { search = null; },
      saveSearchKey: (_dir, cfg) => search = store("search", { provider: "brave", ...cfg }),
      saveManagedSearch: (_dir, cfg) => store("managed-search", cfg),
    },
    "scripts/lib/music-keys.mjs": {
      resolveMusicKey: () => music, clearMusicKey: () => { music = null; },
      saveMusicKey: (_dir, cfg) => music = store("music", { provider: "elevenlabs", ...cfg }),
    },
  };
  const wc = {
    id: 7, mainFrame: { url: `${base}/buzzy/settings` },
    getURL() { return this.mainFrame.url; }, isDestroyed: () => false, send() {},
  };
  const win = { webContents: wc, isDestroyed: () => false };
  class FakeWindow {
    constructor() { trace.push("window"); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    setMenuBarVisibility() {}
    isDestroyed() { return false; }
    destroy() { trace.push("destroy"); }
  }
  class FakeSupervisor {
    constructor() { this.dataDir = "/unused-in-memory-fixture"; this.runtime = runtime; }
    async isHealthy() { return true; }
    async stop() { trace.push("stop"); }
    async start() { trace.push("start"); return runtime; }
  }
  const session = { fromPartition(name) {
    trace.push(`session:${name}`);
    return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {} };
  } };
  const unexpected = (name) => () => { trace.push(name); throw new Error(`Unexpected fixture effect: ${name}`); };
  const context = vm.createContext({ console: quiet, URL, Buffer, setTimeout: unexpected("timer"),
    process: { env, on() {}, platform: "fixture" } });
  const connectExports = {
    managedAccountConnectCapability: () => managedAccountConnectCapability(env),
    cloudBaseUrl: () => { trace.push("cloud-url"); return "http://127.0.0.1:8500"; },
    connectAccount: async (deps) => { trace.push("connect-account"); return connect(deps); },
  };
  const mocks = {
    electron: {
      app: { getVersion: () => "test", commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
        on() {}, whenReady: () => new Promise(() => {}), exit: unexpected("app-exit"), quit: unexpected("app-quit") },
      BrowserWindow: FakeWindow, Menu: { buildFromTemplate: (value) => value, setApplicationMenu: (value) => menu.push(...value) },
      session, shell: { openExternal: unexpected("external"), openPath: unexpected("open-path") },
      dialog: { showMessageBox() {}, showErrorBox: unexpected("error-box") },
      safeStorage: {}, ipcMain: { handle: (name, fn) => ipc.set(name, fn) }, systemPreferences: {},
    },
    "node:fs": { existsSync: () => false, mkdirSync: unexpected("mkdir"), readFileSync: unexpected("read"), writeFileSync: unexpected("write") },
    "node:path": { dirname, join }, "node:url": { fileURLToPath, pathToFileURL },
    "./supervisor.mjs": { RuntimeSupervisor: FakeSupervisor },
    "./paths.mjs": { ROOT: "/unused-in-memory-fixture", runtimeLib: async (name) => {
      assert.ok(libraries[name], `Unexpected credential library ${name}`); return libraries[name];
    } },
    "./logger.mjs": { installLogging() {}, logLine() {}, logPaths: () => ({}) },
    "./connect.mjs": connectExports,
    "./csp.mjs": { createDesktopCsp: unexpected("csp"), loadCspManifest: unexpected("manifest") },
    "./security.mjs": { ...security },
  };
  const modules = new Map();
  const load = async (name) => {
    if (modules.has(name)) return modules.get(name);
    const mod = mocks[name] ? stub(context, mocks[name]) : new vm.SourceTextModule(read("desktop/settings.mjs"), { context });
    assert.ok(mocks[name] || name === "./settings.mjs", `Unexpected main import ${name}`);
    modules.set(name, mod);
    return mod;
  };
  const main = new vm.SourceTextModule(read("desktop/main.mjs") + `
export const testApi = { connectManagedAccount, installMenu,
  register: async () => settingsHandlers = await registerSettingsIpc(),
  setup: (win, rt) => { mainWindow = win; bindRuntime(rt); },
  pending: (value) => { connecting = value; }
};`, {
    context, initializeImportMeta(meta) { meta.url = pathToFileURL(join(ROOT, "desktop/main.mjs")).href; },
    async importModuleDynamically(name) {
      const mod = await load(name);
      if (mod.status === "unlinked") await mod.link(load);
      if (mod.status !== "evaluated") await mod.evaluate();
      return mod;
    },
  });
  await main.link(load);
  await main.evaluate();
  const api = main.namespace.testApi;
  api.setup(win, runtime);
  const handlers = await api.register();
  trace.length = 0;
  return { api, handlers, trace, ipc, menu, event: { sender: wc, senderFrame: wc.mainFrame },
    setFlag: (value) => { flag = value; } };
}

function preloadFixture(invoke) {
  let bridge;
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = invoke;
  vm.runInNewContext(read("desktop/preload.cjs"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }),
    process: { isMainFrame: true }, URL,
    setTimeout: () => { throw new Error("Unexpected navigation"); }, window: {},
  });
  return bridge;
}

function rendererFixture(bridge) {
  const html = read("public/buzzy/settings.html");
  const nodes = new Map([...html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map((match) => {
    const [, tag, attrs, id] = match;
    return [id, { id, tag, hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs),
      checked: /\bchecked\b/.test(attrs), value: /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? "", textContent: "", innerHTML: "", style: {},
      listeners: {}, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
      addEventListener(name, fn) { this.listeners[name] = fn; }, querySelectorAll() { return []; },
    }];
  }));
  const radios = [nodes.get("provider-beezilla"), nodes.get("provider-byok")];
  const document = {
    getElementById: (id) => { assert.ok(nodes.has(id), `Unknown Settings element ${id}`); return nodes.get(id); },
    querySelector: (selector) => selector.endsWith(":checked") ? radios.find((radio) => radio.checked)
      : radios.find((radio) => selector.includes(`value="${radio.value}"`)),
    querySelectorAll: (selector) => selector === "button" ? [...nodes.values()].filter((node) => node.tag === "button") : radios,
  };
  const context = vm.createContext({ document, window: bridge ? { beezilla: { settings: bridge } } : {}, navigator: {}, console: quiet });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "execute the whole actual Settings script");
  vm.runInContext(scripts[0][1], context);
  return { nodes, render: (value) => { context.nextState = value; vm.runInContext("renderStatus(nextState)", context); },
    click: () => nodes.get("connect-account").listeners.click(),
    idle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("capability is scoped, non-secret and disabled only by the exact opt-out", () => {
  for (const flag of [undefined, "", "0", "true", " 1", "1 "]) {
    assert.deepEqual(managedAccountConnectCapability({ BZ_CONNECT_DISABLED: flag, PRIVATE_KEY: "must-not-leak" }), enabled);
  }
  assert.deepEqual(managedAccountConnectCapability({ BZ_CONNECT_DISABLED: "1", PRIVATE_KEY: "must-not-leak" }), disabled);
  assert.match(disabledReason, /account connection.*disabled.*BZ_CONNECT_DISABLED=1/);
  assert.doesNotMatch(disabledReason, /offline|air.gap|all.*network|lockdown/i);
});

test("Settings IPC rejects Connect before any account side effects, regardless of renderer payload", async () => {
  const ctx = await mainFixture("1");
  const bridge = preloadFixture((channel, payload) => ctx.ipc.get(channel)(ctx.event, payload));
  for (const invoke of [
    () => bridge.settings.connect(),
    () => ctx.ipc.get("beezilla:settings:connect")(ctx.event, { enabled: true, BZ_CONNECT_DISABLED: "0", capabilities: state().capabilities }),
    () => ctx.api.connectManagedAccount(),
  ]) {
    ctx.trace.length = 0;
    const result = await invoke();
    assert.deepEqual(ctx.trace, ["flag"], "no cloud URL, session, window, mint, identity or credential access before refusal");
    const outcome = result.data ?? result;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "connect_disabled");
    assert.equal(outcome.error, disabledReason);
  }
});

test("disabled command refuses before joining an existing in-flight connection", async () => {
  const ctx = await mainFixture("1");
  ctx.api.pending(Promise.resolve({ ok: true, token: "never-return-this" }));
  const result = await ctx.api.connectManagedAccount();
  assert.equal(result.code, "connect_disabled");
  assert.deepEqual(ctx.trace, ["flag"]);
});

test("menu mirrors the capability but forced callback still reaches the main guard", async () => {
  const ctx = await mainFixture("1");
  ctx.api.installMenu();
  const item = ctx.menu[0].submenu.find((entry) => entry.label === "Connect BeeZilla account…");
  assert.equal(item.enabled, false);
  ctx.trace.length = 0;
  item.click();
  await Promise.resolve();
  assert.deepEqual(ctx.trace, ["flag"]);
});

for (const flag of [undefined, "0"]) {
  test(`default desktop Connect remains available (${flag ?? "unset"}) and deduplicated`, async () => {
    const pending = deferred();
    const ctx = await mainFixture(flag, () => pending.promise);
    ctx.api.installMenu();
    assert.equal(ctx.menu[0].submenu.find((item) => item.label === "Connect BeeZilla account…").enabled, true);
    ctx.trace.length = 0;
    const first = ctx.api.connectManagedAccount();
    const second = ctx.api.connectManagedAccount();
    assert.equal(first, second);
    pending.resolve({ ok: false, error: "fixture canceled" });
    assert.deepEqual(plain(await first), { ok: false, error: "fixture canceled" });
    assert.equal(ctx.trace.filter((item) => item === "connect-account").length, 1);
    assert.equal(ctx.trace.filter((item) => item === "window").length, 1);
    assert.equal(ctx.trace[0], "flag");
  });
}

test("untrusted and subframe IPC callers remain rejected even when Connect is enabled", async () => {
  const ctx = await mainFixture(undefined);
  for (const event of [{}, { ...ctx.event, senderFrame: { url: `${base}/buzzy/settings` } }]) {
    const result = await ctx.ipc.get("beezilla:settings:connect")(event);
    assert.equal(result.ok, false);
    assert.match(result.error, /only from the BeeZilla app window/);
  }
  assert.deepEqual(ctx.trace, [], "untrusted IPC cannot reach the command at all");
});

test("Settings status adds only the scoped capability; stored credentials and BYOK remain usable", async () => {
  const ctx = await mainFixture("1");
  const get = async () => plain((await ctx.ipc.get("beezilla:settings:get")(ctx.event)).data);
  assert.deepEqual((await get()).capabilities, { managedAccountConnect: disabled });
  const saved = await ctx.handlers.saveInference({ provider: "byok", key: "fixture-only" });
  assert.equal(saved.status.inference.provider, "byok");
  assert.equal(saved.status.capabilities.managedAccountConnect.enabled, false);
  await ctx.handlers.saveSearch({ key: "fixture-only" });
  await ctx.handlers.saveMusic({ key: "fixture-only" });
  await ctx.handlers.saveInference({ provider: "beezilla", key: "already-issued-fixture" });
  assert.equal((await get()).inference.provider, "beezilla", "flag does not revoke or disable stored managed credentials");
  const cleared = await ctx.handlers.clear("inference");
  assert.equal(cleared.status.inference, null);
  assert.equal(cleared.status.capabilities.managedAccountConnect.enabled, false);
  assert.ok(!ctx.trace.includes("connect-account"));
  ctx.setFlag(undefined);
  assert.deepEqual((await get()).capabilities, { managedAccountConnect: enabled });
});

test("renderer starts disabled and does not invoke Connect before status arrives", async () => {
  const pending = deferred();
  let calls = 0;
  const page = rendererFixture({ get: () => pending.promise, connect: () => { calls++; } });
  assert.equal(page.nodes.get("connect-account").disabled, true);
  await page.click();
  assert.equal(calls, 0);
  pending.resolve({ ok: true, data: state(disabled) });
  await page.idle();
  assert.equal(page.nodes.get("connect-account").disabled, true);
  assert.equal(page.nodes.get("connect-account").hidden, false);
  assert.equal(page.nodes.get("managed-fields").hidden, false);
  assert.equal(page.nodes.get("connect-hint").textContent, disabledReason);
  await page.click();
  assert.equal(calls, 0);
  assert.match(page.nodes.get("inference-current").innerHTML, /connection is disabled/);
  assert.doesNotMatch(page.nodes.get("search-current").innerHTML, /Connect your account/);
});

test("renderer preserves default enabled behavior and blocks repeated clicks during Connect", async () => {
  const pending = deferred();
  let calls = 0;
  const page = rendererFixture({ get: async () => ({ ok: true, data: state() }), connect: () => { calls++; return pending.promise; } });
  await page.idle();
  assert.equal(page.nodes.get("connect-account").disabled, false);
  const first = page.click();
  page.render(state()); // An independent status refresh must not enable a busy control.
  assert.equal(page.nodes.get("connect-account").disabled, true);
  await page.click();
  assert.equal(calls, 1);
  pending.resolve({ ok: true, data: { ok: true } });
  await first;
  assert.equal(page.nodes.get("connect-account").disabled, false);
  assert.equal(page.nodes.get("connect-hint").textContent, "Connected.");
});

test("main refusal replaces a frozen stale enabled UI snapshot and finally never re-enables it", async () => {
  const snapshot = Object.freeze(state(Object.freeze({ ...enabled })));
  Object.freeze(snapshot.capabilities);
  const page = rendererFixture({ get: async () => ({ ok: true, data: snapshot }), connect: async () => ({ ok: true, data: { ok: false, code: "connect_disabled", error: disabledReason } }) });
  await page.idle();
  await page.click();
  assert.equal(page.nodes.get("connect-account").disabled, true);
  assert.equal(page.nodes.get("connect-hint").textContent, disabledReason);
  assert.equal(snapshot.capabilities.managedAccountConnect.enabled, true, "bridge snapshot is unchanged");
});

test("status changes during Connect stay disabled after failure and preserve the reason", async () => {
  const pending = deferred();
  const page = rendererFixture({ get: async () => ({ ok: true, data: state() }), connect: () => pending.promise });
  await page.idle();
  const first = page.click();
  page.render(state(disabled, { searchNeedsReconnect: true }));
  pending.resolve({ ok: true, data: { ok: false, error: disabledReason } });
  await first;
  assert.equal(page.nodes.get("connect-account").disabled, true);
  assert.equal(page.nodes.get("connect-hint").textContent, disabledReason);
  assert.doesNotMatch(page.nodes.get("search-current").innerHTML, /Connect your account again/);
});

test("a successful in-flight Connect cannot hide a newly disabled capability", async () => {
  let snapshot = state();
  const pending = deferred();
  const page = rendererFixture({ get: async () => ({ ok: true, data: snapshot }), connect: () => pending.promise });
  await page.idle();
  const first = page.click();
  snapshot = state(disabled);
  pending.resolve({ ok: true, data: { ok: true } });
  await first;
  assert.equal(page.nodes.get("connect-account").disabled, true);
  assert.equal(page.nodes.get("connect-hint").textContent, disabledReason);
});

for (const response of [{ ok: false, error: "unavailable" }, { ok: true, data: {} }]) {
  test(`missing capability or failed Settings read cannot enable Connect (${response.ok})`, async () => {
    const page = rendererFixture({ get: async () => response, connect: () => assert.fail("must not invoke") });
    await page.idle();
    assert.equal(page.nodes.get("connect-account").disabled, true);
    assert.match(page.nodes.get("connect-hint").textContent, /unavailable/);
    await page.click();
  });
}

test("connection transport errors release busy state and hosted/no-bridge Settings remains disabled", async () => {
  const page = rendererFixture({ get: async () => ({ ok: true, data: state() }), connect: async () => { throw new Error("fixture failure"); } });
  await page.idle();
  await page.click();
  assert.equal(page.nodes.get("connect-account").disabled, false);
  assert.match(page.nodes.get("connect-hint").textContent, /Could not connect/);
  const hosted = rendererFixture(null);
  assert.equal(hosted.nodes.get("connect-account").disabled, true);
  assert.match(hosted.nodes.get("connect-hint").textContent, /only inside.*desktop/);
  assert.equal(hosted.nodes.get("nobridge").style.display, "block");
});

test("all current account entry paths use the guarded command, packaged modules and CI include the regression", () => {
  const main = read("desktop/main.mjs");
  assert.equal((main.match(/performConnect\(/g) ?? []).length, 2, "one declaration and one guarded call; no entry path calls the implementation directly");
  assert.match(main, /settings:connect", wrap\(\(\) => connectManagedAccount\(\)\)/);
  assert.match(main, /const outcome = await connectManagedAccount\(\)/, "native connect hook uses the guarded command");
  const pkg = JSON.parse(read("package.json"));
  const desktop = JSON.parse(read("desktop/package.json"));
  assert.match(pkg.scripts["test:desktop-boundaries"], /test-desktop-connect-guard\.mjs/);
  for (const file of ["main.mjs", "settings.mjs", "connect.mjs", "preload.cjs"]) assert.ok(desktop.build.files.includes(file));
});
