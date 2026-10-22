import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { classifyCommandFailure } from "./infrastructure-failure-contract.js";
import { decodeRecords } from "./infrastructure-windows-network.js";

// Read-only Windows supplements. Do not register or admit independently.
const local=z.object({targetId:z.literal("local")}).strict();
export const windowsNeighborInput=local;
export const windowsStorageInput=local;
export const windowsFirewallPolicyInput=local;
type Status="complete"|"partial"|"unavailable"|"unsupported"|"permission_denied"|"timeout"|"no_data";
type Observation={ok:boolean;status:Status;source:string;targetId:"local";data:Record<string,unknown>;warnings:string[];truncated:boolean};
function out(source:string,data:Record<string,unknown>,status:Status="complete",truncated=false,warnings:string[]=[]):Observation{
 return {ok:status==="complete"||status==="partial",status,source,targetId:"local",data,warnings,truncated};
}
const commands={
 neighbor:"Get-NetNeighbor -AddressFamily IPv4 | Select-Object IPAddress,LinkLayerAddress,InterfaceAlias,State | ConvertTo-Json -Compress -Depth 3",
 storage:"Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | Select-Object Name,DiskReadsPerSec,DiskWritesPerSec,DiskReadBytesPerSec,DiskWriteBytesPerSec,Timestamp_PerfTime,Frequency_PerfTime | ConvertTo-Json -Compress -Depth 3",
 firewall:"Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress -Depth 3"
} as const;
async function collect(name:keyof typeof commands):Promise<Observation>{
 const source="powershell:"+name;
 if(process.platform!=="win32")return out(source,{},"unsupported");
 const encoded=Buffer.from(commands[name],"utf16le").toString("base64");
 const result=await runSupervisedCommand(process.cwd(),"powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],10000,131072);
 if(!result.ok){const failure=classifyCommandFailure(result);return out(source,{},failure.status,false,[failure.warning]);}
 const records=decodeRecords(result.stdout);
 if(records===null)return out(source,{},"unavailable",false,["invalid provider response"]);
 const cap=100,truncated=records.length>cap;
 return out(source,{records:records.slice(0,cap),total:records.length},truncated?"partial":"complete",truncated);
}
export async function listWindowsIpv4Neighbors(input:unknown){windowsNeighborInput.parse(input);return collect("neighbor");}
export async function inspectWindowsStorageIo(input:unknown){windowsStorageInput.parse(input);return collect("storage");}
export async function inspectWindowsFirewallPolicy(input:unknown){windowsFirewallPolicyInput.parse(input);return collect("firewall");}
