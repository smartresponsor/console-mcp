import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readFileSync} from 'node:fs';
const id='B2BD3CA2B44993468A6AE2E6AAF18719';
const token=readFileSync('/etc/console-mcp/console-mcp.env','utf8').match(/^CONSOLE_MCP_BEARER_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^['\"]|['\"]$/g,'');
if(!token) throw Error('MCP authentication unavailable');
const client=new Client({name:'nellis-find-batch',version:'1.0'});
const extract=r=>{const t=r.content?.find(x=>x.type==='text');return t?JSON.parse(t.text):r};
const call=async(name,args)=>extract(await client.callTool({name,arguments:{browserSession:'visible',...(['write.web.form.fill','write.web.page.click'].includes(name)?{}:{targetId:id}),...args}}));
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3334/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
try {
  const results=[];
  for(const code of ['453549','704352','710035','274587']) {
    let form=await call('read_.web.page.capture.form',{});
    if(form.ok&&!form.fields?.some(f=>f.id==='find-items-input'&&f.visible)){
      const opened=await call('write.web.page.click',{expectedTargetId:id,text:'Find'});
      if(!opened.ok){results.push({code,status:opened.status});break;}
      form=await call('read_.web.page.capture.form',{});
    }
    if(!form.ok){results.push({code,status:form.status});break;}
    const field=form.fields?.find(f=>f.id==='find-items-input'&&f.visible&&f.safeEditable);
    if(!field){results.push({code,status:'FIND_FIELD_UNAVAILABLE'});break;}
    const fields=[{controlId:field.controlId,value:code}];
    const preview=await call('write.web.form.proposal.preview',{fields});
    if(!preview.ok){results.push({code,status:preview.status});break;}
    const filled=await call('write.web.form.fill',{fields,expectedTargetId:id,expectedPageRevision:preview.pageRevision,expectedFormRevision:preview.formRevision,approved:true,approvalText:'APPLY',approvalReceiptId:preview.approvalReceipt?.id});
    if(!filled.ok){results.push({code,status:filled.status,reason:filled.reason});break;}
    await new Promise(resolve=>setTimeout(resolve,1500));
    const capture=await call('read_.web.page.capture.dom',{});
    if(!capture.ok){results.push({code,status:capture.status});break;}
    const txt=capture.dom?.text||'';
    const count=txt.match(/WON AUCTIONS\s+(\d+) Auctions/)?.[1];
    const links=(capture.dom?.links||[]).filter(l=>/^https:\/\/www\.nellisauction\.com\/p\//.test(l.href)).filter((l,i,a)=>a.findIndex(x=>x.href===l.href)===i);
    const row={code,status:'SKIPPED',count:Number(count||0),products:links.map(l=>({name:l.text,href:l.href})),pickedUp:txt.includes('PICKED UP')};
    if(row.count===1&&row.pickedUp&&links.length===1){
      const clicked=await call('write.web.page.click',{expectedTargetId:id,selector:'a[data-ax="item-card-title-link"]'});
      if(!clicked.ok){row.status=clicked.status;results.push(row);break;}
      const detail=await call('read_.web.page.capture.dom',{});
      const inventory=detail.dom?.text?.match(/Inventory Number\s+(\d{7,})/)?.[1];
      row.inventory=inventory||null;row.exact=Boolean(inventory?.endsWith(code));row.status=row.exact?'EXACT_PICKED_UP':'SKIPPED_NOT_EXACT';
      const back=await call('write.web.page.click',{expectedTargetId:id,text:'Back'});
      row.back=back.ok;
      results.push(row);if(!back.ok)break;
    } else results.push(row);
  }
  console.log(JSON.stringify({ok:true,results}));
} finally { await client.close(); }
