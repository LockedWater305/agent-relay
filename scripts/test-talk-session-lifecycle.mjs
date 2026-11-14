#!/usr/bin/env node
/**
 * Talk selection lifecycle: actual UI functions and Nitro session handlers,
 * synthetic DOM/auth/SQL only. No sockets, providers, credentials or user data.
 * Run: npm run test:talk-sessions (Node 22.13+ with VM modules enabled).
 * BZ_TALK_ROOT points to an exact source baseline for expected-red proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(process.env.BZ_TALK_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const html = fs.readFileSync(resolve(ROOT, 'public/buzzy/talk.html'), 'utf8');
const routeSource = stripTypeScriptTypes(fs.readFileSync(resolve(ROOT, 'src/lib/buzzy/chat.nitro.ts'), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x));
const session = (id, jobId = null, companyId = null) => ({ id, jobId, companyId });
const old = session('sess_old', 'job_old', 'co_old');
const transcript = s => ({ session: s, messages: [{ role: 'user', content: s.id + ' user' }, { role: 'assistant', content: s.id + ' reply' }], slots: {} });
const response = (data, status = 200) => Response.json(data, { status });
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function fn(name) {
 const re = new RegExp('^    (?:async )?function '+name+'\\(', 'm'), found = re.exec(html);
 if (!found) return '';
 const end = html.indexOf('\n    }', found.index); assert.ok(end > found.index, name);
 return html.slice(found.index, end + 6);
}
function ui(fetcher, options = {}) {
 const storage = new Map([['bz_session_id', options.stored === undefined ? old.id : options.stored]]), nodes = new Map(), calls = [];
 let company = options.company ?? null;
 const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', classList: { add(){}, remove(){}, toggle(){} }, focus(){}, disabled: false }); return nodes.get(id); };
 const globals = { URLSearchParams, AbortSignal, console, SESSIONS_BASE: '/api/buzzy/sessions',
  window: { location: { search: options.search || '' }, history: { replaceState(){} } },
  localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
  sessionStorage: { getItem: () => null }, document: { getElementById: node, querySelectorAll: () => [] },
  activeCompanyId: () => company, BZCompanies: { activeId: () => company },
  fetch: async (url, init = {}) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : null }); return fetcher(url, init); },
  paperOperation: 0, paperBusy: false, renderPaper() {},
  welcomeMessage: () => 'Welcome', speechRequestCurrent: () => true, bzJobCtx: j => j,
 };
 globals.window.BZCompanies = globals.BZCompanies;
 for (const name of ['speechContextChanged','resetContextMeter','setBackVisible','resetDraftGate','setChatMascot','renderChatMessages','updateChrome','renderSlotChecklist','closeSessionsDrawer','showChatScreen','sessionsError']) globals[name] = () => {};
 const ctx = vm.createContext(globals);
 const start = html.indexOf('    let chatState ='), end = html.indexOf('    // ── Form tab', start);
 assert.ok(start >= 0 && end > start); vm.runInContext(html.slice(start,end),ctx);
 // New helpers are extracted from shipped source, never reproduced here.
 const names = ['chatContextSnapshot','chatContextCurrent','beginChatNavigation','chatNavigationCurrent','finishChatNavigation','validChatSession','storeChatSession','selectChatSession','showChatFailure','restoreTranscript','newChatNow','ensureChatSession','openSession','startNewChat'];
 const nav = html.match(/^    (?:var|let|const) chatNavigation = .*;$/m);
 if (nav && !html.slice(start,end).includes(nav[0])) vm.runInContext(nav[0],ctx);
 vm.runInContext(names.map(fn).join('\n'),ctx);
 return { ctx, calls, storage, nodes, state: () => vm.runInContext('chatState',ctx), company: c => company = c, set: values => Object.assign(vm.runInContext('chatState',ctx), values) };
}

test('New chat is fresh and retains current job; repeated clicks share one request', async () => {
 const gate = deferred(), u = ui(() => gate.promise); u.set({ ...old, sessionId: old.id, jobId: old.jobId });
 const a = u.ctx.startNewChat(), b = u.ctx.startNewChat(); assert.equal(u.calls.length,1); assert.equal(u.calls[0].body.fresh,true); assert.equal(u.calls[0].body.jobId,old.jobId);
 gate.resolve(response({session:session('sess_new',old.jobId)})); await Promise.all([a,b]); assert.equal(u.state().sessionId,'sess_new'); assert.equal(u.storage.get('bz_session_id'),'sess_new');
});
test('recent-work New chat explicitly creates a fresh unscoped session', async () => {
 const u=ui(async()=>response({session:session('sess_recent')}));u.set({sessionId:old.id,jobId:old.jobId});
 await u.ctx.newChatNow(); assert.equal(u.calls.length,1);assert.equal(u.calls[0].body.fresh,true);assert.ok(!u.calls[0].body.jobId);assert.equal(u.state().jobId,null);assert.equal(u.state().sessionId,'sess_recent');
});
test('ordinary ensure resumes and deduplicates concurrent session creation',async()=>{
 const gate=deferred(),u=ui(()=>gate.promise,{stored:null});const a=u.ctx.ensureChatSession(),b=u.ctx.ensureChatSession();assert.equal(u.calls.length,1);assert.notEqual(u.calls[0].body.fresh,true);
 gate.resolve(response({session:session('sess_resumed')}));await Promise.all([a,b]);assert.equal(u.state().sessionId,'sess_resumed');await u.ctx.ensureChatSession();assert.equal(u.calls.length,1);
});
test('history uses owner-resolved metadata, not card metadata, and persists reload pointer',async()=>{
 const resolved=session('sess_selected','job_selected','co_selected'),u=ui(async()=>response(transcript(resolved)),{company:'co_selected'});u.set({jobId:old.jobId});
 await u.ctx.openSession({...resolved,jobId:'stale-card-job',companyId:'stale-card-company'});assert.equal(u.state().jobId,resolved.jobId);assert.equal(u.state().boundCompanyId,resolved.companyId);assert.equal(u.storage.get('bz_session_id'),resolved.id);assert.deepEqual(plain(u.state().messages),transcript(resolved).messages);
});
test('actual reload initializer and restore select exact session before job-wide history',async()=>{
 const s=session('sess_reload','job_reload','co_reload'),u=ui(async()=>response(transcript(s)),{stored:s.id});await u.ctx.restoreTranscript();
 assert.ok(u.calls[0].url.includes('sessionId='+s.id));assert.equal(u.state().sessionId,s.id);assert.equal(u.state().jobId,s.jobId);assert.equal(u.state().boundCompanyId,s.companyId);
 await u.ctx.restoreTranscript();assert.ok(u.calls.at(-1).url.includes('sessionId='+s.id));assert.deepEqual(plain(u.state().messages),transcript(s).messages);
});
for(const status of [401,404,500])test('history HTTP '+status+' preserves current view',async()=>{
 const u=ui(async()=>response({error:'no'},status));u.set({jobId:old.jobId,messages:[{role:'user',content:'keep'}]});const before=plain(u.state());await u.ctx.openSession(session('sess_missing'));assert.deepEqual(plain(u.state()),before);assert.equal(u.storage.get('bz_session_id'),old.id);
});
test('invalid session response cannot replace current view',async()=>{
 const u=ui(async()=>response({session:{id:''},messages:[]}));u.set({messages:[{role:'user',content:'keep'}]});const before=plain(u.state());await u.ctx.openSession(session('sess_bad'));assert.deepEqual(plain(u.state()),before);
});
test('out-of-order history response cannot overwrite newer selection',async()=>{
 const first=deferred(),second=deferred(),u=ui(url=>url.includes('sess_first')?first.promise:second.promise);
 const a=u.ctx.openSession(session('sess_first')),b=u.ctx.openSession(session('sess_second'));second.resolve(response(transcript(session('sess_second'))));await b;first.resolve(response(transcript(session('sess_first'))));await a;assert.equal(u.state().sessionId,'sess_second');
});
test('company change invalidates pending New chat response',async()=>{
 const gate=deferred(),u=ui(()=>gate.promise,{company:'co_a'});const before=plain(u.state()),p=u.ctx.startNewChat();u.company('co_b');gate.resolve(response({session:session('sess_late',null,'co_a')}));await p;assert.deepEqual(plain(u.state()),before);
});
test('job URL clears unrelated stored session during actual initialization',()=>{
 const u=ui(()=>{throw Error('not requested');},{search:'?job=job_from_url'});assert.equal(u.state().jobId,'job_from_url');assert.equal(u.state().sessionId,null);assert.equal(u.storage.get('bz_session_id'),undefined);
});

async function routeHarness(user='owner') {
 const reads=[], sessions=new Map([['sess_owned',{id:'sess_owned',user_id:'owner',job_id:'job_owned',company_id:'co_owned123'}],['sess_foreign',{id:'sess_foreign',user_id:'other',job_id:'job_foreign',company_id:null}]]);
 const sql=async(strings,...values)=>{const text=strings.join('?');reads.push({text,values});
  if(text.includes("interval '12 hours'")){
   const parameter=field=>{const m=new RegExp('\\b'+field+' (?:=|IS NOT DISTINCT FROM) \\?').exec(text);return m?values[(text.slice(0,m.index).match(/\?/g)||[]).length]:undefined;};
   return [...sessions.values()].filter(s=>s.user_id===parameter('user_id')&&(text.includes('company_id IS NULL')?s.company_id===null:s.company_id===parameter('company_id'))&&(!/\bjob_id = \?/.test(text)||s.job_id===parameter('job_id'))).slice(0,1);
  }
  if(text.includes('FROM buzzy_jobs'))return values.includes('owner')&&['job_owned','job_requested','job_legacy'].includes(values[0])?[{id:values[0],company_id:values[0]==='job_legacy'?null:'co_owned123'}]:[];
  if(text.includes('INSERT INTO buzzy_sessions')){const row={id:values[0],user_id:values[1],job_id:values[2],title:values[3],company_id:values[4]};sessions.set(row.id,row);return [row];}
  if(text.includes('FROM buzzy_companies'))return values[0]==='co_owned123'&&values[1]==='owner'?[{id:'co_owned123'}]:[];
  if(text.includes('FROM buzzy_sessions')){const row=[...sessions.values()].find(s=>values.includes(s.id)&&values.includes(s.user_id));return row?[row]:[];}
  if(text.includes('FROM buzzy_chat_messages'))return [{role:'user',content:'owned transcript',created_at:'2026-01-01'}];
  if(text.includes('FROM buzzy_user_memory'))return [];
  throw Error('Unexpected SQL '+text);
 };
 const context=vm.createContext({Buffer,URL,URLSearchParams,Headers,Request,Response,Uint8Array,TextDecoder,crypto:webcrypto});
 const deps={h3:{defineEventHandler:f=>f,getMethod:e=>e.req.method,setResponseHeader(){},setResponseStatus:(e,s)=>e.status=s,getHeader:(e,k)=>e.req.headers.get(k)},'@/lib/auth/verify.server':{getSessionUserFromHeaders:async()=>user?{id:user}:null},'@/lib/db':{getSql:async()=>sql}};
 const module=new vm.SourceTextModule(routeSource,{context});await module.link(specifier=>{
 const imports=[...routeSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].find(m=>m[2]===specifier);assert.ok(imports,specifier);const names=imports[1].split(',').map(s=>s.trim()).filter(Boolean);
 return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,deps[specifier]?.[name]??(name==='STATEMENT_IDS'||name==='DEEPENING_IDS'?[]:()=>{throw Error('Unexpected dependency '+specifier+'.'+name);}));},{context});});await module.evaluate();
 async function request(path,init={}){const event={path,status:200,req:new Request('http://local'+path,init)};const data=await module.namespace.default(event);return {data,status:event.status};}
 return {reads,sessions,request,async fetch(path,init={}){const r=await request(path,init);return response(r.data,r.status);},async get(id){const path='/api/buzzy/transcript?sessionId='+id,event={path,status:200,req:new Request('http://local'+path)};return {data:await module.namespace.default(event),status:event.status};}};
}
test('actual transcript endpoint returns owner-resolved metadata and exact-session SQL',async()=>{
 const h=await routeHarness(),r=await h.get('sess_owned');assert.equal(r.status,200);assert.deepEqual(plain(r.data.session),session('sess_owned','job_owned','co_owned123'));assert.ok(h.reads.some(q=>q.text.includes('session_id =')&&q.values.includes('sess_owned')));
});
for(const id of ['sess_foreign','sess_absent'])test('actual transcript endpoint refuses '+id+' before reading messages',async()=>{
 const h=await routeHarness(),r=await h.get(id);assert.equal(r.status,404);assert.equal(h.reads.some(q=>q.text.includes('FROM buzzy_chat_messages')),false);
});
test('actual transcript endpoint rejects signed-out access before SQL',async()=>{const h=await routeHarness(null),r=await h.get('sess_owned');assert.equal(r.status,401);assert.equal(h.reads.length,0);});
for(const status of [401,500])test('failed New chat '+status+' retains transcript and reload pointer',async()=>{
 const u=ui(async()=>response({error:'failed'},status));u.set({messages:[{role:'user',content:'keep current'}],jobId:old.jobId});const before=plain(u.state());await u.ctx.startNewChat();assert.deepEqual(plain(u.state()),before);assert.equal(u.storage.get('bz_session_id'),old.id);
});
test('late restore cannot overwrite an explicitly selected history session',async()=>{
 const gate=deferred(),u=ui(url=>url.includes('sess_selected')?Promise.resolve(response(transcript(session('sess_selected')))):gate.promise);
 const restoring=u.ctx.restoreTranscript();await u.ctx.openSession(session('sess_selected'));gate.resolve(response(transcript(old)));await restoring;assert.equal(u.state().sessionId,'sess_selected');assert.deepEqual(plain(u.state().messages),transcript(session('sess_selected')).messages);
});
test('late ensure cannot overwrite a newer history selection',async()=>{
 const gate=deferred(),u=ui((_url,init)=>init.method==='POST'?gate.promise:Promise.resolve(response(transcript(session('sess_selected')))),{stored:null});
 const ensuring=u.ctx.ensureChatSession();await u.ctx.openSession(session('sess_selected'));gate.resolve(response({session:session('sess_stale_ensure')}));await ensuring;assert.equal(u.state().sessionId,'sess_selected');assert.equal(u.storage.get('bz_session_id'),'sess_selected');
});
test('repeated same History click shares one request',async()=>{
 const gate=deferred(),u=ui(()=>gate.promise),s=session('sess_once');const a=u.ctx.openSession(s),b=u.ctx.openSession(s);assert.equal(u.calls.length,1);gate.resolve(response(transcript(s)));await Promise.all([a,b]);assert.equal(u.state().sessionId,s.id);
});
test('late JSON body of New chat cannot overwrite newer History selection',async()=>{
 const body=deferred(),entered=deferred(),u=ui((_url,init)=>init.method==='POST'?Promise.resolve({ok:true,status:200,json(){entered.resolve();return body.promise;}}):Promise.resolve(response(transcript(session('sess_history')))));
 const creating=u.ctx.startNewChat();await entered.promise;await u.ctx.openSession(session('sess_history'));body.resolve({session:session('sess_obsolete')});await creating;assert.equal(u.state().sessionId,'sess_history');assert.equal(u.storage.get('bz_session_id'),'sess_history');
});
test('late JSON body of History cannot overwrite newer New chat selection',async()=>{
 const body=deferred(),entered=deferred(),u=ui((_url,init)=>init.method==='POST'?Promise.resolve(response({session:session('sess_newest')})):Promise.resolve({ok:true,status:200,json(){entered.resolve();return body.promise;}}));
 const opening=u.ctx.openSession(session('sess_obsolete'));await entered.promise;await u.ctx.startNewChat();body.resolve(transcript(session('sess_obsolete')));await opening;assert.equal(u.state().sessionId,'sess_newest');
});
test('fresh job-scoped session restores only its own empty transcript, never prior job messages',async()=>{
 const fresh=session('sess_empty','job_current'),u=ui((url,init)=>init.method==='POST'?Promise.resolve(response({session:fresh})):Promise.resolve(response({session:fresh,messages:[],slots:{}})));u.set({jobId:'job_current',messages:[{role:'user',content:'old job text'}]});
 await u.ctx.startNewChat();await u.ctx.restoreTranscript();assert.equal(u.state().sessionId,fresh.id);assert.equal(u.state().jobId,'job_current');assert.ok(u.calls.filter(c=>c.url.startsWith('/api/buzzy/transcript')).every(c=>c.url.includes('sessionId=sess_empty')));assert.equal(u.state().messages.some(m=>m.content==='old job text'),false);
});
test('company switch during History JSON parsing keeps current session unchanged',async()=>{
 const body=deferred(),entered=deferred(),u=ui(()=>Promise.resolve({ok:true,status:200,json(){entered.resolve();return body.promise;}}),{company:'co_first'}),before=plain(u.state());
 const opening=u.ctx.openSession(session('sess_history',null,'co_first'));await entered.promise;u.company('co_second');body.resolve(transcript(session('sess_history',null,'co_first')));await opening;assert.deepEqual(plain(u.state()),before);
});
test('invalid fresh response retains existing session rather than accepting mismatched job',async()=>{
 const u=ui(async()=>response({session:session('sess_wrong','job_wrong')}));u.set({jobId:'job_current',messages:[{role:'user',content:'keep'}]});const before=plain(u.state());await u.ctx.startNewChat();assert.deepEqual(plain(u.state()),before);assert.equal(u.storage.get('bz_session_id'),old.id);
});
test('actual UI to Nitro ordinary ensure resumes owner company thread without INSERT',async()=>{
 const h=await routeHarness(),u=ui(h.fetch,{stored:null,company:'co_owned123'});
 const id=await u.ctx.ensureChatSession();assert.equal(id,'sess_owned');assert.equal(u.state().sessionId,'sess_owned');assert.notEqual(u.calls[0].body.fresh,true);
 assert.ok(h.reads.some(q=>q.text.includes("interval '12 hours'")));assert.equal(h.reads.some(q=>q.text.includes('INSERT INTO buzzy_sessions')),false);
});
test('actual UI to Nitro New chat fresh inserts requested job/company instead of resuming',async()=>{
 const h=await routeHarness(),u=ui(h.fetch,{company:'co_owned123',stored:'sess_owned'});u.set({jobId:'job_requested',sessionId:'sess_owned'});
 await u.ctx.startNewChat();assert.equal(u.calls[0].body.fresh,true);assert.notEqual(u.state().sessionId,'sess_owned');assert.equal(u.state().jobId,'job_requested');assert.equal(u.state().boundCompanyId,'co_owned123');assert.equal(u.storage.get('bz_session_id'),u.state().sessionId);
 const inserts=h.reads.filter(q=>q.text.includes('INSERT INTO buzzy_sessions'));assert.equal(inserts.length,1);assert.deepEqual(inserts[0].values.slice(1),['owner','job_requested','New session','co_owned123']);assert.equal(h.reads.some(q=>q.text.includes("interval '12 hours'")),false);
});
test('actual fresh POST rejects non-owned company without INSERT',async()=>{
 const h=await routeHarness(),r=await h.request('/api/buzzy/sessions',{method:'POST',body:JSON.stringify({fresh:true,companyId:'co_foreign123'})});assert.equal(r.status,400);assert.equal(h.reads.some(q=>q.text.includes('INSERT INTO buzzy_sessions')),false);
});
test('actual POST signed out rejects before SQL and preserves UI selection',async()=>{
 const h=await routeHarness(null),u=ui(h.fetch),before=plain(u.state());await u.ctx.startNewChat();assert.deepEqual(plain(u.state()),before);assert.equal(h.reads.length,0);assert.equal(u.storage.get('bz_session_id'),old.id);
});
test('explicit requested job never resumes a different job in same company',async()=>{
 const h=await routeHarness(),u=ui(h.fetch,{stored:null,company:'co_owned123'});u.set({jobId:'job_requested'});
 const id=await u.ctx.ensureChatSession();assert.equal(u.calls[0].body.jobId,'job_requested');assert.ok(id);assert.notEqual(id,'sess_owned');assert.equal(u.state().jobId,'job_requested');assert.equal(h.sessions.get(id).job_id,'job_requested');
});
test('explicit exact job and company resumes its own session without INSERT',async()=>{
 const h=await routeHarness(),u=ui(h.fetch,{stored:null,company:'co_owned123'});u.set({jobId:'job_owned'});
 assert.equal(await u.ctx.ensureChatSession(),'sess_owned');assert.equal(u.calls[0].body.jobId,'job_owned');assert.equal(h.reads.some(q=>q.text.includes('INSERT INTO buzzy_sessions')),false);
 assert.ok(h.reads.some(q=>q.text.includes("interval '12 hours'")&&q.text.includes('job_id =')));
});
for(const jobId of ['job_missing','job_foreign'])test('POST rejects missing or foreign job '+jobId+' before resume or insert',async()=>{
 const h=await routeHarness(),r=await h.request('/api/buzzy/sessions',{method:'POST',body:JSON.stringify({jobId,companyId:'co_owned123'})});assert.ok([400,404].includes(r.status));assert.equal(h.reads.some(q=>q.text.includes('INSERT INTO buzzy_sessions')||q.text.includes("interval '12 hours'")),false);
});
test('ensure refuses wrong-job response without replacing explicit job context',async()=>{
 const u=ui(async()=>response({session:session('sess_wrong','job_other')}),{stored:null});u.set({jobId:'job_requested'});const before=plain(u.state());assert.equal(await u.ctx.ensureChatSession(),null);assert.deepEqual(plain(u.state()),before);assert.equal(u.storage.get('bz_session_id'),null);
});
test('actual activeCompanyId falls back to owner-resolved bound company without company widget',async()=>{
 const s=session('sess_bound','job_bound','co_bound123'),u=ui(async()=>response(transcript(s)));delete u.ctx.window.BZCompanies;delete u.ctx.BZCompanies;vm.runInContext(fn('activeCompanyId'),u.ctx);
 await u.ctx.openSession(s);assert.equal(u.ctx.activeCompanyId(),'co_bound123');assert.equal(u.state().jobId,'job_bound');assert.equal(u.storage.get('bz_session_id'),s.id);
});
for(const failure of ['company-mismatch','not-found'])test('unverified restored pointer blocks ensure after '+failure+' but History can recover',async()=>{
 const gate=deferred(),entered=deferred(),selected=session('sess_recovered',null,'co_b');
 const u=ui(url=>url.includes('sess_recovered')?Promise.resolve(response(transcript(selected))):(entered.resolve(),gate.promise),{stored:'sess_old',company:'co_b'});
 const restoring=u.ctx.restoreTranscript();await entered.promise;
 assert.equal(await u.ctx.ensureChatSession(),null,'pending metadata must not authorize Send');
 gate.resolve(failure==='not-found'?response({error:'missing'},404):response(transcript(session('sess_old',null,'co_a'))));await restoring;
 assert.equal(u.state().sessionId,'sess_old');assert.equal(u.storage.get('bz_session_id'),'sess_old');assert.equal(await u.ctx.ensureChatSession(),null,'failed metadata must not authorize Send');
 assert.equal(u.calls.filter(c=>c.body).length,0);
 await u.ctx.openSession(selected);assert.equal(await u.ctx.ensureChatSession(),selected.id);assert.equal(u.storage.get('bz_session_id'),selected.id);
});
test('owned legacy null-company job accepts owned active company without rewriting job',async()=>{
 const h=await routeHarness(),r=await h.request('/api/buzzy/sessions',{method:'POST',body:JSON.stringify({fresh:true,jobId:'job_legacy',companyId:'co_owned123'})});
 assert.equal(r.status,201);assert.equal(r.data.session.jobId,'job_legacy');assert.equal(r.data.session.companyId,'co_owned123');assert.equal(h.reads.some(q=>/UPDATE\s+buzzy_jobs/i.test(q.text)),false);
});
test('legacy null-company compatibility still rejects foreign company and missing job',async()=>{
 for(const body of [{fresh:true,jobId:'job_legacy',companyId:'co_foreign123'},{fresh:true,jobId:'job_missing',companyId:'co_owned123'}]){
  const h=await routeHarness(),r=await h.request('/api/buzzy/sessions',{method:'POST',body:JSON.stringify(body)});assert.ok([400,404].includes(r.status));assert.equal(h.reads.some(q=>q.text.includes('INSERT INTO buzzy_sessions')),false);
 }
});
