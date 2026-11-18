#!/usr/bin/env node
/**
 * Database isolation regression tests for the shared hosted/desktop runtime.
 *
 * Node built-ins only: evaluates the actual DB, auth and launcher source with
 * mocked drivers/IO. No provider, Postgres, filesystem writes, or build needed.
 * This verifies backend selection and launch boundaries, NOT end-to-end parity.
 *
 * Run (Node 22.13+):
 *   node --experimental-vm-modules --test scripts/test-local-db-boundary.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_URL = "postgresql://fake:fake@remote.invalid/example";
const silentConsole = { log() {}, warn() {}, error() {} };

function synthetic(context, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
}

/** Evaluate real modules with explicit, fail-closed dependency mocks. */
function sourceLoader(context, mocks) {
  const modules = new Map();
  async function resolve(specifier, parent) {
    if (mocks.has(specifier)) {
      if (!modules.has(specifier)) modules.set(specifier, synthetic(context, mocks.get(specifier)));
      return modules.get(specifier);
    }
    if (!specifier.startsWith(".")) throw new Error(`Unmocked import: ${specifier}`);
    const resolved = path.resolve(path.dirname(fileURLToPath(parent.identifier)), specifier);
    return load(resolved.endsWith(".ts") || resolved.endsWith(".mjs") ? resolved : `${resolved}.ts`);
  }
  async function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const source = await readFile(filename, "utf8");
    const module = new vm.SourceTextModule(
      filename.endsWith(".ts") ? stripTypeScriptTypes(source) : source,
      {
        context,
        identifier: pathToFileURL(filename).href,
        initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; },
        async importModuleDynamically(specifier, parent) {
          const imported = await resolve(specifier, parent);
          if (imported.status === "unlinked") await imported.link(resolve);
          if (imported.status === "linked") await imported.evaluate();
          return imported;
        },
      },
    );
    modules.set(filename, module);
    return module;
  }
  return async (filename) => {
    const module = await load(path.join(ROOT, filename));
    if (module.status === "unlinked") await module.link(resolve);
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  };
}

async function databaseHarness(env) {
  const observed = { pools: [], embedded: [], sqlQueries: [] };
  class Pool {
    constructor(options) { observed.pools.push(options); }
    async query(text, params) {
      observed.sqlQueries.push({ text, params });
      return { rows: [] };
    }
  }
  class PGlite {
    constructor(options) {
      this.options = options;
      this.waitReady = Promise.resolve();
      observed.embedded.push(this);
    }
    async exec() {}
    async query() { return { rows: [] }; }
    async transaction(callback) { return callback(this); }
  }
  const context = vm.createContext({
    process: { env: { ...env }, cwd: () => ROOT },
    console: silentConsole,
    URL,
    Request,
    Response,
  });
  const mocks = new Map([
    ["pg", { Pool, types: { setTypeParser() {} } }],
    ["@electric-sql/pglite", { PGlite }],
    ["node:os", { homedir: () => "/test-home", platform: () => "linux" }],
    ["node:path", { ...path }],
    ["node:url", { fileURLToPath }],
    ["node:fs", { accessSync() {}, mkdirSync() {}, constants: { W_OK: 2 } }],
    ["node:fs/promises", { readdir: async () => [], readFile: async () => { throw new Error("Unexpected file read"); } }],
    ["node:crypto", { randomBytes: () => ({ toString: () => "test-only-auth-secret" }) }],
    ["better-auth", { betterAuth: (options) => ({ options }) }],
    ["better-auth/plugins", { bearer: () => ({}), genericOAuth: () => ({}), magicLink: () => ({}) }],
    ["better-auth/tanstack-start", { tanstackStartCookies: () => ({}) }],
    ["@tanstack/react-start/server", { getCookie: () => undefined }],
    ["./email-password", { emailAndPasswordEnabled: false }],
    ["./providers", { GROK_PROVIDERS: [] }],
    ["./pglite-dialect", { pgliteDialect: (getClient) => ({ kind: "pglite", getClient }) }],
    ["../product-hosts", { isConsumerHost: () => false }],
    ["../mailer", { sendVerificationMail() {}, sendMagicLinkMail() {} }],
    ["./preview", {
      GROK_ISSUER_DEFAULT: "https://auth.invalid",
      PREVIEW_ALLOWED_HOSTS: [],
      PREVIEW_CLIENT_ID: "test-id",
      PREVIEW_CLIENT_SECRET: "test-secret",
    }],
  ]);
  const evaluate = sourceLoader(context, mocks);
  const db = await evaluate("src/lib/db.ts");
  await db.ensureDbReady();
  const { auth } = await evaluate("src/lib/auth/server.ts");
  return { db, auth, observed, context };
}

for (const mode of ["local", "  LOCAL  "]) {
  test(`${JSON.stringify(mode)} ignores remote DATABASE_URL for app and auth`, async () => {
    const { db, auth, observed } = await databaseHarness({
      BZ_RUNTIME: mode,
      BZ_DATA_DIR: " /test-data/local-db ",
      DATABASE_URL: REMOTE_URL,
    });
    assert.equal(db.dbSource, "pglite");
    const pg = await db.getPglite();
    assert.equal(pg.options.dataDir, "/test-data/local-db");
    assert.equal(auth.options.database.type, "postgres");
    assert.equal(auth.options.database.dialect.kind, "pglite");
    assert.equal(await auth.options.database.dialect.getClient(), pg);
    await (await db.getSql()).query("select 1");
    assert.equal(observed.embedded.length, 1, "app and auth share one PGLite instance");
    assert.equal(observed.pools.length, 0, "no remote pool was even constructed");
  });
}

test("local mode defaults to a durable per-user data path", async () => {
  const { db, observed } = await databaseHarness({ BZ_RUNTIME: "local", DATABASE_URL: REMOTE_URL });
  assert.equal(db.dbSource, "pglite");
  assert.equal(observed.embedded[0].options.dataDir, "/test-home/.local/share/beezilla/data");
  assert.equal(observed.pools.length, 0);
});

for (const mode of [undefined, "cloud"]) {
  test(`${mode ?? "unset"} runtime preserves hosted Postgres for app and auth`, async () => {
    const { db, observed } = await databaseHarness({ BZ_RUNTIME: mode, DATABASE_URL: REMOTE_URL });
    assert.equal(db.dbSource, "neon");
    await (await db.getSql()).query("select 1");
    assert.equal(observed.embedded.length, 0);
    assert.equal(observed.pools.length, 2, "hosted app and auth each retain their pool");
    for (const options of observed.pools) assert.equal(options.connectionString, REMOTE_URL);
    await assert.rejects(db.getPglite(), /active backend is PGLite/);
  });
}

test("hosted preview without DATABASE_URL retains the in-memory fallback", async () => {
  const { db, auth, observed } = await databaseHarness({ DATABASE_URL: "   " });
  assert.equal(db.dbSource, "pglite");
  assert.equal(observed.embedded.length, 1);
  assert.equal(observed.embedded[0].options.dataDir, undefined);
  assert.equal(auth.options.database.dialect.kind, "pglite");
  assert.equal(observed.pools.length, 0);
});

test("launcher strips inherited database/hosted routing settings without dropping unrelated configuration", async () => {
  const databaseEnv = {
    DATABASE_URL: REMOTE_URL,
    DATABASE_URL_UNPOOLED: REMOTE_URL,
    DIRECT_URL: REMOTE_URL,
    PGHOST: "remote.invalid",
    PGPORT: "5432",
    PGDATABASE: "hosted",
    PGUSER: "fake",
    PGPASSWORD: "fake",
    PGSSLMODE: "require",
    PGSERVICE: "hosted",
    POSTGRES_URL: REMOTE_URL,
    POSTGRES_PRISMA_URL: REMOTE_URL,
    Postgres_Password: "fake",
    Database_Url: REMOTE_URL,
    PgHost: "remote.invalid",
    BZ_MOVE_BUZZY: "1",
    Bz_Move_Buzzy: "1",
  };
  const env = { ...databaseEnv, BZ_DATA_DIR: "/test-data", BZ_CHAT_KEY: "fake-byok", PATH: "/test-bin" };
  let spawned;
  let runtime;
  const timer = { unref() {} };
  const context = vm.createContext({
    console: silentConsole,
    process: {
      env,
      argv: ["node", "beezilla-local.mjs"],
      pid: 123,
      ppid: 122,
      execPath: "/test-bin/node",
      on() {},
      exit(code) { throw new Error(`Unexpected launcher exit: ${code}`); },
    },
    setInterval: () => timer,
    setTimeout: () => timer,
    AbortSignal,
    fetch: async () => ({ ok: true, status: 200 }),
  });
  const mocks = new Map([
    ["node:child_process", { spawn: (command, args, options) => {
      spawned = { command, args, options };
      return { pid: 124, on() {}, kill() {} };
    } }],
    ["node:crypto", { randomBytes: () => ({ toString: () => "test-only-launch-token" }) }],
    ["node:fs", {
      existsSync: () => true,
      mkdirSync() {},
      rmSync() {},
      readFileSync() { throw new Error("Unexpected read"); },
      copyFileSync() { throw new Error("Unexpected asset copy"); },
      writeFileSync(_file, value) { runtime = JSON.parse(value); },
    }],
    ["node:net", {
      connect() { throw new Error("Unexpected network connection"); },
      createServer() {
        const callbacks = new Map();
        return {
          once(event, callback) { callbacks.set(event, callback); return this; },
          listen(_port, host) { assert.equal(host, "127.0.0.1"); queueMicrotask(() => callbacks.get("listening")()); },
          close(callback) { callback(); },
        };
      },
    }],
    ["node:os", { homedir: () => "/test-home", platform: () => "linux" }],
    ["node:path", { ...path }],
    ["node:url", { fileURLToPath }],
    ["./lib/inference.mjs", { isExpired: () => false, resolveInference: () => null }],
    ["./lib/search-keys.mjs", { loadManagedSearch: () => null, resolveSearch: () => null }],
  ]);
  await sourceLoader(context, mocks)("scripts/beezilla-local.mjs");
  assert.ok(spawned);
  const childEnv = spawned.options.env;
  for (const key of Object.keys(databaseEnv)) {
    assert.equal(Object.hasOwn(childEnv, key), false, `must not forward ${key}`);
    assert.equal(env[key], databaseEnv[key], "parent environment must not be mutated");
  }
  assert.equal(childEnv.BZ_RUNTIME, "local");
  assert.equal(childEnv.BZ_DATA_DIR, "/test-data");
  assert.equal(childEnv.BZ_CHAT_KEY, "fake-byok");
  assert.equal(childEnv.PATH, "/test-bin");
  assert.equal(childEnv.HOST, "127.0.0.1");
  assert.equal(childEnv.NITRO_HOST, "127.0.0.1");
  assert.equal(childEnv.BZ_LOCAL_TOKEN, runtime.token);
  assert.equal(runtime.port, 7331);
});
