import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setTimeout as sleep } from "node:timers/promises";
import * as h3 from "h3";
import ts from "typescript";
import { chromium } from "playwright";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createRuntimeAuth } from "../desktop/security.mjs";

const require = createRequire(import.meta.url);
const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const token = "synthetic_launch_credential_for_isolated_fixture_32";
const env = { BZ_LOCAL_TOKEN: token, BZ_LOCAL_OWNER_NAME: "Fixture Local Owner", BZ_LOCAL_OWNER_EMAIL: "owner@example.invalid" };
const nav = read("public/buzzy/nav.js"), login = read("public/buzzy/login.html");
const pageShell = '<!doctype html><html><head><script src="/buzzy/nav.js" defer></script></head><body><header><nav></nav></header><main>Isolated account-menu fixture</main></body></html>';
let scenario = "local", fallbackCalls = 0, localReads = 0, auth;
let holdLogout, logoutStarted;
function moduleAt(path, resolver) {
  const tr = ts.transpileModule(read(path), {
    fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true,
  });
  assert.deepEqual((tr.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  vm.runInNewContext(tr.outputText, {
    exports, Headers, Request, Response, URL, Buffer, console, process: { env },
    require(name) { assert.ok(Object.hasOwn(resolver,name), "isolated dependency: " + name); return resolver[name]; },
  }, { filename: path, timeout: 4000 });
  return exports;
}
let row;
const localOwner = moduleAt("src/lib/local-owner.ts", {
  "node:crypto": require("node:crypto"),
  "./runtime": { isLocalRuntime: () => scenario === "local" },
  "./db": {
    async getSql() {
      return async (sql, ...values) => {
        if (sql[0].includes("insert into")) {
          const [id, name, email] = values; row = { id, name, email }; return [];
        }
        assert.match(sql[0], /select id, name, email/);
        assert.equal(values[0], row.id);
        localReads++;
        return [row];
      };
    },
  },
});
const route = moduleAt("src/lib/auth-api.nitro.ts", {
  h3, "./local-owner": localOwner, "./runtime": { isLocalRuntime: () => scenario === "local" },
  "./auth/server": { async handleAuthRequest(req) {
    fallbackCalls++;
    const path = new URL(req.url).pathname;
    if (path === "/api/auth/get-session" && scenario === "malformed-local") {
      return Response.json({ user:{ id:"local_owner", name:"Partial Local Identity", email:"partial@example.invalid" } });
    }
    if (path === "/api/auth/get-session" && scenario === "mismatched") {
      return Response.json({ session:{ id:"ok-looking", userId:"other-fixture-id" }, user:{ id:"local_owner", name:"Partial Local Identity" } });
    }
    if (path === "/api/auth/get-session" && scenario === "malformed-signout-readback") {
      return Response.json({ user:null, session:false });
    }
    if (path === "/api/auth/sign-out" && scenario === "failed-logout") {
      return Response.json({ error:"Fixture failure" }, { status:503 });
    }
    if (path === "/api/auth/sign-out" && scenario === "held-logout") {
      logoutStarted();
      await holdLogout;
      return Response.json({ error:"Old attempt failed late" }, { status:503 });
    }
    if (path === "/api/auth/sign-out" && scenario === "malformed-signout-ack") {
      scenario = "malformed-signout-readback";
      return Response.json({ success:true }); // fixture simulates a misleading acknowledgement; cookie is not changed
    }
    return auth.handler(req);
  } },
}).default;
const app = new h3.H3();
for (const path of ["/buzzy/talk","/buzzy/profile","/buzzy/landing","/buzzy/"]) app.get(path, () => new Response(pageShell, { headers: { "content-type":"text/html" } }));
app.get("/buzzy/nav.js", () => new Response(nav, { headers: { "content-type":"text/javascript; charset=utf-8" } }));
app.get("/buzzy/login", () => new Response(login, { headers: { "content-type":"text/html" } }));
// Adapt a cross-VM async handler to the local Promise realm used by H3.
const handle = async event => await route(event);
app.get("/api/auth/get-session", handle);
for (const path of ["/api/auth/sign-in/email","/api/auth/sign-out"]) app.post(path, handle);
const h3Handler = h3.toNodeHandler(app);
const server = http.createServer((req,res) => { void h3Handler(req,res); });
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const origin = "http://127.0.0.1:" + server.address().port;
auth = betterAuth({
  baseURL: origin,
  secret: "synthetic-loopback-cold-auth-fixtures-not-for-production",
  database: memoryAdapter({ user:[], account:[], session:[], verification:[] }),
  emailAndPassword: { enabled:true },
  telemetry: { enabled:false },
  session: { cookieCache: { enabled:true, maxAge:300 } },
});
const hosted = {
  A:{name:"Fixture Alpha", email:"alpha@example.invalid"},
  B:{name:"Fixture Beta", email:"beta@example.invalid"},
};
const password = "test-account-only-never-reused-password";
for (const user of Object.values(hosted)) {
  const created = await auth.handler(new Request(origin+"/api/auth/sign-up/email", { method:"POST", headers:{ origin,"content-type":"application/json","x-forwarded-for":"127.0.0.1" },body:JSON.stringify({...user,password}) }));
  assert.equal(created.status,200);
}
let browser;
let findings=0;
const observe=(description, data, defective)=>{ console.log(defective?"REPRODUCED":"PASS", description, JSON.stringify(data)); if(defective)findings++; };
try {
  browser = await chromium.launch({ headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const makeContext=async binder=>{
    const ctx=await browser.newContext({ serviceWorkers:"block" });
    ctx.setDefaultTimeout(7000);
    await ctx.route("**/*", async r=>{
      const req=r.request();
      if(new URL(req.url()).origin!==origin) return r.abort();
      if(!binder) return r.continue({ headers:{...req.headers(),"x-forwarded-for":"127.0.0.1"} });
      const bound=binder(req);
      return bound.cancel ? r.abort() : r.continue({ headers:bound.requestHeaders });
    });
    return ctx;
  };
  const expected=(page,q)=>page.waitForResponse(r=>new URL(r.url()).pathname===q);
  const untilAccount=(page,name)=>page.waitForFunction(n=>document.getElementById("accountLink")?.textContent===n,name);
  const ui=page=>page.evaluate(()=>({
    path:location.pathname, name:document.getElementById("accountLink")?.textContent,
    accountTitle:document.getElementById("accountLink")?.title,
    menu:document.querySelector(".account-menu")?.textContent ?? null,
    alert:document.querySelector(".account-menu [role=alert]")?.textContent ?? null,
    logout:document.querySelector(".account-menu .am-signout")?.textContent ?? null,
    disabled:document.querySelector(".account-menu .am-signout")?.disabled ?? null,
  }));
  const start=origin+"/buzzy/talk";
  const frame={ url:start };
  const wc={ id:12, mainFrame:frame, isDestroyed:()=>false,getURL:()=>start };
  const binder=createRuntimeAuth({ getContents:()=>[wc] });
  assert.equal(binder.bind({host:"127.0.0.1",port:server.address().port,token}),origin);
  const fixtureDetails=req=>({
    url:req.url(), requestHeaders:req.headers(), resourceType:req.isNavigationRequest()?"mainFrame":req.resourceType(),
    frame, webContents:wc, webContentsId:wc.id, initiatorOrigin:origin,
  });
  const local=await makeContext(req=>binder.headers(fixtureDetails(req)));
  const lp=await local.newPage();
  const initialLocalRequest=expected(lp,"/api/auth/get-session");
  await lp.goto(start);
  const localBody=await (await initialLocalRequest).json();
  assert.equal(localBody.session.id,"local-session");
  assert.equal(localBody.session.userId,localBody.user.id);
  assert.equal(localBody.user.name,env.BZ_LOCAL_OWNER_NAME);
  assert.ok(!JSON.stringify(localBody).includes(token));
  assert.deepEqual(await local.cookies(),[]);
  assert.equal(localReads,1);
  assert.equal(fallbackCalls,0);
  await untilAccount(lp,env.BZ_LOCAL_OWNER_NAME);
  await lp.locator("#accountLink").click();
  const localUI=await ui(lp);
  assert.match(localUI.menu,/Local workspace/);
  assert.equal(localUI.logout,null);
  assert.equal(binder.headers({...fixtureDetails({url:()=>origin+"/api/auth/get-session",headers:()=>({}),isNavigationRequest:()=>false,resourceType:()=>"fetch"}),webContentsId:99}).cancel,true);
  console.log("PASS cold direct Talk browser with real desktop token-binder logic and exact local H3 adapter gives workspace menu without hosted logout");
  await local.close();

  const guest=await makeContext(null), guestPage=await guest.newPage();
  const askSession=expected(guestPage,"/api/auth/get-session");
  await guestPage.goto(start);
  const anonymous=await askSession;
  assert.equal(await anonymous.json(),null);
  assert.equal(anonymous.headers()["cache-control"],"no-store");
  await untilAccount(guestPage,"Sign in");
  assert.equal((await ui(guestPage)).menu,null);
  assert.equal(localReads,1,"untrusted direct cold page never provisions/reads owner");
  console.log("PASS cold direct browser without launch token receives true null and Sign in without stale menu");
  await guest.close();

  for(const bad of ["malformed-local","mismatched"]){
    scenario=bad;
    const cx=await makeContext(null), p=await cx.newPage();
    const get=expected(p,"/api/auth/get-session");
    await p.goto(start); assert.equal((await get).status(),200); await sleep(160);
    const badge=await ui(p); if(badge.name)await p.locator("#accountLink").click();
    const outcome=await ui(p);
    observe("cold malformed "+bad+" must not paint or enable an account",outcome,outcome.name!==""||outcome.menu!==null);
    await cx.close();
  }

  const enter=async (p,user)=>{
    await p.goto(origin+"/buzzy/login?next=%2Fbuzzy%2Fprofile");
    await p.locator("#email").fill(user.email); await p.locator("#password").fill(password);
    const verified=expected(p,"/api/auth/get-session");
    await Promise.all([p.waitForURL("**/buzzy/profile"),p.locator("#submit").click()]);
    const s=await (await verified).json();
    assert.equal(s.session.userId,s.user.id);assert.equal(s.user.name,user.name);
    await untilAccount(p,user.name);
  };

  scenario="hosted";
  const malformed=await makeContext(null), mp=await malformed.newPage();
  await enter(mp,hosted.A);
  scenario="malformed-signout-ack";
  const confirmation=expected(mp,"/api/auth/get-session");
  await mp.locator("#accountLink").click();await mp.getByRole("button",{name:"Log out",exact:true}).click();
  assert.equal((await confirmation).status(),200);await sleep(300);
  const afterBad=await ui(mp);
  observe("malformed session:false read-back must retain the unresolved logout state",afterBad,afterBad.path!=="/buzzy/profile"||!afterBad.alert);
  await malformed.close();

  scenario="hosted";
  const switched=await makeContext(null), old=await switched.newPage(), next=await switched.newPage();
  await enter(old,hosted.A);
  scenario="failed-logout";
  await old.locator("#accountLink").click(); await old.getByRole("button",{name:"Log out",exact:true}).click();
  await old.locator(".account-menu [role=alert]").waitFor();
  scenario="hosted";
  await enter(next,hosted.B); await untilAccount(old,hosted.B.name);
  await old.locator("#accountLink").click();
  const priorAlert=await ui(old);
  observe("replacement account must not inherit previous account's failed logout alert",priorAlert,priorAlert.alert!==null);
  await switched.close();

  scenario="hosted";
  const pending=await makeContext(null), pOld=await pending.newPage(), pNew=await pending.newPage();
  await enter(pOld,hosted.A);
  let releaseLogout;
  holdLogout=new Promise(resolve=>{releaseLogout=resolve;});
  const captured=new Promise(resolve=>{logoutStarted=resolve;});
  scenario="held-logout";
  try {
    await pOld.locator("#accountLink").click();await pOld.getByRole("button",{name:"Log out",exact:true}).click();
    await captured;
    scenario="hosted";
    await enter(pNew,hosted.B);await untilAccount(pOld,hosted.B.name);
    await pOld.locator("#accountLink").click();
    const inherited=await ui(pOld);
    observe("replacement account must not inherit another account's pending logout",inherited,inherited.logout!=="Log out"||inherited.disabled);
    const oldReply=expected(pOld,"/api/auth/sign-out");
    releaseLogout();
    assert.equal((await oldReply).status(),503);await sleep(170);
    const late=await ui(pOld);
    observe("old logout rejection must not repaint replacement account menu",late,late.alert!==null);
  } finally { releaseLogout(); await pending.close(); }

  if(findings)process.exitCode=1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
