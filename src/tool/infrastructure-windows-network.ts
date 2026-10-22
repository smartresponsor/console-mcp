import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

// Windows-only passive observation layer, not registered with MCP yet.
const local=z.object({targetId:z.literal("local")}).strict();
const ports=local.extend({port:z.number().int().min(1).max(65535).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const winTcpListenersInput=ports,winTcpConnectionsInput=ports,winUdpSocketsInput=ports;
export const winDnsInput=local,winFirewallInput=local.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
type Status="complete"|"partial"|"unsupported"|"unavailable";
type Observation={ok:boolean;status:Status;targetId:"local";vantage:"local";technology:"windows";collectedAt:string;source:string;data:Record<string,unknown>;warnings:string[];truncated:boolean};
function observation(source:string,data:Record<string,unknown>,status:Status="complete",truncated=false):Observation{
 return {ok:status==="complete"||status==="partial",status,targetId:"local",vantage:"local",technology:"windows",collectedAt:new Date().toISOString(),source,data,warnings:[],truncated};
}
export function decodeRecords(stdout:string):Record<string,unknown>[]|null{
 let value:unknown;
 try{value=JSON.parse(stdout);}catch{return null;}
 if(value===null)return [];
 const list=Array.isArray(value)?value:[value];
 return list.every(v=>!!v&&typeof v==="object"&&!Array.isArray(v))?list as Record<string,unknown>[]:null;
}
async function invoke(script:string,source:string):Promise<{records:Record<string,unknown>[]} | {error:Observation}>{
 if(process.platform!=="win32")return {error:observation(source,{},"unsupported")};
 const encoded=Buffer.from(script,"utf16le").toString("base64");
 const r=await runSupervisedCommand(process.cwd(),"powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],10000,262144);
 if(!r.ok)return {error:observation(source,{},"unavailable")};
 const records=decodeRecords(r.stdout);
 return records===null?{error:observation(source,{},"unavailable")}:{records};
}
const script={
 tcpListeners:"Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,State,OwningProcess | ConvertTo-Json -Compress -Depth 3",
 tcpConnections:"Get-NetTCPConnection | Where-Object State -ne Listen | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress -Depth 3",
 udpSockets:"Get-NetUDPEndpoint | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress -Depth 3",
 dns:"Get-DnsClientServerAddress | Select-Object InterfaceAlias,AddressFamily,ServerAddresses | ConvertTo-Json -Compress -Depth 3",
 firewall:"Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress -Depth 3"
} as const;
export function restrictPorts(rows:Record<string,unknown>[],port?:number){
 return rows.filter(row=>{
  const lp=row.LocalPort,rp=row.RemotePort;
  return port===undefined||(typeof lp==="number"&&lp===port)||(typeof rp==="number"&&rp===port);
 });
}
function pick(row:Record<string,unknown>,keys:string[]):Record<string,unknown>{
 const result:Record<string,unknown>={};
 for(const key of keys)if(Object.hasOwn(row,key))result[key]=row[key];
 return result;
}
async function sockets(kind:"tcpListeners"|"tcpConnections"|"udpSockets",input:unknown):Promise<Observation>{
 const params=ports.parse(input),source="powershell:"+kind,r=await invoke(script[kind],source);
 if("error" in r)return r.error;
 const safeKeys=kind==="tcpConnections"?["LocalAddress","LocalPort","RemoteAddress","RemotePort","State","OwningProcess"]:["LocalAddress","LocalPort","State","OwningProcess"];
 const rows=restrictPorts(r.records,params.port).map(row=>pick(row,safeKeys));
 const truncated=rows.length>params.limit;
 return observation(source,{sockets:rows.slice(0,params.limit),total:rows.length},truncated?"partial":"complete",truncated);
}
export async function listWindowsTcpListeners(input:unknown){winTcpListenersInput.parse(input);return sockets("tcpListeners",input);}
export async function listWindowsTcpConnections(input:unknown){winTcpConnectionsInput.parse(input);return sockets("tcpConnections",input);}
export async function listWindowsUdpSockets(input:unknown){winUdpSocketsInput.parse(input);return sockets("udpSockets",input);}
export async function inspectWindowsDns(input:unknown):Promise<Observation>{
 winDnsInput.parse(input);const source="powershell:dns",r=await invoke(script.dns,source);
 if("error" in r)return r.error;
 const interfaces=r.records.map(v=>pick(v,["InterfaceAlias","AddressFamily","ServerAddresses"])).slice(0,100);
 return observation(source,{interfaces},r.records.length>100?"partial":"complete",r.records.length>100);
}
export async function inspectWindowsFirewall(input:unknown):Promise<Observation>{
 const p=winFirewallInput.parse(input),source="powershell:firewall-profile",r=await invoke(script.firewall,source);
 if("error" in r)return r.error;
 const profiles=r.records.map(v=>pick(v,["Name","Enabled","DefaultInboundAction","DefaultOutboundAction"]));
 return observation(source,{profiles:profiles.slice(0,p.limit),total:profiles.length,ruleCoverage:false},profiles.length>p.limit?"partial":"complete",profiles.length>p.limit);
}
