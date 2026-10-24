import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { inspectVisibleTarget, visibleCdpCommand } from '../dist/service/visible-browser-session.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const cfg={};
for(const f of ['/etc/console-mcp/console-mcp.env','/etc/console-mcp/browsing.env'])for(const line of readFileSync(f,'utf8').split('\n')){const m=line.match(/^([A-Z_0-9]+)=(.*)$/);if(m)cfg[m[1]]=m[2].trim().replace(/^(["'])(.*)\1$/,'$2');}
const hashes=()=>{const r='/var/lib/console-mcp/run/engine/task';return readdirSync(r).filter(n=>n.endsWith('.json')).sort().map(n=>[n,createHash('sha256').update(readFileSync(r+'/'+n)).digest('hex')]);};
const before=hashes();
const report={at:new Date().toISOString(),lockedTest:process.argv.includes('--locked'),submissionsAttempted:false,lockedHint:execFileSync('loginctl',['show-session',execFileSync('loginctl',['show-user','alex','-p','Display','--value'],{encoding:'utf8'}).trim(),'-p','LockedHint','--value'],{encoding:'utf8'}).trim()};
const client=new Client({name:'visible-runtime-acceptance',version:'1.0.0'});
const text=r=>{for(const c of r.content??[])if(c.type==='text'){try{return JSON.parse(c.text);}catch{}}return r;};
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'),{requestInit:{headers:{Authorization:'Bearer '+cfg.CONSOLE_MCP_BEARER_TOKEN}}}));
 report.consoleHealthy=true;
 const{tools}=await client.listTools();
 report.schemas=tools.filter(t=>['read_.web.browser.targets','write.web.browser.bind','read_.web.page.capture'].includes(t.name)).map(t=>({name:t.name,browserSession:t.inputSchema.properties?.browserSession}));
 report.previewContract=tools.filter(t=>t.name==='write.web.form.proposal.preview').map(t=>({name:t.name,hasBrowserSession:Boolean(t.inputSchema.properties?.browserSession),hasTargetId:Boolean(t.inputSchema.properties?.targetId),required:t.inputSchema.required??[]}));
 report.workers=[];
 for(const[worker,cdp]of[[8791,9223],[8793,9224]]){
  const response=await fetch(`http://127.0.0.1:${worker}/browser-cdp-targets`,{method:'POST',headers:{Authorization:'Bearer '+cfg.BROWSER_MCP_BROWSER_WORKER_TOKEN,'Content-Type':'application/json'},body:'{}'});
  const inventory=await response.json();const direct=await(await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
  const ids=inventory.targets.map(t=>t.id??t.targetId).sort();
  const unauthorized=await fetch(`http://127.0.0.1:${worker}/browser-cdp-targets`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  report.workers.push({worker,cdp,matched:JSON.stringify(ids)===JSON.stringify(direct.map(t=>t.id).sort()),authorized:response.status,unauthorized:unauthorized.status,targetCount:ids.length});
 }
 const targets=text(await client.callTool({name:'read_.web.browser.targets',arguments:{browserSession:'visible'}}));
 report.discovery={ok:targets.ok,status:targets.status,endpoint:targets.endpoint,targetCount:targets.targets?.length,error:targets.isError?targets.content:undefined};
 const candidates=(targets.targets??[]).filter(t=>t.type==='page'&&(t.url.startsWith('https://jobs.ashbyhq.com/gc-ai/') || t.url === 'https://modetech.bandcamp.com/album/cozy-ep-free-download'));
 report.candidates=candidates.map(t=>({targetId:t.id??t.targetId,title:t.title}));
 if(!report.lockedTest && candidates.length){
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- Fixed loopback CDP endpoint; no user-controlled URL or remote transport.
  const direct=await(await fetch('http://127.0.0.1:9224/json/list')).json();
  const selected=direct.find(t=>t.id===(candidates[0].id??candidates[0].targetId));
  await visibleCdpCommand(selected.webSocketDebuggerUrl,'Page.bringToFront');
  await new Promise(r=>setTimeout(r,300));
 }
 report.visibility=[];
 for(const t of candidates){const v=await inspectVisibleTarget({port:9224,targetId:t.id??t.targetId});report.visibility.push(v);}
 if(report.lockedTest){
  const t=candidates[0];report.capture=text(await client.callTool({name:'read_.web.page.capture',arguments:{browserSession:'visible',screenshot:true}}));
  report.passed=report.lockedHint==='yes'&&report.visibility.length>0&&report.visibility.every(v=>!v.ok&&!v.user_interaction_ready)&&report.capture.ok===false&&report.capture.status==='WEB_VISIBLE_SESSION_REQUIRED';
 }else{
  const eligible=report.visibility.filter(v=>v.ok);
  if(eligible.some(v=>v.evidence.targetId===(candidates[0].id??candidates[0].targetId))){const targetId=candidates[0].id??candidates[0].targetId;
   report.bind=text(await client.callTool({name:'write.web.browser.bind',arguments:{browserSession:'visible',targetId}}));
   if(report.bind.ok){const capture=text(await client.callTool({name:'read_.web.page.capture',arguments:{browserSession:'visible',targetId,screenshot:true}}));
    // Keep screenshots/PII out of console output; preserve the local result for inspection.
    writeFileSync('/var/lib/console-mcp/run/visible-runtime-capture.json',JSON.stringify(capture));
    report.capture={ok:capture.ok,status:capture.status,keys:Object.keys(capture),error:capture.isError?capture.content:undefined,visible_session:capture.visible_session,screenshot:capture.screenshot??null,artifact:'/var/lib/console-mcp/run/visible-runtime-capture.json'};
   }
  }
  report.passed=report.schemas.length===3&&report.schemas.every(t=>t.browserSession)&&report.previewContract.length===1&&report.previewContract[0].hasBrowserSession&&report.previewContract[0].hasTargetId&&report.workers.every(w=>w.matched&&w.unauthorized===401)&&report.bind?.ok===true&&report.capture?.ok===true;
 }
 report.taskFilesUnchanged=JSON.stringify(before)===JSON.stringify(hashes());
 report.passed&&=report.taskFilesUnchanged;
 writeFileSync('/var/lib/console-mcp/run/visible-runtime-'+(report.lockedTest?'locked':'acceptance')+'.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 if(!report.passed) process.exitCode=1;
}finally{await client.close();}
