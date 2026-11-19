const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const talk=fs.readFileSync('public/buzzy/talk.html','utf8'),nav=fs.readFileSync('public/buzzy/nav.js','utf8'),pilot=fs.readFileSync('public/buzzy/pilot.js','utf8');
let starts=0,n=0;const listeners=new Map();const c={voice:{},document:{addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k,f)=>{if(listeners.get(k)===f)listeners.delete(k)}},listenPref:()=>true,paintVoice(){},startListening:()=>starts++,saveListenPref(){},stopListening(){},stopSpeaking(){},saveVoicePref(){},releaseMic(){},localStorage:{setItem(k,v){c.saved=c.saved||{};c.saved[k]=v}},window:{},setInterval(){},bzTitle:{apply(){}}};vm.createContext(c);
vm.runInContext(talk.slice(talk.indexOf('    var pendingVoiceResume'),talk.indexOf('    function toggleMic')),c);
const arm=talk.slice(talk.indexOf('      cancelVoiceResume();\n      if (listenPref())'),talk.indexOf('\n    }\n',talk.indexOf('      cancelVoiceResume();\n      if (listenPref())')));
const stop=talk.slice(talk.indexOf('        stop: function () {')+14,talk.indexOf('\n        },',talk.indexOf('        stop: function () {'))+10);
vm.runInContext('var stopVoice = '+stop,c);
function check(f){f();n++}function armNow(){vm.runInContext("(function(){"+arm+"})()",c);return c.pendingVoiceResume}
check(()=>{armNow();assert.equal(starts,0);assert.equal(c.voice.armed,true)});
for(const key of ['Tab','ArrowLeft','Escape','Enter',' ']) check(()=>{const resume=armNow();resume({type:'keydown',key,target:{closest:()=>true}});assert.equal(starts,0);assert.equal(c.voice.armed,true)});
for(const activation of ['pointer','Enter','Space'])check(()=>{const resume=armNow();resume({target:{closest:()=>true}});c.stopVoice();resume({target:{closest:()=>false}});assert.equal(starts,0);assert.equal(c.voice.armed,false);assert.equal(listeners.size,0)});
check(()=>{const stale=armNow();armNow();stale({target:{closest:()=>false}});assert.equal(starts,0)});
check(()=>{const resume=armNow();resume({target:{closest:()=>false}});assert.equal(starts,1);assert.equal(listeners.size,0);c.voice.mic=false;resume({});assert.equal(starts,1)}); // failure after one start cannot resurrect capture
check(()=>{const resume=armNow();c.stopVoice();resume({});assert.equal(starts,1)});
const start=pilot.indexOf('  function presses(a)'),end=pilot.indexOf('\n  var CSS',start); // use balanced braces
let depth=0,finish;for(let i=pilot.indexOf('{',start);i<pilot.length;i++){if(pilot[i]==='{')depth++;if(pilot[i]==='}'&&!--depth){finish=i+1;break}}
vm.runInContext(pilot.slice(start,finish),c);
check(()=>{const p=c.presses({do:'speak',value:'off'})[0];p.perform();assert.equal(starts,1);assert.equal(c.saved.bz_listen_mode,"0");assert.equal(c.saved.bz_voice_replies,"0")});
check(()=>{let count=0;c.window.BeeZillaVoice={stop(){count++;},toggle(){throw Error('must not toggle')}};const p=c.presses({do:'speak',value:'off'})[0];p.perform();p.perform();assert.equal(count,2);assert.equal(starts,1)});
check(()=>{const p=c.presses({do:'speak',value:'off'})[0];c.window.BeeZillaVoice={stop:c.stopVoice};armNow();p.perform();assert.equal(c.voice.armed,false);assert.equal(listeners.size,0)});
check(()=>assert.match(pilot,/if \(p.perform\) return p.perform\(\) === false \? "missing" : "ok";[\s\S]*var target = await find/));
check(()=>assert.match(nav,/stop.hidden = !\(on \|\| armed\)/));
// Parse all inline scripts; no DOM/audio code executed.
for(const m of talk.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new Function(m[1]);
console.log(`PASS ${n} inert voice intent checks; native browser events/audio permission lifecycle not exercised`);
