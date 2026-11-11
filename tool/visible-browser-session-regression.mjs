import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireVisibleProcessLease } from '../dist/service/visible-browser-process-lock.js';
import { assertVisibleWorkerContract } from './visible-worker-contract.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { classifyVisibleSession, inspectVisibleTarget, sameVisibleRuntime, resolveVisibleCandidates } from '../dist/service/visible-browser-session.js';
import { enforceVisibleBrowserTools, inspectVisibleOperationLease, inspectVisibleOperationLeases, requiresVisibleBrowser } from '../dist/service/visible-browser-tools.js';
const leaseSnapshot = inspectVisibleOperationLeases();
assert.equal(leaseSnapshot.status, 'WEB_SESSION_LEASE_STATUS_READY');
assert.deepEqual(leaseSnapshot.leases, []);
assert.equal(requiresVisibleBrowser('read_.web.browser.status', {}), false);
assert.equal(requiresVisibleBrowser('read_.web.session.lease.status', { browserSession: 'visible', targetId: 'a'.repeat(32) }), false);
const freeLease = inspectVisibleOperationLease('visible', 'a'.repeat(32));
assert.equal(freeLease.ok, true);
assert.equal(freeLease.status, 'LEASE_FREE');
assert.equal(freeLease.expires_in_ms, null, 'No lease expiry may be fabricated');
assert.equal(freeLease.recovery_action, 'NO_ACTION');
assert.equal(inspectVisibleOperationLease('background', 'a'.repeat(32)).status, 'LEASE_STATE_UNAVAILABLE');
assert.equal(inspectVisibleOperationLease('visible', 'invalid').status, 'LEASE_STATE_UNAVAILABLE');
const facts = { cdp:true,target:true,process:true,gui:true,window:true,headless:false,sameUser:true,sameDisplay:true,sameWindow:true,locked:false,sessionStateKnown:true,ambiguous:false };
for (const [patch, reason] of [
  [{window:false},'WINDOW_NOT_VERIFIED'], [{headless:true},'SESSION_NOT_VISIBLE'],
  [{process:false},'VISIBILITY_UNKNOWN'], [{gui:false},'GUI_SESSION_UNAVAILABLE'],
  [{sameUser:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'], [{sameDisplay:false},'TARGET_BELONGS_TO_ANOTHER_SESSION'],
  [{target:false},'BROWSER_TARGET_STALE'], [{ambiguous:true},'AMBIGUOUS_VISIBLE_SESSIONS'],
  [{locked:true},'SESSION_LOCKED'],
]) assert.equal(classifyVisibleSession({...facts,...patch}),reason);
assert.equal(classifyVisibleSession(facts),null,'Matching native identity and visible window must permit binding');
assert.equal(classifyVisibleSession({...facts,authenticationRequired:true}),null,'A login form must not invalidate a healthy GUI session');
const evidence={host:'fixture-host',os:'linux',runtimeOwner:'console-mcp',interactiveUser:'fixture-user',userId:1000,guiSessionId:'1',browserPid:123,processStartedAt:'444',profile:'/fixture/profile',display:':0',windowId:'0x123',cdpWindowId:1,endpoint:'http://127.0.0.1:9223',browserInstance:'/devtools/browser/fixture',targetId:'fixture-target',verifiedAt:new Date().toISOString()};
const candidate = (targetId, windowId, cdpWindowId) => ({
  ok:true, status:'VISIBLE_TARGET_BOUND', reason:'VERIFIED', states:['CDP_CONNECTED'],
  evidence:{...evidence,targetId,windowId,cdpWindowId}, correlationId:'test',
  visibility_verified:true,user_interaction_ready:true
});
const ambiguous = resolveVisibleCandidates([
  candidate('tab-a','0x123',1),candidate('tab-b','0x456',2)
],candidate('tab-a','0x123',1));
assert.equal(ambiguous.reason,'VISIBLE_DISCOVERY_CHANGED');
assert.equal(ambiguous.discovery_diagnostic.inspected_count,2);
assert.equal(ambiguous.discovery_diagnostic.eligible_count,2);
assert.deepEqual(ambiguous.discovery_diagnostic.distinct_window_ids,['0x123','0x456']);
assert.deepEqual(ambiguous.discovery_diagnostic.candidates.map(c=>c.target_id),['tab-a','tab-b']);
assert.equal(ambiguous.visibility_verified,false);
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
assert.equal(requiresVisibleBrowser('write.dev.console.command.run',{command:'watchdog-heal'}),false,'Watchdog recovery must not be blocked by a provider login page');
for (const command of ['browser-ensure-visible','chatgpt-ensure-page','desktop-preflight','desktop-heal-plan','desktop-agent-heartbeat','desktop-agent-start-loop']) {
 assert.equal(requiresVisibleBrowser('write.dev.console.command.run',{command}),false,`${command} recovery must work without an already visible session`);
}
for (const command of ['browser-status','chatgpt-page-status','desktop-agent-stop-loop']) {
 assert.equal(requiresVisibleBrowser('write.dev.console.command.run',{command}),false,`${command} diagnostic/stop must not require GUI visibility`);
}
for (const name of ['write.web.browser.open','write.web.browser.bind','write.web.target.open','write.web.job.open','write.web.page.click','read_.web.form.inspect','read_.web.form.extract','write.web.form.fill','write.web.form.upload','write.web.form.submit','write.browser.session.open']) assert.equal(requiresVisibleBrowser(name,{}),true,name);
preOk=true;postOk=true;
const originalTargetId = evidence.targetId;
evidence.targetId = 'a'.repeat(32);
assert.equal(inspectVisibleOperationLease('visible', evidence.targetId).status, 'LEASE_FREE');
let release;
const pending=new Promise(resolve=>{release=resolve});
guarded.registerTool('write.web.page.click',{},async()=>{await pending;return {content:[{type:'text',text:'{"ok":true}'}]}});
const first=handlers.get('write.web.page.click')({});
await new Promise(resolve=>setImmediate(resolve));
const heldLease = inspectVisibleOperationLease('visible', evidence.targetId);
assert.equal(heldLease.ok, true);
assert.equal(heldLease.status, 'LEASE_HELD');
assert.equal(heldLease.holder_tool, 'write.web.page.click');
assert.equal(typeof heldLease.holder_correlation_id, 'string');
assert.ok(heldLease.held_ms >= 0);
assert.equal(heldLease.expires_in_ms, null);
assert.equal(heldLease.recovery_action, 'WAIT_FOR_LEASE_RELEASE');
const busy=parse(await handlers.get('write.web.page.click')({}));
assert.equal(busy.reason,'VISIBLE_SESSION_BUSY','Concurrent operations cannot share a target lease');
assert.equal(busy.lease_diagnostic.holder_tool,'write.web.page.click');
assert.equal(typeof busy.lease_diagnostic.holder_correlation_id,'string');
assert.ok(busy.lease_diagnostic.held_ms >= 0);
release();await first;
assert.equal(inspectVisibleOperationLease('visible', evidence.targetId).status, 'LEASE_FREE', 'Lease status must return to free after release');
assert.equal(parse(await handlers.get('write.web.page.click')({})).ok,true,'Sequential operation must acquire the lease after previous completion');
assert.equal(inspectVisibleOperationLease('visible', evidence.targetId).status, 'LEASE_FREE');
evidence.targetId = originalTargetId;
// Two targets on the same browser instance can run in parallel; browser-wide
// mutations must wait until *all* target leases have been released.
const A = 'A'.repeat(32), B = 'B'.repeat(32);
const previousOsLeaseMode = process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
const previousOsLeaseRoot = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
const osLeaseTestRoot = process.platform === 'linux' ? mkdtempSync(join(tmpdir(), 'cmcp-lease-integration-')) : null;
if (osLeaseTestRoot) {
 process.env.CONSOLE_MCP_VISIBLE_OS_LEASES = 'required';
 process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = osLeaseTestRoot;
}
const parallelHandlers = new Map();
const parallelGuard = enforceVisibleBrowserTools({ registerTool(n, _c, h) { parallelHandlers.set(n, h); } }, {
 select: async (_ports, id) => ({ ...session(), evidence: { ...evidence, targetId: id ?? A } }),
 inspect: async options => ({ ...session(), evidence: { ...evidence, targetId: options.targetId ?? A } }),
});
let releaseA, releaseB;
const holdA = new Promise(resolve => { releaseA = resolve; });
const holdB = new Promise(resolve => { releaseB = resolve; });
parallelGuard.registerTool('write.web.page.click', {}, async input => {
 if (input.targetId === A) await holdA;
 else if (input.targetId === B) await holdB;
 return { content: [{ type: 'text', text: '{"ok":true}' }] };
});
parallelGuard.registerTool('write.web.browser.close', {}, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
const callA = parallelHandlers.get('write.web.page.click')({ browserSession: 'visible', targetId: A });
await new Promise(resolve => setImmediate(resolve));
const callB = parallelHandlers.get('write.web.page.click')({ browserSession: 'visible', targetId: B });
await new Promise(resolve => setImmediate(resolve));
assert.equal(inspectVisibleOperationLease('visible', A).status, 'LEASE_HELD');
assert.equal(inspectVisibleOperationLease('visible', B).status, 'LEASE_HELD', 'Independent target must acquire a concurrent lease');
assert.equal(parse(await parallelHandlers.get('write.web.page.click')({ browserSession: 'visible', targetId: A })).reason, 'VISIBLE_SESSION_BUSY');
assert.equal(parse(await parallelHandlers.get('write.web.browser.close')({ browserSession: 'visible', targetId: A })).reason, 'VISIBLE_SESSION_BUSY', 'Browser-wide close must conflict with target A');
releaseA(); await callA;
assert.equal(inspectVisibleOperationLease('visible', A).status, 'LEASE_FREE');
assert.equal(inspectVisibleOperationLease('visible', B).status, 'LEASE_HELD');
assert.equal(parse(await parallelHandlers.get('write.web.browser.close')({ browserSession: 'visible', targetId: A })).reason, 'VISIBLE_SESSION_BUSY', 'Browser close must still conflict with target B');
releaseB(); await callB;
assert.equal(inspectVisibleOperationLease('visible', B).status, 'LEASE_FREE');
assert.equal(parse(await parallelHandlers.get('write.web.browser.close')({ browserSession: 'visible', targetId: A })).ok, true);
let releaseBrowser;
const browserPending = new Promise(resolve => { releaseBrowser = resolve; });
const browserWideHandlers = new Map();
const browserWideGuard = enforceVisibleBrowserTools({ registerTool(n, _c, h) { browserWideHandlers.set(n, h); } }, {
 select: async (_ports, id) => ({ ...session(), evidence: { ...evidence, targetId: id ?? A } }),
 inspect: async options => ({ ...session(), evidence: { ...evidence, targetId: options.targetId ?? A } }),
});
browserWideGuard.registerTool('write.web.browser.close', {}, async () => { await browserPending; return { content: [{ type: 'text', text: '{"ok":true}' }] }; });
browserWideGuard.registerTool('write.web.page.click', {}, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
const activeBrowserClose = browserWideHandlers.get('write.web.browser.close')({ browserSession: 'visible', targetId: A });
await new Promise(resolve => setImmediate(resolve));
assert.equal(inspectVisibleOperationLease('visible', B).status, 'LEASE_STATE_UNAVAILABLE', 'Unknown target membership under browser-wide lease must fail closed');
assert.equal(parse(await browserWideHandlers.get('write.web.page.click')({ browserSession: 'visible', targetId: B })).reason, 'VISIBLE_SESSION_BUSY', 'Browser-wide lease must deny independent target operations');
releaseBrowser(); await activeBrowserClose;
assert.equal(inspectVisibleOperationLease('visible', B).status, 'LEASE_FREE');
if (osLeaseTestRoot) {
 process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = 'relative/insecure/lease-root';
 try {
  const denied = parse(await parallelHandlers.get('write.web.page.click')({ browserSession: 'visible', targetId: A }));
  assert.equal(denied.reason, 'VISIBLE_SESSION_LEASE_UNAVAILABLE', 'OS-lock failure must deny the browser handler rather than silently fall back');
 } finally { process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = osLeaseTestRoot; }
}
if (osLeaseTestRoot) {
 if (previousOsLeaseMode === undefined) delete process.env.CONSOLE_MCP_VISIBLE_OS_LEASES;
 else process.env.CONSOLE_MCP_VISIBLE_OS_LEASES = previousOsLeaseMode;
 if (previousOsLeaseRoot === undefined) delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
 else process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = previousOsLeaseRoot;
 rmSync(osLeaseTestRoot, { recursive: true, force: true });
}
// Closure is terminal: disappearance/relaunch must not turn a verified close into failure.
let closePreOk=true;let closePostChecks=0;let closePid=evidence.browserPid;let closeCalls=0;
const closeHandlers=new Map();
const closeGuard=enforceVisibleBrowserTools({registerTool(n,_c,h){closeHandlers.set(n,h)}},{
 select:async()=>({...session(),ok:closePreOk}),
 inspect:async()=>{closePostChecks++;return {...session(),ok:false,visibility_verified:false,user_interaction_ready:false};},
});
closeGuard.registerTool('write.web.browser.close',{},async()=>{closeCalls++;return {content:[{type:'text',text:JSON.stringify({ok:true,status:'WEB_BROWSER_INSTANCE_CLOSED',previous_pid:closePid})}]};});
const closeInput={browserSession:'visible',targetId:evidence.targetId,confirmClose:true};
const closed=parse(await closeHandlers.get('write.web.browser.close')(closeInput));
assert.equal(closed.ok,true);assert.equal(closed.status,'WEB_BROWSER_INSTANCE_CLOSED');
assert.deepEqual(closed.closed_session,evidence);assert.equal(closed.user_interaction_ready,false);
assert.equal(closePostChecks,0,'Closed target must not be required to remain visible');
closePreOk=false;
assert.equal(parse(await closeHandlers.get('write.web.browser.close')(closeInput)).ok,false);
assert.equal(closeCalls,1,'Close still requires the native pre-gate');
closePreOk=true;closePid++;
assert.equal(parse(await closeHandlers.get('write.web.browser.close')(closeInput)).ok,false);
assert.equal(closePostChecks,1,'A different PID must not bypass post-verification');
const cdp=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/json/list'?[{id:'fixture-target',type:'page'}]:{webSocketDebuggerUrl:`ws://127.0.0.1:${cdp.address().port}/devtools/browser/new-instance`}));});
cdp.listen(0,'127.0.0.1');await once(cdp,'listening');
try {
 const port=cdp.address().port;
 const invisible=await inspectVisibleTarget({port,targetId:'fixture-target'});
 assert.equal(invisible.ok,false);assert.equal(invisible.visibility_verified,false);assert.ok(invisible.states.includes('CDP_CONNECTED'));
 const stale=await inspectVisibleTarget({port,targetId:'fixture-target',expected:evidence});
 assert.equal(stale.reason,'BROWSER_TARGET_STALE');
} finally {cdp.close();await once(cdp,'close');}
const workerSource=process.env.CONSOLE_MCP_BROWSER_WORKER_SOURCE || new URL('../../looping/browsing/playwright-worker/src/worker.js',import.meta.url);
let worker=null;
try { worker=await readFile(workerSource,'utf8'); }
catch (error) {
  if (error?.code !== 'ENOENT' || process.env.CONSOLE_MCP_REQUIRE_BROWSER_WORKER_CONTRACT === '1') throw error;
  console.log('Cross-repository Browsing worker contract: NOT CHECKED (worker source not mounted).');
}
if (worker !== null) {
  await assertVisibleWorkerContract(worker);
  // Prove the contract still detects removed ownership/attach-failure guards.
  await assert.rejects(assertVisibleWorkerContract(worker.replace(
    'if (guard?.ok && !policy.externalVisibleChrome)', 'if (false)')));
  await assert.rejects(assertVisibleWorkerContract(worker.replace(
    'throw new Error(`Shared browser CDP attach failed. ${lastExternalAttachError}`);',
    '/* unsafe attach fallback fixture */')));
  assert.match(worker,/RECOVERY_REQUIRES_CONSOLE_ORCHESTRATION/);
  assert.doesNotMatch(worker,/cdpBrowser\.newContext/,'Visible attachment cannot create a competing context');
  assert.match(worker,/requireApprovalForSubmit/);assert.match(worker,/consumeApprovalReceipt/);
}
if (process.platform === 'linux') {
 const root = mkdtempSync(join(tmpdir(), 'cmcp-lease-fixture-'));
 const previous = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
 process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = root;
 try {
   const instance = 'fixture-instance-with-identical-identity';
   const firstTarget = await acquireVisibleProcessLease(instance, 'target', 'A'.repeat(32));
   assert.equal(firstTarget.ok, true, 'First OS-level target lock must be acquired');
   const independent = await acquireVisibleProcessLease(instance, 'target', 'B'.repeat(32));
   assert.equal(independent.ok, true, 'Separate target locks can be held by independent helper processes');
   const sameTarget = await acquireVisibleProcessLease(instance, 'target', 'A'.repeat(32));
   assert.equal(sameTarget.ok, false);
   assert.equal(sameTarget.reason, 'CROSS_PROCESS_LEASE_BUSY');
   const browserBlocked = await acquireVisibleProcessLease(instance, 'browser', null);
   assert.equal(browserBlocked.ok, false);
   assert.equal(browserBlocked.reason, 'CROSS_PROCESS_LEASE_BUSY');
   await firstTarget.release();
   const stillBlocked = await acquireVisibleProcessLease(instance, 'browser', null);
   assert.equal(stillBlocked.reason, 'CROSS_PROCESS_LEASE_BUSY');
   await independent.release();
   const browser = await acquireVisibleProcessLease(instance, 'browser', null);
   assert.equal(browser.ok, true);
   const blockedTarget = await acquireVisibleProcessLease(instance, 'target', 'B'.repeat(32));
   assert.equal(blockedTarget.reason, 'CROSS_PROCESS_LEASE_BUSY');
   await browser.release();
   const recovered = await acquireVisibleProcessLease(instance, 'target', 'A'.repeat(32));
   assert.equal(recovered.ok, true);
   await recovered.release();
   // A killed Node owner closes the helper's stdin, so OS locks must be
   // released without deleting or guessing stale lock files.
   const ownerScript = `import { acquireVisibleProcessLease } from './dist/service/visible-browser-process-lock.js';
const lock = await acquireVisibleProcessLease('crash-fixture','target','C'.repeat(32));
if (!lock.ok) process.exit(2);
process.stdout.write('HELD\\n');
setInterval(() => {}, 1000);`;
   const owner = spawn(process.execPath, ['--input-type=module', '-e', ownerScript], {
     cwd: process.cwd(), env: { ...process.env, CONSOLE_MCP_VISIBLE_LEASE_ROOT: root },
     stdio: ['ignore', 'pipe', 'pipe'],
   });
   await new Promise((resolve, reject) => {
     let output = '';
     const watchdog = setTimeout(() => { owner.kill('SIGKILL'); reject(Error('Lease owner readiness timeout')); }, 5000);
     owner.stdout.on('data', chunk => {
       output += String(chunk);
       if (output.includes('HELD\n')) { clearTimeout(watchdog); resolve(); }
     });
     owner.once('error', error => { clearTimeout(watchdog); reject(error); });
     owner.once('close', code => { clearTimeout(watchdog); reject(Error('Lease owner exited before readiness: ' + code)); });
   });
   assert.equal((await acquireVisibleProcessLease('crash-fixture','target','C'.repeat(32))).reason,'CROSS_PROCESS_LEASE_BUSY');
   owner.kill('SIGKILL');
   await once(owner, 'close');
   let recoveredAfterCrash;
   for (let attempt = 0; attempt < 20; attempt++) {
     recoveredAfterCrash = await acquireVisibleProcessLease('crash-fixture','target','C'.repeat(32));
     if (recoveredAfterCrash.ok) break;
     await new Promise(resolve => setTimeout(resolve, 25));
   }
   assert.equal(recoveredAfterCrash?.ok, true, 'Owner crash must release helper lock by stdin EOF');
   await recoveredAfterCrash.release();
   const savedRoot = process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
   process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = 'relative/insecure/lease-root';
   try {
     const unavailable = await acquireVisibleProcessLease('fixture','target','D'.repeat(32));
     assert.equal(unavailable.reason, 'CROSS_PROCESS_LEASE_UNAVAILABLE');
   } finally { process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = savedRoot; }
 } finally {
   if (previous === undefined) delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
   else process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT = previous;
   rmSync(root, { recursive: true, force: true });
 }
}
for (const test of ['windows-native-session-regression.mjs','windows-cdp-readiness-regression.mjs','windows-foreground-regression.mjs','windows-passive-status-regression.mjs']) {
 const run=spawnSync(process.execPath,[`tool/${test}`],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
 assert.equal(run.status,0,`${test} failed:\\n${run.stdout}\\n${run.stderr}`);
 process.stdout.write(run.stdout);
}
console.log('Visible session regression PASS: native policy, matching identity, headless/service/CDP blockers, wrong session, restart, ambiguity, authentication, pre/post gates, diagnostics, restoration and approvals.');
