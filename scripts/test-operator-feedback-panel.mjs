import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import ts from "typescript";
import { build } from "vite";
import { chromium } from "playwright";

const repo = resolve(import.meta.dirname, "..");
const src = resolve(process.argv[2] ?? repo);
const entry = resolve(repo, "scripts/operator-feedback-fixture.virtual.mjs");
const api = "virtual:operator-feedback-fixture-api";

let browser;
let browserBundle;
before(async () => {
  // Real JSX, React, icons and button dependencies. Only the operator API is
  // redirected, to synthetic reads/writes controlled separately per test.
  const out = await build({
    configFile: false, root: repo, publicDir: false, logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: {
      "@/lib/api-client": api,
      "@/lib/utils": resolve(src, "src/lib/utils.ts"),
      "@/components/ui/button": resolve(src, "src/components/ui/button.tsx"),
    } },
    build: { write: false, minify: false, lib: { entry, name: "operatorFixture", formats: ["iife"] } },
    plugins: [{
      name: "exact-operator-panel-fixture", enforce: "pre",
      resolveId(id) { if (id === entry || id === api) return "\0" + id; },
      load(id) {
        if (id === "\0" + entry) return `
          import { createElement } from "react";
          import { createRoot } from "react-dom/client";
          import { FeedbackPanel } from ${JSON.stringify(resolve(src,"src/components/feedback-panel.tsx"))};
          createRoot(document.getElementById("root")).render(createElement(FeedbackPanel));`;
        if (id === "\0" + api) return `
          export const agentApi = {
            listFeedback: (params) => window.operatorFixture.read(params),
            updateFeedback: (ref,patch) => window.operatorFixture.save(ref,patch),
          };`;
      },
      transform(code, id) {
        if (id.startsWith(src + "/") && id.endsWith(".tsx"))
          return ts.transpileModule(code,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX, target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext}}).outputText;
      },
    }],
  });
  browserBundle = (Array.isArray(out) ? out : [out]).flatMap(x=>x.output).find(x=>x.type==="chunk"&&x.isEntry).code;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    chromiumSandbox: true, headless: true, args: ["--enable-automation", "--disable-gpu"],
  });
  const cdp = await browser.newBrowserCDPSession();
  const {arguments:argv} = await cdp.send("Browser.getBrowserCommandLine");
  assert.equal(argv.includes("--no-sandbox"),false);
  assert.equal(argv.includes("--disable-seccomp-filter-sandbox"),false);
  await cdp.detach();
});
after(async () => browser?.close());

const newer = {ref:"BZ-FB-NEWNEW", status:"new", body:"Synthetic new report.",
  created_at:"2026-11-27T00:00:00.000Z",user_id:null,route:"fixture",page_url:"/fixture",
  app_sha:null,diag:null,diag_redactions:0,admin_note:null,ip_hash:null,ua:null,
  updated_at:"2026-11-27T00:00:00.000Z"};
const fixed = {...newer, ref:"BZ-FB-FXDFXD", status:"fixed", body:"Synthetic fixed report."};
const deny = "Synthetic operator is not authorized to read feedback.";
async function launch(t) {
  const page=await browser.newPage();
  page.setDefaultTimeout(3000);
  t.after(() => page.close());
  await page.route("**/*",route=>route.abort());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const reads=[], saves=[];
    const deferred=(items, args)=>new Promise((resolve,reject)=>items.push({...args,resolve,reject}));
    window.operatorFixture={
      read(params){return deferred(reads,{params});},
      save(ref,patch){return deferred(saves,{ref,patch});},
      allReads(){return reads.map(x=>x.params);},
      allSaves(){return saves.map(x=>({ref:x.ref,patch:x.patch}));},
      resolve(n,feedback){reads[n].resolve({ok:true,feedback,next_before:null});},
      envelope(n,body){reads[n].resolve(body);},
      reject(n,message){reads[n].reject(new Error(message));},
      saved(n){saves[n].resolve({ok:true});},
    };
  });
  await page.addScriptTag({content:browserBundle});
  const filter=page.locator("select");
  const waitReads=n=>page.waitForFunction(n=>window.operatorFixture.allReads().length>=n,n);
  const repaint=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const resolveRows=async(n,rows)=>{await page.evaluate(([n,rows])=>window.operatorFixture.resolve(n,rows),[n,rows]);await repaint();};
  const rejectRead=async(n,message)=>{await page.evaluate(([n,message])=>window.operatorFixture.reject(n,message),[n,message]);await repaint();};
  const select=async(value,count)=>{await filter.selectOption(value);await waitReads(count);};
  const row=ref=>page.locator("button").filter({hasText:ref});
  await waitReads(1);
  return {page,filter,row,waitReads,repaint,resolveRows,rejectRead,select};
}

test("valid operator read shows its report and enables its details", async t => {
  const q=await launch(t);
  await q.resolveRows(0,[newer]);
  assert.equal(await q.row(newer.ref).count(),1);
  assert.equal(await q.page.getByPlaceholder("Admin note (internal)").count(),1);
});
test("a slow earlier status response must not replace the selected newer filter", async t => {
  const q=await launch(t);
  await q.select("fixed",2);
  await q.resolveRows(1,[fixed]);
  assert.equal(await q.row(fixed.ref).count(),1);
  await q.resolveRows(0,[newer]);
  assert.equal(await q.filter.inputValue(),"fixed");
  assert.equal(await q.row(fixed.ref).count(),1);
  assert.equal(await q.row(newer.ref).count(),0);
});
test("changing the filter clears mismatched rows and actions while loading", async t => {
  const q=await launch(t);
  await q.resolveRows(0,[newer]);
  assert.equal(await q.row(newer.ref).count(),1);
  await q.select("fixed",2);
  assert.equal(await q.row(newer.ref).count(),0);
  assert.equal(await q.page.getByPlaceholder("Admin note (internal)").count(),0);
  assert.match(await q.page.getByRole("status").textContent(),/Loading feedback/);
});
test("an earlier denied response cannot stamp an error over current successful results", async t => {
  const q=await launch(t);
  await q.select("fixed",2);
  await q.resolveRows(1,[fixed]);
  await q.rejectRead(0,deny);
  assert.equal(await q.row(fixed.ref).count(),1);
  assert.equal(await q.page.getByText(deny).count(),0);
});
test("permission failure is not an empty inbox", async t => {
  const q=await launch(t);
  await q.rejectRead(0,deny);
  assert.equal(await q.page.getByText(deny).count(),1);
  assert.equal(await q.page.getByText("No feedback yet.").count(),0);
  assert.equal(await q.page.getByRole("alert").count(),1);
});
test("refresh denied after a previous allowed read clears obsolete rows and actions", async t => {
  const q=await launch(t);
  await q.resolveRows(0,[newer]);
  await q.page.getByRole("button",{name:"Refresh"}).click();
  await q.waitReads(2);
  await q.rejectRead(1,deny);
  assert.equal(await q.page.getByText(deny).count(),1);
  assert.equal(await q.row(newer.ref).count(),0);
  assert.equal(await q.page.getByPlaceholder("Admin note (internal)").count(),0);
});
test("empty successful filtered results do not read as an empty site-wide inbox", async t => {
  const q=await launch(t);
  await q.select("fixed",2);
  await q.resolveRows(1,[]);
  assert.equal(await q.page.getByText("No feedback matches this status.").count(),1);
  assert.equal(await q.page.getByText("No feedback yet.").count(),0);
});
test("a prior status update reloads the latest filter, not the old closure", async t => {
  const q=await launch(t);
  await q.select("new",2);
  await q.resolveRows(1,[newer]);
  await q.page.getByRole("button",{name:"triaged",exact:true}).click();
  assert.deepEqual(await q.page.evaluate(()=>window.operatorFixture.allSaves()),[{ref:newer.ref,patch:{status:"triaged"}}]);
  await q.select("fixed",3);
  await q.resolveRows(2,[fixed]);
  await q.page.evaluate(()=>window.operatorFixture.saved(0));
  await q.waitReads(4);
  assert.equal((await q.page.evaluate(()=>window.operatorFixture.allReads())).at(-1).status,"fixed");
});

for (const [name,envelope] of [
  ["missing feedback array",{ok:true}],
  ["non-array feedback",{ok:true,feedback:{rows:[newer]}}],
  ["truthy nonboolean ok",{ok:"true",feedback:[]}],
  ["missing ok",{feedback:[]}],
  ["null envelope",null],
  ["invalid row member",{ok:true,feedback:[null]}],
  ["non-renderable row field",{ok:true,feedback:[{...newer,body:{text:"fixture"}}]}],
]) {
  test(`a malformed 200 (${name}) fails closed after originally valid rows rather than crashing or saying empty`, async t => {
    const q=await launch(t);
    const crashes=[];
    q.page.on("pageerror", e=>crashes.push(e.message));
    await q.resolveRows(0,[newer]);
    assert.equal(await q.row(newer.ref).count(),1);
    await q.page.getByRole("button",{name:"Refresh"}).click();
    await q.waitReads(2);
    await q.page.evaluate(envelope=>window.operatorFixture.envelope(1,envelope),envelope);
    await q.repaint();
    assert.deepEqual(crashes,[], "invalid response must not reach a React render");
    assert.equal(await q.page.getByRole("alert").count(),1);
    assert.equal(await q.page.getByRole("alert").textContent(),"Could not load feedback: invalid response.");
    assert.equal(await q.page.getByText("No feedback yet.").count(),0);
    assert.equal(await q.row(newer.ref).count(),0);
    assert.equal(await q.page.getByPlaceholder("Admin note (internal)").count(),0);
    assert.equal(await q.page.getByRole("button",{name:"Refresh"}).count(),1,"panel remains available for a later retry");
  });
}

const boundary = newer.created_at;
const fullPage = (status = "new") => Array.from({ length: 100 }, (_, index) => ({
  ...newer, ref: "synthetic-report-" + (index + 1), status,
}));
const capText = /Older reports may not be shown in this view/i;
async function resolvePage(q, request, feedback, next_before) {
  await q.page.evaluate(([n, payload]) => window.operatorFixture.envelope(n,payload),
    [request, { ok: true, feedback, ...(next_before === undefined ? {} : { next_before }) }]);
  await q.repaint();
}

test("a full valid page warns that older reports may not be shown; filter change retires it", async t => {
  const q=await launch(t);
  assert.equal((await q.page.evaluate(()=>window.operatorFixture.allReads()))[0].limit,100);
  await resolvePage(q,0,fullPage(),boundary);
  assert.equal(await q.row("synthetic-report-100").count(),1);
  assert.match(await q.page.getByText(capText).textContent(),/newest 100 reports/i);
  await q.select("fixed",2);
  assert.equal(await q.page.getByText(capText).count(),0,"old cap cannot describe the new filter");
  await resolvePage(q,1,fullPage("fixed"),boundary);
  assert.match(await q.page.getByText(capText).textContent(),/newest 100 matching reports/i);
  await q.select("new",3);
  await resolvePage(q,2,fullPage().slice(0,99),null);
  assert.equal(await q.page.getByText(capText).count(),0,"a valid 99-row result has no cap warning");
  assert.equal(await q.row("synthetic-report-99").count(),1);
});

test("a stale full first page cannot attach a warning to a different filter", async t => {
  const q=await launch(t);
  await q.select("fixed",2);
  await q.resolveRows(1,[fixed]);
  await resolvePage(q,0,fullPage(),boundary);
  assert.equal(await q.page.getByText(capText).count(),0);
  assert.equal(await q.row(fixed.ref).count(),1);
});

test("an observed denied refresh removes a previously verified cap warning", async t => {
  const q=await launch(t);
  await resolvePage(q,0,fullPage(),boundary);
  assert.equal(await q.page.getByText(capText).count(),1);
  await q.page.getByRole("button",{name:"Refresh"}).click();
  await q.waitReads(2);
  assert.equal(await q.page.getByText(capText).count(),0,"in-flight refresh must not retain old warning");
  await q.rejectRead(1,deny);
  assert.equal(await q.page.getByText(capText).count(),0);
  assert.equal(await q.page.getByRole("alert").textContent(),deny);
  assert.equal(await q.row("synthetic-report-100").count(),0);
});

for (const [label, rows, cursor, showCap] of [
  ["a full list with no cursor", fullPage(), undefined, true],
  ["a full list with a null cursor", fullPage(), null, true],
  ["a full list with malformed cursor metadata", fullPage(), {unexpected: "fixture"}, true],
  ["a short list with no cursor", [newer], undefined, false],
  ["a short list with unexpected cursor metadata", [newer], boundary, false],
]) test("optional pagination metadata never invalidates valid rows: " + label, async t => {
  const q=await launch(t);
  await resolvePage(q,0,rows,cursor);
  assert.equal(await q.row(rows.at(-1).ref).count(),1);
  assert.equal(await q.page.getByRole("alert").count(),0);
  assert.equal(await q.page.getByText(capText).count(),Number(showCap));
});

test("a malformed current list after a full page removes both warning and stale rows", async t => {
  const q=await launch(t);
  await resolvePage(q,0,fullPage(),boundary);
  await q.page.getByRole("button",{name:"Refresh"}).click();
  await q.waitReads(2);
  await resolvePage(q,1,[...fullPage().slice(0,99),null],boundary);
  assert.equal(await q.page.getByText(capText).count(),0);
  assert.equal(await q.row("synthetic-report-99").count(),0);
  assert.equal(await q.page.getByRole("alert").textContent(),"Could not load feedback: invalid response.");
});
