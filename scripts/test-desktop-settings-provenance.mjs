/**
 * Settings provenance across the actual main/IPC/preload restart lifecycle.
 * Node built-ins only, synthetic credentials and disposable stores. Electron,
 * Keychain, runtime processes and timers are doubles: no app or network launch.
 * Run: node --experimental-vm-modules --test scripts/test-desktop-settings-provenance.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import vm from "node:vm";
import test from "node:test";
import * as security from "../desktop/security.mjs";
import { createLibraryTransition, canonicalRecord, LEGACY_KEY, PENDING_PREFIX } from "../desktop/library-vault.mjs";
import * as connect from "../desktop/connect.mjs";
import { saveInference } from "./lib/inference.mjs";

const ROOT = process.env.BZ_SETTINGS_PROVENANCE_BASELINE_DIR
  ? path.resolve(process.env.BZ_SETTINGS_PROVENANCE_BASELINE_DIR)
  : url.fileURLToPath(new URL("../", import.meta.url));
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const quiet = { log() {}, warn() {}, error() {} };
const keys = ["BZ_CHAT_KEY", "BZ_CHAT_BASE_URL", "BZ_CHAT_MODEL"];
const byok = { provider: "byok", key: "synthetic-key-byok-1234567890", baseUrl: "https://byok.example/v1", model: "fixture-model" };
const managed = { provider: "beezilla", key: "synthetic-key-managed-1234567890", baseUrl: "https://gateway.example/v1", model: "managed-model", expiresAt: "2099-01-01T00:00:00.000Z" };

function syntheticCipher() {
  let failing = false;
  return {
    // Reversible test fixture only; no real secure-storage or credentials.
    encrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decrypt: (value) => {
      if (failing) throw new Error("synthetic secure storage unavailable");
      return Buffer.from(value).map((byte) => byte ^ 0xa5).toString();
    },
    fail: () => { failing = true; },
  };
}

async function fixture(t, { env: initialEnv = {}, stored = null, dir: existingDir, libraryStorage = new Map(), libraryFetch = null } = {}) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(tmpdir(), "bz-settings-provenance-"));
  const cipher = syntheticCipher();
  if (stored) saveInference(dir, stored, cipher);
  const env = { ...initialEnv }, logs = [], ipc = new Map(), starts = [], notifications = [], responses = [];
  let supervisor, now = Date.now(), stopFailure = false;
  const lifecycle = [], appEvents = new Map(), dialogs = [];
  class FixtureDate extends Date { static now() { return now; } }
  const unexpected = (name) => () => { throw new Error(`Unexpected fixture effect: ${name}`); };
  class FakeSupervisor {
    constructor() { supervisor = this; this.dataDir = dir; this.runtime = null; }
    async isHealthy(value) { assert.equal(value, this.runtime); return Boolean(value); }
    async stop() { lifecycle.push("stop"); if (stopFailure) throw new Error("synthetic safe-stop failure"); this.runtime = null; }
    async start() {
      lifecycle.push("start");
      this.runtime = { host: "127.0.0.1", port: 7331 + starts.length, token: String(starts.length).repeat(43) };
      starts.push({ runtime: this.runtime, env: { ...env } });
      return this.runtime;
    }
  }
  const context = vm.createContext({
    Buffer, URL, Date: FixtureDate, process: { env, on() {}, platform: "fixture" },
    console: Object.fromEntries(["log", "warn", "error"].map((name) => [name, (...args) => logs.push(args.join(" "))])),
    setTimeout: unexpected("main timer"), fetch: unexpected("network"),
  });
  const mocks = {
    electron: {
      app: { getVersion: () => "test", commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
        on(name, fn) { appEvents.set(name, fn); }, whenReady: () => new Promise(() => {}), exit: () => lifecycle.push("exit"), quit: unexpected("app quit") },
      BrowserWindow: unexpected("native window"), Menu: {}, session: {},
      shell: { openExternal: unexpected("external page"), openPath: unexpected("open path") },
      dialog: { showErrorBox: (...args) => dialogs.push(args) },
      safeStorage: { encryptString: cipher.encrypt, decryptString: cipher.decrypt },
      ipcMain: { handle: (name, fn) => ipc.set(name, fn) }, systemPreferences: {},
    },
    "node:fs": fs, "node:path": path, "node:url": url,
    "./supervisor.mjs": { RuntimeSupervisor: FakeSupervisor },
    "./logger.mjs": { installLogging() {}, logLine() {}, logPaths: () => ({}) },
    "./connect.mjs": { ...connect, managedAccountConnectCapability: () => connect.managedAccountConnectCapability?.(env), connectAccount: unexpected("Connect"), cloudBaseUrl: unexpected("cloud URL") },
    "./csp.mjs": { createDesktopCsp: unexpected("CSP install"), loadCspManifest: unexpected("manifest") },
    "./security.mjs": security,
    "./library-vault.mjs": { createLibraryTransition: (deps) => createLibraryTransition({ ...deps, fetchImpl: libraryFetch ?? unexpected("Library network") }) },
  };
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    let mod;
    if (mocks[name]) {
      const values = mocks[name];
      mod = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [field, value] of Object.entries(values)) this.setExport(field, value);
      }, { context });
    } else {
      assert.ok(name === "./settings.mjs" || /^scripts\/lib\/(inference|music-keys|search-keys)\.mjs$/.test(name), `Unexpected module ${name}`);
      mod = new vm.SourceTextModule(read(name === "./settings.mjs" ? "desktop/settings.mjs" : name), { context });
    }
    modules.set(name, mod);
    return mod;
  }
  async function evaluated(name) {
    const mod = await load(name);
    if (mod.status === "unlinked") await mod.link(load);
    if (mod.status !== "evaluated") await mod.evaluate();
    return mod;
  }
  mocks["./paths.mjs"] = { ROOT, runtimeLib: async (name) => (await evaluated(name)).namespace };
  const main = new vm.SourceTextModule(read("desktop/main.mjs") + `
export const testApi = {
  initialize: async (main, settings) => {
    mainWindow = main; settingsWindow = settings;
    guardLibraryWindowClose(main); guardLibraryWindowClose(settings);
    await applyStoredInferenceToEnv();
    settingsHandlers = await registerSettingsIpc();
    bindRuntime(await supervisor.start());
  },
  reapply: applyStoredInferenceToEnv,
  authHeaders: (details) => runtimeAuth.headers(details)
};`, {
    context, initializeImportMeta(meta) { meta.url = url.pathToFileURL(path.join(ROOT, "desktop/main.mjs")).href; },
    importModuleDynamically: evaluated,
  });
  await main.link(load);
  await main.evaluate();
  function windowFixture(id, route) {
    let bridge;
    const timers = [], ipcRenderer = new EventEmitter();
    const historyWindow = {}, windowEvents = new Map();
    let destroyed = false;
    const historyStorage = { get length() { return libraryStorage.size; }, getItem: (key) => libraryStorage.get(key) ?? null,
      key: (i) => [...libraryStorage.keys()][i] ?? null, setItem: (key,value) => libraryStorage.set(key,String(value)), removeItem: (key) => libraryStorage.delete(key) };
    const wc = {
      executeJavaScript: async (code) => vm.runInNewContext(code, { window: historyWindow, localStorage: historyStorage }),
      id, mainFrame: { url: `http://127.0.0.1:7331${route}` },
      getURL() { return this.mainFrame.url; }, isDestroyed: () => destroyed,
      send(channel, payload) { notifications.push({ id, channel, payload }); ipcRenderer.emit(channel, {}, payload); },
    };
    ipcRenderer.invoke = async (channel, payload) => {
      const result = await ipc.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, payload);
      responses.push({ channel, result });
      // contextBridge returns an immutable data snapshot, not main's live object.
      const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      return freeze(plain(result));
    };
    vm.runInNewContext(read("desktop/preload.cjs"), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer }),
      process: { isMainFrame: true }, URL,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      window: { location: { replace: (value) => { wc.mainFrame.url = value; } } },
    });
    return { webContents: wc, isDestroyed: () => destroyed, bridge, historyWindow,
      on: (name,fn) => windowEvents.set(name,fn),
      close: () => { let prevented = false; windowEvents.get("close")?.({preventDefault: () => { prevented=true; }}); if (!prevented) { destroyed=true; lifecycle.push("closed"); } },
      flush: () => { while (timers.length) timers.shift()(); } };
  }
  const mainWindow = windowFixture(1, "/buzzy/talk?existing=1#chat");
  const settingsWindow = windowFixture(2, "/buzzy/settings");
  await main.namespace.testApi.initialize(mainWindow, settingsWindow);
  const result = {
    dir, env, cipher, starts, notifications, responses, lifecycle, dialogs, appEvents, libraryStorage,
    setStopFailure: (value) => { stopFailure = value; }, api: main.namespace.testApi,
    bridge: settingsWindow.bridge.settings, mainWindow, settingsWindow,
    flush: () => { mainWindow.flush(); settingsWindow.flush(); },
    status: async () => {
      const res = await settingsWindow.bridge.settings.get();
      assert.equal(res.ok, true); return res.data;
    },
    sharedResolve: () => modules.get("scripts/lib/inference.mjs").namespace.resolveInference(dir, cipher),
    runtime: () => supervisor.runtime,
    setNow: (value) => { now = value; },
  };
  t.after(() => {
    if (!existingDir) fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(logs.some((line) => line.includes("synthetic-key-")), false, "no credential reaches logs");
    assert.equal(JSON.stringify(responses).includes("synthetic-key-"), false, "no raw credential or provenance proof reaches IPC");
  });
  return result;
}

function renderer(bridge) {
  const html = read("public/buzzy/settings.html");
  const nodes = new Map([...html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map((match) => {
    const [, tag, attrs, id] = match;
    const classes = new Set((/\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/));
    return [id, { id, tag, hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs),
      checked: /\bchecked\b/.test(attrs), value: /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? "", textContent: "", innerHTML: "", style: {},
      listeners: {}, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
      setAttribute() {}, removeAttribute() {}, addEventListener(name, fn) { this.listeners[name] = fn; }, querySelectorAll: () => [],
    }];
  }));
  const radios = [nodes.get("provider-beezilla"), nodes.get("provider-byok")];
  for (const radio of radios) {
    let checked = radio.checked;
    Object.defineProperty(radio, "checked", { get: () => checked, set(value) {
      checked = value;
      if (value) for (const other of radios) if (other !== radio) other.checked = false;
    } });
  }
  nodes.get("byok-fields").querySelectorAll = () => ["key", "baseUrl", "model"].map((id) => nodes.get(id));
  const document = {
    getElementById: (id) => { assert.ok(nodes.has(id), `Unknown Settings element ${id}`); return nodes.get(id); },
    querySelector: (selector) => selector.endsWith(":checked") ? radios.find((radio) => radio.checked)
      : radios.find((radio) => selector.includes(`value="${radio.value}"`)),
    querySelectorAll: (selector) => selector === "button" ? [...nodes.values()].filter((node) => node.tag === "button") : radios,
  };
  const context = vm.createContext({ document, window: { beezilla: { settings: bridge } }, navigator: {}, console: quiet });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  vm.runInContext(scripts[0][1], context);
  return { nodes, idle: () => new Promise((resolve) => setImmediate(resolve)),
    refresh: () => vm.runInContext("refresh()", context),
    render: (state) => { context.nextState = state; vm.runInContext("renderStatus(nextState)", context); },
    select: (provider) => { const node = nodes.get(`provider-${provider}`); node.checked = true; node.listeners.change(); },
    click: (id) => nodes.get(id).listeners.click(),
  };
}

function checkStored(state, expected) {
  const inf = state.inference;
  assert.equal(inf.provider, expected.provider);
  assert.equal(inf.source, "store");
  assert.equal(inf.encrypted, true);
  assert.equal(inf.baseUrl, expected.baseUrl || null);
  assert.equal(inf.model, expected.model || null);
  assert.equal(inf.expiresAt, expected.expiresAt ?? null);
  assert.equal(state.inferenceRemovable, true);
  assert.equal(JSON.stringify(state).includes(expected.key), false);
}
function checkByokForm(ui, expected) {
  assert.equal(ui.nodes.get("provider-byok").checked, true);
  assert.equal(ui.nodes.get("provider-beezilla").checked, false);
  assert.equal(ui.nodes.get("byok-fields").classList.contains("locked"), false);
  for (const id of ["key", "baseUrl", "model"]) assert.equal(ui.nodes.get(id).disabled, false, id);
  assert.equal(ui.nodes.get("baseUrl").value, expected.baseUrl || "");
  assert.equal(ui.nodes.get("model").value, expected.model || "");
  assert.equal(ui.nodes.get("key").value, "", "raw key never repopulates the input");
}

test("Save through actual main/preload preserves BYOK after restart, refreshed page and new main process", async (t) => {
  const fx = await fixture(t);
  const ui = renderer(fx.bridge);
  await ui.idle();
  assert.equal(ui.nodes.get("clear-inference").disabled, true);
  ui.select("byok");
  for (const [id, value] of Object.entries({ key: byok.key, baseUrl: byok.baseUrl, model: byok.model })) ui.nodes.get(id).value = value;
  await ui.click("save-inference");
  checkStored(fx.responses.at(-1).result.data.status, byok);
  checkByokForm(ui, byok);
  assert.match(ui.nodes.get("inference-status").textContent, /Saved.*restarted/);
  assert.equal(fx.starts.length, 2);
  assert.notEqual(fx.starts[0].runtime.port, fx.starts[1].runtime.port);
  assert.notEqual(fx.starts[0].runtime.token, fx.starts[1].runtime.token);
  assert.equal(fx.starts[1].env.BZ_CHAT_KEY, byok.key);
  assert.equal(fx.sharedResolve().provider, "env", "shared CLI precedence/classification is unchanged");
  assert.equal(fx.notifications.length, 2, "both windows receive the new endpoint");
  assert.equal(fx.settingsWindow.webContents.getURL(), "http://127.0.0.1:7331/buzzy/settings", "preload waits for reply before navigation");
  fx.flush();
  assert.equal(fx.mainWindow.webContents.getURL(), "http://127.0.0.1:7332/buzzy/talk?existing=1#chat");
  assert.equal(fx.settingsWindow.webContents.getURL(), "http://127.0.0.1:7332/buzzy/settings");
  const refreshed = renderer(fx.bridge);
  await refreshed.idle();
  checkByokForm(refreshed, byok);
  assert.equal(fs.readFileSync(path.join(fx.dir, "inference.json"), "utf8").includes(byok.key), false);
  const relaunched = await fixture(t, { dir: fx.dir });
  checkStored(await relaunched.status(), byok);
  const relaunchedUi = renderer(relaunched.bridge);
  await relaunchedUi.idle();
  checkByokForm(relaunchedUi, byok);
});

test("stored managed inference keeps provider, encryption and expiry metadata after injection and refresh", async (t) => {
  const fx = await fixture(t, { stored: managed });
  checkStored(await fx.status(), managed);
  const ui = renderer(fx.bridge);
  await ui.idle();
  assert.equal(ui.nodes.get("provider-beezilla").checked, true);
  assert.equal(ui.nodes.get("byok-fields").classList.contains("locked"), true);
  assert.match(ui.nodes.get("inference-current").innerHTML, /BeeZilla inference/);
  assert.equal(fx.env.BZ_MUSIC_VIA_GATEWAY, managed.baseUrl);
  assert.equal((await fx.status()).inference.expired, false);
  await ui.refresh();
  checkStored(await fx.status(), managed);
});

test("expired managed store refuses injection, retains reconnect metadata, and Remove clears expiry", async (t) => {
  const expired = { ...managed, expiresAt: "2000-01-01T00:00:00.000Z" };
  const fx = await fixture(t, { stored: expired });
  assert.equal(fx.env.BZ_CHAT_KEY, undefined);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, "1");
  assert.equal(fx.env.BZ_MUSIC_VIA_GATEWAY, undefined);
  checkStored(await fx.status(), expired);
  assert.equal((await fx.status()).inference.expired, true);
  const removed = await fx.bridge.clear("inference");
  assert.equal(removed.ok, true);
  assert.equal(removed.data.status.inference, null);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, undefined);
});

for (const stored of [byok, { ...managed, expiresAt: "2000-01-01T00:00:00.000Z" }]) {
  test(`genuine environment key wins over ${stored.provider}, Save and Remove without being relabeled`, async (t) => {
    const override = { BZ_CHAT_KEY: "synthetic-key-environment-1234567890", BZ_CHAT_BASE_URL: "https://override.example/v1", BZ_CHAT_MODEL: "override-model" };
    const fx = await fixture(t, { env: override, stored });
    for (const action of [() => fx.status(), async () => (await fx.bridge.saveInference(byok)).data.status, async () => (await fx.bridge.clear("inference")).data.status]) {
      const state = await action();
      for (const name of keys) assert.equal(fx.env[name], override[name]);
      assert.equal(state.inference.provider, "env");
      assert.equal(state.inference.source, "env");
      assert.equal(state.inference.encrypted, null);
      assert.equal(state.inference.expiresAt, null);
      assert.equal(state.inference.expired, false);
      assert.equal(fx.env.BZ_MANAGED_EXPIRED, undefined);
      assert.equal(JSON.stringify(state).includes(override.BZ_CHAT_KEY), false);
      fx.flush();
    }
    const ui = renderer(fx.bridge);
    await ui.idle();
    assert.match(ui.nodes.get("inference-current").innerHTML, /environment key.*overrides saved settings/);
    assert.equal(ui.nodes.get("clear-inference").disabled, true, "Remove cannot delete an environment key");
  });
}

test("even an identical explicit key is not proof of stored provenance", async (t) => {
  const fx = await fixture(t, { stored: managed, env: { BZ_CHAT_KEY: managed.key } });
  const state = await fx.status();
  assert.equal(state.inference.provider, "env");
  assert.equal(state.inference.source, "env");
  assert.equal(fx.env.BZ_CHAT_KEY, managed.key);
  assert.equal(fx.env.BZ_MUSIC_VIA_GATEWAY, undefined);
});

test("stored-key provenance preserves genuine endpoint/model overrides through replacement and Remove", async (t) => {
  const override = { BZ_CHAT_BASE_URL: "https://override.example/v1", BZ_CHAT_MODEL: "override-model" };
  const fx = await fixture(t, { stored: byok, env: override });
  checkStored(await fx.status(), { ...byok, baseUrl: override.BZ_CHAT_BASE_URL, model: override.BZ_CHAT_MODEL });
  const replacement = await fx.bridge.saveInference({ ...byok, key: "synthetic-key-next-1234567890", baseUrl: "", model: "" });
  assert.equal(replacement.ok, true);
  for (const [name, value] of Object.entries(override)) assert.equal(fx.env[name], value);
  fx.flush();
  const cleared = await fx.bridge.clear("inference");
  assert.equal(cleared.data.status.inference, null);
  assert.equal(fx.env.BZ_CHAT_KEY, undefined);
  for (const [name, value] of Object.entries(override)) assert.equal(fx.env[name], value);
});

test("provenance fails closed if the current store or applied environment no longer matches", async (t) => {
  for (const changed of ["provider", "key", "baseUrl", "model", "encrypted", "expiresAt", "updatedAt", "environment"]) {
    const fx = await fixture(t, { stored: byok });
    if (changed === "environment") fx.env.BZ_CHAT_MODEL = "external-model-change";
    else {
      const file = path.join(fx.dir, "inference.json");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (changed === "key") data.keyCipher = Buffer.from(fx.cipher.encrypt("synthetic-key-changed-1234567890")).toString("base64");
      else if (changed === "encrypted") { data.encrypted = false; data.keyCipher = byok.key; }
      else data[changed] = changed === "provider" ? "beezilla" : "changed";
      fs.writeFileSync(file, JSON.stringify(data));
    }
    assert.equal((await fx.status()).inference.provider, "env", changed);
  }
});

test("Remove clears injected key, optional values and form values, including on a fresh page", async (t) => {
  const fx = await fixture(t, { stored: byok });
  const ui = renderer(fx.bridge);
  await ui.idle();
  checkByokForm(ui, byok);
  await ui.click("clear-inference");
  assert.equal(fs.existsSync(path.join(fx.dir, "inference.json")), false);
  for (const name of keys) assert.equal(fx.env[name], undefined);
  assert.equal(fx.responses.at(-1).result.data.status.inference, null);
  assert.equal(ui.nodes.get("clear-inference").disabled, true);
  assert.equal(ui.nodes.get("baseUrl").value, "");
  assert.equal(ui.nodes.get("model").value, "");
  fx.flush();
  const refreshed = renderer(fx.bridge);
  await refreshed.idle();
  assert.equal(refreshed.nodes.get("clear-inference").disabled, true);
  assert.equal(refreshed.nodes.get("baseUrl").value, "");
  assert.equal(refreshed.nodes.get("model").value, "");
});

test("replacement with blank fields removes stale endpoint/model in the same and refreshed form", async (t) => {
  const fx = await fixture(t, { stored: byok });
  const ui = renderer(fx.bridge);
  await ui.idle();
  const next = { ...byok, key: "synthetic-key-blank-fields-1234567890", baseUrl: "", model: "" };
  const result = await fx.bridge.saveInference(next);
  ui.render(result.data.status);
  checkStored(result.data.status, next);
  checkByokForm(ui, next);
  fx.flush();
  const refreshed = renderer(fx.bridge);
  await refreshed.idle();
  checkByokForm(refreshed, next);
});

test("unreadable store clears injection and never preserves stale metadata", async (t) => {
  const fx = await fixture(t, { stored: byok });
  fx.cipher.fail();
  await fx.api.reapply();
  for (const name of keys) assert.equal(fx.env[name], undefined);
  assert.equal((await fx.status()).inference, null);
});


test("managed expiry is recomputed after injection instead of lost behind the env classification", async (t) => {
  const fx = await fixture(t, { stored: managed });
  assert.equal((await fx.status()).inference.expired, false);
  fx.setNow(Date.parse(managed.expiresAt) + 1);
  const state = await fx.status();
  checkStored(state, managed);
  assert.equal(state.inference.expired, true);
  await fx.api.reapply();
  assert.equal(fx.env.BZ_CHAT_KEY, undefined);
  assert.equal(fx.env.BZ_MUSIC_VIA_GATEWAY, undefined);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, "1");
  assert.equal((await fx.status()).inference.expired, true);
});

test("an environment value changed after injection is not erased by the next Remove", async (t) => {
  const fx = await fixture(t, { stored: byok });
  const override = "synthetic-key-later-override-1234567890";
  fx.env.BZ_CHAT_KEY = override;
  assert.equal((await fx.status()).inference.provider, "env");
  const removed = await fx.bridge.clear("inference");
  assert.equal(removed.ok, true);
  assert.equal(fx.env.BZ_CHAT_KEY, override);
  assert.equal(removed.data.status.inference.provider, "env");
  assert.equal(removed.data.status.inferenceRemovable, false);
});


for (const failure of ["decrypt", "malformed", "missing"]) {
  test(`Remove remains available when an active owned credential becomes ${failure} before reapply`, async (t) => {
    const fx = await fixture(t, { stored: byok });
    const file = path.join(fx.dir, "inference.json");
    if (failure === "decrypt") fx.cipher.fail();
    else if (failure === "malformed") fs.writeFileSync(file, "not JSON");
    else fs.rmSync(file);
    assert.equal(fx.env.BZ_CHAT_KEY, byok.key);
    const state = await fx.status();
    assert.equal(state.inference.provider, "env", "strict provenance is not weakened for removal");
    assert.equal(state.inferenceRemovable, true);
    const ui = renderer(fx.bridge);
    await ui.idle();
    assert.equal(ui.nodes.get("clear-inference").disabled, false);
    await ui.click("clear-inference");
    assert.equal(fx.env.BZ_CHAT_KEY, undefined);
    assert.equal(fs.existsSync(file), false);
    assert.equal(ui.nodes.get("clear-inference").disabled, true);
    fx.flush();
    const refreshed = renderer(fx.bridge);
    await refreshed.idle();
    assert.equal(refreshed.nodes.get("clear-inference").disabled, true);
  });
}

test("a damaged file remains removable with no active key, while environment-only keys do not", async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.dir, "inference.json");
  fs.writeFileSync(file, "not JSON");
  const state = await fx.status();
  assert.equal(state.inference, null);
  assert.equal(state.inferenceRemovable, true);
  const ui = renderer(fx.bridge);
  await ui.idle();
  assert.match(ui.nodes.get("inference-current").innerHTML, /Saved credential unavailable/);
  ui.select("byok");
  assert.match(ui.nodes.get("inference-current").innerHTML, /Saved credential unavailable/);
  assert.equal(ui.nodes.get("clear-inference").disabled, false);
  await ui.click("clear-inference");
  assert.equal(fs.existsSync(file), false);
  assert.equal(ui.nodes.get("clear-inference").disabled, true);
  const envOnly = await fixture(t, { env: { BZ_CHAT_KEY: "synthetic-key-environment-only-1234567890" } });
  assert.equal((await envOnly.status()).inferenceRemovable, false);
  const envUi = renderer(envOnly.bridge);
  await envUi.idle();
  assert.equal(envUi.nodes.get("clear-inference").disabled, true);
});

test("a key-only environment override keeps the shared stored endpoint/model fallback until Remove", async (t) => {
  const key = "synthetic-key-only-environment-1234567890";
  const fx = await fixture(t, { stored: byok, env: { BZ_CHAT_KEY: key } });
  const state = await fx.status();
  assert.equal(state.inference.provider, "env");
  assert.equal(state.inference.source, "env");
  assert.equal(state.inference.baseUrl, byok.baseUrl);
  assert.equal(state.inference.model, byok.model);
  assert.equal(fx.starts[0].env.BZ_CHAT_KEY, key);
  assert.equal(fx.starts[0].env.BZ_CHAT_BASE_URL, byok.baseUrl);
  assert.equal(fx.starts[0].env.BZ_CHAT_MODEL, byok.model);
  const removed = await fx.bridge.clear("inference");
  assert.equal(removed.data.status.inference.provider, "env");
  assert.equal(removed.data.status.inference.baseUrl, null);
  assert.equal(removed.data.status.inference.model, null);
  assert.equal(fx.env.BZ_CHAT_KEY, key);
  assert.equal(fx.env.BZ_CHAT_BASE_URL, undefined);
  assert.equal(fx.env.BZ_CHAT_MODEL, undefined);
});

test("endpoint/model-only overrides preserve managed key provenance and expiry", async (t) => {
  const override = { BZ_CHAT_BASE_URL: "https://managed-override.example/v1", BZ_CHAT_MODEL: "managed-override-model" };
  const fx = await fixture(t, { stored: managed, env: override });
  const expected = { ...managed, baseUrl: override.BZ_CHAT_BASE_URL, model: override.BZ_CHAT_MODEL };
  checkStored(await fx.status(), expected);
  assert.equal(fx.env.BZ_CHAT_KEY, managed.key);
  for (const [name, value] of Object.entries(override)) assert.equal(fx.starts[0].env[name], value);
  fx.setNow(Date.parse(managed.expiresAt) + 1);
  assert.equal((await fx.status()).inference.expired, true);
  await fx.api.reapply();
  assert.equal(fx.env.BZ_CHAT_KEY, undefined);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, "1");
  checkStored(await fx.status(), expected);
  const removed = await fx.bridge.clear("inference");
  assert.equal(removed.data.status.inference, null);
  for (const [name, value] of Object.entries(override)) assert.equal(fx.env[name], value);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, undefined);
});

test("disabled Connect capability survives actual BYOK Save, refreshed Settings and Remove", async (t) => {
  const fx = await fixture(t, { env: { BZ_CONNECT_DISABLED: "1" } });
  assert.equal((await fx.status()).capabilities.managedAccountConnect.enabled, false);
  const denied = await fx.bridge.connect();
  assert.equal(denied.ok, true);
  assert.equal(denied.data.ok, false);
  assert.equal(denied.data.code, "connect_disabled");
  const ui = renderer(fx.bridge);
  await ui.idle();
  assert.equal(ui.nodes.get("connect-account").disabled, true);
  ui.select("byok");
  for (const [id, value] of Object.entries({ key: byok.key, baseUrl: byok.baseUrl, model: byok.model })) ui.nodes.get(id).value = value;
  await ui.click("save-inference");
  const saved = fx.responses.at(-1).result.data.status;
  checkStored(saved, byok);
  assert.equal(saved.capabilities.managedAccountConnect.enabled, false);
  checkByokForm(ui, byok);
  fx.flush();
  const refreshed = renderer(fx.bridge);
  await refreshed.idle();
  checkByokForm(refreshed, byok);
  assert.equal(refreshed.nodes.get("connect-account").disabled, true);
  await refreshed.click("clear-inference");
  const cleared = fx.responses.at(-1).result.data.status;
  assert.equal(cleared.inference, null);
  assert.equal(cleared.inferenceRemovable, false);
  assert.equal(cleared.capabilities.managedAccountConnect.enabled, false);
  fx.flush();
  const removedPage = renderer(fx.bridge);
  await removedPage.idle();
  assert.equal(removedPage.nodes.get("clear-inference").disabled, true);
  assert.equal(removedPage.nodes.get("connect-account").disabled, true);
  assert.match(removedPage.nodes.get("connect-hint").textContent, /account connection.*disabled/i);
});

test("a key-only environment override retains expired managed endpoint/model fallback without managed expiry", async (t) => {
  const expired = { ...managed, expiresAt: "2000-01-01T00:00:00.000Z" };
  const key = "synthetic-key-expired-store-override-1234567890";
  const fx = await fixture(t, { stored: expired, env: { BZ_CHAT_KEY: key } });
  const state = await fx.status();
  const shared = fx.sharedResolve();
  assert.equal(state.inference.provider, "env");
  assert.equal(state.inference.source, "env");
  assert.equal(state.inference.baseUrl, expired.baseUrl);
  assert.equal(state.inference.model, expired.model);
  assert.equal(state.inference.expired, false);
  assert.equal(state.inference.expiresAt, null);
  assert.equal(shared.provider, "env");
  assert.equal(shared.baseUrl, state.inference.baseUrl);
  assert.equal(shared.model, state.inference.model);
  assert.equal(fx.starts[0].env.BZ_CHAT_KEY, key);
  assert.equal(fx.starts[0].env.BZ_CHAT_BASE_URL, expired.baseUrl);
  assert.equal(fx.starts[0].env.BZ_CHAT_MODEL, expired.model);
  assert.equal(fx.starts[0].env.BZ_MANAGED_EXPIRED, undefined);
  assert.equal(fx.starts[0].env.BZ_MUSIC_VIA_GATEWAY, undefined);
  const removed = await fx.bridge.clear("inference");
  assert.equal(removed.data.status.inference.provider, "env");
  assert.equal(removed.data.status.inference.baseUrl, null);
  assert.equal(removed.data.status.inference.model, null);
  assert.equal(fx.env.BZ_CHAT_KEY, key);
  assert.equal(fx.env.BZ_MANAGED_EXPIRED, undefined);
});

// Library saves participate in the real main/IPC lifecycle, not merely a
// source-order assertion. API storage is synthetic and contains no user data.
function historyApi({ events = [], fail = () => false, pause = null } = {}) {
  const rows = new Map(), storeId = '00000000-0000-4000-8000-000000000001';
  return { rows, fetch: async (_url, options) => {
    if (pause) await pause();
    if (fail()) return Response.json({ ok: false, error: 'Library fixture unavailable' }, { status: 503 });
    if (options.method === 'GET') return Response.json({ ok: true, storeId, generation: '0' });
    const stored = JSON.parse(options.body).records.map((record) => {
      const row = canonicalRecord(record);
      if (!rows.has(row.hash)) rows.set(row.hash, { ...row.record, hash: row.hash, id: String(rows.size + 1) });
      return rows.get(row.hash);
    });
    events.push('commit');
    return Response.json({ ok: true, storeId, generation: '0', stored });
  } };
}
const historyRecord = (md) => ({ jobId: 'job_fixture', document: { name: 'report.md', md, createdAt: 1, updatedAt: 2 } });
const historyMap = () => new Map([[LEGACY_KEY, JSON.stringify({ job_fixture: [historyRecord('VERSION ONE').document, historyRecord('VERSION TWO').document] })]]);
const settleClose = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('Library barrier failure keeps old runtime, bearer, environment and window usable with saved-but-not-applied status', async (t) => {
  let failure = true;
  const db = historyApi({ fail: () => failure }), libraryStorage = historyMap();
  const fx = await fixture(t, { stored: byok, libraryStorage, libraryFetch: db.fetch });
  const original = fx.runtime(), originalBytes = libraryStorage.get(LEGACY_KEY);
  const ui = renderer(fx.bridge); await ui.idle(); ui.select('byok');
  ui.nodes.get('key').value = 'synthetic-key-replacement-123456';
  await ui.click('save-inference');
  assert.equal(fx.starts.length, 1); assert.equal(fx.runtime(), original);
  assert.equal(fx.env.BZ_CHAT_KEY, byok.key); assert.equal(fx.notifications.length, 0);
  assert.equal(fx.lifecycle.includes('stop'), false); assert.equal(libraryStorage.get(LEGACY_KEY), originalBytes);
  assert.match(ui.nodes.get('inference-status').textContent, /Keep this window open.*retry/i);
  assert.doesNotMatch(ui.nodes.get('inference-status').textContent, /Restart the app to apply/);
  const wc = fx.settingsWindow.webContents;
  const auth = fx.api.authHeaders({ url: wc.getURL().replace('/buzzy/settings', '/api/buzzy/jobs'), webContentsId: wc.id, frame: wc.mainFrame, resourceType: 'xhr', requestHeaders: {} });
  assert.equal(auth.requestHeaders.Authorization, `Bearer ${original.token}`);
  assert.equal(fx.mainWindow.historyWindow.__bzLibraryVaultBarrier, undefined);
  failure = false; ui.nodes.get('key').value = 'synthetic-key-replacement-123456'; await ui.click('save-inference');
  assert.equal(db.rows.size, 2); assert.equal(fx.starts.length, 2); fx.flush();
  assert.equal(new URL(fx.mainWindow.webContents.getURL()).port, '7332');
});

test('normal window close persists exact versions before destroying either old-origin page', async (t) => {
  const db = historyApi(), fx = await fixture(t, { libraryStorage: historyMap(), libraryFetch: db.fetch });
  fx.mainWindow.close(); assert.equal(fx.mainWindow.isDestroyed(), false);
  await settleClose(); assert.equal(fx.mainWindow.isDestroyed(), true); assert.equal(db.rows.size, 2);
  assert.equal(fx.settingsWindow.isDestroyed(), false); assert.equal(fx.settingsWindow.historyWindow.__bzLibraryVaultBarrier, undefined);
});

test('normal close failure leaves the page alive and retry succeeds', async (t) => {
  let fail = true; const db = historyApi({ fail: () => fail }), fx = await fixture(t, { libraryStorage: historyMap(), libraryFetch: db.fetch });
  fx.mainWindow.close(); await settleClose(); assert.equal(fx.mainWindow.isDestroyed(), false); assert.equal(fx.dialogs.length, 1);
  assert.equal(fx.mainWindow.historyWindow.__bzLibraryVaultBarrier, undefined);
  fail = false; fx.mainWindow.close(); await settleClose(); assert.equal(fx.mainWindow.isDestroyed(), true); assert.equal(db.rows.size, 2);
});

test('Quit commits history, waits for runtime stop and only then exits', async (t) => {
  const db = historyApi(); let fx;
  const libraryFetch = async (...args) => {
    const result = await db.fetch(...args);
    if (args[1].method === 'POST') fx.lifecycle.push('commit');
    return result;
  };
  fx = await fixture(t, { libraryStorage: historyMap(), libraryFetch });
  let prevented = 0;
  await fx.appEvents.get('before-quit')({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(db.rows.size, 2);
  assert.deepEqual(fx.lifecycle.slice(-2), ['stop', 'exit']); assert.ok(fx.lifecycle.indexOf('commit') < fx.lifecycle.indexOf('stop'));
  assert.equal(fx.dialogs.length, 0);
});

test('failed history or runtime stop cannot accidentally exit, and a later Quit retries', async (t) => {
  let fail = true; const db = historyApi({ fail: () => fail }), fx = await fixture(t, { libraryStorage: historyMap(), libraryFetch: db.fetch });
  const quit = () => fx.appEvents.get('before-quit')({ preventDefault() {} });
  await quit(); assert.equal(fx.lifecycle.includes('stop'), false); assert.equal(fx.lifecycle.includes('exit'), false);
  fail = false; fx.setStopFailure(true); await quit(); assert.equal(fx.lifecycle.includes('exit'), false); assert.equal(db.rows.size, 2);
  fx.setStopFailure(false); await quit(); assert.equal(fx.lifecycle.at(-1), 'exit');
});

test('a second Quit while saving cannot bypass the first pending barrier', async (t) => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const db = historyApi({ pause: () => gate }), fx = await fixture(t, { libraryStorage: historyMap(), libraryFetch: db.fetch });
  let prevented = 0;
  const first = fx.appEvents.get('before-quit')({ preventDefault: () => { prevented++; } });
  await new Promise(resolve => setImmediate(resolve));
  await fx.appEvents.get('before-quit')({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2); assert.equal(fx.lifecycle.includes('exit'), false);
  release(); await first; assert.equal(db.rows.size, 2); assert.equal(fx.lifecycle.filter(x => x === 'exit').length, 1);
});
