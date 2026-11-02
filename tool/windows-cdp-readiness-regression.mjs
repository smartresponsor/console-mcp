import assert from 'node:assert/strict';
import { mock } from 'node:test';
import childProcess from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

// Exercise the production verifier with deterministic OS/CDP boundaries, on either OS.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalExecFile=childProcess.execFile;
Object.defineProperty(process, 'platform', { value:'win32', configurable:true });
mock.method(os, 'platform', () => 'win32');
const target='A'.repeat(32), other='B'.repeat(32);
const bounds={left:0,top:0,width:800,height:600,windowState:'normal'};
const window={id:'123',pid:42,threadId:43,windowClass:'Chrome_WidgetWin_1',visible:true,
  ...bounds,minimized:false,cloaked:0};
const native={pid:42,name:'msedge',startedAt:'2026-01-01',profile:'fixture',userSid:'SID',user:'fixture',
  sessionId:7,sameUser:true,sameSession:true,inputReady:true,sessionLockStateKnown:true,sessionLocked:false,headless:false,
  windows:[window],foregroundWindowIdBefore:'123',foregroundWindowIdAfter:'123',consoleDisplayState:1,sessionDisplayState:1};
let snapshots, nativeCalls, lists, versions, windows, pageVisible, cdpPid;
const clone=v=>structuredClone(v);
function reset() { snapshots=[clone(native),clone(native)];nativeCalls=lists=versions=windows=0;pageVisible=true;cdpPid=42; }
const execute=()=>Promise.resolve({stdout:JSON.stringify(snapshots[Math.min(nativeCalls++,snapshots.length-1)])});
const fakeExec=()=>{};
fakeExec[promisify.custom]=execute;
childProcess.execFile=fakeExec;
syncBuiltinESMExports();
const oldFetch=globalThis.fetch, oldSocket=globalThis.WebSocket;
let replaceTarget=false, replaceInstance=false, moveWindow=false, socketPort=9223, cdpWindow=1;
globalThis.fetch=async url=>({ok:true,json:async()=>new URL(url).port !== '9223' ? [] : String(url).endsWith('/json/version')
  ? {webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/'+(replaceInstance && versions++>0?'new':'fixture')}
  : (lists++>0 && replaceTarget ? [{id:other,type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:9223/other'}]
    : [{id:target,type:'page',webSocketDebuggerUrl:`ws://127.0.0.1:${socketPort}/page`}])});
globalThis.WebSocket=class {
  listeners={}; constructor(){queueMicrotask(()=>this.listeners.open?.());}
  addEventListener(name,fn){this.listeners[name]=fn;} close(){}
  send(raw){const q=JSON.parse(raw);let result={};
    if(q.method==='Browser.getWindowForTarget')result={windowId:moveWindow && windows++>0?2:cdpWindow,bounds};
    if(q.method==='SystemInfo.getProcessInfo')result={processInfo:[{type:'browser',id:cdpPid}]};
    if(q.method==='Runtime.evaluate')result={result:{value:q.params.expression.includes('document.visibilityState')?pageVisible:false}};
    queueMicrotask(()=>this.listeners.message({data:JSON.stringify({id:q.id,result})}));
  }
};
try {
  const {inspectVisibleTarget, selectVisibleTarget}=await import('../dist/service/visible-browser-session.js');
  const {enforceVisibleBrowserTools}=await import('../dist/service/visible-browser-tools.js');
  const read = (options={}) => inspectVisibleTarget({port:9223,targetId:target,...options});
  reset(); const first=await read(); assert.equal(first.ok,true);
  // This is also the default used by the unchanged Browsing HTTP middleware.
  assert.equal(first.capability,'cdp'); assert.equal(first.cdp_ready,true);
  for (const patch of [
    {foregroundWindowIdBefore:'456',foregroundWindowIdAfter:'456'},
    {windows:[{...window,minimized:true}]},
    {windows:[{...window,cloaked:1}]},
    {windows:[]},
    {windows:[window,{...window,id:'456'}]},
  ]) {
    reset(); snapshots=[{...clone(native),...patch}]; pageVisible=false;
    const cdp=await read({expected:first.evidence});
    assert.equal(cdp.ok,true,JSON.stringify(cdp));
    assert.equal(cdp.cdp_ready,true); assert.equal(cdp.native_gui_ready,false);
    assert.equal(cdp.visibility_verified,false); assert.equal(cdp.user_interaction_ready,false);
    assert.ok(!cdp.states.includes('USER_INTERACTION_READY'));
    reset(); snapshots=[{...clone(native),...patch}];
    assert.equal((await read({capability:'native-gui'})).ok,false,'GUI must retain desktop evidence');
  }
  reset(); snapshots=[{...clone(native),sessionDisplayState:0,consoleDisplayState:0}];
  const lidClosed=await read({capability:'native-gui'});
  assert.equal(lidClosed.ok,true,'Closed laptop lid must not deny an otherwise foreground-owned native GUI session');
  reset(); bounds.windowState='minimized';
  assert.equal((await read()).ok,true,'CDP minimized bounds are not a desktop requirement');
  assert.equal((await read({capability:'native-gui'})).ok,false); bounds.windowState='normal';
  for (const capability of ['cdp','native-gui']) {
    reset(); snapshots=[{...clone(native),sessionLocked:true}];
    const locked=await read({capability});
    assert.equal(locked.ok,false); assert.equal(locked.reason,'SESSION_LOCKED');
    reset(); snapshots=[{...clone(native),sessionLockStateKnown:false,sessionLocked:false}];
    const unknownLock=await read({capability});
    assert.equal(unknownLock.ok,false); assert.equal(unknownLock.reason,'SESSION_STATE_UNKNOWN');
    reset(); snapshots=[{...clone(native),inputReady:false}];
    const inputUnavailable=await read({capability});
    if (capability==='cdp') assert.equal(inputUnavailable.ok,true,'InputDesktop access does not gate CDP/Playwright');
    else { assert.equal(inputUnavailable.ok,false); assert.equal(inputUnavailable.reason,'INPUT_DESKTOP_UNAVAILABLE'); }
    for (const patch of [{sameUser:false},{sameSession:false},{sessionId:0},{profile:''},{userSid:null},{startedAt:null},{name:'node'}]) {
      reset(); snapshots=[{...clone(native),...patch}];
      assert.equal((await read({capability})).ok,false,JSON.stringify(patch));
    }
    reset();cdpPid=99;assert.equal((await read({capability})).ok,false);
    for (const patch of [{processStartedAt:'old'},{userId:'foreign'},{guiSessionId:'2'},{profile:'foreign'},{targetId:other},{cdpWindowId:2}]) {
      reset(); assert.equal((await read({capability,expected:{...first.evidence,...patch}})).ok,false);
    }
    for (const patch of [{startedAt:'reused'},{pid:99},{profile:'foreign'},{sameSession:false}]) {
      reset();snapshots[1]={...snapshots[1],...patch};
      assert.equal((await read({capability})).ok,false,'Identity must be sampled again');
    }
    for (const change of ['target','instance','window']) {
      reset(); replaceTarget=change==='target'; replaceInstance=change==='instance'; moveWindow=change==='window';
      assert.equal((await read({capability})).ok,false,'Stale '+change);
      replaceTarget=replaceInstance=moveWindow=false;
    }
  }
  reset(); socketPort=9999; assert.equal((await read()).ok,false,'A second local endpoint cannot impersonate the target'); socketPort=9223;
  reset(); cdpWindow=undefined; assert.equal((await read()).ok,false,'Missing CDP window identity'); cdpWindow=1;
  // Real tool admission: approval stays in handler, authenticated pins/pre/post
  // are exercised separately by visible-binding-continuity-regression.
  const handlers=new Map();let mutations=0, afterPatch=null;
  const server=enforceVisibleBrowserTools({registerTool(n,c,h){handlers.set(n,h);}}, {
    select:(ports,id,corr,bg,capability)=>selectVisibleTarget(ports,id,corr,bg,capability),
    inspect:inspectVisibleTarget,
  });
  for (const name of ['write.web.page.click','write.browser.session.open','write.web.form.upload']) {
    server.registerTool(name,{},async input=>{
      mutations++;
      if(afterPatch) snapshots=[{...clone(native),...afterPatch}];
      return {content:[{type:'text',text:JSON.stringify(input.approved ? {ok:true} : {ok:false,status:'APPROVAL_REQUIRED'})}]};
    });
  }
  const call=async(name,approved=true)=>JSON.parse((await handlers.get(name)({ports:[9223],targetId:target,approved})).content[0].text);
  reset();snapshots=[{...native,sessionDisplayState:0,foregroundWindowIdBefore:'456',foregroundWindowIdAfter:'456'}];
  assert.equal((await call('write.web.page.click',false)).status,'APPROVAL_REQUIRED');
  assert.equal((await call('write.web.page.click')).ok,true,'CDP action remains admissible');
  for (const name of ['write.browser.session.open','write.web.form.upload']) {
    const before=mutations;assert.equal((await call(name)).ok,false);assert.equal(mutations,before);
  }
  reset();afterPatch={sameSession:false};
  const uncertain=await call('write.web.page.click');
  assert.equal(uncertain.ok,false);assert.equal(uncertain.outcome_unknown,true);assert.equal(uncertain.automatic_retry_allowed,false);
  console.log('WINDOWS_CDP_READINESS_GREEN: display-off/background/minimized CDP admitted; GUI, locked/disconnected, owner/session/stale continuity denied; approval and pre/post retained; inert fixtures only');
} finally {globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;childProcess.execFile=originalExecFile;Object.defineProperty(process,'platform',originalPlatform);mock.restoreAll();syncBuiltinESMExports();}
