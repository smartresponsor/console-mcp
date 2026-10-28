import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileDigest, atomicJson, readJson } from './runtime-version-store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=await mkdtemp(path.join(os.tmpdir(),'cmcp-memory-'));
const fixture=path.join(base,'fixture');await mkdir(fixture);
for(let i=0;i<1000;i++)await writeFile(path.join(fixture,`module${i}.ts`),`export function workload${i}(n:number){return n+${i};}\n`);
const executable=process.env.CODE_MEMORY_EXECUTABLE??'C:/Users/Admin/.local/bin/codebase-memory-mcp.exe';
const executableSha256=await fileDigest(executable);
assert.equal(executableSha256,'b67a67cf4846a66f6c6830c48885e1dac6e9e09ae4536423f471f075611071fe','unexpected_v081_binary');
const configuration={base,executable,executableSha256,allowedRoots:[fixture],
  memoryBytes:2*1024**3,workers:1,frameBytes:65536,responseBytes:8*1024**2,timeoutMs:90000,
  budgetEvidence:'Isolated pilot ceiling: 1000 TypeScript files, serial pipeline; not a production workload certification.'};
const configFile=path.join(base,'gateway.json');await atomicJson(configFile,configuration);
const evidence={schema:1,tests:[],configuration,sourceBytes:0,passed:false};
let client,transport;
async function connect(){
  client=new Client({name:'bounded-memory-regression',version:'1'});
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'tool/code-memory-bounded-gateway.mjs'),configFile],stderr:'inherit'});
  await client.connect(transport,{timeout:30000});
  for(let i=0;;i++){
    try{const snapshot=await readJson(path.join(base,'telemetry.json'));if(snapshot.gatewayPid===transport.pid && snapshot.hostPid && snapshot.state==='ready')break;}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(i>100)throw Error('fresh_gateway_telemetry_timeout');await delay(100);
  }
}
function resultJson(result){return JSON.parse(result.content.find(c=>c.type==='text').text);}
try{
  await connect();
  await assert.rejects(client.callTool({name:'index_repository',arguments:{repo_path:os.homedir(),mode:'fast'}},undefined,{timeout:10000}),/index_root_not_admitted/);
  evidence.tests.push({name:'home-root-denied-before-discovery',passed:true});
  const index=await client.callTool({name:'index_repository',arguments:{repo_path:fixture,mode:'fast',persistence:false}},undefined,{timeout:100000});
  assert.notEqual(index.isError,true,JSON.stringify(index).slice(0,500));
  const project=Buffer.from(fixture.replaceAll('\\','/')).toString('latin1').replace(/[^a-zA-Z0-9._-]/g,'-').replace(/-+/g,'-').replace(/\.+/g,'.').replace(/^[-.]+/,'').replace(/-+$/,'');
  evidence.project=project;evidence.tests.push({name:'real-binary-1000-file-index',passed:true});
  const outcomes=await Promise.allSettled(Array.from({length:40},()=>client.callTool({name:'search_graph',arguments:{project,name_pattern:'workload.*',limit:3}},undefined,{timeout:10000})));
  assert.ok(outcomes.some(o=>o.status==='fulfilled'));assert.ok(outcomes.some(o=>o.status==='rejected'));
  evidence.tests.push({name:'burst-backpressure',passed:true,accepted:outcomes.filter(o=>o.status==='fulfilled').length,rejected:outcomes.filter(o=>o.status==='rejected').length});
  for(let i=0;i<100;i++){
    const result=await client.callTool({name:'search_graph',arguments:{project,name_pattern:'workload.*',limit:3}},undefined,{timeout:10000});
    assert.notEqual(result.isError,true);
  }
  await delay(1500);
  const stats=await readJson(path.join(base,'telemetry.json'));
  assert.ok(stats.peakJobBytes>0 && stats.peakJobBytes<=configuration.memoryBytes);
  assert.ok(stats.samples.length<=32);assert.ok(stats.rejectedBusy>0);assert.equal(stats.rejectedScope,1);
  assert.ok(stats.samples.at(-1).privateBytes<stats.peakPrivateBytes/2,'index_memory_not_released');
  evidence.telemetry=stats;evidence.tests.push({name:'100-repeated-queries-bounded-memory',passed:true});
  await client.close();await delay(1500);client=undefined;
  await connect();
  const persisted=await client.callTool({name:'search_graph',arguments:{project,name_pattern:'workload.*',limit:3}});
  assert.notEqual(persisted.isError,true);assert.ok(resultJson(persisted).total>0);
  evidence.tests.push({name:'reconnect-preserves-healthy-index',passed:true});
  await writeFile(path.join(fixture,'new.ts'),'export function afterInterruption(){return 1;}');
  const interrupted=client.callTool({name:'index_repository',arguments:{repo_path:fixture,mode:'full',persistence:false}},undefined,{timeout:100000});
  const interruptedResult=interrupted.then(result=>({result}),error=>({error:error.message}));
  let pending=false;
  for(let i=0;i<100;i++){try{await readJson(path.join(base,'index-recovery.json'));pending=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(25);}
  assert.equal(pending,true);
  const beforeKill=await readJson(path.join(base,'telemetry.json'));
  process.kill(beforeKill.hostPid,'SIGKILL');
  const interruptedOutcome=await interruptedResult;
  assert.ok(interruptedOutcome.error || interruptedOutcome.result?.isError);
  await client.close();client=undefined;await delay(1000);
  await connect();
  const recovered=await client.callTool({name:'search_graph',arguments:{project,name_pattern:'workload.*',limit:3}});
  assert.notEqual(recovered.isError,true);assert.equal(resultJson(recovered).total,1000);
  evidence.tests.push({name:'interrupted-index-restores-previous-sqlite-snapshot',passed:true});
  const gatewayCrash=client.callTool({name:'index_repository',arguments:{repo_path:fixture,mode:'full',persistence:false}},undefined,{timeout:100000}).then(result=>({result}),error=>({error:error.message}));
  let journalPending=false;
  for(let i=0;i<100;i++){try{await readJson(path.join(base,'index-recovery.json'));journalPending=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(25);}
  assert.equal(journalPending,true);assert.ok(transport.pid);
  process.kill(transport.pid,'SIGKILL');
  assert.ok((await gatewayCrash).error);await client.close();client=undefined;await delay(1500);
  await connect();
  const afterGatewayCrash=await client.callTool({name:'search_graph',arguments:{project,name_pattern:'workload.*',limit:3}});
  assert.notEqual(afterGatewayCrash.isError,true);assert.equal(resultJson(afterGatewayCrash).total,1000);
  await delay(1500);assert.equal((await readJson(path.join(base,'telemetry.json'))).recoveredIndex,true);
  evidence.tests.push({name:'gateway-sigkill-stale-lock-and-journal-recovery',passed:true});
  evidence.passed=true;
}catch(error){evidence.failure={message:error.message,stack:error.stack};throw error;}
finally{
  if(client)await client.close();else if(transport)await transport.close();
  await delay(1000);
  try{evidence.finalTelemetry=await readJson(path.join(base,'telemetry.json'));}catch(e){evidence.telemetryError=e.message;}
  await atomicJson(path.join(root,'var/code-memory-resource-evidence.json'),evidence);
  assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cmcp-memory-'));
  await rm(base,{recursive:true,force:true,maxRetries:50,retryDelay:100});
}
console.log(JSON.stringify({passed:evidence.passed,tests:evidence.tests,peakJobBytes:evidence.telemetry?.peakJobBytes}));
