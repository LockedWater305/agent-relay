import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

// Exact served testers HTML + controller, in a fresh browser with every
// request intercepted. No credentials, real reports or real plan changes.
const html = readFileSync(new URL("../public/buzzy/testers.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(part => part[1])
  .find(text => text.includes("/api/buzzy/admin/feedback"));
assert.ok(script);
const inertMarkup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const reportPath = "/api/buzzy/admin/feedback";
const sample = {
  id: "fixture-id", ref: "BZ-FB-ABCDEF", created_at: "2026-11-27T00:00:00.000Z",
  body: "Synthetic fixture only.", status: "new", has_screenshot: true,
};
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true, chromiumSandbox: true,
  });
});
after(async () => browser?.close());

async function view(t, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route("**/*", route => route.abort());
  await page.setContent(inertMarkup);
  await page.evaluate(options => {
    const listReply = options.list ?? { status: 200, json: { ok: true, feedback: [] } };
    function fake(reply) {
      if (reply.offline) throw new TypeError("Synthetic transport failed");
      return {
        ok: reply.status >= 200 && reply.status < 300, status: reply.status,
        json: async () => {
          if (reply.parseError) throw new SyntaxError("Synthetic non-JSON response");
          return reply.json;
        },
      };
    }
    window.requests = [];
    window.fetch = async (path, request) => {
      window.requests.push({ path, method: request.method || "GET" });
      if (path === "/api/buzzy/entitlement")
        return fake(options.entitlement ?? { status: 200, json: { ok: true } });
      if (path === "/api/buzzy/admin/feedback") {
        if (options.defer) await new Promise(resolve => { window.finishListing = resolve; });
        return fake(listReply);
      }
      if (path === "/api/buzzy/admin/feedback?id=fixture-id" && options.screenshot)
        return fake(options.screenshot);
      if (path === "/api/buzzy/admin/plan" && options.plan) {
        window.syntheticPlan = JSON.parse(request.body);
        await new Promise(resolve => { window.finishSyntheticPlan = resolve; });
        return fake(options.plan);
      }
      throw Error("Unexpected request");
    };
  }, options);
  await page.addScriptTag({ content: script });
  return page;
}
async function settled(page) {
  await page.waitForFunction(() => !document.getElementById("gate").hidden || (() => {
    const status = document.getElementById("feedbackLoadStatus");
    const reports = document.getElementById("reports");
    return status ? status.hidden || /could not read reports/i.test(status.textContent)
      : reports.textContent.trim() !== "Loading…";
  })());
}
async function assertUnavailable(page) {
  assert.equal(await page.locator("#feedbackLoadStatus").count(), 1, "an unavailable message must sit outside hidden admin controls");
  assert.equal(await page.locator("#feedbackLoadStatus").isVisible(), true);
  assert.match(await page.locator("#feedbackLoadStatus").textContent(), /could not read reports/i);
  assert.equal(await page.locator("#gate").isVisible(), false, "backend failure is not a permission denial");
  assert.equal(await page.locator("#body").isVisible(), false, "failed load must never reveal admin actions");
  assert.doesNotMatch(await page.locator("#reports").textContent(), /no reports yet/i);
}
async function assertReads(page, paths) {
  assert.deepEqual(await page.evaluate(() => window.requests), paths.map(path => ({ path, method: "GET" })));
}

test("loading is visible outside the hidden admin body and a valid empty queue is distinct", async t => {
  const page = await view(t, { defer: true });
  await page.waitForFunction(() => typeof window.finishListing === "function");
  assert.equal(await page.locator("#feedbackLoadStatus").count(), 1);
  assert.equal(await page.locator("#feedbackLoadStatus").isVisible(), true);
  assert.match(await page.locator("#feedbackLoadStatus").textContent(), /loading feedback reports/i);
  assert.equal(await page.locator("#body").isVisible(), false);
  await page.evaluate(() => window.finishListing());
  await settled(page);
  assert.equal(await page.locator("#gate").isVisible(), false);
  assert.equal(await page.locator("#reports").isVisible(), true);
  assert.equal((await page.locator("#reports").textContent()).trim(), "No reports yet.");
  await assertReads(page, ["/api/buzzy/entitlement", reportPath]);
});
test("a confirmed empty list has its own visible state", async t => {
  const page = await view(t);
  await settled(page);
  assert.equal(await page.locator("#gate").isVisible(), false);
  assert.equal(await page.locator("#reports").isVisible(), true);
  assert.equal((await page.locator("#reports").textContent()).trim(), "No reports yet.");
  await assertReads(page, ["/api/buzzy/entitlement", reportPath]);
});
test("list 403 displays an admin permission gate, not an empty queue", async t => {
  const page = await view(t, { list: { status: 403, json: { ok: false } } });
  await settled(page);
  assert.equal(await page.locator("#gate").isVisible(), true);
  assert.match(await page.locator("#gate").textContent(), /only BeeZilla admins/i);
  assert.equal(await page.locator("#body").isVisible(), false);
  assert.doesNotMatch(await page.locator("#reports").textContent(), /no reports/i);
});
test("entitlement service failure is unavailable, not a denial or failed list request", async t => {
  const page = await view(t, { entitlement: { status: 503, json: { ok: false } } });
  await settled(page);
  await assertUnavailable(page);
  await assertReads(page, ["/api/buzzy/entitlement"]);
});

for (const [name, list] of [
  ["backend 503", { status: 503, json: { ok: false } }],
  ["transport failure", { offline: true }],
  ["non-JSON backend 502", { status: 502, parseError: true }],
  ["null response", { status: 200, json: null }],
  ["omitted collection", { status: 200, json: { ok: true } }],
  ["non-array collection", { status: 200, json: { ok: true, feedback: { length: 0 } } }],
  ["contradictory 503 and stale success body", { status: 503, json: { ok: true, feedback: [] } }],
]) test("unavailable is visible, without implying an empty queue: " + name, async t => {
  const page = await view(t, { list });
  await settled(page);
  await assertUnavailable(page);
  await assertReads(page, ["/api/buzzy/entitlement", reportPath]);
});

for (const status of [401, 403]) test("screenshot read " + status + " removes previously visible reports and shows the gate", async t => {
  const page = await view(t, { list: { status: 200, json: { ok: true, feedback: [sample] } },
    screenshot: { status, json: { ok: false } } });
  await settled(page);
  assert.equal(await page.locator("#reports").isVisible(), true);
  assert.match(await page.locator("#reports").textContent(), /BZ-FB-ABCDEF/);
  await page.getByRole("button", { name: "See the screenshot" }).click();
  await page.waitForFunction(() => !document.getElementById("gate").hidden ||
    document.querySelector("[data-shot]")?.textContent === "No screenshot on that report");
  assert.equal(await page.locator("#gate").isVisible(), true);
  assert.equal(await page.locator("#body").isVisible(), false);
  assert.equal((await page.locator("#reports").textContent()).trim(), "");
  await assertReads(page, ["/api/buzzy/entitlement", reportPath, reportPath + "?id=fixture-id"]);
});

async function startPlan(t, plan, screenshot) {
  const page = await view(t, {
    list: { status: 200, json: { ok: true, feedback: [sample] } }, plan, screenshot,
  });
  await settled(page);
  assert.equal(await page.locator("#reports").isVisible(), true);
  await page.locator("#email").fill("synthetic-fixture@example.invalid");
  await page.locator("#grant").click();
  await page.waitForFunction(() => typeof window.finishSyntheticPlan === "function");
  assert.deepEqual(await page.evaluate(() => window.syntheticPlan), {
    email: "synthetic-fixture@example.invalid", plan: "pro",
  });
  assert.equal(await page.locator("#grant").isEnabled(), false);
  assert.equal(await page.locator("#reports").isVisible(), true, "access was valid before a denial was observed");
  return page;
}
async function heldPlan(t, plan) {
  const page = await startPlan(t, plan);
  await page.evaluate(() => window.finishSyntheticPlan());
  await page.waitForFunction(() => !document.getElementById("gate").hidden ||
    document.getElementById("grantStatus").textContent !== "Setting…");
  assert.deepEqual(await page.evaluate(() => window.requests), [
    { path: "/api/buzzy/entitlement", method: "GET" },
    { path: "/api/buzzy/admin/feedback", method: "GET" },
    { path: "/api/buzzy/admin/plan", method: "POST" },
  ]);
  return page;
}
for (const status of [401, 403]) test("observed plan denial " + status + " retires stale tester UI and reports",
  async t => {
    const page = await heldPlan(t, { status, json: { ok: false, error: "Synthetic auth denied" } });
    assert.equal(await page.locator("#gate").isVisible(), true);
    assert.equal(await page.locator("#body").isVisible(), false);
    assert.equal(await page.locator(".report").count(), 0);
  });
test("normal plan rejection does not imply the operator has lost report access", async t => {
  const page = await heldPlan(t, { status: 400, json: { ok: false, error: "Synthetic validation failure" } });
  assert.equal(await page.locator("#gate").isVisible(), false);
  assert.equal(await page.locator("#reports").isVisible(), true);
  assert.equal(await page.locator("#grant").isEnabled(), true);
  assert.match(await page.locator("#grantStatus").textContent(), /synthetic validation failure/i);
});
test("successful synthetic grant keeps the inbox visible", async t => {
  const page = await heldPlan(t, { status: 200, json: { ok: true, plan: "pro" } });
  assert.equal(await page.locator("#gate").isVisible(), false);
  assert.equal(await page.locator("#reports").isVisible(), true);
  assert.equal(await page.locator("#grant").isEnabled(), true);
  assert.match(await page.locator("#grantStatus").textContent(), /is on pro/i);
});

test("a late plan success cannot update the panel after a screenshot read revokes access", async t => {
  const page = await startPlan(t, { status: 200, json: { ok: true, plan: "pro" } },
    { status: 403, json: { ok: false } });
  await page.getByRole("button", { name: "See the screenshot" }).click();
  await page.waitForFunction(() => !document.getElementById("gate").hidden);
  await page.evaluate(() => window.finishSyntheticPlan());
  await page.waitForFunction(() => !document.getElementById("grant").disabled);
  assert.equal(await page.locator("#gate").isVisible(), true);
  assert.equal(await page.locator("#body").isVisible(), false);
  assert.equal(await page.locator(".report").count(), 0);
  assert.doesNotMatch(await page.locator("#grantStatus").textContent(), /is on pro/i);
});

test("a late plan success cannot update a detached panel", async t => {
  const page = await startPlan(t, { status: 200, json: { ok: true, plan: "pro" } });
  await page.evaluate(() => {
    window.detachedTester = document.getElementById("body");
    window.detachedTester.remove();
    window.finishSyntheticPlan();
  });
  await page.waitForFunction(() => !window.detachedTester.querySelector("#grant").disabled);
  const status = await page.evaluate(() => window.detachedTester.querySelector("#grantStatus").textContent);
  assert.doesNotMatch(status, /is on pro/i);
  assert.equal(await page.locator("#body").count(), 0);
});
