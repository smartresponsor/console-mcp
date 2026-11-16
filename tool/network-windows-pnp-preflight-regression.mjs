import assert from "node:assert/strict";
import {planSerialCapture} from "../dist/tool/network-serial-admission.js";
import {inspectWindowsSerialMetadataPreflight} from "../dist/tool/network-serial-windows-preflight.js";
const target=Object.freeze({id:"pnp_lab",platform:"win32",device:"COM7",profile:"status-only",baudRate:9600,dtr:false,rts:false});
const plan=planSerialCapture({targetId:target.id,observation:"capture"},[target],
  {targetId:target.id,observation:"capture",approved:true},"win32");
assert.equal(plan.ok,true);
const valid={source:"windows-pnp",rows:[{port:"COM7",instanceId:"USB\\VID_0403&PID_6001\\A001",present:true,status:"OK",
  interfaceId:"USB#VID_0403&PID_6001#A001#{GUID}"}]};
let reads=0;
const observe=async()=>{reads++;return structuredClone(valid);};
const ok=await inspectWindowsSerialMetadataPreflight(plan,target,observe);
assert.deepEqual(ok,{ok:true,status:"SERIAL_WINDOWS_METADATA_ONLY",targetId:target.id,
  mayOpenDevice:false,requiresOpenedHandleIdentity:true,modemLinesUnverified:true});
assert.equal(reads,2);
for(const mutation of [
  {...target,dtr:true},{...target,rts:true},
]){
  reads=0;
  assert.equal((await inspectWindowsSerialMetadataPreflight(plan,mutation,observe)).ok,false);
  assert.equal(reads,0);
}
reads=0;
assert.equal((await inspectWindowsSerialMetadataPreflight(plan,{...target,device:"COM8"},observe)).ok,false);
assert.equal(reads,2); // trusted target changed: observations cannot establish COM8 mapping
for(const changed of [
  {source:"windows-pnp",rows:[]},
  {source:"windows-pnp",rows:[valid.rows[0],valid.rows[0]]},
  {source:"windows-pnp",rows:[{...valid.rows[0],present:false}]},
  {source:"windows-pnp",rows:[{...valid.rows[0],port:"COM8"}]},
  {source:"windows-pnp",rows:[{...valid.rows[0],instanceId:"untrusted"}]},
  {source:"windows-pnp",rows:[{...valid.rows[0],interfaceId:"bad"}]},
  {source:"windows-pnp",rows:[{...valid.rows[0],status:"Error"}]},
  {source:"windows-pnp",rows:[{...valid.rows[0],extra:"unsafe"}]},
  {source:"fake",rows:valid.rows},
]){
  let index=0;
  const r=await inspectWindowsSerialMetadataPreflight(plan,target,async()=>{index++;return index===1?changed:valid;});
  assert.equal(r.ok,false);
}
const unstable=await inspectWindowsSerialMetadataPreflight(plan,target,async()=>{
  reads++;return reads%2===0?{source:"windows-pnp",rows:[{...valid.rows[0],interfaceId:"USB#VID_0403&PID_6001#B002#{GUID}"}]}:valid;
});
assert.equal(unstable.ok,false);
assert.equal((await inspectWindowsSerialMetadataPreflight(plan,target,async()=>{throw Error("PnP permissions");})).ok,false);
console.log("NETWORK_WINDOWS_PNP_PREFLIGHT_OFFLINE_PASS");
