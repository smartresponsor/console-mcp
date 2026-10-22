import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerWebDomainBridgeTools } from '../dist/tool/web-domain-bridge.js';

const calls=[];
const fixture=createServer(async(req,res)=>{
  let body='';
  for await(const chunk of req)body+=chunk;
  calls.push({route:req.url,body:JSON.parse(body),token:req.headers.authorization});
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({ok:true,status:'GRANTS_ROUTING_FIXTURE',targetId:'A'.repeat(32)}));
});
const oldToken=process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN;
process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN='test-grants-fixture-only';
try{
  // Never interfere with an already running Grants worker on its dedicated port.
  fixture.listen(8797,'127.0.0.1');
  try { await Promise.race([once(fixture,'listening'),once(fixture,'error').then(([error])=>{throw error;})]); }
  catch (error) { throw new Error('GRANTS_FIXTURE_PORT_UNAVAILABLE: refuse to replace an active worker', {cause:error}); }
  const handlers=new Map();
  registerWebDomainBridgeTools({registerTool(name,config,handler){handlers.set(name,{config,handler})}},{mode:'bearer',bearerTokens:['fixture']});
  const run=async(name,input)=>{
    const h=handlers.get(name);assert.ok(h,name);
    const obj=h.config.inputSchema.parse({...input,browserSession:'grants'});
    const response=await h.handler(obj);
    return JSON.parse(response.content[0].text);
  };
  const page=await run('write.web.target.open',{url:'https://leverforchange.submittable.com/submit/365978/communities-leading-on-ai-open-call',targetId:'A'.repeat(32)});
  assert.equal(page.status,'GRANTS_ROUTING_FIXTURE');
  assert.equal(calls.at(-1).route,'/open');
  const fill=await run('write.web.form.fill',{approved:false,approvalText:'',fields:[]});
  assert.equal(fill.status,'GRANTS_ROUTING_FIXTURE');
  assert.equal(calls.at(-1).body.approved,false,'Bridge must not confer approval');
  const initial=calls.length;
  const target=await run('write.web.browser.bind',{targetId:'A'.repeat(32)});
  assert.equal(target.status,'GRANTS_ROUTING_FIXTURE');
  assert.equal(calls.at(-1).route,'/browser-bind');
  assert.equal(calls.length,initial+1,'Explicit grants binding cannot search legacy workers');
  const inspect=await run('read_.web.form.inspect',{});
  assert.equal(inspect.status,'GRANTS_ROUTING_FIXTURE');
  assert.equal(calls.at(-1).route,'/inspect');
  assert.equal(calls.every(v=>v.token==='Bearer test-grants-fixture-only'),true);
  console.log(JSON.stringify({ok:true,status:'GRANTS_PINNED_BRIDGE_PASS',calls:calls.length,workerPort:8797,legacyWorkersAccessed:false,approvalPreserved:true}));
}finally{
  if(oldToken===undefined)delete process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN;else process.env.BROWSER_MCP_BROWSER_WORKER_TOKEN=oldToken;
  fixture.close();
}
