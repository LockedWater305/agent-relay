/** Full Library renderer and vault in an offline Chromium fixture. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const origin = "http://127.0.0.1:17485";
const read = name => readFileSync(new URL("../public/buzzy/" + name, import.meta.url), "utf8");
const library = read("library.html").replace(/<\/body>\s*<\/html>\s*$/, '<script src="/buzzy/nav.js" defer></script></body></html>');
const inputs = { "nav.js": read("nav.js"), "nav.css": read("nav.css"), "library-vault.js": read("library-vault.js") };
const identity = {session:{id:"fixture-session",userId:"fixture-owner"},user:{id:"fixture-owner",name:"Fixture Reader",email:"owner@example.invalid"}};
const metadata = {ok:true,storeId:"fixture-store",generation:"0"};
const reports = [
  {jobId:"fixture_a",document:{name:"same.md",md:"First version in folder A",createdAt:1}},
  {jobId:"fixture_a",document:{name:"same.md",md:"Second version in folder A",createdAt:2}},
  {jobId:"fixture_b",document:{name:"same.md",md:"Separate folder B document",createdAt:3}},
];
const jobs = [{id:"fixture_a",title:"Fixture A",data:{}},{id:"fixture_b",title:"Fixture B",data:{}}];
function handoff() {
  let done;
  const promise = new Promise(resolve=>{ done=resolve; });
  return {promise,done};
}
const json = (route, body, status=200) => route.fulfill({status,json:body});
const pageRows = (route, records=reports) => json(route,{...metadata,records,done:true,nextCursor:null});
let browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.BZ_LIBRARY_CHROMIUM||undefined,args:["--disable-dev-shm-usage"]});});
after(async()=>{await browser?.close();});

async function fixture(t, onList, {desktop=true,beforeLibrary=()=>{},serverJobs=jobs}={}) {
  const context=await browser.newContext({serviceWorkers:"block"});
  t.after(async()=>{await context.close();});
  const calls=[], unexpected=[], errors=[];
  if(desktop) await context.addInitScript(()=>{window.beezilla={};});
  let lists=0;
  await context.route("**/*",async r=>{
    const u=new URL(r.request().url()), p=u.pathname;
    if(u.origin!==origin || r.request().method()!=="GET") {
      unexpected.push(r.request().method()+" "+u.href); return r.abort();
    }
    if(p==="/buzzy/library") {
      await beforeLibrary(u.searchParams.get("job"));
      return r.fulfill({contentType:"text/html;charset=utf-8",body:library});
    }
    if(p==="/buzzy/talk") return r.fulfill({contentType:"text/html",body:'<!doctype html><title>Fixture Talk</title><header><nav id="bzNav"></nav></header><main><a id="openFolderB" href="/buzzy/library?job=fixture_b">Open saved folder B</a></main>'});
    if(p==="/api/buzzy/library-vault") {
      calls.push(u.search);
      return u.searchParams.has("metadata")?json(r,metadata):onList(r,++lists);
    }
    if(p==="/api/auth/get-session") return json(r,identity);
    if(p==="/api/buzzy/jobs") return json(r,{jobs:serverJobs});
    if(p==="/api/buzzy/assets") return json(r,{assets:[]});
    if(p==="/api/buzzy/entitlement" || p==="/api/wallet") return json(r,{error:"No billing in this fixture"},503);
    if(p.startsWith("/buzzy/")) {
      const n=p.slice(7);
      if(inputs[n]) return r.fulfill({contentType:n.endsWith(".js")?"text/javascript":"text/css",body:inputs[n]});
      if(["companies.js","sow-pdf.js","chat.js"].includes(n)) return r.fulfill({contentType:"text/javascript",body:"/* inert unrelated fixture */"});
      if(["sow.css"].includes(n) || n.startsWith("brand/")) return r.fulfill({status:204});
    }
    if(p==="/favicon.ico") return r.fulfill({status:204});
    unexpected.push(p);return r.abort();
  });
  const page=await context.newPage();
  page.setDefaultTimeout(1600);
  page.on("pageerror",error=>errors.push(error.message));
  t.after(()=>{assert.deepEqual(unexpected,[],"no live or unexpected request");assert.deepEqual(errors,[],"no uncaught renderer errors");});
  return {page,calls};
}
const failed = r => json(r,{ok:false,error:"generic synthetic read failure"},503);

test("late cold folder read does not look empty; settled failure offers same-folder retry",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1){entered.done();await gate.promise;return failed(r);}
    return pageRows(r);
  });
  const url=origin+"/buzzy/library?job=fixture_a";
  await page.goto(url);
  await entered.promise;
  await page.locator(".doclist").waitFor();
  assert.match(await page.locator(".doclist").textContent(),/Loading saved documents/);
  assert.doesNotMatch(await page.locator(".doclist").textContent(),/No documents/);
  gate.done();
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  await retry.waitFor();
  assert.match(await page.locator(".doclist").textContent(),/couldn.t be loaded/i);
  assert.doesNotMatch(await page.locator(".doclist").textContent(),/No documents/);
  await retry.click();
  await page.getByRole("button",{name:"Open",exact:true}).first().waitFor();
  assert.equal(await page.getByRole("button",{name:"Open",exact:true}).count(),2);
  await page.getByRole("button",{name:"Open",exact:true}).nth(1).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Second version in folder A");
  assert.equal(page.url(),url);
  assert.equal(calls.length,4);
});

test("a verified empty folder uses the ordinary empty state with no retry",{timeout:12000},async t=>{
  const {page,calls}=await fixture(t,r=>pageRows(r,[]));
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByText("No documents in this folder yet.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Retry loading documents"}).count(),0);
  assert.equal(calls.length,2);
});

test("retry after cold grid failure updates the current mounted folder, not the old link",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1)return failed(r);
    entered.done();await gate.promise;return pageRows(r);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByRole("button",{name:"Retry loading documents"}).click();
  await entered.promise;
  await page.locator("#docsBackFolders").click();
  assert.equal(await page.locator(".doclist").count(),0);
  assert.match(await page.locator(".docs-folders:not(#serverFiles)").textContent(),/Loading saved documents/);
  gate.done();
  await page.locator('[data-folder="fixture_b"]').click();
  await page.getByRole("button",{name:"Open",exact:true}).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Separate folder B document");
  assert.equal(calls.length,4);
});

test("warm failure keeps available history and a late refresh keeps the newly selected version",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1)return pageRows(r);
    if(i===2)return failed(r);
    entered.done();await gate.promise;
    return pageRows(r,[...reports,{jobId:"fixture_a",document:{name:"same.md",md:"Third version in folder A",createdAt:4}}]);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const open=page.getByRole("button",{name:"Open",exact:true});
  await open.nth(1).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Second version in folder A");
  // Invoke the same existing client operation the desktop resumes, not a new transport.
  await page.evaluate(()=>window.BeeZillaLibraryVault.refresh().catch(()=>{}));
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  await retry.waitFor();
  assert.equal(await page.locator(".docviewer").textContent(),"Second version in folder A");
  await retry.evaluate(button=>{button.click();button.click();});
  await entered.promise;
  await page.locator("#docsBackList").click();
  await open.nth(0).click();
  assert.equal(await page.locator(".docviewer").textContent(),"First version in folder A");
  gate.done();
  await page.waitForFunction(()=>window.BeeZillaLibraryVault.load().fixture_a.length===3);
  assert.equal(await page.locator(".docviewer").textContent(),"First version in folder A");
  assert.equal(await retry.count(),0);
  assert.equal(calls.length,6,"duplicate activation does not schedule an extra refresh");
});

test("an old retry completes into the current Library page after normal Talk navigation",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1)return failed(r);
    entered.done();await gate.promise;return pageRows(r);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const oldRetry=await page.getByRole("button",{name:"Retry loading documents"}).elementHandle();
  await oldRetry.click();
  await entered.promise;
  await page.locator('#bzNav a[data-nav="talk"]').click();
  await page.locator("#openFolderB").click();
  await page.getByRole("heading",{name:"Fixture B",exact:true}).waitFor();
  assert.equal(await oldRetry.evaluate(button=>button.isConnected),false);
  gate.done();
  await page.getByRole("button",{name:"Open",exact:true}).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Separate folder B document");
  await oldRetry.evaluate(button=>button.click());
  assert.equal(page.url(),origin+"/buzzy/library?job=fixture_b");
  assert.equal(calls.length,4);
});

test("ordinary hosted empty view stays unchanged and makes no vault calls",{timeout:12000},async t=>{
  const {page,calls}=await fixture(t,r=>pageRows(r),{desktop:false});
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByText("No documents in this folder yet.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Retry loading documents"}).count(),0);
  assert.deepEqual(calls,[]);
});

test("Retry belongs to the current Library mount and entry even before the shell replaces old DOM",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,(r,i)=>i===1?failed(r):pageRows(r),{
    beforeLibrary(id){ if(id==="fixture_b"){entered.done();return gate.promise;} }
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  const prior=await retry.elementHandle();
  await page.locator("#app").evaluate(app=>{
    const link=document.createElement("a");
    link.id="fixtureOpenNext";
    link.href="/buzzy/library?job=fixture_b";
    link.textContent="Open fixture folder B";
    app.append(link);
  });
  await page.locator("#fixtureOpenNext").click();
  await entered.promise;
  assert.equal(page.url(),origin+"/buzzy/library?job=fixture_b");
  assert.equal(await prior.evaluate(button=>button.isConnected),true,"old DOM still mounted while next entry waits");
  await prior.evaluate(button=>button.click());
  assert.equal(await page.evaluate(()=>window.BeeZillaLibraryVault.status().readState),"failed","old control must not start a refresh");
  gate.done();
  await page.getByRole("heading",{name:"Fixture B",exact:true}).waitFor();
  await retry.click();
  await page.getByRole("button",{name:"Open",exact:true}).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Separate folder B document");
  assert.equal(calls.length,4);
});

test("runtime freeze hides Retry and does not let the old button start a read",{timeout:12000},async t=>{
  const {page,calls}=await fixture(t,r=>failed(r));
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  const button=await retry.elementHandle();
  await page.evaluate(()=>window.BeeZillaLibraryVault.freeze());
  assert.equal(await retry.count(),0);
  await button.evaluate(element=>element.click());
  assert.equal(calls.length,2);
  assert.match(await page.locator(".doclist").textContent(),/paused during the runtime transition/);
});

test("a warm empty folder never reports verified current emptiness during a blocked or failed read",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1)return pageRows(r,[]);
    if(i===2){entered.done();await gate.promise;return failed(r);}
    return pageRows(r,[]);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const verifiedEmpty=page.getByText("No documents in this folder yet.",{exact:true});
  await verifiedEmpty.waitFor();
  await page.evaluate(()=>{void window.BeeZillaLibraryVault.refresh().catch(()=>{});});
  await entered.promise;
  assert.equal(await verifiedEmpty.count(),0);
  assert.match(await page.locator(".doclist").textContent(),/Loading saved documents/);
  gate.done();
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  await retry.waitFor();
  assert.equal(await verifiedEmpty.count(),0);
  assert.match(await page.locator(".doclist").textContent(),/couldn.t be loaded/i);
  await retry.click();
  await verifiedEmpty.waitFor();
  assert.equal(calls.length,6);
});

test("manual Retry is a document read only, preserves recovery copies and creates no derived draft",{timeout:12000},async t=>{
  const derivable = "A synthetic job draft that the normal archive pass could materialize.";
  const serverJobs = [{...jobs[0],data:{draftText:derivable,version:4}},jobs[1]];
  const {page,calls}=await fixture(t,(r,i)=>i===1?failed(r):pageRows(r),{serverJobs});
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  await retry.waitFor();
  const keys={
    bz_docs_v1:JSON.stringify({fixture_a:[{name:"legacy.md",md:"intact unsynced legacy copy"}]}),
    "bz_docs_v2_pending:fixture":JSON.stringify({
      version:1,storeId:metadata.storeId,generation:metadata.generation,
      record:{jobId:"fixture_a",document:{name:"pending.md",md:"intact pending recovery copy"}}
    })
  };
  await page.evaluate(entries=>Object.entries(entries).forEach(([key,value])=>localStorage.setItem(key,value)),keys);
  await retry.click();
  await page.getByText("pending.md",{exact:true}).waitFor();
  assert.equal(await page.getByText("same.md",{exact:true}).count(),2);
  assert.equal(await page.getByText("legacy.md",{exact:true}).count(),0,"never turn unimported legacy into saved rows");
  assert.equal(await page.getByText("fixture-a-v4.md",{exact:true}).count(),0);
  assert.doesNotMatch(await page.locator(".doclist").textContent(),new RegExp(derivable));
  const preserved=await page.evaluate(names=>Object.fromEntries(names.map(name=>[name,localStorage.getItem(name)])),Object.keys(keys));
  assert.deepEqual(preserved,keys);
  assert.deepEqual(calls,["?metadata=1","?after=0&limit=50","?metadata=1","?after=0&limit=50"]);
});

test("read-only retry still rejects a response from a different storage generation",{timeout:12000},async t=>{
  const {page,calls}=await fixture(t,(r,i)=>{
    if(i===1)return failed(r);
    if(i===2)return json(r,{...metadata,generation:"1",records:reports,done:true});
    return pageRows(r);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  const retry=page.getByRole("button",{name:"Retry loading documents"});
  await retry.click();
  await page.getByText("The local Library changed while history was loading. Retry.",{exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Open",exact:true}).count(),0);
  assert.match(await page.locator(".doclist").textContent(),/couldn.t be loaded/i);
  await retry.click();
  await page.getByRole("button",{name:"Open",exact:true}).nth(1).click();
  assert.equal(await page.locator(".docviewer").textContent(),"Second version in folder A");
  assert.equal(calls.length,6);
});

test("freezing a pending read-only retry leaves its returned history uncommitted",{timeout:12000},async t=>{
  const gate=handoff(), entered=handoff();
  t.after(gate.done);
  const {page,calls}=await fixture(t,async(r,i)=>{
    if(i===1)return failed(r);
    entered.done();await gate.promise;return pageRows(r);
  });
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByRole("button",{name:"Retry loading documents"}).click();
  await entered.promise;
  await page.evaluate(()=>window.BeeZillaLibraryVault.freeze());
  gate.done();
  await page.waitForFunction(()=>window.BeeZillaLibraryVault.status().readState==="failed");
  assert.equal(await page.getByRole("button",{name:"Open",exact:true}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Retry loading documents"}).count(),0);
  assert.match(await page.locator(".doclist").textContent(),/paused during the runtime transition/);
  assert.equal(calls.length,4);
});

test("a warm vault refresh preserves an open version's selection, scroll, and keyboard focus",{timeout:12000},async t=>{
  const longText=Array.from({length:120},(_,i)=>"Fixture draft line "+i).join("\n");
  const selected={jobId:"fixture_a",document:{name:"same.md",md:longText,createdAt:3}};
  const {page,calls}=await fixture(t,(r,i)=>pageRows(r,i===1?[reports[0],selected]:[
    reports[0],selected,{jobId:"fixture_a",document:{name:"same.md",md:"New version",createdAt:4}}
  ]));
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByRole("button",{name:"Open",exact:true}).nth(1).click();
  const anchor=await page.locator(".docviewer").elementHandle();
  await page.evaluate(()=>{
    const viewer=document.querySelector(".docviewer"), text=viewer.firstChild, range=document.createRange();
    viewer.style.maxHeight="160px"; viewer.style.overflow="auto";
    document.querySelector("#docCopy").focus();
    range.setStart(text,0);range.setEnd(text,12);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    viewer.scrollTop=300;
  });
  const before=await page.evaluate(()=>({
    selected:window.getSelection().toString(), y:document.querySelector(".docviewer").scrollTop,
    focused:document.activeElement.id
  }));
  assert.deepEqual(before,{selected:"Fixture draf",y:300,focused:"docCopy"});
  await page.evaluate(()=>window.BeeZillaLibraryVault.refresh());
  assert.equal(await page.locator(".docviewer").textContent(),longText);
  assert.equal(await anchor.evaluate(viewer=>viewer===document.querySelector(".docviewer")),true,"warm sync must not replace the current version's viewer");
  assert.deepEqual(await page.evaluate(()=>({
    selected:window.getSelection().toString(), y:document.querySelector(".docviewer").scrollTop,
    focused:document.activeElement.id
  })),before);
  await page.locator("#docsBackList").click();
  await page.getByRole("button",{name:"Open",exact:true}).nth(2).click();
  assert.equal(await page.locator(".docviewer").textContent(),"New version");
  assert.equal(calls.length,4);
});

test("a refreshed snapshot without the open version drops that viewer",{timeout:12000},async t=>{
  const {page,calls}=await fixture(t,(r,i)=>pageRows(r,i===1?reports:[reports[0],reports[2]]));
  await page.goto(origin+"/buzzy/library?job=fixture_a");
  await page.getByRole("button",{name:"Open",exact:true}).nth(1).click();
  const anchor=await page.locator(".docviewer").elementHandle();
  assert.equal(await anchor.textContent(),"Second version in folder A");
  await page.evaluate(()=>window.BeeZillaLibraryVault.refresh());
  assert.equal(await anchor.evaluate(viewer=>viewer.isConnected),false);
  assert.equal(await page.locator(".docviewer").count(),0);
  await page.getByRole("button",{name:"Open",exact:true}).click();
  assert.equal(await page.locator(".docviewer").textContent(),"First version in folder A");
  assert.equal(calls.length,4);
});
