import assert from 'node:assert/strict';
import { enforceVisibleBrowserTools } from '../dist/service/visible-browser-tools.js';
import { resolveVisibleCandidates } from '../dist/service/visible-browser-session.js';
import { runWithMcpRequestContext } from '../dist/Infrastructure/Diagnostics/RequestContext.js';
const A = 'A'.repeat(32), B = 'B'.repeat(32);
const evidence = { host:'fixture', os:'linux', runtimeOwner:'console-mcp', interactiveUser:'alex',
 userId:1000, guiSessionId:'351', browserPid:123, processStartedAt:'1', profile:'/profile',
 display:':1', windowId:'0x2400004', cdpWindowId:1, endpoint:'http://127.0.0.1:9224',
 browserInstance:'/devtools/browser/one', targetId:A, verifiedAt:new Date().toISOString() };
const proof = (patch = {}) => ({ ok:true, status:'VISIBLE_TARGET_BOUND', reason:'VERIFIED',
 states:['CDP_CONNECTED','VISIBLE_WINDOW_VERIFIED'], evidence:{...evidence,...patch},
 page_authentication_observation:'NOT_CHECKED', correlationId:'fixture', visibility_verified:true, user_interaction_ready:true });
const failure = reason => ({...proof(),ok:false,status:'WEB_VISIBLE_SESSION_REQUIRED',reason,
 visibility_verified:false,user_interaction_ready:false});
let inspections = [], selections = [], handlers = [], invoked = [];
let afterHandler = null;
let current = proof(), discovery = failure('AMBIGUOUS_VISIBLE_SESSIONS');
const probes = {
 select:async (ports,id) => { selections.push({ports,id}); return id ? (ports.includes(Number(new URL(current.evidence.endpoint).port)) && id === current.evidence.targetId ? current : failure('BROWSER_TARGET_STALE')) : discovery; },
 inspect:async options => { inspections.push(options); return options.background && current.ok
  ? {...current,evidence:{...current.evidence,windowId:null},visibility_verified:false,user_interaction_ready:false} : current; },
};
const parse = r => JSON.parse(r.content[0].text);
// HTTP creates a new McpServer for every call. Only authenticated request scope is stable.
async function call(name,input={},scope='client-one') {
 const registered=new Map();
 const server=enforceVisibleBrowserTools({registerTool(n,_c,h){registered.set(n,h);}},probes);
 server.registerTool(name,{},async args=>{
  invoked.push({name,args}); handlers.push(name);
  if (afterHandler) current = afterHandler;
  return {content:[{type:'text',text:JSON.stringify({ok:true,status:name==='write.web.browser.bind'?'WEB_TARGET_BOUND':'OK'})}]};
 });
 return parse(await runWithMcpRequestContext('fixture',()=>registered.get(name)(input),scope));
}
assert.equal((await call('write.web.browser.bind',{browserSession:'visible',targetId:A})).ok,true);
const inspected=await call('read_.web.form.inspect',{browserSession:'visible'});
assert.equal(inspected.ok,true,'A verified bind must survive sequential MCP servers without rediscovery');
assert.equal(invoked.at(-1).args.targetId,A,'Inspect must reach the exact bound target');
assert.equal(inspected.visible_session.visibility_verified,false,'Background proof cannot confer interaction readiness');
assert.equal((await call('read_.web.form.inspect')).ok,true,'Background inspection must preserve the interactive window pin');
assert.equal(inspections.at(-1).expected.targetId,A);
for(const name of ['read_.web.page.capture','write.web.page.click']) {
 assert.equal((await call(name,{browserSession:'visible'})).ok,true,name);
 assert.equal(invoked.at(-1).args.targetId,A);
}
assert.equal(selections.length,1,'Only explicit bind may discover after a binding exists');
assert.equal((await call('read_.web.form.inspect',{},'other-client')).reason,'AMBIGUOUS_VISIBLE_SESSIONS');
current=failure('BROWSER_TARGET_STALE');
const calls=invoked.length;
assert.equal((await call('read_.web.form.inspect')).reason,'BROWSER_TARGET_STALE');
assert.equal(invoked.length,calls,'Stale bound targets must never fall back or invoke handlers');
// Exercise identical identity rules on Linux and Windows.
for (const os of ['linux','win32']) {
 const scope='identity-'+os;
 current=proof({os});
 assert.equal((await call('write.web.browser.bind',{browserSession:'visible',targetId:A},scope)).ok,true);
 for (const patch of [{browserInstance:'restarted'},{browserPid:999},{processStartedAt:'new'},
   {guiSessionId:'other'},{display:':2'},{profile:'/other'},{endpoint:'http://127.0.0.1:9223'},
   {targetId:B},{cdpWindowId:2}]) {
  current=proof({os,...patch});
  const before=invoked.length;
  assert.equal((await call('read_.web.form.inspect',{},scope)).reason,'VISIBLE_TARGET_IDENTITY_CHANGED');
  assert.equal(invoked.length,before,'Changed identity cannot reach handler');
 }
 current=proof({os,windowId:'other'});
 const nativeCalls=invoked.length;
 assert.equal((await call('write.web.form.upload',{},scope)).reason,'VISIBLE_TARGET_IDENTITY_CHANGED');
 assert.equal(invoked.length,nativeCalls,'Native GUI retains the HWND pin');
 current=proof({os,cdpWindowId:2});
 assert.equal((await call('read_.web.form.inspect',{browserSession:'visible'},scope)).reason,'VISIBLE_TARGET_IDENTITY_CHANGED','Background reads still prove the CDP window');
 for (const reason of ['VISIBILITY_UNKNOWN','SESSION_NOT_VISIBLE','GUI_SESSION_UNAVAILABLE','AMBIGUOUS_VISIBLE_SESSIONS']) {
  current={...failure(reason),evidence:{...evidence,os}};
  assert.equal((await call('write.web.page.click',{},scope)).reason,reason);
 }
 current=proof({os});
 assert.equal((await call('read_.web.form.inspect',{},scope)).ok,true,'Focus recovery requires fresh proof');
 current=proof({os,targetId:B});
 assert.equal((await call('read_.web.page.capture',{browserSession:'visible',targetId:B},scope)).ok,true);
 current=proof({os});
 assert.equal((await call('read_.web.form.inspect',{},scope)).ok,true,'Exact observations must not overwrite bindings');
}
current=proof();
await call('write.web.browser.bind',{browserSession:'visible',targetId:A},'multi-port');
current=proof({targetId:B,endpoint:'http://127.0.0.1:9223',browserPid:456,browserInstance:'/devtools/browser/two'});
await call('write.web.browser.bind',{browserSession:'isolated',targetId:B},'multi-port');
assert.equal((await call('read_.web.form.inspect',{},'multi-port')).reason,'AMBIGUOUS_VISIBLE_SESSIONS');
current=proof();
assert.equal((await call('read_.web.form.inspect',{browserSession:'visible'},'multi-port')).ok,true);
const first=proof(), tab=proof({targetId:B});
const backgroundTabs=[proof({windowId:null}),proof({windowId:null,targetId:B})];
assert.equal(resolveVisibleCandidates(backgroundTabs,backgroundTabs[0]).reason,'AMBIGUOUS_VISIBLE_SESSIONS','Background page proofs are not native-window identity');
assert.equal(resolveVisibleCandidates([first,tab],first).ok,true);
const moved=proof({targetId:B,windowId:'0x2',cdpWindowId:2});
const changed=resolveVisibleCandidates([first,moved],first);
assert.equal(changed.reason,'VISIBLE_DISCOVERY_CHANGED');
assert.equal(changed.visibility_verified,false);
assert.equal(changed.resolution_candidates.length,2);
const windows=[proof({os:'win32'}),proof({os:'win32',windowId:'2',cdpWindowId:2,targetId:B})];
assert.equal(resolveVisibleCandidates(windows,windows[0]).reason,'AMBIGUOUS_VISIBLE_SESSIONS');
const otherPort=proof({endpoint:'http://127.0.0.1:9223',browserPid:456});
assert.equal(resolveVisibleCandidates([first,otherPort],first).reason,'AMBIGUOUS_VISIBLE_SESSIONS');
assert.equal(resolveVisibleCandidates([first,tab],first,A).reason,'AMBIGUOUS_VISIBLE_SESSIONS');
// Window changes during a handler remain an uncertain postcondition, never success.
current=proof();
await call('write.web.browser.bind',{browserSession:'visible',targetId:A},'post-change');
afterHandler=proof({windowId:'moved',cdpWindowId:2});
const uncertain=await call('write.web.page.click',{},'post-change');
assert.equal(uncertain.ok,false);
assert.equal(uncertain.outcome_unknown,true);
assert.equal(uncertain.automatic_retry_allowed,false);
assert.equal(uncertain.visible_session.reason,'VISIBLE_TARGET_IDENTITY_CHANGED');
assert.equal(uncertain.visible_session.evidence.verifiedAt,null);
assert.equal(uncertain.visible_session.states.includes('USER_INTERACTION_READY'),false);
afterHandler=null;
// Duplicate exact targets across CDP instances must not return success-shaped denials.
let duplicateInvoked=false;
const duplicateHandlers=new Map();
const duplicateGuard=enforceVisibleBrowserTools({registerTool(n,c,h){duplicateHandlers.set(n,h)}},{
 select:async ports=>proof({endpoint:`http://127.0.0.1:${ports[0]}`}),inspect:async()=>proof(),
});
duplicateGuard.registerTool('write.web.browser.bind',{},async()=>{duplicateInvoked=true;return {content:[]};});
const duplicate=parse(await duplicateHandlers.get('write.web.browser.bind')({targetId:A}));
assert.equal(duplicate.reason,'AMBIGUOUS_VISIBLE_SESSIONS');
assert.equal(duplicate.ok,false);
assert.equal(duplicate.visibility_verified,false);
assert.equal(duplicate.user_interaction_ready,false);
assert.equal(duplicateInvoked,false);
console.log('Visible binding continuity regression PASS');
