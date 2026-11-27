// Execute the real parity CLI module against file fixtures. Only git metadata
// and process.exit are intercepted. No subprocess, listener or native launch.
// Requires Node 22+ with --experimental-vm-modules.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const script = fs.readFileSync(new URL('./parity-check.mjs', import.meta.url), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Bee Zilla #% Ø-'));
const registerDir = path.join(root, 'docs', 'parity');
fs.mkdirSync(registerDir, { recursive: true });
const register = path.join(registerDir, 'functions.json');
fs.writeFileSync(register, '{"functions":[]}');
const shapes = new Map(Object.entries({
  'node:fs': fs, 'node:os': os, 'node:path': path, 'node:url': url,
  'node:child_process': { execFileSync() { return 'fixture'; } },
}));

async function cli(...args) {
  const lines = [];
  const identifier = url.pathToFileURL(path.join(root, 'scripts', 'parity-check.mjs')).href;
  const stopped = new Error('CLI exit');
  let code;
  const context = vm.createContext({ URL, console: { log: (...m) => lines.push(m.join(' ')), error: (...m) => lines.push(m.join(' ')) },
    process: { argv: ['node', identifier, ...(args.includes('--web') ? [] : ['--web',root]), ...(args.includes('--desktop') ? [] : ['--desktop',root]), ...args], exit: c => { code = c; throw stopped; } } });
  const entry = new vm.SourceTextModule(script, { context, identifier, initializeImportMeta(meta) { meta.url = identifier; } });
  const modules = new Map();
  await entry.link(spec => {
    if (modules.has(spec)) return modules.get(spec);
    const dep = shapes.get(spec); assert.ok(dep, spec);
    const keys = Object.keys(dep);
    const module = new vm.SyntheticModule(keys, function() { for (const k of keys) this.setExport(k, dep[k]); }, { context });
    modules.set(spec, module); return module;
  });
  await assert.rejects(entry.evaluate(), e => e === stopped);
  return { code, lines: lines.join('\n') };
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
test('implicit register lives in real checkout, even with space, percent escapes, hash and non-ASCII', async () => {
  const r = await cli(); assert.equal(r.code, 0, r.lines);
  assert.match(r.lines, /RESULT: PASS/);
});
test('explicit absent --bundle must not silently become source-only PASS', async () => {
  const r = await cli('--register', register, '--bundle', path.join(root, 'missing bundle'));
  assert.equal(r.code, 2, r.lines); assert.doesNotMatch(r.lines, /RESULT: PASS/);
});
test('explicit --bundle with no value fails', async () => { assert.equal((await cli('--register', register, '--bundle')).code, 2); });
test('explicit --bundle pointing to a file fails', async () => { assert.equal((await cli('--register', register, '--bundle', register)).code, 2); });
test('explicit empty directory is not a runtime tree', async () => {
  const dir = path.join(root, 'empty'); fs.mkdirSync(dir);
  assert.equal((await cli('--register', register, '--bundle', dir)).code, 2);
});
test('directory-shaped shells cannot stand in for a staged runtime', async () => {
  const dir = path.join(root, 'empty-tree');
  for (const name of ['public/buzzy', 'migrations', '.output/server']) fs.mkdirSync(path.join(dir,name),{recursive:true});
  assert.equal((await cli('--register', register, '--bundle', dir)).code, 2);
});
function makeBundle(name) {
  const bundle = path.join(root, name);
  for (const dir of ['public/buzzy', 'migrations', '.output/server']) fs.mkdirSync(path.join(bundle, dir), { recursive: true });
  for (const rel of ['public/buzzy/talk.html', 'migrations/001_test.sql', '.output/server/index.mjs']) fs.writeFileSync(path.join(bundle,rel),'fixture');
  return bundle;
}
test('explicit runtime directory still gets bundle reporting', async () => {
  const r = await cli('--register', register, '--bundle', makeBundle('valid'));
  assert.equal(r.code, 0, r.lines); assert.match(r.lines, /INSTALLED BUNDLE/);
});
test('valid package shape cannot hide pages and migrations absent from the bundle', async () => {
  const desk = path.join(root,'new desktop'); fs.mkdirSync(path.join(desk, 'public/buzzy'),{recursive:true});
  fs.mkdirSync(path.join(desk,'migrations')); fs.writeFileSync(path.join(desk,'public/buzzy/new.html'),'fixture');
  fs.writeFileSync(path.join(desk,'migrations/002_new.sql'),'fixture');
  const r = await cli('--register', register, '--web', desk, '--desktop', desk, '--bundle', makeBundle('stale'));
  assert.equal(r.code,1); assert.match(r.lines,/installed bundle is behind/);
});
test('source-only --inventory is still usable but cannot silently ignore explicit --bundle', async () => {
  assert.equal((await cli('--inventory')).code,0);
  assert.equal((await cli('--inventory','--bundle',makeBundle('ignored-before'))).code,2);
});

function makePageSource(name, handler, allowlist) {
  const dir = path.join(root, name);
  for (const rel of ['src/lib/buzzy', 'public/buzzy', 'migrations']) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/lib/buzzy/pages.nitro.ts'), handler);
  if (allowlist !== undefined) fs.writeFileSync(path.join(dir, 'src/lib/buzzy/page-alias.ts'), allowlist);
  for (const page of ['talk', 'library']) fs.writeFileSync(path.join(dir, 'public/buzzy', page + '.html'), 'exact source page');
  fs.writeFileSync(path.join(dir, 'migrations/001_test.sql'), 'current source migration');
  return dir;
}
test('current imported allowlist is recognized without evaluating the evidence source', async () => {
  const dir = makePageSource(
    'imported',
    'import { BUZZY_PAGE_NAMES, htmlAliasLocation } from "./page-alias";\nconst PAGES = new Set<string>(BUZZY_PAGE_NAMES);',
    'export const BUZZY_PAGE_NAMES = Object.freeze([\n  "talk", "library",\n] as const);\nthrow new Error("do not import this file");',
  );
  const inv = await cli('--web', dir, '--desktop', dir, '--inventory');
  assert.deepEqual(JSON.parse(inv.lines).desktop.pageSet, ['library', 'talk']);
  const r = await cli('--web', dir, '--desktop', dir);
  assert.equal(r.code, 0, r.lines);
  assert.doesNotMatch(r.lines, /WARN.*page/);
});
test('inline legacy list still finds a genuinely missing declaration', async () => {
  const dir = makePageSource('legacy', 'const PAGES = new Set(["talk"]);');
  const inv = await cli('--web', dir, '--desktop', dir, '--inventory');
  assert.deepEqual(JSON.parse(inv.lines).desktop.unroutable, ['library']);
  const r = await cli('--web', dir, '--desktop', dir);
  assert.match(r.lines, /WARN.*library.html exists but is not in the BeeZilla page allowlist/);
  assert.doesNotMatch(r.lines, /WARN.*talk.html/);
});
test('unsupported or missing page list is unknown, not an invented 404', async () => {
  const dir = makePageSource('unknown', 'const PAGES = new Set(resolveFromBuild());');
  const r = await cli('--web', dir, '--desktop', dir);
  assert.match(r.lines, /WARN.*allowlist unavailable or unrecognized/);
  assert.doesNotMatch(r.lines, /will 404|reachable only as a static file|talk.html exists but is not/);
});
test('a saved revision with correct filenames is labeled layout-only, never revision-verified', async () => {
  const dir = makePageSource('expected-source', 'const PAGES = new Set(["talk", "library"]);');
  const bundle = makeBundle('other-revision-same-layout');
  fs.writeFileSync(path.join(bundle, 'public/buzzy/library.html'), 'old revision page');
  assert.notDeepEqual(fs.readFileSync(path.join(dir, 'public/buzzy/talk.html')), fs.readFileSync(path.join(bundle, 'public/buzzy/talk.html')));
  const report = path.join(root, 'comparison.json');
  const source = await cli('--web', dir, '--desktop', dir, '--json', report);
  assert.equal(source.code, 0, source.lines);
  const src = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(src.bundle, null);
  const compared = await cli('--web', dir, '--desktop', dir, '--bundle', bundle, '--json', report);
  assert.equal(compared.code, 0, compared.lines);
  const data = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual(data.bundle.stalePages, []);
  assert.deepEqual(data.bundle.staleMigrations, []);
  assert.match(compared.lines, /layout only; revision not verified/);
  assert.equal(src.evidenceScope, 'source-only');
  assert.equal(data.evidenceScope, 'source-and-runtime-layout');
});
