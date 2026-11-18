/** Test-only Electron launch support. Importing this module never launches an app. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];
const DIRECTORY_NAMES = ["home", "tmp", "data", "userData", "sessionData", "logs", "crashDumps", "config", "cache", "state"];

export function createDesktopSandbox(label = "desktop") {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid desktop test label");
  const root = realpathSync(mkdtempSync(join(tmpdir(), `bz-${label}-`)));
  try {
    const paths = { root };
    for (const name of DIRECTORY_NAMES) {
      paths[name] = join(root, name);
      mkdirSync(paths[name], { mode: 0o700 });
    }
    return paths;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function withDesktopSandbox(label, run) {
  const paths = createDesktopSandbox(label);
  let keepData = false;
  try {
    return await run(paths);
  } catch (error) {
    // Do not remove a database beneath a process whose shutdown is uncertain.
    keepData = error?.desktopCleanupPending === true;
    if (keepData) error.message += `; isolated test data retained at ${paths.root}`;
    throw error;
  } finally {
    if (!keepData) rmSync(paths.root, { recursive: true, force: true });
  }
}

export function desktopTestEnv(paths, mode, source = process.env) {
  if (!["firstrun", "settings-ui"].includes(mode)) throw new Error(`Unknown desktop test mode: ${mode}`);
  const env = {};
  // Do not spread process.env: it may contain live provider/database credentials,
  // NODE_OPTIONS, ELECTRON_RUN_AS_NODE, proxies, or production data overrides.
  for (const name of INHERITED_ENV) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  Object.assign(env, {
    HOME: paths.home, TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
    XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state,
    BZ_TEST_ROOT: paths.root,
    BZ_DATA_DIR: paths.data, BZ_LOG_DIR: paths.logs, BZ_RUNTIME: "local",
    BZ_CONNECT_DISABLED: "1",
    BZ_CHAT_KEY: "", BZ_CHAT_BASE_URL: "", BZ_CHAT_MODEL: "",
  });
  if (mode === "firstrun") env.BZ_FIRSTRUN_TEST = "1";
  else Object.assign(env, { BZ_SETTINGS_TEST: "1", BZ_SETTINGS_DRIVE: "1", BZ_PROBE_PATH: "/buzzy/settings" });
  return env;
}

export function desktopLaunchPlan({ root, paths, mode, platform = process.platform, sourceEnv = process.env }) {
  if (!["darwin", "linux"].includes(platform)) throw new Error(`Desktop E2E has no launcher for ${platform}; no test was run`);
  const electron = join(root, "desktop", "node_modules", "electron", "dist", ...(
    platform === "darwin" ? ["Electron.app", "Contents", "MacOS", "Electron"] : ["electron"]
  ));
  const entry = join(root, "scripts", "lib", "desktop-test-entry.mjs");
  // Use the installed binary directly, not a shebang wrapper or `open -a`, so
  // exit status and the owned process group belong to this test invocation.
  const args = platform === "linux"
    ? ["-a", "--server-args=-screen 0 1400x900x24", electron, entry, "--disable-gpu"]
    : [entry];
  // A Linux runner must support Chromium's sandbox. No automatic no-sandbox
  // fallback: otherwise these tests could claim to verify a sandboxed renderer
  // while disabling its sandbox. Native macOS uses no Chromium overrides.
  return {
    command: platform === "linux" ? "xvfb-run" : electron,
    args, cwd: root, env: desktopTestEnv(paths, mode, sourceEnv),
  };
}

/** Called synchronously by the test entry point, before importing main.mjs. */
export function configureDesktopTestApp(app, env = process.env, report = (line) => console.log(line)) {
  const root = env.BZ_TEST_ROOT;
  if (app.isPackaged || !root || !isAbsolute(root) || resolve(root) === resolve("/")) {
    throw new Error("Desktop test entry requires an unpackaged app and an isolated test root");
  }
  if (env.BZ_DATA_DIR !== join(root, "data") || env.BZ_LOG_DIR !== join(root, "logs") || env.HOME !== join(root, "home")) {
    throw new Error("Desktop test directories do not match the isolated test root");
  }
  app.setName("BeeZilla Desktop Test");
  for (const name of ["userData", "sessionData", "crashDumps"]) app.setPath(name, join(root, name));
  app.setAppLogsPath(join(root, "logs"));
  // Observe every window, including first-run Settings. Constructing a window
  // is not proof that its page loaded, and a crashed renderer may leave the
  // main process alive until its otherwise-successful test quit timer fires.
  app.on("browser-window-created", (_event, window) => {
    window.webContents.on("did-finish-load", () => report(`[desktop-test] page loaded ${window.webContents.getURL()}`));
    window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame) report(`[desktop-test] load failed ${code} ${description}`);
    });
    window.webContents.on("render-process-gone", (_event, details) => report(`[desktop-test] renderer failed ${details.reason}`));
  });
}

const groupExists = (pid) => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

async function stopProcessGroup(pid) {
  // spawn(detached:true) creates a separate POSIX group on both supported OSes.
  // Only signal that group, never a PID obtained from runtime.json or disk.
  for (const [signal, grace] of [["SIGTERM", 2000], ["SIGKILL", 1000]]) {
    if (!groupExists(pid)) return;
    try { process.kill(-pid, signal); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
      if (!groupExists(pid)) return;
      await delay(25);
    }
  }
  throw new Error(`Desktop test process group ${pid} did not stop`);
}

export async function runDesktopLaunch(plan, {
  timeoutMs = 180_000, maxOutputBytes = 4 * 1024 * 1024,
  spawnImpl = spawn, stopGroup = stopProcessGroup,
} = {}) {
  let child, timer, stopping;
  let stdout = "", stderr = "", bytes = 0, timedOut = false, outputLimit = false;
  const stop = () => stopping ??= Number.isInteger(child?.pid) && child.pid > 0
    ? Promise.resolve().then(() => stopGroup(child.pid)) : Promise.resolve();
  try {
    return await new Promise((done, reject) => {
      let finished = false;
      const finish = (code, signal, error = null) => {
        if (finished) return;
        finished = true;
        done({ code, signal, error, timedOut, outputLimit, stdout, stderr, out: stdout + stderr });
      };
      const stopAndFinish = () => {
        void stop().then(() => finish(null, null), reject);
      };
      const capture = (stream) => (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutputBytes) {
          outputLimit = true;
          stopAndFinish();
          return;
        }
        if (stream === "stdout") stdout += String(chunk);
        else stderr += String(chunk);
      };
      try {
        child = spawnImpl(plan.command, plan.args, {
          cwd: plan.cwd, env: plan.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        finish(null, null, error.message);
        return;
      }
      child.stdout?.on("data", capture("stdout"));
      child.stderr?.on("data", capture("stderr"));
      child.stdout?.once("error", (error) => finish(null, null, error.message));
      child.stderr?.once("error", (error) => finish(null, null, error.message));
      child.once("error", (error) => finish(null, null, error.message));
      child.once("close", (code, signal) => finish(code, signal));
      timer = setTimeout(() => { timedOut = true; stopAndFinish(); }, timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    // Includes timeout, spawn/stream errors, and a nominally successful wrapper
    // exit with lingering runtime descendants. Await before deleting test data.
    try { await stop(); }
    catch (cause) {
      const error = new Error(`Desktop test cleanup failed: ${cause.message}`, { cause });
      error.desktopCleanupPending = true;
      throw error;
    }
  }
}

export function desktopLaunchStatus(result, page = "/buzzy/talk") {
  const reasons = [];
  if (result.error) reasons.push(`process error: ${result.error}`);
  if (result.timedOut) reasons.push("launch timed out");
  if (result.outputLimit) reasons.push("launch output exceeded limit");
  if (result.code !== 0) reasons.push(`exit code ${result.code ?? "unknown"}`);
  if (result.signal) reasons.push(`signal ${result.signal}`);
  if (!/^\[desktop\] runtime ready on /m.test(result.out)) reasons.push("no runtime-ready evidence");
  const loaded = [...result.out.matchAll(/^\[desktop\] loadURL resolved (\S+)/gm)].some((match) => {
    try {
      const url = new URL(match[1]);
      return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && url.pathname === page;
    } catch { return false; }
  });
  if (!loaded) reasons.push(`no loaded ${page} evidence`);
  if (/\[desktop\] (?:failed to start:|load failed |loadURL TIMED OUT)|\[desktop-test\] (?:load failed |renderer failed )|\[supervisor\] runtime exited unexpectedly|uncaughtException|unhandledRejection/.test(result.out)) {
    reasons.push("desktop reported a launch/runtime failure");
  }
  return { ok: reasons.length === 0, detail: reasons.join("; ") || "clean exit, runtime ready, page loaded" };
}
