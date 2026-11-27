import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import {
  anonIpHash, checkScreenshot, FEEDBACK_BODY_MAX, FEEDBACK_DIAG_MAX_BYTES,
  LIMITS, pathOnly, sanitizeDiag,
} from "../src/lib/buzzy/feedback.ts";

// Run the actual POST branch, sanitizer and SQL against a disposable in-memory
// database with the real feedback migrations. No HTTP, user or operator data.
const source = readFileSync(new URL("../src/lib/buzzy/chat.nitro.ts", import.meta.url), "utf8");
const start = '  if (method === "POST" && path === "/api/buzzy/feedback") {';
const end = "  // ── CR-6 — POST /api/buzzy/feedback/transcribe";
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const handler = stripTypeScriptTypes("(async () => {\n" + source.slice(source.indexOf(start), source.indexOf(end)) + "\n})()");
const pepper = "synthetic-feedback-test-pepper";
const build = "synthetic-fixture-build";
const ua = "SyntheticBrowser/17.1 (synthetic platform)";
const screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hKwAAAAASUVORK5CYII=";

async function fixture(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const name of ["0059_buzzy_feedback.sql", "0062_buzzy_feedback_screenshot.sql"]) {
    await pg.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  const sql = async (parts, ...values) => {
    const query = parts.map((part, i) => (i ? "$" + i : "") + part).join("");
    return (await pg.query(query, values)).rows;
  };
  const { rows: [legacy] } = await pg.query(
    "INSERT INTO buzzy_feedback (id, ref, body, ua) VALUES ($1, $2, $3, $4) RETURNING *",
    ["fixture-legacy", "BZ-FB-LGACY2", "Legacy synthetic report", "LegacySyntheticBrowser"],
  );
  let next = 0;
  async function write({ userId = null, requestUA = ua, diag } = {}) {
    const id = "fixture-report-" + (++next);
    const ref = "BZ-FB-REPRT" + (next + 1);
    let status = 200;
    const responseHeaders = new Headers();
    const requestHeaders = new Headers({ "user-agent": requestUA });
    const raw = {
      body: "Synthetic report text.", route: "talk", page_url: "/buzzy/talk?fixture=1#not-stored",
      screenshot, user_id: "ignored-client-id", name: "ignored-client-name",
      app_sha: "ignored-client-build", user_agent: "ignored-client-UA",
    };
    if (diag !== undefined) raw.diag = diag;
    const receipt = await vm.runInNewContext(handler, {
      method: "POST", path: "/api/buzzy/feedback", Buffer,
      feedbackPepper: () => pepper, headersFromEvent: () => requestHeaders,
      getSessionUserFromHeaders: async () => userId ? { id: userId } : null,
      clientIp: () => null, anonIpHash,
      event: { req: { json: async () => raw } },
      setResponseStatus: (_event, code) => { status = code; },
      setResponseHeader: (_event, name, value) => responseHeaders.set(name, value),
      FEEDBACK_BODY_MAX, FEEDBACK_DIAG_MAX_BYTES, LIMITS, pathOnly, sanitizeDiag, checkScreenshot,
      getHeader: (_event, key) => requestHeaders.get(key), appSha: () => build,
      makeRef: () => ref, newFeedbackId: () => id, getSql: async () => sql,
    });
    const { rows: [row] } = await pg.query("SELECT * FROM buzzy_feedback WHERE id=$1", [id]);
    if (status === 201) {
      assert.ok(row, "the claimed receipt must identify an actual inserted row");
      assert.equal(receipt.ok, true);
      assert.equal(receipt.ref, row.ref);
      assert.match(receipt.ref, /^BZ-FB-[A-HJ-NP-Z2-9]{6}$/);
      assert.equal(receipt.received_at, new Date(row.created_at).toISOString());
    }
    return { status, ref, receipt, row, responseHeaders };
  }
  return { pg, write, legacy };
}

for (const userId of [null, "synthetic-session-id"]) {
  test("diagnostics OFF persists no raw UA for " + (userId ? "a signed-in reporter" : "an anonymous reporter"), async t => {
    const { pg, write, legacy } = await fixture(t);
    const { status, row } = await write({ userId });
    assert.equal(status, 201);
    assert.equal(row.body, "Synthetic report text.");
    assert.equal(row.screenshot, screenshot);
    assert.equal(row.page_url, "/buzzy/talk");
    assert.equal(row.route, "talk");
    assert.equal(row.app_sha, build);
    assert.equal(row.user_id, userId);
    assert.equal(row.ip_hash, anonIpHash(null, pepper));
    assert.equal(row.diag, null);
    assert.equal(row.diag_redactions, 0);
    assert.equal(row.ua, null);
    assert.doesNotMatch(JSON.stringify(row), /ignored-client-/);
    assert.deepEqual((await pg.query("SELECT * FROM buzzy_feedback WHERE id=$1", [legacy.id])).rows[0], legacy);
  });
}

test("opt-in stores the sanitized diagnostic browser field, never a parallel raw header", async t => {
  const { write } = await fixture(t);
  const { status, row } = await write({
    userId: "synthetic-session-id",
    diag: {
      browser: { user_agent: "Consented fixture " + "Z".repeat(45), language: "en" },
      account: { signed_in: true, user_id: "ignored-client-id", name: "ignored-client-name" },
      extra: "ignored-client-extra",
    },
  });
  assert.equal(status, 201);
  assert.equal(row.diag.browser.user_agent, "Consented fixture [redacted]");
  assert.equal(row.diag.browser.language, "en");
  assert.equal(row.diag.account.user_id, "synthetic-session-id");
  assert.equal(row.diag.page.app_sha, build);
  assert.equal(row.diag_redactions, 1);
  assert.equal(row.ua, null);
  assert.doesNotMatch(JSON.stringify(row), /ignored-client-/);
});

test("anonymous rate limiting still keys on the hashed address, not the raw UA", async t => {
  const { pg, write } = await fixture(t);
  const hashed = anonIpHash(null, pepper);
  for (let n = 0; n < LIMITS.anonHour; n++) {
    await pg.query("INSERT INTO buzzy_feedback (id, ref, body, ip_hash) VALUES ($1,$2,$3,$4)", [
      "prior-fixture-" + n, "prior-ref-" + n, "Synthetic earlier feedback.", hashed,
    ]);
  }
  const { status, row, receipt, responseHeaders } = await write({ requestUA: "DifferentFixtureBrowser" });
  assert.equal(status, 429);
  assert.equal(receipt.code, "rate_limited");
  assert.ok(Number(responseHeaders.get("retry-after")) > 0);
  assert.equal(row, undefined, "refused writes do not persist a new report");
});
