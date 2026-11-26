#!/usr/bin/env node
/**
 * beezilla — the local runtime's command line.
 *
 * This is NOT a second implementation. The CLI supervises and talks to the same
 * local server the desktop window uses; `scripts/beezilla-local.mjs` owns the
 * process, this file owns the verbs. Anything the CLI can do, the window can do
 * and vice versa, because both go through one runtime and one auth token.
 *
 *   beezilla serve [--port N]   start the runtime in the foreground
 *   beezilla status             is it running, where, since when
 *   beezilla stop               graceful shutdown (PGLite flushes)
 *   beezilla doctor             diagnose install: build, assets, data dir, keys
 *   beezilla run "<message>"    one chat turn, printed to stdout
 *   beezilla export [file]      full local data as JSON (never trapped)
 *
 * Autostart: every command that needs a server starts one if none is running,
 * so a fresh install works from the first command with no ceremony.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, rmdirSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInference, saveInference, clearInference, redactKey, isExpired } from "../scripts/lib/inference.mjs";
import { resolvePins } from "../scripts/lib/pins.mjs";
import { loadManagedSearch, resolveSearch, saveSearchKey, clearSearchKey } from "../scripts/lib/search-keys.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "scripts", "beezilla-local.mjs");

function dataDir() {
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

const DATA = dataDir();
const RUNTIME_FILE = join(DATA, "runtime.json");

function readRuntimeRecord() {
  let text;
  try {
    text = readFileSync(RUNTIME_FILE, "utf8");
  } catch (error) {
    return { runtime: null, state: error.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    return { runtime: JSON.parse(text), state: "read" };
  } catch {
    return { runtime: null, state: "invalid" };
  }
}

// Other commands keep their existing absent/unreadable fallback behavior.
function readRuntime() {
  return readRuntimeRecord().runtime;
}

async function healthy(rt) {
  if (!rt?.port) return false;
  try {
    const res = await fetch(`http://${rt.host}:${rt.port}/api/agent/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function api(rt, path, init = {}) {
  const res = await fetch(`http://${rt.host}:${rt.port}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rt.token}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text is fine */
  }
  return { status: res.status, body };
}

/** Start the runtime detached and wait for runtime.json. */
async function ensureServer() {
  const existing = readRuntime();
  if (existing && (await healthy(existing))) return existing;

  mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BZ_DATA_DIR: DATA },
  });
  child.unref();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rt = readRuntime();
    if (rt && (await healthy(rt))) return rt;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("local runtime did not start within 120s (run `beezilla doctor`)");
}

// ── verbs ────────────────────────────────────────────────────────────────────

async function cmdServe(argv) {
  const child = spawn(process.execPath, [LAUNCHER, ...argv], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, BZ_DATA_DIR: DATA },
  });
  // A reported launcher failure must also fail for callers checking our exit status.
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

async function cmdStatus() {
  const { runtime: rt, state } = readRuntimeRecord();
  if (state === "missing") {
    console.log("not running");
    return 0;
  }
  if (state === "unreadable" || state === "invalid") {
    console.log(`runtime status unknown: runtime.json ${state === "invalid" ? "contains invalid JSON" : "could not be read"}`);
    return 1;
  }
  if (!rt || typeof rt.host !== "string" || !rt.host.trim() ||
      !Number.isInteger(rt.port) || rt.port < 1 || rt.port > 65535 ||
      !Number.isInteger(rt.pid) || rt.pid < 1 ||
      typeof rt.startedAt !== "string" || !Number.isFinite(Date.parse(rt.startedAt)) ||
      typeof rt.dataDir !== "string" || !rt.dataDir.trim()) {
    console.log("runtime status unknown: runtime.json has missing or invalid process details");
    return 1;
  }
  const up = await healthy(rt);
  if (!up) {
    console.log(`not answering  http://${rt.host}:${rt.port}`);
    console.log(`pid ${rt.pid}  started ${rt.startedAt}  (stale handshake — shutting down, or crashed)`);
    console.log(`data ${rt.dataDir}`);
    return 1;
  }
  console.log(`running  http://${rt.host}:${rt.port}`);
  console.log(`pid ${rt.pid}  since ${rt.startedAt}`);
  console.log(`data ${rt.dataDir}`);
  return 0;
}

async function cmdStop() {
  const rt = readRuntime();
  if (!rt) {
    console.log("not running");
    return 0;
  }
  try {
    process.kill(rt.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  // The server shuts down gracefully (PGLite must flush its WAL), and the
  // launcher removes the handshake file when the child exits. Wait for BOTH:
  // reporting "stopped" while runtime.json still names a live pid is how a CLI
  // starts telling the truth about a process that is still shutting down.
  const deadline = Date.now() + 25_000;
  let downAt = 0;
  while (Date.now() < deadline) {
    const alive = await healthy(rt);
    if (!alive && !downAt) downAt = Date.now();
    if (!alive && !existsSync(RUNTIME_FILE)) {
      console.log("stopped");
      return 0;
    }
    if (downAt && Date.now() - downAt > 10_000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!(await healthy(rt))) {
    console.log("server stopped, but runtime.json was left behind — remove it or start again");
    return 0;
  }
  console.log("still running after 25s — check the process manually");
  return 1;
}

async function cmdDoctor() {
  const checks = [];
  const ok = (name, pass, detail = "") => checks.push({ name, pass, detail, soft: false });
  const soft = (name, pass, detail = "") => checks.push({ name, pass, detail, soft: true });

  const libs = join(ROOT, ".output", "server", "_libs");
  const installed = join(ROOT, "node_modules", "@electric-sql", "pglite", "dist");
  const inspect = (path) => {
    try {
      const file = statSync(path, { throwIfNoEntry: false });
      return !file ? "missing" : !file.isFile() ? "not a regular file" : file.size === 0 ? "empty" : "present";
    } catch (error) {
      return `unreadable (${error.code ?? "stat failed"})`;
    }
  };
  const entry = ".output/server/index.mjs";
  const build = inspect(join(ROOT, entry));
  ok("build present", build === "present", build === "present" ? entry : `${entry} is ${build}`);
  let haveLoaderDir = false;
  try { haveLoaderDir = statSync(libs, { throwIfNoEntry: false })?.isDirectory() === true; } catch { /* report below */ }
  if (!haveLoaderDir) {
    ok("pglite assets", false, ".output/server/_libs directory is unavailable; the launcher restores files into that existing directory");
  } else {
    const restore = [], problems = [];
    for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
      const state = inspect(join(libs, name));
      if (state === "present") continue;
      if (state !== "missing") {
        // An existing file takes precedence; the launcher will not overwrite it.
        problems.push(`${name} is ${state} in .output/server/_libs`);
        continue;
      }
      const fallback = inspect(join(installed, name));
      if (fallback === "present") restore.push(name);
      else if (fallback === "missing") problems.push(`${name} missing from .output/server/_libs and node_modules/@electric-sql/pglite/dist`);
      else problems.push(`${name} absent in .output/server/_libs; installed copy is ${fallback}`);
    }
    const detail = problems.length ? problems.join("; ")
      : restore.length ? `${restore.join(", ")} available for launcher restore (requires write access to _libs)`
      : "already bundled in .output/server/_libs";
    ok("pglite assets", problems.length === 0, detail);
  }

  let writable = false;
  let probe, probeFile, cleanupHint = "";
  try {
    mkdirSync(DATA, { recursive: true });
    // A named file in the user's data tree might already belong to them.
    probe = mkdtempSync(join(DATA, ".doctor-"));
    const candidate = join(probe, "write");
    const fd = openSync(candidate, "wx");
    probeFile = candidate; // Clean only a file this process actually created.
    try { writeFileSync(fd, "ok"); }
    finally { closeSync(fd); }
    writable = statSync(probeFile).size > 0;
  } catch {
    writable = false;
  } finally {
    if (probe) {
      try {
        if (probeFile) rmSync(probeFile, { force: true });
        rmdirSync(probe); // Never recursively remove other files.
      } catch {
        cleanupHint = ` (could not remove temporary probe: ${probe})`;
      }
    }
  }
  ok("data dir writable", writable, DATA + cleanupHint);

  const inference = resolveInference(DATA);
  ok(
    "inference configured",
    Boolean(inference?.key) && !inference?.expired,
    inference
      ? inference.expired
        ? `${inference.provider} via ${inference.source} — managed session EXPIRED, reconnect (beezilla key set --provider beezilla --token …)`
        : `${inference.provider} via ${inference.source}${inference.expired ? "" : ""}${inference.encrypted === false ? " (stored UNENCRYPTED)" : ""}`
      : "no key — chat will refuse by name; the rest works offline",
  );

  // A build with no pinned publisher cannot trust a single fetched recipe, so
  // say it at install time rather than at the first import.
  // Search is optional: an install with no key still chats, it just cannot cite.
  // A soft check keeps `doctor` honest without failing a healthy install.
  const search = resolveSearch(DATA);
  // "off" and "your session lapsed" are different problems with different fixes.
  const staleSearch = !search && Boolean(loadManagedSearch(DATA));
  soft(
    "web search",
    Boolean(search),
    search
      ? search.provider === "beezilla"
        ? `BeeZilla search via our gateway (expires ${search.expiresAt ?? "unknown"}) — reconnect to renew`
        : `brave via ${search.source}${search.encrypted === false ? " (stored UNENCRYPTED)" : ""}`
      : staleSearch
        ? "BeeZilla search session expired — reconnect from Settings (BeeZilla → Settings), or use your own Brave key"
        : "not configured — the model answers without sources (beezilla key search set)",
  );

  const pins = resolvePins(ROOT);
  soft(
    "publisher keys pinned",
    pins.count > 0,
    pins.count > 0
      ? `${pins.count} pinned via ${pins.source} — fetched recipes can be trusted`
      : "NONE pinned — no fetched recipe will be trusted (set BZ_RECIPE_PUBLISHER_KEYS, or ship publishers.json in a release)",
  );

  const rt = readRuntime();
  ok("runtime", Boolean(rt && (await healthy(rt))), rt ? `http://${rt.host}:${rt.port}` : "not started");

  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "warn"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  // "inference configured" and "runtime" are states, not faults; "publisher keys"
  // is only a fault in a release build, so it warns rather than fails a dev install.
  const blocking = checks.filter((c) => !c.pass && !c.soft && c.name !== "inference configured" && c.name !== "runtime");
  return blocking.length ? 1 : 0;
}

async function cmdRun(argv) {
  const usage = () => {
    console.error('usage: beezilla run "<what you want>" [--job <id>] [--work]');
    console.error('       beezilla run [--job <id>] [--work] -- <literal message>');
    return 2;
  };
  let jobId;
  let mode = "chat";
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      // Everything after the separator is the user's message, not CLI options.
      parts.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--job") {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) return usage();
      jobId ??= value;
    } else if (arg === "--work") {
      mode = "work";
    } else if (!arg.startsWith("--")) {
      parts.push(arg);
    }
  }
  const message = parts.join(" ").trim();
  if (!message) return usage();
  // An expired managed token is a session problem, not a bad key. Spending a
  // request to learn that gives the user a confusing 401; say it up front.
  const cred = resolveInference(DATA);
  if (cred?.expired) {
    console.error(
      `your BeeZilla session expired at ${cred.expiresAt}. Reconnect with \`beezilla key set --provider beezilla --token <token>\`, or switch to your own key with --provider byok.`,
    );
    return 2;
  }

  const rt = await ensureServer();
  const { status, body } = await api(rt, "/api/buzzy/chat", {
    method: "POST",
    body: JSON.stringify({ message, jobId, mode }),
  });

  if (status !== 200) {
    console.error(body?.error ?? `request failed (${status})`);
    return 1;
  }
  // A 200 is not a success: the chat lane answers 200 with `ok:false` and
  // friendly copy when the model call fails ("trouble connecting"). Printing
  // that and exiting 0 tells a script everything is fine when nothing ran.
  if (body?.ok === false) {
    if (typeof body.reply === "string" && body.reply.trim()) console.error(body.reply);
    console.error(`[${body.code ?? "failed"}] ${body.error ?? "the turn did not complete"}`);
    return 1;
  }
  if (typeof body?.reply === "string" && body.reply.trim()) {
    console.log(body.reply);
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (body?.jobId) console.error(`\n[job ${body.jobId}]`);
  return 0;
}

function hasExportZipFraming(bytes) {
  // The workspace archive is never empty (it includes README.txt). A local
  // file header alone also appears in a truncated download; require its end
  // record, accounting for any ZIP comment, before writing the destination.
  const endSize = 22;
  if (bytes.length < endSize || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const min = Math.max(4, bytes.length - endSize - 0xffff);
  for (let at = bytes.length - endSize; at >= min; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + endSize + bytes.readUInt16LE(at + 20) === bytes.length) {
      return true;
    }
  }
  return false;
}

async function cmdExport(argv) {
  const target =
    argv[0] || join(process.cwd(), `beezilla-export-${new Date().toISOString().slice(0, 10)}.zip`);
  const rt = await ensureServer();
  // The export endpoint returns a ZIP of the owner's whole workspace, not JSON.
  // Read it as bytes — treating it as text produces a file that opens as mojibake.
  const res = await fetch(`http://${rt.host}:${rt.port}/api/buzzy/export`, {
    headers: { authorization: `Bearer ${rt.token}` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    console.error(`export failed (${res.status})`);
    return 1;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!hasExportZipFraming(bytes)) {
    console.error("export did not return a complete ZIP archive");
    return 1;
  }
  writeFileSync(target, bytes);
  console.log(`wrote ${target} (${bytes.length} bytes)`);
  return 0;
}

async function cmdKey(argv) {
  // `key search ...` manages web-search credentials; `key ...` manages inference.
  if (argv[0] === "search") {
    const action = argv[1] ?? "show";
    const flag = (name) => {
      const i = argv.indexOf(name);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    if (action === "set") {
      const key = flag("--key") ?? "";
      if (!key.trim()) {
        console.error('usage: beezilla key search set --key <BRAVE_API_KEY>');
        return 2;
      }
      const saved = saveSearchKey(DATA, { key });
      console.log(`saved brave search key ${redactKey(key)}${saved.encrypted ? " (encrypted)" : " (unencrypted — 0600 file)"}`);
      console.log("restart the runtime for it to take effect: beezilla stop && beezilla serve");
      return 0;
    }
    if (action === "clear") {
      clearSearchKey(DATA);
      console.log("web search credentials removed");
      return 0;
    }
    const inf = resolveSearch(DATA);
    if (!inf) {
      console.log("web search: not configured — answers will have no sources");
      return 0;
    }
    console.log(`provider  ${inf.provider} (${inf.source})`);
    console.log(`key       ${redactKey(inf.key)}`);
    if (inf.encrypted === false) console.log("storage   unencrypted file (0600) — the desktop app uses the OS keychain");
    return 0;
  }

  const sub = argv[0] ?? "show";
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  if (sub === "set") {
    const key = flag("--key") ?? flag("--token") ?? "";
    if (!key.trim()) {
      console.error('usage: beezilla key set --key <KEY> [--base-url <URL>] [--model <ID>] [--provider byok|beezilla]');
      return 2;
    }
    const saved = saveInference(DATA, {
      provider: flag("--provider") ?? "byok",
      key,
      baseUrl: flag("--base-url") ?? "",
      model: flag("--model") ?? "",
      expiresAt: flag("--expires-at") ?? "",
    });
    console.log(`saved ${saved.provider} key ${redactKey(key)}${saved.encrypted ? " (encrypted)" : " (unencrypted — 0600 file)"}`);
    if (saved.expiresAt) console.log(`expires   ${saved.expiresAt}${isExpired(saved) ? " — ALREADY EXPIRED" : ""}`);
    if (saved.provider === "beezilla" && !saved.baseUrl) console.error("no base url — managed inference needs ours");
    console.log("restart the runtime for it to take effect: beezilla stop && beezilla serve");
    return 0;
  }

  if (sub === "clear") {
    clearInference(DATA);
    console.log("inference credentials removed");
    return 0;
  }

  const inf = resolveInference(DATA);
  if (!inf) {
    console.log("none configured — chat will refuse by name until a key is set");
    return 0;
  }
  console.log(`provider  ${inf.provider} (${inf.source})`);
  console.log(`key       ${redactKey(inf.key)}`);
  if (inf.expiresAt) {
    console.log(`expires   ${inf.expiresAt}${isExpired(inf) ? " — EXPIRED, reconnect" : ""}`);
  }
  console.log(`base url  ${inf.baseUrl || "(provider default)"}`);
  console.log(`model     ${inf.model || "(provider default)"}`);
  if (inf.encrypted === false) console.log("storage   unencrypted file (0600) — the desktop app uses the OS keychain");
  return 0;
}

async function cmdRecipe(argv) {
  const sub = argv[0] ?? "list";
  // Only the explicit add verb may reach the import branch below.
  if (!["list", "catalog", "fetch", "verify", "add"].includes(sub)) {
    console.error("usage: beezilla recipe <list|catalog|fetch|verify|add> [argument]");
    return 2;
  }
  const rt = await ensureServer();

  const post = async (path, bodyObj) => {
    const { status, body } = await api(rt, path, { method: "POST", body: JSON.stringify(bodyObj) });
    return { status, body };
  };

  if (sub === "list") {
    const { status, body } = await api(rt, "/api/recipes/local");
    if (status !== 200) {
      console.error(`recipe list failed (${status}): ${body?.error ?? ""}`);
      return 1;
    }
    if (!body.pins) {
      console.log("no publisher keys pinned in this build — nothing can be trusted (set BZ_RECIPE_PUBLISHER_KEYS)");
    }
    if (!body.valid?.length && !body.rejected?.length) {
      console.log("no recipes cached");
      return 0;
    }
    for (const r of body.valid ?? []) console.log(`ok    ${r.id}@${r.version}  ${r.title}`);
    for (const r of body.rejected ?? []) console.log(`BAD   ${r.file}  ${r.reason}${r.detail ? ` — ${r.detail}` : ""}`);
    return (body.rejected?.length ?? 0) > 0 ? 1 : 0;
  }

  // The catalog is the only cloud call: list what the cloud offers, then install
  // one. Fetch verifies against pinned publishers server-side; the CLI only relays
  // the verdict, so there is one implementation of "is this trustworthy".
  if (sub === "catalog") {
    const { status, body } = await api(rt, "/api/recipes/local/catalog");
    if (status !== 200) {
      console.error(`catalog failed (${status}): ${body?.error ?? ""}`);
      return 1;
    }
    if (!body.configured) {
      console.log(`no catalog configured — ${body.error}`);
      return 0;
    }
    if (!body.ok) {
      console.error(`catalog unreachable: ${body.error}`);
      return 1;
    }
    if (!body.entries?.length) {
      console.log(`catalog ${body.catalog} is empty`);
      return 0;
    }
    console.log(`catalog ${body.catalog}`);
    for (const e of body.entries) console.log(`  ${e.id}@${e.version}  ${e.title ?? ""}`);
    return 0;
  }

  if (sub === "fetch") {
    const id = argv.slice(1).find((a) => !a.startsWith("-"));
    if (!id) {
      console.error("usage: beezilla recipe fetch <id>");
      return 2;
    }
    const { status, body } = await post("/api/recipes/local/fetch", { id });
    if (body?.ok && status === 201) {
      console.log(`installed ${body.cached?.id}@${body.cached?.version} (${body.cached?.title ?? body.entry?.title ?? ""})`);
      return 0;
    }
    console.error(`refused: ${body?.error ?? body?.reason ?? status}${body?.detail ? ` — ${body.detail}` : ""}`);
    return 1;
  }

  const file = argv.find((a) => !a.startsWith("-") && a !== sub);
  if (!file) {
    console.error(`usage: beezilla recipe ${sub} <file.bezz>`);
    return 2;
  }
  const bytes = readFileSync(file);
  const bundle = bytes.toString("base64");
  const path = sub === "verify" ? "/api/recipes/local/verify" : "/api/recipes/local";
  const { status, body } = await post(path, { bundle });

  if (sub === "verify") {
    const verdict = body?.ok ? `trusted (${body.anchor})` : `${body?.reason ?? "invalid"}${body?.detail ? ` — ${body.detail}` : ""}`;
    console.log(`${body?.ok ? "ok" : "BAD"}  ${body?.recipe?.id ?? file}${body?.recipe?.version ? `@${body.recipe.version}` : ""}: ${verdict}`);
    return body?.ok ? 0 : 1;
  }

  if (status === 201 && body?.ok) {
    console.log(`added ${body.cached?.id}@${body.cached?.version} (${body.cached?.title}), verified against ${body.anchor}`);
    return 0;
  }
  console.error(`refused: ${body?.reason ?? status}${body?.detail ? ` — ${body.detail}` : ""}`);
  return 1;
}

const [, , verb, ...rest] = process.argv;
const verbs = {
  serve: cmdServe,
  status: cmdStatus,
  stop: cmdStop,
  doctor: cmdDoctor,
  run: cmdRun,
  export: cmdExport,
  key: cmdKey,
  recipe: cmdRecipe,
};

const fn = verbs[verb];
if (!fn) {
  console.log(`beezilla <command>\n\n  serve [--port N]   start the runtime\n  status             is it running\n  stop               graceful shutdown\n  doctor             diagnose this install\n  run "<message>"    one chat turn [--job id] [--work]\n  export [file]      full local data as ZIP\n  key set|show|clear inference credentials (BYOK, or ours via device token)\n  key search set|show|clear  web search credentials (Brave; ours or BYOK)`);
  const requestedHelp = !verb || ["--help", "-h", "help"].includes(verb);
  process.exit(requestedHelp ? 0 : 2);
}
// Let stdout and stderr drain, including asynchronous writes to pipes.
process.exitCode = await fn(rest);
