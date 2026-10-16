import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync } from 'node:fs';
const id='B2BD3CA2B44993468A6AE2E6AAF18719';
const env=readFileSync('/etc/console-mcp/console-mcp.env','utf8');
const token=env.match(/^CONSOLE_MCP_BEARER_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/,'$2');
if(!token)throw Error('Console bearer token unavailable');
const client=new Client({name:'nellis-readonly-probe',version:'1.0.0'});
const payload=r=>{for(const c of r.content??[])if(c.type==='text'){try{return JSON.parse(c.text)}catch{}}return r};
try{
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 const fields=[{controlId:'control:714cce1f9a937d66ea6adab080aa6836112e56b0cc51d13cc5f7faeb8e2e24a2',value:'380690'}];
 const preview=payload(await client.callTool({name:'write.web.form.proposal.preview',arguments:{browserSession:'visible',targetId:id,fields}}));
 const result=payload(await client.callTool({name:'read_.web.page.capture.dom',arguments:{browserSession:'visible',targetId:id}}));
 writeFileSync('/var/lib/console-mcp/run/nellis-readonly-capture.json',JSON.stringify(result));
 const publicResult={receiptShape:result.approvalReceipt?Object.keys(result.approvalReceipt):[],proposals:result.proposals?.map(x=>({controlId:x.controlId,status:x.status,operation:x.operation,reason:x.reason})),ok:result.ok,status:result.status,reason:result.reason,states:result.states,evidence:result.evidence,keys:Object.keys(result),visiblePort:result.visible_session?.evidence?.endpoint,targetId:result.visible_session?.evidence?.targetId,postSession:result.visible_session,telemetry:result.browser_telemetry,workerStatus:result.http_status,workerReason:result.error,artifact:'/var/lib/console-mcp/run/nellis-readonly-capture.json'};
 for(const field of ['url','title','page','snapshot','text','semantic','links','forms','error'])if(result[field]!==undefined)publicResult[field]=JSON.stringify(result[field]).slice(0,7000);
 if(Array.isArray(result.fields)) publicResult.findFieldSummary=result.fields.filter(x=>x.id==='find-items-input'||x.name==='keyword').map(x=>({id:x.id,name:x.name,controlId:x.controlId,index:x.index,visible:x.visible,safeEditable:x.safeEditable,placeholder:x.placeholder}));
 if(result.dom){const d=result.dom; publicResult.domSummary={identifierCount:d.identifiers?.length,identifierCodeHits:['380690','453549','693345','704352','710035','274587'].map(code=>({code,count:d.identifiers?.filter(x=>JSON.stringify(x).includes(code)).length})),suffixMatches:['380690','453549','693345','704352','710035','274587'].map(code=>({code,matches:d.identifiers?.flatMap(x=>x.attributes?.filter(a=>String(a[1]).match(/\d{6,}/g)?.some(n=>n.endsWith(code))).map(a=>({tag:x.tag,attribute:a})))?.slice(0,8)})),identifierExamples:d.identifiers?.slice(25,45),findControls:d.findControls?.filter(x=>/find|search|auction|year/i.test(JSON.stringify(x))).slice(0,20),textLength:d.text?.length,links:d.links?.length,items:d.items?.length,codeHits:['380690','453549','693345','704352','710035','274587'].map(code=>({code,inText:d.text?.includes(code),inItems:d.items?.filter(x=>JSON.stringify(x).includes(code)).length})),linkCodeHits:['380690','453549','693345','704352','710035','274587'].map(code=>({code,links:d.links?.filter(l=>JSON.stringify(l).includes(code)).length})),productLinks:d.links?.filter(l=>/auction|item|lot|product/.test(l.href)&&!/dashboard\/auctions/.test(l.href)).slice(0,15),linksSample:d.links?.slice(0,30),itemsSample:d.items?.slice(0,8),textSample:d.text?.slice(0,6500)};}
 console.log(JSON.stringify(publicResult));
}finally{await client.close();}
