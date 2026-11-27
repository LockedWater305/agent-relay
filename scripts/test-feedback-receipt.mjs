import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Test only the exact write branch, with all IO replaced by synthetic state.
const sourcePath = new URL('../src/lib/buzzy/chat.nitro.ts', import.meta.url);
const filename = process.argv[2] ?? fileURLToPath(sourcePath);
const full = readFileSync(filename, 'utf8');
const start = '  if (method === "POST" && path === "/api/buzzy/feedback") {';
const stop = '  // ── CR-6 — POST /api/buzzy/feedback/transcribe';
assert.equal(full.split(start).length, 2);
assert.equal(full.split(stop).length, 2);
const branch = full.slice(full.indexOf(start), full.indexOf(stop));
const asyncHandler = stripTypeScriptTypes('(async () => {\n' + branch + '\n})()');

async function run(modes) {
  let status = 200, attempts = 0, stored = [];
  const result = await vm.runInNewContext(asyncHandler, {
    method: 'POST', path: '/api/buzzy/feedback', Buffer,
    feedbackPepper: () => 'pure-synthetic-test-pepper',
    headersFromEvent: () => ({}), getSessionUserFromHeaders: async () => null,
    clientIp: () => null, anonIpHash: () => 'synthetic-anon',
    event: { req: {json: async () => ({ body: 'abc' }) } },
    setResponseStatus: (_, n) => { status = n; }, setResponseHeader: () => {},
    FEEDBACK_BODY_MAX: 5000, FEEDBACK_DIAG_MAX_BYTES: 256 * 1024,
    sanitizeDiag: () => ({ diag: null, redactions: 0 }),
    checkScreenshot: () => ({ ok: true, value: null }), LIMITS: { anonHour: 5, anonDay: 10 },
    pathOnly: () => null, getHeader: () => null, appSha: () => null,
    makeRef: () => 'BZ-FB-SYNTH' + (attempts + 1), newFeedbackId: () => 'fake-id' + (attempts + 1),
    getSql: async () => async (s, ...v) => {
      const sql = s.join('?');
      if (sql.includes('SELECT count')) return [{ n: 0, oldest: null }];
      assert.match(sql, /INSERT INTO buzzy_feedback\s/);
      attempts++;
      const outcome = modes[attempts - 1] ?? 'collision';
      if (outcome === 'collision') {
        if (/ON CONFLICT \(ref\) DO NOTHING/i.test(sql)) return [];
        throw Object.assign(new Error('duplicate key violates unique constraint "buzzy_feedback_ref_key"'), {
          code: '23505', constraint: 'buzzy_feedback_ref_key',
        });
      }
      if (outcome === 'db-unavailable') throw new Error('fake DB outage');
      if (outcome === 'empty') return [];
      const row = { ref: v[1], created_at: '2026-11-27T00:00:00.000Z' };
      stored.push(row.ref);
      return [row];
    },
  }, { filename, timeout: 1000 });
  return { status, attempts, stored, result: JSON.parse(JSON.stringify(result)) };
}

test('ordinary success reports only the receipt returned by INSERT', async () => {
  const r = await run(['saved']);
  assert.deepEqual(r, {
    status: 201, attempts: 1, stored: ['BZ-FB-SYNTH1'],
    result: { ok: true, ref: 'BZ-FB-SYNTH1', received_at: '2026-11-27T00:00:00.000Z' },
  });
});

test('a reference collision retries and returns the actual saved receipt', async () => {
  const r = await run(['collision', 'saved']);
  assert.equal(r.status, 201);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.stored, ['BZ-FB-SYNTH2']);
  assert.equal(r.result.ref, 'BZ-FB-SYNTH2');
});

test('five collisions do not acknowledge a non-existent report', async () => {
  const r = await run(['collision', 'collision', 'collision', 'collision', 'collision']);
  assert.equal(r.status, 503);
  assert.equal(r.attempts, 5);
  assert.deepEqual(r.stored, []);
  assert.equal(r.result.ok, false);
  assert.equal('ref' in r.result, false);
});

test('an empty INSERT receipt must not acknowledge a non-existent report', async () => {
  const r = await run(['empty', 'empty', 'empty', 'empty', 'empty']);
  assert.equal(r.status, 503);
  assert.deepEqual(r.stored, []);
  assert.equal(r.result.ok, false);
  assert.equal('ref' in r.result, false);
});

test('an unrelated database failure is not swallowed or reported as saved', async () => {
  await assert.rejects(run(['db-unavailable']), /fake DB outage/);
});
