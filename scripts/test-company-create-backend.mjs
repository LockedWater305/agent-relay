// Real full Nitro handler and emitted SQL; synthetic SQLite only. SQLite is not
// PostgreSQL/PGLite: native migration/packaged checks remain separate gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
const source=stripTypeScriptTypes(fs.readFileSync(new URL('../src/lib/buzzy/chat.nitro.ts',import.meta.url),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
async function harness(){
 const db=new DatabaseSync(':memory:'),queries=[];let user='owner';
 db.exec(`CREATE TABLE buzzy_companies(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,one_liner TEXT DEFAULT '',website TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE buzzy_company_facts(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,fact_key TEXT,label TEXT,value TEXT,status TEXT,source_label TEXT,source_page TEXT,original_value TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,title TEXT,status TEXT);
 CREATE TABLE buzzy_sessions(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,job_id TEXT);
 CREATE TABLE buzzy_chat_messages(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,session_id TEXT,role TEXT,content TEXT);
 INSERT INTO buzzy_companies(id,user_id,name,created_at) VALUES('co_existing1','owner','Existing owner company','2020'),('co_foreign11','other','Foreign company','2020');
 INSERT INTO buzzy_company_facts(id,user_id,company_id,fact_key,label,value,status) VALUES('fact_owned','owner','co_existing1','offer','Offer','Existing fact','confirmed'),('fact_foreign','other','co_foreign11','offer','Offer','Foreign fact','confirmed');
 INSERT INTO buzzy_jobs VALUES('job_keep','owner',NULL,'Unassigned existing job','Archived');
 INSERT INTO buzzy_sessions VALUES('sess_keep','owner',NULL,'job_keep');
 INSERT INTO buzzy_chat_messages VALUES(1,'owner','job_keep','sess_keep','user','Existing conversation');`);
 const sql=async(strings,...values)=>{let text=strings[0];for(let i=0;i<values.length;i++)text+='$'+(i+1)+strings[i+1];queries.push({text,values});const bindings=Object.fromEntries(values.map((v,i)=>['p'+(i+1),v]));return db.prepare(text.replace(/\$(\d+)/g,':p$1')).all(bindings);};
 const ctx=vm.createContext({URL,URLSearchParams,Headers,Request,Response,Buffer,crypto:webcrypto});
 const deps={h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,setResponseHeader(){},setResponseStatus:(e,s)=>e.status=s,getHeader:(e,k)=>e.req.headers.get(k)},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'@/lib/db':{getSql:async()=>sql}};
 const mod=new vm.SourceTextModule(source,{context:ctx});await mod.link(specifier=>{const match=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].find(m=>m[2]===specifier);assert.ok(match,specifier);const names=match[1].split(',').map(x=>x.trim()).filter(Boolean);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[specifier]?.[name]??(()=>{throw Error('Unexpected dependency '+specifier+'.'+name)}));},{context:ctx});});await mod.evaluate();
 return {db,queries,as:id=>user=id,async request(method='POST',body={name:'New company'},raw){const e={path:'/api/buzzy/companies',status:200,req:new Request('http://local/api/buzzy/companies',{method,...(method==='POST'?{body:raw??JSON.stringify(body)}:{})})};const data=await mod.namespace.default(e);return {status:e.status,data:plain(data)};}};
}
test('name-only creation returns valid empty card and reload preserves authenticated ownership',async()=>{
 const h=await harness();const r=await h.request('POST',{name:'New name',userId:'other',user_id:'other',id:'co_hijacked',companyId:'co_foreign11',website:'https://ignored.example',facts:[{value:'not imported'}]});
 assert.equal(r.status,201);const c=r.data.company;assert.match(c.id,/^co_[a-f0-9]{16}$/);assert.equal(c.name,'New name');assert.equal(c.oneLiner,'');assert.equal(c.website,'');assert.deepEqual(c.lines,[]);assert.deepEqual(c.facts,[]);assert.ok(c.createdAt);assert.ok(c.updatedAt);
 assert.equal(h.db.prepare('SELECT user_id FROM buzzy_companies WHERE id=?').get(c.id).user_id,'owner');
 const list=await h.request('GET');assert.deepEqual(list.data.companies.map(c=>c.name),['Existing owner company','New name']);assert.equal(list.data.companies[0].facts[0].value,'Existing fact');assert.deepEqual(list.data.companies.find(x=>x.id===c.id),c);
 h.as('other');const foreign=await h.request('GET');assert.deepEqual(foreign.data.companies.map(c=>c.name),['Foreign company']);assert.equal(foreign.data.companies[0].facts[0].value,'Foreign fact');h.db.close();
});
test('normalization trims and collapses whitespace then truncates to80 UTF16 units',async()=>{
 const h=await harness();for(const [input,expected] of [[' \t Acme\n\n &  Sons \r ','Acme & Sons'],['x'.repeat(100),'x'.repeat(80)],['  '+('a '.repeat(70)),'a '.repeat(40)],['日本語  会社','日本語 会社']]){const r=await h.request('POST',{name:input});assert.equal(r.status,201);assert.equal(r.data.company.name,expected);}h.db.close();
});
test('missing or invalid name and malformed/nonobject JSON reject before SQL',async()=>{
 const h=await harness();for(const body of [{},{name:null},{name:12},{name:false},{name:[]},{name:{}},{name:''},{name:' \n\t '},[],null,'name']){const r=await h.request('POST',body);assert.equal(r.status,400);assert.equal(r.data.code,'bad_request');}
 for(const raw of ['{','', 'not json']){const r=await h.request('POST',{},raw);assert.equal(r.status,400);}assert.equal(h.queries.length,0);h.db.close();
});
test('signed-out create/list refuse before database access',async()=>{const h=await harness();h.as(null);for(const method of ['POST','GET']){const r=await h.request(method);assert.equal(r.status,401);assert.equal(r.data.code,'signed_out');}assert.equal(h.queries.length,0);h.db.close();});
test('creating and listing does not alter unrelated companies, facts, jobs, sessions or messages',async()=>{
 const h=await harness(),tables=['buzzy_company_facts','buzzy_jobs','buzzy_sessions','buzzy_chat_messages'];
 const snapshot=()=>JSON.stringify(tables.map(t=>[t,h.db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));const before=snapshot();const old=h.db.prepare('SELECT * FROM buzzy_companies ORDER BY id').all();const created=await h.request();await h.request('GET');assert.equal(snapshot(),before);
 assert.deepEqual(h.db.prepare('SELECT * FROM buzzy_companies WHERE id<>? ORDER BY id').all(created.data.company.id),old);assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM buzzy_companies').get().count,3);h.db.close();
});
test('existing API has no name deduplication or idempotency contract',async()=>{const h=await harness();const a=await h.request(),b=await h.request();assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.data.company.id,b.data.company.id);h.db.close();});
test('existing list returns first50 owner companies by creation time',async()=>{
 const h=await harness();for(let i=0;i<52;i++)h.db.prepare('INSERT INTO buzzy_companies(id,user_id,name,created_at) VALUES(?,?,?,?)').run('co_limit'+String(i).padStart(3,'0'),'owner','Limit '+i,'2021-'+String(i).padStart(3,'0'));
 const r=await h.request('GET');assert.equal(r.data.companies.length,50);assert.equal(r.data.companies[0].name,'Existing owner company');assert.equal(r.data.companies.at(-1).name,'Limit 48');h.db.close();
});
