import assert from "node:assert/strict";
import {inspectLinuxSerialPreflight} from "../dist/tool/network-serial-linux-preflight.js";
import {planSerialCapture} from "../dist/tool/network-serial-admission.js";
const target=Object.freeze({id:"bench",platform:"linux",device:"/dev/ttyUSB0",
  profile:"status-only",baudRate:9600,dtr:false,rts:false});
const plan=planSerialCapture({targetId:"bench",observation:"capture"},[target],
  {targetId:"bench",observation:"capture",approved:true},"linux");
assert.equal(plan.ok,true);
const node=(ino=9n)=>({dev:123n,ino,rdev:48128n,
  isCharacterDevice:()=>true,isSymbolicLink:()=>false});
const fixture={lstat:async()=>node(),readFile:async()=>"188:0\n",
  realpath:async()=>"/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1"};
const result=await inspectLinuxSerialPreflight(plan,target,fixture);
assert.equal(result.status,"SERIAL_LINUX_PREFLIGHT_ONLY");
assert.equal(result.mayOpenDevice,false);
assert.equal(result.modemLinesUnverified,true);
assert.equal(result.deviceNumber,"188:0");
const expect=async(probe,status)=>assert.equal(
  (await inspectLinuxSerialPreflight(plan,target,probe)).status,status);
assert.equal((await inspectLinuxSerialPreflight({...plan,mayOpenDevice:true},target,fixture)).ok,false);
assert.equal((await inspectLinuxSerialPreflight(plan,{...target,device:"/dev/pts/0"},fixture)).ok,false);
assert.equal((await inspectLinuxSerialPreflight(plan,{...target,dtr:true},fixture)).ok,false);
await expect({...fixture,lstat:async()=>({...node(),isSymbolicLink:()=>true})},
  "SERIAL_LINUX_NODE_UNTRUSTED");
await expect({...fixture,readFile:async()=>"189:0"},
  "SERIAL_LINUX_DEVNO_MISMATCH");
await expect({...fixture,realpath:async()=>"/tmp/other"},
  "SERIAL_LINUX_SYSFS_UNTRUSTED");
let n=0;
await expect({...fixture,lstat:async()=>node(++n)},
  "SERIAL_LINUX_PREFLIGHT_UNSTABLE");
await expect({...fixture,lstat:async()=>{throw Error("missing");}},
  "SERIAL_LINUX_PREFLIGHT_UNAVAILABLE");
console.log("NETWORK_LINUX_SERIAL_OS_PREFLIGHT_PASS");
