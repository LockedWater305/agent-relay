/** Controlled Chromium run of the shipped Project markup and shell. All HTTP is intercepted. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const DEFAULT_ORIGIN = "http://127.0.0.1:17484";
const at = (path, origin=DEFAULT_ORIGIN) => new URL(path, origin).href;
const route = id => "/buzzy/project" + (id ? "?job=" + id : "");
const read = path => readFileSync(new URL("../public/buzzy/" + path, import.meta.url), "utf8");
const withNav = html => html.replace(/<\/body>(?=\s*<\/html>\s*$)/, '<script src="/buzzy/nav.js" defer></script></body>');
const sources = { "project.html": read("project.html"), "nav.js": read("nav.js"), "nav.css": read("nav.css") };
const talk = withNav('<!doctype html><html><head><title>Fixture Talk</title></head><body><header><nav id="bzNav"></nav></header><main id="work"><a href="/buzzy/project?job=fixture_a" id="openA">Open recent A</a> <a href="/buzzy/project?job=fixture_b" id="openB">Open recent B</a></main></body></html>');
const record = suffix => ({
  ok: true,
  project: {id:"fixture_" + suffix,title:"Same synthetic title",status:"Deliverable ready",updated_at:"2026-11-26T12:00:00Z"},
  sources: [{label:"Input " + suffix,kind:"brief"}],
  deliverables: [{name:"same-filename.txt",kind:"file",type:"text/plain",bytes:32,url:"/api/buzzy/assets/" + (suffix === "a" ? 101 : 102)}],
  turns: [{surface:"Lane " + suffix, created_at:"2026-11-26T12:00:00Z", latency_ms:50}],
  messages: [{role:"user",content:"History " + suffix,created_at:"2026-11-26T12:00:00Z"}],
});
let browser;
before(async()=>{ browser = await chromium.launch({headless: true, executablePath: process.env.BZ_PROJECT_CHROMIUM || undefined, args: ["--disable-dev-shm-usage"]}); });
after(async()=>{ await browser?.close(); });

const respond = (route, json, status = 200) => route.fulfill({status, json});
function defer() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function usingFixture(t, handle, { beforeTalk = () => {}, origin = DEFAULT_ORIGIN } = {}) {
  const context=await browser.newContext({serviceWorkers:"block"});
  t.after(async()=>{ await context.close(); });
  const calls=[], pageErrors=[], unknown=[];
  await context.route("**/*",async r=>{
    const u=new URL(r.request().url()), path=u.pathname;
    if (u.origin!==origin || r.request().method()!=="GET") {
      unknown.push(r.request().method()+ " " + u.href);
      return r.abort();
    }
    if (path.startsWith("/api/buzzy/projects/")) {
      const id=path.split("/").at(-1);
      calls.push(id);
      return handle(r,id,calls.filter(x=>x===id).length);
    }
    if (path==="/buzzy/project") return r.fulfill({contentType:"text/html;charset=utf-8",body:withNav(sources["project.html"])});
    if (path==="/buzzy/talk") {
      await beforeTalk();
      return r.fulfill({contentType:"text/html;charset=utf-8",body:talk});
    }
    if (path==="/buzzy/landing") return r.fulfill({contentType:"text/html",body:"<h1>Fixture sign in</h1>"});
    if (path==="/buzzy/nav.js" || path==="/buzzy/nav.css") return r.fulfill({contentType:path.endsWith(".js")?"text/javascript":"text/css",body:sources[path.split("/").at(-1)]});
    if (path==="/buzzy/chat.js") return r.fulfill({contentType:"text/javascript",body:"window.BeeZillaChat={mount(slot, options){slot.dataset.fixtureJob=options.jobId||'';}};"});
    if (path==="/buzzy/companies.js") return r.fulfill({contentType:"text/javascript",body:"/* no company workload in this fixture */"});
    if (path.startsWith("/buzzy/brand/") || path==="/favicon.ico") return r.fulfill({status:204});
    if (path==="/api/auth/get-session") return respond(r,null);
    if (path==="/api/buzzy/entitlement" || path==="/api/wallet") return respond(r,{error:"fixture signed out"},401);
    unknown.push(path);
    return r.abort();
  });
  const page=await context.newPage();
  page.setDefaultTimeout(1500);
  page.on("pageerror",error=>pageErrors.push(error.message));
  t.after(()=>{ assert.deepEqual(unknown,[],"no real or unexpected request"); assert.deepEqual(pageErrors,[],"no renderer script errors"); });
  return {page,calls};
}
async function loaded(page,suffix,origin=DEFAULT_ORIGIN) {
  await page.locator("#deliverables h3").filter({hasText:"same-filename.txt"}).waitFor();
  assert.equal(await page.locator("#title").textContent(),"Same synthetic title");
  assert.equal(await page.locator("#deliverables a").getAttribute("href"),"/api/buzzy/assets/"+(suffix==="a"?101:102));
  assert.match(await page.locator("#conversation").textContent(),new RegExp("History "+suffix));
  assert.match(await page.locator("#activity").textContent(),new RegExp("Lane "+suffix));
  assert.match(await page.locator("#sources").textContent(),new RegExp("Input "+suffix));
  assert.equal(await page.locator("#meta a").getAttribute("href"),"/buzzy/talk?job=fixture_"+suffix);
  assert.equal(await page.locator("#chatSlot").getAttribute("data-fixture-job"),"fixture_"+suffix);
  assert.equal(page.url(),at(route("fixture_"+suffix),origin));
}
async function noSpinners(page) {
  const content = await page.locator("#sources, #deliverables, #activity, #conversation").allTextContents();
  assert.equal(content.length,4);
  assert.ok(content.every(x=>!x.includes("Loading")),JSON.stringify(content));
}

test("transient Project GET failure has a usable in-page retry for the same job",{timeout:10000},async t=>{
  const {page,calls}=await usingFixture(t,(r,id,n)=>n===1?respond(r,{error:"synthetic outage"},503):respond(r,record("a")));
  await page.goto(at(route("fixture_a")));
  await page.getByRole("heading",{name:"Could not load project",exact:true}).waitFor();
  await noSpinners(page);
  assert.equal(page.url(),at(route("fixture_a")));
  await page.getByRole("button",{name:"Retry project"}).click();
  await loaded(page,"a");
  assert.deepEqual(calls,["fixture_a","fixture_a"]);
});

test("queued Retry activations start only one active Project request",{timeout:10000},async t=>{
  const retryStarted=defer(), release=defer();
  t.after(release.resolve);
  const {page,calls}=await usingFixture(t,async(r,id,n)=>{
    if(n===1)return respond(r,{error:"synthetic outage"},503);
    if(n===2) {
      retryStarted.resolve();
      await release.promise;
      return respond(r,record("a"));
    }
    return respond(r,{error:"synthetic expired session"},401);
  });
  await page.goto(at(route("fixture_a")));
  const retry=page.getByRole("button",{name:"Retry project"});
  await retry.waitFor();
  const started=await retry.evaluate(button=>{
    const fetch=window.fetch;
    let starts=0;
    window.fetch=function(url,...args) {
      if(url==="/api/buzzy/projects/fixture_a")starts++;
      return fetch.call(this,url,...args);
    };
    try {
      button.click();
      button.click();
      return starts;
    } finally { window.fetch=fetch; }
  });
  await retryStarted.promise;
  release.resolve();
  assert.equal(started,1,"both queued activations reached the available handler; only one may start a request");
  await loaded(page,"a");
  assert.deepEqual(calls,["fixture_a","fixture_a"],"no overlapping 401 can steer an active retry");
});

test("aborted request and invalid JSON both offer retry, with no raw input displayed",{timeout:10000},async t=>{
  const {page,calls}=await usingFixture(t,(r,id,n)=>n===1?r.abort("failed"):n===2?r.fulfill({contentType:"application/json",body:"not valid fixture JSON"}):respond(r,record("a")));
  await page.goto(at(route("fixture_a")));
  const retry=page.getByRole("button",{name:"Retry project"});
  await retry.waitFor();
  await noSpinners(page);
  await retry.click();
  await retry.waitFor();
  assert.doesNotMatch(await page.locator("#meta").textContent(),/not valid fixture JSON|SyntaxError|Unexpected token/);
  await retry.click();
  await loaded(page,"a");
  assert.deepEqual(calls,["fixture_a","fixture_a","fixture_a"]);
});

for (const status of [403, 404]) {
  test("unavailable Project " + status + " has no loader or misleading retry",{timeout:10000},async t=>{
    const {page,calls}=await usingFixture(t,r=>respond(r,{error:"No such project"},status));
    await page.goto(at(route("fixture_a")));
    await page.getByRole("heading",{name:"Project unavailable",exact:true}).waitFor();
    await noSpinners(page);
    assert.equal(await page.getByRole("button",{name:"Retry project"}).count(),0);
    await page.locator("#backLink").click();
    await page.locator("#openA").waitFor();
    assert.equal(page.url(),at("/buzzy/talk"));
    assert.deepEqual(calls,["fixture_a"]);
  });
}

test("an unselected Project is passive: no request, loader, or retry",{timeout:10000},async t=>{
  const {page,calls}=await usingFixture(t,r=>respond(r,{error:"Unexpected request"},500));
  await page.goto(at(route()));
  await page.getByRole("heading",{name:"No project selected",exact:true}).waitFor();
  await noSpinners(page);
  assert.equal(await page.getByRole("button",{name:"Retry project"}).count(),0);
  assert.deepEqual(calls,[]);
});

test("late same-name Project A cannot overwrite Project B; Back and reopen use the correct record",{timeout:10000},async t=>{
  const late=defer(), started=defer(), released=defer();
  t.after(late.resolve);
  const {page,calls}=await usingFixture(t,async(r,id,n)=>{
    if(id==="fixture_a" && n===1) { started.resolve(); await late.promise; }
    try { await respond(r,record(id.at(-1))); } finally { if(id==="fixture_a" && n===1) released.resolve(); }
  });
  await page.goto(at("/buzzy/talk"));
  await page.locator("#openA").click();
  await started.promise;
  await page.locator("#backLink").click();
  await page.locator("#openB").click();
  await loaded(page,"b");
  late.resolve();
  await released.promise;
  await loaded(page,"b");
  await page.goBack();
  await page.locator("#openA").waitFor();
  await page.goBack();
  await loaded(page,"a");
  await page.reload();
  await loaded(page,"a");
  assert.deepEqual(calls,["fixture_a","fixture_b","fixture_a","fixture_a"]);
});

test("successful HTTP response must identify the requested Project before rendering",{timeout:10000},async t=>{
  const {page,calls}=await usingFixture(t,(r,id,n)=>{
    const response=record(n===1?"a":"b");
    if(n===2) delete response.project.id;
    return respond(r,response);
  });
  await page.goto(at(route("fixture_b")));
  const retry=page.getByRole("button",{name:"Retry project"});
  for(let attempt=0;attempt<2;attempt++){
    await page.getByRole("heading",{name:"Could not load project",exact:true}).waitFor();
    await noSpinners(page);
    assert.equal(await page.locator("#deliverables a, #meta a").count(),0);
    assert.doesNotMatch((await page.locator("#sources, #activity, #conversation").allTextContents()).join(" "),/Input [ab]|Lane [ab]|History [ab]/);
    assert.equal(page.url(),at(route("fixture_b")));
    await retry.click();
  }
  await loaded(page,"b");
  assert.deepEqual(calls,["fixture_b","fixture_b","fixture_b"]);
});

test("current Project 401 still takes the ordinary sign-in route",{timeout:10000},async t=>{
  const {page,calls}=await usingFixture(t,r=>respond(r,{error:"Sign in required",code:"signed_out"},401));
  await page.goto(at(route("fixture_a")));
  await page.getByRole("heading",{name:"Fixture sign in"}).waitFor();
  assert.equal(page.url(),at("/buzzy/landing"));
  assert.deepEqual(calls,["fixture_a"]);
});


test("a 401 for the retiring Project cannot interrupt pending Talk navigation",{timeout:10000},async t=>{
  const projectStarted=defer(), talkStarted=defer(), old401=defer(), talkReady=defer();
  t.after(()=>{ old401.resolve(); talkReady.resolve(); });
  const {page,calls}=await usingFixture(t,async(r,id,n)=>{
    if(n>1)return respond(r,record("a"));
    projectStarted.resolve();
    await old401.promise;
    return respond(r,{error:"Sign in required",code:"signed_out"},401);
  }, { beforeTalk:()=>{ talkStarted.resolve(); return talkReady.promise; } });
  await page.goto(at(route("fixture_a")));
  await projectStarted.promise;
  await page.locator("#backLink").click();
  await talkStarted.promise;
  assert.equal(page.url(),at("/buzzy/talk"));
  assert.equal(await page.locator("#title").textContent(),"Project","still the retiring mounted Project");
  old401.resolve();
  // Let the stale 401 reach the retiring renderer while Talk's HTML is still held.
  await page.getByRole("heading",{name:"Could not load project",exact:true}).waitFor();
  assert.equal(page.url(),at("/buzzy/talk"),"a stale 401 cannot redirect the pending destination");
  talkReady.resolve();
  await page.locator("#openA").waitFor();
  await page.goBack();
  await loaded(page,"a");
  assert.deepEqual(calls,["fixture_a","fixture_a"]);
});

async function throttledProject(t, hold) {
  const started=defer(), closed=defer();
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push(req.url);
    if (req.method!=="GET" || req.url!=="/api/buzzy/projects/fixture_a") {
      res.writeHead(404).end();
      return;
    }
    if (requests.length>1) {
      res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(record("a")));
      return;
    }
    res.once("close",()=>closed.resolve(!res.writableFinished));
    if (hold==="body" || hold==="non-ok") {
      res.writeHead(hold==="non-ok"?503:200,{"Content-Type":"application/json"});
      res.write('{"ok":true, "project":');
    }
    started.resolve();
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(done=>server.close(done));
  });
  return {origin:"http://127.0.0.1:"+server.address().port,started,closed,requests};
}

for (const phase of ["headers","body"]) {
  test("Project deadline aborts real incomplete HTTP "+phase+" and permits retry",{timeout:10000},async t=>{
    const wire=await throttledProject(t,phase);
    const {page,calls}=await usingFixture(t,r=>r.continue(),{origin:wire.origin});
    await page.clock.install();
    const project=at(route("fixture_a"),wire.origin);
    const bodyStarted=phase==="body"
      ? page.waitForResponse(r=>r.url()===at("/api/buzzy/projects/fixture_a",wire.origin) && r.status()===200)
      : Promise.resolve();
    await page.goto(project);
    await Promise.all([wire.started.promise,bodyStarted]);
    assert.match(await page.locator("#sources").textContent(),/Loading/);
    await page.clock.fastForward(15_100);
    await page.getByRole("heading",{name:"Could not load project",exact:true}).waitFor();
    await noSpinners(page);
    assert.equal(await wire.closed.promise,true,"the original HTTP response was aborted, not merely ignored");
    assert.equal(page.url(),project);
    await page.getByRole("button",{name:"Retry project"}).click();
    await loaded(page,"a",wire.origin);
    assert.deepEqual(calls,["fixture_a","fixture_a"]);
    assert.deepEqual(wire.requests,["/api/buzzy/projects/fixture_a","/api/buzzy/projects/fixture_a"]);
  });
}

test("non-OK HTTP status aborts the unused error body without hiding Retry",{timeout:10000},async t=>{
  const wire=await throttledProject(t,"non-ok");
  const {page,calls}=await usingFixture(t,r=>r.continue(),{origin:wire.origin});
  await page.goto(at(route("fixture_a"),wire.origin));
  await wire.started.promise;
  const retry=page.getByRole("button",{name:"Retry project"});
  await retry.waitFor();
  assert.match(await page.locator("#meta").textContent(),/project details didn't load/);
  let timer;
  try {
    await Promise.race([wire.closed.promise.then(closed=>assert.equal(closed,true)),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("unread synthetic 503 stayed open")),1500);})]);
  } finally { clearTimeout(timer); }
  await retry.click();
  await loaded(page,"a",wire.origin);
  assert.deepEqual(calls,["fixture_a","fixture_a"]);
});

test("Back cancels pending Talk shell navigation without replacing the prior Project",{timeout:10000},async t=>{
  const talkStarted=defer(), talkReady=defer();
  t.after(talkReady.resolve);
  const {page,calls}=await usingFixture(t,r=>respond(r,record("a")),{
    beforeTalk:()=>{ talkStarted.resolve(); return talkReady.promise; }
  });
  await page.clock.install();
  await page.goto(at(route("fixture_a")));
  await loaded(page,"a");
  const mounted=await page.locator("#title").elementHandle();
  await page.locator("#backLink").click();
  await talkStarted.promise;
  assert.equal(page.url(),at("/buzzy/talk"));
  await page.goBack();
  await page.waitForFunction(()=>!window.BeeZillaShell.busy);
  talkReady.resolve();
  await page.clock.fastForward(15_100);
  await loaded(page,"a");
  assert.ok(await mounted.evaluate(node=>node===document.getElementById("title")),"no Project DOM remount");
  assert.deepEqual(calls,["fixture_a"],"neither restarting nor timing out a resolved request");
});

test("deadline of a still mounted Project remains retryable after Back cancels pending Talk",{timeout:10000},async t=>{
  const wire=await throttledProject(t,"headers");
  const talkStarted=defer(), talkReady=defer();
  t.after(talkReady.resolve);
  const {page,calls}=await usingFixture(t,r=>r.continue(),{
    origin:wire.origin, beforeTalk:()=>{ talkStarted.resolve(); return talkReady.promise; }
  });
  await page.clock.install();
  await page.goto(at(route("fixture_a"),wire.origin));
  await wire.started.promise;
  const mounted=await page.locator("#title").elementHandle();
  await page.locator("#backLink").click();
  await talkStarted.promise;
  await page.clock.fastForward(15_100);
  await page.getByRole("heading",{name:"Could not load project",exact:true}).waitFor();
  assert.equal(await wire.closed.promise,true);
  assert.equal(page.url(),at("/buzzy/talk",wire.origin),"retry state must not steal the pending route");
  await page.goBack();
  await page.waitForFunction(()=>!window.BeeZillaShell.busy);
  talkReady.resolve();
  assert.ok(await mounted.evaluate(node=>node===document.getElementById("title")));
  await page.getByRole("button",{name:"Retry project"}).click();
  await loaded(page,"a",wire.origin);
  assert.deepEqual(calls,["fixture_a","fixture_a"]);
});
