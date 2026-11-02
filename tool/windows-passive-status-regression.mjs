import assert from 'node:assert/strict';
import { inspectWindowsPassiveStatus } from '../dist/service/windows-passive-status.js';
import { inspectWindowsNative } from '../dist/service/visible-browser-session.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerWebBrowserBridgeTools } from '../dist/tool/web-browser-bridge.js';

const native = { pid:42, name:'msedge', sessionId:7, sameUser:true, sameSession:true,
  inputReady:true, sessionLockStateKnown:true, sessionLocked:false, headless:false, sessionDisplayState:1, consoleDisplayState:1 };
let calls = [];
const probe = async (port, timeout) => { calls.push({port,timeout}); return {...native}; };
const neverReady = result => {
  assert.equal(result.visibilityVerified, false);
  assert.equal(result.userInteractionReady, false);
  assert.equal(result.requiresExactTargetVerification, true);
  assert.equal(result.cdpReadiness.ready,false);
  assert.equal(result.cdpReadiness.requiresDisplayOn,false);
  assert.equal(result.cdpReadiness.requiresForeground,false);
  assert.equal(result.nativeGuiReadiness.ready,false);
};
for (const [port,budget,reason] of [[undefined,50,'NO_READY_CDP_ENDPOINT'],[NaN,50,'INVALID_CDP_PORT'],
  [0,50,'INVALID_CDP_PORT'],[9223,0,'DIAGNOSTIC_DEADLINE_EXHAUSTED']]) {
  const result = await inspectWindowsPassiveStatus(port,budget,probe);
  assert.equal(result.status,'NOT_PROBED'); assert.equal(result.reason,reason);
  assert.equal(result.probeAttempted,false); neverReady(result);
}
assert.equal(calls.length,0,'No undefined/invalid port or exhausted deadline reaches native code');
for (const port of [9223,9224]) {
  const result = await inspectWindowsPassiveStatus(port,500,probe);
  assert.equal(result.endpoint,`http://127.0.0.1:${port}`);
  assert.equal(result.status,'WINDOWS_NATIVE_DESKTOP_ELIGIBLE'); neverReady(result);
}
assert.deepEqual(calls,[{port:9223,timeout:500},{port:9224,timeout:500}]);
const cdpOnlyEligible=await inspectWindowsPassiveStatus(9223,100,async()=>({...native,inputReady:false}));
assert.equal(cdpOnlyEligible.reason,'INPUT_DESKTOP_UNAVAILABLE');
assert.equal(cdpOnlyEligible.cdpReadiness.sessionEligible,true,'InputDesktop access does not gate CDP session eligibility');
for (const [patch,reason] of [[{sessionLocked:true},'SESSION_LOCKED'],[{sessionLockStateKnown:false},'SESSION_STATE_UNKNOWN']]) {
 const denied=await inspectWindowsPassiveStatus(9223,100,async()=>({...native,...patch}));
 assert.equal(denied.reason,reason); assert.equal(denied.cdpReadiness.sessionEligible,false);
}
for (const [patch,reason] of [[{sameSession:false},'SESSION_MISMATCH'],[{sameUser:false},'ACCOUNT_MISMATCH'],
  [{inputReady:false},'INPUT_DESKTOP_UNAVAILABLE'],[{sessionId:0},'NONINTERACTIVE_SESSION'],
  [{headless:true},'HEADLESS_BROWSER'],[{name:'node'},'NOT_BROWSER_PROCESS']]) {
  const result=await inspectWindowsPassiveStatus(9223,100,async()=>({...native,...patch}));
  assert.equal(result.status,'WINDOWS_NATIVE_DESKTOP_INELIGIBLE');
  assert.equal(result.reason,reason); assert.equal(result.probeAttempted,true); neverReady(result);
}
const missing=await inspectWindowsPassiveStatus(9223,100,async()=>({pid:42}));
assert.equal(missing.reason,'INCOMPLETE_NATIVE_EVIDENCE'); neverReady(missing);
const unavailable=await inspectWindowsPassiveStatus(9223,100,async()=>{throw Error('private native error');});
assert.equal(unavailable.status,'WINDOWS_NATIVE_PROBE_UNAVAILABLE');
assert.equal(unavailable.reason,'NATIVE_PROBE_FAILED'); assert.ok(!JSON.stringify(unavailable).includes('private'));
const off=await inspectWindowsPassiveStatus(9223,100,async()=>({...native,sessionDisplayState:0}));
assert.equal(off.sessionDisplayState,0); neverReady(off);
assert.equal(off.cdpReadiness.sessionEligible,true);
assert.equal(off.status,'WINDOWS_NATIVE_DESKTOP_ELIGIBLE');
assert.equal(off.nativeGuiReadiness.status,'WINDOW_FOREGROUND_AND_TARGET_NOT_VERIFIED');
const started=performance.now();
const timeout=await inspectWindowsPassiveStatus(9223,25,()=>new Promise(()=>{}));
assert.equal(timeout.reason,'NATIVE_PROBE_TIMEOUT'); assert.equal(timeout.probeAttempted,true);
assert.ok(performance.now()-started<1000,'Native diagnostics must not outlive a stalled probe'); neverReady(timeout);
await assert.rejects(inspectWindowsNative(undefined));
await assert.rejects(inspectWindowsNative(9223,0));
// Real diagnostic registration: periodic response bytes cannot extend the deadline.
const handlers = new Map();
registerWebBrowserBridgeTools({registerTool(name,config,handler){handlers.set(name,{config,handler});}}, {mode:'bearer',bearerTokens:['fixture']});
const requests=[];
const cdp=createServer((req,res)=>{
  requests.push({method:req.method,path:req.url}); res.writeHead(200); res.write('[');
  const interval=setInterval(()=>res.write(' '),10);
  res.on('close',()=>clearInterval(interval));
});
cdp.listen(0,'127.0.0.1'); await once(cdp,'listening');
const port=cdp.address().port;
const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');
try {
  Object.defineProperty(process,'platform',{value:'win32',configurable:true});
  const status=handlers.get('read_.web.browser.status');
  const input=status.config.inputSchema.parse({ports:[port],timeoutMs:250});
  const start=performance.now();
  const result=JSON.parse((await status.handler(input)).content[0].text);
  assert.ok(performance.now()-start<1500,'The whole diagnostic must have a wall-clock deadline');
  assert.equal(result.desktop_agent.status,'NOT_PROBED');
  assert.equal(result.desktop_agent.reason,'NO_READY_CDP_ENDPOINT');
  assert.equal(result.visibility_verified,false); assert.equal(result.user_interaction_ready,false);
  assert.deepEqual(requests,[{method:'GET',path:'/json/list'}]);
} finally {Object.defineProperty(process,'platform',originalPlatform);cdp.close(); await once(cdp,'close');}
console.log('WINDOWS_PASSIVE_STATUS_GREEN: no probe, unavailable, denial, endpoint, deadline and no readiness');
