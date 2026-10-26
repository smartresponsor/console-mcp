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
  sessionId:7,sameUser:true,sameSession:true,inputReady:true,headless:false,
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
let replaceTarget=false, replaceInstance=false, moveWindow=false;
globalThis.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/json/version')
  ? {webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/'+(replaceInstance && versions++>0?'new':'fixture')}
  : (lists++>0 && replaceTarget ? [{id:other,type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:9223/other'}]
    : [{id:target,type:'page',webSocketDebuggerUrl:'ws://127.0.0.1:9223/page'}])});
globalThis.WebSocket=class {
  listeners={}; constructor(){queueMicrotask(()=>this.listeners.open?.());}
  addEventListener(name,fn){this.listeners[name]=fn;} close(){}
  send(raw){const q=JSON.parse(raw);let result={};
    if(q.method==='Browser.getWindowForTarget')result={windowId:moveWindow && windows++>0?2:1,bounds};
    if(q.method==='SystemInfo.getProcessInfo')result={processInfo:[{type:'browser',id:cdpPid}]};
    if(q.method==='Runtime.evaluate')result={result:{value:q.params.expression.includes('document.visibilityState')?pageVisible:false}};
    queueMicrotask(()=>this.listeners.message({data:JSON.stringify({id:q.id,result})}));
  }
};
try {
  const {inspectVisibleTarget}=await import('../dist/service/visible-browser-session.js');
  reset();const first=await inspectVisibleTarget({port:9223,targetId:target});assert.equal(first.ok,true,JSON.stringify(first));
  for(const [patch,reason] of [
    [{sameUser:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'],[{sameSession:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'],
    [{inputReady:false},'SESSION_LOCKED'],[{sessionDisplayState:0},'WINDOW_NOT_VISIBLE'],
    [{windows:[]},'VISIBILITY_UNKNOWN'],[{windows:[window,{...window,id:'456'}]},'AMBIGUOUS_VISIBLE_SESSIONS'],
    [{windows:[{...window,minimized:true}]},'WINDOW_NOT_VISIBLE'],
    [{windows:[{...window,pid:99}]},'VISIBILITY_UNKNOWN'],
    [{foregroundWindowIdBefore:'456',foregroundWindowIdAfter:'456'},'WINDOW_NOT_VISIBLE'],
    [{foregroundWindowIdAfter:'456'},'VISIBILITY_UNKNOWN'],
  ]) {reset();snapshots=[{...clone(native),...patch}];assert.equal((await inspectVisibleTarget({port:9223,targetId:target})).reason,reason);}
  reset();cdpPid=99;assert.equal((await inspectVisibleTarget({port:9223,targetId:target})).ok,false,'CDP browser PID must own the listener');
  reset();pageVisible=false;assert.equal((await inspectVisibleTarget({port:9223,targetId:target})).reason,'PAGE_NOT_VISIBLE');
  for(const patch of [{name:'foreign-process'}, {startedAt:'reused-pid'}, {windows:[{...window,id:'456'}],foregroundWindowIdBefore:'456',foregroundWindowIdAfter:'456'}]) {
    reset();snapshots[1]={...snapshots[1],...patch};assert.equal((await inspectVisibleTarget({port:9223,targetId:target})).ok,false,'Native identity change during CDP cannot authorize');
  }
  for(const change of ['target','instance','window']) {
    reset();replaceTarget=change==='target';replaceInstance=change==='instance';moveWindow=change==='window';
    assert.equal((await inspectVisibleTarget({port:9223,targetId:target})).ok,false,'CDP '+change+' replacement must fail closed');
    replaceTarget=replaceInstance=moveWindow=false;
  }
  for(const patch of [{windowId:'stale-HWND'},{processStartedAt:'old'},{userId:'other'},{guiSessionId:'2'},{targetId:other},{cdpWindowId:2}]) {
    reset();assert.equal((await inspectVisibleTarget({port:9223,targetId:target,expected:{...first.evidence,...patch}})).ok,false);
  }
  reset();snapshots=[{...native,foregroundWindowIdBefore:'456',foregroundWindowIdAfter:'456',sessionDisplayState:0}];
  const background=await inspectVisibleTarget({port:9223,targetId:target,background:true,expected:first.evidence});
  assert.equal(background.ok,true);assert.equal(background.user_interaction_ready,false);assert.equal(background.visibility_verified,false);
  console.log('WINDOWS_NATIVE_SESSION_GREEN: process/SID/session/HWND continuity, stale targets, duplicate geometry, foreground, minimization and background isolation');
} finally {globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;childProcess.execFile=originalExecFile;Object.defineProperty(process,'platform',originalPlatform);mock.restoreAll();syncBuiltinESMExports();}
