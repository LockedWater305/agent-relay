#!/usr/bin/env node
/** Shipped header, shared company store and dialog with synthetic DOM/IO only. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const ROOT=resolve(process.env.BZ_COMPANY_ROOT || new URL('..',import.meta.url).pathname);
const companies=readFileSync(resolve(ROOT,'public/buzzy/companies.js'),'utf8');
const nav=readFileSync(resolve(ROOT,'public/buzzy/nav.js'),'utf8');
const talk=readFileSync(resolve(ROOT,'public/buzzy/talk.html'),'utf8');
const memory=readFileSync(resolve(ROOT,'public/buzzy/memory.html'),'utf8');
function fn(source,name,indent=4){const re=new RegExp('^'+' '.repeat(indent)+'(?:async )?function '+name+'\\([^]*?^'+' '.repeat(indent)+'\\}','m');const m=source.match(re);assert.ok(m,'actual '+name);return m[0];}
const A={id:'co_aaaaaaaa',name:'Company A'}, B={id:'co_bbbbbbbb',name:'Company B'}, NEW={id:'co_cccccccc',name:'New company',lines:[],facts:[]};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
async function settle(){for(let i=0;i<35;i++)await Promise.resolve();}
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
class Element {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.attrs=new Map();this.events=new Map();this.parentNode=null;this.style={};this.disabled=false;this.value='';this.open=false;this._text='';this._html='';this.classList={add(){},remove(){},toggle(){},contains(){return false;}};}
 set id(v){this.attrs.set('id',v);}get id(){return this.attrs.get('id')||'';}
 set className(v){this.attrs.set('class',v);}get className(){return this.attrs.get('class')||'';}
 set textContent(v){this._text=String(v);this._html='';this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set innerHTML(v){this._html=String(v);this._text='';for(const c of this.children)c.parentNode=null;this.children=[];}get innerHTML(){return this._html||esc(this._text)+this.children.map(c=>c.outerHTML).join('');}
 get outerHTML(){return '<'+this.tagName.toLowerCase()+'>'+this.innerHTML+'</'+this.tagName.toLowerCase()+'>';}
 setAttribute(k,v){this.attrs.set(k,String(v));}getAttribute(k){return this.attrs.get(k)??null;}removeAttribute(k){this.attrs.delete(k);}
 appendChild(c){c.remove();this.children.push(c);c.parentNode=this;return c;}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null;}
 get isConnected(){return this===this.doc.documentElement||!!this.parentNode?.isConnected;}
 addEventListener(k,f){if(!this.events.has(k))this.events.set(k,[]);this.events.get(k).push(f);}
 fire(k,extra={}){const e={target:this,preventDefault(){this.defaultPrevented=true;},...extra};for(const f of this.events.get(k)||[])f(e);return e;}
 click(){if(!this.disabled)this.fire('click');}focus(){this.doc.activeElement=this;}
 showModal(){this.open=true;}close(){this.open=false;this.fire('close');}
 matches(selector){if(selector.includes(' ')){const parts=selector.trim().split(/\s+/);return this.matches(parts.pop())&&!!this.parentNode?.closest(parts.join(' '));}const m=/^(\w+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/.exec(selector);assert.ok(m,'fixture selector '+selector);const[,tag,id,cls,attr,val]=m;return(!tag||this.tagName===tag.toUpperCase())&&(!id||this.id===id)&&(!cls||this.className.split(/\s+/).includes(cls))&&(!attr||(val===undefined?this.attrs.has(attr):String(this.getAttribute(attr)??this[attr])===val));}
 closest(s){return this.matches(s)?this:this.parentNode?.closest(s)||null;}
 querySelectorAll(s){const out=[];for(const c of this.children){if(s.split(',').some(x=>c.matches(x.trim())))out.push(c);out.push(...c.querySelectorAll(s));}return out;}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
}
function browser({list=[A,B],location='/buzzy/talk',autoLoad=true}={}){
 const requests=[],storage=new Map(),timers=[],windowEvents=new Map(),documentEvents=new Map(),navigations=[];
 const document={readyState:'complete',activeElement:null,createElement:tag=>new Element(tag,document),addEventListener(k,f){if(!documentEvents.has(k))documentEvents.set(k,[]);documentEvents.get(k).push(f);}};
 document.documentElement=new Element('html',document);document.head=new Element('head',document);document.body=new Element('body',document);document.documentElement.appendChild(document.head);document.documentElement.appendChild(document.body);
 document.getElementById=id=>[document.documentElement,...document.documentElement.querySelectorAll('[id]')].find(n=>n.id===id)||null;
 document.querySelector=s=>document.documentElement.querySelector(s);document.querySelectorAll=s=>document.documentElement.querySelectorAll(s);
 // The shared store only looks for these legacy mounts at boot; none is shipped.
 const query=document.querySelector;document.querySelector=s=>s==='#bzPage #companyTabs'?null:query(s);
 const url=new URL(location,'http://127.0.0.1:7331');
 const window={document,location:url,addEventListener(k,f){if(!windowEvents.has(k))windowEvents.set(k,[]);windowEvents.get(k).push(f);}};
 window.BeeZillaShell={busy:false,currentKey:url.pathname+url.search,go:async href=>{navigations.push(href);url.href=new URL(href,url).href;return true;}};
 const c=vm.createContext({window,document,location:url,console,URL,URLSearchParams,AbortSignal,
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
  setInterval:f=>{timers.push(f);return timers.length;},clearInterval(){},
  fetch:(url,init={})=>{const task=deferred();requests.push({...task,url,init});return task.promise;}});
 vm.runInContext(companies,c);
 const header=document.createElement('nav');document.body.appendChild(header);
 vm.runInContext(fn(nav,'companyControl',2),c);c.companyControl(header);
 const api=window.BZCompanies;
 function tick(){timers.forEach(f=>f());}
 async function hydrate(){requests[0].resolve(response({companies:list}));await settle();tick();}
 function selectAdd(){const sel=header.querySelector('select');sel.value='__add';sel.fire('change');return document.getElementById('bzCompanyCreate');}
 const h={c,window,document,api,header,requests,storage,navigations,tick,hydrate,selectAdd,
  replayStore(){vm.runInContext(companies,c);},emitWindow(k){for(const f of windowEvents.get(k)||[])f({});},emitDocument(k){for(const f of documentEvents.get(k)||[])f({});},
  dialog:()=>document.getElementById('bzCompanyCreate'),input:()=>document.getElementById('bzCompanyCreateName'),status:()=>document.getElementById('bzCompanyCreateStatus'),
  submit(name='New company'){const d=this.dialog();assert.ok(d,'reachable company dialog');this.input().value=name;d.querySelector('form').fire('submit');},
  cancel(){const b=this.dialog()?.querySelector('[data-company-cancel]');assert.ok(b,'visible Cancel/Close');b.click();},
 };
 h.ready=autoLoad?hydrate():Promise.resolve();return h;
}
async function opened(options){const h=browser(options);await h.ready;h.selectAdd();return h;}
function post(h){return h.requests.find(r=>r.init.method==='POST');}

test('visible header Add opens a live name form without navigating or mounting hidden tabs',async()=>{
 const h=await opened();const d=h.dialog();assert.ok(d?.open,'header exposes the form in a real dialog');assert.equal(h.navigations.length,0);assert.equal(h.window.location.pathname,'/buzzy/talk');assert.equal(h.input(),h.document.activeElement);assert.equal(d.getAttribute('aria-labelledby'),'bzCompanyCreateTitle');assert.equal(h.header.querySelector('select').value,A.id);assert.equal(h.requests.length,1);
});
test('header Add works on Memory without a Talk detour or an account-scope change',async()=>{
 const h=await opened({location:'/buzzy/memory'});assert.ok(h.dialog()?.open);assert.equal(h.api.activeId(),A.id);assert.equal(h.navigations.length,0);h.cancel();assert.equal(h.api.activeId(),A.id);assert.equal(h.requests.length,1);
});
for(const action of ['Cancel','Escape'])test(action+' before submit leaves company, storage and conversation untouched',async()=>{
 const h=await opened();const before=h.storage.get('bz_active_company');if(action==='Cancel')h.cancel();else h.dialog().fire('cancel');assert.equal(h.dialog(),null);assert.equal(h.api.activeId(),A.id);assert.equal(h.storage.get('bz_active_company'),before);assert.equal(h.requests.length,1);assert.equal(h.document.activeElement,h.header.querySelector('select'));
});
test('valid owner-create response selects once, closes form and persists header selection',async()=>{
 const h=await opened();let changes=0;h.api.onChange(()=>changes++);h.submit('  New company  ');const r=post(h);assert.ok(r);assert.equal(r.url,'/api/buzzy/companies');assert.equal(r.init.credentials,'same-origin');assert.deepEqual(JSON.parse(r.init.body),{name:'New company'});assert.equal(h.api.activeId(),A.id);assert.equal(h.input().disabled,true);r.resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),NEW.id);assert.equal(h.storage.get('bz_active_company'),NEW.id);assert.equal(h.api.list().length,3);assert.equal(h.dialog(),null);assert.equal(changes,2);assert.equal(h.header.querySelector('select').value,NEW.id);
});
test('repeated Add and submit while pending preserve one dialog and one create request',async()=>{
 const h=await opened();const d=h.dialog();h.selectAdd();assert.equal(h.dialog(),d);h.submit();h.submit();assert.equal(h.requests.filter(r=>r.init.method==='POST').length,1);post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.api.list().filter(c=>c.id===NEW.id).length,1);
});
for(const value of ['', '   ', 'x'.repeat(81)])test('invalid name '+JSON.stringify(value.slice(0,8))+' does not send create',async()=>{
 const h=await opened();h.submit(value);assert.equal(post(h),undefined);assert.match(h.status().textContent,/name|80/i);assert.equal(h.api.activeId(),A.id);
});
for(const outcome of ['401','400','403','500','network','timeout','JSON','empty company','invalid id','invalid name'])test('create '+outcome+' keeps prior selection and exposes a usable failure state',async()=>{
 const h=await opened();h.submit();const r=post(h);assert.ok(r,'create begins');
 if(outcome==='network'||outcome==='timeout')r.reject(Object.assign(Error('synthetic failure'),{name:outcome==='timeout'?'TimeoutError':'TypeError'}));
 else if(outcome==='JSON')r.resolve({ok:true,status:201,json:async()=>{throw Error('bad JSON');}});
 else if(/^\d/.test(outcome))r.resolve(response({error:'synthetic rejected'},Number(outcome)));
 else r.resolve(response({company:outcome==='empty company'?{}:outcome==='invalid id'?{...NEW,id:'bad'}:{...NEW,name:[]}},201));
 await settle();assert.equal(h.api.activeId(),A.id);assert.equal(h.api.list().length,2);assert.equal(h.storage.get('bz_active_company'),A.id);assert.ok(h.dialog()?.open);assert.match(h.status().textContent,/couldn|sign in|permission|name/i);assert.ok(h.dialog().querySelector('[data-company-cancel]'));assert.equal(h.requests.length,2);
});
for(const outcome of ['success','failure','delayed JSON'])test('closing a pending form prevents late '+outcome+' from changing the active company',async()=>{
 const h=await opened();h.submit();const r=post(h);let body;
 if(outcome==='delayed JSON'){body=deferred();r.resolve({ok:true,status:201,json:()=>body.promise});await settle();}
 h.cancel();assert.equal(h.dialog(),null);
 if(outcome==='failure')r.reject(Error('old failure'));else if(body)body.resolve({company:NEW});else r.resolve(response({company:NEW},201));
 await settle();assert.equal(h.dialog(),null);assert.equal(h.api.activeId(),A.id);assert.equal(h.api.list().length,2);assert.equal(h.storage.get('bz_active_company'),A.id);
});
test('an older dismissed request cannot select or close a newer form',async()=>{
 const h=await opened();h.submit();const old=post(h);h.cancel();h.selectAdd();const fresh=h.dialog();old.resolve(response({company:NEW},201));await settle();assert.equal(h.dialog(),fresh);assert.equal(h.api.activeId(),A.id);assert.equal(h.input().disabled,false);assert.equal(h.status().textContent,'');
});
test('explicit company switch invalidates pending creation selection',async()=>{
 const h=await opened();h.submit();h.api.select(B.id);post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),B.id);assert.equal(h.storage.get('bz_active_company'),B.id);assert.equal(h.dialog(),null);
});
for(const kind of ['Back','Forward','pagehide'])test(kind+' dismisses the form and never reopens it on late completion',async()=>{
 const h=await opened();h.submit();h.emitWindow(kind==='pagehide'?'pagehide':'popstate');post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.dialog(),null);assert.equal(h.api.activeId(),A.id);
});
test('late response while a soft navigation is pending cannot select a company',async()=>{
 const h=await opened();h.submit();h.window.BeeZillaShell.busy=true;post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),A.id);assert.equal(h.storage.get('bz_active_company'),A.id);
});
test('shared store survives script replay across soft pages instead of losing subscriptions',async()=>{
 const h=await opened();h.cancel();let selected;h.api.onChange(co=>selected=co?.id);h.replayStore();assert.equal(h.window.BZCompanies,h.api);assert.equal(h.requests.length,1);h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();assert.equal(selected,NEW.id);
});
test('literal company name is text in header, never executable markup',async()=>{
 const h=await opened();h.submit('<img src=x onerror=alert(1)>');const name=h.input().value;post(h).resolve(response({company:{...NEW,name}},201));await settle();const option=h.header.querySelectorAll('option').find(n=>n.value===NEW.id);assert.equal(option.textContent,name);assert.equal(option.children.length,0);
});

// These controls also pass against the exact baseline: scope selection already
// works; the absent Add receiver, not a fixture import, is the feature defect.
test('existing header company switch stays owner-catalogue scoped',async()=>{
 const h=browser();await h.ready;const sel=h.header.querySelector('select');sel.value=B.id;sel.fire('change');assert.equal(h.api.activeId(),B.id);assert.equal(h.storage.get('bz_active_company'),B.id);sel.value='co_foreign1';sel.fire('change');assert.equal(h.api.activeId(),B.id);assert.equal(h.requests.length,1);
});
test('unselected company loading cannot create or choose an optimistic company',async()=>{
 const h=browser({autoLoad:false});assert.equal(h.header.querySelector('select').disabled,true);assert.equal(h.api.ready(),false);assert.equal(h.api.activeId(),null);assert.equal(h.requests.length,1);
});
test('script replay while catalogue is pending retains exactly one shared load',async()=>{
 const h=browser({autoLoad:false});h.replayStore();assert.equal(h.window.BZCompanies,h.api);assert.equal(h.requests.length,1);await h.hydrate();assert.equal(h.api.activeId(),A.id);
});
test('Add during a pending page transition does not expose a nonfunctional form',async()=>{
 const h=browser();await h.ready;h.window.BeeZillaShell.busy=true;h.selectAdd();assert.equal(h.dialog(),null);assert.equal(h.requests.length,1);
});
for(const destination of ['/buzzy/memory','/buzzy/talk','https://example.invalid/'])test('actual shell navigation intent to '+destination+' retires a pending form before completion',async()=>{
 const h=await opened();h.submit();const r=post(h);
 Object.assign(h.c,{navigationId:0,pendingNavigation:null,busy:false,currentReady:true,currentKey:'/buzzy/talk',cache:{},commitQueue:Promise.resolve(),
  keyOf:u=>{u=u instanceof URL?u:new URL(u,h.window.location);return u.pathname+u.search;},isShellPath:u=>u.origin===h.window.location.origin&&u.pathname.startsWith('/buzzy/'),
  history:{pushState(_state,_title,url){h.window.location.href=new URL(url,h.window.location).href;}},
 });
 vm.runInContext(fn(nav,'go',2),h.c);h.c.go(destination);assert.equal(h.dialog(),null,'close happens at intent, not after fetched page/body');r.resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),A.id);
});
function installMemory(h){
 const content=h.document.createElement('main');content.id='content';h.document.body.appendChild(content);Object.assign(h.c,{memGen:0,BZCompanies:h.api});
 vm.runInContext(fn(memory,'esc')+'\n'+fn(memory,'loadMemory'),h.c);h.api.onChange(()=>h.c.loadMemory());return content;
}
const memoryResponse=(companyId,body='Selected company history')=>response({scope:{companyId},facts:[],messages:[{role:'user',content:body,source:{kind:'session',id:'sess_history',title:'Conversation',companyId}}]});
test('creating on Memory replaces only the selected scope and discards an older response',async()=>{
 const h=browser({location:'/buzzy/memory'});await h.ready;const content=installMemory(h);const old=h.requests.at(-1);assert.equal(old.url,'/api/buzzy/memory?companyId='+A.id);
 h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();const current=h.requests.at(-1);assert.equal(current.url,'/api/buzzy/memory?companyId='+NEW.id);current.resolve(memoryResponse(NEW.id,'New scoped history'));await settle();old.resolve(memoryResponse(A.id,'Old scoped history'));await settle();assert.match(content.innerHTML,/New scoped history/);assert.doesNotMatch(content.innerHTML,/Old scoped history/);assert.ok(h.requests.filter(r=>r.url.startsWith('/api/buzzy/memory')).every(r=>r.url.includes('?companyId=')));
});
test('failed header creation cannot broaden existing company Memory',async()=>{
 const h=browser({location:'/buzzy/memory'});await h.ready;const content=installMemory(h);h.requests.at(-1).resolve(memoryResponse(A.id));await settle();h.selectAdd();h.submit();post(h).resolve(response({company:{}},201));await settle();assert.equal(h.api.activeId(),A.id);assert.match(content.innerHTML,/Selected company history/);assert.equal(h.requests.filter(r=>r.url.startsWith('/api/buzzy/memory')).length,1);assert.ok(!h.requests.some(r=>r.url==='/api/buzzy/memory'));
});
test('first company creation invalidates a formerly valid empty-account Memory read',async()=>{
 const h=browser({location:'/buzzy/memory',list:[]});await h.ready;const content=installMemory(h);const old=h.requests.at(-1);assert.equal(old.url,'/api/buzzy/memory');h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();const current=h.requests.at(-1);assert.equal(current.url,'/api/buzzy/memory?companyId='+NEW.id);current.resolve(memoryResponse(NEW.id,'New only'));await settle();old.resolve(memoryResponse(null,'Account only'));await settle();assert.match(content.innerHTML,/New only/);assert.doesNotMatch(content.innerHTML,/Account only/);
});
function installTalk(h,{verified=true,bound=null,sessionId='sess_companyless',jobId='job_old',messages=[{role:'user',content:'old conversation'}]}={}){
 const input=h.document.createElement('input');input.id='chatInput';h.document.body.appendChild(input);const send=h.document.createElement('button');send.id='chatSend';h.document.body.appendChild(send);const error=h.document.createElement('p');error.id='chatError';h.document.body.appendChild(error);
 const painted=[],restored=[];
 Object.assign(h.c,{BZCompanies:h.api,chatState:{sessionId,sessionVerified:verified,boundCompanyId:bound,jobId,jobContext:{jobId},paper:{body:'old paper'},slots:{},messages},
  chatNavigation:{generation:0,pending:null,ensure:null,restore:0,history:0,sendClaim:null,turn:{id:'old turn'},auth:0},paperOperation:0,paperBusy:false,
  speechContextChanged(){},renderPaper:v=>painted.push(v),resetDraftGate(){},renderChatMessages(){},renderSlotChecklist(){},loadCompanyPaper(){},welcomeMessage:()=> 'Welcome',restoreTranscript:()=>restored.push(true),loadSessions(){},
  SESSIONS_BASE:'/api/buzzy/sessions',speechRequestCurrent:()=>true,
 });
 h.storage.set('bz_session_id',sessionId);
 const names=['activeCompanyId','chatContextSnapshot','chatContextCurrent','beginChatNavigation','finishChatNavigation','storeChatSession','applyChatCompany','ensureChatSession','validChatSession','showChatFailure'];
 vm.runInContext(names.map(n=>fn(talk,n)).join('\n'),h.c);h.api.onChange(h.c.applyChatCompany);
 return {painted,restored};
}
test('first company creation starts a new scope instead of relabeling verified company-less history',async()=>{
 const h=browser({list:[]});await h.ready;const t=installTalk(h);const oldContext=h.c.chatContextSnapshot(),oldMessages=h.c.chatState.messages;h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.c.chatState.boundCompanyId,NEW.id);assert.equal(h.c.chatState.sessionId,null);assert.equal(h.c.chatState.sessionVerified,false);assert.equal(h.c.chatState.jobId,null);assert.equal(h.storage.has('bz_session_id'),false);assert.equal(h.c.chatState.paper,null);assert.equal(h.c.chatNavigation.turn,null);assert.equal(h.c.chatContextCurrent(oldContext),false);assert.equal(oldMessages[0].content,'old conversation');assert.equal(t.painted.at(-1),null);
 const next=h.c.ensureChatSession();const request=h.requests.at(-1);assert.deepEqual(JSON.parse(request.init.body),{companyId:NEW.id});request.resolve(response({session:{id:'sess_new_company',jobId:null,companyId:NEW.id}},201));await next;assert.equal(h.c.chatState.sessionId,'sess_new_company');assert.equal(h.storage.get('bz_session_id'),'sess_new_company');
});
test('unverified stored session keeps hydration/restore semantics when company arrives',async()=>{
 const h=browser();await h.ready;const t=installTalk(h,{verified:false,messages:[]});assert.equal(h.c.chatState.sessionId,'sess_companyless');assert.equal(h.c.chatState.jobId,'job_old');assert.equal(h.c.chatState.boundCompanyId,A.id);assert.equal(h.c.chatNavigation.generation,0);assert.equal(h.storage.get('bz_session_id'),'sess_companyless');assert.equal(t.restored.length,1);
});
test('cancelling Add leaves a verified company-less conversation and turn intact',async()=>{
 const h=browser({list:[]});await h.ready;installTalk(h);const snapshot=h.c.chatContextSnapshot(),turn=h.c.chatNavigation.turn;h.selectAdd();h.cancel();assert.equal(h.c.chatContextCurrent(snapshot),true);assert.equal(h.c.chatState.sessionId,'sess_companyless');assert.equal(h.c.chatNavigation.turn,turn);assert.equal(h.storage.get('bz_session_id'),'sess_companyless');
});
test('creation in another soft page reaches the live Talk company subscriber',async()=>{
 const h=browser();await h.ready;installTalk(h,{bound:A.id});h.replayStore();h.window.location.pathname='/buzzy/memory';h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.c.chatState.boundCompanyId,NEW.id);assert.equal(h.c.chatState.sessionId,null);assert.equal(h.c.chatState.jobId,null);
});
test('old pending session ensure cannot attach after first company creation',async()=>{
 const h=browser({list:[]});await h.ready;installTalk(h,{verified:false,sessionId:null,jobId:null});const pending=h.c.ensureChatSession();const old=h.requests.at(-1);h.selectAdd();h.submit();const create=h.requests.find(r=>r.url==='/api/buzzy/companies'&&r.init.method==='POST');create.resolve(response({company:NEW},201));await settle();old.resolve(response({session:{id:'sess_old_pending',jobId:'job_old',companyId:null}},201));assert.equal(await pending,null);assert.equal(h.c.chatState.sessionId,null);assert.equal(h.c.chatState.jobId,null);assert.equal(h.c.chatState.boundCompanyId,NEW.id);assert.equal(h.storage.has('bz_session_id'),false);
});

test('actual company callback cannot relabel an already verified company-less session',async()=>{
 const h=browser({list:[]});await h.ready;installTalk(h);h.c.applyChatCompany(NEW);assert.equal(h.c.chatState.boundCompanyId,NEW.id);assert.equal(h.c.chatState.sessionId,null);assert.equal(h.c.chatState.jobId,null);assert.equal(h.storage.has('bz_session_id'),false);
});
test('correctable name rejection permits one explicit retry without changing scope early',async()=>{
 const h=await opened();h.submit('Bad');post(h).resolve(response({error:'bad name'},400));await settle();assert.equal(h.input().disabled,false);assert.equal(h.api.activeId(),A.id);h.submit('New company');const requests=h.requests.filter(r=>r.init.method==='POST');assert.equal(requests.length,2);requests[1].resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),NEW.id);
});
test('unknown create outcome disables retry in that form rather than blindly duplicating a possible save',async()=>{
 const h=await opened();h.submit();post(h).reject(Error('lost reply'));await settle();assert.match(h.status().textContent,/reload.*check.*trying again/i);h.submit();assert.equal(h.requests.filter(r=>r.init.method==='POST').length,1);assert.equal(h.api.activeId(),A.id);
});
test('switching away and back does not revive an old create intent',async()=>{
 const h=await opened();h.submit();h.api.select(B.id);h.api.select(A.id);post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),A.id);assert.equal(h.dialog(),null);
});

const library=readFileSync(resolve(ROOT,'public/buzzy/library.html'),'utf8');
test('detached actual Library subscriber cannot reassign old jobs or overwrite newer saved work',async()=>{
 const h=browser({list:[],location:'/buzzy/library'});await h.ready;const oldPage=h.document.createElement('main');oldPage.id='app';h.document.body.appendChild(oldPage);
 Object.assign(h.c,{BZCompanies:h.api,STORAGE_KEY:'beezilla-jobs-v1',catalog:{jobs:[{id:'job_old',title:'Old unassigned work',problem:'old content',messages:[],companyId:null}],currentId:'job_old'},state:{id:'job_old',screen:'docs',problem:'old content',messages:[],companyId:null},serverMerged:true,goDocs(){},goJobs(){},docsOpenFolder:null,docsOpenDoc:null});
 const helpers=['firstCompanyId','workspaceCompanyId','assignUnassignedToFirstCompany','applyActiveCompanyToFreshJob','pushJob','jobTitle','jobStatus','jobComplete'].map(n=>fn(library,n)).join('\n');
 const listener=library.match(/    if \(window\.BZCompanies\) \{\n      BZCompanies\.onChange\(function \(\) \{[^]*?\n      \}\);\n    \}/)[0];
 vm.runInContext(helpers+'\n'+listener,h.c);assert.equal(h.requests.length,1);
 oldPage.remove();h.window.location.pathname='/buzzy/memory';h.replayStore();const newer=JSON.stringify({jobs:[{id:'job_newer',title:'Newer saved work'}],currentId:'job_newer'});h.storage.set('beezilla-jobs-v1',newer);
 h.selectAdd();h.submit();post(h).resolve(response({company:NEW},201));await settle();assert.equal(h.api.activeId(),NEW.id);assert.equal(h.requests.filter(r=>r.url==='/api/buzzy/jobs').length,0);assert.equal(h.storage.get('beezilla-jobs-v1'),newer);assert.equal(h.c.catalog.jobs[0].companyId,null);assert.equal(h.c.state.companyId,null);
});
test('detached Memory callback cannot read or repaint a new page global content root',async()=>{
 const h=browser({location:'/buzzy/memory'});await h.ready;const old=installMemory(h);h.requests.at(-1).resolve(memoryResponse(A.id));await settle();old.remove();const current=h.document.createElement('main');current.id='content';current.innerHTML='Different live page';h.document.body.appendChild(current);
 const before=h.requests.length;h.api.select(B.id);await settle();assert.equal(h.requests.length,before);assert.equal(current.innerHTML,'Different live page');
});
test('connected cached Talk subscriber follows company changes while detached headers retire',async()=>{
 const h=browser();await h.ready;const main=h.document.createElement('main');h.document.body.appendChild(main);installTalk(h,{bound:A.id});const cache=h.document.createElement('div');cache.id='bzPageCache';h.document.body.appendChild(cache);cache.appendChild(main);
 const oldSelect=h.header.querySelector('select');h.header.remove();const page=h.document.createElement('div');page.id='bzPage';h.document.body.appendChild(page);const newMain=h.document.createElement('main');page.appendChild(newMain);const freshHeader=h.document.createElement('nav');page.appendChild(freshHeader);h.c.companyControl(freshHeader);
 const oldOptions=oldSelect.innerHTML;h.api.select(B.id);assert.equal(h.c.chatState.boundCompanyId,B.id);assert.equal(h.c.chatState.sessionId,null);assert.equal(oldSelect.innerHTML,oldOptions);assert.equal(freshHeader.querySelector('select').value,B.id);assert.equal(main.isConnected,true);
});
test('explicit unsubscribe and disconnected owner stop subsequent notifications',async()=>{
 const h=browser();await h.ready;const owner=h.document.createElement('main');h.document.body.appendChild(owner);let calls=0;const off=h.api.onChange(()=>calls++,owner);assert.equal(calls,1);off();h.api.select(B.id);assert.equal(calls,1);h.api.onChange(()=>calls++,owner);assert.equal(calls,2);owner.remove();h.api.select(A.id);assert.equal(calls,2);
});

test('current live page owns subscriptions even when cached Talk main appears earlier in the DOM',async()=>{
 const h=browser();await h.ready;const cache=h.document.createElement('div');cache.id='bzPageCache';h.document.body.appendChild(cache);const cachedMain=h.document.createElement('main');cache.appendChild(cachedMain);
 const page=h.document.createElement('div');page.id='bzPage';h.document.body.appendChild(page);const currentMain=h.document.createElement('main');page.appendChild(currentMain);let calls=0;h.api.onChange(()=>calls++);assert.equal(calls,1);currentMain.remove();h.api.select(B.id);assert.equal(calls,1);assert.equal(cachedMain.isConnected,true);
});
test('canonical-collision removal retires the old cached Talk subscriber',async()=>{
 const h=browser();await h.ready;const page=h.document.createElement('div');page.id='bzPage';h.document.body.appendChild(page);const main=h.document.createElement('main');page.appendChild(main);let calls=0;h.api.onChange(()=>calls++);
 const cache=h.document.createElement('div');cache.id='bzPageCache';h.document.body.appendChild(cache);cache.appendChild(page);page.removeAttribute('id');h.api.select(B.id);assert.equal(calls,2,'connected cached Talk follows scope');page.remove();h.api.select(A.id);assert.equal(calls,2,'removed collision cannot keep reacting');
});
