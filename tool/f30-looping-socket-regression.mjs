import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"f30-"));
const gid=process.getgroups().find(x=>x>0)||process.getgid();
const dir=path.join(tmp,"socket");fs.mkdirSync(dir);fs.chownSync(dir,process.getuid(),gid);fs.chmodSync(dir,0o710);
const socket=path.join(dir,"looping.sock");
const port=54000+Math.floor(Math.random()*4000);
const origin="http://127.0.0.1:"+port;
let child;
const call=(url,method="POST",request={jsonrpc:"2.0",method:"tools/list",id:1})=>new Promise((resolve,reject)=>{
  const body=JSON.stringify(request);
  const r=http.request({socketPath:socket,path:url,method,headers:{"content-type":"application/json",accept:"application/json, text/event-stream"}},res=>{
    let s="";res.on("data",c=>s+=c);res.on("end",()=>resolve({status:res.statusCode,body:s}));
  });r.on("error",reject);if(method==="POST")r.write(body);r.end();
});
try{
 child=spawn(process.execPath,["dist/index.js"],{cwd:process.cwd(),env:{...process.env,
 CONSOLE_MCP_MANAGED_RUNTIME:"smoke-test",CONSOLE_MCP_RELEASE_PROBE:"1",
 CONSOLE_MCP_HOST:"127.0.0.1",CONSOLE_MCP_PORT:String(port),CONSOLE_MCP_AUTH_MODE:"oauth",
 CONSOLE_MCP_PUBLIC_ORIGIN:origin,CONSOLE_MCP_OAUTH_ISSUER:"https://example.invalid/",
 CONSOLE_MCP_OAUTH_AUDIENCE:origin,CONSOLE_MCP_LOOPING_TUNNEL_SOCKET:socket,
 CONSOLE_MCP_LOOPING_TUNNEL_GID:String(gid),CONSOLE_MCP_TRANSCRIPT_DIR:tmp},
 stdio:["ignore","pipe","pipe"]});
 let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);
 const deadline=Date.now()+18000;
 while(!fs.existsSync(socket)){if(child.exitCode!==null)throw Error("startup exited "+output);if(Date.now()>deadline)throw Error("startup timeout "+output);await new Promise(r=>setTimeout(r,60))}
 const socketStat=fs.lstatSync(socket);assert.equal(socketStat.isSocket(),true);assert.equal(socketStat.mode & 0o777,0o660);assert.equal(socketStat.gid,gid);
 const parentStat=fs.lstatSync(dir);assert.equal(parentStat.mode & 0o777,0o710);
 const list=await call("/mcp/looping");assert.equal(list.status,200,list.body.slice(0,300));
 const data=list.body.split("\n").find(x=>x.startsWith("data: "))?.slice(6)??list.body;
 const tools=JSON.parse(data).result.tools;
 assert.equal(tools.length,26);assert.ok(tools.every(x=>/^(read_|write)\.engine\./.test(x.name)));
 const executed=await call("/mcp/looping","POST",{jsonrpc:"2.0",id:7,method:"tools/call",params:{name:"read_.engine.worker.status",arguments:{}}});
 assert.equal(executed.status,200,executed.body.slice(0,300));
 const executionData=executed.body.split("\n").find(x=>x.startsWith("data: "))?.slice(6)??executed.body;
 assert.ok(JSON.parse(executionData).result,"Looping tools/call must return result");
 assert.notEqual(JSON.parse(executionData).result.isError,true,"Looping read-only tool returned an error");
 for(const route of ["/mcp","/mcp/network","/mcp/transport","/.well-known/oauth-protected-resource"])assert.equal((await call(route)).status,404,route);
 assert.equal((await call("/mcp/looping","GET")).status,404);
 const tcp=await new Promise((resolve,reject)=>{const r=http.request({hostname:"127.0.0.1",port,path:"/mcp/looping",method:"POST"},res=>{res.resume();res.on("end",()=>resolve(res.statusCode))});r.on("error",reject);r.end("{}")});
 assert.equal(tcp,401);
 console.log("F30_SOCKET_ACCEPTANCE_PASS 26_tools tools_call=PASS isolation=PASS acl=0710/0660 tcp_oauth=PASS");
}finally{child?.kill("SIGTERM");await new Promise(r=>setTimeout(r,200));fs.rmSync(tmp,{recursive:true,force:true})}
