import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readFileSync} from 'node:fs';
const cfg={};for(const f of ['/etc/console-mcp/console-mcp.env','/etc/console-mcp/browsing.env'])try{for(const line of readFileSync(f,'utf8').split('\n')){const m=line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);if(m)cfg[m[1]]=m[2].trim().replace(/^["']|["']$/g,'')}}catch{}
const token=process.env.CONSOLE_MCP_BEARER_TOKEN??cfg.CONSOLE_MCP_BEARER_TOKEN;
if(!token)throw Error('MCP credential unavailable');
const c=new Client({name:'background-read-acceptance',version:'1.0'});
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
try{
const names=(await c.listTools()).tools;
const tool=names.find(t=>t.name==='read_.web.page.capture');
console.log('SCHEMA',JSON.stringify({available:!!tool,browserSession:tool?.inputSchema?.properties?.browserSession??null,targetId:tool?.inputSchema?.properties?.targetId??null}));
const response=await c.callTool({name:'read_.web.page.capture',arguments:{browserSession:'visible',targetId:'E33118268E63396AE683D23D149CF9B5',screenshot:false}});
const item=response.content?.find(x=>x.type==='text');
const data=JSON.parse(item?.text??'{}');
console.log('CAPTURE',JSON.stringify({ok:data.ok,status:data.status,reason:data.reason,targetId:data.targetId,url:data.url,fieldCount:Array.isArray(data.fields)?data.fields.length:null,visibilityVerified:data.visible_session?.visibility_verified,sessionStatus:data.visible_session?.status,isError:response.isError??false}));
}finally{await c.close()}
