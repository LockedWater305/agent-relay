// Actual Library goDocs/shelf functions + complete Nitro assets routes and
// emitted SQL in disposable SQLite. DOM/H3/auth are synthetic. No provider,
// network, image/audio/video decoding, native launch or real user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {cleanFilename} from '../src/lib/buzzy/paper.ts';
const ROOT=resolve(process.env.BZ_LIBRARY_ARTIFACT_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(ROOT,p),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
export const tick=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const json=(data,status=200)=>Response.json(data,{status});
const row=(id=11,extra={})=>({id,filename:'Quarterly report.md',content_type:'text/markdown',bytes:42,created_at:'2026-11-16T00:00:00Z',...extra});

export async function backend(t,options={}){
 const db=new DatabaseSync(':memory:'),queries=[],requests=[];let user='owner',forbidden=0;
 db.exec(`CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT);
 CREATE TABLE buzzy_assets(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,filename TEXT,rel_path TEXT,content_type TEXT,bytes INTEGER,created_at TEXT,body BLOB);
 CREATE TABLE unrelated(id TEXT,value TEXT);
 INSERT INTO buzzy_jobs VALUES('job_a','owner','A work'),('job_b','owner','B work'),('job_f','foreign','Foreign work');
 INSERT INTO unrelated VALUES('preserve','Exact café 日本語 & <text>');`);
 const insert=db.prepare('INSERT INTO buzzy_assets VALUES(?,?,?,?,?,?,?,?,?)');
 const seeds=[
  [11,'owner','job_a','Quarterly report.md','a/report.md','text/markdown',42,'2026-11-16',Buffer.from('Synthetic report café 日本語')],
  [12,'owner','job_b','Image metadata','b/image.png','image/png',0,'2026-11-16',Buffer.alloc(0)],
  [13,'owner','job_b','Audio metadata','c/audio.mp3','audio/mpeg',0,'2026-11-16',Buffer.alloc(0)],
  [14,'owner',null,'Video metadata','d/video.mp4','video/mp4',0,'2026-11-16',Buffer.alloc(0)],
  [15,'foreign','job_f','Foreign metadata','e/foreign.md','text/markdown',9,'2026-11-16',Buffer.from('Foreign synthetic text')],
 ];
 for(const seed of seeds)insert.run(...seed);
 const snapshot=()=>plain(['buzzy_assets','buzzy_jobs','unrelated'].map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 const before=snapshot();
 const sql=async(strings,...params)=>{let text=strings[0];params.forEach((_,i)=>text+='$'+(i+1)+strings[i+1]);queries.push({text,params:plain(params)});assert.match(text,/^\s*SELECT/,'read-only asset workflow');return db.prepare(text.replace(/::text/g,'').replace(/\$(\d+)/g,':p$1')).all(Object.fromEntries(params.map((x,i)=>['p'+(i+1),x])));};
 const ctx=vm.createContext({Headers,Buffer,Uint8Array,URLSearchParams});
 const deps={'../runtime':{isLocalRuntime:()=>Boolean(options.local)},h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,getHeader:(e,k)=>e.req.headers.get(k),setResponseStatus:(e,n)=>e.status=n,setResponseHeader:(e,k,v)=>e.headers.set(k,v)},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'@/lib/db':{getSql:async()=>sql},'./paper':{cleanFilename}};
 const source=stripTypeScriptTypes(read('src/lib/buzzy/chat.nitro.ts'));
 const module=new vm.SourceTextModule(source,{context:ctx});
 await module.link(id=>{const declaration=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m=>m[2]===id);assert.ok(declaration,id);const names=declaration[1].split(',').map(x=>x.trim()).filter(Boolean);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[id]?.[name]??(()=>{forbidden++;throw Error('Forbidden dependency '+id+'.'+name);}));},{context:ctx});});
 await module.evaluate();
 const fetch=async(url,init={})=>{assert.match(url,/^\/api\/buzzy\/assets(?:\?[^#]*|\/\d+)?$/);assert.ok(!init.method||init.method==='GET');requests.push({url,init:plain(init)});const e={path:url,status:200,headers:new Headers(),req:new Request('http://synthetic'+url,init)};const result=await module.namespace.default(e);return result instanceof Uint8Array?new Response(result,{status:e.status,headers:e.headers}):json(result,e.status);};
 t.after(()=>{assert.equal(forbidden,0,'zero providers/network/private dependencies');assert.deepEqual(snapshot(),before,'all synthetic raw rows and asset bytes unchanged');db.close();});
 return {fetch,requests,queries,snapshot,user:value=>user=value};
}

class Element{
 constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.parentNode=null;this.style={};this.id='';this.textContent='';this._html='';}
 get isConnected(){return this===this.doc.body||Boolean(this.parentNode?.isConnected);}
 appendChild(node){node.remove();node.parentNode=this;this.children.push(node);return node;}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}}
 set innerHTML(value){this._html=value;for(const child of this.children)child.parentNode=null;this.children=[];for(const m of value.matchAll(/<(div|button)[^>]*\bid=['"]([^'"]+)['"][^>]*>/g)){const child=new Element(m[1],this.doc);child.id=m[2];this.appendChild(child);}}
 get innerHTML(){return this._html;}
 querySelectorAll(){return [];}
 querySelector(){return null;}
}
function extract(source,name){const start=source.indexOf('    function '+name+'(');assert.ok(start>=0,name);const firstEnd=source.indexOf('\n',start);if(name==='escHtml')return source.slice(start,firstEnd);const end=source.indexOf('\n    }',start);assert.ok(end>start,name);return source.slice(start,end+6);}
export function ui(fetcher,options={}){
 const events=new Map(),calls=[],document={};
 document.body=new Element('body',document);
 const app=document.body.appendChild(new Element('main',document));app.id='app';
 document.createElement=tag=>new Element(tag,document);
 document.getElementById=id=>{function find(node){if(node.id===id)return node;for(const c of node.children){const result=find(c);if(result)return result;}return null;}return find(document.body);};
 const location={pathname:'/buzzy/library',search:'',...options.location};
 const window={location,addEventListener(name,fn,opts){if(!events.has(name))events.set(name,[]);events.get(name).push({fn,once:opts?.once});},removeEventListener(name,fn){events.set(name,(events.get(name)||[]).filter(x=>x.fn!==fn));}};
 if(options.local){window.beezilla={};window.BeeZillaLibraryVault={};}
 const fetch=async(url,init)=>{calls.push({url,init});return url.includes('?limit=60')?fetcher(url,init):(options.otherFetch?options.otherFetch(url,init):json({items:[]}));};
 const ctx=vm.createContext({document,window,location,fetch,console,URLSearchParams,catalog:{jobs:[]},state:{screen:'docs'},docsOpenFolder:null,docsOpenDoc:null,docsOpenFromLink:null,showRecoveredFolders:false,setPhase(){},syncJobDocs(){},loadDocs:()=>({}),paintLibrarySync(){},render(){app.innerHTML='Jobs';}});
 const source=read('public/buzzy/library.html'),names=['escHtml','escAttr','goDocs','artifactKind','humanBytes','loadArtifactShelf','renderServerFiles'];
 if(source.includes('    function artifactAssetUrl('))names.push('artifactAssetUrl');
 vm.runInContext(names.map(name=>extract(source,name)).join('\n'),ctx);
 const mount=()=>{ctx.goDocs();return document.getElementById('artifactShelf');};
 const result={ctx,app,document,window,location,calls,mount,emit(name){for(const item of [...events.get(name)||[]]){item.fn();if(item.once)window.removeEventListener(name,item.fn);}},listeners:()=>[...events.values()].reduce((n,list)=>n+list.length,0),navigate(path,search=''){location.pathname=path;location.search=search;},detach(){app.remove();},shelf:()=>document.getElementById('artifactShelf')};
 if(options.mount!==false)result.initial=mount();return result;
}
const urls=html=>[...html.matchAll(/(?:src|href)='([^']*)'/g)].map(m=>m[1]);

test('actual Library grid and owned list route give every shelf card its canonical asset endpoint',async t=>{
 const h=await backend(t),u=ui(h.fetch,{otherFetch:h.fetch});await tick();
 assert.deepEqual(urls(u.shelf().innerHTML),[11,12,13,14].map(id=>'/api/buzzy/assets/'+id));
 assert.match(u.shelf().innerHTML,/<audio controls preload='none'/);assert.match(u.shelf().innerHTML,/<img loading='lazy'/);assert.match(u.shelf().innerHTML,/<video controls preload='none'/);
 assert.match(u.shelf().innerHTML,/Quarterly report\.md/);assert.doesNotMatch(u.shelf().innerHTML,/Foreign/);
 assert.deepEqual(h.requests.map(x=>x.url),['/api/buzzy/assets','/api/buzzy/assets?limit=60']);
 assert.equal(h.requests[1].init.credentials,'same-origin');
 assert.equal(h.requests[1].init.redirect,'error');assert.equal(h.requests[1].init.headers.Accept,'application/json');
 assert.match(u.document.getElementById('serverFiles').innerHTML,/\/api\/buzzy\/assets\/11/,'unchanged alternate Files list remains useful');
 const download=await h.fetch('/api/buzzy/assets/11');assert.equal(download.status,200);assert.equal(await download.text(),'Synthetic report café 日本語');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(download.headers.get('x-content-type-options'),'nosniff');
});
for(const id of [15,999])test('canonical asset '+id+' cannot read a foreign or missing owner record',async t=>{const h=await backend(t);const res=await h.fetch('/api/buzzy/assets/'+id);assert.equal(res.status,404);assert.equal((await res.json()).code,'not_found');assert.ok(h.queries.every(q=>/AND user_id =/.test(q.text)));});
test('signed-out list and content refuse before SQL',async t=>{const h=await backend(t);h.user(null);for(const path of ['/api/buzzy/assets?limit=60','/api/buzzy/assets/11'])assert.equal((await h.fetch(path)).status,401);assert.deepEqual(h.queries,[]);});
for(const id of [11,'11',2147483647])test('numeric id '+JSON.stringify(id)+' ignores every external URL alias',async()=>{const u=ui(async()=>json({items:[row(id,{url:"https://outside.invalid/secret?x=' onclick='bad",name:'Named',type:'audio/mpeg'})]}));await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/'+id]);assert.doesNotMatch(u.shelf().innerHTML,/outside|onclick|secret/);});
test('filename/type fallbacks and Unicode are preserved with attribute-specific escaping',async()=>{const name=`O'Brian "café" <tag> & 日本語`;const u=ui(async()=>json({items:[row(11,{filename:name,content_type:'image/png'}),row(12,{name:'Alias name',filename:'raw',type:'audio/mpeg',content_type:'text/plain'}),row(13,{name:'',filename:'',content_type:null})]}));await tick();const html=u.shelf().innerHTML;assert.match(html,/alt='O&#39;Brian &quot;café&quot; &lt;tag> &amp; 日本語'/);assert.match(html,/title='O&#39;Brian &quot;café&quot; &lt;tag> &amp; 日本語'/);assert.match(html,/>O'Brian "café" &lt;tag> &amp; 日本語<\/div>/);assert.match(html,/>Alias name<\/div>/);assert.match(html,/>untitled<\/div>/);assert.equal(urls(html).length,3);});
for(const id of [undefined,null,0,-1,1.5,NaN,Infinity,9007199254740992,'','0','01','1/../../secret','1?x=1',"1' onerror='bad",'https://outside.invalid',{},[]])test('malformed asset id '+String(id)+' never creates an empty or external target',async()=>{const u=ui(async()=>json({items:[{...row(),id}]}));await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);assert.deepEqual(urls(u.shelf().innerHTML),[]);});
for(const value of [null,{},[],{items:null},{items:{}},{items:'wrong'},{items:[null]},{items:[[]]},{ok:false,items:[row()]},{error:true,items:[row()]}])test('malformed list response fails visibly '+JSON.stringify(value),async()=>{const u=ui(async()=>json(value));await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);assert.deepEqual(urls(u.shelf().innerHTML),[]);});
for(const value of [{items:[]},{assets:[]}])test('valid empty list clears only the artifact shelf '+JSON.stringify(value),async()=>{const u=ui(async()=>json(value));await tick();assert.equal(u.shelf().innerHTML,'');assert.match(u.app.innerHTML,/No documents yet/);});
for(const status of [401,403,404,500])test('list HTTP '+status+' is an error, not a successful empty shelf',async()=>{let failed=true;const u=ui(async()=>json(failed?{error:'synthetic'}:{items:[row()]},failed?status:200));await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);failed=false;u.mount();await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/11']);});
for(const kind of ['transport','json'])test(kind+' failure is visible and reopening retries',async()=>{let failed=true;const u=ui(async()=>{if(failed){if(kind==='transport')throw Error('Synthetic disconnect');return {ok:true,json:async()=>{throw Error('Synthetic invalid JSON');}};}return json({items:[row()]});});await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);failed=false;u.mount();await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/11']);});

for(const stage of ['headers','body'])for(const outcome of ['success','error'])test('retired shelf ignores late '+stage+' '+outcome,async()=>{const gate=deferred();let first=true,readBodies=0;const u=ui(async()=>{if(!first)return json({items:[row(22,{filename:'NEW OWNER'})]});first=false;if(stage==='headers')return gate.promise;return {ok:true,json:async()=>{readBodies++;return gate.promise;}};});await tick();const old=u.shelf();u.mount();await tick();const replacement=u.shelf(),before=replacement.innerHTML;if(outcome==='error')gate.reject(Error('Late old failure'));else gate.resolve(stage==='headers'?{ok:true,json:async()=>{readBodies++;return {items:[row(11,{filename:'OLD OWNER'})]};}}:{items:[row(11,{filename:'OLD OWNER'})]});await tick();assert.equal(old.isConnected,false);assert.equal(replacement.innerHTML,before);assert.doesNotMatch(replacement.innerHTML,/OLD OWNER/);if(stage==='headers'&&outcome==='success')assert.equal(readBodies,0,'retired response body is not consumed');});
test('newest request owns a still-mounted shelf; old success cannot overwrite it',async()=>{const gate=deferred();let first=true;const u=ui(async()=>{if(first){first=false;return gate.promise;}return json({items:[row(22)]});});u.ctx.loadArtifactShelf();await tick();const before=u.shelf().innerHTML;gate.resolve(json({items:[row(11)]}));await tick();assert.equal(u.shelf().innerHTML,before);assert.deepEqual(urls(before),['/api/buzzy/assets/22']);});
for(const event of ['pagehide','popstate'])test(event+' with the same still-mounted owner preserves completion',async()=>{const gate=deferred();const u=ui(async()=>gate.promise);const host=u.shelf(),before=host.innerHTML;u.navigate('/buzzy/talk');u.emit(event);u.navigate('/buzzy/library');gate.resolve(json({items:[row()]}));await tick();assert.deepEqual(urls(host.innerHTML),['/api/buzzy/assets/11']);assert.equal(u.listeners(),0);});
test('temporary shell URL does not retire the still-mounted read owner',async()=>{const gate=deferred();let body=0;const u=ui(async()=>gate.promise);const before=u.shelf().innerHTML;u.navigate('/buzzy/talk');gate.resolve({ok:true,json:async()=>{body++;return {items:[row()]};}});await tick();assert.equal(body,1);assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/11']);});
test('detached old page cannot paint the same-id shelf of a new page',async()=>{const gate=deferred();const u=ui(async()=>gate.promise);const old=u.shelf();u.detach();const replacement=u.document.body.appendChild(new Element('div',u.document));replacement.id='artifactShelf';replacement.innerHTML='NEW PAGE';gate.resolve(json({items:[row()]}));await tick();assert.equal(old.isConnected,false);assert.equal(replacement.innerHTML,'NEW PAGE');});
test('settled requests leave no lifecycle listeners and repeated mounted refreshes remain usable',async()=>{const u=ui(async()=>json({items:[row()]}));for(let i=0;i<4;i++){await tick();assert.equal(u.listeners(),0);assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/11']);u.mount();}await tick();assert.equal(u.listeners(),0);});
test('nonempty legacy assets envelope retains supported name/type aliases but never its URL',async()=>{const u=ui(async()=>json({assets:[row('31',{name:'Legacy label',type:'audio/ogg',url:'javascript:bad()'})]}));await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/31']);assert.match(u.shelf().innerHTML,/>Legacy label<\/div>/);assert.match(u.shelf().innerHTML,/<audio/);});
test('nonstring display aliases use real filename/type or untitled without object serialization',async()=>{const u=ui(async()=>json({items:[row(11,{name:{bad:'object'}}),row(12,{name:[],filename:{bad:'object'},type:null,content_type:'image/png'})]}));await tick();assert.match(u.shelf().innerHTML,/Quarterly report\.md/);assert.match(u.shelf().innerHTML,/>untitled<\/div>/);assert.doesNotMatch(u.shelf().innerHTML,/\[object Object\]/);});
test('one malformed row fails the batch before publishing any partial asset links',async()=>{const u=ui(async()=>json({items:[row(11),row('unsafe')] }));await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);assert.deepEqual(urls(u.shelf().innerHTML),[]);});
test('actual signed-out list displays refusal rather than an empty success',async t=>{const h=await backend(t);h.user(null);const u=ui(h.fetch);await tick();assert.match(u.shelf().innerHTML,/could not be loaded/);assert.deepEqual(h.queries,[]);});
test('old rejected request cannot release a newer pending same-host owner',async()=>{const a=deferred(),b=deferred();let calls=0;const u=ui(async()=>++calls===1?a.promise:b.promise);u.ctx.loadArtifactShelf();a.reject(Error('Old failure'));await tick();assert.equal(u.listeners(),0);b.resolve(json({items:[row(22)]}));await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/22']);assert.equal(u.listeners(),0);});
test('old fulfillment cannot release the newer pending owner across page restore',async()=>{const a=deferred(),b=deferred();let calls=0;const u=ui(async()=>++calls===1?a.promise:b.promise);u.ctx.loadArtifactShelf();a.resolve(json({items:[row(11)]}));await tick();assert.equal(u.listeners(),0);const before=u.shelf().innerHTML;u.emit('pagehide');b.resolve(json({items:[row(22)]}));await tick();assert.deepEqual(urls(u.shelf().innerHTML),['/api/buzzy/assets/22']);assert.equal(u.listeners(),0);});
test('query-distinct navigation that replaces the grid invalidates its pending response',async()=>{const gate=deferred();const u=ui(async()=>gate.promise);const host=u.shelf(),before=host.innerHTML;u.navigate('/buzzy/library','?job=other');u.app.innerHTML='Other folder';gate.resolve(json({items:[row()]}));await tick();assert.equal(host.isConnected,false);assert.equal(host.innerHTML,before);assert.equal(u.app.innerHTML,'Other folder');});
test('a retired Library closure does not begin a new shelf request on another route',async()=>{const u=ui(async()=>json({items:[row()]}));await tick();u.navigate('/buzzy/talk');const count=u.calls.length;u.ctx.loadArtifactShelf();await tick();assert.equal(u.calls.length,count);});

test('same mounted Library remains usable after a temporary shell URL and Back',async()=>{const gate=deferred();const u=ui(async()=>gate.promise);const host=u.shelf();u.navigate('/buzzy/talk');gate.resolve(json({items:[row()]}));await tick();u.navigate('/buzzy/library');u.emit('popstate');await tick();assert.equal(u.shelf(),host);assert.deepEqual(urls(host.innerHTML),['/api/buzzy/assets/11']);});


test('local saved-file view is newest-first with collapsed legacy organizer and unchanged vault',async t=>{
 const h=await backend(t,{local:true}),u=ui(h.fetch,{local:true,otherFetch:h.fetch});await tick();
 assert.deepEqual(h.requests.map(r=>r.url),['/api/buzzy/assets','/api/buzzy/assets?limit=60&order=newest']);
 assert.deepEqual(urls(u.shelf().innerHTML),[14,13,12,11].map(id=>'/api/buzzy/assets/'+id));
 assert.match(u.shelf().innerHTML,/Saved files · newest first/);
 assert.match(u.app.innerHTML,/Saved files across all companies, not filtered by the selected company/);
 assert.match(u.app.innerHTML,/<details><summary>Saved documents/);
 assert.match(u.app.innerHTML,/librarySyncStatus/);
 assert.doesNotMatch(u.app.innerHTML,/mascot-sm/);
 assert.equal(u.document.getElementById('serverFiles').parentNode.id,'sessionFileOrganizer');
 assert.match(u.document.getElementById('sessionFileOrganizer').innerHTML,/up to 200 files in path order/);
 assert.doesNotMatch(u.document.getElementById('sessionFileOrganizer').innerHTML,/<details[^>]*open/);
 assert.doesNotMatch(u.shelf().innerHTML,/Keep working on it|Continue/,'no fabricated conversation action');
});
test('newest ordering only affects explicit local request, with limit applied after sorting',async t=>{
 const local=await backend(t,{local:true});
 const newest=await (await local.fetch('/api/buzzy/assets?limit=1&order=newest')).json();assert.equal(newest.items[0].id,14);
 const original=await (await local.fetch('/api/buzzy/assets?limit=1')).json();assert.equal(original.items[0].id,11);
 const cloud=await backend(t);const unchanged=await (await cloud.fetch('/api/buzzy/assets?limit=1&order=newest')).json();assert.equal(unchanged.items[0].id,11);
});
test('empty or failed local list retains saved document access and honest message',async()=>{
 const empty=ui(async()=>json({items:[]}),{local:true});await tick();assert.match(empty.shelf().innerHTML,/No saved files yet/);assert.match(empty.app.innerHTML,/Saved documents/);assert.match(empty.app.innerHTML,/Saved files across all companies/);
 const failed=ui(async()=>json({error:'synthetic'},500),{local:true});await tick();assert.match(failed.shelf().innerHTML,/could not be loaded/);assert.match(failed.app.innerHTML,/Saved documents/);assert.match(failed.app.innerHTML,/Saved files across all companies/);
});

test('older session file omitted from newest sixty remains accessible in collapsed organizer',async()=>{
 const recent=Array.from({length:60},(_,i)=>row(i+101));
 const older=row(9,{filename:'Older-session-file.png'});
 const u=ui(async()=>json({items:recent}),{local:true,otherFetch:async()=>json({items:[older,...recent]})});await tick();
 assert.equal(urls(u.shelf().innerHTML).length,60);
 assert.ok(!urls(u.shelf().innerHTML).includes('/api/buzzy/assets/9'));
 const holder=u.document.getElementById('serverFiles');
 assert.equal(holder.parentNode.tagName,'details');
 assert.ok(urls(holder.innerHTML).includes('/api/buzzy/assets/9'));
 assert.match(holder.innerHTML,/Older-session-file.png/);
 assert.match(u.app.innerHTML,/Saved documents/);
 assert.match(u.app.innerHTML,/librarySyncStatus/);
});
