import assert from 'node:assert/strict';
import http from 'node:http';
import {syncBuiltinESMExports,createRequire} from 'node:module';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
const browsing=process.argv[2];
assert.ok(browsing);
const defsPath=join(browsing,'mcp-server/src/web-domain-tool-definitions.cjs');
const source=readFileSync(join(browsing,'playwright-worker/src/worker.js'),'utf8');
const routes=name=>new Set(JSON.parse(source.match(new RegExp('const '+name+' = new Set\\((\\[[^\\]]+\\])\\);'))[1].replaceAll("'",'"')));
const guarded=routes('guardedRoutes'),diagnostic=routes('diagnosticRoutes');
const calls=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 calls.push({route:req.url,auth:req.headers.authorization,lease:req.headers['x-console-browser-lease-root'],body:JSON.parse(raw)});
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,status:'FIXTURE_OBSERVED'}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const original=http.request;
const root=mkdtempSync(join(tmpdir(),'paired-dispatch-'));
const env={BROWSER_MCP_CORE_DOMAIN_DEFINITIONS_PATH:defsPath,BROWSER_MCP_BROWSER_WORKER_URL:'http://127.0.0.1:8791',BROWSER_MCP_BROWSER_WORKER_TOKEN:'fixture-token',CONSOLE_MCP_VISIBLE_OS_LEASES:'required',CONSOLE_MCP_VISIBLE_LEASE_ROOT:root};
const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
Object.assign(process.env,env);
// Only in this fixture process: redirect the HTTP transport after checking
// the real requested destination. No production listener receives a request.
http.request=function(options,...args){
 assert.equal(options.hostname,'127.0.0.1');assert.equal(String(options.port),'8791');
 return original.call(http,{...options,port:server.address().port},...args);
};
syncBuiltinESMExports();
try{
 const {resolvePairedWebDispatch:dispatch,registerWebDomainBridgeTools}=await import('../dist/tool/web-domain-bridge.js');
 const {inspectVisibleProcessLeaseRoot}=await import('../dist/service/visible-browser-process-lock.js');
 const url=new URL(env.BROWSER_MCP_BROWSER_WORKER_URL),lease=inspectVisibleProcessLeaseRoot();
 assert.ok(lease);
 for(const r of guarded){assert.deepEqual(dispatch(r,'write',url,'token',lease),{ok:true,route:'/lease-v1'+r,leaseIdentity:lease.identity});assert.equal(dispatch(r,'read',url,'token',null).ok,false);}
 for(const r of diagnostic){assert.deepEqual(dispatch(r,'read',url,'token',null),{ok:true,route:r});assert.equal(dispatch(r,'write',url,'token',lease).ok,false);}
 for(const r of ['/unknown','/lease-v1/click','/browser-restart','/click?x=1','/../click','/secret-fill'])assert.equal(dispatch(r,'write',url,'token',lease).status,'WEB_SHARED_LEASE_ROUTE_DENIED');
 for(const endpoint of ['http://localhost:8791','http://127.0.0.1:8792','http://127.0.0.1:8791/base','http://user@127.0.0.1:8791/','http://127.0.0.1:8791/?x=1','http://127.0.0.1:8791/#x']){
  for(const r of ['/click','/browser-targets'])assert.equal(dispatch(r,'read',new URL(endpoint),'token',lease).ok,false);
 }
 assert.equal(dispatch('/browser-targets','read',url,'',null).ok,false);
 const definitions=createRequire(defsPath)(defsPath).createWebCoreDomainToolDefinitions();
 assert.equal(definitions.length,17);
 const registered=new Map();
 registerWebDomainBridgeTools({registerTool(name,config,handler){registered.set(name,{config,handler});}},{mode:'bearer',bearerTokens:['fixture']});
 const inputs={'write.web.target.open':{url:'https://example.invalid/'},'write.web.job.open':{url:'https://example.invalid/'},'write.web.form.proposal.preview':{fields:[]},'write.web.form.fill':{approved:false,approvalText:'',fields:[]},'write.web.form.upload':{approved:false,approvalText:'',artifactRef:'fixture.txt'},'write.web.form.submit':{approved:false,approvalText:''}};
 for(const d of definitions){
  const t=registered.get(d.consoleName);
  assert.ok(t);
  const input=t.config.inputSchema.parse({...inputs[d.consoleName],browserSession:'isolated'});
  const before=calls.length;
  const result=JSON.parse((await t.handler(input)).content[0].text);
  assert.equal(result.ok,true,d.consoleName);
  assert.equal(calls.length,before+1);
  const observed=calls.at(-1);
  assert.equal(observed.route,guarded.has(d.route)?'/lease-v1'+d.route:d.route);
  assert.equal(observed.auth,'Bearer fixture-token');
  assert.equal(observed.lease,guarded.has(d.route)?lease.identity:undefined);
 }
 const before=calls.length;
 process.env.BROWSER_MCP_BROWSER_WORKER_URL='http://127.0.0.1:8792';
 const denied=JSON.parse((await registered.get('read_.web.browser.targets').handler({})).content[0].text);
 assert.equal(denied.status,'WEB_SHARED_LEASE_CONFIGURATION_REQUIRED');assert.equal(calls.length,before);
 process.env.BROWSER_MCP_BROWSER_WORKER_URL=env.BROWSER_MCP_BROWSER_WORKER_URL;
 delete process.env.CONSOLE_MCP_VISIBLE_LEASE_ROOT;
 assert.equal(inspectVisibleProcessLeaseRoot(),null,'fixture must actually have no lease root');
 const rejected=JSON.parse((await registered.get('read_.web.form.inspect').handler({})).content[0].text);
 assert.equal(rejected.status,'WEB_SHARED_LEASE_CONFIGURATION_REQUIRED');assert.equal(calls.length,before);
 console.log('PAIRED_WEB_DISPATCH_PASS (17 tools, exact worker route sets, actual fixture HTTP, no production requests)');
}finally{
 http.request=original;syncBuiltinESMExports();
 for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});
}
