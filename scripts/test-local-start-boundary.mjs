#!/usr/bin/env node
/**
 * Local startup must not migrate a hosted DB, bind publicly, or redirect its UI
 * to the cloud.
 * Node built-ins only; migrations use a fake pg driver for the hosted checks.
 * Run: node --experimental-vm-modules --test scripts/test-local-start-boundary.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_URL = "postgresql://fake:fake@remote.invalid/example";
const silent = { log() {}, warn() {}, error() {} };
function stub(context, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
}

for (const mode of ["local", " LOCAL ", "cloud", undefined]) {
  test(`generic start configures ${mode ?? "unset"} bind before loading the server`, async () => {
    const env = { BZ_RUNTIME: mode, HOST: "::", NITRO_HOST: "0.0.0.0", PORT: "7444", NITRO_PORT: "7444" };
    const local = typeof mode === "string" && mode.trim().toLowerCase() === "local";
    const context = vm.createContext({ process: { env } });
    let imports = 0;
    const module = new vm.SourceTextModule(await readFile(path.join(ROOT, "scripts/start-server.mjs"), "utf8"), {
      context,
      async importModuleDynamically(specifier) {
        imports++;
        assert.equal(specifier, "../.output/server/index.mjs");
        assert.equal(env.HOST, local ? "127.0.0.1" : "0.0.0.0");
        assert.equal(env.NITRO_HOST, env.HOST);
        assert.equal(env.PORT, "7444");
        assert.equal(env.NITRO_PORT, "7444");
        const server = stub(context, {});
        await server.link(() => { throw new Error("Unexpected server dependency"); });
        await server.evaluate();
        return server;
      },
    });
    await module.link(() => { throw new Error("Built server must be imported after configuring the bind"); });
    await module.evaluate();
    assert.equal(imports, 1);
  });
}

test("npm start uses the guarded migrator and bind wrapper", async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node scripts/migrate.mjs && node scripts/start-server.mjs");
});

for (const mode of ["local", " LOCAL "]) {
  test(`direct migrator skips remote DB in ${JSON.stringify(mode)} mode`, async () => {
    const { stdout } = await run(process.execPath, ["scripts/migrate.mjs"], {
      cwd: ROOT, env: { ...process.env, BZ_RUNTIME: mode, DATABASE_URL: REMOTE_URL }, timeout: 5000,
    });
    assert.match(stdout, /local runtime.*skipping remote migrations/);
  });
}

test("blank hosted DATABASE_URL still skips migrations", async () => {
  const { stdout } = await run(process.execPath, ["scripts/migrate.mjs"], {
    cwd: ROOT, env: { ...process.env, BZ_RUNTIME: "cloud", DATABASE_URL: "   " }, timeout: 5000,
  });
  assert.match(stdout, /DATABASE_URL not set.*skipping/);
});

for (const mode of [undefined, "cloud"]) {
  test(`${mode ?? "unset"} mode retains hosted migration execution`, async () => {
    const queries = [];
    let options;
    let released = false;
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    const context = vm.createContext({
      console: silent,
      process: { env: { BZ_RUNTIME: mode, DATABASE_URL: REMOTE_URL }, exit: (code) => { throw new Error(`Unexpected exit ${code}`); } },
    });
    const client = { query: async (text) => { queries.push(text); return { rows: [] }; }, release() { released = true; } };
    class Pool {
      constructor(opts) { options = opts; }
      async connect() { return client; }
      async end() { close(); }
    }
    const pg = stub(context, { default: { Pool } });
    const mocks = {
      "node:fs/promises": { readdir: async () => ["0100_test.sql"], readFile: async () => "SELECT 1;" },
      "node:url": { fileURLToPath },
      "node:path": { dirname: path.dirname, join: path.join },
    };
    const module = new vm.SourceTextModule(await readFile(path.join(ROOT, "scripts/migrate.mjs"), "utf8"), {
      context,
      initializeImportMeta(meta) { meta.url = new URL("./migrate.mjs", import.meta.url).href; },
      async importModuleDynamically(specifier) {
        assert.equal(specifier, "pg");
        await pg.link(() => { throw new Error("Unexpected pg dependency"); });
        await pg.evaluate();
        return pg;
      },
    });
    await module.link((specifier) => {
      assert.ok(mocks[specifier], `Unexpected migration import ${specifier}`);
      return stub(context, mocks[specifier]);
    });
    await module.evaluate();
    await closed;
    assert.equal(options.connectionString, REMOTE_URL);
    assert.equal(released, true);
    assert.match(queries[0], /^CREATE TABLE IF NOT EXISTS _migrations/);
    assert.ok(queries.includes("BEGIN"));
    assert.ok(queries.includes("SELECT 1;"));
    assert.ok(queries.includes("COMMIT"));
  });
}

async function route(env, { host = "127.0.0.1:7331", pathname = "/buzzy/talk", method = "GET", forwarded } = {}) {
  const redirects = [];
  const context = vm.createContext({ process: { env }, console: silent });
  const h3 = {
    defineEventHandler: (handler) => handler,
    getRequestURL: () => new URL(`http://${host}${pathname}`),
    sendRedirect: (_event, location, status) => { redirects.push({ location, status }); },
  };
  const modules = new Map();
  const builtin = { h3, "node:os": { ...os }, "node:path": { ...path }, "node:fs": { ...fs } };
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = builtin[name]
      ? stub(context, builtin[name])
      : new vm.SourceTextModule(stripTypeScriptTypes(await readFile(path.join(ROOT, "src/lib", `${name}.ts`), "utf8")), { context });
    modules.set(name, module);
    return module;
  }
  const module = await load("host-router.nitro");
  await module.link((specifier) => load(specifier.replace(/^\.\//, "")));
  await module.evaluate();
  module.namespace.default({ node: { req: { method, headers: { host, ...(forwarded ? { "x-forwarded-host": forwarded } : {}) } } } });
  return redirects;
}

for (const mode of ["local", " LOCAL "]) {
  test(`${JSON.stringify(mode)} UI never takes the hosted product redirect`, async () => {
    assert.deepEqual(await route({ BZ_RUNTIME: mode, BZ_MOVE_BUZZY: "1" }), []);
    assert.deepEqual(await route({ BZ_RUNTIME: mode, BZ_MOVE_BUZZY: "1" }, { pathname: "/buzzy/talk?job=123", forwarded: "www.beezilla.net" }), []);
    assert.deepEqual(await route({ BZ_RUNTIME: mode, BZ_MOVE_BUZZY: "1", BZ_CONSUMER_HOSTS: "127.0.0.1" }, { pathname: "/" }), []);
  });
}

test("cloud console cutover keeps its existing GET/HEAD redirects and query", async () => {
  for (const method of ["GET", "HEAD"]) {
    assert.deepEqual(await route({ BZ_RUNTIME: "cloud", BZ_MOVE_BUZZY: "1" }, { host: "app.devboards.ai", pathname: "/buzzy/talk?job=123", method }), [
      { location: "https://beezilla.net/buzzy/talk?job=123", status: 301 },
    ]);
  }
});

test("cloud cutover stays gated, does not redirect POST or agent APIs", async () => {
  assert.deepEqual(await route({}), []);
  assert.deepEqual(await route({ BZ_MOVE_BUZZY: "1" }, { method: "POST" }), []);
  assert.deepEqual(await route({ BZ_MOVE_BUZZY: "1" }, { pathname: "/api/agent/health" }), []);
});

test("cloud consumer front door and canonical host behavior remain unchanged", async () => {
  assert.deepEqual(await route({}, { host: "beezilla.net" }), []);
  assert.deepEqual(await route({}, { host: "beezilla.net", pathname: "/" }), [{ location: "/buzzy/talk", status: 302 }]);
  assert.deepEqual(await route({}, { host: "www.beezilla.net", pathname: "/buzzy/talk?job=123" }), [
    { location: "https://beezilla.net/buzzy/talk?job=123", status: 301 },
  ]);
});
