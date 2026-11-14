// Actual canvas authoring handlers -> full Nitro handler -> graph module SQL.
// Synthetic DOM/owner/transport and in-memory SQLite, not browser or PGlite E2E.
// Rendering is stubbed; no workflow Run, model/provider, credential or file IO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.env.BZ_GRAPH_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const read = path => readFileSync(resolve(root, path), 'utf8');
const html = read('public/buzzy/graph.html');
const routeSource = stripTypeScriptTypes(read('src/lib/buzzy/chat.nitro.ts'));
const graphSource = stripTypeScriptTypes(read('src/lib/buzzy/graphs.ts'));
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const start = html.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, name);
  const lineEnd = html.indexOf('\n', start);
  if (html.slice(start, lineEnd).trimEnd().endsWith('}')) return html.slice(start, lineEnd);
  const end = html.indexOf('\n    }', start);
  assert.ok(end > start, name + ' closing brace');
  return html.slice(start, end + 6);
}
function section(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return html.slice(start, end);
}
const addHandlers = section('    document.querySelectorAll("[data-add]")', '    // ── drag');
const linkHandlers = section('    var linkMode = false;', '    // ── inspector');
const saveNewHandlers = section('    document.getElementById("save").addEventListener', '    // ── run');
const deleteStart = html.indexOf('      document.getElementById("del").addEventListener');
const deleteEnd = html.indexOf('\n      });', deleteStart) + '\n      });'.length;
assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);

async function harness(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.function('now', () => '2026-01-02T00:00:00.000Z');
  db.exec(`
    CREATE TABLE buzzy_graphs (
      id TEXT PRIMARY KEY, user_id TEXT, title TEXT, description TEXT, spec TEXT,
      version INTEGER DEFAULT 1, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01'
    );
    CREATE TABLE buzzy_graph_nodes (
      id TEXT PRIMARY KEY, graph_id TEXT, node_key TEXT, kind TEXT, title TEXT,
      config TEXT, pos_x REAL, pos_y REAL, UNIQUE(graph_id, node_key)
    );
    CREATE TABLE buzzy_graph_edges (
      id INTEGER PRIMARY KEY, graph_id TEXT, from_key TEXT, to_key TEXT, kind TEXT,
      UNIQUE(graph_id, from_key, to_key, kind)
    );
  `);
  const queries = [];
  const sql = async (strings, ...values) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += '?' + strings[i + 1];
    queries.push({ text, values });
    // PostgreSQL casts are the only SQL spelling adaptation. JSON columns are
    // decoded as the production driver does; no graph behavior is reimplemented.
    return db.prepare(text.replace(/::(?:jsonb|int)/g, '')).all(...values).map(row => ({
      ...row, ...(typeof row.config === 'string' ? { config: JSON.parse(row.config) } : {}),
    }));
  };
  let user = 'synthetic_owner';
  let forbiddenCalls = 0;
  const context = vm.createContext({ URL, URLSearchParams, Headers, Request, Response, Buffer });
  const dbModule = new vm.SyntheticModule(['getSql'], function () {
    this.setExport('getSql', async () => sql);
  }, { context });
  const graphModule = new vm.SourceTextModule(graphSource, { context });
  await graphModule.link(specifier => {
    assert.equal(specifier, '@/lib/db');
    return dbModule;
  });
  await graphModule.evaluate();
  const deps = {
    h3: {
      defineEventHandler: fn => fn, getMethod: event => event.req.method,
      setResponseHeader() {}, setResponseStatus: (event, status) => { event.status = status; },
      getHeader: (event, key) => event.req.headers.get(key),
    },
    '@/lib/auth/verify.server': { getSessionUserFromHeaders: async () => user ? { id: user } : null },
    '@/lib/db': { getSql: async () => sql },
  };
  const route = new vm.SourceTextModule(routeSource, { context });
  await route.link(specifier => {
    if (specifier === './graphs') return graphModule;
    const match = [...routeSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)]
      .find(m => m[2] === specifier);
    assert.ok(match, specifier);
    const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, deps[specifier]?.[name] ?? (() => {
        forbiddenCalls++;
        throw Error('Unexpected dependency ' + specifier + '.' + name);
      }));
    }, { context });
  });
  await route.evaluate();

  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', className: '', innerHTML: '', events: {},
      classList: { toggle() {}, remove() {} },
      addEventListener(kind, fn) { this.events[kind] = fn; },
      fire(kind, event = {}) { this.events[kind]?.call(this, { preventDefault() {}, ...event }); },
      getAttribute: name => name === 'data-add' ? 'gate' : null,
    });
    return elements.get(id);
  }
  const requests = [], tasks = [];
  async function request(url, init = {}) {
    assert.match(url, /^\/api\/buzzy\/graphs(?:\/[A-Za-z0-9_-]+)?(?:\?[^#]*)?$/,
      'the fixture never runs a graph or calls a provider');
    const event = {
      path: url, status: 200,
      req: new Request('http://synthetic.local' + url, {
        method: init.method || 'GET', headers: init.headers, body: init.body,
      }),
    };
    const data = plain(await route.namespace.default(event));
    const result = { url, method: init.method || 'GET', status: event.status, data };
    requests.push(result);
    return result;
  }
  const ui = vm.createContext({
    state: { graphId: null, nodes: [], edges: [], sel: null, linkFrom: null, seq: 0 },
    document: { getElementById: element, querySelectorAll: selector => {
      assert.equal(selector, '[data-add]');
      return [element('add-gate')];
    } },
    canvas: element('canvas'), statusEl: element('status'),
    draw() {}, inspect() {}, loadList() {},
    fetch(url, init) {
      const task = request(url, init).then(({ data, status }) => Response.json(data, { status }));
      tasks.push(task);
      return task;
    },
  });
  vm.runInContext(['say', 'rid', 'byId', 'defaultConfig', 'addNode', 'open'].map(functionSource).join('\n')
    + '\n' + addHandlers + linkHandlers + saveNewHandlers, ui);
  async function flush() {
    for (let pass = 0; pass < 5; pass++) {
      await Promise.all(tasks);
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
  }
  t.after(() => assert.equal(forbiddenCalls, 0, 'no unrelated model/private dependency used'));
  return {
    db, ui, requests, queries, as: id => { user = id; },
    status: () => element('status').textContent,
    nodes: () => plain(ui.state.nodes), edges: () => plain(ui.state.edges),
    add() { element('add-gate').fire('click'); return ui.state.sel; },
    newGraph() { element('new').fire('click'); },
    link(from, to) {
      element('linkBtn').fire('click');
      for (const key of [from, to]) element('canvas').fire('click', {
        target: { closest: () => ({ getAttribute: () => key }) },
      });
    },
    delete(key) {
      ui.n = ui.state.nodes.find(node => node.key === key);
      assert.ok(ui.n, key);
      vm.runInContext(html.slice(deleteStart, deleteEnd), ui);
      element('del').fire('click');
    },
    async open(id) { ui.open(id); await flush(); },
    async save(title = 'Synthetic saved workflow') {
      element('title').value = title;
      element('save').fire('click');
      await flush();
      return requests.filter(r => r.method === 'POST').at(-1);
    },
    post: body => request('/api/buzzy/graphs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    request,
    snapshot: () => JSON.stringify(['buzzy_graphs', 'buzzy_graph_nodes', 'buzzy_graph_edges']
      .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])),
  };
}

async function initialGraph(h, keys) {
  const graph = {
    title: 'Synthetic imported workflow',
    nodes: keys.map((key, i) => ({
      key, kind: 'gate', title: 'Existing ' + i,
      config: { approval: true, fixture: { value: 'preserve-' + i } }, x: 50 + i * 20, y: 60 + i * 10,
    })),
    edges: keys.slice(1).map((key, i) => ({ from: keys[i], to: key, kind: 'gate' })),
  };
  const saved = await h.post(graph);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, 1);
  await h.open(saved.data.id);
  return saved.data.id;
}

for (const [deleted, expected] of [[null, 'n4'], ['n2', 'n4'], ['n3', 'n3']]) {
  test(`actual add/delete/save/reopen/add/link/save/reload: deleted ${deleted || 'none'}`, async t => {
    const h = await harness(t);
    assert.deepEqual([h.add(), h.add(), h.add()], ['n1', 'n2', 'n3']);
    h.link('n1', 'n3');
    h.link('n1', 'n2');
    if (deleted) h.delete(deleted);
    const first = await h.save();
    assert.equal(first.status, 200);
    assert.equal(first.data.version, 1);
    await h.open(first.data.id);
    const oldNodes = h.nodes(), oldEdges = h.edges();
    const added = h.add();
    assert.deepEqual(h.nodes().slice(0, oldNodes.length), oldNodes, 'existing IDs/config/positions unchanged');
    assert.deepEqual(h.edges(), oldEdges, 'existing edge identities unchanged');
    h.link(oldNodes[0].key, added);
    const expectedNodes = h.nodes(), expectedEdges = h.edges();
    const second = await h.save();
    assert.equal(second.status, 200);
    assert.equal(added, expected);
    assert.equal(new Set(h.nodes().map(n => n.key)).size, h.nodes().length);
    assert.equal(second.data.version, 2);
    assert.equal(second.data.id, first.data.id);
    assert.equal(h.status(), 'Saved · version 2');
    await h.open(first.data.id);
    assert.deepEqual(h.nodes(), expectedNodes.sort((a, b) => a.key.localeCompare(b.key)));
    assert.deepEqual(h.edges(), expectedEdges);
  });
}

for (const [name, keys, expected] of [
  ['sparse IDs', ['n1', 'n3'], 'n4'],
  ['consecutive collisions', ['n1', 'n4', 'n5'], 'n6'],
  ['reordered IDs', ['n5', 'n1', 'n4'], 'n6'],
  ['custom/case/leading-zero IDs', ['external-alpha', 'n7', 'n06', 'N6', '6'], 'n6'],
  ['large numeric-looking ID', ['n9007199254740992', 'n3'], 'n4'],
  ['count need not equal maximum', ['n1', 'n2', 'n9', 'n10', 'n11'], 'n6'],
]) {
  test(`restored ${name} preserve every key/config/edge and repeated additions stay unique`, async t => {
    const h = await harness(t), id = await initialGraph(h, keys);
    const oldNodes = h.nodes(), oldEdges = h.edges();
    assert.equal(h.add(), expected);
    h.add(); h.add();
    assert.equal(new Set(h.nodes().map(n => n.key)).size, keys.length + 3);
    assert.deepEqual(h.nodes().slice(0, oldNodes.length), oldNodes);
    assert.deepEqual(h.edges(), oldEdges);
    const saved = await h.save();
    assert.equal(saved.status, 200);
    assert.equal(saved.data.version, 2);
    await h.open(id);
    for (const node of oldNodes) assert.deepEqual(h.nodes().find(n => n.key === node.key), node);
    assert.deepEqual(h.edges(), oldEdges);
    assert.equal(new Set(h.nodes().map(n => n.key)).size, keys.length + 3);
  });
}

test('server-normalized external IDs are respected without rewriting them on Add', async t => {
  const h = await harness(t);
  const saved = await h.post({ title: 'Normalized IDs', nodes: [
    { key: ' n3 ', kind: 'gate' }, { key: 41, kind: 'gate' },
  ], edges: [] });
  assert.equal(saved.status, 200);
  await h.open(saved.data.id);
  assert.deepEqual(h.nodes().map(n => n.key), ['41', 'n3']);
  assert.equal(h.add(), 'n4');
  assert.equal((await h.save()).status, 200);
});

test('New resets ordinary numbering without changing the saved sparse graph', async t => {
  const h = await harness(t);
  await initialGraph(h, ['n1', 'n3']);
  const savedBefore = h.snapshot();
  h.newGraph();
  assert.equal(h.add(), 'n1');
  assert.equal(h.ui.state.graphId, null);
  assert.deepEqual(h.edges(), []);
  assert.equal(h.snapshot(), savedBefore);
});

test('deleting without reopening keeps the existing monotonic allocator behavior', async t => {
  const h = await harness(t);
  h.add(); h.add(); h.add(); h.delete('n2');
  assert.equal(h.add(), 'n4');
  assert.equal((await h.save()).status, 200);
});

for (const [name, nodes, edges, code] of [
  ['exact duplicate', [{ key: 'n1', kind: 'gate' }, { key: 'n1', kind: 'gate' }], [], 'duplicate_node'],
  ['normalized duplicate', [{ key: 'n1', kind: 'gate' }, { key: ' n1 ', kind: 'gate' }], [], 'duplicate_node'],
  ['empty key', [{ key: ' ', kind: 'gate' }], [], 'node_key_required'],
  ['dangling edge', [{ key: 'n1', kind: 'gate' }], [{ from: 'n1', to: 'n_missing' }], 'dangling_edge'],
]) {
  test(`existing backend ${name} rejection preserves all stored rows`, async t => {
    const h = await harness(t), id = await initialGraph(h, ['n1', 'n3']);
    const before = h.snapshot(), queryCount = h.queries.length;
    const rejected = await h.post({ id, title: 'Must not replace stored graph', nodes, edges });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.code, code);
    assert.equal(h.queries.length, queryCount, 'validation still precedes SQL');
    assert.equal(h.snapshot(), before);
  });
}

test('existing node limit still rejects a unique 201st node without modifying saved work', async t => {
  const h = await harness(t);
  await initialGraph(h, Array.from({ length: 200 }, (_, i) => 'n' + (i + 1)));
  const before = h.snapshot();
  assert.equal(h.add(), 'n201');
  const rejected = await h.save();
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.code, 'too_many_nodes');
  assert.equal(h.snapshot(), before);
});

test('signed-out authoring and other-owner loading retain existing isolation', async t => {
  const h = await harness(t), id = await initialGraph(h, ['n1', 'n3']);
  const before = h.snapshot(), queryCount = h.queries.length;
  h.as(null);
  assert.equal((await h.post({ title: 'No authority', nodes: [{ key: 'n1', kind: 'gate' }], edges: [] })).status, 401);
  assert.equal((await h.request('/api/buzzy/graphs/' + id)).status, 401);
  assert.equal(h.queries.length, queryCount);
  h.as('other_owner');
  assert.equal((await h.request('/api/buzzy/graphs/' + id)).status, 404);
  assert.equal(h.snapshot(), before);
});
