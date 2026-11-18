/**
 * Desktop runtime supervisor — pure Node, no Electron imports.
 *
 * The Electron main process and the test harness both use this, so the contract
 * that actually matters (start the runtime, hand back an authenticated endpoint,
 * shut it down cleanly) is verifiable headlessly instead of only by clicking a
 * window. Anything Electron-specific lives in main.mjs.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { runtimeOrigin } from "./security.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (child) => Boolean(child && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null);
const processAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};

export function defaultDataDir() {
  const override = (process.env.BZ_DATA_DIR ?? "").trim();
  if (override) return override;
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "BeeZilla", "data");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "BeeZilla", "data");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "beezilla", "data");
}

export class RuntimeSupervisor {
  /**
   * @param {{ root: string, dataDir?: string, onLog?: (line: string) => void }} opts
   */
  constructor({ root, dataDir = defaultDataDir(), onLog = () => {} }) {
    this.root = root;
    this.dataDir = dataDir;
    this.onLog = onLog;
    this.child = null;
    this.runtime = null;
    this.stopping = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.startAbort = null;
    this.exitingPid = null;
    // Process ownership is independent of HTTP readiness. Keep the current
    // generation's validated handshake even when a probe fails or is canceled.
    this.ownedRuntime = null;
    this.launch = null;
    this.shutdownUncertain = false;
  }

  get runtimeFile() {
    return join(this.dataDir, "runtime.json");
  }

  /** Base URL of the running runtime (throws before start() resolves). */
  get baseUrl() {
    if (!this.runtime) throw new Error("runtime not started");
    return runtimeOrigin(this.runtime);
  }

  get token() {
    if (!this.runtime) throw new Error("runtime not started");
    return this.runtime.token;
  }

  async start(options = {}) {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise && this.startAbort?.signal.aborted) await this.startPromise.catch(() => {});
    if (this.startPromise) return this.startPromise;
    if (this.shutdownUncertain) throw new Error("The previous launch did not confirm whether its server stopped. Restart is blocked to protect your data.");
    if (processAlive(this.exitingPid)) throw new Error("The previous local runtime is still stopping. No replacement was started to protect your data.");
    this.exitingPid = null;
    if (this.runtime && alive(this.child) && !this.stopping) return this.runtime;
    if (alive(this.child)) throw new Error("The previous local runtime is still stopping. Wait before trying again.");
    this.stopping = false;
    this.startAbort = new AbortController();
    const pending = this.startOwned(options, this.startAbort.signal).catch(async (error) => {
      if (!this.stopping) {
        try { await this.stop(); } catch (stopError) { this.onLog(`[supervisor] cleanup failed: ${stopError.message}`); }
      }
      throw error;
    }).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  async startOwned({ timeoutMs = 90_000 } = {}, signal) {

    const launcher = join(this.root, "scripts", "beezilla-local.mjs");
    if (!existsSync(launcher)) throw new Error(`local runtime launcher missing: ${launcher}`);

    // A stale file must not be adopted as this launch, and another live runtime
    // must not share our PGLite directory. Never kill a PID from an old file.
    const prior = this.readRuntimeFile();
    if (prior) {
      try {
        process.kill(prior.pid, 0);
        throw new Error("Another local runtime is using this data directory. Close it before starting BeeZilla.");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(this.runtimeFile, { force: true });
    const launchedAt = Date.now();

    this.child = spawn(process.execPath, [launcher], {
      cwd: this.root,
      env: {
        ...process.env,
        // Electron's binary IS process.execPath inside the app, so the child must
        // be told to behave as plain Node. Set explicitly: leaving it undefined
        // happens to work (Electron sees the string "undefined" and treats it as
        // set) but that is an accident, not a contract.
        ELECTRON_RUN_AS_NODE: "1",
        BZ_DATA_DIR: this.dataDir,
        BZ_RUNTIME: "local",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const child = this.child;
    const launch = { child, startedAt: launchedAt, serverPid: null, serverExited: false, noServer: false, controlReady: false, closed: false };
    this.launch = launch;
    this.ownedRuntime = null;
    let spawnError = null;
    child.stdout?.on("data", (b) => this.onLog(String(b).trimEnd()));
    child.stderr?.on("data", (b) => this.onLog(String(b).trimEnd()));
    child.on("error", (error) => { spawnError = error; });
    child.on("message", (message) => {
      if (this.launch !== launch || !message || typeof message !== "object") return;
      if (message.type === "beezilla:launcher-ready") launch.controlReady = true;
      if (message.type === "beezilla:runtime-not-started" && !launch.serverPid) launch.noServer = true;
      if (message.type === "beezilla:runtime-spawned" && Number.isInteger(message.pid) && message.pid > 0 && message.pid !== process.pid && message.pid !== child.pid) {
        if (launch.serverPid && launch.serverPid !== message.pid) { this.shutdownUncertain = true; return; }
        launch.serverPid = message.pid;
        launch.noServer = false;
        if (this.stopping || !alive(child)) this.exitingPid = message.pid;
      }
      if (message.type === "beezilla:runtime-exited" && launch.serverPid === message.pid) {
        launch.serverExited = true;
        if (this.exitingPid === message.pid) this.exitingPid = null;
      }
    });
    child.on("close", () => { launch.closed = true; });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.captureOwnedRuntime(child);
      if (!this.stopping) this.onLog(`[supervisor] runtime exited unexpectedly (code ${code})`);
      const serverPid = launch.serverPid ?? this.ownedRuntime?.pid;
      if (!launch.serverExited && serverPid !== child.pid) this.exitingPid = serverPid ?? this.exitingPid;
      this.runtime = null;
      this.child = null;
    });

    // The old failure said only "did not become ready", then the exit handler
    // appended "runtime exited unexpectedly (code 0)" — while the server was
    // demonstrably listening. Two contradictory sentences and no port, error code or
    // distinction between "dead" and "alive but unreachable" is what a firewall,
    // an antivirus, or a Wine loopback limitation all look like from here. Collect
    // the facts while waiting instead of guessing at the end.
    const deadline = Date.now() + timeoutMs;
    let lastProbe = { ok: false, error: "not attempted", code: null, ms: 0, rt: null };
    let sawRuntimeFile = false;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error("Local runtime startup canceled.");
      if (this.shutdownUncertain) throw new Error("The runtime sent inconsistent process ownership. Startup was refused.");
      if (spawnError) throw new Error(`Could not start the local runtime: ${spawnError.message}`);
      if (!alive(child)) throw new Error(`The local runtime exited during startup (code ${child.exitCode}, signal ${child.signalCode ?? "none"}).`);
      const rt = this.captureOwnedRuntime(child);
      if (rt) sawRuntimeFile = true;
      if (rt && Date.parse(rt.startedAt) >= launchedAt - 1000) {
        const probe = await this.probe(rt);
        if (signal.aborted) throw new Error("Local runtime startup canceled.");
        if (probe.ok && this.child === child && alive(child)) {
          this.runtime = rt;
          return rt;
        }
        lastProbe = probe;
      }
      await delay(100);
    }

    const running = alive(child);
    const where = lastProbe.rt ? `http://${lastProbe.rt.host}:${lastProbe.rt.port}` : "(no runtime.json written)";
    const hint = running
      ? "The runtime process is still running, so this is a reachability problem, not a crash: " +
        "something is blocking this app's connection to its own loopback port (firewall, antivirus, " +
        "VPN/proxy, or a Wine/VM network stack). Allow BeeZilla in the firewall, or set " +
        "BZ_SKIP_READY_PROBE=1 to open the window anyway and let the UI report what it can reach."
      : "The runtime process exited before answering, so this is a start-up failure: read the lines above " +
        "it for the reason (a missing data directory, a port already in use, or a module that failed to load).";
    const message =
      `local runtime did not answer within ${timeoutMs}ms. ` +
      `Probe: ${where} · ${lastProbe.error}${lastProbe.code ? ` (${lastProbe.code})` : ""} · ` +
      `last attempt ${lastProbe.ms}ms · runtime.json ${sawRuntimeFile ? "present" : "absent"} · ` +
      `process ${running ? "alive" : "exited"}. ${hint}`;

    // Escape hatch for environments where loopback from the shell is broken but the
    // port is genuinely serving (observed under Wine: the server logs "Listening"
    // and the host curls it fine, while the shell's fetch fails). Explicit, never
    // automatic, and never quiet.
    if (running && !signal.aborted && process.env.BZ_SKIP_READY_PROBE === "1") {
      const rt = this.captureOwnedRuntime(child);
      if (rt && Date.parse(rt.startedAt) >= launchedAt - 1000) {
        this.onLog(`[supervisor] BZ_SKIP_READY_PROBE=1 — opening the window without a healthy probe. ${message}`);
        this.runtime = rt;
        return rt;
      }
    }
    throw new Error(message);
  }

  /** A listening socket, asked without DNS (see probe()). */
  tcpReachable(port, host = "127.0.0.1") {
    return new Promise((done) => {
      const sock = connect(port, host);
      const finish = (ok) => {
        try { sock.destroy(); } catch { /* closed */ }
        done(ok);
      };
      sock.setTimeout(1200);
      sock.once("connect", () => finish(true));
      sock.once("timeout", () => finish(false));
      sock.once("error", () => finish(false));
    });
  }

  /** One readiness attempt, with the failure kept instead of discarded. */
  async probe(rt) {
    const started = Date.now();
    let base;
    try { base = runtimeOrigin(rt); } catch { return { ok: false, error: "invalid runtime endpoint", code: null, ms: 0, rt: null }; }
    try {
      const res = await fetch(`${base}/api/agent/health`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      if (res.ok) return { ok: true, error: null, code: null, ms: Date.now() - started, rt };
      return { ok: false, error: `HTTP ${res.status}`, code: String(res.status), ms: Date.now() - started, rt };
    } catch (err) {
      // undici can fail before sending a packet (name resolution on Wine/Windows
      // answers an opaque UNKNOWN). Ask the same question with a raw TCP connect to
      // the literal — a listening port must never be reported unreachable.
      const tcp = await this.tcpReachable(rt.port, rt.host);
      if (tcp) {
        return { ok: true, error: null, code: "tcp-only", ms: Date.now() - started, rt };
      }
      // fetch wraps the useful part: "fetch failed" alone hides ECONNREFUSED,
      // EHOSTUNREACH, a TLS problem, or a timeout.
      const cause = err?.cause ?? err;
      return {
        ok: false,
        error: String(err?.message ?? err),
        code: cause?.code ?? cause?.name ?? null,
        ms: Date.now() - started,
        rt,
      };
    }
  }

  readRuntimeFile() {
    try {
      const rt = JSON.parse(readFileSync(this.runtimeFile, "utf8"));
      runtimeOrigin(rt);
      if (!Number.isInteger(rt.pid) || rt.pid < 1 || typeof rt.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(rt.token)) return null;
      if (typeof rt.dataDir !== "string" || resolve(rt.dataDir) !== resolve(this.dataDir) || !Number.isFinite(Date.parse(rt.startedAt))) return null;
      return rt;
    } catch {
      return null;
    }
  }

  captureOwnedRuntime(child = this.child) {
    const launch = this.launch;
    if (!child || !launch || launch.child !== child || this.child !== child) return this.ownedRuntime;
    const rt = this.readRuntimeFile();
    if (!rt || Date.parse(rt.startedAt) < launch.startedAt) return this.ownedRuntime;
    if (launch.serverPid && launch.serverPid !== rt.pid) return this.ownedRuntime;
    // One generation cannot replace its established owner by editing the file.
    if (this.ownedRuntime && (this.ownedRuntime.pid !== rt.pid || this.ownedRuntime.token !== rt.token)) return this.ownedRuntime;
    this.ownedRuntime = rt;
    launch.serverPid = rt.pid;
    return rt;
  }

  async isHealthy(rt = this.runtime) {
    if (!rt) return false;
    try {
      const res = await fetch(`${runtimeOrigin(rt)}/api/agent/health`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Graceful stop: the runtime flushes PGLite before exiting. */
  async stop(options = {}) {
    this.stopping = true;
    this.startAbort?.abort();
    if (this.stopPromise) return this.stopPromise;
    const pending = this.stopOwned(options).finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    this.stopPromise = pending;
    return pending;
  }

  async stopOwned({ timeoutMs = 20_000 } = {}) {
    const child = this.child;
    const launch = this.launch;
    // Capture before signaling: the launcher removes runtime.json immediately,
    // possibly before the first readiness poll ever observes it.
    const owned = this.captureOwnedRuntime(child);
    const deadline = Date.now() + timeoutMs;
    const serverPid = launch?.serverPid ?? owned?.pid;
    if (serverPid && serverPid !== child?.pid && !launch?.serverExited) this.exitingPid = serverPid;
    // Ask the current launcher over IPC even before health is ready. Never
    // terminate an unknown pre-handshake generation and infer that it had no
    // server: it may already have spawned a database process.
    let requested = false;
    const requestStop = () => {
      if (requested || !alive(child)) return;
      this.captureOwnedRuntime(child);
      if (launch?.controlReady && child.connected) {
        requested = true;
        try { child.send({ type: "beezilla:stop" }, () => {}); }
        catch { requested = false; }
      } else if (launch?.serverPid) {
        requested = true;
        child.kill("SIGTERM");
      }
    };
    // Signal only our own launcher. It forwards the stop to its child.
    // A failed health check is NOT proof that a database process has exited.
    if (alive(child)) {
      requestStop();
      while (alive(child) && Date.now() < deadline) { await delay(25); requestStop(); }
      if (alive(child)) throw new Error("The local runtime has not stopped yet. No replacement was started to protect your data.");
    }
    // Drain queued ownership messages after exit before deciding that the
    // launcher never spawned a child. A missing message is not an all-clear.
    while (launch && !launch.closed && Date.now() < deadline) await delay(25);
    if (launch && !launch.serverPid && !launch.noServer) {
      this.shutdownUncertain = true;
      throw new Error("The launcher exited without confirming server ownership. Restart is blocked to protect your data.");
    }
    if (launch?.serverPid && launch.serverPid !== child?.pid && !launch.serverExited) this.exitingPid = launch.serverPid;
    // The launcher has its own bounded shutdown. Wait for the server PID too,
    // rather than assuming the launcher exit means PGLite has finished flushing.
    while (!launch?.serverExited && processAlive(this.exitingPid) && Date.now() < deadline) await delay(25);
    if (!launch?.serverExited && processAlive(this.exitingPid)) throw new Error("The local database process has not stopped yet. No replacement was started to protect your data.");
    this.exitingPid = null;
    const disk = this.readRuntimeFile();
    if (owned && disk?.token === owned.token) rmSync(this.runtimeFile, { force: true });
    if (this.child === child) this.child = null;
    this.runtime = null;
    this.ownedRuntime = null;
    this.launch = null;
  }
}
