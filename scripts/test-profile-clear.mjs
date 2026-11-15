// Actual profile page functions + complete Nitro handler + actual profile service.
// SQL runs in isolated in-memory SQLite with only parameter-name adaptation.
// This is not the separate real PostgreSQL/PGlite or packaged native gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.env.BZ_PROFILE_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(root,p),'utf8');
const profileSource=stripTypeScriptTypes(read('src/lib/buzzy/profile.ts'));
const routeSource=stripTypeScriptTypes(read('src/lib/buzzy/chat.nitro.ts'));
const html=read('public/buzzy/profile.html');
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

async function backend(){
 const db=new DatabaseSync(':memory:'),queries=[];let user='owner',failure=null;
 db.function('now',()=> '2026-11-15T01:00:00Z');
 db.exec(`CREATE TABLE buzzy_user_memory(id INTEGER PRIMARY KEY,user_id TEXT,job_id TEXT,key TEXT,value TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,job_id,key));
 CREATE TABLE buzzy_companies(id TEXT PRIMARY KEY,user_id TEXT,name TEXT);
 CREATE TABLE buzzy_company_facts(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,value TEXT);
 CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,title TEXT,status TEXT);
 CREATE TABLE buzzy_sessions(id TEXT PRIMARY KEY,user_id TEXT,company_id TEXT,job_id TEXT);
 CREATE TABLE buzzy_documents(id TEXT PRIMARY KEY,user_id TEXT,job_id TEXT,body TEXT,approved INTEGER);
 INSERT INTO buzzy_companies VALUES('co_a','owner','Company A'),('co_b','owner','Company B'),('co_foreign','foreign','Foreign company');
 INSERT INTO buzzy_company_facts VALUES('fact_a','owner','co_a','Keep A'),('fact_b','owner','co_b','Keep B'),('fact_foreign','foreign','co_foreign','Keep foreign');
 INSERT INTO buzzy_jobs VALUES('job_a','owner','co_a','Owned active job','Active'),('job_b','owner','co_b','Owned archived job','Archived'),('job_foreign','foreign','co_foreign','Foreign job','Active');
 INSERT INTO buzzy_sessions VALUES('sess_a','owner','co_a','job_a'),('sess_b','owner','co_b','job_b');
 INSERT INTO buzzy_documents VALUES('doc_a','owner','job_a','Approved original',1),('doc_b','owner','job_b','Archived original',1);`);
 function insert(userId,jobId,key,value){db.prepare('INSERT INTO buzzy_user_memory(user_id,job_id,key,value) VALUES(?,?,?,?)').run(userId,jobId,key,value);}
 insert('owner',null,'profile_tone','Obsolete tone');insert('owner',null,'profile_business_name','Owned business');
 insert('owner',null,'unrelated_account_fact','Keep unrelated');insert('owner',null,'profile_future_key','Keep unknown');
 insert('foreign',null,'profile_tone','Foreign tone');insert('owner','job_a','profile_tone','Snapshot A');
 insert('owner','job_b','profile_tone','Snapshot B');insert('foreign','job_foreign','profile_tone','Foreign snapshot');
 const execute=(text,params=[])=>{
  queries.push({text,params});if(failure)failure(text,params);
  return db.prepare(text.replace(/\$(\d+)/g,':p$1')).all(Object.fromEntries(params.map((v,i)=>['p'+(i+1),v])));
 };
 const sql=async(strings,...params)=>{let text=strings[0];params.forEach((_,i)=>{text+='$'+(i+1)+strings[i+1];});return execute(text,params);};
 sql.query=async(text,params=[])=>execute(text,params);
 const context=vm.createContext({URL,URLSearchParams,Headers,Request,Response,Buffer});
 const service=new vm.SourceTextModule(profileSource,{context});await service.link(()=>{throw Error('Unexpected profile dependency');});await service.evaluate();
 const deps={h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,getHeader:(e,k)=>e.req.headers.get(k),setResponseHeader(){},setResponseStatus:(e,status)=>e.status=status},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'@/lib/db':{getSql:async()=>sql}};
 const route=new vm.SourceTextModule(routeSource,{context});
 await route.link(specifier=>{
  if(specifier==='./profile')return service;
  const match=[...routeSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].find(m=>m[2]===specifier);assert.ok(match,specifier);
  const names=match[1].split(',').map(x=>x.trim()).filter(Boolean);
  return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[specifier]?.[name]??(()=>{throw Error('Unexpected '+specifier+'.'+name);}));},{context});
 });await route.evaluate();
 const rows=()=>plain(db.prepare('SELECT * FROM buzzy_user_memory ORDER BY id').all());
 return {db,sql,queries,insert,rows,service:service.namespace,as(value){user=value;},fail(callback){failure=callback;},
  async request(method='PUT',body={fields:{tone:''}},path='/api/buzzy/profile',raw){
   const event={path,status:200,req:new Request('http://local'+path,{method,...(method==='GET'?{}:{body:raw??JSON.stringify(body)})})};
   const data=await route.namespace.default(event);return {status:event.status,data:plain(data)};
  }, snapshotOtherTables(){return JSON.stringify(['buzzy_companies','buzzy_company_facts','buzzy_jobs','buzzy_sessions','buzzy_documents'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY id').all()]));},
 };
}

// A minimal connected DOM adapter mounts the real rendered form, replaces old
// nodes on render, and decodes the entities used in these text fixtures.
function decode(text){return text.replace(/&(?:amp|lt|gt|quot|copy|#39|#x[0-9a-f]+|#\d+);/gi,entity=>{
 const known={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&copy;':'©','&#39;':"'"};
 return known[entity.toLowerCase()]??String.fromCodePoint(parseInt(entity.slice(entity[2].toLowerCase()==='x'?3:2,-1),entity[2].toLowerCase()==='x'?16:10));
});}
async function ui(h){
 const elements=new Map(),requests=[];let responseHook=null,activeApp;
 const app={isConnected:true,contains(el){return !!el&&el.owner===this&&el.isConnected;},_html:'',
  set innerHTML(markup){
   this._html=markup;for(const [id,el] of elements)if(el!==this){el.isConnected=false;elements.delete(id);}
   for(const match of markup.matchAll(/<(textarea|button|input|div)\b([^>]*\sid=['"]([^'"]+)['"][^>]*)>([\s\S]*?)(?:<\/\1>|(?=<))/g)){
    const [,tag,attrs,id,content]=match;elements.set(id,{id,owner:this,isConnected:true,value:tag==='textarea'?decode(content):'',disabled:/\bdisabled\b/.test(attrs),checked:/\bchecked\b/.test(attrs),textContent:tag==='div'?decode(content):'',className:attrs.match(/class=['"]([^'"]*)/)?.[1]||'',onclick:null});
   }
   // Self-closing-ish HTML inputs need only checkbox/reuse behavior here.
   for(const match of markup.matchAll(/<input\b([^>]*\sid=['"]([^'"]+)['"][^>]*)>/g)){
    const [,attrs,id]=match;elements.set(id,{id,owner:this,isConnected:true,value:'',disabled:/\bdisabled\b/.test(attrs),checked:/\bchecked\b/.test(attrs),textContent:'',className:'',onclick:null});
   }
  },get innerHTML(){return this._html;}};
 activeApp=app;elements.set('app',app);
 const document={getElementById(id){return id==='app'?activeApp:elements.get(id)||null;}};
 const context=vm.createContext({document,window:{BeeZillaShell:{go(){throw Error('No navigation requested');}}},fetch:async(url,init={})=>{
  assert.equal(init.credentials,'same-origin');const method=init.method||'GET';const body=init.body?JSON.parse(init.body):undefined;
  const request={url,method,body};requests.push(request);
  const next=async()=>{try{const r=await h.request(method,body,url);return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.data};}catch{return {ok:false,status:500,json:async()=>({error:'Synthetic server failure'})};}};
  return responseHook?responseHook(request,next):next();
 }});
 const start=html.indexOf('    function escapeHtml('),end=html.indexOf('    // ── Account gate.',start);
 assert.ok(start>0&&end>start);vm.runInContext(html.slice(start,end),context);
 await context.loadProfile();context.render();
 return {context,app,requests,element:id=>elements.get(id),set(id,value){const el=elements.get('f_'+id);assert.ok(el,id);el.value=value;},
  profile:()=>plain(vm.runInContext('PROFILE',context)),
  click:()=>elements.get('save').onclick(),
  missing(id){const el=elements.get('f_'+id);el.isConnected=false;elements.delete('f_'+id);},
  hook(value){responseHook=value;},
  detach(){app.isConnected=false;for(const el of elements.values())el.isConnected=false;const replacement={innerHTML:'New page',isConnected:true};activeApp=replacement;return replacement;},
 };
}

test('normal visible blank Save clears the current default and stays cleared after reload',async()=>{
 const h=await backend(),f=await ui(h);f.set('tone','');await f.click();
 assert.equal(f.requests.at(-1).body.fields.tone,'');assert.equal(f.profile().fields.tone,undefined);
 assert.equal(f.element('f_tone').value,'');assert.equal(f.element('r_tone').disabled,true);
 assert.equal(f.element('saveStatus').className,'status ok');assert.equal(f.element('saveStatus').textContent,'Saved.');
 await f.context.loadProfile();f.context.render();assert.equal(f.element('f_tone').value,'');assert.equal((await h.request('GET')).data.profile.fields.tone,undefined);h.db.close();
});
test('visible form explains explicit blank clears and unchanged job copies',async()=>{
 const h=await backend(),f=await ui(h);assert.match(f.app.innerHTML,/Leave a field blank and Save/);assert.match(f.app.innerHTML,/Copies already in jobs stay unchanged/);h.db.close();
});
test('partial API clear returns canonical cleared key and leaves omitted fields unchanged',async()=>{
 const h=await backend();const before=h.rows().find(row=>row.key==='profile_business_name');
 const r=await h.request();assert.equal(r.status,200);assert.deepEqual(r.data.saved,[]);assert.deepEqual(r.data.cleared,['tone']);assert.deepEqual(r.data.rejected,[]);
 assert.equal(r.data.profile.fields.tone,undefined);assert.deepEqual(h.rows().find(row=>row.id===before.id),before);h.db.close();
});
test('omitted keys and non-string values never authorize a clear or rewrite',async()=>{
 const h=await backend(),before=h.rows();
 for(const fields of [{},{tone:null},{tone:false},{tone:42},{tone:[]},{tone:{}},{tone:undefined}]){await h.request('PUT',{fields});assert.deepEqual(h.rows(),before);}
 assert.equal(h.queries.some(q=>/^\s*(DELETE|INSERT|UPDATE)/.test(q.text)),false);h.db.close();
});
test('malformed or non-object request fields remain a no-op, not a bulk clear',async()=>{
 const h=await backend(),before=h.rows();for(const body of [{},null,[],{fields:null},{fields:[]},{fields:'tone'},{fields:1}]){await h.request('PUT',body);assert.deepEqual(h.rows(),before);}
 for(const raw of ['{','not json','']){await h.request('PUT',{},'/api/buzzy/profile',raw);assert.deepEqual(h.rows(),before);}h.db.close();
});
test('empty and whitespace-only strings explicitly clear, including aliases and missing defaults',async()=>{
 const h=await backend();await h.service.saveProfile(h.sql,'owner',{activity:'Old activity'});
 const r=await h.request('PUT',{fields:{tone:' \n\t\u00a0 ',activity:'',audience:''}});assert.deepEqual(r.data.cleared,['tone','primary_activity','audience']);
 assert.equal(r.data.profile.fields.tone,undefined);assert.equal(r.data.profile.fields.primary_activity,undefined);assert.equal(h.rows().some(r=>r.user_id==='owner'&&r.job_id===null&&r.value===''),false);h.db.close();
});
test('unknown and sensitive-looking fields cannot clear any record or become new profile fields',async()=>{
 const h=await backend(),before=h.rows();const fields=JSON.parse('{"tax_jurisdiction":"","license":"","consent":"","user_id":"foreign","companyId":"co_foreign","profile_tone":"","__proto__":""}');
 const r=await h.request('PUT',{fields});assert.deepEqual(r.data.rejected,Object.keys(fields));assert.deepEqual(h.rows(),before);h.db.close();
});
test('owner clear cannot touch foreign profiles, other account facts, jobs or company records',async()=>{
 const h=await backend(),before=h.rows(),other=h.snapshotOtherTables();
 await h.request('PUT',{userId:'foreign',user_id:'foreign',companyId:'co_foreign',jobId:'job_foreign',fields:{tone:''}});
 assert.deepEqual(h.rows(),before.filter(r=>!(r.user_id==='owner'&&r.job_id===null&&r.key==='profile_tone')));
 assert.equal(h.snapshotOtherTables(),other);h.as('foreign');assert.equal((await h.request('GET')).data.profile.fields.tone.value,'Foreign tone');h.db.close();
});
test('signed-out GET/PUT refuse before any SQL or mutation',async()=>{
 const h=await backend(),before=h.rows();h.as(null);for(const method of ['GET','PUT']){const r=await h.request(method);assert.equal(r.status,401);assert.equal(r.data.code,'signed_out');}
 assert.equal(h.queries.length,0);assert.deepEqual(h.rows(),before);h.db.close();
});
test('all profile defaults can be cleared without touching snapshots and hasProfile becomes false',async()=>{
 const h=await backend();const r=await h.request('PUT',{fields:{tone:'',business_name:''}});assert.equal(r.data.profile.hasProfile,false);assert.deepEqual(r.data.profile.fields,{});
 assert.equal(h.rows().filter(r=>r.job_id!==null&&r.key==='profile_tone').length,3);assert.ok(h.rows().some(r=>r.key==='profile_future_key'));h.db.close();
});
test('idempotent repeated clear removes legacy duplicates but never adds blank rows',async()=>{
 const h=await backend();h.insert('owner',null,'profile_tone','Duplicate legacy');const expected=h.rows().filter(r=>!(r.user_id==='owner'&&r.job_id===null&&r.key==='profile_tone'));
 await h.request();assert.deepEqual(h.rows(),expected);await h.request();assert.deepEqual(h.rows(),expected);h.db.close();
});
test('mixed partial update clears one default, sets Unicode and preserves omitted values',async()=>{
 const h=await backend();const text='日本語 – Café 🐝 e\u0301\nمرحبا & <literal>';const before=h.rows().find(r=>r.key==='profile_business_name');
 const r=await h.request('PUT',{fields:{tone:'',audience:'  '+text+'  '}});assert.deepEqual(r.data.saved,['audience']);assert.deepEqual(r.data.cleared,['tone']);assert.equal(r.data.profile.fields.audience.value,text);
 assert.deepEqual(h.rows().find(r=>r.id===before.id),before);h.db.close();
});
test('clear does not rewrite prior reused job snapshots and later reuse skips the removed default',async()=>{
 const h=await backend();await h.request('POST',{jobId:'job_a',keys:['tone','business_name']},'/api/buzzy/profile/reuse');
 const before=h.rows().filter(r=>r.job_id!==null),other=h.snapshotOtherTables();await h.request();
 assert.deepEqual(h.rows().filter(r=>r.job_id!==null),before);const r=await h.request('POST',{jobId:'job_b',keys:['tone']},'/api/buzzy/profile/reuse');assert.deepEqual(r.data.reused,[]);assert.deepEqual(r.data.skipped,['tone']);
 assert.deepEqual(h.rows().filter(r=>r.job_id!==null),before);assert.equal(h.snapshotOtherTables(),other);h.db.close();
});
test('present blank versus missing form control has distinct request semantics',async()=>{
 const h=await backend(),f=await ui(h);f.missing('business_name');f.set('tone','');const original=h.rows().find(r=>r.key==='profile_business_name');await f.click();
 assert.equal(Object.hasOwn(f.requests.at(-1).body.fields,'business_name'),false);assert.equal(f.requests.at(-1).body.fields.tone,'');assert.deepEqual(h.rows().find(r=>r.id===original.id),original);h.db.close();
});
test('untouched unset fields stay omitted even if another save populated them after this load',async()=>{
 const h=await backend(),f=await ui(h);await h.request('PUT',{fields:{audience:'Saved elsewhere'}});const original=h.rows().find(r=>r.key==='profile_audience');f.set('tone','');await f.click();
 assert.equal(Object.hasOwn(f.requests.at(-1).body.fields,'audience'),false);assert.deepEqual(h.rows().find(r=>r.id===original.id),original);assert.equal(f.profile().fields.audience.value,'Saved elsewhere');h.db.close();
});
test('actual render/edit/save preserves Unicode and literal HTML entity text',async()=>{
 const h=await backend(),text='日本語 🐝 e\u0301 &copy; &lt; <textarea> & café';await h.request('PUT',{fields:{tone:text}});const f=await ui(h);
 assert.equal(f.element('f_tone').value,text);assert.match(f.app.innerHTML,/&amp;copy;/);await f.click();assert.equal((await h.request('GET')).data.profile.fields.tone.value,text);h.db.close();
});
test('successful save leaves visible feedback in the newly rendered form',async()=>{
 const h=await backend(),f=await ui(h),old=f.element('saveStatus');f.set('tone','New tone');await f.click();
 assert.equal(old.isConnected,false);assert.equal(f.element('saveStatus').textContent,'Saved.');assert.equal(f.element('saveStatus').className,'status ok');assert.equal(f.element('save').disabled,false);h.db.close();
});
for(const mode of ['network','HTTP500','HTTP401','invalid-json','missing-profile','invalid-profile'])test(`UI ${mode} keeps blank intent and other entries for retry without claiming rollback`,async()=>{
 const h=await backend(),f=await ui(h);f.set('tone','');f.set('audience','New audience');const before=h.rows(),old=f.element('f_tone');
 f.hook(async()=>{
  if(mode==='network')throw Error('synthetic transport');
  if(mode==='invalid-json')return {ok:true,json:async()=>{throw Error('synthetic parser');}};
  const data=mode==='missing-profile'?{}:mode==='invalid-profile'?{profile:{fields:{tone:null},hasProfile:true}}:{error:'Synthetic denied'};
  return {ok:!mode.startsWith('HTTP'),status:mode==='HTTP401'?401:500,json:async()=>data};
 });await f.click();assert.equal(f.element('f_tone'),old);assert.equal(f.element('f_tone').value,'');assert.equal(f.element('f_audience').value,'New audience');assert.equal(f.element('save').disabled,false);
 assert.equal(f.element('saveStatus').className,'status err');assert.match(f.element('saveStatus').textContent,/Could not confirm/);assert.match(f.element('saveStatus').textContent,/retry Save/);assert.doesNotMatch(f.element('saveStatus').textContent,/nothing changed|Synthetic/);assert.deepEqual(h.rows(),before);
 f.hook(null);await f.click();assert.equal(f.profile().fields.tone,undefined);assert.equal(f.profile().fields.audience.value,'New audience');assert.equal(f.element('saveStatus').textContent,'Saved.');h.db.close();
});
test('pending save locks its field snapshot and duplicate clicks produce one PUT',async()=>{
 const h=await backend(),f=await ui(h),wait=deferred();f.set('tone','');f.hook(async(request,next)=>{await wait.promise;return next();});
 const saving=f.click();assert.equal(f.element('f_tone').disabled,true);assert.equal(f.element('save').disabled,true);await f.click();assert.equal(f.requests.filter(r=>r.method==='PUT').length,1);
 wait.resolve();await saving;assert.equal(f.element('f_tone').disabled,false);assert.equal(f.element('save').disabled,false);assert.equal(f.profile().fields.tone,undefined);h.db.close();
});
for(const fail of [false,true])test(`late ${fail?'failed':'successful'} save after page removal cannot repaint a different page`,async()=>{
 const h=await backend(),f=await ui(h),wait=deferred();f.set('tone','');f.hook(async(request,next)=>{await wait.promise;if(fail)throw Error('late failure');return next();});
 const saving=f.click(),replacement=f.detach();wait.resolve();await saving;assert.equal(replacement.innerHTML,'New page');assert.equal(f.profile().fields.tone.value,'Obsolete tone');h.db.close();
});
test('clear storage failure before deletion leaves rows untouched and retry succeeds',async()=>{
 const h=await backend(),f=await ui(h),before=h.rows();f.missing('business_name');f.set('tone','');h.fail((text,params)=>{if(text.startsWith('DELETE')&&params[1]==='profile_tone')throw Error('synthetic delete failure');});
 await f.click();assert.deepEqual(h.rows(),before);assert.equal(f.element('f_tone').value,'');assert.equal(f.element('saveStatus').className,'status err');h.fail(null);await f.click();assert.equal(f.profile().fields.tone,undefined);h.db.close();
});
test('existing nontransactional partial failure is honest and retries desired clear/set values',async()=>{
 const h=await backend(),f=await ui(h);f.set('business_name','');f.set('tone','Replacement tone');h.fail((text,params)=>{if(text.startsWith('INSERT')&&params[1]==='profile_tone')throw Error('synthetic later insert failure');});
 await f.click();assert.equal(h.rows().some(r=>r.user_id==='owner'&&r.job_id===null&&r.key==='profile_business_name'),false,'earlier explicit clear may already commit');
 assert.equal(f.element('f_business_name').value,'');assert.equal(f.element('f_tone').value,'Replacement tone');assert.match(f.element('saveStatus').textContent,/Could not confirm/);
 h.fail(null);await f.click();assert.equal(f.profile().fields.business_name,undefined);assert.equal(f.profile().fields.tone.value,'Replacement tone');h.db.close();
});
test('lost response after committed clear keeps intent; retry does not resurrect or duplicate',async()=>{
 const h=await backend(),f=await ui(h);f.set('tone','');f.hook(async(request,next)=>{await next();throw Error('response lost after commit');});await f.click();
 assert.equal((await h.request('GET')).data.profile.fields.tone,undefined);assert.equal(f.element('f_tone').value,'');assert.equal(f.element('saveStatus').className,'status err');
 f.hook(null);await f.click();assert.equal(f.profile().fields.tone,undefined);assert.equal(h.rows().filter(r=>r.user_id==='owner'&&r.job_id===null&&r.key==='profile_business_name').length,1);h.db.close();
});
test('actual route readback failure after committed clear is unconfirmed, not rolled back',async()=>{
 const h=await backend(),f=await ui(h);f.set('tone','');h.fail(text=>{if(text.startsWith('SELECT key, value'))throw Error('synthetic readback failure');});await f.click();
 assert.equal(h.rows().some(r=>r.user_id==='owner'&&r.job_id===null&&r.key==='profile_tone'),false);assert.equal(f.element('saveStatus').className,'status err');assert.equal(f.element('f_tone').value,'');
 h.fail(null);await f.click();assert.equal(f.profile().fields.tone,undefined);assert.equal(f.element('saveStatus').textContent,'Saved.');h.db.close();
});

// Regression from the real H3/PGlite acceptance gate: LIKE 'profile_%'
// matches profileXtone because underscore is a wildcard. Slicing the key then
// mislabels that unrelated row as tone, including after the real tone clears.
const prefixDecoys=['profileXtone','profile-tone','profile%tone','profile tone','profile\\tone','profileétone','Profile_tone','profile__tone','profile_tone_extra','profile_tone ','profile_activity','profile_future_key'];
function seedPrefixDecoys(h){for(const key of prefixDecoys)h.insert('owner',null,key,'Keep unrelated '+key);}
const ownCanonical=(row,keys)=>row.user_id==='owner'&&row.job_id===null&&keys.includes(row.key);

test('literal profile keys: actual visible clear cannot reveal a prefix-lookalike value',async()=>{
 const h=await backend();h.insert('owner',null,'profileXtone','Keep prefix lookalike');const unrelated=h.rows().find(r=>r.key==='profileXtone'),other=h.snapshotOtherTables();
 const f=await ui(h);assert.equal(f.element('f_tone').value,'Obsolete tone');f.set('tone','');await f.click();
 assert.deepEqual(f.requests.at(-1).body.fields.tone,'');assert.equal(f.profile().fields.tone,undefined);assert.equal(f.element('f_tone').value,'');assert.equal(f.element('r_tone').disabled,true);
 assert.equal(f.element('saveStatus').textContent,'Saved.');assert.deepEqual(h.rows().find(r=>r.id===unrelated.id),unrelated);assert.equal(h.snapshotOtherTables(),other);
 await f.context.loadProfile();f.context.render();assert.equal(f.element('f_tone').value,'');assert.equal((await h.request('GET')).data.profile.fields.tone,undefined);h.db.close();
});
test('literal profile keys: only exact closed storage keys enter the SQL read and projection',async()=>{
 const h=await backend();seedPrefixDecoys(h);const values=Object.fromEntries(Array.from(h.service.PROFILE_KEYS,id=>[id,'Canonical '+id+' 日本語 &copy;']));
 await h.service.saveProfile(h.sql,'owner',values);const before=h.rows(),other=h.snapshotOtherTables(),p=plain(await h.service.getProfile(h.sql,'owner'));
 assert.deepEqual(Object.fromEntries(Object.entries(p.fields).map(([id,field])=>[id,field.value])),values);assert.equal(p.hasProfile,true);
 for(const [id,field] of Object.entries(p.fields)){assert.equal(field.origin,'you set this');assert.equal(field.updatedAt,before.find(row=>ownCanonical(row,['profile_'+id])).updated_at);}
 const read=h.queries.at(-1),rows=await h.sql.query(read.text,read.params);assert.deepEqual(rows.map(r=>r.key).sort(),Object.keys(values).map(id=>'profile_'+id).sort());
 assert.deepEqual(h.rows(),before);assert.equal(h.snapshotOtherTables(),other);h.db.close();
});
test('literal profile keys: no canonical rows means empty profile despite decoys, foreign owners and job snapshots',async()=>{
 const h=await backend();seedPrefixDecoys(h);h.db.prepare("DELETE FROM buzzy_user_memory WHERE user_id='owner' AND job_id IS NULL AND key IN ('profile_tone','profile_business_name')").run();
 const before=h.rows(),other=h.snapshotOtherTables();const r=await h.request('GET');assert.equal(r.status,200);assert.deepEqual(r.data.profile,{fields:{},hasProfile:false});
 assert.deepEqual(h.rows(),before);assert.equal(h.snapshotOtherTables(),other);h.as('foreign');assert.equal((await h.request('GET')).data.profile.fields.tone.value,'Foreign tone');h.db.close();
});
test('literal profile keys: every closed field rejects a same-length prefix lookalike',async()=>{
 const h=await backend();h.db.prepare("DELETE FROM buzzy_user_memory WHERE user_id='owner' AND job_id IS NULL AND key IN ('profile_tone','profile_business_name')").run();
 for(const id of h.service.PROFILE_KEYS)h.insert('owner',null,'profileX'+id,'Not a profile '+id);
 const before=h.rows();assert.deepEqual(plain(await h.service.getProfile(h.sql,'owner')),{fields:{},hasProfile:false});assert.deepEqual(h.rows(),before);h.db.close();
});
test('literal profile keys: repeated explicit clear deletes canonical rows only and cannot expose unrelated values',async()=>{
 const h=await backend();seedPrefixDecoys(h);h.insert('owner',null,'profile_tone','Legacy duplicate');const before=h.rows(),other=h.snapshotOtherTables();
 const expected=before.filter(row=>!ownCanonical(row,['profile_tone']));
 for(let i=0;i<2;i++){const r=await h.request();assert.deepEqual(r.data.cleared,['tone']);assert.equal(r.data.profile.fields.tone,undefined);assert.deepEqual(h.rows(),expected);}
 assert.equal(h.snapshotOtherTables(),other);h.db.close();
});
test('literal profile keys: alias clear leaves unknown stored alias and prefix variants untouched',async()=>{
 const h=await backend();h.insert('owner',null,'profile_activity','Unrelated stored alias');h.insert('owner',null,'profileXprimary_activity','Unrelated variant');
 await h.service.saveProfile(h.sql,'owner',{activity:'Canonical activity'});const before=h.rows();
 const r=await h.request('PUT',{fields:{activity:'',profileXprimary_activity:'',profile_activity:''}});
 assert.deepEqual(r.data.cleared,['primary_activity']);assert.deepEqual(r.data.rejected,['profileXprimary_activity','profile_activity']);assert.equal(r.data.profile.fields.primary_activity,undefined);
 assert.deepEqual(h.rows(),before.filter(row=>!ownCanonical(row,['profile_primary_activity'])));h.db.close();
});
test('literal profile keys: clear cannot reintroduce a lookalike through later default reuse',async()=>{
 const h=await backend();seedPrefixDecoys(h);await h.request();const before=h.rows(),other=h.snapshotOtherTables();
 const r=await h.request('POST',{jobId:'job_b',keys:['tone','activity','future_key']},'/api/buzzy/profile/reuse');assert.deepEqual(r.data.reused,[]);assert.deepEqual(r.data.skipped,['tone','activity','future_key']);
 assert.deepEqual(h.rows(),before);assert.equal(h.snapshotOtherTables(),other);
 const valid=await h.request('POST',{jobId:'job_b',keys:['business_name']},'/api/buzzy/profile/reuse');assert.deepEqual(valid.data.reused,['business_name']);assert.equal(h.rows().find(row=>row.user_id==='owner'&&row.job_id==='job_b'&&row.key==='profile_business_name').value,'Owned business');
 for(const row of before)assert.deepEqual(h.rows().find(current=>current.id===row.id),row);h.db.close();
});
test('literal profile keys: decoy-only form stays unset and Save never copies unrelated text into canonical storage',async()=>{
 const h=await backend();h.db.prepare("DELETE FROM buzzy_user_memory WHERE user_id='owner' AND job_id IS NULL AND key IN ('profile_tone','profile_business_name')").run();seedPrefixDecoys(h);
 const before=h.rows(),f=await ui(h);assert.equal(f.profile().hasProfile,false);assert.equal(f.element('f_tone').value,'');assert.equal(f.element('r_tone').disabled,true);await f.click();
 assert.deepEqual(f.requests.at(-1).body.fields,{});assert.deepEqual(h.rows(),before);assert.equal(f.profile().hasProfile,false);h.db.close();
});
test('literal profile keys: clear-all response and reload remain empty without deleting unrelated records',async()=>{
 const h=await backend();seedPrefixDecoys(h);const before=h.rows();
 const r=await h.request('PUT',{fields:Object.fromEntries(Array.from(h.service.PROFILE_KEYS,id=>[id,'']))});assert.equal(r.data.profile.hasProfile,false);assert.deepEqual(r.data.profile.fields,{});
 const expected=before.filter(row=>!ownCanonical(row,Array.from(h.service.PROFILE_KEYS,id=>'profile_'+id)));assert.deepEqual(h.rows(),expected);assert.deepEqual((await h.request('GET')).data.profile,{fields:{},hasProfile:false});h.db.close();
});
test('literal profile keys: failed readback and retry preserve blank intent without widening the read',async()=>{
 const h=await backend();h.insert('owner',null,'profileXtone','Keep prefix lookalike');const unrelated=h.rows().find(r=>r.key==='profileXtone'),f=await ui(h);f.set('tone','');
 h.fail(text=>{if(text.startsWith('SELECT key, value'))throw Error('Synthetic prefix-safe readback failure');});await f.click();
 assert.equal(f.element('saveStatus').className,'status err');assert.equal(f.element('f_tone').value,'');assert.equal(h.rows().some(row=>ownCanonical(row,['profile_tone'])),false);assert.deepEqual(h.rows().find(row=>row.id===unrelated.id),unrelated);
 h.fail(null);await f.click();assert.equal(f.element('saveStatus').textContent,'Saved.');assert.equal(f.profile().fields.tone,undefined);assert.equal(f.element('f_tone').value,'');assert.deepEqual(h.rows().find(row=>row.id===unrelated.id),unrelated);h.db.close();
});
