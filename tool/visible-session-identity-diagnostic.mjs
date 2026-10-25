import assert from 'node:assert/strict';
import { readdir,readFile,stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { enforceVisibleBrowserTools } from '../dist/service/visible-browser-tools.js';
import { visibleCdpCommand } from '../dist/service/visible-browser-session.js';
import { runWithMcpRequestContext } from '../dist/Infrastructure/Diagnostics/RequestContext.js';
const targetId=process.argv[2];
if(!/^[A-Fa-f0-9]{32}$/.test(targetId??'')) throw new Error('Exact target ID required');
const scope='visible-live-'+randomUUID(), observations=[], failures=[];
const directory='/home/alex/smartresponse/mcp/console-mcp/var/transcript';
function collect(v,depth=0) {
 if(!v||typeof v!=='object'||depth>8)return;
 if(v.reason==='AMBIGUOUS_VISIBLE_SESSIONS'&&v.evidence?.browserPid) {
  const e=v.evidence;
  failures.push({reason:v.reason,browserPid:e.browserPid,browserInstance:e.browserInstance,
   targetId:e.targetId,windowId:e.windowId,cdpWindowId:e.cdpWindowId,display:e.display,
   guiSessionId:e.guiSessionId,x11Diagnostic:e.x11Diagnostic});
 }
 for(const value of Object.values(v)) {
  if(typeof value==='string'&&value.startsWith('{')) {try{collect(JSON.parse(value),depth+1)}catch{}}
  else if(value&&typeof value==='object')collect(value,depth+1);
 }
}
let filesRead=0;
for(const name of (await readdir(directory)).filter(n=>/\.(json|ndjson)$/.test(n)).sort().slice(-200)) {
 const path=directory+'/'+name;
 if((await stat(path)).size>2*1024*1024)continue;
 const raw=await readFile(path,'utf8');filesRead++;
 if(name.endsWith('.ndjson'))for(const line of raw.split('\n').slice(-300)){try{collect(JSON.parse(line))}catch{}}
 else {try{collect(JSON.parse(raw))}catch{}}
}
const inventory=async()=>((await(await fetch('http://127.0.0.1:9224/json/list')).json()).map(t=>t.id).sort());
const before=await inventory();
async function call(name,input) {
 const handlers=new Map();
 const server=enforceVisibleBrowserTools({registerTool(n,_c,h){handlers.set(n,h)}});
 // Staged native guard acceptance: read-only CDP observations, not worker authorization.
 server.registerTool(name,{},async args=>{
  if(name!=='write.web.browser.bind') {
   const pages=await(await fetch('http://127.0.0.1:9224/json/list')).json();
   const page=pages.find(p=>p.id===args.targetId);
   assert.ok(page,'Guard must supply an existing exact target');
   const observed=await visibleCdpCommand(page.webSocketDebuggerUrl,'Runtime.evaluate',{
    expression:'({ready:document.readyState,visible:document.visibilityState,forms:document.forms.length})',returnByValue:true});
   assert.ok(observed.result?.value);
  }
  return {content:[{type:'text',text:JSON.stringify({ok:true,status:'STAGED_NATIVE_OBSERVATION'})}]};
 });
 const response=await runWithMcpRequestContext(randomUUID(),()=>handlers.get(name)(input),scope);
 const body=JSON.parse(response.content.find(c=>c.type==='text').text);
 observations.push({name,ok:body.ok,status:body.status,reason:body.reason,
  visible_session:body.visible_session,telemetry:body.browser_telemetry});
 assert.equal(body.ok,true,JSON.stringify(observations.at(-1)));
}
await call('write.web.browser.bind',{targetId,browserSession:'visible'});
for(let i=0;i<3;i++) {
 await call('read_.web.form.inspect',{browserSession:'visible'});
 await call('read_.web.form.inspect',{});
 await call('read_.web.page.capture.dom',{browserSession:'visible',targetId});
}
assert.deepEqual(await inventory(),before,'Read-only acceptance must preserve every target');
console.log(JSON.stringify({filesRead,historicalAmbiguity:failures.slice(-5),observations,
 targetsUnchanged:true,browserRestarted:false,liveClicksAttempted:false,workerAuthorizationTested:false}));
