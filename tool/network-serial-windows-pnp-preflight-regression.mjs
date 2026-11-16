import assert from "node:assert/strict";
import { inspectWindowsPnpPreflight, observeWindowsPnp } from "../dist/tool/network-serial-windows-pnp-preflight.js";
import { planSerialCapture } from "../dist/tool/network-serial-admission.js";

const target={id:"bench",platform:"win32",device:"COM3",profile:"status-only",
  baudRate:9600,dtr:false,rts:false};
const plan=planSerialCapture({targetId:"bench",observation:"capture"},[target],
  {targetId:"bench",observation:"capture",approved:true},"win32");
assert.equal(plan.ok,true);
const row={device:"COM3",instanceId:"USB\\VID_0403&PID_6001\\ABC123",status:"OK"};
const snap=(rows=[row])=>({ok:true,source:"Get-PnpDevice+DEVPKEY_Device_PortName",rows});
const stable=async()=>snap();
let r=await inspectWindowsPnpPreflight(plan,target,stable);
assert.equal(r.ok,true);
assert.equal(r.mayOpenDevice,false);
assert.equal(r.requiresOpenedHandleIdentity,true);
assert.equal(r.modemLinesUnverified,true);
const deny=async(probe,expected)=>{
  const result=await inspectWindowsPnpPreflight(plan,target,probe);
  assert.equal(result.ok,false);
  assert.equal(result.status,expected);
};
await deny(async()=>snap([]),"SERIAL_WINDOWS_PNP_DEVICE_MISSING");
await deny(async()=>snap([row,{...row,instanceId:"USB\\VID_0403&PID_6001\\DIFFERENT"}]),"SERIAL_WINDOWS_PNP_UNTRUSTED");
await deny(async()=>snap([{...row,status:"Error"}]),"SERIAL_WINDOWS_PNP_UNTRUSTED");
await deny(async()=>snap([{...row,instanceId:"INVALID"}]),"SERIAL_WINDOWS_PNP_UNTRUSTED");
await deny(async()=>{throw Error("unavailable");},"SERIAL_WINDOWS_PNP_UNAVAILABLE");
let n=0;
await deny(async()=>++n===1?snap():snap([{...row,instanceId:"USB\\VID_0403&PID_6001\\CHANGED"}]),"SERIAL_WINDOWS_PNP_CHANGED");
assert.equal((await inspectWindowsPnpPreflight({...plan,mayOpenDevice:true},target,stable)).ok,false);
assert.equal((await inspectWindowsPnpPreflight(plan,{...target,dtr:true},stable)).ok,false);
assert.equal((await inspectWindowsPnpPreflight(plan,{...target,rts:true},stable)).ok,false);
assert.equal((await inspectWindowsPnpPreflight(plan,{...target,device:"COM3;cmd"},stable)).ok,false);
const live=await observeWindowsPnp();
assert.equal(typeof live,"object");
console.log("NETWORK_WINDOWS_PNP_PREFLIGHT_PASS",process.platform);
