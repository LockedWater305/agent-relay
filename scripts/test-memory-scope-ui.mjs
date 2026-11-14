#!/usr/bin/env node
/** Actual Memory/company browser functions, synthetic IO only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const ROOT=resolve(process.env.BZ_MEMORY_ROOT || new URL('..',import.meta.url).pathname);
const html=readFileSync(resolve(ROOT,'public/buzzy/memory.html'),'utf8');
const companySource=readFileSync(resolve(ROOT,'public/buzzy/companies.js'),'utf8');
function fn(name){const m=html.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    \\}`,'m'));assert.ok(m,name);return m[0];}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};}
async function settle(){for(let i=0;i<40;i++)await Promise.resolve();}
const CO={id:'co_companya1',name:'Company A'};
const OTHER={id:'co_companyb2',name:'Company B'};
const source=(kind='session',id='sess_owner',companyId=CO.id,title='Owned conversation')=>({kind,id,companyId,title});
function payload(companyId=CO.id,origin=source()) {return {scope:{companyId},honchoAvailable:false,
 facts:[{jobId:origin.kind==='session'?origin.id:'job_owner',key:'challenge',value:'Saved decision',updatedAt:'2026-11-14',source:origin}],
 messages:[{jobId:null,sessionId:'sess_owner',role:'user',content:'Saved conversation',createdAt:'2026-11-14',source:origin}]};}
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
function browser({company=CO,ready=true,loadError=false,fetcher=null,missingApi=false,actualCompanies=false}={}) {
 const requests=[],buttons=[],listeners=[];let active=company;
 const root={innerHTML:'',querySelectorAll:()=>buttons};
 const api={ready:()=>ready,active:()=>active,list:()=>active?[active]:[],loadError:()=>loadError,onChange:f=>listeners.push(f)};
 const doc={readyState:'complete',querySelector:()=>null,
  getElementById:id=>id==='content'?root:id==='bz-co-style'?{}:null,
  createElement:()=>({textContent:'',get innerHTML(){return this.textContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}})};
 const c={memGen:0,document:doc,window:{},localStorage:{getItem:()=>null,setItem(){}},fetch:(url,init)=>{
  const task=deferred();requests.push({...task,url,init});return fetcher?Promise.resolve(fetcher(url,init)):url.startsWith('/api/buzzy/jobs')?Promise.resolve(response({jobs:[]})):task.promise;
 }};
 if(actualCompanies){vm.runInNewContext(companySource,c);c.BZCompanies=c.window.BZCompanies;}
 else if(!missingApi){c.BZCompanies=api;c.window.BZCompanies=api;}
 vm.runInNewContext(fn('esc')+'\n'+fn('loadMemory'),c);
 return{c,root,requests,buttons,api:c.window.BZCompanies,company(v){active=v;},load(){return c.loadMemory();}};
}
test('Memory sends one owner-company scoped request and renders session-only facts/messages',async()=>{
 const h=browser({fetcher:url=>url.startsWith('/api/buzzy/jobs')?response({jobs:[]}):response(payload())});await h.load();
 assert.deepEqual(h.requests.map(r=>r.url),['/api/buzzy/memory?companyId='+CO.id]);
 assert.match(h.root.innerHTML,/Saved decision/);assert.match(h.root.innerHTML,/Saved conversation/);assert.match(h.root.innerHTML,/Owned conversation/);assert.match(h.root.innerHTML,/Memory for Company A/);
});
for(const label of ['Archived job','Legacy Talk job'])test('Memory displays backend-resolved '+label+' without active-job filtering',async()=>{
 const h=browser({fetcher:url=>response(url.includes('/jobs')?{jobs:[]}:payload(CO.id,source('job','job_history',CO.id,label)))});await h.load();
 assert.match(h.root.innerHTML,/Saved decision/);assert.match(h.root.innerHTML,new RegExp(label));assert.equal(h.requests.length,1);
});
test('verified no-company account shows preserved unassigned history',async()=>{
 const h=browser({company:null,fetcher:()=>response(payload(null,source('unassigned',null,null,null)))});await h.load();
 assert.equal(h.requests[0].url,'/api/buzzy/memory');assert.match(h.root.innerHTML,/Saved decision/);assert.match(h.root.innerHTML,/Unassigned memory/);
});
test('confirmed empty scoped result displays the actual empty state',async()=>{
 const h=browser({fetcher:()=>response({scope:{companyId:CO.id},facts:[],messages:[],honchoAvailable:false})});await h.load();assert.match(h.root.innerHTML,/No decisions captured yet/);assert.match(h.root.innerHTML,/No conversations yet/);
});
for(const status of [400,404,500,503])test('Memory HTTP '+status+' cannot fall back to account-wide data or false empty success',async()=>{
 const h=browser({fetcher:()=>response({error:'unavailable'},status)});await h.load();assert.equal(h.requests.length,1);assert.match(h.requests[0].url,/\?companyId=/);assert.match(h.root.innerHTML,/Couldn/);assert.doesNotMatch(h.root.innerHTML,/No decisions captured|No conversations yet/);
});
test('Memory401 shows sign-in state without issuing another read',async()=>{
 const h=browser({fetcher:()=>response({error:'signed out'},401)});await h.load();assert.match(h.root.innerHTML,/Sign in/);assert.equal(h.requests.length,1);
});
for(const kind of ['transport','JSON'])test('Memory '+kind+' failure clears old contents and stays scoped',async()=>{
 const h=browser();h.root.innerHTML='old company secret';const task=h.load();
 const clearedAtIntent=!h.root.innerHTML.includes('old company secret');
 if(kind==='transport')h.requests[0].reject(new Error('synthetic failure'));else h.requests[0].resolve({ok:true,status:200,json:async()=>{throw Error('invalid JSON');}});
 await task;assert.equal(clearedAtIntent,true);assert.match(h.root.innerHTML,/Couldn/);assert.equal(h.requests.length,1);assert.doesNotMatch(h.root.innerHTML,/No decisions captured/);
});
for(const kind of ['missing scope','wrong company','null company','wrong record company','malformed facts','malformed messages'])test('Memory rejects '+kind+' response without rendering records',async()=>{
 const data=payload();if(kind==='missing scope')delete data.scope;
 if(kind==='wrong company')data.scope.companyId=OTHER.id;
 if(kind==='null company')data.scope.companyId=null;
 if(kind==='wrong record company')data.facts[0].source.companyId=OTHER.id;
 if(kind==='malformed facts')data.facts=null;
 if(kind==='malformed messages')data.messages={};
 const h=browser({fetcher:()=>response(data)});await h.load();assert.match(h.root.innerHTML,/Couldn/);assert.doesNotMatch(h.root.innerHTML,/Saved decision|Saved conversation/);assert.equal(h.requests.length,1);
});
for(const kind of ['missing API','pending catalogue','failed catalogue','malformed company'])test('Memory '+kind+' never sends an unscoped account read',async()=>{
 const h=browser({missingApi:kind==='missing API',ready:kind!=='pending catalogue',company:kind==='failed catalogue'?null:kind==='malformed company'?{id:'',name:'Broken'}:CO,loadError:kind==='failed catalogue',fetcher:()=>response(payload(null))});
 await h.load();assert.equal(h.requests.length,0);assert.doesNotMatch(h.root.innerHTML,/Saved decision/);assert.match(h.root.innerHTML,kind==='pending catalogue'?/Loading/:/Couldn/);
});
test('known selected company remains explicitly scoped after a catalogue refresh failure',async()=>{
 const h=browser({loadError:true,fetcher:()=>response(payload())});await h.load();assert.equal(h.requests[0].url,'/api/buzzy/memory?companyId='+CO.id);assert.match(h.root.innerHTML,/Saved decision/);
});
for(const outcome of ['success','failure','JSON'])test('older '+outcome+' cannot overwrite newer company memory',async()=>{
 const h=browser();const old=h.load();let body;
 if(outcome==='JSON'){body=deferred();h.requests[0].resolve({ok:true,status:200,json:()=>body.promise});await settle();}
 h.company(OTHER);const current=h.load();const d=payload(OTHER.id,source('session','sess_other',OTHER.id,'B conversation'));d.facts[0].value='Company B decision';
 h.requests[1].resolve(response(d));await current;
 const before=h.root.innerHTML;
 if(outcome==='failure')h.requests[0].reject(Error('old failure'));else if(outcome==='JSON')body.resolve(payload());else h.requests[0].resolve(response(payload()));
 await old;assert.equal(h.root.innerHTML,before);assert.match(h.root.innerHTML,/Company B decision/);assert.doesNotMatch(h.root.innerHTML,/Saved decision/);
});
test('company switch while JSON is pending cannot retitle old data as the new company',async()=>{
 const h=browser();const body=deferred();const old=h.load();h.requests[0].resolve({ok:true,status:200,json:()=>body.promise});await settle();h.company(OTHER);body.resolve(payload());await old;
 assert.doesNotMatch(h.root.innerHTML,/Saved decision|Saved conversation|Memory for Company B/);
});
test('newer refresh in the same company owns response rendering',async()=>{
 const h=browser();const old=h.load(),current=h.load();const d=payload();d.facts[0].value='Newest decision';h.requests[1].resolve(response(d));await current;h.requests[0].resolve(response(payload()));await old;assert.match(h.root.innerHTML,/Newest decision/);assert.doesNotMatch(h.root.innerHTML,/Saved decision/);
});
test('source labels and saved data render as text; duplicate titles retain separate source groups',async()=>{
 const d=payload();d.facts[0].source.title='<img src=x onerror=alert(1)>';
 d.facts.push({...d.facts[0],value:'Second decision',source:source('job','job_distinct',CO.id,d.facts[0].source.title)});
 d.messages[0].source.title=d.facts[0].source.title;
 const h=browser({fetcher:()=>response(d)});await h.load();assert.match(h.root.innerHTML,/&lt;img/);assert.doesNotMatch(h.root.innerHTML,/<img src=x/);assert.equal((h.root.innerHTML.match(/class="mem-job"/g)||[]).length,2);
});
test('Memory fact drill-down still toggles its own source details',async()=>{
 const h=browser({fetcher:()=>response(payload())});let click;const detail={style:{display:'none'}};
 h.buttons.push({parentElement:{querySelector:()=>detail},classList:{toggle(){}},addEventListener:(kind,fn)=>{assert.equal(kind,'click');click=fn;}});await h.load();assert.equal(typeof click,'function');click();assert.equal(detail.style.display,'block');click();assert.equal(detail.style.display,'none');
});
for(const outcome of ['HTTP','network','JSON','malformed catalogue','empty catalogue','owned catalogue'])test('actual company loader '+outcome+' informs safe Memory scope',async()=>{
 const h=browser({actualCompanies:true});assert.equal(h.requests[0].url,'/api/buzzy/companies');
 if(outcome==='network')h.requests[0].reject(Error('offline'));
 else if(outcome==='JSON')h.requests[0].resolve({ok:true,status:200,json:async()=>{throw Error('bad JSON');}});
 else h.requests[0].resolve(response(outcome==='malformed catalogue'?{}:{companies:outcome==='owned catalogue'?[CO]:[]},outcome==='HTTP'?503:200));
 await settle();const failed=!['empty catalogue','owned catalogue'].includes(outcome);
 const loading=h.load();await settle();
 const reads=h.requests.filter(r=>r.url.startsWith('/api/buzzy/memory'));
 if(failed){for(const r of reads)r.resolve(response(payload(null)));await loading;assert.equal(reads.length,0);assert.match(h.root.innerHTML,/Couldn/);}
 else {assert.equal(reads.length,1);assert.equal(reads[0].url,outcome==='owned catalogue'?'/api/buzzy/memory?companyId='+CO.id:'/api/buzzy/memory');reads[0].resolve(response(outcome==='owned catalogue'?payload():payload(null,source('unassigned',null,null,null))));await loading;assert.match(h.root.innerHTML,/Saved decision/);}
});
test('actual company subscription loads Memory and switching companies owns its delayed JSON',async()=>{
 const h=browser({actualCompanies:true});
 const wiring=html.match(/^    if \(window\.BZCompanies\) BZCompanies\.onChange\(function \(\) \{ loadMemory\(\); \}\);\n    else loadMemory\(\);/m);
 assert.ok(wiring,'shipped Memory subscription exists');vm.runInNewContext(wiring[0],h.c);
 h.requests[0].resolve(response({companies:[CO,OTHER]}));await settle();
 assert.equal(h.requests[1].url,'/api/buzzy/memory?companyId='+CO.id);
 const oldBody=deferred();h.requests[1].resolve({ok:true,status:200,json:()=>oldBody.promise});await settle();
 h.api.select(OTHER.id);await settle();assert.equal(h.requests[2].url,'/api/buzzy/memory?companyId='+OTHER.id);
 const d=payload(OTHER.id,source('session','sess_b',OTHER.id,'Company B history'));d.facts[0].value='B selected fact';
 h.requests[2].resolve(response(d));await settle();oldBody.resolve(payload());await settle();
 assert.match(h.root.innerHTML,/B selected fact/);assert.doesNotMatch(h.root.innerHTML,/Saved decision/);
 assert.equal(h.requests.length,3,'one catalogue and two scoped memory reads only');
 assert.ok(h.requests.slice(1).every(r=>r.init.credentials==='same-origin'));
});
test('pending account-wide read cannot paint after company becomes active',async()=>{
 const h=browser({company:null});const body=deferred();const old=h.load();h.requests[0].resolve({ok:true,status:200,json:()=>body.promise});await settle();
 h.company(CO);body.resolve(payload(null,source('unassigned',null,null,null)));await old;
 assert.doesNotMatch(h.root.innerHTML,/Saved decision|Saved conversation/);
});
test('pending account-wide failure cannot paint after company becomes active',async()=>{
 const h=browser({company:null});const old=h.load();h.company(CO);h.root.innerHTML='current selected-company state';h.requests[0].reject(Error('old failure'));await old;assert.equal(h.root.innerHTML,'current selected-company state');
});

test('missing active selection in a nonempty verified catalogue cannot broaden to account memory',async()=>{
 const h=browser({company:null,fetcher:()=>response(payload(null))});h.api.list=()=>[CO];await h.load();assert.equal(h.requests.length,0);assert.match(h.root.innerHTML,/Couldn/);
});
test('pending empty-account read is discarded if catalogue becomes nonempty without a selected company',async()=>{
 const h=browser({company:null});const old=h.load();h.api.list=()=>[CO];h.requests[0].resolve(response(payload(null,source('unassigned',null,null,null))));await old;assert.doesNotMatch(h.root.innerHTML,/Saved decision/);
});
test('actual Add company name-submit malformed success cannot turn company Memory into an account-wide read',async()=>{
 const h=browser({actualCompanies:true});h.requests[0].resolve(response({companies:[CO]}));await settle();
 h.api.onChange(()=>h.c.loadMemory());await settle();h.requests[1].resolve(response(payload()));await settle();
 function control(attrs={}){return{value:'',events:{},focus(){},getAttribute:k=>attrs[k],addEventListener(k,fn){this.events[k]=fn;},fire(k){this.events[k]({preventDefault(){}});}};}
 const mount={querySelectorAll:()=>[],querySelector(selector){return selector==='.bz-co-add'?this.add:selector==='.bz-co-form'?this.form:null;},set innerHTML(html){
  this.html=html;this.add=control();this.form=null;
  if(html.includes('class="bz-co-form"')){
   const input=control(),cancel=control(),mode=control({'data-mode':html.includes('data-mode="name"')?'name':'website'});
   this.form=control();this.form.input=input;this.form.mode=mode;this.form.querySelector=s=>s==='input'?input:s==='.bz-co-cancel'?cancel:s==='[data-mode]'?mode:null;
  }
 }};
 h.api.mount(mount);mount.add.fire('click');assert.ok(mount.html.includes('data-mode="name"'));
 mount.form.mode.fire('click');mount.form.input.value='Synthetic new company';mount.form.fire('submit');
 assert.equal(h.requests[2].url,'/api/buzzy/companies');assert.equal(h.requests[2].init.method,'POST');
 h.requests[2].resolve(response({company:{}}));await settle();
 assert.equal(h.api.list().length,1);assert.equal(h.api.active(),null);
 const extra=h.requests.slice(3);for(const request of extra)request.resolve(response(payload(null,source('job','other',OTHER.id,'Other company'))));await settle();
 assert.equal(extra.length,0,'invalid active selection must never fall back to account-wide Memory');
 assert.match(h.root.innerHTML,/Couldn/);assert.doesNotMatch(h.root.innerHTML,/Other company|Saved decision/);
});
