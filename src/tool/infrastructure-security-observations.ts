import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

// Draft passive, local-only collectors. No public MCP admission in this slice.
const local = z.object({ targetId: z.literal("local") }).strict();
export const fdListInput = local.extend({ pid: z.number().int().min(1).max(4194304), limit: z.number().int().min(1).max(100).default(50) }).strict();
export const firewallPolicyInput = local;
export const oomRecordsInput = local.extend({ minutes: z.number().int().min(1).max(60).default(15), limit: z.number().int().min(1).max(50).default(20) }).strict();
// Source-scoped opaque cursor: caller cannot pass arbitrary journalctl arguments.
export const journalDetailInput = local.extend({ cursor: z.string().min(8).max(512).regex(/^[A-Za-z0-9_.;=:-]+$/) }).strict();
type Status = "complete" | "partial" | "unavailable" | "unsupported";
type Result = {ok:boolean; status:Status; targetId:"local"; vantage:"local"; source:string; collectedAt:string; data:Record<string,unknown>; warnings:string[]; truncated:boolean};
const reply=(source:string,data:Record<string,unknown>,status:Status="complete",truncated=false):Result=>({
 ok:status==="complete"||status==="partial",status,targetId:"local",vantage:"local",source,
 collectedAt:new Date().toISOString(),data,warnings:[],truncated
});
async function run(executable:string,args:string[],source:string,bytes=65536):Promise<{stdout:string}|{failure:Result}>{
 if(process.platform!=="linux")return {failure:reply(source,{},"unsupported")};
 const r=await runSupervisedCommand(process.cwd(),executable,args,10000,bytes);
 return r.ok?{stdout:r.stdout}:{failure:reply(source,{},"unavailable")};
}
export function parseFdEntries(stdout:string,limit:number){
 // Data from numeric /proc/PID/fd directory entries only: no symlink resolution,
 // no filenames or socket inode identifiers disclosed to the caller.
 const values=stdout.split(/\r?\n/).filter(s=>/^\d+$/.test(s)).map(Number).filter(Number.isSafeInteger).sort((a,b)=>a-b);
 return {descriptors:values.slice(0,limit),observedCount:values.length,truncated:values.length>limit};
}
export async function listProcessFds(input:unknown):Promise<Result>{
 const p=fdListInput.parse(input),source="/proc/<pid>/fd";
 const r=await run("ls",["-1","--",`/proc/${p.pid}/fd`],source);
 if("failure" in r)return r.failure;
 const parsed=parseFdEntries(r.stdout,p.limit);
 return reply(source,{fdNumbers:parsed.descriptors,observedCount:parsed.observedCount},parsed.truncated?"partial":"complete",parsed.truncated);
}
export function parseNftPolicies(stdout:string){
 // Only base-chain headers; do not surface rules or source/destination addresses.
 const policies:Array<{chain:string;hook:string|null;priority:string|null;policy:string|null}>=[];
 let chain:string|null=null;
 for(const line of stdout.split(/\r?\n/)){
  const ch=line.match(/^\s*chain\s+([A-Za-z_][\w.-]{0,63})\s*\{/);
  if(ch){chain=ch[1];continue;}
  if(chain){
   const m=line.match(/\btype\s+(filter|nat|route)\s+hook\s+(input|output|forward|prerouting|postrouting)\s+priority\s+(-?\d+|[A-Za-z_]+)\s*;.*?\bpolicy\s+(accept|drop)\s*;/);
   if(m)policies.push({chain,hook:m[2],priority:m[3],policy:m[4]});
   if(/^\s*}\s*$/.test(line))chain=null;
  }
 }
 return policies.slice(0,100);
}
export async function inspectFirewallPolicy(input:unknown):Promise<Result>{
 firewallPolicyInput.parse(input);const source="nft list ruleset (base-chain metadata)";
 const r=await run("nft",["list","ruleset"],source,262144);if("failure" in r)return r.failure;
 const policies=parseNftPolicies(r.stdout);
 return reply(source,{backend:"nftables",baseChains:policies,verdictUnknown:true});
}
export function parseOomEvents(stdout:string,limit:number){
 const records:Array<{timestamp:string|null,event:"oom-kill"|"out-of-memory"}>=[];
 for(const line of stdout.split(/\r?\n/)){
  if(!line)continue;
  try{
   const o:unknown=JSON.parse(line);
   if(!o||typeof o!=="object"||Array.isArray(o))continue;
   const v=o as Record<string,unknown>,message=typeof v.MESSAGE==="string"?v.MESSAGE:"";
   const event=/out of memory/i.test(message)?"out-of-memory":/killed process|oom-kill/i.test(message)?"oom-kill":null;
   if(event)records.push({timestamp:typeof v.__REALTIME_TIMESTAMP==="string"?v.__REALTIME_TIMESTAMP:null,event});
  }catch{ /* malformed journal record */ }
 }
 return {records:records.slice(0,limit),total:records.length,truncated:records.length>limit};
}
export async function listOomRecords(input:unknown):Promise<Result>{
 const p=oomRecordsInput.parse(input),source="journalctl kernel OOM metadata";
 const r=await run("journalctl",["--no-pager","--output=json","--dmesg","--since",`-${p.minutes}min`,"--lines","500"],source,262144);
 if("failure" in r)return r.failure;
 const rows=parseOomEvents(r.stdout,p.limit);
 return reply(source,{records:rows.records,total:rows.total},rows.truncated?"partial":"complete",rows.truncated);
}
export function parseJournalDetail(stdout:string){
 const line=stdout.split(/\r?\n/).find(Boolean);
 if(!line)return null;
 try{
  const parsed:unknown=JSON.parse(line);
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return null;
  const v=parsed as Record<string,unknown>;
  return {timestamp:typeof v.__REALTIME_TIMESTAMP==="string"?v.__REALTIME_TIMESTAMP:null,
    unit:typeof v._SYSTEMD_UNIT==="string"?v._SYSTEMD_UNIT.slice(0,128):null,
    severity:typeof v.PRIORITY==="string"&&/^[0-7]$/.test(v.PRIORITY)?v.PRIORITY:null,
    messageRedacted:true};
 }catch{return null;}
}
export async function inspectJournalRecord(input:unknown):Promise<Result>{
 const p=journalDetailInput.parse(input),source="journalctl cursor metadata";
 // Cursor is deliberately passed as one argv element; no shell interpretation.
 const r=await run("journalctl",["--no-pager","--output=json","--cursor",p.cursor,"--lines","2"],source);
 if("failure" in r)return r.failure;
 const entry=parseJournalDetail(r.stdout);
 return entry?reply(source,{record:entry}):reply(source,{},"unavailable");
}
