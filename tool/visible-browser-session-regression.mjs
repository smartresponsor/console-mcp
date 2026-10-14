import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { classifyVisibleSession, inspectVisibleTarget, sameVisibleRuntime } from '../dist/service/visible-browser-session.js';
import { enforceVisibleBrowserTools, requiresVisibleBrowser } from '../dist/service/visible-browser-tools.js';
const facts = { cdp:true,target:true,process:true,gui:true,window:true,headless:false,sameUser:true,sameDisplay:true,sameWindow:true,locked:false,ambiguous:false };
for (const [patch, reason] of [
  [{window:false},'VISIBILITY_UNKNOWN'], [{headless:true},'SESSION_NOT_VISIBLE'],
  [{process:false},'VISIBILITY_UNKNOWN'], [{gui:false},'GUI_SESSION_UNAVAILABLE'],
  [{sameUser:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'], [{sameDisplay:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'],
  [{target:false},'BROWSER_TARGET_STALE'], [{ambiguous:true},'AMBIGUOUS_VISIBLE_SESSIONS'],
  [{authenticationRequired:true},'AUTHENTICATION_REQUIRED'], [{locked:true},'SESSION_NOT_VISIBLE'],
]) assert.equal(classifyVisibleSession({...facts,...patch}),reason);
assert.equal(classifyVisibleSession(facts),null,'Matching native identity and visible window must permit binding');
const evidence={host:'fixture-host',os:'linux',runtimeOwner:'console-mcp',interactiveUser:'fixture-user',userId:1000,guiSessionId:'1',browserPid:123,processStartedAt:'444',profile:'/fixture/profile',display:':0',windowId:'0x123',cdpWindowId:1,endpoint:'http://127.0.0.1:9223',browserInstance:'/devtools/browser/fixture',targetId:'fixture-target',verifiedAt:new Date().toISOString()};
assert.equal(sameVisibleRuntime(evidence,{...evidence}),true);
for (const key of ['host','os','userId','guiSessionId','browserPid','processStartedAt','profile','display','endpoint','browserInstance']) assert.equal(sameVisibleRuntime(evidence,{...evidence,[key]:'changed'}),false,key);
assert.equal(sameVisibleRuntime(evidence,{...evidence,profile:null}),false);
let calls=0; let preOk=false; let postOk=true;
const session=()=>({ok:preOk,status:preOk?'VISIBLE_TARGET_BOUND':'WEB_VISIBLE_SESSION_REQUIRED',reason:preOk?'VERIFIED':'VISIBILITY_UNKNOWN',states:['CDP_CONNECTED','BROWSER_TARGET_EXISTS'],evidence,correlationId:'fixture',visibility_verified:preOk,user_interaction_ready:preOk});
const handlers=new Map();
const guarded=enforceVisibleBrowserTools({registerTool(name,_config,h){handlers.set(name,h)}},{select:async()=>session(),inspect:async()=>({...session(),ok:postOk,visibility_verified:postOk,user_interaction_ready:postOk})});
guarded.registerTool('write.web.form.submit',{},async input=>{calls++; assert.equal(input.approved,false); return {content:[{type:'text',text:JSON.stringify({ok:false,status:'WEB_APPROVAL_REQUIRED'})}]};});
const parse=r=>JSON.parse(r.content[0].text);
assert.equal(parse(await handlers.get('write.web.form.submit')({approved:false})).status,'WEB_VISIBLE_SESSION_REQUIRED');
assert.equal(calls,0,'Invisible CDP must never invoke mutations');
preOk=true;
assert.equal(parse(await handlers.get('write.web.form.submit')({approved:false})).status,'WEB_APPROVAL_REQUIRED','Visibility cannot confer approval');
postOk=false;
const uncertain=parse(await handlers.get('write.web.form.submit')({approved:false}));
assert.equal(uncertain.ok,false);assert.equal(uncertain.status,'WEB_VISIBLE_SESSION_REQUIRED');assert.equal(uncertain.outcome_unknown,true);assert.equal(uncertain.automatic_retry_allowed,false);
guarded.registerTool('read_.web.browser.inventory',{},async()=>{calls++;return {content:[{type:'text',text:'{"ok":true,"visibility_verified":false}'}]};});
preOk=false;assert.equal(parse(await handlers.get('read_.web.browser.inventory')({})).visibility_verified,false);
for (const name of ['write.web.browser.open','write.web.browser.bind','write.web.target.open','write.web.job.open','write.web.page.click','read_.web.form.inspect','read_.web.form.extract','write.web.form.fill','write.web.form.upload','write.web.form.submit','write.browser.session.open']) assert.equal(requiresVisibleBrowser(name,{}),true,name);
preOk=true;postOk=true;
let release;
const pending=new Promise(resolve=>{release=resolve});
guarded.registerTool('write.web.page.click',{},async()=>{await pending;return {content:[{type:'text',text:'{"ok":true}'}]}});
const first=handlers.get('write.web.page.click')({});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(parse(await handlers.get('write.web.page.click')({})).reason,'VISIBLE_SESSION_BUSY','Concurrent operations cannot share a target lease');
release();await first;
const cdp=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/json/list'?[{id:'fixture-target',type:'page'}]:{webSocketDebuggerUrl:`ws://127.0.0.1:${cdp.address().port}/devtools/browser/new-instance`}));});
cdp.listen(0,'127.0.0.1');await once(cdp,'listening');
try {
 const port=cdp.address().port;
 const invisible=await inspectVisibleTarget({port,targetId:'fixture-target'});
 assert.equal(invisible.ok,false);assert.equal(invisible.visibility_verified,false);assert.ok(invisible.states.includes('CDP_CONNECTED'));
 const stale=await inspectVisibleTarget({port,targetId:'fixture-target',expected:evidence});
 assert.equal(stale.reason,'BROWSER_TARGET_STALE');
} finally {cdp.close();await once(cdp,'close');}
const worker=await readFile(new URL('../../looping/browsing/playwright-worker/src/worker.js',import.meta.url),'utf8');
assert.doesNotMatch(worker,/chromium\.launchPersistentContext|cdpBrowser\.newContext/,'Restoration cannot launch or create a competing profile');
assert.match(worker,/RECOVERY_REQUIRES_CONSOLE_ORCHESTRATION/);
assert.match(worker,/visibleRequest\.run\(before, next\)/);
assert.match(worker,/requireApprovalForSubmit/);assert.match(worker,/consumeApprovalReceipt/);
console.log('Visible session regression PASS: native policy, matching identity, headless/service/CDP blockers, wrong session, restart, ambiguity, authentication, pre/post gates, diagnostics, restoration and approvals.');
