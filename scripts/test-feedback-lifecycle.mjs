import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/buzzy/feedback.js',import.meta.url),'utf8');
function harness(){
 const nodes=[], readers=[], requests=[], timers=[];
 function el(tag){ const n={tag,children:[],handlers:{},value:'',hidden:false,disabled:false,removed:false,className:'',setAttribute(){},appendChild(c){this.children.push(c);},addEventListener(k,f){this.handlers[k]=f;},focus(){},remove(){this.removed=true;}};n.classList={contains:k=>n.className.split(' ').includes(k),toggle(k,on){let s=new Set(n.className.split(' '));on?s.add(k):s.delete(k);n.className=[...s].join(' ');},remove(k){this.toggle(k,false);}}; nodes.push(n);return n; }
 const doc={createElement:el,createTextNode:t=>({textContent:t}),getElementById:id=>nodes.find(n=>n.id===id),head:el('head'),body:el('body')};
 const ctx={document:doc,window:{},location:{pathname:'/buzzy/talk'},FileReader:class{constructor(){readers.push(this);}readAsDataURL(){}},fetch:(url,opts)=>new Promise((resolve,reject)=>requests.push({resolve,reject,opts})),setTimeout:f=>(timers.push(f),timers.length),clearTimeout:id=>{timers[id-1]=()=>{};}};
 vm.runInNewContext(source,ctx);
 const open=()=>{ctx.window.BeeZillaFeedback.open(); const panel=nodes.filter(n=>n.className==='bz-fb').at(-1);return {panel,text:nodes.filter(n=>n.tag==='textarea').at(-1),input:nodes.filter(n=>n.tag==='input').at(-1),send:nodes.filter(n=>n.className==='bz-fb-send').at(-1),close:nodes.filter(n=>n.className==='bz-fb-close').at(-1),note:nodes.filter(n=>n.className==='bz-fb-note').at(-1),image:nodes.filter(n=>n.tag==='img').at(-1)};};
 return {open,readers,requests,timers,async settle(){for(let i=0;i<8;i++)await Promise.resolve();}};
}
function submit(p){p.text.value='test feedback';p.send.handlers.click();}
function select(p,name){p.input.files=[{name,size:12}];p.input.handlers.change();}
test('old success cannot close reopened panel',async()=>{const h=harness(),a=h.open();submit(a);a.close.handlers.click();const b=h.open();b.text.value='new draft';h.requests[0].resolve({json:async()=>({ok:true})});await h.settle();h.timers.forEach(f=>f());assert.equal(b.panel.removed,false);assert.equal(b.text.value,'new draft');assert.equal(b.note.textContent,undefined);});
test('old failure cannot unlock or change new submission',async()=>{const h=harness(),a=h.open();submit(a);a.close.handlers.click();const b=h.open();submit(b);h.requests[0].reject(new Error('offline'));await h.settle();assert.equal(b.send.disabled,true);assert.equal(b.note.textContent,'Sending…');});
test('success timer is retired on close',async()=>{const h=harness(),a=h.open();submit(a);h.requests[0].resolve({json:async()=>({ok:true})});await h.settle();a.close.handlers.click();const b=h.open();h.timers.forEach(f=>f());assert.equal(b.panel.removed,false);});
test('latest screenshot selection wins',()=>{const h=harness(),a=h.open();select(a,'old');select(a,'new');h.readers[1].result='data:new';h.readers[1].onload();h.readers[0].result='data:old';h.readers[0].onload();submit(a);assert.equal(JSON.parse(h.requests[0].opts.body).screenshot,'data:new');});
test('closed panel screenshot cannot leak into new draft',()=>{const h=harness(),a=h.open();select(a,'old');a.close.handlers.click();const b=h.open();h.readers[0].result='data:old';h.readers[0].onload();submit(b);assert.equal(JSON.parse(h.requests[0].opts.body).screenshot,null);});
test('normal success closes its own panel',async()=>{const h=harness(),a=h.open();submit(a);h.requests[0].resolve({json:async()=>({ok:true})});await h.settle();assert.equal(a.note.textContent,'Thank you. The team will read it.');h.timers.forEach(f=>f());assert.equal(a.panel.removed,true);});
test('clearing selection retires pending screenshot',()=>{const h=harness(),a=h.open();select(a,'old');a.input.files=[];a.input.handlers.change();h.readers[0].result='data:old';h.readers[0].onload();submit(a);assert.equal(JSON.parse(h.requests[0].opts.body).screenshot,null);});
test('current failure allows retry and double submit is ignored',async()=>{const h=harness(),a=h.open();submit(a);submit(a);assert.equal(h.requests.length,1);h.requests[0].reject(new Error('offline'));await h.settle();assert.equal(a.send.disabled,false);submit(a);assert.equal(h.requests.length,2);});
