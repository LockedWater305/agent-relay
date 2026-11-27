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
