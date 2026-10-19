import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { inspectVisibleTarget } from '../dist/service/visible-browser-session.js';
const cfg={};for(const f of ['/etc/console-mcp/console-mcp.env','/etc/console-mcp/browsing.env']){try{for(const line of readFileSync(f,'utf8').split('\n')){const m=line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);if(m)cfg[m[1]]=m[2].trim().replace(/^["']|["']$/g,'');}}catch{}}
const token=process.env.CONSOLE_MCP_BEARER_TOKEN??cfg.CONSOLE_MCP_BEARER_TOKEN;
if(!token)throw Error('Bearer unavailable');
const c=new Client({name:'visible-close-recheck',version:'1'});
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
const js=async(path)=>await(await fetch('http://127.0.0.1:9224'+path,{signal:AbortSignal.timeout(1500)})).json();
const tabs=(await js('/json/list')).filter(x=>x.type==='page');
const target=tabs.find(x=>x.url.startsWith('https://jobs.ashbyhq.com/gc-ai/'))??tabs[0];if(!target)throw Error('No targets');
const native=await inspectVisibleTarget({port:9224,targetId:target.id});
if(!native.ok)throw Error('Native window not verified: '+native.reason);
const old=await js('/json/version');
const before={pid:native.evidence.browserPid,window:native.evidence.windowId,instance:old.webSocketDebuggerUrl,profile:native.evidence.profile,tabs:tabs.map(x=>x.url)};
console.log('BEFORE',JSON.stringify(before));
const response=await c.callTool({name:'write.web.browser.close',arguments:{browserSession:'visible',targetId:target.id,confirmClose:true}});
const body=JSON.parse(response.content?.find(x=>x.type==='text')?.text??'{}');
console.log('CLOSE',JSON.stringify(body).slice(0,1600));
let after=null;
for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,250));try{const v=await js('/json/version');if(v.webSocketDebuggerUrl!==old.webSocketDebuggerUrl){const pages=(await js('/json/list')).filter(t=>t.type==='page');const checked=pages[0]?await inspectVisibleTarget({port:9224,targetId:pages[0].id}):null;after={instance:v.webSocketDebuggerUrl,pid:checked?.evidence.browserPid,window:checked?.evidence.windowId,visible:checked?.ok,tabs:pages.map(x=>x.url)};break;}}catch{}}
console.log('AFTER',JSON.stringify(after));
if(!body.ok||!after||after.pid===before.pid)throw Error('Lifecycle not confirmed');
const t=await c.callTool({name:'write.web.browser.open',arguments:{url:'https://www.google.com/',ports:[9224],confirmOpen:true}});
console.log('OPEN',JSON.stringify(t).slice(0,1600));
await c.close();
