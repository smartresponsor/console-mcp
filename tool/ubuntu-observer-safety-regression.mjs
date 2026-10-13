import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd(), temp=await mkdtemp(path.join(tmpdir(),'observer-safety-'));
try {
 const bin=path.join(temp,'bin'), scripts=path.join(temp,'scripts'), log=path.join(temp,'calls');
 await mkdir(bin); await mkdir(scripts);
 for(const name of ['watchdog.sh','runtime-maintenance.sh']) await copyFile(path.join(root,'ops/ubuntu/script',name),path.join(scripts,name));
 const mock=async(name,body)=>writeFile(path.join(bin,name),'#!/bin/bash\n'+body,{mode:0o755});
 await mock('systemctl',`echo "systemctl $*" >> "$CALL_LOG"\nif [[ "$1" == show ]]; then if [[ "$*" == *ActiveState* ]]; then echo "$FIXTURE_STATE"; else echo success; fi; fi\n`);
 await mock('curl',`printf '%s' "$FIXTURE_HTTP"\n`);
 await mock('node',`echo "node $*" >> "$CALL_LOG"\n`);
 await mock('runuser',`shift 3; exec "$@"\n`);
 const env={...process.env,PATH:bin+':'+process.env.PATH,CALL_LOG:log,CONSOLE_MCP_ROOT:temp,CONSOLE_MCP_WATCHDOG_RETRY_DELAY_SECONDS:'0'};
 for(const [state,http,label] of [['inactive','000','ADMINISTRATIVELY_PAUSED'],['inactive','200','ADMINISTRATIVELY_PAUSED'],['failed','000','CRASHED'],['active','000','DEGRADED'],['active','200','HEALTHY']]) {
  for(const optIn of ['false','true']) {
   await writeFile(log,'');
   const r=spawnSync('bash',[path.join(scripts,'watchdog.sh')],{env:{...env,FIXTURE_STATE:state,FIXTURE_HTTP:http,CONSOLE_MCP_WATCHDOG_ALLOW_RESTARTS:optIn,CONSOLE_MCP_WATCHDOG_ALLOW_BROWSER_CLEANUP:'false'},encoding:'utf8'});
   assert.equal(r.status,0,r.stderr); assert.match(r.stderr,new RegExp('state='+label));
   const calls=await readFile(log,'utf8');
   assert.equal(calls.includes('systemctl restart'),state==='active'&&http==='000'&&optIn==='true');
   assert.doesNotMatch(calls,/engine-browser-target-reaper|plugin-settings-cleanup|engine-cli/);
   assert.match(calls,new RegExp('--mcp-state='+label));
   assert.match(calls,new RegExp('--mcp-ok='+(label==='HEALTHY')));
  }
 }
 for(const cleanup of ['false','true']) {
  await writeFile(log,'');
  const r=spawnSync('bash',[path.join(scripts,'runtime-maintenance.sh'),'true','true','123'],{env:{...env,CONSOLE_MCP_WATCHDOG_ALLOW_BROWSER_CLEANUP:cleanup},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const calls=await readFile(log,'utf8'); assert.equal(calls.includes('engine-browser-target-reaper'),cleanup==='true');
 }
 console.log('Observer safety: PASS (inactive/failed preserved, opt-in degraded recovery, independent cleanup authorization)');
} finally {await rm(temp,{recursive:true,force:true});}
