/** Node-only tests: no Electron, Xvfb, provider requests, or real child launches. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  configureDesktopTestApp, createDesktopSandbox, desktopLaunchPlan,
  desktopLaunchStatus, desktopTestEnv, runDesktopLaunch, withDesktopSandbox,
} from "./lib/desktop-test-harness.mjs";

const fixturePaths = Object.fromEntries([
  ["root", "/tmp/bz-fixture"],
  ...["home", "tmp", "data", "userData", "sessionData", "logs", "crashDumps", "config", "cache", "state"]
    .map((name) => [name, `/tmp/bz-fixture/${name}`]),
]);
const plan = (options = {}) => desktopLaunchPlan({
  root: "/project with spaces", paths: fixturePaths, mode: "firstrun", platform: "darwin", sourceEnv: {}, ...options,
});
const goodOutput = (page = "/buzzy/talk") =>
  `[desktop] runtime ready on 127.0.0.1:12345\n[desktop] loadURL resolved http://127.0.0.1:12345${page}\n`;
const result = (changes = {}) => ({
  code: 0, signal: null, error: null, timedOut: false, outputLimit: false, out: goodOutput(), ...changes,
});

test("macOS launches the installed Electron binary natively with no security overrides", () => {
  const actual = plan();
  assert.equal(actual.command, "/project with spaces/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  assert.deepEqual(actual.args, ["/project with spaces/scripts/lib/desktop-test-entry.mjs"]);
  assert.equal(actual.cwd, "/project with spaces");
  assert.equal(actual.env.BZ_FIRSTRUN_TEST, "1");
  assert.equal(actual.env.BZ_SETTINGS_TEST, undefined);
});

test("Linux uses xvfb-run without disabling Chromium's sandbox", () => {
  const actual = plan({ platform: "linux", mode: "settings-ui" });
  assert.equal(actual.command, "xvfb-run");
  assert.deepEqual(actual.args, [
    "-a", "--server-args=-screen 0 1400x900x24",
    "/project with spaces/desktop/node_modules/electron/dist/electron",
    "/project with spaces/scripts/lib/desktop-test-entry.mjs", "--disable-gpu",
  ]);
  assert.equal(actual.env.BZ_SETTINGS_TEST, "1");
  assert.equal(actual.env.BZ_SETTINGS_DRIVE, "1");
  assert.equal(actual.env.BZ_PROBE_PATH, "/buzzy/settings");
  assert.equal(actual.env.BZ_FIRSTRUN_TEST, undefined);
});

test("unsupported platforms and unknown test modes fail, never pass as skipped", () => {
  assert.throws(() => plan({ platform: "win32" }), /no launcher/);
  assert.throws(() => plan({ mode: "arbitrary-env" }), /Unknown desktop test mode/);
});

test("environment is a positive allowlist, not a credential denylist", () => {
  const source = {
    PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC",
    HOME: "/real/home", TMPDIR: "/real/tmp", XDG_CONFIG_HOME: "/real/config",
    AWS_ACCESS_KEY_ID: "synthetic-aws", AWS_SECRET_ACCESS_KEY: "synthetic-secret",
    DATABASE_URL: "postgres://synthetic", PGHOST: "synthetic-host", PGPASSWORD: "synthetic-password",
    OPENAI_API_KEY: "synthetic-key", BZ_ELEVEN_KEY: "synthetic-music", BZ_CHAT_KEY: "synthetic-chat",
    BZ_CHAT_BASE_URL: "https://remote.invalid", BZ_CHAT_MODEL: "production-model",
    BZ_DATA_DIR: "/production/data", BZ_LOG_DIR: "/production/logs", BZ_RUNTIME: "cloud",
    BZ_PROBE_URL: "https://untrusted.invalid", BZ_SKIP_READY_PROBE: "1", BZ_CONNECT_TEST: "1",
    ELECTRON_RUN_AS_NODE: "1", ELECTRON_DISABLE_SANDBOX: "1", NODE_OPTIONS: "--require=/evil.cjs",
    NODE_EXTRA_CA_CERTS: "/real/cert", HTTPS_PROXY: "https://synthetic:secret@proxy.invalid",
    SSH_AUTH_SOCK: "/real/ssh", GITHUB_TOKEN: "synthetic-token", UNKNOWN_FUTURE_SECRET: "synthetic-secret",
    DYLD_INSERT_LIBRARIES: "/evil.dylib", LD_PRELOAD: "/evil.so", DISPLAY: ":0", XAUTHORITY: "/real/xauth",
  };
  const original = { ...source };
  const env = desktopTestEnv(fixturePaths, "firstrun", source);
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) assert.equal(env[key], source[key]);
  for (const key of Object.keys(source).filter((key) => !["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"].includes(key))) {
    assert.notEqual(env[key], source[key], key);
  }
  assert.equal(env.HOME, fixturePaths.home);
  assert.equal(env.TMPDIR, fixturePaths.tmp);
  assert.equal(env.BZ_DATA_DIR, fixturePaths.data);
  assert.equal(env.BZ_LOG_DIR, fixturePaths.logs);
  assert.equal(env.BZ_RUNTIME, "local");
  assert.equal(env.BZ_CHAT_KEY, "");
  assert.equal(env.BZ_CHAT_BASE_URL, "");
  assert.equal(env.BZ_CHAT_MODEL, "");
  assert.deepEqual(source, original, "the parent environment must remain unchanged");
});

test("each test gets private, distinct home/data/log/userData directories", (t) => {
  const first = createDesktopSandbox("unit-isolation");
  const second = createDesktopSandbox("unit-isolation");
  t.after(() => { for (const paths of [first, second]) rmSync(paths.root, { recursive: true, force: true }); });
  assert.notEqual(first.root, second.root);
  assert.equal(new Set(Object.values(first)).size, Object.values(first).length);
  for (const paths of [first, second]) {
    for (const directory of Object.values(paths)) {
      assert.ok(statSync(directory).isDirectory());
      assert.equal(statSync(directory).mode & 0o077, 0, directory);
    }
  }
});

test("sandbox removal runs after successful and failed assertions", async () => {
  let successful, failing;
  assert.equal(await withDesktopSandbox("unit-success", async (paths) => { successful = paths.root; return 42; }), 42);
  assert.equal(existsSync(successful), false);
  await assert.rejects(withDesktopSandbox("unit-failure", async (paths) => {
    failing = paths.root;
    throw new Error("fixture assertion");
  }), /fixture assertion/);
  assert.equal(existsSync(failing), false);
});

test("test bootstrap sets lock/session/log paths before importing production main", () => {
  const calls = [];
  const app = {
    isPackaged: false,
    setName: (...args) => calls.push(["name", ...args]),
    setPath: (...args) => calls.push(args),
    setAppLogsPath: (path) => calls.push(["logs", path]),
    on: () => {},
  };
  configureDesktopTestApp(app, desktopTestEnv(fixturePaths, "firstrun", {}));
  assert.deepEqual(calls, [
    ["name", "BeeZilla Desktop Test"], ["userData", fixturePaths.userData],
    ["sessionData", fixturePaths.sessionData], ["crashDumps", fixturePaths.crashDumps], ["logs", fixturePaths.logs],
  ]);
  const entry = readFileSync(new URL("./lib/desktop-test-entry.mjs", import.meta.url), "utf8");
  assert.ok(entry.indexOf("configureDesktopTestApp(app)") < entry.indexOf('await import("../../desktop/main.mjs")'));
  assert.equal(/import\s+.*from\s+["'].*desktop\/main\.mjs/.test(entry), false, "no hoisted production import before isolation");
});

test("test bootstrap records page completion and failures for every window", () => {
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, setName() {}, setPath() {}, setAppLogsPath() {},
  });
  const lines = [];
  configureDesktopTestApp(app, desktopTestEnv(fixturePaths, "firstrun", {}), (line) => lines.push(line));
  const webContents = Object.assign(new EventEmitter(), { getURL: () => "http://127.0.0.1:12345/buzzy/settings" });
  app.emit("browser-window-created", {}, { webContents });
  webContents.emit("did-finish-load");
  webContents.emit("did-fail-load", {}, -2, "ERR_FAILED", "http://127.0.0.1:12345/buzzy/settings", true);
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(lines, [
    "[desktop-test] page loaded http://127.0.0.1:12345/buzzy/settings",
    "[desktop-test] load failed -2 ERR_FAILED",
    "[desktop-test] renderer failed crashed",
  ]);
  for (const line of lines.slice(1)) assert.equal(desktopLaunchStatus(result({ out: goodOutput() + line })).ok, false);
});

test("bootstrap refuses packaged use and non-isolated directory settings", () => {
  const env = desktopTestEnv(fixturePaths, "firstrun", {});
  assert.throws(() => configureDesktopTestApp({ isPackaged: true }, env), /unpackaged/);
  assert.throws(() => configureDesktopTestApp({ isPackaged: false }, {}), /isolated/);
  assert.throws(() => configureDesktopTestApp({ isPackaged: false }, { ...env, BZ_TEST_ROOT: "/" }), /isolated/);
  assert.throws(() => configureDesktopTestApp({ isPackaged: false }, { ...env, BZ_DATA_DIR: "/production/data" }), /do not match/);
});

test("positive launch needs clean exit, ready runtime, and the expected local page", () => {
  assert.equal(desktopLaunchStatus(result()).ok, true);
  assert.equal(desktopLaunchStatus(result({ out: goodOutput("/buzzy/settings") }), "/buzzy/settings").ok, true);
  for (const bad of [
    { code: 1 }, { code: null }, { signal: "SIGSEGV" }, { timedOut: true }, { error: "spawn ENOENT" },
    { outputLimit: true }, { out: "" }, { out: "[desktop] loadURL resolved http://127.0.0.1:12345/buzzy/talk\n" },
    { out: "[desktop] runtime ready on 127.0.0.1:12345\n" },
    { out: goodOutput("/buzzy/settings") },
    { out: goodOutput().replace("http://127.0.0.1:12345", "https://remote.invalid") },
    { out: goodOutput() + "[desktop] load failed -2 ERR_FAILED\n" },
    { out: goodOutput() + "[desktop] failed to start: fixture\n" },
    { out: goodOutput() + "[desktop] loadURL TIMED OUT\n" },
    { out: goodOutput() + "[supervisor] runtime exited unexpectedly (code 0)\n" },
    { out: goodOutput() + "unhandledRejection: fixture\n" },
  ]) assert.equal(desktopLaunchStatus(result(bad)).ok, false, JSON.stringify(bad));
});

function fakeLaunch(script, { pid = 567890, stopGroup } = {}) {
  const child = Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const calls = [];
  const options = {
    timeoutMs: 100,
    spawnImpl: (command, args, opts) => {
      calls.push({ command, args, opts });
      queueMicrotask(() => script(child));
      return child;
    },
    stopGroup: async (id) => { calls.push({ stopped: id }); await stopGroup?.(child); },
  };
  return { options, calls };
}

test("runner captures output and awaits owned-group cleanup after a clean exit", async () => {
  let cleanupFinished = false;
  const fake = fakeLaunch((child) => {
    child.stdout.emit("data", Buffer.from(goodOutput()));
    child.stderr.emit("data", Buffer.from("fixture diagnostic\n"));
    child.emit("close", 0, null);
  }, { stopGroup: async () => { await Promise.resolve(); cleanupFinished = true; } });
  const actual = await runDesktopLaunch(plan(), fake.options);
  assert.equal(desktopLaunchStatus(actual).ok, true);
  assert.equal(actual.stderr, "fixture diagnostic\n");
  assert.equal(cleanupFinished, true);
  assert.equal(fake.calls[0].opts.detached, true);
  assert.deepEqual(fake.calls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(fake.calls.at(-1), { stopped: 567890 });
});

test("runner preserves nonzero exit and signal even after positive output", async () => {
  for (const [code, signal] of [[2, null], [null, "SIGABRT"]]) {
    const fake = fakeLaunch((child) => { child.stdout.emit("data", goodOutput()); child.emit("close", code, signal); });
    const actual = await runDesktopLaunch(plan(), fake.options);
    assert.equal(actual.code, code);
    assert.equal(actual.signal, signal);
    assert.equal(desktopLaunchStatus(actual).ok, false);
  }
});

test("spawn failures cannot turn into passing skips", async () => {
  let stopped = false;
  // No child PID exists on a failed spawn.
  const actual = await runDesktopLaunch(plan({ platform: "linux" }), {
    spawnImpl: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => child.emit("error", new Error("spawn xvfb-run ENOENT")));
      return child;
    },
    stopGroup: async () => { stopped = true; },
  });
  assert.match(actual.error, /ENOENT/);
  assert.equal(desktopLaunchStatus(actual).ok, false);
  assert.equal(stopped, false);
  const thrown = await runDesktopLaunch(plan(), { spawnImpl: () => { throw new Error("fixture invalid executable"); } });
  assert.match(thrown.error, /invalid executable/);
});

test("timeout fails even with positive markers and a zero exit during shutdown", async () => {
  const fake = fakeLaunch((child) => child.stdout.emit("data", goodOutput()), {
    stopGroup: async (child) => child.emit("close", 0, null),
  });
  const actual = await runDesktopLaunch(plan(), { ...fake.options, timeoutMs: 5 });
  assert.equal(actual.timedOut, true);
  assert.equal(actual.code, 0);
  assert.equal(desktopLaunchStatus(actual).ok, false);
  assert.equal(fake.calls.filter((call) => call.stopped).length, 1);
});

test("timeout is bounded even when the child never emits close", async () => {
  const fake = fakeLaunch(() => {});
  const actual = await runDesktopLaunch(plan(), { ...fake.options, timeoutMs: 5 });
  assert.equal(actual.timedOut, true);
  assert.equal(actual.code, null);
  assert.equal(desktopLaunchStatus(actual).ok, false);
});

test("excess output and stream errors fail and clean up", async () => {
  const large = fakeLaunch((child) => child.stdout.emit("data", "x".repeat(100)));
  const limited = await runDesktopLaunch(plan(), { ...large.options, maxOutputBytes: 20 });
  assert.equal(limited.outputLimit, true);
  assert.equal(limited.out, "");
  assert.equal(desktopLaunchStatus(limited).ok, false);
  const broken = fakeLaunch((child) => child.stderr.emit("error", new Error("fixture stream error")));
  const actual = await runDesktopLaunch(plan(), broken.options);
  assert.match(actual.error, /stream error/);
  assert.deepEqual(broken.calls.at(-1), { stopped: 567890 });
});

test("uncertain process cleanup fails and retains only its temporary data", async (t) => {
  let root;
  const fake = fakeLaunch((child) => child.emit("close", 0, null), {
    stopGroup: async () => { throw new Error("fixture could not stop"); },
  });
  await assert.rejects(withDesktopSandbox("unit-pending", async (paths) => {
    root = paths.root;
    return runDesktopLaunch(plan({ paths }), fake.options);
  }), /cleanup failed.*isolated test data retained/);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(existsSync(join(root, "data")), true);
});
