// Exact chatLoop file-envelope block + Talk card + complete actual Nitro route.
// SQL runs in disposable SQLite with explicit JSON-driver adaptation. Original
// bodies/Word output are routing sentinels, not real Office packer acceptance.
// DOM/H3/auth/telemetry are synthetic. No provider, network or native execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const ROOT=resolve(process.env.BZ_OFFICE_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(ROOT,p),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
export const MIME={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
export const artifact=(format='xlsx',patch={})=>({filename:'synthetic.'+format,contentType:MIME[format],bytesB64:Buffer.from('SYNTHETIC ORIGINAL '+format+' BYTES').toString('base64'),...patch});
const helperPath='src/lib/buzzy/officeOriginal.ts';
async function loadHelper(ctx){
 if(!existsSync(resolve(ROOT,helperPath)))return null;
 const module=new vm.SourceTextModule(stripTypeScriptTypes(read(helperPath)),{context:ctx});
 await module.link(id=>{assert.equal(id,'node:crypto');return new vm.SyntheticModule(['createHash'],function(){this.setExport('createHash',createHash);},{context:ctx});});
 await module.evaluate();return module;
}
export async function envelope(raw,opts={}){
 const source=read('src/lib/buzzy/server.ts');
 const start=source.indexOf('    const renderedDoc = renderedDocument as '),end=source.indexOf('\n  }\n\n  // The player rides',start);
 assert.ok(start>0&&end>start);
 const ctx=vm.createContext({Buffer,renderedDocument:raw,materializedId:'doc_job_file',recordId:'job_file',baseTitle:'Synthetic title',response:{},documentIdForJob:id=>'doc_'+id,encodeURIComponent,...opts});
 const helper=await loadHelper(ctx);if(helper)Object.assign(ctx,helper.namespace);
 vm.runInContext(stripTypeScriptTypes(source.slice(start,end)),ctx);
 const talk=read('public/buzzy/talk.html'),a=talk.indexOf('    function renderFileCard(doc) {'),z=talk.indexOf('\n    }',a)+6;assert.ok(a>0&&z>a);
 vm.runInContext(talk.slice(a,z),ctx);
 const response=plain(ctx.response);return {...response,markup:response.document?ctx.renderFileCard(response.document):null};
}
export async function backend(t){
 const db=new DatabaseSync(':memory:'),queries=[],events=[],renderCalls=[];let user='owner',forbidden=0,readGate=null,readError=null;
 db.exec(`CREATE TABLE buzzy_jobs(id TEXT PRIMARY KEY,user_id TEXT,data TEXT);
 CREATE TABLE buzzy_documents(id TEXT PRIMARY KEY,user_id TEXT,job_id TEXT,title TEXT,type TEXT,status TEXT,current_version INTEGER,accepted_version INTEGER,expert TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE buzzy_document_versions(doc_id TEXT,version INTEGER,content TEXT,parent_version INTEGER,creator TEXT,expert TEXT,brief_revision TEXT,review TEXT,accepted_at TEXT,accepted_by TEXT,created_at TEXT);
 CREATE TABLE protected_rows(id TEXT,value TEXT);
 INSERT INTO protected_rows VALUES('keep','Unrelated café 日本語 & <text>');`);
 const seed=(id,owner,raw,approved)=>db.prepare('INSERT INTO buzzy_jobs VALUES(?,?,?)').run(id,owner,JSON.stringify({artifact:raw,approved,unrelated:'Keep original job fields'}));
 seed('job_file','owner',artifact(),true);seed('job_deck','owner',artifact('pptx'),true);seed('job_draft','owner',artifact(),false);seed('job_foreign','foreign',artifact(),true);seed('job_word','owner',artifact('docx'),false);
 db.prepare('INSERT INTO buzzy_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('doc_job_file','owner','job_file','Canonical companion','document','ready',2,null,null,'old','old');
 for(const [version,body]of [[1,'# Exact prior text\nFirst café 日本語.'],[2,'# Exact current text\nSecond café 日本語.']])db.prepare('INSERT INTO buzzy_document_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('doc_job_file',version,body,version===1?null:1,'owner',null,null,null,null,null,'old');
 const snapshot=()=>plain(['buzzy_jobs','buzzy_documents','buzzy_document_versions','protected_rows'].map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 const original=snapshot();
 const sql=async(strings,...params)=>{
  let text=strings[0];params.forEach((_,i)=>text+='$'+(i+1)+strings[i+1]);queries.push({text,params:plain(params)});assert.match(text,/^\s*SELECT/,'file delivery performs no data write');
  const rows=db.prepare(text.replace(/::(?:text|jsonb|int)/g,'').replace(/\$(\d+)/g,':p$1')).all(Object.fromEntries(params.map((p,i)=>['p'+(i+1),p]))).map(row=>{if(typeof row.artifact==='string')row.artifact=JSON.parse(row.artifact);if([0,1].includes(row.approved))row.approved=row.approved?'true':'false';return row;});
  if(readGate&&text.includes("data->>'approved'"))await readGate;if(readError)throw readError;return rows;
 };
 const ctx=vm.createContext({Buffer,Headers,URL,URLSearchParams,Request,Response,Uint8Array,console});
 const helper=await loadHelper(ctx);
 const deps={h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,getHeader:(e,k)=>e.req.headers.get(k),setResponseStatus:(e,s)=>e.status=s,setResponseHeader:(e,k,v)=>e.headers.set(k,v)},'@/lib/db':{getSql:async()=>sql},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'./telemetry':{recordTelemetry:async(_sql,e)=>events.push(plain(e))},'./artifact':{renderDocument:async body=>{renderCalls.push(plain(body));return {ok:true,bytes:Buffer.from('SYNTHETIC WORD EXPORT'),contentType:MIME.docx,filename:'word.docx'};}}};
 const source=stripTypeScriptTypes(read('src/lib/buzzy/chat.nitro.ts')),route=new vm.SourceTextModule(source,{context:ctx});
 await route.link(id=>{
  if(id==='./officeOriginal'){assert.ok(helper);return helper;}
  const decl=[...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)].find(m=>m[2]===id);assert.ok(decl,id);const names=decl[1].split(',').map(x=>x.trim()).filter(Boolean);
  return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[id]?.[name]??(()=>{forbidden++;throw Error('Forbidden dependency '+id+'.'+name);}));},{context:ctx});
 });await route.evaluate();
 const fetch=async url=>{
  assert.match(url,/^\/api\/buzzy\/(?:jobs\/[^/?]+\/document|documents\/doc_[A-Za-z0-9_-]+)(?:\?[^#]*)?$/);
  const e={path:url,status:200,headers:new Headers(),req:new Request('http://synthetic'+url)},value=await route.namespace.default(e);
  return value instanceof Response?value:Response.json(value,{status:e.status,headers:e.headers});
 };
 const set=(id,raw,approved=true)=>db.prepare('UPDATE buzzy_jobs SET data=? WHERE id=?').run(JSON.stringify({artifact:raw,approved,unrelated:'Keep original job fields'}),id);
 const reset=()=>{for(const row of original[0][1])db.prepare('UPDATE buzzy_jobs SET data=? WHERE id=?').run(row.data,row.id);};
 t.after(()=>{reset();assert.deepEqual(snapshot(),original,'all stored originals, text versions and unrelated records retained exactly');assert.equal(forbidden,0,'zero provider/private dependency calls');db.close();});
 return {fetch,queries,events,renderCalls,seed,set,reset,snapshot,user:value=>user=value,holdRead:value=>readGate=value,failRead:value=>readError=value};
}

for(const format of ['xlsx','pptx'])test(format+' actual envelope and Talk card select the approved original, not a Word export',async t=>{
 const h=await backend(t),raw=artifact(format),job=format==='xlsx'?'job_file':'job_deck',e=await envelope(raw,{recordId:job});
 assert.match(e.document.downloadUrl,new RegExp('^/api/buzzy/jobs/'+job+'/document\\?original=[a-f0-9]{64}$'));
 assert.equal(e.document.filename,raw.filename);assert.equal(e.document.contentType,raw.contentType);assert.equal(e.document.bytes,Buffer.from(raw.bytesB64,'base64').length);assert.equal(e.document.approvalRequired,true);
 assert.match(e.markup,/Download original/);assert.match(e.markup,/requires saved draft approval/);
 const res=await h.fetch(e.document.downloadUrl);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),raw.contentType);assert.match(res.headers.get('content-disposition'),new RegExp('synthetic\\.'+format));assert.equal(res.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));assert.equal(h.renderCalls.length,0);
});
for(const format of ['xlsx','pptx'])test(format+' refusal before saved approval then explicit retry returns the same original',async t=>{
 const h=await backend(t),raw=artifact(format);h.set('job_draft',raw,false);const e=await envelope(raw,{recordId:'job_draft'});
 const refused=await h.fetch(e.document.downloadUrl);assert.equal(refused.status,403);assert.equal((await refused.json()).code,'approval_required');assert.equal(h.events.length,0);
 // Fixture models approval that has already been durably confirmed. This is
 // not a test or rewrite of the separate approval mutation/UI state machine.
 h.set('job_draft',raw,true);const res=await h.fetch(e.document.downloadUrl);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));
 h.set('job_draft',raw,false);assert.equal((await h.fetch(e.document.downloadUrl)).status,403,'revoked approval is checked on every new original request');
});
for(const principal of [null,'foreign'])test('current principal '+principal+' cannot use the owner original link',async t=>{const h=await backend(t),e=await envelope(artifact());h.user(principal);const res=await h.fetch(e.document.downloadUrl);assert.equal(res.status,principal?404:401);assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);if(!principal)assert.equal(h.queries.length,0);});
test('missing job refuses instead of falling back to a text export',async t=>{const h=await backend(t),e=await envelope(artifact(),{recordId:'job_absent'});assert.equal((await h.fetch(e.document.downloadUrl)).status,404);assert.equal(h.renderCalls.length,0);});
for(const change of ['body','name','type'])test('older card refuses after stored '+change+' replacement, even when the new original is approved',async t=>{
 const h=await backend(t),old=artifact(),e=await envelope(old);const fresh=change==='body'?artifact('xlsx',{bytesB64:Buffer.from('NEW ORIGINAL').toString('base64')}):change==='name'?artifact('xlsx',{filename:'new-name.xlsx'}):artifact('pptx');h.set('job_file',fresh,true);
 const stale=await h.fetch(e.document.downloadUrl);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'original_changed');assert.equal(h.events.length,0);
 const next=await envelope(fresh);const result=await h.fetch(next.document.downloadUrl);assert.equal(result.status,200);assert.deepEqual(Buffer.from(await result.arrayBuffer()),Buffer.from(fresh.bytesB64,'base64'));assert.notEqual(next.document.downloadUrl,e.document.downloadUrl);
});
for(const token of ['', 'bad', '0'.repeat(64), 'A'.repeat(64), 'f'.repeat(63), 'a'.repeat(65)])test('invalid or stale original selector '+JSON.stringify(token)+' cannot return bytes',async t=>{const h=await backend(t),res=await h.fetch('/api/buzzy/jobs/job_file/document?original='+token);assert.ok([400,409].includes(res.status));assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);});
test('duplicate original query selectors are refused rather than ambiguously selected',async t=>{const h=await backend(t),e=await envelope(artifact());const res=await h.fetch(e.document.downloadUrl+'&original='+'a'.repeat(64));assert.equal(res.status,400);});
test('original selectors cannot turn a Word/text route into a spreadsheet authority',async t=>{const h=await backend(t);h.set('job_file',artifact('docx'),true);assert.equal((await h.fetch('/api/buzzy/jobs/job_file/document?original='+'a'.repeat(64))).status,409);});
for(const raw of [null,{},artifact('xlsx',{bytesB64:''}),artifact('xlsx',{bytesB64:'not-base64!'}),artifact('xlsx',{bytesB64:'YQ'}),artifact('xlsx',{filename:'wrong.docx'}),artifact('xlsx',{filename:'../file.xlsx'}),artifact('xlsx',{filename:'bad\r\nname.xlsx'}),artifact('xlsx',{filename:'bad\ud800.xlsx'})])test('malformed stored Office representation '+JSON.stringify(raw)+' is not downloaded under a pinned identity',async t=>{const h=await backend(t);h.set('job_file',raw,true);const res=await h.fetch('/api/buzzy/jobs/job_file/document?original='+'a'.repeat(64));assert.ok([404,409].includes(res.status));assert.equal(h.events.length,0);});
for(const patch of [{filename:'wrong.docx'},{filename:'bad\nname.xlsx'},{filename:'../file.xlsx'},{bytesB64:'bad!'}])test('malformed newly rendered Office metadata does not advertise a mislabeled Word fallback '+JSON.stringify(patch),async()=>{const e=await envelope(artifact('xlsx',patch));assert.equal(e.document,undefined);assert.match(e.warning,/original file.*could not be linked/i);});
for(const filename of ['Quarterly Report.XLSX','café 日本語 "quotes" & budget.xlsx'])test('exact valid original filename survives '+filename,async t=>{const h=await backend(t),raw=artifact('xlsx',{filename});h.set('job_file',raw,true);const e=await envelope(raw),res=await h.fetch(e.document.downloadUrl);assert.equal(e.document.filename,filename);assert.equal(res.status,200);assert.match(res.headers.get('content-disposition'),/filename\*=UTF-8''/);const encoded=res.headers.get('content-disposition').split("filename*=UTF-8''")[1];assert.equal(decodeURIComponent(encoded),filename);assert.doesNotMatch(e.markup,/<quotes>/);});
for(const raw of [artifact('docx'),null,artifact('docx',{contentType:'text/markdown',filename:'notes.md'}),artifact('docx',{contentType:'application/pdf',filename:'file.pdf'}),artifact('docx',{contentType:'application/x-officedocument-unknown',filename:'unknown.bin'}),artifact('docx',{filename:'looks-like-sheet.xlsx'})])test('existing canonical export routing stays unchanged for '+JSON.stringify(raw?.contentType||'text-only')+' '+(raw?.filename||''),async()=>{
 const e=await envelope(raw),fmt=raw?.contentType==='application/pdf'?'pdf':raw?.contentType&&/word|officedocument/i.test(raw.contentType)?'docx':'md';assert.equal(e.document.downloadUrl,'/api/buzzy/documents/doc_job_file?format='+fmt);assert.equal(e.document.approvalRequired,undefined);assert.match(e.markup,/Saved to your Library/);assert.doesNotMatch(e.markup,/requires saved draft approval/);
});
test('unapproved canonical Word and chosen-version Markdown remain available and unchanged',async t=>{const h=await backend(t);h.set('job_file',artifact('docx'),false);const word=await envelope(artifact('docx')),res=await h.fetch(word.document.downloadUrl);assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),MIME.docx);assert.equal(h.renderCalls.length,1);for(const [version,text]of [[1,'# Exact prior text\nFirst café 日本語.'],[2,'# Exact current text\nSecond café 日本語.']]){const md=await h.fetch('/api/buzzy/documents/doc_job_file?format=md&version='+version);assert.equal(md.status,200);assert.equal(await md.text(),text);}assert.equal((await h.fetch('/api/buzzy/documents/doc_job_file?format=md&version=99')).status,404);});
test('legacy unpinned approved original clients keep their existing retrieval contract',async t=>{const h=await backend(t),res=await h.fetch('/api/buzzy/jobs/job_file/document');assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(artifact().bytesB64,'base64'));assert.equal((await h.fetch('/api/buzzy/jobs/job_draft/document')).status,403);});
test('a read already admitted to an owned approved snapshot never substitutes replacement bytes after an await',async t=>{const h=await backend(t),old=artifact(),e=await envelope(old);let release;h.holdRead(new Promise(r=>release=r));const pending=h.fetch(e.document.downloadUrl);await new Promise(r=>setImmediate(r));h.set('job_file',artifact('xlsx',{bytesB64:Buffer.from('NEWER BODY').toString('base64')}),true);release();const res=await pending;assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(old.bytesB64,'base64'));h.holdRead(null);assert.equal((await h.fetch(e.document.downloadUrl)).status,409);});
test('different retained Talk cards keep their own captured job and original identity',async()=>{const first=await envelope(artifact(),{recordId:'job_first'}),next=await envelope(artifact('pptx'),{recordId:'job_second'});assert.match(first.markup,/jobs\/job_first\/document/);assert.doesNotMatch(first.markup,/job_second/);assert.match(next.markup,/jobs\/job_second\/document/);assert.doesNotMatch(next.markup,/job_first/);});
test('new original URLs stay inside the existing desktop download authority',async()=>{const {isAppDownload}=await import('../desktop/security.mjs');const e=await envelope(artifact());assert.equal(isAppDownload('http://127.0.0.1:7331'+e.document.downloadUrl,'http://127.0.0.1:7331'),true);assert.equal(isAppDownload('https://outside.invalid'+e.document.downloadUrl,'http://127.0.0.1:7331'),false);});

for(const format of ['xlsx','pptx'])test(format+' exact media type tolerates casing and surrounding HTTP whitespace, never extension guesses',async t=>{
 const h=await backend(t),raw=artifact(format,{contentType:' '+MIME[format].toUpperCase()+' '});h.set('job_file',raw,true);const e=await envelope(raw),res=await h.fetch(e.document.downloadUrl);
 assert.equal(e.document.contentType,MIME[format]);assert.equal(res.headers.get('content-type'),MIME[format]);assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));
 assert.equal((await envelope(artifact(format,{contentType:'text/plain'}))).document.approvalRequired,undefined);
});
test('filename literal entities and attribute punctuation remain literal Talk text and exact UTF-8 download metadata',async t=>{
 const h=await backend(t),raw=artifact('xlsx',{filename:'Budget &quot; <img title="x"> (v1)\' 日本語 📊.xlsx'});h.set('job_file',raw,true);const e=await envelope(raw),res=await h.fetch(e.document.downloadUrl);
 assert.match(e.markup,/Budget &amp;quot; &lt;img title=&quot;x&quot;&gt;/);assert.doesNotMatch(e.markup,/<img/);
 assert.equal(decodeURIComponent(res.headers.get('content-disposition').split("filename*=UTF-8''")[1]),raw.filename);
 assert.doesNotMatch(res.headers.get('content-disposition').split("filename*=UTF-8''")[1],/['()*]/);
});
test('original selection is deterministic and binds bytes/name/type but never unknown stored fields',async t=>{
 const h=await backend(t),raw=artifact(),withUnknown={...raw,legacy:{keep:'not a new filename'}};h.set('job_file',withUnknown,true);
 const a=await envelope(raw),b=await envelope(withUnknown),c=await envelope({...raw});assert.equal(a.document.downloadUrl,b.document.downloadUrl);assert.equal(b.document.downloadUrl,c.document.downloadUrl);
 assert.equal((await h.fetch(a.document.downloadUrl)).status,200);assert.equal(h.renderCalls.length,0);
});
test('storage failure emits no substitute bytes or success event, and explicit retry uses the same untouched original',async t=>{
 const h=await backend(t),e=await envelope(artifact()),before=h.snapshot();h.failRead(Error('synthetic storage unavailable'));await assert.rejects(h.fetch(e.document.downloadUrl),/synthetic storage unavailable/);
 assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);assert.deepEqual(h.snapshot(),before);h.failRead(null);
 assert.equal((await h.fetch(e.document.downloadUrl)).status,200);assert.deepEqual(h.snapshot(),before);
});
test('approval and owner refusal precede original-identity disclosure and are not cacheable',async t=>{
 const h=await backend(t);for(const [principal,job,status]of [['owner','job_draft',403],['foreign','job_file',404],[null,'job_file',401]]){
  h.user(principal);const r=await h.fetch('/api/buzzy/jobs/'+job+'/document?original=bad');assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'private, no-store');
 }assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);
});
test('malformed original metadata appends its warning without suppressing an existing draft warning',async()=>{
 const e=await envelope(artifact('xlsx',{bytesB64:'bad!'}),{response:{warning:'Keep the existing warning.'}});assert.equal(e.document,undefined);assert.match(e.warning,/^Keep the existing warning\. The original file could not be linked\./);
});

// Reuse the existing declared synthetic Talk IO fixture, without importing or
// running its tests. It extracts actual shipped sender/navigation functions;
// no product function is substituted. This adds file-descriptor-specific
// late-body controls while leaving the established speech suite untouched.
function talkTurn(){
 const fixture=read('scripts/test-talk-voice-lifecycle.mjs'),a=fixture.indexOf('function fn(name) {'),z=fixture.indexOf('\nfor (const sender of senders) {');assert.ok(a>0&&z>a);
 const ctx=vm.createContext({source:read('public/buzzy/talk.html'),assert,runInNewContext:vm.runInNewContext,AbortController,TextDecoder,Headers,console});
 vm.runInContext(fixture.slice(a,z),ctx);const h=ctx.speechHarness({realSend:true});h.c.voice.mic=false;h.c.chatState.jobId='job_file';return h;
}
async function settle(){for(let i=0;i<30;i++)await Promise.resolve();}
for(const format of ['xlsx','pptx'])test(format+' real Talk sender retains this response descriptor and its exact original URL',async t=>{
 const h=talkTurn(),db=await backend(t),raw=artifact(format);db.set('job_file',raw,true);const e=await envelope(raw);h.node('chatInput').value='Make the synthetic file';const sending=h.c.sendChatMessage();await settle();
 h.requests[0].resolve({ok:true,json:async()=>({ok:true,reply:'Your file',document:e.document})});await sending;
 const message=h.c.chatState.messages.at(-1);assert.deepEqual(plain(message.document),e.document);assert.equal(h.node('chatInput').disabled,false);
 const res=await db.fetch(message.document.downloadUrl);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));
});
for(const stage of ['headers','body','body-error'])test('late Office '+stage+' response cannot attach a file to a newly selected conversation or replace its draft',async()=>{
 const h=talkTurn(),e=await envelope(artifact());h.node('chatInput').value='Old conversation file';const sending=h.c.sendChatMessage();await settle();
 let finishBody;if(stage!=='headers'){h.requests[0].resolve({ok:true,json:()=>new Promise((resolve,reject)=>{finishBody=stage==='body'?resolve:reject;})});await settle();}
 const selecting=h.c.startNewChat();h.requests[1].resolve({ok:true,json:async()=>({session:{id:'new-session',jobId:'job_file',companyId:'original-company'}})});await selecting;
 h.node('chatInput').value='New conversation unsent draft';const before=plain(h.c.chatState.messages);
 const payload={ok:true,reply:'Old file response',document:e.document};if(stage==='headers')h.requests[0].resolve({ok:true,json:async()=>payload});else finishBody(stage==='body'?payload:Error('old body failed'));await sending;
 assert.deepEqual(plain(h.c.chatState.messages),before);assert.equal(h.c.chatState.sessionId,'new-session');assert.equal(h.node('chatInput').value,'New conversation unsent draft');assert.equal(h.node('chatInput').disabled,false);assert.equal(h.c.chatState.messages.some(m=>m.document),false);
});
test('actual Talk error response cannot advertise an attached original and leaves unrelated messages intact',async()=>{
 const h=talkTurn(),e=await envelope(artifact());h.c.chatState.messages.push({role:'assistant',content:'Retain prior reply'});h.node('chatInput').value='Make file';const pending=h.c.sendChatMessage();await settle();
 h.requests[0].resolve({ok:false,json:async()=>({ok:false,error:'Synthetic refusal',document:e.document})});await pending;
 assert.equal(h.c.chatState.messages[0].content,'Retain prior reply');assert.equal(h.c.chatState.messages.some(m=>m.document),false);assert.equal(h.node('chatError').textContent,'Synthetic refusal');assert.equal(h.node('chatInput').disabled,false);
});


test('an owned link never serves a foreign job and ignores supplied URL authority aliases',async t=>{
 const h=await backend(t),raw={...artifact(),url:'https://outside.invalid/bytes',downloadUrl:'https://outside.invalid/file',libraryUrl:'//outside.invalid/'};
 const e=await envelope(raw);assert.match(e.document.downloadUrl,/^\/api\/buzzy\/jobs\/job_file\/document\?original=[a-f0-9]{64}$/);assert.doesNotMatch(e.markup,/outside\.invalid/);
 const foreign=await envelope(raw,{recordId:'job_foreign'});const response=await h.fetch(foreign.document.downloadUrl);assert.equal(response.status,404);assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);
});

// Legacy originals: actual Nitro route, synthetic H3/telemetry, SQLite custody.
for (const [format, filename] of [
 ['pptx', 'Plan & 日本語.pptx'], ['xlsx', 'Budget 📊.xlsx'],
 ['docx', 'café "quotes" \\ notes.docx'], ['docx', 'literal%20 (v1)\'*.docx'],
 ['docx', 'plain.docx'],
]) test('legacy original exact filename and bytes: '+filename, async t => {
 const h=await backend(t),raw=artifact(format,{filename});h.set('job_file',raw,true);const before=h.snapshot();
 const res=await h.fetch('/api/buzzy/jobs/job_file/document');assert.equal(res.status,200);
 assert.equal(res.headers.get('content-type'),MIME[format]);
 const disposition=res.headers.get('content-disposition');assert.match(disposition,/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
 assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]),filename);
 assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));
 assert.equal(h.events.length,1);assert.equal(h.events[0].event,'exported');assert.equal(h.renderCalls.length,0);assert.deepEqual(h.snapshot(),before);
});
for(const patch of [{filename:'bad\r\nX-Test: value.pptx'},{filename:'bad\0.pptx'},{filename:'bad\u0085.pptx'},{filename:'bad\ud800.pptx'},{filename:'bad\udc00.pptx'},{filename:{unexpected:true}},{contentType:'text/plain\r\nX-Test: value'}]) test('legacy malformed metadata refuses before success telemetry: '+JSON.stringify(patch),async t=>{
 const h=await backend(t);h.set('job_file',artifact('pptx',patch),true);const before=h.snapshot();
 const res=await h.fetch('/api/buzzy/jobs/job_file/document');assert.equal(res.status,422);assert.equal((await res.json()).code,'invalid_original_metadata');
 assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);assert.deepEqual(h.snapshot(),before);
});
for(const [principal,approved,status]of [[null,true,401],['foreign',true,404],['owner',false,403]])test('legacy malformed metadata never precedes access refusal '+status,async t=>{
 const h=await backend(t);h.set('job_file',artifact('pptx',{filename:'bad\ud800.pptx'}),approved);h.user(principal);
 assert.equal((await h.fetch('/api/buzzy/jobs/job_file/document')).status,status);assert.equal(h.events.length,0);assert.equal(h.renderCalls.length,0);
});
test('legacy original absent filename retains default and absent MIME retains Word default',async t=>{
 const h=await backend(t),raw=artifact('docx',{filename:null,contentType:null});h.set('job_file',raw,true);
 const res=await h.fetch('/api/buzzy/jobs/job_file/document');assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),MIME.docx);
 assert.equal(decodeURIComponent(res.headers.get('content-disposition').split("filename*=UTF-8''")[1]),'document.docx');assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(raw.bytesB64,'base64'));
});
