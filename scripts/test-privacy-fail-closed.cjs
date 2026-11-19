// Offline full-handler execution with boundary mocks. No server or network.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.BZ_TEST_TYPESCRIPT || 'typescript');
let state;const forbidden=()=>{throw Error('unexpected dependency/network call')};globalThis.fetch=forbidden;
const sql=async parts=>{const q=parts.join('?');if(q.includes('buzzy_privacy_mode')){if(state.fail)throw Error('synthetic migration/read failure');return state.rows;}if(q.includes('buzzy_turn_log'))return [];throw Error('unexpected SQL');};
const req=id=>{
 if(id==='h3')return {defineEventHandler:f=>f,getMethod:e=>e.method,getHeader:()=>undefined,setResponseStatus:(e,s)=>e.status=s,setResponseHeader:()=>state.headers++};
 if(id==='@/lib/auth/verify.server')return {getSessionUserFromHeaders:async()=>({id:'fixture-owner'})};
 if(id==='@/lib/db')return {getSql:async()=>sql};
 if(id==='./entitlements')return {checkQuota:async()=>{state.quotas++;return {ok:true}},recordUsage:async()=>state.meter++};
 if(id==='./server')return {chatLoop:async args=>{state.chats++;state.privacy=args.privacy;return {ok:true,reply:'mock'}}};
 if(id==='./telemetry')return {recordTelemetry:async()=>{}};
 if(id==='./webpage')return {fetchPageText:async()=>{state.reads++;return {ok:true,text:'fixture',title:'mock',links:[]}}};
 if(id==='node:crypto')return require(id);
 return new Proxy({},{get:()=>forbidden});
};
const moduleObj={exports:{}};const src=fs.readFileSync('src/lib/buzzy/chat.nitro.ts','utf8');const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInThisContext('(function(require,module,exports){'+out+'\n})')(req,moduleObj,moduleObj.exports);const handler=moduleObj.exports.default;
async function run(route,rows,fail,body={}){state={rows,fail,meter:0,quotas:0,chats:0,reads:0,headers:0};const e={method:route==='chat'?'POST':'GET',path:route==='chat'?'/api/buzzy/chat':'/api/buzzy/read?url=https%3A%2F%2Ffixture.example',req:{headers:{},json:async()=>({message:'fixture',...body})},status:200};return {result:await handler(e),e};}
(async()=>{let n=0;
for(const body of [{},{stream:true},{voice:true},{privacy:'open'},{privacy:'lockdown'}]){const {result,e}=await run('chat',[],true,body);assert.equal(e.status,503);assert.equal(result.code,'privacy_policy_unavailable');assert.equal(state.meter+state.quotas+state.chats+state.reads+state.headers,0);n++;}
{const {result,e}=await run('read',[],true);assert.equal(e.status,503);assert.equal(result.code,'privacy_policy_unavailable');assert.equal(state.reads,0);n++;}
for(const mode of [null,'open','advocate','lockdown']){const rows=mode?[{mode}]:[];const {e}=await run('read',rows,false);assert.equal(e.status,mode==='lockdown'?403:200);assert.equal(state.reads,mode==='lockdown'?0:1);n++;}
for(const [saved,requested,want] of [[null,undefined,undefined],[null,'lockdown','lockdown'],['open',undefined,'open'],['advocate',undefined,'advocate'],['lockdown','open','lockdown'],['open','lockdown','lockdown']]){await run('chat',saved?[{mode:saved}]:[],false,{privacy:requested});assert.equal(state.chats,1);assert.equal(state.privacy,want);assert.equal(state.meter,1);n++;}
console.log('PASS '+n+' full-handler privacy invariants (mock DB/provider/metering; no real outbound work)');})().catch(e=>{console.error(e);process.exitCode=1});
