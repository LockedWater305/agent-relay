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
const initialState = html.match(/^    var state = .*;$/m)?.[0];
assert.ok(initialState, 'actual canvas initial state');

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
const saveNewHandlers = section('    // ── save / load', '    // ── run');
const ownerBindings = section('    var saveButton =', '    function say(');
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
      value: '', textContent: '', className: '', innerHTML: '', events: {}, isConnected: true, disabled: false,
      classList: { toggle() {}, remove() {} },
      addEventListener(kind, fn) { this.events[kind] = fn; },
      fire(kind, event = {}) { this.events[kind]?.call(this, { preventDefault() {}, ...event }); },
      getAttribute: name => name === 'data-add' ? 'gate' : null,
    });
    return elements.get(id);
  }
  const requests = [], tasks = [], openReplies = [], saveReplies = [];
  function holdOpen(stage = 'response', target = 'open') {
    let ready, accept, reject;
    const started = new Promise(resolve => { ready = resolve; });
    const promise = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    const hold = { stage, ready, promise, started,
      release(...args) { accept({ overridden: args.length > 0, data: args[0] }); },
      reject(error = Error('Synthetic Open transport failure')) { reject(error); },
    };
    (target === 'save' ? saveReplies : openReplies).push(hold);
    return hold;
  }
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
    const result = { url, method: init.method || 'GET',
      requestBody: init.body ? JSON.parse(init.body) : null, status: event.status, data };
    requests.push(result);
    return result;
  }
  const ui = vm.createContext({
    document: { getElementById: element, querySelectorAll: selector => {
      assert.equal(selector, '[data-add]');
      return [element('add-gate')];
    } },
    canvas: element('canvas'), statusEl: element('status'),
    draw() {}, inspect() {}, loadList() {},
    fetch(url, init) {
      const hold = url === '/api/buzzy/graphs' && init?.method === 'POST' ? saveReplies.shift()
        : /^\/api\/buzzy\/graphs\/[A-Za-z0-9_-]+$/.test(url) && !init?.method ? openReplies.shift() : null;
      const task = request(url, init).then(({ data, status }) => {
        if (!hold) return Response.json(data, { status });
        if (hold.stage === 'json') return { status, json() {
          hold.ready();
          return hold.promise.then(reply => reply.overridden ? reply.data : data);
        } };
        hold.ready();
        return hold.promise.then(reply => Response.json(reply.overridden ? reply.data : data, { status }));
      });
      tasks.push(task);
      return task;
    },
  });
  vm.runInContext(initialState + '\n' + ownerBindings + '\n' + ['say', 'rid', 'byId', 'defaultConfig', 'addNode', 'open'].map(functionSource).join('\n')
    + '\n' + addHandlers + linkHandlers + saveNewHandlers, ui);
  async function settle() { for (let i = 0; i < 200; i++) await Promise.resolve(); }
  async function flush() {
    for (let pass = 0; pass < 5; pass++) {
      await Promise.allSettled(tasks);
      await settle();
    }
  }
  t.after(() => assert.equal(forbiddenCalls, 0, 'no unrelated model/private dependency used'));
  return {
    db, ui, requests, queries, holdOpen, holdSave: stage => holdOpen(stage, 'save'), settle, flush, as: id => { user = id; },
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
    startOpen(id) { ui.open(id); },
    async save(title = 'Synthetic saved workflow') {
      element('title').value = title;
      element('save').fire('click');
      await flush();
      return requests.filter(r => r.method === 'POST').at(-1);
    },
    startSave(title = 'Synthetic saved workflow') {
      element('title').value = title;
      element('save').fire('click');
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

async function describedGraph(h, description, title = 'Described workflow') {
  const body = { title, description,
    nodes: [
      { key: 'n1', kind: 'gate', title: 'Keep first', config: { approval: true, note: 'unchanged' }, x: 40, y: 50 },
      { key: 'n3', kind: 'gate', title: 'Keep last', config: { approval: true }, x: 240, y: 50 },
    ], edges: [{ from: 'n1', to: 'n3', kind: 'gate' }],
  };
  const saved = await h.post(body);
  assert.equal(saved.status, 200);
  return { ...body, id: saved.data.id };
}
function storedDescription(h, id) {
  const row = h.db.prepare('SELECT description, spec, version FROM buzzy_graphs WHERE id=?').get(id);
  return { description: row.description, specDescription: JSON.parse(row.spec).description, version: row.version };
}
function assertDescription(h, id, description, version) {
  assert.deepEqual(storedDescription(h, id), { description, specDescription: description, version });
}

for (const [name, description, add] of [
  ['no-edit', 'Preserve newline\nquotes " & non-ASCII 🐝 日本語', false],
  ['add/link', 'Existing workflow instructions', true],
  ['2000-unit boundary', 'é'.repeat(1998) + '🐝', false],
]) {
  test(`description survives ${name} Save, reload and unrelated graph isolation`, async t => {
    const h = await harness(t);
    const other = await describedGraph(h, 'Unrelated description', 'Other workflow');
    const graph = await describedGraph(h, description);
    const otherBefore = h.db.prepare('SELECT * FROM buzzy_graphs WHERE id=?').get(other.id);
    await h.open(graph.id);
    const nodesBefore = h.nodes(), edgesBefore = h.edges();
    if (add) h.link('n3', h.add());
    const saved = await h.save(graph.title);
    assert.equal(saved.status, 200);
    assertDescription(h, graph.id, description, 2);
    assert.equal(saved.requestBody.description, description);
    await h.open(graph.id);
    assert.equal(h.ui.state.description, description);
    for (const node of nodesBefore) assert.deepEqual(h.nodes().find(n => n.key === node.key), node);
    assert.deepEqual(h.edges().slice(0, edgesBefore.length), edgesBefore);
    assert.deepEqual(h.db.prepare('SELECT * FROM buzzy_graphs WHERE id=?').get(other.id), otherBefore);
    assert.equal((await h.request('/api/buzzy/graphs/' + graph.id)).data.graph.description, description);
  });
}

test('description API control: explicit clearing and omitted replacement retain existing semantics', async t => {
  const h = await harness(t);
  for (const mode of ['empty', 'null', 'omitted']) {
    const graph = await describedGraph(h, 'Must be explicitly replaceable');
    const body = { ...graph, description: mode === 'empty' ? '' : null };
    if (mode === 'omitted') delete body.description;
    const saved = await h.post(body);
    assert.equal(saved.status, 200);
    assertDescription(h, graph.id, null, 2);
  }
});

test('description resets across described, null, empty and New graphs without editing prior work', async t => {
  const h = await harness(t);
  const a = await describedGraph(h, 'Description A', 'A');
  const b = await describedGraph(h, null, 'B');
  const c = await describedGraph(h, null, 'C');
  // Legacy empty-string storage is readable, but the unchanged API normalizes
  // empty description to null on Save. It must never inherit another graph's text.
  h.db.prepare('UPDATE buzzy_graphs SET description=? WHERE id=?').run('', c.id);
  await h.open(a.id); assert.equal(h.ui.state.description, 'Description A');
  await h.open(b.id); assert.equal(h.ui.state.description, null);
  await h.save(b.title); assertDescription(h, b.id, null, 2);
  await h.open(a.id); await h.open(c.id); assert.equal(h.ui.state.description, '');
  await h.save(c.title); assertDescription(h, c.id, null, 2);
  await h.open(a.id);
  h.newGraph();
  assert.equal(h.ui.state.graphId, null);
  assert.equal(h.ui.state.description, null);
  h.add(); const fresh = await h.save('New graph');
  assert.notEqual(fresh.data.id, a.id);
  assertDescription(h, fresh.data.id, null, 1);
  assertDescription(h, a.id, 'Description A', 1);
});

test('description is present as null on the first new canvas save', async t => {
  const h = await harness(t);
  assert.equal(h.ui.state.description, null);
  h.add(); const saved = await h.save();
  assert.equal(saved.requestBody.description, null);
  assertDescription(h, saved.data.id, null, 1);
});

test('failed validation Save preserves current identity/description and retry round-trips it', async t => {
  const h = await harness(t), graph = await describedGraph(h, 'Keep through failed Save');
  await h.open(graph.id);
  const before = h.snapshot();
  h.ui.state.nodes[1].key = 'n1';
  const failed = await h.save();
  assert.equal(failed.status, 400);
  assert.equal(failed.data.code, 'duplicate_node');
  assert.equal(h.snapshot(), before);
  assert.equal(h.ui.state.graphId, graph.id);
  assert.equal(h.ui.state.description, graph.description);
  h.ui.state.nodes[1].key = 'n3';
  const retry = await h.save(graph.title);
  assert.equal(retry.status, 200);
  assertDescription(h, graph.id, graph.description, 2);
});

for (const stage of ['response', 'json']) {
  for (const newer of ['another graph', 'New']) {
    test(`stale Open ${stage} cannot replace description/identity after ${newer}`, async t => {
      const h = await harness(t);
      const a = await describedGraph(h, 'Old delayed description', 'Old');
      const b = await describedGraph(h, 'New current description', 'Current');
      const held = h.holdOpen(stage);
      h.startOpen(a.id); await held.started;
      if (newer === 'New') { h.newGraph(); h.add(); }
      else { h.startOpen(b.id); await h.settle(); }
      const intended = { graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges(), status: h.status() };
      assert.equal(intended.graphId, newer === 'New' ? null : b.id);
      held.release(); await h.flush();
      assert.deepEqual({ graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges(), status: h.status() }, intended);
      const saved = await h.save('Save current only');
      assert.equal(saved.status, 200);
      assertDescription(h, saved.data.id, newer === 'New' ? null : b.description, newer === 'New' ? 1 : 2);
      assertDescription(h, a.id, a.description, 1);
    });
  }
}

for (const stage of ['response', 'json']) {
  test(`current Open ${stage} rejection preserves previously loaded graph and description`, async t => {
    const h = await harness(t), a = await describedGraph(h, 'Keep active'), b = await describedGraph(h, 'Failed target');
    await h.open(a.id);
    const before = { graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges() };
    const held = h.holdOpen(stage);
    h.startOpen(b.id); await held.started; held.reject(); await h.flush();
    assert.deepEqual({ graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges() }, before);
    assert.match(h.status(), /Could not open/);
    await h.save(a.title);
    assertDescription(h, a.id, a.description, 2);
    assertDescription(h, b.id, b.description, 1);
  });
  test(`stale Open ${stage} failure cannot repaint a newer successful selection`, async t => {
    const h = await harness(t), a = await describedGraph(h, 'Delayed'), b = await describedGraph(h, 'Current');
    const held = h.holdOpen(stage);
    h.startOpen(a.id); await held.started;
    h.startOpen(b.id); await h.settle();
    const currentStatus = h.status();
    held.reject(); await h.flush();
    assert.equal(h.ui.state.graphId, b.id);
    assert.equal(h.ui.state.description, b.description);
    assert.equal(h.status(), currentStatus);
  });
}

for (const malformed of ['not-ok', 'wrong-id', 'bad-description', 'bad-nodes', 'bad-edges', 'broken-node']) {
  test(`Open ${malformed} payload commits neither identity nor description`, async t => {
    const h = await harness(t), a = await describedGraph(h, 'Keep A'), b = await describedGraph(h, 'Not B');
    await h.open(a.id);
    const before = { graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges() };
    const held = h.holdOpen('json');
    h.startOpen(b.id); await held.started;
    const payload = (await h.request('/api/buzzy/graphs/' + b.id)).data;
    if (malformed === 'not-ok') { payload.ok = false; payload.error = 'Could not open synthetic target'; }
    if (malformed === 'wrong-id') payload.graph.id = a.id;
    if (malformed === 'bad-description') payload.graph.description = { unexpected: true };
    if (malformed === 'bad-nodes') payload.graph.nodes = null;
    if (malformed === 'bad-edges') payload.graph.edges = null;
    if (malformed === 'broken-node') payload.graph.nodes = [null];
    held.release(payload); await h.flush();
    assert.deepEqual({ graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges() }, before);
    assert.match(h.status(), /Could not open/);
    await h.save(a.title);
    assertDescription(h, a.id, a.description, 2);
    assertDescription(h, b.id, b.description, 1);
  });
}

test('missing description in an incomplete Open response cannot erase known metadata', async t => {
  const h = await harness(t), a = await describedGraph(h, 'Description A'), b = await describedGraph(h, null);
  await h.open(a.id);
  const held = h.holdOpen('json'); h.startOpen(b.id); await held.started;
  const payload = (await h.request('/api/buzzy/graphs/' + b.id)).data;
  delete payload.graph.description;
  held.release(payload); await h.flush();
  assert.equal(h.ui.state.graphId, a.id);
  assert.equal(h.ui.state.description, a.description);
  assert.match(h.status(), /Could not open/);
  await h.save(a.title);
  assertDescription(h, a.id, a.description, 2);
  assertDescription(h, b.id, null, 1);
});

for (const stage of ['response', 'json']) {
  for (const selection of ['another graph', 'New']) {
    test(`older Save ${stage} success cannot pair current description with old ID after ${selection}`, async t => {
      const h = await harness(t), a = await describedGraph(h, 'Old A'), b = await describedGraph(h, 'Current B');
      await h.open(a.id);
      const held = h.holdSave(stage); h.startSave(a.title); await held.started;
      if (selection === 'New') { h.newGraph(); h.add(); }
      else { h.startOpen(b.id); await h.settle(); }
      const intended = { graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges(), status: h.status() };
      held.release(); await h.flush();
      assert.deepEqual({ graphId: h.ui.state.graphId, description: h.ui.state.description, nodes: h.nodes(), edges: h.edges(), status: h.status() }, intended);
      const current = await h.save('Save intended graph');
      assert.equal(current.status, 200);
      assertDescription(h, a.id, a.description, 2);
      assertDescription(h, current.data.id, selection === 'New' ? null : b.description, selection === 'New' ? 1 : 2);
    });
  }
}

test('older Save failure cannot repaint a newer loaded graph', async t => {
  const h = await harness(t), a = await describedGraph(h, 'A'), b = await describedGraph(h, 'B');
  await h.open(a.id);
  const held = h.holdSave('json'); h.startSave(a.title); await held.started;
  h.startOpen(b.id); await h.settle(); const status = h.status();
  held.release({ ok: false, error: 'Old save failed' }); await h.flush();
  assert.equal(h.ui.state.graphId, b.id); assert.equal(h.ui.state.description, b.description);
  assert.equal(h.status(), status);
});

test('failed Open does not retire an accepted Save of the still-current graph', async t => {
  const h = await harness(t);
  h.add();
  const held = h.holdSave('response'); h.startSave('Current new workflow'); await held.started;
  h.startOpen('graph_missing'); await h.settle();
  assert.equal(h.ui.state.graphId, null);
  assert.match(h.status(), /No such graph/);
  held.release(); await h.flush();
  assert.ok(h.ui.state.graphId);
  assert.equal(h.ui.state.description, null);
  assert.equal(h.status(), 'Saved · version 1');
  assertDescription(h, h.ui.state.graphId, null, 1);
});
