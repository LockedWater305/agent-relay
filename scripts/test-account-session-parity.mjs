// Exercise the shipped login form and account menu through ordinary browser input.
// Loopback fixture only: no real service, credentials, or account required.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const root = new URL("../public/buzzy/", import.meta.url);
const [nav, login] = await Promise.all(["nav.js", "login.html"].map(f => readFile(new URL(f,root))));
const user = { id:"fixture-user", name:"Fixture Reader", email:"fixture@example.test" };
const local = { id:"local_owner", name:"Local Owner", email:"owner@beezilla.local" };
const isIndicator = pathname => pathname==="/api/wallet" || pathname==="/api/buzzy/entitlement";
const shell = '<!doctype html><html><head><script src="/buzzy/nav.js" defer></script></head><body><header><nav></nav></header><main>Fixture page</main></body></html>';
let scenario, posts;
const api = http.createServer((req,res) => {
  const path = new URL(req.url,"http://localhost").pathname;
  const json = (code,val) => { res.writeHead(code,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(val)); };
  if(path==="/buzzy/nav.js"){res.writeHead(200,{"content-type":"text/javascript"});return res.end(nav);}
  if(path==="/buzzy/login"){res.writeHead(200,{"content-type":"text/html"});return res.end(login);}
  if(path.startsWith("/buzzy/") && !path.includes(".")){res.writeHead(200,{"content-type":"text/html"});return res.end(shell);}
  if(path==="/api/auth/sign-in/email" && req.method==="POST"){res.setHeader("Set-Cookie","fixture=synthetic; HttpOnly; Path=/; SameSite=Strict");return json(200,{user});}
  if(path==="/api/auth/get-session"){return json(200,scenario==="local"?{session:{id:"local-session",userId:local.id},user:local}:req.headers.cookie?.includes("fixture=synthetic")?{session:{id:"session-fixture",userId:user.id},user}:null);}
  if(isIndicator(path)){
    if(!req.headers.cookie?.includes("fixture=synthetic"))return json(401,{});
    return json(200,path==="/api/wallet"?{balance:4321}:{ok:true,plan:"pro",remaining:{inference:19},planUntil:"2027-01-02"});
  }
  if(path==="/api/auth/sign-out" && req.method==="POST"){
    ++posts;
    if(scenario==="failure")return json(500,{message:"fixture unavailable"});
    if(scenario==="bad-body"){res.writeHead(200,{"content-type":"text/html"});return res.end("fixture service unavailable");}
    if(scenario==="delayed")return setTimeout(()=>{res.setHeader("Set-Cookie","fixture=; Max-Age=0; Path=/");json(200,{success:true});},250);
    res.setHeader("Set-Cookie","fixture=; Max-Age=0; Path=/");return json(200,{success:true});
  }
  if(path.startsWith("/api/"))return json(404,{});
  res.writeHead(404);res.end();
});
await new Promise(r=>api.listen(0,"127.0.0.1",r));
const origin="http://127.0.0.1:"+api.address().port;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  for(const mode of ["failure","offline","bad-body","delayed","expired","local","another-tab","restored-page-event","late-indicators"]){
    scenario=mode;posts=0; const ctx=await browser.newContext();
    let delayPrivateResponses=false, releasePrivateResponses;
    const privateResponseGate=new Promise(resolve=>{releasePrivateResponses=resolve;});
    let countHeld=0, markHeld;
    const heldResponses=new Promise(resolve=>{markHeld=resolve;});
    try {
      let attempts=0;
      await ctx.route("**/*",async r=>{
        const u=new URL(r.request().url());
        if(u.origin!==origin) return r.abort();
        if(delayPrivateResponses && isIndicator(u.pathname)){
          const response=await r.fetch();
          if(++countHeld===2)markHeld();
          await privateResponseGate;
          return r.fulfill({response});
        }
        if(u.pathname==="/api/auth/sign-out" && r.request().method()==="POST"){
          ++attempts;
          if(scenario==="offline")return r.abort("internetdisconnected");
        }
        return r.continue();
      });
      const page=await ctx.newPage(),pageErrors=[];
      page.on("pageerror",e=>pageErrors.push(String(e)));
      page.setDefaultTimeout(3500);
      if(mode==="local"){await page.goto(origin+"/buzzy/profile");}
      else {
        await page.goto(origin+"/buzzy/login?next=%2Fbuzzy%2Fprofile");
        await page.locator("#email").fill(user.email);await page.locator("#password").fill("synthetic-fixture-only");
        await Promise.all([page.waitForURL("**/buzzy/profile"),page.locator("#submit").click()]);
      }
      await page.waitForFunction(n=>document.getElementById("accountLink")?.textContent===n,mode==="local"?local.name:user.name);
      const indicatorCase=["another-tab","restored-page-event","late-indicators"].includes(mode);
      if(indicatorCase)await page.waitForFunction(()=>document.getElementById("bzPlanChip")?.textContent==="PRO" && /4,321/.test(document.getElementById("bzHoneyChip")?.textContent||""));
      delayPrivateResponses=mode==="late-indicators";
      const staleResponses=delayPrivateResponses?["/api/wallet","/api/buzzy/entitlement"].map(path=>page.waitForResponse(r=>new URL(r.url()).pathname===path)) : [];
      await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/get-session"),page.reload()]);
      if(delayPrivateResponses)await Promise.race([
        heldResponses,
        sleep(2500,undefined,{ref:false}).then(()=>{throw new Error("indicator responses were not held before expiry");}),
      ]);
      await page.waitForFunction(n=>document.getElementById("accountLink")?.textContent===n,mode==="local"?local.name:user.name);
      // Force an authoritative session read in this page's lifecycle before testing the menu.

      await page.locator("#accountLink").click();
      const menu=page.locator("#bzChrome .account-menu");
      if(mode==="expired"){
        await ctx.clearCookies();
        await page.reload();
        await page.waitForFunction(()=>document.getElementById("accountLink")?.textContent==="Sign in");
        // Cached names/emails are presentation hints only. Once the server
        // confirms expiry, neither the old menu nor its click target may survive.
        assert.equal(await menu.count(),0);
        assert.equal(await page.locator("#accountLink").getAttribute("href"),"/buzzy/landing");
        assert.equal(await page.evaluate(()=>localStorage.bz_identity),"null");
        assert.equal(posts,0);
      }else if(mode==="local"){
        assert.match(await menu.innerText(),/local workspace/i);
        assert.equal(await menu.getByRole("button",{name:"Log out"}).count(),0);
        assert.equal(posts,0);
      }else if(indicatorCase){
        const documentKey=await page.evaluate(()=>window.__sessionFixtureDoc=Math.random());
        const reread=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/get-session");
        if(mode==="another-tab"){
          const other=await ctx.newPage();
          await other.goto(origin+"/buzzy/profile");
          await other.waitForFunction(n=>document.getElementById("accountLink")?.textContent===n,user.name);
          await other.locator("#accountLink").click();
          await Promise.all([other.waitForURL("**/buzzy/"),other.getByRole("button",{name:"Log out"}).click()]);
          await other.close();
          assert.equal(posts,1);
        }else{
          // Headless Chromium doesn't retain this document in BFCache. Test
          // the browser's persisted pageshow event without requiring retention.
          await ctx.clearCookies();
          await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));
          assert.equal(posts,0);
        }
        assert.equal(await (await reread).json(),null);
        await page.waitForFunction(()=>document.getElementById("accountLink")?.textContent==="Sign in");
        assert.equal(await menu.count(),0);
        assert.equal(await page.evaluate(()=>window.__sessionFixtureDoc),documentKey,"old document updated without reload");
        if(mode==="late-indicators"){
          releasePrivateResponses();
          const responses=await Promise.all(staleResponses);
          assert.deepEqual(await Promise.all(responses.map(r=>r.status())),[200,200],"old authenticated responses arrived after logout");
          await Promise.all(responses.map(r=>r.finished()));
          // Allow the response JSON/DOM microtasks to settle before asserting.
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        }
        const indicators=await page.evaluate(()=>{
          const plan=document.getElementById("bzPlanChip"),honey=document.getElementById("bzHoneyChip");
          return {plan:plan.textContent,planTitle:plan.getAttribute("title"),hidden:plan.style.display==="none",honey:honey.textContent,honeyTitle:honey.title,cache:[localStorage.bz_plan,localStorage.bz_honey]};
        });
        assert.deepEqual(indicators,{plan:"",planTitle:null,hidden:true,honey:"\u25c8",honeyTitle:"",cache:["null","null"]},"no previous plan, usage, billing date or Honey balance remains in DOM or persistent cache");
      }else{
        const before=await page.evaluate(()=>{localStorage.setItem("bz_plan",'"fixture-plan"');localStorage.setItem("bz_honey","5");return [localStorage.bz_identity,localStorage.bz_plan,localStorage.bz_honey];});
        await menu.getByRole("button",{name:"Log out"}).click();
        if(mode==="delayed"){
          await page.waitForURL("**/buzzy/");
          await page.waitForFunction(()=>document.getElementById("accountLink")?.textContent==="Sign in");
          assert.deepEqual(await page.evaluate(()=>[localStorage.bz_identity,localStorage.bz_plan,localStorage.bz_honey]),["null","null","null"]);
          assert.ok(!(await ctx.cookies()).some(c=>c.name==="fixture"));
        }else{
          await page.waitForFunction(()=>document.querySelector("#bzChrome .account-menu [role=alert]")?.textContent);
          assert.equal(new URL(page.url()).pathname,"/buzzy/profile");
          assert.deepEqual(await page.evaluate(()=>[localStorage.bz_identity,localStorage.bz_plan,localStorage.bz_honey]), before);
          assert.equal(await menu.getByRole("button",{name:"Log out"}).isEnabled(),true);
          assert.ok((await ctx.cookies()).some(c=>c.name==="fixture"));
        }
        assert.equal(attempts,1);
        assert.equal(posts,mode==="offline"?0:1);
        if(mode!=="delayed"){
          scenario="retry";
          await Promise.all([page.waitForURL("**/buzzy/"),menu.getByRole("button",{name:"Log out"}).click()]);
          await page.waitForFunction(()=>document.getElementById("accountLink")?.textContent==="Sign in");
          assert.equal(attempts,2);
        }
      }
      assert.deepEqual(pageErrors,[]);
      console.log("PASS",mode,"sign-in/refresh/identity/logout");
    }catch(e){process.exitCode=1;console.error("FAIL",mode,e.message);}finally{releasePrivateResponses();await ctx.close();}
  }
}finally{await browser?.close();api.closeAllConnections();await new Promise(r=>api.close(r));}
