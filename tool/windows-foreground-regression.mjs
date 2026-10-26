import assert from 'node:assert/strict';
import { proveWindowsWindow } from '../dist/service/windows-window-proof.js';
import { classifyVisibleSession } from '../dist/service/visible-browser-session.js';

const window = { id:'28575144', pid:42, threadId:43, windowClass:'Chrome_WidgetWin_1', visible:true, left:-8, top:-8, width:1936, height:1096, minimized:false, cloaked:0 };
const bounds = { left:-8, top:-8, width:1936, height:1096, windowState:'maximized' };
const native = { pid:42, windows:[window], foregroundWindowIdBefore:window.id, foregroundWindowIdAfter:window.id, consoleDisplayState:1, sessionDisplayState:1 };
const facts = { cdp:true,target:true,process:true,gui:true,window:true,headless:false,sameUser:true,sameDisplay:true,sameWindow:true,locked:false,ambiguous:false };
const proof = proveWindowsWindow(native,bounds);
assert.equal(proof.reason,null);
assert.equal(proof.windowId,window.id);
assert.equal(proof.stage,'foreground-window-matched');

for (const [snapshot, stage, reason] of [
  [{...native,sessionDisplayState:0},'session-display-off','SESSION_NOT_VISIBLE'],
  [{...native,sessionDisplayState:null},'display-state-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,sessionDisplayState:undefined},'display-state-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,sessionDisplayState:3},'display-state-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[]},'window-unmatched','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,pid:99}]},'window-owner-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,threadId:0}]},'window-owner-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,windowClass:'other'}]},'window-owner-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,visible:false}]},'window-hidden','SESSION_NOT_VISIBLE'],
  [{...native,windows:[window,{...window,id:'524462'}]},'window-ambiguous','AMBIGUOUS_VISIBLE_SESSIONS'],
  [{...native,foregroundWindowIdBefore:'524462',foregroundWindowIdAfter:'524462'},'window-not-foreground','SESSION_NOT_VISIBLE'],
  [{...native,foregroundWindowIdAfter:'524462'},'foreground-changed','VISIBILITY_UNKNOWN'],
  [{...native,foregroundWindowIdBefore:'0',foregroundWindowIdAfter:'0'},'foreground-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,foregroundWindowIdBefore:undefined,foregroundWindowIdAfter:undefined},'foreground-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,cloaked:1}]},'window-hidden','SESSION_NOT_VISIBLE'],
  [{...native,windows:[{...window,cloaked:null}]},'window-state-unavailable','VISIBILITY_UNKNOWN'],
  [{...native,windows:[{...window,minimized:true}]},'window-hidden','SESSION_NOT_VISIBLE'],
]) {
  const result=proveWindowsWindow(snapshot,bounds);
  assert.equal(result.stage,stage);assert.equal(result.reason,reason);
}
assert.equal(proveWindowsWindow(native,{...bounds,windowState:'minimized'}).reason,'SESSION_NOT_VISIBLE');
assert.equal(proveWindowsWindow(native,{...bounds,left:1}).reason,'VISIBILITY_UNKNOWN','DPI/bounds mismatch cannot imply identity');
assert.equal(proveWindowsWindow(native,{...bounds,width:NaN}).reason,'VISIBILITY_UNKNOWN');
assert.equal(proveWindowsWindow(native,{...bounds,height:0}).reason,'VISIBILITY_UNKNOWN');
assert.equal(proveWindowsWindow({...native,sessionDisplayState:2},bounds).reason,null,'Dimmed remains a known powered-on state');
assert.equal(proveWindowsWindow({...native,consoleDisplayState:0,sessionDisplayState:1},bounds).reason,null,'Current-session display authority supports a powered remote session independently of console power');
assert.equal(proveWindowsWindow({...native,sessionDisplayState:0},bounds,true).reason,null,'Display-off background identity never implies interaction readiness');
const background=proveWindowsWindow({...native,foregroundWindowIdBefore:'524462',foregroundWindowIdAfter:'524462'},bounds,true);
assert.equal(background.reason,null,'Background observation may identify the same native window without asserting interaction readiness');
assert.equal(background.stage,'background-window-matched');
assert.equal(classifyVisibleSession({...facts,pageVisible:true}),null);
assert.equal(classifyVisibleSession({...facts,pageVisible:false}),'PAGE_NOT_VISIBLE','Known hidden is not unknown and must never be overridden by native focus');
assert.equal(classifyVisibleSession({...facts,pageVisible:true,windowHidden:true}),'WINDOW_NOT_VISIBLE','An inactive native window cannot be rescued by a visible/emulated page');
assert.equal(classifyVisibleSession({...facts,window:false,pageVisible:undefined}),'WINDOW_NOT_VERIFIED','Missing CDP visibility remains unknown');
assert.equal(classifyVisibleSession({...facts,pageVisible:true,locked:true}),'SESSION_LOCKED');
assert.equal(classifyVisibleSession({...facts,pageVisible:true,sameUser:false}),'TARGET_BELONGS_TO_ANOTHER_SESSION');
assert.equal(classifyVisibleSession({...facts,pageVisible:true,ambiguous:true}),'AMBIGUOUS_VISIBLE_SESSIONS');
console.log('WINDOWS_FOREGROUND_REGRESSION_GREEN: HWND identity, foreground stability, duplicates, cloaking, minimization, hidden pages and fail-closed boundaries');
