// Dependency-free static-parser regressions; no application or repository source execution.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const source=fs.readFileSync(path.join(__dirname,'parity-check.mjs'),'utf8');
const start=source.indexOf('function pageSetOf(root)'),end=source.indexOf('\nfunction migrationsOf',start);
assert.ok(start>=0&&end>start);
const context={readFileSync:fs.readFileSync,existsSync:fs.existsSync,join:path.join};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
function fixture(t,handler,aliases){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bz-parity-parser-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'src/lib/buzzy');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'pages.nitro.ts'),handler);if(aliases)fs.writeFileSync(path.join(dir,'page-alias.ts'),aliases);return root;}
function pages(root){return Array.from(context.pageSetOf(root).declared);}
test('literal web page list is retained',t=>{assert.deepEqual(pages(fixture(t,'const PAGES = new Set(["shared", "join", "talk"]);')),['join','shared','talk']);});
test('typed literal page list is retained',t=>{assert.deepEqual(pages(fixture(t,'const PAGES = new Set<string>(["talk"]);')),['talk']);});
test('known imported desktop literal is read without evaluating source',t=>{const root=fixture(t,'import { BUZZY_PAGE_NAMES, htmlAliasLocation } from "./page-alias";\nconst PAGES = new Set<string>(BUZZY_PAGE_NAMES);','export const BUZZY_PAGE_NAMES = Object.freeze(["talk", "settings"] as const);\nthrow new Error("must not execute");');assert.deepEqual(pages(root),['settings','talk']);});
test('unknown computed declaration does not masquerade as zero routes',t=>{assert.throws(()=>pages(fixture(t,'const PAGES = computed();')),/routing parity is unknown/);});
test('missing imported literal fails explicitly',t=>{assert.throws(()=>pages(fixture(t,'import { BUZZY_PAGE_NAMES } from "./page-alias"; const PAGES = new Set(BUZZY_PAGE_NAMES);')),/routing parity is unknown/);});
test('manifest references the actual Library asset without claiming behavioral parity',()=>{const r=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/parity/functions.json')));for(const id of ['nav.canonical','library.documents']){const entry=r.functions.find(f=>f.id===id);for(const side of ['web','desktop']){assert.ok(entry[side].pages.includes('library'));assert.ok(!entry[side].pages.includes('index'));}assert.match(entry.note,/does not establish identical/);}});
