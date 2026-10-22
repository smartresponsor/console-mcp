import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { classifyCommandFailure } from "./infrastructure-failure-contract.js";

// Standalone Windows draft. Neither exported through registration nor production admission.
const local=z.object({targetId:z.literal("local")}).strict();
export const windowsMemoryInput=local;
export const windowsCpuInput=local;
export const windowsInterfacesInput=local;
export const windowsRoutesInput=local;
export const windowsServicesInput=local.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
export const windowsProcessInput=local.extend({pid:z.number().int().min(1).max(4294967295)}).strict();
export const windowsServiceInput=local.extend({serviceId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/)}).strict();
type Status="complete"|"partial"|"unsupported"|"unavailable"|"permission_denied"|"timeout"|"no_data";
type Observation={ok:boolean;status:Status;targetId:"local";vantage:"local";technology:"windows";source:string;collectedAt:string;data:Record<string,unknown>;warnings:string[];truncated:boolean};
const output=(source:string,data:Record<string,unknown>,status:Status="complete",truncated=false):Observation=>({
 ok:status==="complete"||status==="partial",status,targetId:"local",vantage:"local",technology:"windows",source,collectedAt:new Date().toISOString(),data,warnings:[],truncated
});
export function parsePsJson(stdout:string):unknown {
 try {const v:unknown=JSON.parse(stdout);return v===null?null:v;}catch{return null;}
}
function objects(v:unknown):Record<string,unknown>[]{
 return (Array.isArray(v)?v:[v]).filter((x):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x));
}
const scripts={
 memory:"Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json -Compress",
 cpu:"Get-CimInstance Win32_Processor | Select-Object DeviceID,NumberOfLogicalProcessors,LoadPercentage | ConvertTo-Json -Compress",
 interfaces:"Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress,PrefixLength,AddressState | ConvertTo-Json -Compress",
 routes:"Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,PolicyStore | ConvertTo-Json -Compress",
 services:"Get-Service | Select-Object Name,Status,StartType | ConvertTo-Json -Compress",
} as const;
type ScriptName=keyof typeof scripts;
async function execute(source:string,script:string):Promise<{value:unknown}|{error:Observation}>{
 if(process.platform!=="win32")return {error:output(source,{},"unsupported")};
 const encoded=Buffer.from(script,"utf16le").toString("base64");
 const r=await runSupervisedCommand(process.cwd(),"powershell.exe",
  ["-NoProfile","-NonInteractive","-EncodedCommand",encoded],10000,131072);
 if(!r.ok)return {error:output(source,{},classifyCommandFailure(r).status)};
 const value=parsePsJson(r.stdout);
 return value===null?{error:output(source,{},"unavailable")}:{value};
}
async function named(name:ScriptName):Promise<Observation>{
 const source=`powershell:${name}`,r=await execute(source,scripts[name]);
 if("error" in r)return r.error;
 const records=objects(r.value),limit=100,truncated=records.length>limit;
 // No command lines, environment values, credentials, or raw PowerShell messages.
 return output(source,{records:records.slice(0,limit),total:records.length},truncated?"partial":"complete",truncated);
}
export async function inspectWindowsMemory(input:unknown):Promise<Observation>{
 windowsMemoryInput.parse(input);return named("memory");
}
export async function inspectWindowsCpu(input:unknown):Promise<Observation>{
 windowsCpuInput.parse(input);return named("cpu");
}
export async function listWindowsIpv4Interfaces(input:unknown):Promise<Observation>{
 windowsInterfacesInput.parse(input);return named("interfaces");
}
export async function listWindowsIpv4Routes(input:unknown):Promise<Observation>{
 windowsRoutesInput.parse(input);return named("routes");
}
export async function listWindowsServices(input:unknown):Promise<Observation>{
 const p=windowsServicesInput.parse(input),source="powershell:services",r=await execute(source,scripts.services);
 if("error" in r)return r.error;
 const records=objects(r.value),truncated=records.length>p.limit;
 return output(source,{services:records.slice(0,p.limit),total:records.length},truncated?"partial":"complete",truncated);
}
export async function inspectWindowsProcess(input:unknown):Promise<Observation>{
 const p=windowsProcessInput.parse(input),source="powershell:process";
 const script=`Get-CimInstance Win32_Process -Filter "ProcessId = ${p.pid}" | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CreationDate | ConvertTo-Json -Compress`;
 const r=await execute(source,script);
 if("error" in r)return r.error;
 const records=objects(r.value);
 return records.length?output(source,{process:records[0]}):output(source,{},"unavailable");
}
export async function inspectWindowsService(input:unknown):Promise<Observation>{
 const p=windowsServiceInput.parse(input),source="powershell:service";
 const script=`Get-Service -Name '${p.serviceId}' -ErrorAction Stop | Select-Object Name,Status,StartType | ConvertTo-Json -Compress`;
 const r=await execute(source,script);
 if("error" in r)return r.error;
 const records=objects(r.value);
 return records.length?output(source,{service:records[0]}):output(source,{},"unavailable");
}

export const windowsProcessesInput=local.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
export async function listWindowsProcesses(input:unknown):Promise<Observation>{
 const p=windowsProcessesInput.parse(input),source="powershell:processes";
 const script="Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress";
 const r=await execute(source,script);
 if("error" in r)return r.error;
 const records=objects(r.value),truncated=records.length>p.limit;
 return output(source,{records:records.slice(0,p.limit),total:records.length},truncated?"partial":"complete",truncated);
}
