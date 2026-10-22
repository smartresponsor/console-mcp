import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

// Feature-only Linux collectors. Deliberately no MCP registration.
const local = z.object({targetId:z.literal("local")}).strict();
export const interfaceInput=local;
export const neighborInput=local;
export const dnsResolverInput=local;
export const udpSocketsInput=local.extend({port:z.number().int().min(1).max(65535).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();

type Result = {ok:boolean;status:"complete"|"partial"|"unavailable"|"unsupported";source:string;targetId:"local";collectedAt:string;data:Record<string,unknown>;truncated:boolean;warnings:string[]};
function result(source:string,data:Record<string,unknown>,status:Result["status"]="complete",truncated=false):Result{
  return {ok:status==="complete"||status==="partial",status,source,targetId:"local",collectedAt:new Date().toISOString(),data,truncated,warnings:status==="unavailable"?["source unavailable"]:status==="unsupported"?["unsupported platform"]:[]};
}
async function run(exe:string,args:string[],source:string,max=65536):Promise<{stdout:string}|{error:Result}>{
  if(process.platform!=="linux")return {error:result(source,{},"unsupported")};
  const r=await runSupervisedCommand(process.cwd(),exe,args,10000,max);
  return r.ok?{stdout:r.stdout}:{error:result(source,{},"unavailable")};
}
export function parseInterfaces(input:unknown){
  if(!Array.isArray(input))return [];
  return input.filter((v):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)).map(v=>({
    name:typeof v.ifname==="string"?v.ifname:null,index:typeof v.ifindex==="number"?v.ifindex:null,
    state:typeof v.operstate==="string"?v.operstate:null,
    mtu:typeof v.mtu==="number"?v.mtu:null,
    addresses:Array.isArray(v.addr_info)?v.addr_info.filter((a):a is Record<string,unknown>=>!!a&&typeof a==="object"&&!Array.isArray(a))
      .filter(a=>a.family==="inet").map(a=>({address:a.local??null,prefixLength:a.prefixlen??null})):[]
  }));
}
export async function listIpv4Interfaces(input:unknown):Promise<Result>{
  interfaceInput.parse(input);const source="ip -j -4 addr show";const r=await run("ip",["-j","-4","addr","show"],source);
  if("error" in r)return r.error;
  try{const records=parseInterfaces(JSON.parse(r.stdout));return result(source,{interfaces:records.slice(0,100),total:records.length},records.length>100?"partial":"complete",records.length>100)}
  catch{return result(source,{},"unavailable")}
}
export function parseNeighbors(input:unknown){
  if(!Array.isArray(input))return [];
  return input.filter((v):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)).map(v=>({
    address:typeof v.dst==="string"?v.dst:null,interface:typeof v.dev==="string"?v.dev:null,
    mac:typeof v.lladdr==="string"?v.lladdr:null,state:typeof v.state==="string"?v.state:null
  }));
}
export async function listIpv4Neighbors(input:unknown):Promise<Result>{
  neighborInput.parse(input);const source="ip -j -4 neigh show";const r=await run("ip",["-j","-4","neigh","show"],source);
  if("error" in r)return r.error;
  try{const records=parseNeighbors(JSON.parse(r.stdout));return result(source,{neighbors:records.slice(0,200),total:records.length},records.length>200?"partial":"complete",records.length>200)}
  catch{return result(source,{},"unavailable")}
}
export function parseUdpSockets(stdout:string,port?:number){
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line=>{
    const fields=line.trim().split(/\s+/);
    if(fields.length<5||fields[0]!=="UNCONN")return [];
    const m=fields[4].match(/:(\d+)$/);if(!m)return [];
    const p=Number(m[1]);if(!Number.isInteger(p)||p<1||p>65535||(port!==undefined&&p!==port))return [];
    return [{address:fields[3].slice(0,-m[0].length),port:p,state:fields[0]}];
  });
}
export async function listUdpSockets(input:unknown):Promise<Result>{
  const p=udpSocketsInput.parse(input);const source="ss -H -lun";
  const r=await run("ss",["-H","-lun"],source,256*1024);if("error" in r)return r.error;
  const sockets=parseUdpSockets(r.stdout,p.port);
  return result(source,{sockets:sockets.slice(0,p.limit),total:sockets.length},sockets.length>p.limit?"partial":"complete",sockets.length>p.limit);
}
export function parseResolverStatus(stdout:string){
  const servers:string[]=[];const domains:string[]=[];
  for(const line of stdout.split(/\r?\n/)){
    let m=line.match(/^\s*(?:Current DNS Server|DNS Servers):\s*(.+)$/);
    if(m){for(const address of m[1].trim().split(/\s+/))if(/^[a-fA-F\d:.]+$/.test(address))servers.push(address);}
    m=line.match(/^\s*DNS Domain:\s*(.+)$/);
    if(m)domains.push(...m[1].trim().split(/\s+/).slice(0,12));
  }
  return {servers:[...new Set(servers)].slice(0,32),domains:[...new Set(domains)].slice(0,32)};
}
export async function inspectDnsResolver(input:unknown):Promise<Result>{
  dnsResolverInput.parse(input);const source="resolvectl status";
  const r=await run("resolvectl",["status","--no-pager"],source);
  if("error" in r)return r.error;
  return result(source,{resolver:parseResolverStatus(r.stdout)});
}
