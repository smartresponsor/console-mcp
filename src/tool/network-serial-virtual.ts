/** Hardware-independent, fixed-profile, bounded virtual serial acceptance harness.
 * No COM/TTY open, subprocess, or DTR/RTS signaling is implemented here. */
import { Readable } from "node:stream";
const DEVICE = "virtual-serial-fixture";
const active = new Set<string>();
type Request = {deviceId:string; profile:string; baudRate:number; authorized:true; dtr:false; rts:false};
type Result = {ok:boolean;status:string;deviceId?:string;output?:string;bytesRead?:number};
function allowed(value:unknown): value is Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x=value as Record<string,unknown>;
  const keys=Object.keys(x);
  return keys.length===6 && keys.every(k=>["deviceId","profile","baudRate","authorized","dtr","rts"].includes(k)) &&
    x.deviceId===DEVICE && x.profile==="status-only" && (x.baudRate===9600 || x.baudRate===115200) &&
    x.authorized===true && x.dtr===false && x.rts===false;
}
export async function inspectVirtualSerial(
  request:unknown, factory:()=>Readable,
  options:{timeoutMs?:number; maxBytes?:number; signal?:AbortSignal}={}
):Promise<Result> {
  if (!allowed(request)) return {ok:false,status:"SERIAL_REQUEST_DENIED"};
  const timeoutMs=options.timeoutMs ?? 2000;
  const maxBytes=options.maxBytes ?? 4096;
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000 ||
      !Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>4096)
    return {ok:false,status:"SERIAL_LIMITS_INVALID"};
  if (options.signal?.aborted) return {ok:false,status:"SERIAL_CANCELLED"};
  if (active.has(request.deviceId)) return {ok:false,status:"SERIAL_DEVICE_BUSY"};
  active.add(request.deviceId);
  let stream:Readable|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onAbort:(()=>void)|undefined;
  let failure:"SERIAL_CANCELLED"|"SERIAL_TIMEOUT"|null=null;
  try {
    stream=factory();
    if (!(stream instanceof Readable)) return {ok:false,status:"SERIAL_FIXTURE_INVALID"};
    const reading=stream;
    const interrupt=(reason:"SERIAL_CANCELLED"|"SERIAL_TIMEOUT")=>{
      if (failure) return;
      failure=reason;
      reading.destroy(new Error(reason));
    };
    let settleStop:(result:Result)=>void=()=>{};
    const stopped=new Promise<Result>(resolve=>{settleStop=resolve;});
    onAbort=()=>{
      interrupt("SERIAL_CANCELLED");
      settleStop({ok:false,status:"SERIAL_CANCELLED"});
    };
    options.signal?.addEventListener("abort",onAbort,{once:true});
    timer=setTimeout(()=>{
      interrupt("SERIAL_TIMEOUT");
      settleStop({ok:false,status:"SERIAL_TIMEOUT"});
    },timeoutMs);
    const consume=async():Promise<Result>=>{
      let count=0;
      const chunks:Buffer[]=[];
      for await (const chunk of reading) {
        const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),"utf8");
        count+=buf.length;
        if (count>maxBytes) return {ok:false,status:"SERIAL_OUTPUT_LIMIT_EXCEEDED"};
        chunks.push(buf);
      }
      if (failure) return {ok:false,status:failure};
      const content=Buffer.concat(chunks,count).toString("utf8")
        .replace(/\b(password|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi,"$1=[REDACTED]");
      return {ok:true,status:"SERIAL_VIRTUAL_READ_OK",deviceId:request.deviceId,output:content,bytesRead:count};
    };
    // Race is necessary: Readable.from(async generator) can be stuck in an
    // uncooperative iterator even after destroy(); caller deadline still holds.
    return await Promise.race([consume(),stopped]);
  } catch {
    return {ok:false,status:failure??"SERIAL_FIXTURE_FAILED"};
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort",onAbort);
    stream?.destroy();
    active.delete(request.deviceId);
  }
}
