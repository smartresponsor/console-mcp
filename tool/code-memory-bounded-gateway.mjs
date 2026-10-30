import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, rm, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { atomicJson, readJson, fileDigest } from './runtime-version-store.mjs';
import { boundedLines } from './bounded-json-lines.mjs';

const config = await readJson(process.argv[2]);
if (process.platform !== 'win32' || !Number.isSafeInteger(config.memoryBytes) || config.memoryBytes <= 0 || !config.budgetEvidence || !Number.isInteger(config.workers) || config.workers < 1 || !Number.isSafeInteger(config.frameBytes) || config.frameBytes < 1 || !Number.isSafeInteger(config.responseBytes) || config.responseBytes < 1 || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) throw Error('calibrated_resource_policy_required');
const base = await realpath(config.base);
const cache = path.join(base, 'cache'), cwd = path.join(base, 'session');
const journalFile = path.join(base, 'index-recovery.json'), lock = path.join(base, 'gateway.lock');
if (await fileDigest(config.executable) !== config.executableSha256) throw Error('code_memory_binary_hash_mismatch');
for (const directory of [cache,cwd]) await mkdir(directory, { recursive: true });
for(const directory of [cache,cwd])if(await realpath(directory)!==directory)throw Error('private_runtime_directory_redirected');
try { await mkdir(lock); }
catch (e) {
  if (e.code !== 'EEXIST') throw e;
  const owner = await readJson(path.join(lock, 'owner.json'));
  try { process.kill(owner.pid, 0); throw Error('gateway_locked'); }
  catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
  await rm(lock, { recursive: true }); await mkdir(lock);
}
await atomicJson(path.join(lock,'owner.json'), { pid: process.pid });
let active, recovering, stopping = false, worker, timer;
const stats = { schema: 1, gatewayPid: process.pid, state: 'starting', admitted: 0, rejectedBusy: 0, rejectedScope: 0, peakPrivateBytes: 0, peakJobBytes: 0, samples: [], memoryBytes: config.memoryBytes, workers: config.workers, concurrency: 1, queueCapacity: 0, budgetEvidence: config.budgetEvidence };
async function telemetry() { stats.gatewayMemory=process.memoryUsage(); await atomicJson(path.join(base,'telemetry.json'), stats); }
async function restore() {
  let record;
  try { record = await readJson(journalFile); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!/^[a-zA-Z0-9_.-]+\.db$/.test(record.name)) throw Error('invalid_recovery_target');
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
  const owned=[record.backendPid,record.hostPid].filter(Boolean);
  for(let i=0;owned.some(alive)&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,100));
  if(owned.some(alive))throw Error('index_recovery_process_cleanup_unverified');
  const target = path.join(cache,record.name);
  await rm(target+'-wal', { force:true }); await rm(target+'-shm', { force:true });
  if (record.existed) await copyFile(path.join(base,'previous.db'),target);
  else await rm(target,{force:true});
  await rm(journalFile); stats.recoveredIndex = true;
}
await restore();
// Separate cache and neutral CWD prevent the legacy home-path auto-index bug.
// Defaults in an absent config DB are auto_index=false. Refuse reused auto-index caches.
{
  const check = spawn(config.executable, ['config','set','auto_index','false'], { cwd, windowsHide:true, env:{...process.env,CBM_CACHE_DIR:cache}, stdio:['ignore','pipe','ignore'] });
  let value=''; check.stdout.on('data', b => { value+=b.toString(); if(value.length>1024)check.kill(); });
  await new Promise((resolve,reject) => { check.once('error',reject);check.once('exit',code => code===0 && /false/.test(value) ? resolve() : reject(Error('private_auto_index_disable_failed'))); });
}
await writeFile(path.join(cache,'config.json'), JSON.stringify({ui_enabled:false,ui_port:0}));
const roots = await Promise.all(config.allowedRoots.map(r => realpath(r)));
function output(line) { if(!process.stdout.write(line+'\n')){process.stdin.pause();process.stdout.once('drain',()=>{if(!stopping)process.stdin.resume();});} }
function forward(line) { if(!worker.stdin.write(line+'\n')){process.stdin.pause();worker.stdin.once('drain',()=>{if(!stopping)process.stdin.resume();});} }
function reply(id,code,message) { output(JSON.stringify({jsonrpc:'2.0',id,error:{code,message}})); }
async function shutdown(state) {
  if (stopping) return;
  stopping=true; clearInterval(timer); stats.state=state;
  if(active)clearTimeout(active.timeout);
  if(worker && worker.exitCode===null && worker.signalCode===null) {
    worker.stdin.end();
    await new Promise(resolve => worker.once('exit',resolve));
  }
  await restore(); await telemetry(); await rm(lock,{recursive:true}); process.stdin.destroy();
}
worker=spawn('pwsh',['-NoProfile','-File',fileURLToPath(new URL('./windows-contained-process.ps1',import.meta.url))],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
const env={...process.env,CBM_CACHE_DIR:cache,CBM_WORKERS:String(config.workers),CBM_LOG_LEVEL:'info'};
delete env.CBM_DIAGNOSTICS;
worker.stdin.write(JSON.stringify({executable:config.executable,arguments:[],cwd,env,memoryBytes:config.memoryBytes})+'\n');
worker.stdin.on('error',()=>{ void shutdown('backend-input-closed').catch(fatal); });
function fatal(error) { process.stderr.write(JSON.stringify({gateway:'failed',reason:error.message})+'\n');process.exitCode=78; }
boundedLines(worker.stderr,65536,line=>{
  let event; try{event=JSON.parse(line);}catch{return;} // C backend's diagnostic text is optional; never forward raw bytes.
  if(event.containment==='ready'){stats.pid=event.pid;stats.hostPid=event.hostPid;stats.state='ready';}
  if(event.containment==='sample'){
    stats.peakPrivateBytes=Math.max(stats.peakPrivateBytes,event.privateBytes);
    stats.peakJobBytes=Math.max(stats.peakJobBytes,event.peakJobBytes);
    stats.samples.push(event);if(stats.samples.length>32)stats.samples.shift();
  }
},error=>{fatal(error);void shutdown('backend-frame-failure');});
boundedLines(worker.stdout,config.responseBytes,line=>{
  let message;try{message=JSON.parse(line);}catch{fatal(Error('backend_invalid_json'));void shutdown('backend-invalid-json');return;}
  if(active && message.id===active.id){
    clearTimeout(active.timeout);
    const operation=active;
    // Keep admission closed until the durable index journal is committed/cleared.
    void (async()=>{
      if(operation.index){
        if(message.result?.isError || message.error){await shutdown('index-failed-restored');}
        else {await rm(journalFile);stats.indexCommitted=true;}
      }
      active=undefined;
      if(!process.stdout.write(line+'\n')){worker.stdout.pause();process.stdout.once('drain',()=>worker.stdout.resume());}
    })().catch(fatal);
  }else if(!process.stdout.write(line+'\n')){worker.stdout.pause();process.stdout.once('drain',()=>worker.stdout.resume());}
},error=>{fatal(error);void shutdown('backend-frame-failure');});
worker.once('exit',()=>{
  if(stopping)return;
  if(active){clearTimeout(active.timeout);reply(active.id,-32002,'contained_backend_exited_no_request_replayed');active=undefined;}
  void shutdown('backend-exited').then(()=>{process.exitCode=78;},fatal);
});
worker.once('error',error=>{fatal(error);void shutdown('backend-launch-failed');});
boundedLines(process.stdin,config.frameBytes,line=>{
  let message;try{message=JSON.parse(line);}catch{reply(null,-32700,'invalid_json');return;}
  if(stopping){if(message.id!==undefined)reply(message.id,-32002,'backend_unavailable');return;}
  if(message.id===undefined){if(!active?.admitting)forward(line);return;}
  if(active){stats.rejectedBusy++;reply(message.id,-32001,'resource_busy_retry_after_completion');return;}
  const index=message.method==='tools/call' && message.params?.name==='index_repository';
  active={id:message.id,index,admitting:true};
  void (async()=>{
    if(index){
      const requested=await realpath(message.params.arguments.repo_path);
      const home=await realpath(os.homedir());
      if(requested.toLowerCase()===home.toLowerCase() || !roots.some(r=>r.toLowerCase()===requested.toLowerCase())){stats.rejectedScope++;reply(message.id,-32602,'index_root_not_admitted');active=undefined;return;}
      const name=Buffer.from(requested.replaceAll('\\','/')).toString('latin1').replace(/[^a-zA-Z0-9._-]/g,'-').replace(/-+/g,'-').replace(/\.+/g,'.').replace(/^[-.]+/,'').replace(/-+$/,'')+'.db';
      const target=path.join(cache,name);let existed=false;
      try{
        const db=new DatabaseSync(target,{readOnly:true});
        try{await backup(db,path.join(base,'previous.db'));existed=true;}finally{db.close();}
      }catch(e){if((await readdir(cache)).includes(name))throw e;}
      await atomicJson(journalFile,{name,existed,backendPid:stats.pid,hostPid:stats.hostPid});
    }
    stats.admitted++;active.admitting=false;
    active.timeout=setTimeout(()=>{reply(message.id,-32002,'request_deadline_no_replay');void shutdown('request-timeout').catch(fatal);},config.timeoutMs);
    forward(line);
  })().catch(error=>{reply(message.id,-32602,error.message);active=undefined;});
},error=>{fatal(error);void shutdown('input-frame-failure');});
process.stdin.once('end',()=>{void shutdown('client-disconnected').catch(fatal);});
timer=setInterval(()=>{if(!recovering)recovering=telemetry().catch(fatal).finally(()=>{recovering=undefined;});},1000);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void shutdown('signal').catch(fatal);});
