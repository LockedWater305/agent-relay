// Exercise the shipped login form and account menu through ordinary browser input.
// Loopback fixture only: no real service, credentials, or account required.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("../public/buzzy/", import.meta.url);
const [nav, login] = await Promise.all(["nav.js", "login.html"].map(f => readFile(new URL(f,root))));
const user = { id:"fixture-user", name:"Fixture Reader", email:"fixture@example.test" };
const local = { id:"local_owner", name:"Local Owner", email:"owner@beezilla.local" };
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
  for(const mode of ["failure","offline","bad-body","delayed","expired","local","another-tab","restored-page-event"]){
    scenario=mode;posts=0; const ctx=await browser.newContext();
    try {
      let attempts=0;
      await ctx.route("**/*",r=>{
        const u=new URL(r.request().url());
        if(u.origin!==origin) return r.abort();
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
      await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==="/api/auth/get-session"),page.reload()]);
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
      }else if(mode==="another-tab" || mode==="restored-page-event"){
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
    }catch(e){process.exitCode=1;console.error("FAIL",mode,e.message);}finally{await ctx.close();}
  }
}finally{await browser?.close();api.closeAllConnections();await new Promise(r=>api.close(r));}
