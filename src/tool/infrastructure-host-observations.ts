import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { classifyCommandFailure } from "./infrastructure-failure-contract.js";

// Draft collectors only: no registry, catalog, or runtime admission yet.
const local=z.object({targetId:z.literal("local")}).strict();
export const firewallInput=local;
export const tcpConnectionsInput=local.extend({limit:z.number().int().min(1).max(100).default(50),port:z.number().int().min(1).max(65535).optional()}).strict();
export const cpuLoadInput=local;
export const diskIoInput=local;
export const servicesListInput=local.extend({limit:z.number().int().min(1).max(100).default(50)}).strict();
type Status="complete"|"partial"|"unavailable"|"unsupported"|"permission_denied"|"timeout"|"no_data";
type Observation={ok:boolean;status:Status;source:string;targetId:"local";vantage:"local";collectedAt:string;data:Record<string,unknown>;warnings:string[];truncated:boolean};
function result(source:string,data:Record<string,unknown>,status:Status="complete",truncated=false):Observation {
 return {ok:status==="complete"||status==="partial",status,source,targetId:"local",vantage:"local",collectedAt:new Date().toISOString(),data,warnings:[],truncated};
}
async function read(exe:string,args:string[],source:string,maxBytes=131072):Promise<{stdout:string}|{failure:Observation}> {
 if(process.platform!=="linux")return {failure:result(source,{},"unsupported")};
 const x=await runSupervisedCommand(process.cwd(),exe,args,10000,maxBytes);
 return x.ok?{stdout:x.stdout}:{failure:result(source,{},classifyCommandFailure(x).status)};
}
export function parseTcpConnections(stdout:string,filterPort?:number){
 return stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{
  const f=line.trim().split(/\s+/);if(f.length<5||!["ESTAB","SYN-SENT","SYN-RECV","FIN-WAIT-1","FIN-WAIT-2","TIME-WAIT","CLOSE-WAIT","LAST-ACK","CLOSING"].includes(f[0]))return [];
  const local=f[3].match(/:(\d+)$/),remote=f[4].match(/:(\d+)$/);
  if(!local||!remote)return [];const lp=Number(local[1]),rp=Number(remote[1]);
  if(lp<1||lp>65535||rp<1||rp>65535||(filterPort!==undefined&&filterPort!==lp&&filterPort!==rp))return [];
  return [{state:f[0],localAddress:f[3].slice(0,-local[0].length),localPort:lp,remoteAddress:f[4].slice(0,-remote[0].length),remotePort:rp}];
 });
}
export async function listTcpConnections(input:unknown):Promise<Observation>{
 const p=tcpConnectionsInput.parse(input),source="ss -H -tn";
 const r=await read("ss",["-H","-tn"],source,262144);if("failure" in r)return r.failure;
 const rows=parseTcpConnections(r.stdout,p.port),cut=rows.length>p.limit;
 return result(source,{connections:rows.slice(0,p.limit),total:rows.length},cut?"partial":"complete",cut);
}
export function parseCpuLoad(stdout:string){
 const m=stdout.trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)\s+(\d+)$/);
 return m?{load1:Number(m[1]),load5:Number(m[2]),load15:Number(m[3]),running:Number(m[4]),tasks:Number(m[5])}:null;
}
export async function inspectCpuLoad(input:unknown):Promise<Observation>{
 cpuLoadInput.parse(input);const source="/proc/loadavg",r=await read("cat",["/proc/loadavg"],source);
 if("failure" in r)return r.failure;const load=parseCpuLoad(r.stdout);
 return load?result(source,{load}):result(source,{},"unavailable");
}
export function parseDiskStats(stdout:string){
 return stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{
  const f=line.trim().split(/\s+/);
  if(f.length<14||!f.slice(0,3).every((s,i)=>i===2?s.length>0:/^\d+$/.test(s)))return [];
  const nums=f.slice(3,14).map(Number);
  if(!nums.every(n=>Number.isSafeInteger(n)&&n>=0))return [];
  return [{major:Number(f[0]),minor:Number(f[1]),device:f[2],readsCompleted:nums[0],sectorsRead:nums[2],
   writesCompleted:nums[4],sectorsWritten:nums[6],ioMilliseconds:nums[9]}];
 });
}
export async function inspectDiskIo(input:unknown):Promise<Observation>{
 diskIoInput.parse(input);const source="/proc/diskstats",r=await read("cat",["/proc/diskstats"],source);
 if("failure" in r)return r.failure;const disks=parseDiskStats(r.stdout),cut=disks.length>100;
 return result(source,{disks:disks.slice(0,100),total:disks.length},cut?"partial":"complete",cut);
}
export function parseServiceList(stdout:string){
 return stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{
  const f=line.trim().split(/\s+/);
  if(f.length<4||!f[0].endsWith(".service")||!["loaded","not-found","masked","error"].includes(f[1]))return [];
  return [{unit:f[0],load:f[1],active:f[2],sub:f[3]}];
 });
}
export async function listServices(input:unknown):Promise<Observation>{
 const p=servicesListInput.parse(input),source="systemctl list-units";
 const r=await read("systemctl",["list-units","--type=service","--all","--plain","--no-legend","--no-pager"],source,262144);
 if("failure" in r)return r.failure;const services=parseServiceList(r.stdout),cut=services.length>p.limit;
 return result(source,{services:services.slice(0,p.limit),total:services.length},cut?"partial":"complete",cut);
}
// Firewall v1 intentionally reveals only the nftables chain inventory, not rules,
// counters, sets, interface mappings, or potentially sensitive match values.
export function parseFirewallChains(stdout:string){
 const found=new Set<string>();
 for(const line of stdout.split(/\r?\n/)){
  const m=line.match(/^\s*chain\s+([a-zA-Z_][a-zA-Z_0-9.-]{0,63})\s*\{/);
  if(m)found.add(m[1]);
 }
 return [...found].slice(0,100);
}
export async function inspectFirewall(input:unknown):Promise<Observation>{
 firewallInput.parse(input);const source="nft list ruleset (chain names only)";
 const r=await read("nft",["-a","list","ruleset"],source,262144);
 if("failure" in r)return r.failure;
 const chains=parseFirewallChains(r.stdout);
 return result(source,{chains,chainCount:chains.length});
}
