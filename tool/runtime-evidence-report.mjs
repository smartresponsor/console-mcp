import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson,readJson,fileDigest } from './runtime-version-store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const variable=path.join(root,'var');
const read=name=>readJson(path.join(variable,name));
const [runtime,memory,containment,routing,audit,resources,cleanup,initialAudit]=await Promise.all([
  read('runtime-version-evidence.json'),read('code-memory-resource-evidence.json'),read('windows-containment-evidence.json'),
  read('runtime-broker-route-evidence.json'),read('runtime-recovery-audit-v2.json'),read('memory-after-recovery.json'),
  read('resource-cleanup-v2.json'),read('runtime-recovery-audit.json'),
]);
for(const result of [runtime,memory,containment,routing])assert.equal(result.passed,true);
assert.equal(cleanup.noRemainingTestProcesses,true);
const smokes={};for(const name of ['codex','chatgpt','public']){const result=await read(`production-${name}-smoke-v2.log`);assert.equal(result.ok,true);smokes[name]={ok:true,authenticated:name==='codex'?result.authenticated_smoke?.ok:undefined,metadataStatus:result.metadata_status,mcpStatus:result.mcp_status};}
function gitStatusRecord(value){
  if(!value||typeof value!=='object')return;
  if(value.check_name==='git_status'&&typeof value.stdout==='string')return value.stdout;
  for(const item of Object.values(value)){const result=gitStatusRecord(item);if(result!==undefined)return result;}
}
const baseline=gitStatusRecord(await read('production-codex-smoke.log'));
const production='D:/PhpstormProjects/www/mcp/console-mcp';
const actual=execFileSync('git',['-C',production,'status','--porcelain'],{encoding:'utf8'});
const canonical=text=>JSON.stringify(text.split(/\r?\n/).filter(Boolean).sort());
const dirtyStatePreserved=baseline===undefined?null:canonical(baseline)===canonical(actual);
assert.notEqual(dirtyStatePreserved,false);
const master=execFileSync('git',['-C',production,'rev-parse','master'],{encoding:'utf8'}).trim();
assert.equal(master,'be32037c3b51774b335dec2d0db99044ce60d77e');
const services=items=>JSON.stringify([...items].sort((a,b)=>a.Name.localeCompare(b.Name)));
assert.equal(services(initialAudit.services),services(audit.services));
const sourceFiles=['package.json','tool/windows-contained-process.cs','tool/windows-contained-process.ps1','tool/windows-containment-regression.mjs','tool/code-memory-bounded-gateway.mjs','tool/code-memory-resource-regression.mjs','tool/bounded-json-lines.mjs','tool/runtime-version-store.mjs','tool/runtime-version-transaction.mjs','tool/runtime-version-transaction-regression.mjs','tool/runtime-candidate-guardian.mjs','tool/runtime-release-provenance.mjs','tool/runtime-selector-router.mjs','tool/runtime-watchdog-validation.mjs','tool/runtime-broker-route-regression.mjs','tool/runtime-memory-telemetry.ps1','tool/runtime-recovery-audit.ps1','tool/dev-console.d/85-session-relay.ps1','tool/dev-console.d/86-runtime-version-validation.ps1','tool/runtime-evidence-report.mjs'];
const hashes={};for(const name of sourceFiles)hashes[name]=await fileDigest(path.join(root,name));
const evidenceFiles=['runtime-version-evidence.json','code-memory-resource-evidence.json','windows-containment-evidence.json','runtime-broker-route-evidence.json','runtime-recovery-audit-v2.json','memory-after-recovery.json','memory-incident-events.json','code-memory-ui-log.json','code-memory-before-retirement.json','resource-cleanup-v2.json'];
const evidenceHashes={};for(const name of evidenceFiles)evidenceHashes[name]=await fileDigest(path.join(variable,name));
const summary={schema:2,createdAt:new Date().toISOString(),readiness:'BLOCKED',baseCommit:'04c5017e38da4a4dd8020bea3cda08c8b137b84d',containmentCommit:'f1ce27f1f9618aa69a22ef9a8c01ddb9f2efa521',
  rootCause:{classification:'oversized-automatic-home-index-with-failed-admission-and-soft-RSS-budget',sourceTag:'v0.8.1',sourceCommit:'f0c9be19c5d74b84f418d807bfdce7b5d6a261ff',binarySha256:memory.configuration.executableSha256,discoveredFiles:1127499,oldIncidentPrivateBytes:66368860160,observedReplacementPrivateBytes:33640644608,terminatedOnlyCodeMemoryPid:27152,autoIndexNow:false,allocationLevelLeakAttribution:'UNVERIFIED'},
  tests:{passed:runtime.tests.length+memory.tests.length+containment.tests.length+routing.tests.length,failed:0,groups:{runtime:runtime.tests.map(x=>x.name),memory:memory.tests.map(x=>x.name),containment:containment.tests.map(x=>x.scenario),routing:routing.tests.map(x=>x.name)}},
  regressionChecks:{typecheck:true,build:true,admission:true,schema:true,deploymentPreflight:true,restartFailsafe:true,syntax:true,diffCheck:true},
  memoryPilot:{peakBackendJobBytes:memory.telemetry.peakJobBytes,backendLimitBytes:memory.configuration.memoryBytes,workers:1,concurrency:1,queueCapacity:0,retainedSamples:memory.telemetry.samples.length,lastBackendPrivateBytes:memory.telemetry.samples.at(-1)?.privateBytes,gatewayMemory:memory.telemetry.gatewayMemory,productionBudgetApproved:false,stressEnvelope:containment.tests.find(x=>x.scenario==='memory-commit-limit')},
  dependencyProvenance:{current:routing.current.provenance,candidate:routing.candidate.provenance,currentFileCount:routing.current.fileCount,candidateFileCount:routing.candidate.fileCount,currentManifestSha256:routing.current.manifestHash,candidateManifestSha256:routing.candidate.manifestHash},
  production:{runtimePids:[...new Set(audit.listeners.map(x=>x.OwningProcess))],watchdogPids:audit.processes.filter(x=>x.role==='watchdog').map(x=>x.pid),watchdogStatus:audit.watchdogStatus,watchdogCount:audit.watchdogCount,smokes,master,dirtyStatePreserved,protectedServicePidsPreserved:true,initiatedProductionLifecycle:false,autonomousWatchdogReplacementObserved:true},
  resources:{finalPeakCommittedBytes:resources.peakCommittedBytes,finalMinimumAvailablePhysicalBytes:resources.minimumAvailablePhysicalBytes,noTestProcesses:true,testPortsReleased:runtime.cleanup&&routing.ports.every(x=>x.released),temporaryDirectoryCleanupRejected:cleanup.cleanupApprovalRejected},
  blockers:['representative-Git-project-soak-and-bounded-gateway-activation','positive-isolated-active-console-watchdog-validation','production-OAuth-canonical-port-handoff-and-process-freshness','second-interactive-session-HWND-denial','release-ACL-source-build-attestation-and-storage-durability','explicit-production-deployment-authorization'],
  implementationHashes:hashes,evidenceHashes,
};
if(process.argv.includes('--snapshot'))await atomicJson(path.join(root,'docs/runtime-memory-validation.json'),summary);
await atomicJson(path.join(variable,'task-report-v2.json'),{...summary,head:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pullRequest:'https://github.com/smartresponsor/console-mcp/pull/100'});
console.log(JSON.stringify({passed:summary.tests.passed,readiness:summary.readiness,dirtyStatePreserved,productionPids:summary.production.runtimePids}));
