import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { inspectVisibleTarget, visibleCdpCommand } from '../dist/service/visible-browser-session.js';
import { enforceVisibleBrowserTools } from '../dist/service/visible-browser-tools.js';
import { runWithMcpRequestContext } from '../dist/Infrastructure/Diagnostics/RequestContext.js';
import { registerWindowTools } from '../dist/tool/window.js';
import { registerWebBrowserBridgeTools } from '../dist/tool/web-browser-bridge.js';

assert.equal(process.platform,'win32');
assert.ok(process.argv.includes('--approved-harmless-page'),'Explicit harmless-page authorization required');
const endpoint='http://127.0.0.1:9223', scope=randomUUID(), observations=[];
const version=await (await fetch(endpoint+'/json/version')).json();
const inventory=async()=>await(await fetch(endpoint+'/json/list')).json();
const original=(await inventory()).map(t=>t.id);
const marker='native-parity-'+randomUUID();
const html=`<!doctype html><title>Console native verification</title><body data-fixture="${marker}"><h1>Windows native verification</h1><button id="harmless" type="button" style="margin:80px;padding:30px" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Local counter only</button></body>`;
const created=await visibleCdpCommand(version.webSocketDebuggerUrl,'Target.createTarget',{url:'data:text/html,'+encodeURIComponent(html),background:false});
const targetId=created.targetId;
assert.match(targetId,/^[A-Fa-f0-9]{32}$/);
console.log(JSON.stringify({fixtureCreated:targetId,retained:true}));
await visibleCdpCommand(version.webSocketDebuggerUrl,'Target.activateTarget',{targetId});
const page=(await inventory()).find(t=>t.id===targetId);
const evaluate=async expression=>(await visibleCdpCommand(page.webSocketDebuggerUrl,'Runtime.evaluate',{expression,returnByValue:true})).result?.value;
const parse=r=>JSON.parse(r.content.find(c=>c.type==='text').text);
async function call(name,input={}) {
  const handlers=new Map();
  const server=enforceVisibleBrowserTools({registerTool(n,_c,h){handlers.set(n,h);}});
  server.registerTool(name,{},async args=>{
    assert.equal(args.targetId,targetId);
    assert.equal(await evaluate('document.body.dataset.fixture'),marker,'Only the owned harmless fixture may be inspected or clicked');
    if(name==='read_.web.page.capture') {
      const shot=await visibleCdpCommand(page.webSocketDebuggerUrl,'Page.captureScreenshot',{format:'png'});
      const bytes=Buffer.from(shot.data,'base64');assert.ok(bytes.length>100);
      await mkdir('var/validation',{recursive:true});await writeFile('var/validation/windows-native-parity.png',bytes);
      observations.push({screenshotSha256:createHash('sha256').update(bytes).digest('hex')});
    }
    if(name==='write.web.page.click') {
      const point=await evaluate("(()=>{const r=document.querySelector('#harmless').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      assert.equal(await evaluate('document.body.dataset.clicks||"0"'),'0');
      await visibleCdpCommand(page.webSocketDebuggerUrl,'Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await visibleCdpCommand(page.webSocketDebuggerUrl,'Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      assert.equal(await evaluate('document.body.dataset.clicks'),'1');
    }
    return {content:[{type:'text',text:JSON.stringify({ok:true,status:'STAGED_NATIVE_DIAGNOSTIC',targetId})}]};
  });
  const result=parse(await runWithMcpRequestContext(randomUUID(),()=>handlers.get(name)(input),scope));
  observations.push({name,...result});
  assert.equal(result.ok,true,JSON.stringify(result));
}
try {
  const before=await inspectVisibleTarget({port:9223,targetId,capability:'native-gui'});assert.equal(before.ok,true,JSON.stringify(before));
  await call('write.web.browser.bind',{targetId,browserSession:'isolated'});
  await call('read_.web.form.inspect',{});
  await call('read_.web.page.capture',{targetId,screenshot:true});
  await call('write.web.page.click',{targetId,expectedTargetId:targetId,browserSession:'isolated'});
  const after=await inspectVisibleTarget({port:9223,targetId,expected:before.evidence,capability:'native-gui'});assert.equal(after.ok,true,JSON.stringify(after));
  const windows=new Map();registerWindowTools({registerTool(n,_c,h){windows.set(n,h)}},{mode:'bearer',bearerTokens:['diagnostic']});
  const inv=parse(await windows.get('read_.window.inventory')({}));assert.equal(inv.ok,true,JSON.stringify(inv));
  const hex='0x'+BigInt(after.evidence.windowId).toString(16);
  assert.ok(inv.windows.some(w=>w.windowId===hex && w.pid===after.evidence.browserPid));
  const inspected=parse(await windows.get('read_.window.inspect')({windowId:hex}));assert.equal(inspected.ok,true);
  const focus=parse(await windows.get('read_.window.inspect.focus')({}));assert.equal(focus.ok,true);
  const statusHandlers=new Map();registerWebBrowserBridgeTools({registerTool(n,_c,h){statusHandlers.set(n,h)}},{mode:'bearer',bearerTokens:['diagnostic']});
  const status=parse(await statusHandlers.get('read_.web.browser.status')({ports:[9223],timeoutMs:3000}));
  assert.equal(status.desktop_agent.status,'WINDOWS_NATIVE_DESKTOP_ELIGIBLE');assert.equal(status.visibility_verified,false);
  observations.push({before,after,inventoryCount:inv.count,inspected:inspected.window,focus,status:status.desktop_agent});
} finally {
  const remaining=(await inventory()).map(t=>t.id);
  const report={targetId,observations,originalTargetsPreserved:original.every(id=>remaining.includes(id)),fixtureRetained:remaining.includes(targetId),
    stagedGuardTested:true,deployedWorkerAuthorizationTested:false,browserRestarted:false};
  await mkdir('var/validation',{recursive:true});await writeFile('var/validation/windows-native-parity-live.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  assert.equal(report.originalTargetsPreserved,true);
}
