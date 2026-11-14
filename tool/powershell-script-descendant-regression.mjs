import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPowerShellScriptTool } from "../dist/tool/powershell-script.js";
const root=await mkdtemp(path.join(os.tmpdir(),"powershell-script-descendant-"));
const toolDir=path.join(root,"tool");
await mkdir(toolDir,{recursive:true});
const childJs=path.join(toolDir,"child.cjs");
await writeFile(childJs, `const fs=require("node:fs");fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);\n`);
await writeFile(path.join(toolDir,"child.ps1"),`& node (Join-Path $PSScriptRoot "child.cjs") (Join-Path $PSScriptRoot "child.pid")\n`);
const server=new McpServer({name:"descendant-regression",version:"1.0.0"});
registerPowerShellScriptTool(server,{allowedRoots:[root]},{mode:"bearer",bearerTokens:["test-only"]});
const client=new Client({name:"descendant-regression-client",version:"1.0.0"});
const [ct,st]=InMemoryTransport.createLinkedPair();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const call=async (name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(result.structuredContent,`No structured result from ${name}`);return result.structuredContent};
const status=id=>call("read_.repo.powershell.script.status",{workspacePath:root,runId:id});
const childAlive=pid=>{
  try { process.kill(pid,0); } catch(e) {if(e.code==="ESRCH")return false;if(e.code!=="EPERM")throw e; }
  if(process.platform==="linux"){try{const stat=readFileSync(`/proc/${pid}/stat`,"utf8");if(/^\S+\s+\(.+\)\s+[ZX]/.test(stat))return false;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
  return true;
};
const readChildPid=async()=>{for(let n=0;n<80;n++){try{const p=Number((await readFile(path.join(toolDir,"child.pid"),"utf8")).trim());if(p>0)return p;}catch(e){if(e.code!=="ENOENT")throw e;}await wait(100);}throw Error("Child PID not written")};
const awaitChildExit=async pid=>{for(let n=0;n<60;n++){if(!childAlive(pid))return;await wait(100);}throw Error(`Descendant still alive pid=${pid}`)};
const pollTerminal=async id=>{for(let n=0;n<100;n++){const x=await status(id);if(["succeeded","failed","stopped","timed_out"].includes(x.status))return x;await wait(100);}throw Error("No terminal status")};
let active=null, childPid=null;
try {
 await server.connect(st);await client.connect(ct);
 for(const mode of ["stop","timeout"]){
   const run=await call("write.repo.powershell.script.start",{workspacePath:root,scriptPath:"tool/child.ps1",executable:"pwsh",confirmRun:true,timeoutMs:mode==="stop"?20000:2500});
   assert.equal(run.ok,true,JSON.stringify(run));active=run.run_id;
   childPid=await readChildPid();assert.ok(childAlive(childPid),`Child should run: ${childPid}`);
   if(mode==="stop"){const stop=await call("write.repo.powershell.script.stop",{workspacePath:root,runId:active,confirmStop:true});assert.equal(stop.status,"stopped",JSON.stringify(stop));}
   const terminal=await pollTerminal(active);assert.equal(terminal.status,mode==="stop"?"stopped":"timed_out",JSON.stringify(terminal));
   await awaitChildExit(childPid);
   console.log(`DESCENDANT_${mode.toUpperCase()}_CLEANUP_PASS ${process.platform}`);
   active=null;childPid=null;
   if(mode==="stop"){await rm(path.join(toolDir,"child.pid"));}
 }
 console.log("M2_PR202_DESCENDANT_CLEANUP_PASS");
} finally {
 if(active){try{await call("write.repo.powershell.script.stop",{workspacePath:root,runId:active,confirmStop:true})}catch{}}
 if(childPid&&childAlive(childPid)){try{process.kill(childPid,"SIGKILL")}catch{}}
 await client.close().catch(()=>{});await server.close().catch(()=>{});await rm(root,{recursive:true,force:true});
}
