// Real Nitro routes, graph SQL, strict preferences, runner and buffered client.
// Synthetic identity, in-memory SQL, and stubbed frontier, pricing and fetch.
// Covers these admission checkpoints only, not live authentication or egress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(process.env.BZ_GRAPH_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const sources = Object.fromEntries(['chat.nitro', 'graphs', 'runner', 'modelPrefs', 'llm'].map(name => [
  './' + name, stripTypeScriptTypes(readFileSync(resolve(root, 'src/lib/buzzy', name + '.ts'), 'utf8')),
]));
const plain = value => JSON.parse(JSON.stringify(value));

const owner = 'fixture-owner';
const another = 'different-account';
const model = 'fixture/fruit-sort';
const modelBase = 'https://graph-fixture.invalid/v1';
const modelKey = 'fixture-not-a-secret';
const graphPath = id => '/api/buzzy/graphs/' + id;
const start = id => graphPath(id) + '/run';
const runs = id => '/api/buzzy/runs/' + id;
const approve = id => runs(id) + '/approve';
const graph = {
  title: 'Fruit list',
  nodes: [
    { key: 'a-sort', kind: 'agent', title: 'Sort fruit', config: { model, prompt: 'Sort the sample fruit list.' }, x: 500, y: 0 },
    { key: 'b-gate', kind: 'gate', title: 'Check the fruit list' },
    { key: 'c-label', kind: 'skill', title: 'Label list', config: { model, skill: 'Add a heading' }, x: 50, y: 0 },
  ],
  edges: [{ from: 'a-sort', to: 'b-gate', kind: 'gate' }, { from: 'b-gate', to: 'c-label', kind: 'data' }],
};

function completion(text = 'Fig, plum', usage = 'with usage') {
  return Response.json({
    model,
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    ...(usage === 'omitted' ? {} : {
      usage: usage === 'null' ? null : { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }),
  });
}

async function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.function('now', () => '2026-01-02T00:00:00.000Z');
  db.exec(`
    CREATE TABLE ar_operator_prefs (user_id TEXT PRIMARY KEY, prefs TEXT);
    CREATE TABLE buzzy_graphs (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, description TEXT, spec TEXT,
      version INTEGER DEFAULT 1, updated_at TEXT DEFAULT '2026-01-02');
    CREATE TABLE buzzy_graph_nodes (id TEXT PRIMARY KEY, graph_id TEXT, node_key TEXT, kind TEXT, title TEXT,
      config TEXT, pos_x REAL, pos_y REAL);
    CREATE TABLE buzzy_graph_edges (id INTEGER PRIMARY KEY, graph_id TEXT, from_key TEXT, to_key TEXT, kind TEXT,
      UNIQUE (graph_id, from_key, to_key, kind));
    CREATE TABLE buzzy_graph_runs (id TEXT PRIMARY KEY, graph_id TEXT, user_id TEXT, status TEXT, spec TEXT,
      cost_usd REAL DEFAULT 0, error TEXT, started_at TEXT DEFAULT '2026-01-02', finished_at TEXT);
    CREATE TABLE buzzy_graph_node_results (id INTEGER PRIMARY KEY, run_id TEXT, node_key TEXT, attempt INTEGER,
      status TEXT, output TEXT, input TEXT, provider TEXT, model TEXT, independent INTEGER, latency_ms INTEGER,
      cost_usd REAL, error TEXT, started_at TEXT, finished_at TEXT, UNIQUE (run_id, node_key, attempt));
  `);
  const prefs = value => {
    if (value === undefined) db.prepare('DELETE FROM ar_operator_prefs WHERE user_id = ?').run(owner);
    else db.prepare('INSERT OR REPLACE INTO ar_operator_prefs VALUES (?, ?)').run(owner, JSON.stringify(value));
  };
  let verified = owner, prefsError = false, onPin, afterSql, duringPrice;
  const seen = { auth: [], prefReads: [], catalog: 0, pins: 0, completions: [], prices: 0, runWrites: 0, readback: 0 };
  const replies = [], unexpected = [];
  t.after(() => assert.deepEqual(unexpected, [], 'unrelated routes or outbound calls were attempted'));

  // Adapt only SQL parameter/cast spelling and JSON decoding; run decisions are
  // made by the actual Graph modules against these in-memory tables.
  const sql = async (strings, ...values) => {
    const statement = strings.join('?').replace(/::(?:jsonb|int|text)\b/g, '');
    const normalized = statement.replace(/\s+/g, ' ').trim();
    if (/from ar_operator_prefs/i.test(statement)) {
      seen.prefReads.push(values[0]);
      if (prefsError) throw Error('Synthetic preference read failure');
    }
    if (/^(?:insert into|update) buzzy_graph_(?:runs|node_results)/i.test(normalized)) seen.runWrites++;
    if (/^SELECT (?:id, graph_id, status, error|node_key, attempt, status, provider)/i.test(normalized)) seen.readback++;
    const rows = db.prepare(statement).all(...values).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, typeof value === 'string' && ['config', 'prefs', 'spec', 'output', 'input'].includes(key) ? JSON.parse(value) : value,
    ])));
    afterSql?.(normalized);
    return rows;
  };

  function forbidden(label) {
    unexpected.push(label);
    throw Error('Unexpected test dependency: ' + label);
  }
  const context = vm.createContext({
    URL, URLSearchParams, Headers,
    // No ambient environment, credentials, network, timers or system imports.
    process: { env: {
      BZ_CHAT_BASE_URL: modelBase,
      BZ_CHAT_KEY: modelKey,
      BZ_CHAT_MODEL: model,
      get BZ_CHAT_MODELS() { seen.catalog++; return JSON.stringify([{ label: model, model }]); },
    } },
    async fetch(url, init) {
      if (url !== modelBase + '/chat/completions' || init?.method !== 'POST' || init.headers?.Authorization !== 'Bearer ' + modelKey) {
        forbidden('fetch ' + init?.method + ' ' + url);
      }
      seen.completions.push(JSON.parse(init.body));
      return replies.length ? replies.shift()() : completion();
    },
  }, { codeGeneration: { strings: false, wasm: false } });

  const deps = {
    h3: {
      defineEventHandler: fn => fn,
      getMethod: event => event.req.method,
      setResponseStatus(event, status) { event.status = status; },
    },
    '@/lib/db': { getSql: async () => sql },
    '@/lib/auth/verify.server': {
      async getSessionUserFromHeaders(headers, options) {
        assert.equal(headers.get('x-synthetic-request'), 'original');
        const authoritative = options?.authoritative === true;
        seen.auth.push(authoritative);
        // Ordinary auth retains a deliberately stale view after revocation.
        return authoritative ? (verified ? { id: verified } : null) : { id: owner };
      },
    },
    './frontier': {
      providerOf: id => id.split('/')[0],
      async resolvePinLive(pin) {
        seen.pins++;
        onPin?.();
        return { model: pin.model, provider: 'fixture' };
      },
      resolveReviewLive: () => forbidden('frontier review'),
    },
    './pricing': {
      async costOf() { seen.prices++; await duringPrice?.(); return 0.01; },
    },
  };

  const modules = new Map(Object.entries(sources).map(([specifier, source]) => [
    specifier, new vm.SourceTextModule(source, { context, identifier: specifier }),
  ]));
  const mocks = new Map();
  const route = modules.get('./chat.nitro');
  await route.link((specifier, importer) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (importer !== route && !Object.hasOwn(deps, specifier)) return forbidden('import ' + specifier);
    if (mocks.has(specifier)) return mocks.get(specifier);
    // Stub the route's unrelated named imports by their requested export name;
    // none may be called. Never load server modules by dynamic path.
    const names = new Set(Object.keys(deps[specifier] ?? {}));
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
        if (match[2] !== specifier) continue;
        for (const name of match[1].split(',')) {
          if (name.trim()) names.add(name.trim().split(/\s+as\s+/)[0]);
        }
      }
    }
    const mock = new vm.SyntheticModule([...names], function () {
      for (const name of names) this.setExport(name, deps[specifier]?.[name] ?? (() => forbidden(specifier + '.' + name)));
    }, { context, identifier: 'mock:' + specifier });
    mocks.set(specifier, mock);
    return mock;
  });
  await route.evaluate({ timeout: 1000 });

  async function request(path, method = 'GET', body) {
    assert.match(path, /^\/api\/buzzy\/(?:graphs(?:\/[\w-]+(?:\/run)?)?|runs\/[\w-]+(?:\/approve)?)(?:\?[^#]*)?$/);
    const event = {
      path, status: 200,
      req: { method, headers: new Headers({ 'x-synthetic-request': 'original' }), json: async () => body },
    };
    return { json: plain(await route.namespace.default(event)), status: event.status };
  }
  return {
    request, prefs, seen, replies, api: modules.get('./llm').namespace,
    state: () => JSON.stringify(['buzzy_graph_runs', 'buzzy_graph_node_results']
      .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all())),
    setVerified(value) { verified = value; },
    failPrefs() { prefsError = true; },
    onPin(fn) { onPin = fn; },
    afterSql(fn) { afterSql = fn; },
    duringPrice(fn) { duringPrice = fn; },
  };
}

async function save(h, spec = graph) {
  const r = await h.request('/api/buzzy/graphs', 'POST', spec);
  assert.equal(r.status, 200);
  assert.ok(r.json.id);
  return r.json.id;
}

async function pauseAtGate(h) {
  const r = await h.request(start(await save(h)), 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.json.run.status, 'awaiting_approval');
  assert.equal(h.seen.completions.length, 1);
  return r.json.runId;
}

function assertBoundaryCalls(h, completions = 0, prices = 0) {
  assert.equal(h.seen.completions.length, completions, 'completion transport calls');
  assert.equal(h.seen.prices, prices, 'calls to the pricing double');
}

for (const [label, setup, status, code] of [
  ['Local Only', h => h.prefs({ localOnly: true }), 403, 'graph_local_only'],
  ['malformed stored flag', h => h.prefs({ localOnly: 'true' }), 503, 'graph_policy_unavailable'],
  ['malformed stored row', h => h.prefs(['wrong']), 503, 'graph_policy_unavailable'],
  ['preference read failure', h => h.failPrefs(), 503, 'graph_policy_unavailable'],
  ['changed account', h => h.setVerified(another), 401, 'graph_session_changed'],
  ['revoked account', h => h.setVerified(null), 401, 'graph_session_changed'],
]) {
  test(`Run refuses ${label} before mutation, catalog or a completion`, async t => {
    const h = await harness(t), id = await save(h), before = h.state();
    setup(h);
    const r = await h.request(start(id), 'POST');
    assert.equal(r.status, status);
    assert.equal(r.json.code, code);
    assert.equal(h.state(), before);
    assert.equal(h.seen.runWrites, 0);
    assert.equal(h.seen.catalog, 0);
    assert.equal(h.seen.pins, 0);
    assert.ok(h.seen.auth.includes(true), 'authoritative owner check');
    if (status !== 401) assert.ok(h.seen.prefReads.length > 0);
    assert.ok(h.seen.prefReads.every(id => id === owner), 'only the original owner settings');
    assertBoundaryCalls(h);
  });

  test(`Approve refuses ${label} without mutating the existing gate`, async t => {
    const h = await harness(t), id = await pauseAtGate(h), before = h.state();
    const { runWrites, catalog, pins } = h.seen;
    setup(h);
    const r = await h.request(approve(id), 'POST');
    assert.equal(r.status, status);
    assert.equal(r.json.code, code);
    assert.equal(h.state(), before);
    assert.equal(h.seen.runWrites, runWrites);
    assert.equal(h.seen.catalog, catalog);
    assert.equal(h.seen.pins, pins);
    assertBoundaryCalls(h, 1, 1);
  });
}

for (const prefs of [{ localOnly: false }, undefined]) {
  test('normal gate and approval with ' + (prefs ? 'Local Only false' : 'no preference row'), async t => {
    const h = await harness(t);
    h.prefs(prefs);
    const r = await h.request(approve(await pauseAtGate(h)), 'POST');
    assert.equal(r.status, 200);
    assert.equal(r.json.run.status, 'done');
    assert.deepEqual(r.json.run.results.map(({ node_key, status }) => [node_key, status]), [
      ['a-sort', 'done'], ['b-gate', 'done'], ['c-label', 'done'],
    ]);
    assertBoundaryCalls(h, 2, 2);
  });
}

test('Local Only still permits graph list, read, save and ordinary run reads', async t => {
  const h = await harness(t), run = await pauseAtGate(h);
  h.prefs({ localOnly: true });
  const reads = h.seen.prefReads.length;
  const graphId = await save(h);
  assert.equal((await h.request('/api/buzzy/graphs?limit=10')).status, 200);
  assert.equal((await h.request(graphPath(graphId))).status, 200);
  assert.equal((await h.request(runs(run))).json.run.status, 'awaiting_approval');
  assert.equal(h.seen.prefReads.length, reads);
  assertBoundaryCalls(h, 1, 1);
});

test('Local Only switched during model resolution prevents the first completion', async t => {
  const h = await harness(t), id = await save(h);
  h.onPin(() => h.prefs({ localOnly: true }));
  const r = await h.request(start(id), 'POST');
  assert.equal(r.json.run.status, 'failed');
  assert.match(r.json.run.error, /Local Only/);
  assert.equal(r.json.run.results.length, 0);
  assertBoundaryCalls(h);
});

test('client rechecks Local Only before its second HTTP attempt', async t => {
  const h = await harness(t), id = await save(h);
  h.replies.push(() => { h.prefs({ localOnly: true }); throw Error('Transient synthetic transport failure'); });
  const r = await h.request(start(id), 'POST');
  assert.equal(r.json.run.status, 'failed');
  assert.equal(r.json.run.results.length, 0);
  assertBoundaryCalls(h, 1, 0);
});

test('runner rechecks Local Only before a node retry after a non-retryable client result', async t => {
  const h = await harness(t), id = await save(h);
  h.replies.push(() => {
    h.prefs({ localOnly: true });
    return Response.json({ error: 'Synthetic forbidden response' }, { status: 403 });
  });
  const r = await h.request(start(id), 'POST');
  assert.equal(r.json.run.status, 'failed');
  assert.deepEqual(r.json.run.results.map(r => r.status), ['failed']);
  assertBoundaryCalls(h, 1, 0);
});

test('session revocation inside a transport failure prevents retry and readback', async t => {
  const h = await harness(t), id = await save(h);
  h.replies.push(() => { h.setVerified(null); throw Error('Retryable synthetic transport failure'); });
  const r = await h.request(start(id), 'POST');
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'graph_session_changed');
  assert.equal(r.json.run, undefined);
  assertBoundaryCalls(h, 1, 0);
});

test('Local Only change during an admitted completion skips pricing but preserves its accepted result', async t => {
  const h = await harness(t), id = await save(h);
  h.replies.push(() => { h.prefs({ localOnly: true }); return completion(); });
  const r = await h.request(start(id), 'POST');
  assert.equal(r.json.run.status, 'failed');
  assert.deepEqual(r.json.run.results.map(n => [n.node_key, n.output?.text, n.output?.priced]), [
    ['a-sort', 'Fig, plum', false],
  ]);
  assertBoundaryCalls(h, 1, 0);
});

test('non-graph buffered calls retain retry and explicit endpoint-locality behavior without opting in', async t => {
  const h = await harness(t), messages = [{ role: 'user', content: 'Sort the sample list' }];
  h.replies.push(() => { throw Error('Retryable synthetic transport failure'); });
  assert.equal((await h.api.chatCompletionFull(messages, { model })).content, 'Fig, plum');
  assert.deepEqual(h.seen.completions.map(body => body.temperature), [0.7, 0.7 + 0.2]);
  assert.equal(h.seen.auth.length, 0);
  assert.equal(h.seen.prefReads.length, 0);
  await assert.rejects(h.api.chatCompletionFull(messages, { model, localOnly: true }), /requires a loopback/);
  assertBoundaryCalls(h, 2, 0);
});

for (const usage of ['omitted', 'null']) {
  test(`Approve keeps no completion text or readback after loss of owner (usage ${usage})`, async t => {
    const h = await harness(t), run = await pauseAtGate(h), reads = h.seen.readback;
    h.replies.push(() => { h.setVerified(null); return completion('Unadmitted label', usage); });
    const r = await h.request(approve(run), 'POST');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'graph_session_changed');
    assert.equal(r.json.run, undefined);
    assert.equal(h.seen.readback, reads);
    assert.doesNotMatch(h.state(), /Unadmitted label/);
    assertBoundaryCalls(h, 2, 1);
  });

  test(`admitted producer cannot create the next gate after Local Only changes (usage ${usage})`, async t => {
    const h = await harness(t), id = await save(h);
    h.replies.push(() => { h.prefs({ localOnly: true }); return completion('Completed fruit list', usage); });
    const r = await h.request(start(id), 'POST');
    assert.equal(r.json.run.status, 'failed');
    assert.deepEqual(r.json.run.results.map(n => [n.node_key, n.output?.text]), [['a-sort', 'Completed fruit list']]);
    assertBoundaryCalls(h, 1, 0);
  });
}

test('account switch while pricing awaits stops the next transition and readback', async t => {
  const h = await harness(t), id = await save(h);
  h.duringPrice(async () => {
    await Promise.resolve();
    h.setVerified(another);
  });
  const r = await h.request(start(id), 'POST');
  assert.equal(r.status, 401);
  assert.equal(r.json.run, undefined);
  assert.equal(h.seen.readback, 0);
  assert.doesNotMatch(h.state(), /Fig, plum|awaiting_approval/);
  assertBoundaryCalls(h, 1, 1);
});

for (const single of [false, true]) {
  test('after a node write, rechecks Local Only before ' + (single ? 'marking done' : 'recording the next gate'), async t => {
    const h = await harness(t);
    const id = await save(h, single ? { ...graph, nodes: graph.nodes.slice(0, 1), edges: [] } : graph);
    h.afterSql(sql => {
      if (sql.includes('INSERT INTO buzzy_graph_node_results') && sql.includes("'done'")) h.prefs({ localOnly: true });
    });
    const r = await h.request(start(id), 'POST');
    assert.equal(r.json.run.status, 'failed');
    assert.match(r.json.run.error, /Local Only/);
    assert.deepEqual(r.json.run.results.map(n => n.node_key), ['a-sort']);
    assertBoundaryCalls(h, 1, 1);
  });
}

for (const isApprove of [false, true]) {
  for (const whileReading of [false, true]) {
    test(`${isApprove ? 'Approve' : 'Run'} refuses exposure on revocation ${whileReading ? 'while' : 'before'} reading the snapshot`, async t => {
      const h = await harness(t);
      const path = isApprove ? approve(await pauseAtGate(h)) : start(await save(h));
      const reads = h.seen.readback;
      h.afterSql(sql => {
        const lost = whileReading
          ? sql.startsWith('SELECT node_key, attempt, status, provider')
          : sql.startsWith(`UPDATE buzzy_graph_runs SET status = '${isApprove ? 'done' : 'awaiting_approval'}'`);
        if (lost) h.setVerified(null);
      });
      const r = await h.request(path, 'POST');
      assert.equal(r.status, 401);
      assert.equal(r.json.code, 'graph_session_changed');
      assert.equal(r.json.run, undefined);
      assert.equal(h.seen.readback, reads + (whileReading ? 2 : 0));
      assertBoundaryCalls(h, isApprove ? 2 : 1, isApprove ? 2 : 1);
    });
  }
}
