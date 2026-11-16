/** Read-only Linux /dev and sysfs metadata preflight for SERIAL_PLAN_ONLY.
 * Never opens a TTY, changes DTR/RTS, or grants device-open authority.
 * Linux open(2) can toggle modem lines; a future backend needs independent
 * driver-specific no-toggle evidence and an opened-handle identity check.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { SerialPlanResult, SerialTarget } from "./network-serial-admission.js";

type CharNode = Readonly<{dev:bigint;ino:bigint;rdev:bigint;
  isCharacterDevice():boolean;isSymbolicLink():boolean}>;
export type LinuxSerialProbe = Readonly<{
  lstat(file:string):Promise<CharNode>;
  readFile(file:string):Promise<string>;
  realpath(file:string):Promise<string>;
}>;
export type LinuxSerialPreflightResult =
  | {ok:false;status:string}
  | {ok:true;status:"SERIAL_LINUX_PREFLIGHT_ONLY";targetId:string;
     device:string;deviceNumber:string;sysfsInstance:string;
     mayOpenDevice:false;requiresOpenedHandleIdentity:true;modemLinesUnverified:true};

const ttyDevice=/^\/dev\/tty(?:USB|ACM)(?:0|[1-9][0-9]{0,3})$/;
const kernelFs:LinuxSerialProbe={
  lstat:async file=>lstat(file,{bigint:true}),
  readFile:file=>readFile(file,"utf8"),
  realpath,
};
const devText=/^(?:0|[1-9][0-9]{0,6}):(?:0|[1-9][0-9]{0,9})$/;
function devNumber(rdev:bigint):string {
  const major=((rdev>>8n)&0xfffn)|((rdev>>32n)&~0xfffn);
  const minor=(rdev&0xffn)|((rdev>>12n)&~0xffn);
  return `${major}:${minor}`;
}
function withinSysDevices(resolved:string):boolean {
  if (!path.posix.isAbsolute(resolved)) return false;
  const relative=path.posix.relative("/sys/devices",resolved);
  return relative.length>0&&relative!==".."&&!relative.startsWith("../")&&
    !path.posix.isAbsolute(relative);
}
function validNode(node:CharNode):boolean {
  return node.isCharacterDevice()&&!node.isSymbolicLink()&&node.rdev>0n;
}
/** probe override is for offline fixture tests only. No result ever permits open. */
export async function inspectLinuxSerialPreflight(
  plan:SerialPlanResult,target:SerialTarget,probe:LinuxSerialProbe=kernelFs,
):Promise<LinuxSerialPreflightResult> {
  if (plan.ok!==true||plan.status!=="SERIAL_PLAN_ONLY"||
      plan.mayOpenDevice!==false||plan.requiresOsDeviceVerification!==true||
      plan.platform!=="linux"||target.platform!=="linux"||
      target.id!==plan.targetId||!ttyDevice.test(target.device)||
      target.profile!=="status-only"||target.baudRate!==plan.baudRate||
      target.dtr!==false||target.rts!==false)
    return {ok:false,status:"SERIAL_LINUX_PREFLIGHT_DENIED"};
  const name=path.posix.basename(target.device);
  const sysDev=`/sys/class/tty/${name}/dev`;
  const sysInstance=`/sys/class/tty/${name}/device`;
  try {
    const before=await probe.lstat(target.device);
    if (!validNode(before)) return {ok:false,status:"SERIAL_LINUX_NODE_UNTRUSTED"};
    const number=(await probe.readFile(sysDev)).trim();
    const instance=await probe.realpath(sysInstance);
    if (!devText.test(number)||!withinSysDevices(instance))
      return {ok:false,status:"SERIAL_LINUX_SYSFS_UNTRUSTED"};
    if (devNumber(before.rdev)!==number)
      return {ok:false,status:"SERIAL_LINUX_DEVNO_MISMATCH"};
    const after=await probe.lstat(target.device);
    const numberAfter=(await probe.readFile(sysDev)).trim();
    const instanceAfter=await probe.realpath(sysInstance);
    if (!validNode(after)||before.dev!==after.dev||before.ino!==after.ino||
        before.rdev!==after.rdev||number!==numberAfter||instance!==instanceAfter)
      return {ok:false,status:"SERIAL_LINUX_PREFLIGHT_UNSTABLE"};
    return {ok:true,status:"SERIAL_LINUX_PREFLIGHT_ONLY",
      targetId:plan.targetId,device:target.device,deviceNumber:number,
      sysfsInstance:instance,mayOpenDevice:false,requiresOpenedHandleIdentity:true,
      modemLinesUnverified:true};
  } catch {
    return {ok:false,status:"SERIAL_LINUX_PREFLIGHT_UNAVAILABLE"};
  }
}
