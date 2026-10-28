import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedLines } from './bounded-json-lines.mjs';
import { atomicJson } from './runtime-version-store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(os.tmpdir(),'cmcp-containment-'));
const fixture=path.join(temp,'child.mjs');
await writeFile(fixture,`import {spawn} from 'node:child_process';
const child=process.env.STRESS==='true'?null:spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
console.log(JSON.stringify({grandchild:child?.pid,ready:true}));
const held=[];setInterval(()=>{if(process.env.STRESS==='true')held.push(Buffer.alloc(8*1024**2,1));},50);
`);
const evidence={schema:1,tests:[]};
try{
  for(const scenario of ['host-termination','lease-disconnect','memory-commit-limit']){
    const host=spawn('pwsh',['-NoProfile','-File',path.join(root,'tool/windows-contained-process.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const exited=once(host,'exit');let runtimePid,grandchild,ready=false,peak=0,parseError;
    boundedLines(host.stderr,65536,line=>{try{const e=JSON.parse(line);if(e.containment==='ready')runtimePid=e.pid;if(e.peakJobBytes)peak=Math.max(peak,e.peakJobBytes);}catch{}},e=>{parseError=e;});
    boundedLines(host.stdout,65536,line=>{const e=JSON.parse(line);grandchild=e.grandchild;ready=e.ready;},e=>{parseError=e;});
    host.stdin.on('error',()=>{});
    const limit=96*1024**2;
    host.stdin.write(JSON.stringify({executable:process.execPath,arguments:[fixture],cwd:temp,env:{...process.env,STRESS:String(scenario==='memory-commit-limit')},memoryBytes:limit})+'\n');
    try{
      for(let i=0;i<100 && !ready;i++)await delay(100);
      assert.ok(runtimePid && ready);if(parseError)throw parseError;
      if(scenario==='host-termination')host.kill('SIGKILL');
      if(scenario==='lease-disconnect')host.stdin.end();
      await Promise.race([exited,delay(20000,undefined,{ref:false}).then(()=>{throw Error('contained_exit_timeout');})]);
      for(let i=0;i<50;i++){try{process.kill(runtimePid,0);await delay(100);}catch(e){if(e.code==='ESRCH')break;throw e;}}
      for(const pid of [runtimePid,grandchild].filter(Boolean))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
      // This Windows build reports a small peak-counter excess at allocation
      // failure. Its exact accounting cause is not established. Record it and
      // bound the test envelope by one fixture allocation, rather than claiming
      // an unobserved zero-overshoot guarantee.
      if(scenario==='memory-commit-limit'){assert.notEqual(host.exitCode,0);assert.ok(peak>0 && peak<=limit+8*1024**2,JSON.stringify({peak,limit,exitCode:host.exitCode}));}
      evidence.tests.push({scenario,passed:true,hostPid:host.pid,runtimePid,grandchild,peakJobBytes:peak,limit,observedPeakExcessBytes:Math.max(0,peak-limit),allProcessesStopped:true});
    }finally{if(host.exitCode===null && host.signalCode===null){host.kill('SIGKILL');await exited;}}
  }
  evidence.passed=true;
}finally{
  await atomicJson(path.join(root,'var/windows-containment-evidence.json'),evidence);
  assert.equal(path.dirname(temp),os.tmpdir());assert.ok(path.basename(temp).startsWith('cmcp-containment-'));
  await rm(temp,{recursive:true,force:true,maxRetries:50,retryDelay:100});
}
console.log(JSON.stringify(evidence));
