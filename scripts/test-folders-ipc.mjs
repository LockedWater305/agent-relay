#!/usr/bin/env node
// Tests for desktop/folders-ipc.mjs and the folder bridge in desktop/preload.cjs.
// Electron does not start. ipcMain, dialog and the windows are fakes. The real broker, the real
// trust check (desktop/security.mjs) and the real preload source run against them.
// Run: node --test --test-concurrency=1 scripts/test-folders-ipc.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createBroker } from "../desktop/capability-broker.mjs";
import {
  FOLDER_ACTIVITY_EVENT, FOLDER_CHANNELS, folderActivityForwarder, registerFolderIpc,
} from "../desktop/folders-ipc.mjs";
import { isTrustedSender } from "../desktop/security.mjs";

const BASE = "http://127.0.0.1:7331";
const PRELOAD = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
const ALL_HANDLED = [
  "bz-folders:activate", "bz-folders:activity", "bz-folders:list", "bz-folders:listDir",
  "bz-folders:pause", "bz-folders:pick", "bz-folders:readFile", "bz-folders:resume",
  "bz-folders:revoke", "bz-folders:search",
];

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folders-ipc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

/** A web contents whose main frame sits at `url`, shaped the way security.mjs reads it. */
function contents(url, id) {
  return {
    id,
    destroyed: false,
    sent: [],
    mainFrame: { url },
    getURL() { return this.mainFrame.url; },
    isDestroyed() { return this.destroyed; },
    send(channel, payload) { this.sent.push([channel, payload]); },
  };
}

/** An IPC event sent from a window's main frame. */
const fromWindow = (wc) => ({ sender: wc, senderFrame: wc.mainFrame });

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, fn) {
      assert.ok(!handlers.has(channel), `handled twice: ${channel}`);
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      assert.ok(!listeners.has(channel), `listened twice: ${channel}`);
      listeners.set(channel, fn);
    },
    call(channel, event, payload) {
      return handlers.get(channel)(event, payload);
    },
    sync(channel, event) {
      listeners.get(channel)(event);
      return event.returnValue;
    },
  };
}

function fakeDialog(answer) {
  const calls = [];
  return {
    calls,
    answer,
    async showOpenDialog(...args) {
      calls.push(args);
      return typeof this.answer === "function" ? this.answer(...args) : this.answer;
    },
  };
}

function setup({ broker = createBroker(), dialog = fakeDialog({ canceled: true, filePaths: [] }) } = {}) {
  const ipc = fakeIpc();
  const app = contents(`${BASE}/buzzy/talk`, 10);
  const settings = contents(`${BASE}/buzzy/settings`, 11);
  const owner = { name: "settings window" };
  const trusted = [app, settings];
  registerFolderIpc({
    ipcMain: ipc,
    dialog,
    broker,
    isTrustedSender: (event) => isTrustedSender(event, { base: BASE, contents: trusted }),
    getWindow: (event) => (event.sender === settings ? owner : null),
    runtimeOrigin: () => BASE,
  });
  return { ipc, dialog, broker, app, settings, owner };
}

test("the channel set is fixed: ten handled channels and one synchronous origin answer", () => {
  const { ipc } = setup();
  assert.deepEqual([...ipc.handlers.keys()].sort(), [...ALL_HANDLED].sort());
  assert.deepEqual([...ipc.listeners.keys()], ["bz-folders:origin"]);
});

test("every channel refuses a sender that is not the app's own main frame, before any work", async (t) => {
  const base = sandbox(t);
  const folder = path.join(base, "Docs");
  fs.mkdirSync(folder);
  const dialog = fakeDialog({ canceled: false, filePaths: [folder] });
  const { ipc, broker, app, settings, owner } = setup({ dialog });
  const stranger = contents(`${BASE}/buzzy/settings`, 99); // not one of the app's windows
  const remote = contents("https://app.devboards.ai/login", 12); // a remote page
  const uploaded = contents(`${BASE}/api/buzzy/assets/1`, 13); // an uploaded document
  const refused = [
    { sender: stranger, senderFrame: stranger.mainFrame },
    { sender: settings, senderFrame: { url: `${BASE}/buzzy/settings` } }, // a frame, not the main frame
    { sender: remote, senderFrame: remote.mainFrame },
    { sender: uploaded, senderFrame: uploaded.mainFrame },
    { sender: app }, // no frame at all
  ];
  const payload = { id: "any", path: folder, query: "x", options: {} };
  for (const event of refused) {
    for (const channel of ALL_HANDLED) {
      const result = await ipc.call(channel, event, payload);
      assert.equal(result.ok, false, channel);
      assert.equal(result.code, "untrusted_sender", channel);
      assert.equal(typeof result.message, "string", channel);
    }
    assert.equal(ipc.sync("bz-folders:origin", event), null, "origin answer");
  }
  assert.equal(dialog.calls.length, 0, "no refused sender opens the picker");
  assert.deepEqual(broker.list(), []);
  assert.deepEqual(broker.activity(), [], "refused calls never reach the broker");
  // The same handlers answer the app's own windows: the settings window's pick opens the picker
  // parented to it and grants the folder the dialog returned.
  assert.equal((await ipc.call(FOLDER_CHANNELS.list, fromWindow(app))).ok, true);
  const picked = await ipc.call(FOLDER_CHANNELS.pick, fromWindow(settings));
  assert.equal(picked.data.granted, true);
  assert.equal(dialog.calls.at(-1)[0], owner, "the picker is parented to the window that asked");
  assert.deepEqual(broker.list().map((g) => g.root), [folder]);
});

test("no channel grants a folder the page names; pick ignores its payload and grants the dialog's choice", async (t) => {
  const base = sandbox(t);
  const chosen = path.join(base, "Chosen");
  const named = path.join(base, "Named");
  fs.mkdirSync(chosen);
  fs.mkdirSync(named);
  const broker = createBroker();
  const grantCalls = [];
  const spied = { ...broker, grantFolder: (folder, options) => { grantCalls.push(folder); return broker.grantFolder(folder, options); } };
  const dialog = fakeDialog({ canceled: true, filePaths: [] });
  const { ipc, app } = setup({ broker: spied, dialog });
  const hostile = { path: named, root: named, folder: named, chosenPath: named, id: "missing", query: "x", options: { root: named } };

  for (const channel of ALL_HANDLED) {
    const result = await ipc.call(channel, fromWindow(app), hostile);
    assert.equal(typeof result.ok, "boolean", channel);
  }
  assert.deepEqual(grantCalls, [], "no channel reached grantFolder with a page-supplied path");

  // The page's folder is ignored even when the picker is cancelled.
  assert.deepEqual(await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app), hostile), { ok: true, data: { granted: false } });
  assert.deepEqual(grantCalls, []);
  assert.deepEqual(broker.list(), []);

  // With a real choice, exactly that folder is granted, and the picker gets only constant options.
  dialog.answer = { canceled: false, filePaths: [chosen] };
  const picked = await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app), hostile);
  assert.equal(picked.ok, true);
  assert.equal(picked.data.granted, true);
  assert.deepEqual(grantCalls, [chosen]);
  assert.deepEqual(broker.list().map((g) => g.root), [chosen]);
  const callArgs = dialog.calls.at(-1);
  assert.equal(callArgs.length, 1, "no owner window for the app page, so only options are passed");
  const [options] = callArgs;
  assert.deepEqual(options.properties, ["openDirectory"]);
  assert.equal("defaultPath" in options, false);
});

test("a cancelled dialog, or one that returns no folder, grants nothing", async () => {
  for (const answer of [
    { canceled: true, filePaths: ["/Users/ana/Documents/Notes"] },
    { canceled: false, filePaths: [] },
    { canceled: false },
    {},
  ]) {
    const broker = createBroker();
    const { ipc, app } = setup({ broker, dialog: fakeDialog(answer) });
    assert.deepEqual(await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app)), { ok: true, data: { granted: false } });
    assert.deepEqual(broker.list(), []);
    assert.deepEqual(broker.activity(), []);
  }
});

test("only one folder picker is open at a time; a second request is refused until the first closes", async () => {
  let release;
  const calls = [];
  const dialog = {
    showOpenDialog: (...args) => {
      calls.push(args);
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const { ipc, settings, owner } = setup({ dialog });
  const first = ipc.call(FOLDER_CHANNELS.pick, fromWindow(settings));
  assert.deepEqual(await ipc.call(FOLDER_CHANNELS.pick, fromWindow(settings)), {
    ok: false, code: "busy", message: "The folder picker is already open.",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], owner);
  release({ canceled: true, filePaths: [] });
  assert.deepEqual(await first, { ok: true, data: { granted: false } });
  const second = ipc.call(FOLDER_CHANNELS.pick, fromWindow(settings));
  release({ canceled: true, filePaths: [] });
  assert.deepEqual(await second, { ok: true, data: { granted: false } });
});

test("list, read and search reach the broker by grant id and return what it returns", async (t) => {
  const base = sandbox(t);
  const folder = path.join(base, "Notes");
  fs.mkdirSync(path.join(folder, "week"), { recursive: true });
  fs.writeFileSync(path.join(folder, "week", "plan.txt"), "ship the broker\n");
  const { ipc, app } = setup({ dialog: fakeDialog({ canceled: false, filePaths: [folder] }) });
  const granted = await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app));
  const id = granted.data.grant.id;

  // A new grant is off: the broker refuses, and the page gets a code.
  const refusedRead = await ipc.call(FOLDER_CHANNELS.readFile, fromWindow(app), { id, path: "week/plan.txt" });
  assert.deepEqual(Object.keys(refusedRead).sort(), ["code", "message", "ok"]);
  assert.equal(refusedRead.code, "inactive");
  assert.equal((await ipc.call(FOLDER_CHANNELS.activate, fromWindow(app), { id })).ok, true);

  const listed = await ipc.call(FOLDER_CHANNELS.listDir, fromWindow(app), { id, path: "week" });
  assert.deepEqual(listed, {
    ok: true,
    data: { path: "week", entries: [{ name: "plan.txt", path: "week/plan.txt", type: "file" }] },
  });
  const text = "ship the broker\n";
  const read = await ipc.call(FOLDER_CHANNELS.readFile, fromWindow(app), { id, path: "week/plan.txt" });
  assert.deepEqual(read, { ok: true, data: { path: "week/plan.txt", bytes: Buffer.byteLength(text), text } });
  const found = await ipc.call(FOLDER_CHANNELS.search, fromWindow(app), { id, query: "PLAN" });
  assert.equal(found.ok, true);
  assert.deepEqual(found.data.matches, [{ path: "week/plan.txt", type: "file" }]);

  // The search text is not recorded anywhere the page can read.
  const log = await ipc.call(FOLDER_CHANNELS.activity, fromWindow(app));
  assert.equal(log.ok, true);
  assert.ok(log.data.some((entry) => entry.op === "search"));
  assert.ok(!JSON.stringify(log.data).includes("PLAN"));
});

test("broker refusals reach the page as { ok: false, code, message }, never as a thrown error", async (t) => {
  const base = sandbox(t);
  const folder = path.join(base, "Notes");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "a.txt"), "a");
  const { ipc, app } = setup({ dialog: fakeDialog({ canceled: false, filePaths: [folder] }) });
  const { data: { grant: { id } } } = await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app));
  const w = fromWindow(app);
  await ipc.call(FOLDER_CHANNELS.activate, w, { id });

  const cases = [
    [FOLDER_CHANNELS.readFile, { id, path: "../escape.txt" }, "bad_path"],
    [FOLDER_CHANNELS.readFile, { id: "missing", path: "a.txt" }, "not_granted"],
    [FOLDER_CHANNELS.readFile, { id, path: "a.txt", options: { maxBytes: -1 } }, "bad_argument"],
    [FOLDER_CHANNELS.listDir, "a.txt", "bad_argument"],
    [FOLDER_CHANNELS.search, { id, query: "" }, "bad_argument"],
    [FOLDER_CHANNELS.activate, undefined, "bad_argument"],
    [FOLDER_CHANNELS.readFile, { id, path: "a.txt" }, "ok"],
  ];
  for (const [channel, payload, code] of cases) {
    const result = await ipc.call(channel, w, payload);
    if (code === "ok") {
      assert.equal(result.ok, true, channel);
      continue;
    }
    assert.equal(result.ok, false, channel);
    assert.equal(result.code, code, channel);
    assert.equal(typeof result.message, "string", channel);
  }

  await ipc.call(FOLDER_CHANNELS.pause, w, { id });
  assert.equal((await ipc.call(FOLDER_CHANNELS.readFile, w, { id, path: "a.txt" })).code, "paused");
  await ipc.call(FOLDER_CHANNELS.resume, w, { id });
  await ipc.call(FOLDER_CHANNELS.revoke, w, { id });
  assert.equal((await ipc.call(FOLDER_CHANNELS.readFile, w, { id, path: "a.txt" })).code, "revoked");
  assert.deepEqual(await ipc.call(FOLDER_CHANNELS.activate, w, { id }), {
    ok: false, code: "revoked", message: "the grant has been revoked",
  });
});

test("a failure that is not a broker error is reported as unavailable, without its text", async () => {
  const broker = { ...createBroker(), listDir: async () => { throw new Error("EACCES: /Users/ana/Secret/notes.txt"); } };
  const { ipc, app } = setup({ broker });
  const result = await ipc.call(FOLDER_CHANNELS.listDir, fromWindow(app), { id: "x", path: "" });
  assert.deepEqual(result, { ok: false, code: "unavailable", message: "BeeZilla could not finish that folder action." });
  assert.ok(!JSON.stringify(result).includes("Secret"));
});

test("every broker activity entry reaches each live app window, and the activity call returns the log", async (t) => {
  const base = sandbox(t);
  const folder = path.join(base, "Docs");
  fs.mkdirSync(folder);
  const app = contents(`${BASE}/buzzy/talk`, 10);
  const settings = contents(`${BASE}/buzzy/settings`, 11);
  const gone = contents(`${BASE}/buzzy/settings`, 12);
  gone.destroyed = true;
  const ipc = fakeIpc();
  const broker = createBroker({ onActivity: folderActivityForwarder(() => [app, settings, gone]) });
  registerFolderIpc({
    ipcMain: ipc,
    dialog: fakeDialog({ canceled: false, filePaths: [folder] }),
    broker,
    isTrustedSender: (event) => isTrustedSender(event, { base: BASE, contents: [app, settings] }),
    getWindow: () => null,
    runtimeOrigin: () => BASE,
  });
  const granted = await ipc.call(FOLDER_CHANNELS.pick, fromWindow(app));
  await ipc.call(FOLDER_CHANNELS.activate, fromWindow(app), { id: granted.data.grant.id });

  for (const wc of [app, settings]) {
    assert.deepEqual(
      wc.sent.map(([channel, entry]) => [channel, entry.op, entry.ok]),
      [[FOLDER_ACTIVITY_EVENT, "grant", true], [FOLDER_ACTIVITY_EVENT, "activate", true]],
    );
  }
  assert.deepEqual(gone.sent, [], "a destroyed window receives nothing");
  const log = await ipc.call(FOLDER_CHANNELS.activity, fromWindow(app));
  assert.deepEqual(log.data.map((entry) => entry.op), ["grant", "activate"]);
});

test("the synchronous origin answer is the runtime origin for the app's windows, and null for anything else", () => {
  const { ipc, app, settings } = setup();
  assert.equal(ipc.sync("bz-folders:origin", fromWindow(app)), BASE);
  assert.equal(ipc.sync("bz-folders:origin", fromWindow(settings)), BASE);
  assert.equal(ipc.sync("bz-folders:origin", { sender: app, senderFrame: { url: `${BASE}/buzzy/talk` } }), null);
  assert.equal(ipc.sync("bz-folders:origin", fromWindow(contents(`${BASE}/buzzy/settings`, 30))), null);
});

test("a runtime origin that throws is answered as null, so the preload never blocks", () => {
  const ipc = fakeIpc();
  const app = contents(`${BASE}/buzzy/talk`, 10);
  registerFolderIpc({
    ipcMain: ipc,
    dialog: fakeDialog({ canceled: true, filePaths: [] }),
    broker: createBroker(),
    isTrustedSender: (event) => isTrustedSender(event, { base: BASE, contents: [app] }),
    getWindow: () => null,
    runtimeOrigin: () => { throw new Error("runtime not started"); },
  });
  assert.equal(ipc.sync("bz-folders:origin", fromWindow(app)), null);
});

/**
 * Runs the real preload source with a stubbed `electron`. Returns what it exposed and what it
 * sent. Its results are compared as JSON, because values created inside vm have another realm.
 */
function runPreload({ isMainFrame = true, pageOrigin = BASE, mainSays = () => BASE } = {}) {
  const ipc = new EventEmitter();
  ipc.calls = [];
  ipc.syncCalls = [];
  ipc.invoke = async (...args) => {
    ipc.calls.push(args);
    return { ok: true };
  };
  ipc.sendSync = (...args) => {
    ipc.syncCalls.push(args);
    return mainSays(...args);
  };
  const exposed = new Map();
  runInNewContext(PRELOAD, {
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer: ipc }),
    process: { isMainFrame },
    URL,
    setTimeout: () => 0,
    window: { location: { origin: pageOrigin, replace() {} } },
  });
  return { exposed, ipc };
}

const wire = (value) => JSON.parse(JSON.stringify(value));

test("the preload exposes window.beezillaFolders only in the top frame, at the origin main reports", () => {
  const trusted = runPreload();
  assert.ok(trusted.exposed.has("beezillaFolders"));
  assert.ok(trusted.exposed.has("beezilla"), "the settings bridge is still exposed");
  assert.deepEqual(wire(trusted.ipc.syncCalls), [["bz-folders:origin"]]);

  const refused = {
    "a different origin than main reports": runPreload({ pageOrigin: "http://127.0.0.1:7332" }),
    "main reports no origin": runPreload({ mainSays: () => null }),
    "main reports another origin": runPreload({ mainSays: () => "http://127.0.0.1:7332" }),
    "a remote page": runPreload({ pageOrigin: "https://app.devboards.ai" }),
    "the origin query fails": runPreload({ mainSays: () => { throw new Error("no reply"); } }),
    "a subframe": runPreload({ isMainFrame: false }),
  };
  for (const [name, result] of Object.entries(refused)) {
    assert.equal(result.exposed.has("beezillaFolders"), false, name);
  }
  assert.equal(refused["a subframe"].exposed.has("beezilla"), false, "a subframe gets no bridge at all");
  assert.equal(refused["a subframe"].ipc.syncCalls.length, 0, "a subframe does not ask");
  assert.equal(refused["the origin query fails"].exposed.has("beezilla"), true,
    "a failed folder check does not take the settings bridge down");
});

test("each folder call sends its own channel and only the fields it needs", async () => {
  const { exposed, ipc } = runPreload();
  const api = exposed.get("beezillaFolders");
  await api.pick("/etc"); // a page cannot name a folder through pick
  await api.activate("g1", "extra");
  await api.readFile("g1", "a.txt", { maxBytes: 4 });
  await api.search("g1", "needle", { limit: 3 });
  await api.listDir("g1");
  assert.deepEqual(wire(ipc.calls), [
    ["bz-folders:pick", null],
    ["bz-folders:activate", { id: "g1" }],
    ["bz-folders:readFile", { id: "g1", path: "a.txt", options: { maxBytes: 4 } }],
    ["bz-folders:search", { id: "g1", query: "needle", options: { limit: 3 } }],
    ["bz-folders:listDir", { id: "g1" }],
  ]);
});

test("onActivity passes the page only the entry, and its return value stops the callback", () => {
  const { exposed, ipc } = runPreload();
  const api = exposed.get("beezillaFolders");
  const seen = [];
  const stop = api.onActivity((entry) => seen.push(entry));
  const entry = { at: 1, grantId: "g1", op: "grant", path: null, ok: true, reason: null };
  ipc.emit(FOLDER_ACTIVITY_EVENT, { sender: "forged" }, entry);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], entry);
  stop();
  ipc.emit(FOLDER_ACTIVITY_EVENT, {}, entry);
  assert.equal(seen.length, 1, "a stopped callback is not called again");
  assert.equal(typeof api.onActivity("not a function"), "function");
});

test("the preload names exactly the channels main registers", () => {
  const named = new Set([...PRELOAD.matchAll(/"(bz-folders:[A-Za-z:-]+)"/g)].map((m) => m[1]));
  const registered = new Set([...Object.values(FOLDER_CHANNELS), FOLDER_ACTIVITY_EVENT]);
  assert.deepEqual([...named].sort(), [...registered].sort());
});

test("main creates one broker, forwards its activity, registers before the window, and never grants itself", () => {
  const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.equal((main.match(/createBroker\(/g) ?? []).length, 1);
  assert.match(main, /createBroker\(\{ onActivity: folderActivityForwarder\(trustedContents\) \}\)/);
  assert.ok(main.indexOf("registerFolderIpc({") < main.indexOf("await createWindow();"));
  assert.doesNotMatch(main, /grantFolder/);
  assert.doesNotMatch(main, /ipcMain\.(handle|on)\("bz-folders/);
});

test("the packaged shell lists the folder modules and every relative import they make", () => {
  const pkg = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8"));
  const files = pkg.build.files;
  for (const file of ["main.mjs", "preload.cjs", "capability-broker.mjs", "folders-ipc.mjs"]) {
    assert.ok(files.includes(file), `${file} is in build.files`);
  }
  for (const file of ["main.mjs", "folders-ipc.mjs", "capability-broker.mjs"]) {
    const source = readFileSync(new URL(`../desktop/${file}`, import.meta.url), "utf8");
    for (const [, spec] of source.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
      assert.ok(files.includes(spec.slice(2)), `${file} imports ${spec}, which build.files must list`);
    }
  }
});
