import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { classifyCommandFailure } from "./infrastructure-failure-contract.js";

// Windows event-log metadata only. Never return Message, Properties, UserId or raw XML.
const local=z.object({targetId:z.literal("local")}).strict();
export const winEventListInput=local.extend({minutes:z.number().int().min(1).max(60).default(15),limit:z.number().int().min(1).max(100).default(30),serviceId:z.string().optional()}).strict();
export const winEventDetailInput=local.extend({cursor:z.string().regex(/^System:[1-9][0-9]{0,17}$/)}).strict();
type State="complete"|"partial"|"unavailable"|"unsupported"|"no_data"|"permission_denied"|"timeout";
type Result={status:State;ok:boolean;source:string;targetId:"local";data:Record<string,unknown>;truncated:boolean;warnings:string[]};
function result(status:State,data:Record<string,unknown>,truncated=false,warnings:string[]=[]):Result{
 return {status,ok:status==="complete"||status==="partial",source:"Windows Event Log: System",targetId:"local",data,truncated,warnings};
}
export function parseWindowsEventJson(stdout:string):Record<string,unknown>[]|null{
 try{
  const raw:unknown=JSON.parse(stdout);
  if(raw===null)return [];
  const items=Array.isArray(raw)?raw:[raw];
  return items.every(v=>v!==null&&typeof v==="object"&&!Array.isArray(v))?items as Record<string,unknown>[]:null;
 }catch{return null;}
}
export function mapWindowsEvent(row:Record<string,unknown>){
 const id=row.RecordId;
 if(typeof id!=="number"||!Number.isSafeInteger(id)||id<=0)return null;
 return {cursor:"System:"+String(id),timestampUsec:null,priority:null,
  timestamp:typeof row.TimeCreated==="string"?row.TimeCreated:null,
  unit:typeof row.ProviderName==="string"?row.ProviderName.slice(0,128):null,
  eventId:typeof row.Id==="number"?row.Id:null,level:typeof row.Level==="number"?row.Level:null};
}
export function classifyWindowsEventFailure(stderr:string):"no_data"|"unavailable"{
 // Get-WinEvent uses a terminating exception when the filter matches no events.
 return /NoMatchingEventsFound|No events were found that match/i.test(stderr)
  ? "no_data" : "unavailable";
}
async function query(script:string):Promise<{rows:Record<string,unknown>[]} | {failure:Result}>{
 if(process.platform!=="win32")return {failure:result("unsupported",{})};
 const encoded=Buffer.from(script,"utf16le").toString("base64");
 const r=await runSupervisedCommand(process.cwd(),"powershell.exe",
  ["-NoProfile","-NonInteractive","-EncodedCommand",encoded],10000,131072);
 if(!r.ok){
  const f=classifyCommandFailure(r);
  const status=f.status==="unavailable" && classifyWindowsEventFailure(r.stderr)==="no_data"?"no_data":f.status;
  return {failure:result(status,{},false,[status==="no_data"?"no matching System events":f.warning])};
 }
 const rows=parseWindowsEventJson(r.stdout);
 return rows===null?{failure:result("unavailable",{},false,["invalid event provider response"])}:{rows};
}
export async function listWindowsEventRecords(input:unknown):Promise<Result>{
 const p=winEventListInput.parse(input);
 // Windows serviceId is not equivalent to a System channel provider filter.
 if(p.serviceId!==undefined)return result("unsupported",{},false,["service-scoped journal query not supported on Windows"]);
 const script=`$start=(Get-Date).AddMinutes(-${p.minutes}); Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$start} -MaxEvents ${p.limit+1} -ErrorAction Stop | Select-Object RecordId,TimeCreated,ProviderName,Id,Level | ConvertTo-Json -Compress -Depth 2`;
 const q=await query(script);if("failure" in q)return q.failure;
 const records=q.rows.map(mapWindowsEvent).filter((v):v is NonNullable<typeof v>=>v!==null);
 if(records.length===0)return result("no_data",{records:[],total:0});
 const truncated=records.length>p.limit;
 return result(truncated?"partial":"complete",{records:records.slice(0,p.limit),total:records.length},truncated);
}
export async function inspectWindowsEventRecord(input:unknown):Promise<Result>{
 const p=winEventDetailInput.parse(input),id=Number(p.cursor.slice(7));
 if(!Number.isSafeInteger(id))return result("no_data",{});
 const script=`Get-WinEvent -LogName System -FilterXPath '*[System[EventRecordID=${id}]]' -MaxEvents 1 -ErrorAction Stop | Select-Object -First 1 RecordId,TimeCreated,ProviderName,Id,Level | ConvertTo-Json -Compress -Depth 2`;
 // Exact record-id filter, without scanning an arbitrary window of 10000 events.
 const q=await query(script);if("failure" in q)return q.failure;
 const record=q.rows.map(mapWindowsEvent).find(v=>v?.cursor===p.cursor);
 return record?result("complete",{record:{timestamp:record.timestamp,severity:record.priority,unit:record.unit,messageRedacted:true,cursor:record.cursor}}):result("no_data",{});
}
