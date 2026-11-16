/** Windows serial metadata-only gate. Never opens a COM handle or authorizes I/O. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SerialPlanResult, SerialTarget } from "./network-serial-admission.js";

export type PnpRow = Readonly<{device:string;instanceId:string;status:string}>;
export type PnpSnapshot = Readonly<{ok:true;source:"Get-PnpDevice+DEVPKEY_Device_PortName";rows:readonly PnpRow[]}>;
export type PnpProbe = () => Promise<unknown>;
export type WindowsPnpPreflightResult =
  | {ok:false;status:string}
  | {ok:true;status:"SERIAL_WINDOWS_PNP_PREFLIGHT_ONLY";targetId:string;
     device:string;instanceId:string;mayOpenDevice:false;
     requiresOpenedHandleIdentity:true;modemLinesUnverified:true};

const SCRIPT=fileURLToPath(new URL("../../tool/network-windows-serial-pnp-preflight.ps1",import.meta.url));
const DEVICE=/^COM(?:[1-9]|[1-9][0-9]{1,3})$/;
const INSTANCE=/^(?:USB|FTDIBUS|ACPI)\\[A-Z0-9_&\\-]{4,180}$/;
const SOURCE="Get-PnpDevice+DEVPKEY_Device_PortName";

function snapshot(value:unknown):PnpSnapshot|null {
  if (!value || typeof value!=="object" || Array.isArray(value)) return null;
  const x=value as Record<string,unknown>;
  if (x.ok!==true || x.source!==SOURCE || !Array.isArray(x.rows) || x.rows.length>128) return null;
  const ports=new Set<string>();const ids=new Set<string>();
  const rows:PnpRow[]=[];
  for(const item of x.rows) {
    if (!item || typeof item!=="object" || Array.isArray(item)) return null;
    const row=item as Record<string,unknown>;
    if(typeof row.device!=="string" || !DEVICE.test(row.device) ||
       typeof row.instanceId!=="string" || !INSTANCE.test(row.instanceId) ||
       row.status!=="OK" || ports.has(row.device) || ids.has(row.instanceId)) return null;
    ports.add(row.device);ids.add(row.instanceId);
    rows.push({device:row.device,instanceId:row.instanceId,status:"OK"});
  }
  return {ok:true,source:SOURCE,rows};
}

/** Fixed command/script, bounded output and deadline, no caller-supplied shell arguments. */
export async function observeWindowsPnp():Promise<unknown> {
  if(process.platform!=="win32") return {ok:false};
  return new Promise(resolve=>{
    let settled=false, bytes=0, output="";
    const child=spawn("pwsh",["-NoProfile","-NonInteractive","-File",SCRIPT],
      {shell:false,windowsHide:true,stdio:["ignore","pipe","ignore"]});
    const finish=(value:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);resolve(value);
    };
    const timer=setTimeout(()=>{child.kill("SIGKILL");finish({ok:false});},15000);
    child.on("error",()=>finish({ok:false}));
    child.stdout.on("data",(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>65536){child.kill("SIGKILL");finish({ok:false});return;}
      output+=chunk.toString("utf8");
    });
    child.on("close",code=>{
      if(code!==0)return finish({ok:false});
      try{finish(JSON.parse(output) as unknown);}
      catch{finish({ok:false});}
    });
  });
}

/** Probe injection is test-only. Positive metadata is never open authorization. */
export async function inspectWindowsPnpPreflight(
  plan:SerialPlanResult,target:SerialTarget,probe:PnpProbe=observeWindowsPnp,
):Promise<WindowsPnpPreflightResult> {
  if(plan.ok!==true || plan.status!=="SERIAL_PLAN_ONLY" ||
     plan.platform!=="win32" || plan.mayOpenDevice!==false ||
     plan.requiresOsDeviceVerification!==true || target.platform!=="win32" ||
     target.id!==plan.targetId || target.profile!==plan.profile ||
     target.baudRate!==plan.baudRate || !DEVICE.test(target.device) ||
     target.dtr!==false || target.rts!==false)
    return {ok:false,status:"SERIAL_WINDOWS_PNP_ADMISSION_DENIED"};
  try {
    const before=snapshot(await probe());
    if(!before)return {ok:false,status:"SERIAL_WINDOWS_PNP_UNTRUSTED"};
    const selected=before.rows.filter(row=>row.device===target.device);
    if(selected.length!==1)return {ok:false,status:"SERIAL_WINDOWS_PNP_DEVICE_MISSING"};
    const after=snapshot(await probe());
    if(!after)return {ok:false,status:"SERIAL_WINDOWS_PNP_UNTRUSTED"};
    if(after.rows.length!==before.rows.length ||
       after.rows.some((row,i)=>!before.rows.some(old=>old.device===row.device &&
           old.instanceId===row.instanceId)) ||
       after.rows.filter(row=>row.device===target.device).length!==1)
      return {ok:false,status:"SERIAL_WINDOWS_PNP_CHANGED"};
    return {ok:true,status:"SERIAL_WINDOWS_PNP_PREFLIGHT_ONLY",
      targetId:plan.targetId,device:target.device,instanceId:selected[0]!.instanceId,
      mayOpenDevice:false,requiresOpenedHandleIdentity:true,modemLinesUnverified:true};
  }catch{return {ok:false,status:"SERIAL_WINDOWS_PNP_UNAVAILABLE"};}
}
