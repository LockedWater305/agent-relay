#!/usr/bin/env node
// Real service and route with a transactional SQL double; no providers/filesystem
// data, dependencies or network. Native PGLite integration remains a separate gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
const ROOT=resolve(process.env.BZ_VAULT_TEST_ROOT || fileURLToPath(new URL('..',import.meta.url)));
const serviceSource=stripTypeScriptTypes(readFileSync(new URL('../src/lib/buzzy/libraryVault.ts',import.meta.url),'utf8'));
const context=vm.createContext({Buffer,TextDecoder,URL,Headers,Request,Response,Uint8Array});
const service=new vm.SourceTextModule(serviceSource,{context});
await service.link(()=>new vm.SyntheticModule(['createHash','randomUUID'],function(){this.setExport('createHash',createHash);this.setExport('randomUUID',randomUUID)},{context}));
await service.evaluate();
const actual=service.namespace;
const STORE='00000000-0000-4000-8000-000000000001';
const api={...Object.fromEntries(Object.keys(actual).map(key=>[key,actual[key]])),
 storeVaultBatch:(sql,user,body)=>actual.storeVaultBatch(sql,user,{expectedStoreId:STORE,expectedGeneration:'0',...body}),
};
const sample=(md='one',more={})=>({jobId:'job_synthetic',document:{name:'report-v1.md',md,createdAt:1,updatedAt:2,...more}});
const normal=value=>JSON.parse(JSON.stringify(value));
function database(){
 const rows=[]; let id=0n;let storeId=STORE;const generations=new Map();const owners=new Map();let queries=0;
 const sql={query:async(text,params)=>{
  queries++;
  if(text.includes('INSERT INTO buzzy_library_vault_store')){storeId??=params[0];return [{store_id:storeId}];}
  if(text.includes('INSERT INTO buzzy_library_vault_owner')){generations.set(params[0],generations.get(params[0])??'0');return [{generation:generations.get(params[0])}];}
  if(text.includes('SELECT * FROM buzzy_library_vault_import')){
   const [owner,expectedStore,expectedGeneration,json]=params;const incoming=JSON.parse(json);
   const generation=generations.get(owner)??'0';
   if(expectedStore!==storeId||expectedGeneration!==generation)return [{result_code:'vault_store_changed'}];
   if(incoming.some(x=>owners.has(x.job_id)&&owners.get(x.job_id)!==owner))return [{result_code:'vault_job_conflict'}];
   return incoming.map(x=>{
    let row=rows.find(r=>r.user_id===owner&&r.generation===generation&&r.record_hash===x.record_hash);
    if(!row){row={id:String(++id),user_id:owner,generation,result_code:'stored',...x};rows.push(row);}
    return structuredClone(row);
   });
  }
  if(text.includes('SELECT buzzy_library_vault_delete')){
   const owner=params[0];const removed=rows.filter(r=>r.user_id===owner).length;
   for(let i=rows.length-1;i>=0;i--)if(rows[i].user_id===owner)rows.splice(i,1);
   generations.set(owner,String(BigInt(generations.get(owner)??'0')+1n));return [{deleted:String(removed)}];
  }
  if(text.includes('WITH candidates AS')){
   assert.match(text,/user_id = \$1 AND id > \$2::bigint/);
   assert.match(text,/ORDER BY bounded\.id ASC/,'sort native bigint, not cast text alias');
   const [owner,after,limit,cap,generation]=params;
   const selected=rows.filter(r=>r.user_id===owner&&r.generation===generation&&BigInt(r.id)>BigInt(after)).slice(0,limit);
   let bytes=0;return selected.filter((r,i)=>{bytes+=r.record_bytes+512;return !i||bytes<=cap;}).map(r=>structuredClone(r));
  }
  if(text.includes('SELECT EXISTS'))return [{present:rows.some(r=>r.user_id===params[0]&&r.generation===params[2]&&BigInt(r.id)>BigInt(params[1]))}];
  throw Error('Unexpected SQL '+text);
 }};
 return {sql,rows,owners,generations,get queries(){return queries;},get storeId(){return storeId;},setId(value){id=BigInt(value);}};
}
async function route({local=true,token="synthetic-launch-token",user='local_owner',method='POST',body={records:[sample()],expectedStoreId:STORE,expectedGeneration:'0'},db=database(),url='/api/buzzy/library-vault',request,failStorage=false}={}){
 const source=stripTypeScriptTypes(readFileSync(resolve(ROOT,'src/lib/buzzy/chat.nitro.ts'),'utf8'));
 let authCalls=0,dbCalls=0;
 const deps={
  h3:{defineEventHandler:fn=>fn,getMethod:e=>e.req.method,setResponseHeader:(e,k,v)=>{(e.responseHeaders??=new Headers()).set(k,v);},setResponseStatus:(e,n)=>{e.status=n;},getHeader:(e,k)=>e.req.headers.get(k)},
  '../runtime':{isLocalRuntime:()=>local},'../local-owner':{LOCAL_OWNER_ID:'local_owner',localToken:()=>token},
  '@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>{authCalls++;return user?{id:user}:null;}},
  '@/lib/db':{getSql:async()=>{dbCalls++;if(failStorage)throw Error('synthetic storage failure');return db.sql;}},
  './libraryVault':actual,
 };
 const module=new vm.SourceTextModule(source,{context});
 await module.link(specifier=>{
  const match=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].find(m=>m[2]===specifier);
  assert.ok(match,`named imports for ${specifier}`);
  const names=match[1].split(',').map(s=>s.trim()).filter(Boolean);
  return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[specifier]?.[name]??(()=>{throw Error('Unexpected dependency '+specifier+'.'+name);}));},{context});
 });
 await module.evaluate();
 const event={path:url,status:200,req:request??new Request('http://127.0.0.1'+url,{method,...(method==='POST'?{body:JSON.stringify(body)}:{})})};
 const result=await module.namespace.default(event);
 return {result:normal(result),status:event.status,headers:event.responseHeaders,db,authCalls,dbCalls};
}

test('same-name versions append; exact replay and JSON key order deduplicate without replacing content',async()=>{
 const db=database();const first=await api.storeVaultBatch(db.sql,'local_owner',{records:[sample()]});
 const second=await api.storeVaultBatch(db.sql,'local_owner',{records:[sample('two')]});
 const replay=await api.storeVaultBatch(db.sql,'local_owner',{records:[{document:{updatedAt:2,md:'one',createdAt:1,name:'report-v1.md'},jobId:'job_synthetic'}]});
 assert.equal(db.rows.length,2);assert.equal(first.stored[0].id,replay.stored[0].id);assert.notEqual(first.stored[0].id,second.stored[0].id);
 assert.deepEqual(db.rows.map(r=>r.document.md),['one','two']);
});
test('missing timestamps and differing exact metadata survive; duplicate records in one batch have one acknowledgment',async()=>{
 const db=database();const minimal={jobId:'orphan',document:{name:'old.md',md:''}};
 const result=await api.storeVaultBatch(db.sql,'local_owner',{records:[minimal,minimal,sample('one',{updatedAt:3})]});
 assert.equal(result.count,2);assert.deepEqual(normal(result.stored[0].document),minimal.document);
 assert.equal(result.stored[1].document.updatedAt,3);
});
test('orphan legacy folders import, but a foreign live job blocks the entire batch',async()=>{
 const db=database();db.owners.set('foreign','other-owner');
 await assert.rejects(api.storeVaultBatch(db.sql,'local_owner',{records:[sample(),{...sample(),jobId:'foreign'}]}),e=>e.code==='vault_job_conflict');
 assert.equal(db.rows.length,0);
 await api.storeVaultBatch(db.sql,'local_owner',{records:[{...sample(),jobId:'orphan'}]});assert.equal(db.rows.length,1);
});
test('invalid late record prevents all SQL and preserves unknown metadata by refusing it',async()=>{
 for(const invalid of [sample('x',{extra:'keep me'}),{...sample(),userId:'victim'},sample('x',{createdAt:null}),sample('x',{updatedAt:-1}),sample('\0'),sample('\ud800'),{jobId:'',document:{name:'x',md:'x'}}]){
  const db=database();await assert.rejects(api.storeVaultBatch(db.sql,'local_owner',{records:[sample(),invalid]}));assert.equal(db.queries,0);
 }
});
test('UTF8 byte limits, empty/overfull batches and timestamps fail before SQL',async()=>{
 for(const records of [[],Array.from({length:51},()=>sample()),[sample('😀'.repeat(api.VAULT_RECORD_BYTES/4))],[sample('x',{createdAt:Infinity})]]){
  const db=database();await assert.rejects(api.storeVaultBatch(db.sql,'local_owner',{records}));assert.equal(db.queries,0);
 }
});
test('bounded streamed body rejects missing/false content length, invalid UTF8 and bad JSON',async()=>{
 const size=api.VAULT_REQUEST_BYTES;
 await assert.rejects(api.readVaultBody(new Request('http://localhost',{method:'POST',headers:{'content-length':String(size+1)},body:'{}'})),e=>e.status===413);
 let canceled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(size));c.enqueue(new Uint8Array(1));},cancel(){canceled=true;}});
 await assert.rejects(api.readVaultBody(new Request('http://localhost',{method:'POST',headers:{'content-length':'1'},body:stream,duplex:'half'})),e=>e.status===413);
 assert.equal(canceled,true);
 for(const body of [new Uint8Array([0xff]),'{'])await assert.rejects(api.readVaultBody(new Request('http://localhost',{method:'POST',body})),e=>e.code==='bad_vault_json');
});
test('pagination returns more than 200 records, scoped to owner, with unrounded IDs',async()=>{
 const db=database();db.setId('9007199254740993');
 for(let n=0;n<205;n++)await api.storeVaultBatch(db.sql,'local_owner',{records:[sample(String(n))]});
 await api.storeVaultBatch(db.sql,'other-owner',{records:[sample('private')]});
 const seen=[];let after='0';
 for(;;){const page=await api.listVaultPage(db.sql,'local_owner',{after,limit:50});seen.push(...page.records);if(page.done)break;assert.ok(BigInt(page.nextCursor)>BigInt(after));after=page.nextCursor;}
 assert.equal(seen.length,205);assert.equal(new Set(seen.map(x=>x.id)).size,205);assert.equal(seen[0].id,'9007199254740994');assert.equal(seen.some(x=>x.document.md==='private'),false);
});
test('byte-capped pages progress without truncating large records',async()=>{
 const db=database();for(let n=0;n<3;n++)await api.storeVaultBatch(db.sql,'local_owner',{records:[sample(String(n)+'x'.repeat(4*1024*1024))]});
 const page=await api.listVaultPage(db.sql,'local_owner',{after:'0',limit:50});assert.equal(page.records.length,1);assert.equal(page.done,false);
 const last=await api.listVaultPage(db.sql,'local_owner',{after:'2',limit:50});assert.equal(last.records.length,1);assert.equal(last.done,true);
});
test('cursor and page limits reject malformed, negative, fractional and overflow input',()=>{
 for(const query of ['after=-1','after=1.5','after=01','after=9223372036854775808','limit=0','limit=51','limit=1.5'])assert.throws(()=>api.vaultPageOptions('/?'+query));
 assert.deepEqual(normal(api.vaultPageOptions('/?after=9007199254740994&limit=1')),{after:'9007199254740994',limit:1});
});
test('route authenticates local owner and persists/reloads synthetic history',async()=>{
 const db=database();const post=await route({db});assert.equal(post.status,200);assert.equal(post.headers.get('cache-control'),'no-store');assert.equal(post.result.stored[0].document.md,'one');
 const get=await route({db,method:'GET'});assert.equal(get.result.records.length,1);assert.equal(get.result.done,true);
});
test('hosted mode and missing/foreign local identity are refused before reading body or DB',async()=>{
 const unread={method:'POST',headers:new Headers(),get body(){throw Error('unauthorized body touched');}};
 for(const options of [{local:false,user:'local_owner'},{user:null},{user:'other-owner'}]){
  const result=await route({...options,request:unread});assert.equal(result.dbCalls,0);assert.equal(result.db.queries,0);assert.equal(result.status,options.local===false?404:401);
 }
});
test('route names malformed payload and storage failure without leaking internals',async()=>{
 const bad=await route({body:{records:[sample('x',{extra:1})]}});assert.equal(bad.status,400);assert.equal(bad.dbCalls,0);
 const failed=await route({failStorage:true});assert.equal(failed.status,503);assert.equal(failed.result.code,'vault_unavailable');assert.doesNotMatch(failed.result.error,/synthetic storage/);
 const method=await route({method:'DELETE'});assert.equal(method.status,405);assert.equal(method.dbCalls,0);
});
test('export uses safe ID-based paths and deletion includes the new owner-scoped table',()=>{
 const source=readFileSync(resolve(ROOT,'src/lib/buzzy/portability.ts'),'utf8');
 assert.match(source,/SELECT buzzy_library_vault_delete\(\$1\)::text AS deleted/);
 assert.match(source,/SELECT id::text, record_hash, job_id, document FROM buzzy_library_vault WHERE user_id = \$1 ORDER BY buzzy_library_vault.id ASC/);
 assert.match(source,/`library-history\/\$\{row.id\}\.md`/);
 assert.match(source,/library-history\/manifest.json/);
});

test('store identity is durable, returned on pages/acks, and rejects a different expected database',async()=>{
 const db=database();const metadata=await route({db,method:'GET',url:'/api/buzzy/library-vault?metadata=1'});
 assert.equal(metadata.status,200);assert.equal(metadata.result.storeId,db.storeId);
 const first=await api.storeVaultBatch(db.sql,'local_owner',{records:[sample()],expectedStoreId:db.storeId});
 assert.equal(first.storeId,db.storeId);
 const page=await api.listVaultPage(db.sql,'local_owner',{after:'0',limit:50});assert.equal(page.storeId,db.storeId);
 const before=db.rows.length;
 await assert.rejects(api.storeVaultBatch(db.sql,'local_owner',{records:[sample('other')],expectedStoreId:randomUUID()}),e=>e.code==='vault_store_changed'&&e.status===409);
 assert.equal(db.rows.length,before);
 db.rows.length=0; // Account deletion removes content, not singleton identity.
 assert.equal(await api.getVaultStoreId(db.sql),metadata.result.storeId);
});

test('manual local mode without a configured per-launch token cannot migrate',async()=>{
 const unread={method:'POST',headers:new Headers(),get body(){throw Error('unprotected body touched');}};
 const result=await route({token:null,request:unread});assert.equal(result.status,503);assert.equal(result.result.code,'local_auth_required');assert.equal(result.authCalls,0);assert.equal(result.dbCalls,0);
});

test('POST requires store and generation, and stale generation cannot resurrect deleted history',async()=>{
 const db=database();
 await assert.rejects(actual.storeVaultBatch(db.sql,'local_owner',{records:[sample()]}),e=>e.code==='bad_vault_store');
 await api.storeVaultBatch(db.sql,'local_owner',{records:[sample()]});
 await db.sql.query('SELECT buzzy_library_vault_delete($1)::text AS deleted',['local_owner']);
 const metadata=await api.getVaultMetadata(db.sql,'local_owner');assert.equal(metadata.generation,'1');assert.equal(metadata.storeId,STORE);
 await assert.rejects(api.storeVaultBatch(db.sql,'local_owner',{records:[sample()]}),e=>e.code==='vault_store_changed');assert.equal(db.rows.length,0);
 // Explicitly rebound recovery may import into the new generation.
 await api.storeVaultBatch(db.sql,'local_owner',{records:[sample()],expectedGeneration:'1'});assert.equal(db.rows.length,1);assert.equal(db.rows[0].generation,'1');
});
test('database routines serialize import and deletion under one owner lock without privilege escalation',()=>{
 const migration=readFileSync(new URL('../migrations/0057_buzzy_library_vault.sql',import.meta.url),'utf8');
 assert.equal((migration.match(/LANGUAGE plpgsql VOLATILE SECURITY INVOKER/g)||[]).length,2);
 assert.match(migration,/WHERE o.user_id = p_user_id FOR UPDATE/g);
 assert.match(migration,/generation = generation \+ 1/);
 assert.match(migration,/current_generation <> p_generation/);
 assert.doesNotMatch(migration,/SECURITY DEFINER|EXECUTE\s/i);
});

async function portabilityHarness(local) {
 const files=new Map(),queries=[];
 class FakeZip {
  file(path,value){files.set(path,value);return this;}
  folder(path){return {file:(name,value)=>files.set(path+'/'+name,value)};}
  async generateAsync(){return new Uint8Array();}
 }
 const ctx=vm.createContext({Uint8Array});
 const module=new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(resolve(ROOT,'src/lib/buzzy/portability.ts'),'utf8')),{context:ctx});
 await module.link(specifier=>new vm.SyntheticModule(specifier==='jszip'?['default']:['isLocalRuntime'],function(){this.setExport(specifier==='jszip'?'default':'isLocalRuntime',specifier==='jszip'?FakeZip:()=>local)},{context:ctx}));
 await module.evaluate();
 const sql=async()=>[];
 sql.query=async(statement,params)=>{queries.push({statement,params});return statement.includes('buzzy_library_vault_delete')?[{deleted:'2'}]:[];};
 return {module:module.namespace,files,queries,sql};
}
test('hosted portability adds no vault query, archive manifest, or deletion tombstone',async()=>{
 const h=await portabilityHarness(false);
 await h.module.buildExportBundle(h.sql,'synthetic-owner');
 assert.equal([...h.files.keys()].some(p=>p.startsWith('library-history/')),false);
 assert.equal(h.queries.length,0);
 const receipt=await h.module.deleteAccountData(h.sql,'synthetic-owner');
 assert.equal(Object.hasOwn(receipt,'buzzy_library_vault'),false);
 assert.equal(h.queries.some(q=>q.statement.includes('library_vault')),false);
 assert.ok(h.queries.some(q=>q.statement.includes('DELETE FROM buzzy_jobs')));
});
test('local vault tombstone is last, after every source account-data deletion',async()=>{
 const h=await portabilityHarness(true);
 await h.module.buildExportBundle(h.sql,'synthetic-owner');
 assert.ok(h.files.has('library-history/manifest.json'));
 assert.equal(h.queries.length,1);h.queries.length=0;
 const receipt=await h.module.deleteAccountData(h.sql,'synthetic-owner');
 assert.equal(receipt.buzzy_library_vault,2);
 assert.match(h.queries.at(-1).statement,/SELECT buzzy_library_vault_delete/);
 assert.equal(h.queries.filter(q=>q.statement.includes('buzzy_library_vault_delete')).length,1);
 assert.ok(h.queries.slice(0,-1).every(q=>q.statement.startsWith('DELETE FROM ')));
 assert.ok(h.queries.slice(0,-1).some(q=>q.statement.includes('DELETE FROM buzzy_jobs')));
 for(const q of h.queries)assert.deepEqual(normal(q.params),['synthetic-owner']);
});
test('failed source deletion does not expose a fresh vault generation',async()=>{
 const h=await portabilityHarness(true),query=h.sql.query;
 h.sql.query=async(statement,params)=>{if(statement.includes('DELETE FROM buzzy_jobs'))throw Error('source deletion failed');return query(statement,params);};
 await assert.rejects(h.module.deleteAccountData(h.sql,'synthetic-owner'),/source deletion failed/);
 assert.equal(h.queries.some(q=>q.statement.includes('buzzy_library_vault_delete')),false);
});
