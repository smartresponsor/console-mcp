import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { RELEASE_TRANSACTION_FACADE_TOOL_NAMES, RELEASE_LIFECYCLE_CANDIDATE_NAMES } from "../dist/engine/release-transaction-facade-tools.js";
const base = [...RELEASE_TRANSACTION_FACADE_TOOL_NAMES].sort();
const extended = [...RELEASE_TRANSACTION_FACADE_TOOL_NAMES, ...RELEASE_LIFECYCLE_CANDIDATE_NAMES].sort();
assert.equal(base.length, 5); assert.equal(extended.length, 10);
const dir = await mkdtemp(path.join(os.tmpdir(), "stage06-release-"));
async function port() { for(let i=0;i<100;i++){const value=49152+crypto.randomInt(16384);const h=http.createServer();try{await new Promise((resolve,reject)=>{h.once("error",reject);h.listen(value,"127.0.0.1",resolve);});await new Promise(r=>h.close(r));return value;}catch(e){h.close();if(e.code!=="EADDRINUSE")throw e;}}throw Error("No high loopback port"); }
const jwksPort=await port(),serverPort=await port();
const issuer=`http://127.0.0.1:${jwksPort}/`; const audience=`http://127.0.0.1:${serverPort}`;
const {publicKey,privateKey}=await generateKeyPair("RS256");
const jwk=await exportJWK(publicKey);jwk.kid="stage06";jwk.use="sig";jwk.alg="RS256";
const jwks=http.createServer((req,res)=>{if(req.url==="/jwks"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({keys:[jwk]}));return;}res.writeHead(404);res.end();});
await new Promise(r=>jwks.listen(jwksPort,"127.0.0.1",r));
const token=await new SignJWT({scope:"console:read console:write"}).setProtectedHeader({alg:"RS256",kid:"stage06"}).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
async function rpc(route,method,id,args){const response=await fetch(`${audience}${route}`,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:"2.0",id,method,...(args?{params:args}:{})})});const txt=await response.text();const data=txt.split("\n").find(x=>x.startsWith("data: "))?.slice(6)??txt;return {status:response.status,body:JSON.parse(data)};}
async function launch(extendedFlag,cutoverFlag){
 const child=spawn(process.execPath,["dist/index.js"],{cwd:process.cwd(),env:{...process.env,CONSOLE_MCP_MANAGED_RUNTIME:"smoke-test",CONSOLE_MCP_RELEASE_PROBE:"1",CONSOLE_MCP_AUTH_MODE:"oauth",CONSOLE_MCP_HOST:"127.0.0.1",CONSOLE_MCP_PORT:String(serverPort),CONSOLE_MCP_PUBLIC_ORIGIN:audience,CONSOLE_MCP_OAUTH_ISSUER:issuer,CONSOLE_MCP_OAUTH_AUDIENCE:audience,CONSOLE_MCP_OAUTH_JWKS_URI:`${issuer}jwks`,CONSOLE_MCP_OAUTH_REQUIRED_SCOPE:"console:read",CONSOLE_MCP_TRANSCRIPT_DIR:dir,CONSOLE_MCP_RELEASE_TRANSACTION_FACADE_ENABLED:"1",CONSOLE_MCP_RELEASE_FACADE_EXTENDED:String(Number(extendedFlag)),CONSOLE_MCP_RELEASE_EXTENDED_MAIN_CUTOVER:String(Number(cutoverFlag))},stdio:["ignore","pipe","pipe"]});
 let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);const end=Date.now()+18000;while(!output.includes("listening on")){if(child.exitCode!==null||Date.now()>end)throw Error("startup failed "+output);await new Promise(r=>setTimeout(r,80));}return child;
}
async function stop(child){child.kill("SIGTERM");await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once("exit",r);setTimeout(r,3000);});}
let child;
try{
 for(const mode of [{extension:false,cutover:false,count:259},{extension:true,cutover:false,count:259},{extension:true,cutover:true,count:254}]){
  child=await launch(mode.extension,mode.cutover);
  const release=await rpc("/release/mcp","tools/list",10);assert.equal(release.status,200);
  const listed=release.body.result.tools;
  assert.deepEqual(listed.map(x=>x.name).sort(),mode.extension?extended:base);
  const main=await rpc("/mcp","tools/list",11);assert.equal(main.status,200);
  assert.equal(main.body.result.tools.length,mode.count,`main count mismatch ${JSON.stringify(mode)}`);
  const names=new Set(main.body.result.tools.map(x=>x.name));
  for(const name of RELEASE_LIFECYCLE_CANDIDATE_NAMES){
    assert.equal(names.has(name),!mode.cutover,`unexpected candidate ownership ${name}`);
    if(mode.cutover){const denied=await rpc("/mcp","tools/call",12,{name,arguments:{}});assert.equal(denied.status,200);assert.ok(denied.body.error||denied.body.result?.isError,`Main executed ${name}`);}
  }
  const read=await rpc("/release/mcp","tools/call",14,{name:mode.extension?"read_.release.runtime.status":"read_.release.transaction.status",arguments:{}});
  assert.equal(read.status,200);assert.ok(read.body.result||read.body.error);
  for(const name of RELEASE_TRANSACTION_FACADE_TOOL_NAMES)assert.equal(names.has(name),false,`transaction leaked ${name}`);
  const fp=crypto.createHash("sha256").update(JSON.stringify(listed.map(x=>({name:x.name,description:x.description,inputSchema:x.inputSchema})).sort((a,b)=>a.name.localeCompare(b.name)))).digest("hex").slice(0,16);
  console.log(JSON.stringify({status:"STAGE06_MODE_PASS",...mode,facadeTools:listed.length,mainTools:names.size,facadeSchemaFingerprint:fp}));
  await stop(child);child=null;
 }
 console.log("STAGE06_EXTENDED_RELEASE_HTTP_PASS");
} finally {if(child)await stop(child);await new Promise(r=>jwks.close(r));await rm(dir,{recursive:true,force:true});}
