import assert from "node:assert/strict";
import { captureOfflineSerialFixture } from "../dist/tool/network-serial-offline-capture.js";
import { OfflineSerialLeaseCoordinator } from "../dist/tool/network-serial-session-lease.js";
const target = Object.freeze({id:"lab_a",platform:"linux",device:"/dev/ttyUSB0",
  profile:"status-only",baudRate:9600,dtr:false,rts:false});
const request = {targetId:"lab_a",observation:"capture"};
const approval = {targetId:"lab_a",observation:"capture",approved:true};
const witness = {platform:"linux",device:"/dev/ttyUSB0",
  instanceId:"/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1",identity:"188:0",
  dtr:false,rts:false,verified:true};
const encode = s=>new TextEncoder().encode(s);
const leases = new OfflineSerialLeaseCoordinator();
let opens=0, closes=0;
const factory = (frames,after={...witness}) => async () => {
  opens++;
  return {before:witness,after,frames:(async function*(){for(const frame of frames)yield frame;})(),
    async close(){closes++;}};
};
let r=await captureOfflineSerialFixture(request,[target],approval,"linux",leases,
  factory([encode("ready\n"),encode("token=abc123\n")]),{timeoutMs:500});
assert.equal(r.ok,true);
assert.equal(r.value.status,"SERIAL_OFFLINE_CAPTURE_COMPLETE");
assert.match(r.value.output,/ready/);
assert.doesNotMatch(r.value.output,/abc123/);
assert.equal(opens,1);assert.equal(closes,1);
for(const altered of [{...request,command:"show running-config"},{...request,device:"/dev/ttyUSB0"}]){
  r=await captureOfflineSerialFixture(altered,[target],approval,"linux",leases,
    factory([encode("bad")]),{timeoutMs:100});
  assert.equal(r.status,"SERIAL_OFFLINE_ADMISSION_DENIED");
}
assert.equal(opens,1);
r=await captureOfflineSerialFixture(request,[target],approval,"linux",leases,
  factory([encode("bad")],{...witness,identity:"188:1"}),{timeoutMs:100});
assert.equal(r.status,"SERIAL_LEASE_TASK_FAILED");
assert.equal(closes,2);

r=await captureOfflineSerialFixture(request,[target],approval,"linux",leases,
  factory([new Uint8Array(1025)]),{timeoutMs:100});
assert.equal(r.status,"SERIAL_LEASE_TASK_FAILED");
r=await captureOfflineSerialFixture(request,[target],approval,"linux",leases,
  factory([new Uint8Array(1024),new Uint8Array(1024),
    new Uint8Array(1024),new Uint8Array(1024),encode("overflow")]),{timeoutMs:100});
assert.equal(r.status,"SERIAL_LEASE_TASK_FAILED");

let release;
const held = captureOfflineSerialFixture(request,[target],approval,"linux",leases,async()=>{
  opens++;
  return {before:witness,after:witness,
    frames:(async function*(){await new Promise(resolve=>{release=resolve;}); yield encode("late");})(),
    async close(){closes++;}}, {timeoutMs:20});
await new Promise(resolve=>setTimeout(resolve,5));
const concurrent = await captureOfflineSerialFixture(request,[target],approval,"linux",leases,
  factory([encode("wrong")]),{timeoutMs:100});
assert.equal(concurrent.status,"SERIAL_LEASE_BUSY");
r=await held;
assert.equal(r.status,"SERIAL_LEASE_TIMEOUT");
assert.equal(leases.isLeased("lab_a"),true);
release();
await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(leases.isLeased("lab_a"),false);
assert.equal(closes,5);

r=await captureOfflineSerialFixture(request,[target],approval,"linux",leases,async()=>{
  opens++;
  return {before:witness,after:witness,
    frames:(async function*(){yield encode("ready");})(),
    async close(){closes++;throw new Error("secret=must-not-escape");}};
},{timeoutMs:100});
assert.equal(r.status,"SERIAL_LEASE_TASK_FAILED");
assert.equal(leases.isLeased("lab_a"),false);
console.log("NETWORK_SERIAL_OFFLINE_CAPTURE_PASS");
