// Audit the real BeeZilla login and nav with a two-account loopback fixture.
// The fixture holds up the new account's billing endpoints, not its session.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const root = new URL("../public/buzzy/", import.meta.url);
const [nav, login] = await Promise.all(["nav.js", "login.html"].map(f => readFile(new URL(f, root))));
const accounts = {
  A: { user: { id: "fixture-a", email: "alpha@example.invalid", name: "Fixture Alpha" }, balance: 4321, entitlement: { ok:true, plan:"pro", remaining:{ inference:19 }, planUntil:"2027-01-02" } },
  B: { user: { id: "fixture-b", email: "beta@example.invalid", name: "Fixture Beta" }, balance: 12, entitlement: { ok:true, plan:"starter", remaining:{ inference:2 }, planUntil:"2027-04-06" } },
};
const shell = '<!doctype html><html><head><script src="/buzzy/nav.js" defer></script></head><body><header><nav></nav></header><main>Private loopback fixture</main></body></html>';
let signOuts = 0, betaBillingReads = 0, betaBillingAvailable = false, sessionAvailable = true, wrongBillingOwner = false;
const api = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const write = (code, body, type) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    const json = (code, value) => write(code, JSON.stringify(value), "application/json");
    const cookie = (req.headers.cookie ?? "").match(/(?:^|;\s*)fixture=(A|B)(?:;|$)/)?.[1];
    const account = accounts[cookie];
    if (path === "/buzzy/login") return write(200, login, "text/html");
    if (path === "/buzzy/nav.js") return write(200, nav, "text/javascript");
    if (path === "/buzzy/profile" || path === "/buzzy/") return write(200, shell, "text/html");
    if (path === "/api/auth/sign-in/email" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { email } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const key = Object.keys(accounts).find(k => email === accounts[k].user.email);
      if (!key) return json(401, {});
      res.setHeader("Set-Cookie", `fixture=${key}; HttpOnly; Path=/; SameSite=Strict`);
      return json(200, { user: accounts[key].user });
    }
    if (path === "/api/auth/get-session") return sessionAvailable
      ? json(200, account ? { session:{ id:"fixture-session-"+cookie, userId:account.user.id }, user:account.user } : null)
      : json(503, { error:"synthetic session failure" });
    if (path === "/api/auth/sign-out" && req.method === "POST") {
      signOuts++;
      res.setHeader("Set-Cookie", "fixture=; Max-Age=0; Path=/");
      return json(200, { success:true });
    }
    if (path === "/api/wallet" || path === "/api/buzzy/entitlement") {
      if (!account) return json(401, {});
      if (cookie === "B") {
        betaBillingReads++;
        if (!betaBillingAvailable) return json(503, { error:"synthetic temporary outage" });
      }
      const replyAccount = wrongBillingOwner ? accounts.A : account;
      res.setHeader("x-bz-account-owner", encodeURIComponent(replyAccount.user.id));
      return json(200, path === "/api/wallet" ? { balance:replyAccount.balance } : replyAccount.entitlement);
    }
    return json(404, {});
  } catch {
    res.statusCode = 500;
    res.end();
  }
});
await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + api.address().port;
let browser;
try {
  browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const ctx = await browser.newContext({ serviceWorkers:"block" });
  ctx.setDefaultTimeout(8000);
  await ctx.route("**/*", r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
  await ctx.addInitScript(() => { window.fixtureDoc = Math.random(); });
  const first = await ctx.newPage();
  const second = await ctx.newPage();
  const read = tab => tab.evaluate(() => {
    const plan = document.getElementById("bzPlanChip"), honey=document.getElementById("bzHoneyChip");
    return { doc:window.fixtureDoc, account:document.getElementById("accountLink")?.textContent, plan:plan?.textContent,
      planTitle:plan?.title, honey:honey?.textContent, honeyTitle:honey?.title, cache:[localStorage.bz_plan,localStorage.bz_honey] };
  });
  const enter = async (tab, key) => {
    await tab.goto(origin + "/buzzy/login?next=%2Fbuzzy%2Fprofile");
    await tab.locator("#email").fill(accounts[key].user.email);
    await tab.locator("#password").fill("fixture-not-real-credential");
    await Promise.all([tab.waitForURL("**/buzzy/profile"), tab.locator("#submit").click()]);
    await tab.waitForFunction(name => document.getElementById("accountLink")?.textContent === name, accounts[key].user.name);
  };
  const waitWallet = (tab, balance) => tab.waitForFunction(text => document.getElementById("bzHoneyChip")?.textContent.includes(text), balance);
  const result = (label, observed, problem) => {
    console.log(problem ? "REPRODUCED" : "SAFE", label, JSON.stringify(observed));
    return Number(problem);
  };
  let findings = 0;
  await enter(first, "A");
  await waitWallet(first,"4,321");
  await first.waitForFunction(() => document.getElementById("bzPlanChip")?.textContent === "PRO");
  const before = await read(first);
  assert.equal(before.account, accounts.A.user.name);
  assert.equal(signOuts, 0);
  let firstSessionReads = 0;
  first.on("request", r => { if (new URL(r.url()).pathname === "/api/auth/get-session") firstSessionReads++; });

  await enter(second, "B");
  const confirmed = await second.evaluate(async () => {
    const response = await fetch("/api/auth/get-session");
    return (await response.json())?.user.id;
  });
  assert.equal(confirmed, accounts.B.user.id);
  assert.equal(signOuts, 0, "there was no sign-out request or intermediate signed-out session");
  assert.equal((await ctx.cookies()).find(c => c.name === "fixture")?.value, "B");
  await sleep(300);
  assert.ok(betaBillingReads >= 2, "Beta indicator reads should have reached the fixture");
  const newPage = await read(second);
  findings += result("new Beta page showing Alpha billing after authoritative Beta identification (Beta billing endpoints 503)",
    newPage, newPage.account === accounts.B.user.name && newPage.planTitle.includes("2027-01-02") && newPage.honeyTitle.includes("4,321"));

  const live = await read(first);
  assert.equal(live.doc, before.doc);
  findings += result("already-open Alpha tab did not notice a direct account switch",
    {...live, firstSessionReads}, live.account !== accounts.B.user.name || live.honeyTitle.includes("4,321") || live.planTitle.includes("2027-01-02") || !firstSessionReads);

  const checked = first.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/get-session");
  await first.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted:true })));
  assert.equal((await (await checked).json()).user.id, accounts.B.user.id);
  await first.waitForFunction(name => document.getElementById("accountLink")?.textContent === name, accounts.B.user.name);
  const restored = await read(first);
  assert.equal(restored.doc, before.doc, "old tab was not reloaded");
  findings += result("simulated persisted restore updated name to Beta while Alpha billing remained",
    restored, restored.planTitle.includes("2027-01-02") && restored.honeyTitle.includes("4,321"));

  betaBillingAvailable = true;
  await second.reload();
  await waitWallet(second, "12");
  await second.waitForFunction(() => document.getElementById("bzPlanChip")?.textContent === "STARTER");
  const recovered = await read(second);
  assert.equal(recovered.account, accounts.B.user.name);
  assert.equal(recovered.honeyTitle, "12 Honey Drops");
  assert.match(recovered.planTitle,/2027-04-06/);
  assert.equal(signOuts, 0);
  console.log("PASS positive control: fresh Beta indicator requests recover Beta values, proving endpoint fixtures are distinct");

  // The original release exits red on the three actual leaks above; the
  // extra checks below exercise the repair only after those scenarios pass.
  if (!findings) {
    wrongBillingOwner = true;
    const foreignReplies = ["/api/wallet", "/api/buzzy/entitlement"].map(path => second.waitForResponse(r => new URL(r.url()).pathname === path));
    await second.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted:true })));
    await second.waitForFunction(name => document.getElementById("accountLink")?.textContent === name, accounts.B.user.name);
    for (const reply of await Promise.all(foreignReplies)) {
      assert.equal(reply.status(), 200);
      // A rejected foreign response body is deliberately not consumed.
      assert.equal(reply.headers()["x-bz-account-owner"], accounts.A.user.id);
    }
    await sleep(200);
    const wrong = await read(second);
    assert.equal(wrong.honeyTitle,"12 Honey Drops","200 reply marked Alpha must not replace Beta's same-account cached balance");
    assert.match(wrong.planTitle,/2027-04-06/,"200 reply marked Alpha must not replace Beta's same-account plan");
    console.log("PASS late/foreign 200 reply ignored despite successful status");

    wrongBillingOwner = false;
    betaBillingAvailable = false;
    await second.reload();
    await waitWallet(second,"12");
    assert.equal((await read(second)).account, accounts.B.user.name);
    console.log("PASS same-account cached indicators can render after verified reload even with a billing outage");

    sessionAvailable = false;
    const unconfirmed = await ctx.newPage();
    await unconfirmed.goto(origin + "/buzzy/login");
    await unconfirmed.evaluate(() => {
      localStorage.setItem("bz_plan", JSON.stringify({ plan:"pro", planUntil:"2026-12-31" }));
      localStorage.setItem("bz_honey", "4321");
    });
    const sessionFault = unconfirmed.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/get-session");
    await unconfirmed.goto(origin + "/buzzy/profile");
    assert.equal((await sessionFault).status(),503);
    const onlineUnknown = await read(unconfirmed);
    assert.equal(onlineUnknown.account,"", "unknown session must not show a prior cached name or claim Sign in");
    assert.equal(onlineUnknown.honeyTitle, "");
    assert.equal(onlineUnknown.planTitle, "");
    assert.deepEqual(onlineUnknown.cache, ["null","null"], "legacy unowned cache is scrubbed even during auth outage");
    console.log("PASS unavailable session shows neutral header, not guessed sign-out or prior plan/balance");
  }
  await ctx.close();
  if (findings) process.exitCode = 1;
} finally {
  await browser?.close();
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
}
