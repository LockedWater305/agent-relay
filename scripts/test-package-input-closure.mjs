/** Synthetic non-native regressions. No app, server, builder, install or live-process inspection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { productionDependencyClosure, copyProductionDependency, ensurePgliteAssets, PGLITE_PAYLOADS } from "../desktop/stage-inputs.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const moneySource = fs.readFileSync(new URL("../src/lib/buzzy/money.ts", import.meta.url), "utf8");
const sourceJs = ts.transpileModule(moneySource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const browserScript = fs.readFileSync(new URL("../public/buzzy/money-check.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
function write(file, bytes) { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "beezilla-input-unit-"));
  const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function json(file, value) { write(file, JSON.stringify(value)); }
function dep(root, name, metadata = {}, prefix = "") {
  const dir = join(root, prefix, "node_modules", name);
  json(join(dir, "package.json"), { name, version: "1.0.0", ...metadata });
  return dir;
}
function layout(t, kind = "source", script = browserScript) {
  const root = fixture(t);
  const base = join(root, "space and 雪");
  const module = kind === "source" ? join(base, "src/lib/buzzy/money.ts")
    : kind === "relocated" ? join(base, "relocated/server/index.mjs")
    : kind === "packaged" ? join(base, "resources/app/.output/server/index.mjs")
    : join(base, ".output/server/index.mjs");
  const anchor = kind === "source" ? base : dirname(dirname(module));
  const asset = join(anchor, "public/buzzy/money-check.js");
  write(module, "// module URL fixture only; no emitted application\n");
  if (script !== null) write(asset, script);
  return { root, base, module, anchor, asset };
}
async function loadMoney(modulePath, options = {}) {
  const reads = [];
  const context = vm.createContext({ URL, process: { cwd: () => process.cwd() } });
  const modules = {
    "node:fs": {
      readFileSync(file, ...args) {
        reads.push(String(file));
        if (options.failRead) throw Object.assign(new Error("synthetic read denial"), { code: "EACCES" });
        return fs.readFileSync(file, ...args);
      }, realpathSync: fs.realpathSync, statSync: fs.statSync,
    },
    "node:path": await import("node:path"), "node:url": await import("node:url"),
    "node:vm": { runInNewContext: vm.runInNewContext },
  };
  const subject = new vm.SourceTextModule(sourceJs, { context,
    identifier: pathToFileURL(modulePath).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(modulePath).href; } });
  await subject.link(specifier => {
    assert.ok(Object.hasOwn(modules, specifier), `unexpected product import: ${specifier}`);
    const values = modules[specifier], names = Object.keys(values);
    return new vm.SyntheticModule(names, function () { for (const key of names) this.setExport(key, values[key]); }, { context });
  });
  await subject.evaluate();
  return { api: subject.namespace, reads };
}
const amount = (value, status = "confirmed") => ({ key: "amount", label: "Amount", value, status });
const inputs = [
  { draft: "The amount is $100.", facts: [amount("$100")] },
  { draft: "The amount is $200.", facts: [amount("$100")] },
  { draft: "The amount is $100.", facts: [amount("$100", "proposed")] },
  { draft: "An agreement without a price.", facts: [amount("", "blank")] },
];

for (const kind of ["source", "bundle", "relocated", "packaged"]) {
  test(`${kind} module layout uses only its anchored public asset with unrelated cwd`, async t => {
    const f = layout(t, kind), unrelated = join(f.root, "unrelated");
    write(join(unrelated, "public/buzzy/money-check.js"), "checkMoney = () => ({items:[], draft:'deceptive'});");
    write(join(f.base, "public/buzzy/deceptive.js"), "not selected");
    process.chdir(unrelated);
    const m = await loadMoney(f.module);
    const expected = {}; vm.runInNewContext(browserScript, expected);
    const value = plain(m.api.checkMoney(inputs[1]));
    assert.deepEqual(value, { ...plain(expected.checkMoney(inputs[1])), blocksApproval: true, draft: inputs[1].draft });
    assert.deepEqual(m.reads, [fs.realpathSync(f.asset)]);
    assert.equal(fileURLToPath(m.api.resolveMoneyCheckAsset(pathToFileURL(f.module).href)), f.asset);
    if (kind === "bundle") assert.equal(fs.existsSync(join(f.base, "public/buzzy/money-check.js")), false, "Docker-like output-only fixture has no root public");
  });
}
test("source resolver is independent of repository, desktop and unrelated cwd", async t => {
  const f = layout(t), m = await loadMoney(f.module);
  for (const cwd of [f.base, join(f.base, "desktop"), join(f.root, "elsewhere")]) {
    fs.mkdirSync(cwd, { recursive: true }); process.chdir(cwd);
    assert.equal(fileURLToPath(m.api.resolveMoneyCheckAsset(pathToFileURL(f.module).href)), f.asset);
  }
  assert.equal(m.reads.length, 0);
});
test("Windows drive and UNC file URLs use the explicit URL layout without cwd", async t => {
  const f = layout(t), m = await loadMoney(f.module);
  assert.equal(m.api.resolveMoneyCheckAsset("file:///C:/space%20and%20%E9%9B%AA/.output/server/index.mjs").href,
    "file:///C:/space%20and%20%E9%9B%AA/.output/public/buzzy/money-check.js");
  assert.equal(m.api.resolveMoneyCheckAsset("file://server/share/src/lib/buzzy/money.ts").href,
    "file://server/share/public/buzzy/money-check.js");
});
test("unknown chunks, filenames, protocols and decorated URLs fail closed", async t => {
  const f = layout(t), m = await loadMoney(f.module);
  for (const url of ["file:///app/server/chunks/money.mjs", "file:///app/src/lib/buzzy/money.js", "file:///app/money.ts",
    "https://example.invalid/server/index.mjs", "file:///app/server/index.mjs?x=1", "file:///app/server/index.mjs#x"]) {
    assert.throws(() => m.api.resolveMoneyCheckAsset(url), /unsupported money check module layout/);
  }
  assert.equal(m.reads.length, 0);
});
test("missing fixed asset does not use deceptive root public or cwd public", async t => {
  const f = layout(t, "bundle", null);
  write(join(f.base, "public/buzzy/money-check.js"), browserScript);
  process.chdir(f.base);
  const m = await loadMoney(f.module);
  assert.throws(() => m.api.checkMoney(inputs[0]), /ENOENT/);
  assert.equal(m.reads.length, 0);
});
for (const mode of ["asset-link", "public-link", "directory"]) {
  test(`${mode} cannot redirect the fixed asset`, async t => {
    const f = layout(t), outside = join(f.root, "outside");
    write(join(outside, "buzzy/money-check.js"), browserScript);
    if (mode === "asset-link") {
      fs.rmSync(f.asset); fs.symlinkSync(join(outside, "buzzy/money-check.js"), f.asset);
    } else if (mode === "public-link") {
      fs.rmSync(join(f.anchor, "public"), { recursive: true }); fs.symlinkSync(outside, join(f.anchor, "public"), "dir");
    } else { fs.rmSync(f.asset); fs.mkdirSync(f.asset); }
    const m = await loadMoney(f.module);
    assert.throws(() => m.api.checkMoney(inputs[0]), /outside its shipped public layout/);
    assert.equal(m.reads.length, 0);
  });
}
test("unreadable fixed asset is a failure, with no clean fallback", async t => {
  const f = layout(t), m = await loadMoney(f.module, { failRead: true });
  assert.throws(() => m.api.checkMoney(inputs[0]), error => error.code === "EACCES");
  assert.equal(m.reads.length, 1);
});
for (const script of ["not valid JavaScript !", "checkMoney = 17;"]) {
  test(`malformed check script cannot produce an accepted verdict: ${script}`, async t => {
    const f = layout(t, "bundle", script), m = await loadMoney(f.module);
    assert.throws(() => m.api.checkMoney(inputs[0]));
    assert.equal(m.reads.length, 1);
  });
}
test("pinned browser/server results retain match, wrong, unconfirmed, blank and exact drafts", async t => {
  const f = layout(t), m = await loadMoney(f.module), browser = {};
  vm.runInNewContext(browserScript, browser);
  const tones = new Set();
  for (const input of inputs) {
    const actual = plain(m.api.checkMoney(input)), expected = plain(browser.checkMoney(input));
    assert.deepEqual(actual.items, expected.items); assert.equal(actual.draft, input.draft);
    assert.equal(actual.blocksApproval, actual.items.some(item => item.tone === "wrong"));
    actual.items.forEach(item => tones.add(item.tone));
  }
  assert.ok(["match", "wrong", "unconfirmed", "blank"].every(tone => tones.has(tone)));
  assert.equal(m.reads.length, 1);
});
test("cache is lazy and local to each fresh module", async t => {
  const f = layout(t), first = await loadMoney(f.module);
  assert.equal(first.reads.length, 0);
  const original = plain(first.api.checkMoney(inputs[0]));
  write(f.asset, "checkMoney = function(input){return {items:[{tone:'wrong',text:'replacement'}],draft:input.draft}};");
  assert.deepEqual(plain(first.api.checkMoney(inputs[0])), original); assert.equal(first.reads.length, 1);
  const second = await loadMoney(f.module);
  assert.equal(second.reads.length, 0); assert.equal(second.api.checkMoney(inputs[0]).items[0].text, "replacement");
  assert.equal(second.reads.length, 1);
});
test("budget logic remains lazy even under an unknown module layout", async t => {
  const root = fixture(t), m = await loadMoney(join(root, "unknown.mjs"));
  for (const [spent, cap, expected] of [[0,0,"allow"],[100,100,"refuse"],[51,100,"ask"],[1,1000,"allow"]]) {
    assert.equal(m.api.budgetVerdict(spent,cap).verdict,expected);
  }
  assert.equal(m.api.defaultAskWithinCents(1000),100); assert.equal(m.reads.length,0);
});

test("required dependency absence rejects", t => {
  const root=fixture(t);json(join(root,"package.json"),{dependencies:{required:"1"}});
  assert.throws(()=>productionDependencyClosure(root),/missing required production dependency required/);
});
test("optional absent edge is recorded; a present optional package needs its own required closure", t => {
  const root=fixture(t);json(join(root,"package.json"),{dependencies:{main:"1"}});
  dep(root,"main",{optionalDependencies:{optional:"1"}});
  let result=productionDependencyClosure(root);assert.equal(result.directories.length,1);assert.equal(result.optionalMissing.length,1);
  dep(root,"optional",{dependencies:{requiredChild:"1"}});
  assert.throws(()=>productionDependencyClosure(root),/requiredChild/);
});
test("required edge cannot be excused by an earlier optional absent edge", t => {
  const root=fixture(t);json(join(root,"package.json"),{dependencies:{a:"1",b:"1"}});
  dep(root,"a",{optionalDependencies:{shared:"1"}});dep(root,"b",{dependencies:{shared:"1"}});
  assert.throws(()=>productionDependencyClosure(root),/missing required.*shared/);
});
for (const mode of ["invalid-required", "invalid-optional", "unreadable-required", "unreadable-optional", "missing-required", "missing-optional", "metadata-directory"]) {
  test(`${mode} metadata fails closure`, t => {
    const root=fixture(t);json(join(root,"package.json"),{dependencies:{main:"1"}});
    const main=dep(root,"main",mode.endsWith("optional")?{optionalDependencies:{child:"1"}}:{dependencies:{child:"1"}});
    const child=dep(root,"child"), metadata=join(child,"package.json");
    if(mode.startsWith("invalid"))write(metadata,"{broken");
    if(mode.startsWith("missing"))fs.rmSync(metadata);
    if(mode==="metadata-directory"){fs.rmSync(metadata);fs.mkdirSync(metadata);}
    if(mode.startsWith("unreadable")) {
      const read=fs.readFileSync;
      t.mock.method(fs,"readFileSync",function(file,...args){if(String(file)===metadata)throw Object.assign(new Error("synthetic metadata denial"),{code:"EACCES"});return read.call(this,file,...args);});
    }
    assert.throws(()=>productionDependencyClosure(root));assert.ok(fs.existsSync(main));
  });
}
test("root optional-only seed policy remains unchanged", t => {
  const root=fixture(t);json(join(root,"package.json"),{dependencies:{main:"1"},optionalDependencies:{cache:"1"}});
  dep(root,"main");dep(root,"cache");
  assert.deepEqual(productionDependencyClosure(root).directories,[join(root,"node_modules/main")]);
});
test("synthetic 475-record graph retains 31 declared optional absences", t => {
  const root=fixture(t);json(join(root,"package.json"),{dependencies:{p0:"1"}});
  for(let i=0;i<475;i++)dep(root,`p${i}`,{...(i<474?{dependencies:{[`p${i+1}`]:"1"}}:{}),...(i<31?{optionalDependencies:{[`absent${i}`]:"1"}}:{})});
  const result=productionDependencyClosure(root);assert.equal(result.directories.length,475);assert.equal(result.optionalMissing.length,31);
});
function copyFixture(t) {
  const root=fixture(t), source=join(root,"inputs"), target=join(root,"copied");
  write(join(source,"package.json"),'{"name":"synthetic"}');write(join(source,"lib/code.js"),"synthetic bytes");
  return {root,source,target};
}
test("complete copies and identical pre-existing nested targets preserve exact bytes", t => {
  const f=copyFixture(t);assert.equal(copyProductionDependency(f.source,f.target),true);
  assert.equal(copyProductionDependency(f.source,f.target),false);
  assert.deepEqual(fs.readFileSync(join(f.target,"lib/code.js")),fs.readFileSync(join(f.source,"lib/code.js")));
});
for(const mode of ["missing","stale","extra","directory","link","dangling-link"]) {
  test(`pre-existing ${mode} target is rejected without overwrite`, t => {
    const f=copyFixture(t);
    if(mode==="link"||mode==="dangling-link")fs.symlinkSync(mode==="link"?f.source:join(f.root,"absent"),f.target,"dir");
    else if(mode==="directory")write(f.target,"not a directory");
    else {fs.cpSync(f.source,f.target,{recursive:true});if(mode==="missing")fs.rmSync(join(f.target,"lib/code.js"));if(mode==="stale")write(join(f.target,"lib/code.js"),"stale");if(mode==="extra")write(join(f.target,"extra"),"unexpected");}
    assert.throws(()=>copyProductionDependency(f.source,f.target));
    assert.equal(fs.readFileSync(join(f.source,"lib/code.js"),"utf8"),"synthetic bytes");
  });
}
for(const partial of [false,true]) {
  test(`copy error ${partial?"after partial bytes":"before bytes"} propagates`, t => {
    const f=copyFixture(t);
    t.mock.method(fs,"cpSync",()=>{if(partial)write(join(f.target,"partial"),"partial");throw new Error("synthetic copy failure");});
    assert.throws(()=>copyProductionDependency(f.source,f.target),/synthetic copy failure/);
    assert.equal(fs.existsSync(join(f.target,"package.json")),false);
  });
}
test("changed source during copy cannot produce accepted target identity", t => {
  const f=copyFixture(t), cp=fs.cpSync;
  t.mock.method(fs,"cpSync",(...args)=>{write(join(f.source,"lib/code.js"),"changed during copy");return cp(...args);});
  assert.throws(()=>copyProductionDependency(f.source,f.target),/does not match/);
});
function payloadFixture(t) {
  const root=fixture(t), app=join(root,"synthetic-runtime"), modules=join(app,"node_modules/@electric-sql/pglite/dist"), libs=join(app,".output/server/_libs");
  fs.mkdirSync(modules,{recursive:true});return {root,app,modules,libs};
}
test("complete module payloads are copied to actual loader layout", t => {
  const f=payloadFixture(t);for(const name of PGLITE_PAYLOADS)write(join(f.modules,name),`synthetic ${name}`);
  ensurePgliteAssets(f.app);for(const name of PGLITE_PAYLOADS)assert.equal(fs.readFileSync(join(f.libs,name),"utf8"),`synthetic ${name}`);
});
test("complete bundled payloads do not require fallback module-directory presence", t => {
  const f=payloadFixture(t);fs.rmSync(f.modules,{recursive:true});for(const name of PGLITE_PAYLOADS)write(join(f.libs,name),name);ensurePgliteAssets(f.app);
});
for(const missing of PGLITE_PAYLOADS) {
  test(`missing ${missing} rejects despite module directory existence`, t => {
    const f=payloadFixture(t);for(const name of PGLITE_PAYLOADS.filter(n=>n!==missing))write(join(f.libs,name),name);
    assert.throws(()=>ensurePgliteAssets(f.app),error=>error.message.includes(missing));
  });
  test(`directory instead of ${missing} rejects`, t => {
    const f=payloadFixture(t);for(const name of PGLITE_PAYLOADS)write(join(f.modules,name),name);fs.mkdirSync(join(f.libs,missing),{recursive:true});
    assert.throws(()=>ensurePgliteAssets(f.app),/not a regular file/);
  });
  test(`symlink instead of ${missing} rejects without following it`, t => {
    const f=payloadFixture(t);for(const name of PGLITE_PAYLOADS)write(join(f.modules,name),name);
    fs.mkdirSync(f.libs,{recursive:true});fs.symlinkSync(join(f.root,"absent"),join(f.libs,missing));
    assert.throws(()=>ensurePgliteAssets(f.app),/not a regular file/);assert.equal(fs.existsSync(join(f.root,"absent")),false);
  });
}
test("all PGlite payloads absent rejects", t => {const f=payloadFixture(t);assert.throws(()=>ensurePgliteAssets(f.app),/missing required PGlite payload/);});
test("PGlite payload copy failure propagates", t => {
  const f=payloadFixture(t);for(const name of PGLITE_PAYLOADS)write(join(f.modules,name),name);
  t.mock.method(fs,"copyFileSync",()=>{throw new Error("synthetic payload copy failure");});assert.throws(()=>ensurePgliteAssets(f.app),/synthetic payload copy failure/);
});
