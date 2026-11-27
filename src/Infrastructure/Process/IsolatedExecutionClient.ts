import { createConnection } from "node:net";
import { lstatSync, realpathSync } from "node:fs";
import { managedExecutionRouting } from "./ManagedExecutionAdmission.js";
export type IsolatedKind = "gate-check" | "powershell";
const socketPath="/run/eng16-executor/broker.sock";
export function useIsolatedExecution(workspace:string):boolean {
  return managedExecutionRouting(workspace) && process.env.CONSOLE_MCP_ISOLATED_EXECUTOR==="1";
}
function assertEndpoint():void {
  for(const p of ["/run","/run/eng16-executor",socketPath]){
    const s=lstatSync(p);
    if(s.uid!==0 || realpathSync(p)!==p || (p===socketPath ? !s.isSocket() || (s.mode&0o007)!==0 : !s.isDirectory() || (s.mode&0o022)!==0)) throw new Error("ISOLATED_BROKER_ENDPOINT_UNSAFE");
  }
}
export async function requestIsolatedExecution(request:Record<string,unknown>):Promise<Record<string,unknown>> {
  assertEndpoint();
  return exchange(socketPath,request);
}
/** Testable wire protocol; production path is fixed and checked above. */
export function exchange(endpoint:string,request:Record<string,unknown>):Promise<Record<string,unknown>> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(endpoint);
    let buffer=Buffer.alloc(0),settled=false;
    function finish(error?:Error,value?:Record<string,unknown>){
      if(settled)return;settled=true;socket.destroy();if(error)reject(error);else resolve(value!);
    }
    socket.setTimeout(60000,()=>finish(new Error("ISOLATED_BROKER_AMBIGUOUS_RECONCILE")));
    socket.on("error",()=>finish(new Error("ISOLATED_BROKER_UNAVAILABLE_OR_AMBIGUOUS")));
    socket.on("connect",()=>socket.write(JSON.stringify(request)+"\n"));
    socket.on("data",chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length>65536)return finish(new Error("ISOLATED_BROKER_RESPONSE_LIMIT"));
      const end=buffer.indexOf(10);if(end<0)return;
      try {
        const r=JSON.parse(buffer.subarray(0,end).toString("utf8"));
        if(!r || typeof r!=="object" || r.applyAllowed!==false || typeof r.status!=="string" ||
           (r.run_id!==undefined && r.run_id!==request.runId) || (r.ok===true && r.run_id!==request.runId))throw new Error("ISOLATED_BROKER_RESPONSE_INVALID");
        finish(undefined,r);
      }catch{finish(new Error("ISOLATED_BROKER_RESPONSE_INVALID"));}
    });
    socket.on("end",()=>finish(new Error("ISOLATED_BROKER_AMBIGUOUS_RECONCILE")));
  });
}
export async function startIsolatedExecution(workspacePath:string,kind:IsolatedKind,operation:string,timeoutMs:number,approvalId?:string){
  if(!approvalId)throw new Error("ISOLATED_EXECUTION_APPROVAL_REQUIRED");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error("ISOLATED_EXECUTION_TIMEOUT_UNADMITTED");
  return requestIsolatedExecution({op:"start",runId:approvalId,workspacePath,kind,operation,timeoutMs});
}
export function isolatedLifecycle(op:"status"|"output"|"cancel",workspacePath:string,kind:IsolatedKind,runId:string){
  return requestIsolatedExecution({op,workspacePath,kind,runId});
}
