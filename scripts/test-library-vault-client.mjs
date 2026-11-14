import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
const source = fs.readFileSync(new URL('../public/buzzy/library-vault.js', import.meta.url), 'utf8');
const STORE = '12345678-1234-4234-8234-123456789abc';
const LEGACY = 'bz_docs_v1', PREFIX = 'bz_docs_v2_pending:';
const record = (md, name = 'same.md') => ({ jobId: 'job', document: { name, md } });
// Same fixed-key canonical recipe as libraryVault.ts. Omitted timestamps stay omitted.
function canonical(r) { const d = { name: r.document.name, md: r.document.md }; for (const k of ['createdAt', 'updatedAt']) if (Object.hasOwn(r.document, k)) d[k] = r.document[k]; return JSON.stringify({ jobId: r.jobId, document: d }); }
const hash = r => createHash('sha256').update(canonical(r)).digest('hex');
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, fail: false, get length() { return data.size; }, key(i) { return [...data.keys()][i] ?? null; }, getItem(k) { return data.get(k) ?? null; }, setItem(k,v) { if (this.fail) throw new Error('QuotaExceededError'); data.set(k, String(v)); }, removeItem(k) { data.delete(k); } };
}
function api() {
  const state = { generation: '0', rows: [], calls: [], hook: null, lostAck: false };
  state.insert = r => { const h = hash(r); let row = state.rows.find(x => x.hash === h); if (!row) { row = { id: String(state.rows.length + 1), hash: h, ...JSON.parse(canonical(r)) }; state.rows.push(row); } return row; };
  state.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith('/api/buzzy/library-vault')); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    const method = init.method || 'GET'; state.calls.push({ url, method });
    if (state.hook) await state.hook(url, init);
    let result;
    if (method === 'POST') {
      const b = JSON.parse(init.body); assert.ok(b.records.length <= 50);
      if (b.expectedStoreId !== STORE || b.expectedGeneration !== state.generation) return { ok: false, json: async () => ({ ok: false, error: 'vault_store_changed' }) };
      const stored = [...new Map(b.records.map(r => [hash(r), state.insert(r)])).values()];
      if (state.lostAck) { state.lostAck = false; throw new Error('lost acknowledgment'); }
      result = { stored, count: stored.length };
    } else if (url.includes('metadata=1')) result = {};
    else { const q = new URL(url, 'http://local').searchParams; const after = BigInt(q.get('after')); const rows = state.rows.filter(r => BigInt(r.id) > after).slice(0, 50); result = { records: rows, nextCursor: rows.at(-1)?.id ?? null, done: !state.rows.some(r => BigInt(r.id) > BigInt(rows.at(-1)?.id ?? after)) }; }
    return { ok: true, json: async () => ({ ok: true, storeId: STORE, generation: state.generation, ...result }) };
  };
  return state;
}
function browser(server, local = storage(), bridge = true) {
  const timers = new Map(); let n = 0;
  const window = bridge ? { beezilla: {} } : {};
  vm.runInNewContext(source, { window, localStorage: local, crypto: webcrypto, TextEncoder, fetch: server.fetch, setTimeout(fn) { timers.set(++n, fn); return n; }, clearTimeout(id) { timers.delete(id); }, console });
  return { vault: window.BeeZillaLibraryVault, local, timers, async ready() { await window.BeeZillaLibraryVault.refresh(); }, rows() { return Object.values(window.BeeZillaLibraryVault.load()).flat(); } };
}
const legacy = rows => JSON.stringify({ job: rows.map(r => r.document) });
const pending = (r, generation = '0') => JSON.stringify({ version: 1, storeId: STORE, generation, record: r });
function deferred() { let release; const promise = new Promise(r => release = r); return { promise, release }; }

test('backend canonical identity fixtures distinguish omissions, timestamps and same-name versions', () => {
  assert.equal(canonical(record('v1')), '{"jobId":"job","document":{"name":"same.md","md":"v1"}}');
  assert.equal(hash(record('v1')), createHash('sha256').update('{"jobId":"job","document":{"name":"same.md","md":"v1"}}').digest('hex'));
  assert.notEqual(hash(record('v1')), hash({ jobId: 'job', document: { ...record('v1').document, createdAt: 0 } }));
});
test('versions survive reload, new port/new VM and exact duplicates remain idempotent', async () => {
  const server = api(), raw = legacy([record('v1'), record('v2'), record('v1')]), local = storage({ [LEGACY]: raw, unrelated: 'never sent' });
  const a = browser(server, local); await a.ready(); assert.equal(a.rows().length, 2); assert.equal(local.getItem(LEGACY), raw);
  const b = browser(server, local); await b.ready(); assert.equal(server.rows.length, 2);
  const newOrigin = browser(server); await newOrigin.ready(); assert.deepEqual(newOrigin.rows().map(r => r.md).sort(), ['v1', 'v2']); assert.equal(newOrigin.local.getItem(LEGACY), null);
});
test('more than 200 versions are batched and all pages restored', async () => {
  const server = api(), a = browser(server, storage({ [LEGACY]: legacy(Array.from({ length: 231 }, (_, i) => record(`version-${i}`))) })); await a.ready();
  assert.equal(server.rows.length, 231); assert.equal(a.rows().length, 231); assert.equal(server.calls.filter(c => c.method === 'POST').length, 5);
  const b = browser(server); await b.ready(); assert.equal(b.rows().length, 231);
});
test('committed POST with lost ack retains copies and retries without duplication', async () => {
  const server = api(); server.lostAck = true; const raw = legacy([record('v1')]), local = storage({ [LEGACY]: raw, [PREFIX + 'one']: pending(record('v2')) });
  const a = browser(server, local); await assert.rejects(a.ready(), /lost acknowledgment/); assert.equal(server.rows.length, 2); assert.equal(local.getItem(LEGACY), raw); assert.ok(local.getItem(PREFIX + 'one'));
  await a.ready(); assert.equal(server.rows.length, 2); assert.equal(local.getItem(PREFIX + 'one'), null); assert.equal(a.rows().length, 2);
});
for (const phase of ['POST', 'GET']) test(`late pending write while awaiting ${phase} stays visible and is persisted next refresh`, async () => {
  const server = api(), a = browser(server); await a.ready(); a.vault.save({ job: [record('first').document] });
  const entered = deferred(), gate = deferred(); let once = false;
  server.hook = async (url, init) => { if (!once && (phase === 'POST' ? init.method === 'POST' : !init.method && url.includes('after='))) { once = true; entered.release(); await gate.promise; } };
  const refreshing = a.vault.refresh(); await entered.promise;
  assert.equal(a.vault.save({ job: [record('late').document] }), true); gate.release(); await refreshing;
  assert.ok(a.rows().some(r => r.md === 'late')); assert.ok([...a.local.data.keys()].some(k => k.startsWith(PREFIX)));
  server.hook = null; await a.vault.refresh(); assert.equal(server.rows.length, 2); assert.ok(![...a.local.data.keys()].some(k => k.startsWith(PREFIX)));
});
test('migration needs no new storage quota after committed exact acknowledgment', async () => {
  const server = api(), raw = legacy([record('old')]), local = storage({ [LEGACY]: raw, [PREFIX + 'one']: pending(record('new')) }); local.fail = true;
  const a = browser(server, local); await a.ready(); assert.equal(local.getItem(LEGACY), raw); assert.equal(local.getItem(PREFIX + 'one'), null); assert.equal(server.rows.length, 2);
  local.fail = false; await a.ready(); assert.equal(server.rows.length, 2);
});
for (const [label, raw] of [['malformed', '{'], ['oversize', legacy([record('x'.repeat(8 * 1024 * 1024))])]]) test(`${label} legacy is retained without POST or silent truncation`, async () => {
  const server = api(), local = storage({ [LEGACY]: raw }), a = browser(server, local); await assert.rejects(a.ready()); assert.equal(local.getItem(LEGACY), raw); assert.equal(server.rows.length, 0); assert.equal(server.calls.filter(c => c.method === 'POST').length, 0);
});
test('quota failure on new save does not claim success or mutate existing history', async () => {
  const server = api(), a = browser(server); await a.ready(); a.local.fail = true;
  assert.equal(a.vault.save({ job: [record('unsaved').document] }), false); assert.equal(a.rows().length, 0); assert.match(a.vault.status().message, /not saved/);
});
test('account generation reset keeps stale outbox/legacy for recovery without resurrection', async () => {
  const server = api(), raw = legacy([record('deleted')]), local = storage({ [LEGACY]: raw, [PREFIX + 'stale']: pending(record('stale')) }); server.generation = '1';
  const a = browser(server, local); await a.ready(); assert.equal(server.rows.length, 0); assert.equal(a.rows().length, 0); assert.ok(local.getItem(PREFIX + 'stale')); assert.equal(local.getItem(LEGACY), raw);
  assert.equal(a.vault.save({ job: [record('new after reset').document] }), true); await a.vault.refresh(); assert.equal(server.rows.length, 1); assert.equal(server.rows[0].document.md, 'new after reset');
});
test('hosted page without native bridge creates no vault and makes no request', () => { const server = api(), a = browser(server, storage(), false); assert.equal(a.vault, undefined); assert.equal(server.calls.length, 0); });
test('partial multi-batch failure retains source and retry deduplicates committed prefix', async () => {
  const server = api(); let posts = 0;
  server.hook = async (_url, init) => { if (init.method === 'POST' && ++posts === 2) throw new Error('second batch disconnected'); };
  const raw = legacy(Array.from({ length: 101 }, (_, i) => record(String(i)))), local = storage({ [LEGACY]: raw }), a = browser(server, local);
  await assert.rejects(a.ready(), /second batch/); assert.equal(server.rows.length, 50); assert.equal(local.getItem(LEGACY), raw);
  server.hook = null; await a.ready(); assert.equal(server.rows.length, 101); assert.equal(a.rows().length, 101);
});
test('generation changes during POST fail closed and stale pending never rebinds', async () => {
  const server = api(), a = browser(server); await a.ready(); a.vault.save({ job: [record('before deletion').document] });
  server.hook = async (_url, init) => { if (init.method === 'POST') { server.generation = '1'; server.rows = []; } };
  await assert.rejects(a.vault.refresh(), /vault_store_changed/); assert.ok([...a.local.data.keys()].some(k => k.startsWith(PREFIX)));
  server.hook = null; await a.vault.refresh(); assert.equal(server.rows.length, 0); assert.equal(a.rows().length, 0);
});
test('generation change during paginated GET rejects mixed history', async () => {
  const server = api(); for (let i = 0; i < 51; i++) server.insert(record(String(i)));
  server.hook = async url => { if (url.includes('after=50')) { server.generation = '1'; server.rows = []; } };
  const a = browser(server); await assert.rejects(a.ready(), /changed while history/); assert.equal(a.vault.status().ready, false);
  server.hook = null; await a.ready(); assert.equal(a.rows().length, 0);
});
test('same-store older database restore replays immutable legacy despite old receipts', async () => {
  const server = api(), local = storage({ [LEGACY]: legacy([record('recoverable')]), bz_docs_v2_receipts: JSON.stringify({ version: 1, stores: { [STORE]: { generation: '0', hashes: [hash(record('recoverable'))] } } }) });
  const a = browser(server, local); await a.ready(); assert.equal(server.rows.length, 1);
  server.rows = []; const b = browser(server, local); await b.ready(); assert.equal(server.rows.length, 1); assert.equal(b.rows()[0].md, 'recoverable');
});
test('delayed initial metadata never displays deleted legacy before generation confirmation', async () => {
  const server = api(), gate = deferred(), entered = deferred(); server.generation = '1';
  server.hook = async url => { if (url.includes('metadata=1')) { entered.release(); await gate.promise; } };
  const raw = legacy([record('deleted private history')]), local = storage({ [LEGACY]: raw }), a = browser(server, local);
  await entered.promise; assert.equal(a.rows().length, 0); assert.equal(a.vault.status().ready, false);
  gate.release(); await a.ready(); assert.equal(a.rows().length, 0); assert.equal(server.rows.length, 0); assert.equal(local.getItem(LEGACY), raw);
});
test('exact record with wrong acknowledgment hash retains pending until verified retry', async () => {
  const server = api(), originalFetch = server.fetch; let corrupt = true;
  server.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (init?.method !== 'POST' || !corrupt) return response;
    const data = await response.json();
    return { ok: true, json: async () => ({ ...data, stored: data.stored.map(row => ({ ...row, hash: '0'.repeat(64) })) }) };
  };
  const local = storage({ [PREFIX + 'verify']: pending(record('verify exact bytes')) }), a = browser(server, local);
  await assert.rejects(a.ready()); assert.ok(local.getItem(PREFIX + 'verify')); assert.equal(server.rows.length, 1);
  corrupt = false; await a.ready(); assert.equal(local.getItem(PREFIX + 'verify'), null); assert.equal(server.rows.length, 1); assert.equal(a.rows()[0].md, 'verify exact bytes');
});
