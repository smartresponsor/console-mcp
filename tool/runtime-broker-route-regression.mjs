import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildRelease } from './runtime-release-provenance.mjs';
import { atomicJson,resolveVersion } from './runtime-version-store.mjs';
import { startCandidate } from './runtime-version-transaction.mjs';
import { probe } from './runtime-mcp-probe.mjs';
const exec=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=await mkdtemp(path.join(os.tmpdir(),'cmcp-broker-'));
const evidence={schema:1,tests:[]};let previous;
const ports=[];
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const value=s.address().port;await new Promise(resolve=>s.close(resolve));ports.push(value);return value;}
try{
  const current=await buildRelease(process.env.RUNTIME_PREVIOUS_ROOT??root,path.join(base,'previous'));
  const candidate=await buildRelease(process.env.RUNTIME_CANDIDATE_ROOT??root,path.join(base,'candidate'));
  evidence.references={current,candidate};
  for(const [name,reference]of Object.entries(evidence.references)){
    const manifest=JSON.parse(await readFile(reference.manifest));
    evidence[name]={manifestHash:reference.sha256,commit:manifest.commit,provenance:manifest.provenance,fileCount:manifest.files.length,files:manifest.files};
    await resolveVersion(reference);
  }
  evidence.tests.push({name:'fresh-npm-ci-and-complete-dependency-inventory',passed:true});
  const token='isolated-route-previous-token';const oldPort=await port();
  previous=await startCandidate(await resolveVersion(current),{port:oldPort,token,workspace:path.join(base,'old-workspace')});
  for(let i=0;;i++){try{await probe({port:oldPort,token});break;}catch(e){if(i>60)throw e;await delay(250);}}
  const run=path.join(base,'run');await mkdir(run);
  const selection=path.join(base,'selector');await atomicJson(path.join(selection,'active.json'),current);
  const session=Number((await exec('pwsh',['-NoProfile','-Command','(Get-Process -Id $PID).SessionId'],{windowsHide:true})).stdout.trim());
  const config={mode:'isolated-validation',expectedSessionId:session,base:selection,previous:{reference:current,pid:previous.pid,port:oldPort},candidate,port:await port(),workspace:path.join(base,'new-workspace'),routerPort:await port(),maxRequests:4,maxBodyBytes:1024**2,timeoutMs:15000};
  await atomicJson(path.join(run,'runtime-version-validation.json'),config);
  const helper=path.join(base,'broker.ps1');
  await writeFile(helper,`$ErrorActionPreference='Stop'
$Root=$env:TEST_RUNTIME_ROOT
$RunDir=$env:TEST_RUNTIME_RUN
. (Join-Path $Root 'tool/dev-console.d/85-session-relay.ps1')
. (Join-Path $Root 'tool/dev-console.d/86-runtime-version-validation.ps1')
function Get-NodeCommand { Get-Command node }
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ValidationConsoleSession { [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId(); }'
function Get-ConsoleSessionReport { [pscustomobject]@{active_console=[pscustomobject]@{id=[ValidationConsoleSession]::WTSGetActiveConsoleSessionId()}} }
function Sanitize-Text($Value) { $Value }
$identity=New-ServerControlBrokerIdentity
Write-ServerControlBrokerIdentity -Identity $identity
$request=[pscustomobject]@{schema_version=2;correlation_id='isolated-route';action='validate-runtime-version';requested_at=(Get-Date).ToUniversalTime().ToString('o');requested_by_session=$identity.windows_session_id;expected_broker_generation=$identity.generation;expected_login_epoch=$identity.login_epoch}
Write-ServerControlJsonAtomically -Path (Join-Path $ServerControlInboxDir 'isolated-route.json') -Value $request
$result=Invoke-PendingServerControlRequest
$result|ConvertTo-Json -Depth 20
`);
  const output=await exec('pwsh',['-NoProfile','-File',helper],{windowsHide:true,timeout:120000,maxBuffer:1024**2,env:{...process.env,TEST_RUNTIME_ROOT:root,TEST_RUNTIME_RUN:run,RUNTIME_PREVIOUS_BEARER_TOKEN:token,RUNTIME_ROUTER_BEARER_TOKEN:'isolated-front-token'}});
  const receipt=JSON.parse(output.stdout);evidence.receipt=receipt;
  if(session===0){
    assert.equal(receipt.result.ok,false);assert.match(receipt.result.error,/INTERACTIVE_SESSION_REQUIRED/);
    evidence.tests.push({name:'real-broker-queue-refuses-session-zero',passed:true});
    evidence.interactiveBrokerGate='BLOCKED_NO_ISOLATED_INTERACTIVE_EXECUTOR';
  }else{assert.equal(receipt.result.ok,true);evidence.tests.push({name:'real-broker-queue-validation',passed:true});}
  const direct=await exec(process.execPath,[path.join(root,'tool/runtime-watchdog-validation.mjs'),path.join(run,'runtime-version-validation.json')],{windowsHide:true,timeout:120000,maxBuffer:1024**2,env:{...process.env,RUNTIME_PREVIOUS_BEARER_TOKEN:token,RUNTIME_ROUTER_BEARER_TOKEN:'isolated-front-token'}});
  const routed=JSON.parse(direct.stdout);assert.equal(routed.ok,true);
  assert.equal(routed.beforePid,previous.pid);assert.equal(routed.rolledBackPid,previous.pid);
  evidence.routing=routed;evidence.tests.push({name:'real-node-selector-routing-and-rollback',passed:true});
  // Unlisted executable content and dependency mutation fail closed.
  const extra=path.join(path.dirname(candidate.manifest),'node_modules','unlisted.js');await writeFile(extra,'export const altered=true;');
  await assert.rejects(resolveVersion(candidate),/release_inventory_mismatch/);await rm(extra);
  const manifest=JSON.parse(await readFile(candidate.manifest));
  const dep=manifest.files.find(f=>f.path.startsWith('node_modules/')&&f.path.endsWith('.js'));
  await writeFile(path.join(path.dirname(candidate.manifest),dep.path),'tampered');
  await assert.rejects(resolveVersion(candidate),/artifact_hash_mismatch/);
  evidence.tests.push({name:'extra-and-modified-dependency-rejected',passed:true});evidence.passed=true;
}catch(e){evidence.failure={message:e.message,stdout:e.stdout,stderr:e.stderr};throw e;}
finally{
  if(previous)await previous.stop();
  evidence.ports=[];
  for(const value of ports){const s=net.createServer();s.listen(value,'127.0.0.1');await once(s,'listening');await new Promise(resolve=>s.close(resolve));evidence.ports.push({port:value,released:true});}
  await atomicJson(path.join(root,'var/runtime-broker-route-evidence.json'),evidence);
  assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cmcp-broker-'));
  await rm(base,{recursive:true,force:true,maxRetries:50,retryDelay:100});
}
console.log(JSON.stringify({passed:evidence.passed,tests:evidence.tests,receipt:evidence.receipt?.result}));
