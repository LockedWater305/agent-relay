// Actual Nitro route and actual query text executed against synthetic in-memory
// SQLite. Only $N binding names are translated; PostgreSQL/PGLite remains a gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(process.env.BZ_MEMORY_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const source=stripTypeScriptTypes(fs.readFileSync(resolve(root,'src/lib/buzzy/chat.nitro.ts'),'utf8'));
const A='co_aaaaaaaa',B='co_bbbbbbbb',F='co_ffffffff';
async function harness(user='owner'){
 const db=new DatabaseSync(':memory:'),queries=[];
 db.exec(`CREATE TABLE buzzy_companies(id TEXT PRIMARY KEY,user_id TEXT);
 CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,company_id TEXT,status TEXT);
 CREATE TABLE buzzy_sessions(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,job_id TEXT,company_id TEXT);
 CREATE TABLE buzzy_user_memory(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,key TEXT,value TEXT,updated_at TEXT);
 CREATE TABLE buzzy_chat_messages(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,session_id TEXT,role TEXT,content TEXT,created_at TEXT);`);
 const insert=(table,values)=>db.prepare(`INSERT INTO ${table} VALUES (${values.map(()=>'?').join(',')})`).run(...values);
 insert('buzzy_companies',[A,'owner']);insert('buzzy_companies',[B,'owner']);insert('buzzy_companies',[F,'foreign']);
 const job=(id,company=A,owner='owner',status='Active')=>insert('buzzy_jobs',[id,owner,'Title '+id,company,status]);
 const session=(id,jobId=null,company=A,owner='owner')=>insert('buzzy_sessions',[id,owner,'Session '+id,jobId,company]);
 const fact=(id,key=id,owner='owner',time='2026-01-01')=>insert('buzzy_user_memory',[null,owner,id,key,'Value '+key,time]);
 const message=(id,jobId=null,sessionId=null,owner='owner',time='2026-01-01')=>insert('buzzy_chat_messages',[null,owner,jobId,sessionId,'user',id,time]);
 let fail=false;
 const execute=(text,params)=>{queries.push({text,params});if(fail)throw Error('synthetic storage failure');const statement=db.prepare(text.replace(/\$(\d+)/g,':p$1'));const bindings=Object.fromEntries(params.map((v,i)=>['p'+(i+1),v]));return statement.all(bindings);};
 const sql=async(strings,...values)=>{let text=strings[0];for(let i=0;i<values.length;i++)text+='$'+(i+1)+strings[i+1];return execute(text,values);};sql.query=async(text,params)=>execute(text,params);
 const ctx=vm.createContext({URL,URLSearchParams,Headers,Request,Response,Buffer});
 const deps={h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,setResponseHeader(){},setResponseStatus:(e,s)=>e.status=s,getHeader:(e,k)=>e.req.headers.get(k)},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'@/lib/db':{getSql:async()=>sql}};
 const mod=new vm.SourceTextModule(source,{context:ctx});await mod.link(specifier=>{const m=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].find(m=>m[2]===specifier);assert.ok(m,specifier);const names=m[1].split(',').map(x=>x.trim()).filter(Boolean);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[specifier]?.[name]??(name==='honchoAvailable'?()=>false:()=>{throw Error('Unexpected '+specifier+'.'+name)}));},{context:ctx});});await mod.evaluate();
 return {db,queries,job,session,fact,message,fail:()=>fail=true,async get(query=''){const path='/api/buzzy/memory'+query,e={path,status:200,req:new Request('http://local'+path)};return {status:e.status,data:await mod.namespace.default(e),get actualStatus(){return e.status;}};}};
}
const keys=r=>r.data.facts.map(f=>f.key).sort();
test('scoped archived, legacy, session-only facts and messages use verified metadata',async()=>{
 const h=await harness();h.job('archived',A,'owner','Archived');h.job('legacy',null);h.session('legacy_session','legacy');h.session('plain');h.job('other',B);h.job('foreign',F,'foreign');
 for(const id of ['archived','legacy','plain','other'])h.fact(id);h.fact('foreign','foreign','foreign');
 h.message('archived message','archived');h.message('legacy message',null,'legacy_session');h.message('plain message',null,'plain');h.message('other message','other');h.message('foreign message',null,null,'foreign');
 const r=await h.get('?companyId='+A);assert.equal(r.actualStatus,200);assert.deepEqual(keys(r),['archived','legacy','plain']);assert.equal(r.data.messages.length,3);assert.equal(r.data.scope.companyId,A);
 const f=r.data.facts.find(f=>f.key==='plain');assert.equal(f.jobId,'plain');assert.equal(f.source.kind,'session');assert.equal(f.source.id,'plain');assert.equal(f.source.title,'Session plain');assert.equal(f.source.companyId,A);
 assert.equal(r.data.messages.find(m=>m.content==='plain message').sessionId,'plain');h.db.close();
});
test('job ambiguity stays account-only while explicit session records keep independent company authority',async()=>{
 const h=await harness();h.job('multi',null);h.session('multi_a','multi',A);h.session('multi_b','multi',B);h.job('unknown',null);h.session('unknown_session','unknown',null);h.job('collision');h.session('collision');h.job('direct',A);h.session('contradiction','direct',B);h.session('deleted_job','missing',A);h.session('foreign_session',null,F,'foreign');
 for(const id of ['multi','unknown','collision','missing','deleted_job'])h.fact(id);
 h.message('multi message',null,'multi_a');h.message('foreign session no fallback','direct','foreign_session');h.message('conflict',null,'contradiction');h.message('missing session no fallback','direct','missing');h.message('wrong job','unknown','multi_a');
 const scoped=await h.get('?companyId='+A);assert.deepEqual(keys(scoped),['deleted_job']);assert.deepEqual(scoped.data.messages.map(m=>m.content).sort(),['multi message','wrong job']);
 const all=await h.get();assert.equal(all.data.scope.companyId,null);assert.equal(all.data.facts.length,5);assert.equal(all.data.messages.length,5);
 for(const row of all.data.facts.filter(f=>f.key!=='deleted_job'))assert.deepEqual(JSON.parse(JSON.stringify(row.source)),{kind:'unassigned',id:null,title:null,companyId:null});
 for(const name of ['foreign session no fallback','missing session no fallback'])assert.equal(all.data.messages.find(m=>m.content===name).source.kind,'unassigned');h.db.close();
});
test('explicit job company governs facts despite contradictory session; session message excluded',async()=>{
 const h=await harness();h.job('explicit',A);h.session('conflict','explicit',B);h.fact('explicit');h.message('contradictory','explicit','conflict');
 const a=await h.get('?companyId='+A),b=await h.get('?companyId='+B);assert.equal(a.data.facts.length,1);assert.equal(a.data.messages.length,0);assert.equal(b.data.facts.length,0);assert.equal(b.data.messages.length,0);h.db.close();
});
test('scope filters run before 200 fact and 100 message limits',async()=>{
 const h=await harness();h.job('a',A);h.job('b',B);h.fact('a','target','owner','2020');h.message('target','a',null,'owner','2020');for(let i=0;i<250;i++){h.fact('b','other'+i);h.message('other'+i,'b');}
 const r=await h.get('?companyId='+A);assert.deepEqual(keys(r),['target']);assert.equal(r.data.messages[0].content,'target');const all=await h.get();assert.equal(all.data.facts.length,200);assert.equal(all.data.messages.length,100);
 for(const q of h.queries.filter(q=>q.text.includes('WITH owned_companies'))){assert.match(q.text,/WHERE \(CAST\(\$2 AS TEXT\) IS NULL OR source_company_id = \$2\)[\s\S]*ORDER BY[\s\S]*LIMIT/);assert.doesNotMatch(q.text,/archived_at IS NULL/);}h.db.close();
});
test('malformed, empty and duplicate company parameters never fall back to account scope',async()=>{
 const h=await harness();for(const q of ['?companyId=','?companyId=bad','?companyId='+A+'&companyId='+A,'?companyId=%20'+A,'?companyId%5B%5D='+A,'?company_id='+A,'?cursor=1','?companyId='+A+'&unexpected=1']){const r=await h.get(q);assert.equal(r.actualStatus,400);assert.equal(r.data.facts,undefined);}assert.equal(h.queries.length,0);h.db.close();
});
test('missing/foreign company refuses before querying memory; absent scope remains account-wide',async()=>{
 const h=await harness();for(const company of [F,'co_missing1']){const r=await h.get('?companyId='+company);assert.equal(r.actualStatus,404);}assert.equal(h.queries.some(q=>q.text.includes('buzzy_user_memory')),false);h.fact('orphan');assert.equal((await h.get()).data.facts.length,1);h.db.close();
});
test('authentication and storage failure fail closed without broad retry',async()=>{
 const no=await harness(null);assert.equal((await no.get('?companyId='+A)).actualStatus,401);assert.equal(no.queries.length,0);no.db.close();const h=await harness();h.fail();const r=await h.get('?companyId='+A);assert.equal(r.actualStatus,503);assert.equal(h.queries.length,1);assert.equal(r.data.facts,undefined);assert.doesNotMatch(r.data.error,/synthetic/);h.db.close();
});
test('session pointer advance keeps explicit same-company historical messages, rejects conflicting past job',async()=>{
 const h=await harness();h.job('past',A);h.job('current',A);h.job('conflicting_past',B);h.session('moving','current',A);
 h.message('past message','past','moving');h.message('current message','current','moving');h.message('conflicting message','conflicting_past','moving');
 const a=await h.get('?companyId='+A),b=await h.get('?companyId='+B);assert.deepEqual(a.data.messages.map(m=>m.content).sort(),['current message','past message']);assert.equal(b.data.messages.length,0);assert.equal((await h.get()).data.messages.find(m=>m.content==='conflicting message').source.kind,'unassigned');h.db.close();
});
test('immutable message edges recover older legacy jobs after pointer advance without duplicate rows',async()=>{
 const h=await harness();h.job('legacy_past',null);h.job('current',A);h.session('moving','current',A);h.fact('legacy_past');
 h.message('past one','legacy_past','moving');h.message('past two','legacy_past','moving');h.message('current','current','moving');
 const r=await h.get('?companyId='+A);assert.deepEqual(keys(r),['legacy_past']);assert.equal(r.data.facts[0].source.companyId,A);assert.equal(r.data.messages.length,3);h.db.close();
});
test('invalid and conflicting historical edges poison legacy inference rather than being dropped',async()=>{
 const h=await harness();h.job('current',A);h.session('valid','current',A);h.session('foreign',null,F,'foreign');h.session('other',null,B);
 for(const [jobId,badSession] of [['bad_missing','missing'],['bad_foreign','foreign'],['bad_multi','other']]){h.job(jobId,null);h.fact(jobId);h.message(jobId+' good',jobId,'valid');h.message(jobId+' bad',jobId,badSession);}
 assert.equal((await h.get('?companyId='+A)).data.facts.length,0);assert.equal((await h.get('?companyId='+B)).data.facts.length,0);
 for(const row of (await h.get()).data.facts)assert.equal(row.source.kind,'unassigned');h.db.close();
});
test('ordinary Talk null-company jobA to jobB retains historical facts and messages',async()=>{
 const h=await harness();h.job('past',null);h.job('current',null);h.session('moving','current',A);h.fact('past');h.message('past','past','moving');
 const r=await h.get('?companyId='+A);assert.deepEqual(keys(r),['past']);assert.equal(r.data.messages.length,1);assert.equal(r.data.facts[0].source.kind,'job');h.db.close();
});
test('equal timestamps have deterministic actual row-id descending order',async()=>{
 const h=await harness();h.job('job');for(let i=0;i<3;i++){h.fact('job','fact'+i);h.message('message'+i,'job');}
 const r=await h.get('?companyId='+A);assert.deepEqual(r.data.facts.map(f=>f.key),['fact2','fact1','fact0']);assert.deepEqual(r.data.messages.map(m=>m.content),['message2','message1','message0']);h.db.close();
});
test('session identity ignores latest missing or contradictory job pointer; each actual message job is separately checked',async()=>{
 const h=await harness();h.job('current_other',B);h.job('past_good',A);h.job('past_legacy',null);h.job('foreign_job',A,'foreign');
 h.session('moved','current_other',A);h.session('deleted_latest','gone',A);h.fact('moved');h.fact('deleted_latest');
 h.message('session only',null,'moved');h.message('same company past','past_good','moved');h.message('legacy past','past_legacy','moved');h.message('different company actual','current_other','moved');h.message('missing actual','missing','moved');h.message('foreign actual','foreign_job','moved');
 const r=await h.get('?companyId='+A);assert.deepEqual(keys(r),['deleted_latest','moved']);assert.deepEqual(r.data.messages.map(m=>m.content).sort(),['legacy past','same company past','session only']);h.db.close();
});
test('invalid explicit job company cannot inherit otherwise valid session edges',async()=>{
 const h=await harness();h.job('invalid',F);h.session('valid',null,A);h.fact('invalid');h.message('edge','invalid','valid');
 const r=await h.get('?companyId='+A);assert.equal(r.data.facts.length,0);assert.equal(r.data.messages.length,0);const all=await h.get();assert.equal(all.data.facts[0].source.kind,'unassigned');assert.equal(all.data.messages[0].source.kind,'unassigned');h.db.close();
});
test('actual Memory UI to Nitro to SQL restores scoped history without mutating stored rows',async()=>{
 const h=await harness();h.session('plain');h.job('archived',A,'owner','Archived');h.job('jobA',null);h.job('jobB',null);h.session('moving','jobB',A);h.job('other_company',B);h.job('foreign_job',F,'foreign');
 for(const id of ['plain','archived','jobA'])h.fact(id,'visible_'+id);
 h.fact('other_company','HIDDEN_OTHER_COMPANY');h.fact('foreign_job','HIDDEN_OTHER_OWNER','foreign');
 h.message('VISIBLE_PLAIN',null,'plain');h.message('VISIBLE_ARCHIVED','archived');h.message('VISIBLE_HISTORICAL_JOB_A','jobA','moving');h.message('HIDDEN_COMPANY_MESSAGE','other_company');h.message('HIDDEN_OWNER_MESSAGE','foreign_job',null,'foreign');
 const tables=['buzzy_companies','buzzy_jobs','buzzy_sessions','buzzy_user_memory','buzzy_chat_messages'];
 const snapshot=()=>JSON.stringify(tables.map(table=>[table,h.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 const before=snapshot(),calls=[],rootNode={innerHTML:'',querySelectorAll:()=>[]};
 const html=fs.readFileSync(resolve(root,'public/buzzy/memory.html'),'utf8');
 function extract(name){const match=new RegExp('^    (?:async )?function '+name+'\\(','m').exec(html);assert.ok(match,name);const end=html.indexOf('\n    }',match.index);assert.ok(end>match.index);return html.slice(match.index,end+6);}
 const companies={ready:()=>true,active:()=>({id:A,name:'Owned company'}),activeId:()=>A,loadError:()=>false};
 const document={getElementById:id=>id==='content'?rootNode:null,createElement:()=>({value:'',set textContent(v){this.value=String(v);},get innerHTML(){return this.value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}})};
 const context=vm.createContext({window:{BZCompanies:companies},BZCompanies:companies,document,URLSearchParams,console,memGen:0,fetch:async url=>{
  calls.push(url);
  // Baseline's deprecated active-jobs intersection is represented truthfully;
  // it cannot see archived or null-company jobs or session-keyed memory.
  if(url.startsWith('/api/buzzy/jobs'))return Response.json({jobs:h.db.prepare("SELECT * FROM buzzy_jobs WHERE user_id='owner' AND company_id=? AND status!='Archived'").all(A)});
  assert.ok(url.startsWith('/api/buzzy/memory'));const r=await h.get(url.slice('/api/buzzy/memory'.length));return Response.json(r.data,{status:r.actualStatus});
 }});
 vm.runInContext(extract('esc')+'\n'+extract('loadMemory'),context);await context.loadMemory();
 assert.deepEqual(calls,['/api/buzzy/memory?companyId='+A]);
 for(const text of ['Value visible_plain','Value visible_archived','Value visible_jobA','VISIBLE_PLAIN','VISIBLE_ARCHIVED','VISIBLE_HISTORICAL_JOB_A','Session plain','Title archived','Title jobA','Session moving'])assert.ok(rootNode.innerHTML.includes(text),'missing rendered '+text);
 assert.doesNotMatch(rootNode.innerHTML,/HIDDEN_|No decisions captured yet|No conversations yet/);
 assert.equal(snapshot(),before,'scoped UI read must not reassign or delete data');await h.get();assert.equal(snapshot(),before,'account read must not reassign or delete data');h.db.close();
});
