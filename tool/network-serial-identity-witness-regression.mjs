import assert from "node:assert/strict";
import { planSerialCapture } from "../dist/tool/network-serial-admission.js";
import { compareSerialWitnesses } from "../dist/tool/network-serial-identity-witness.js";

const target = Object.freeze({
  id:"serial_lab_a",platform:"linux",device:"/dev/ttyUSB0",
  profile:"status-only",baudRate:9600,dtr:false,rts:false,
});
const request = {targetId:target.id,observation:"capture"};
const approval = {targetId:target.id,observation:"capture",approved:true};
const plan = planSerialCapture(request,[target],approval,"linux");
assert.equal(plan.ok,true);
const linux = Object.freeze({
  platform:"linux",device:"/dev/ttyUSB0",
  instanceId:"/sys/devices/pci0000:00/0000:00:14.0/usb1/1-1",
  identity:"188:0",dtr:false,rts:false,verified:true,
});
const ok = compareSerialWitnesses(plan,target,linux,{...linux});
assert.deepEqual(ok,{ok:true,status:"SERIAL_IDENTITY_WITNESSED_OFFLINE",
  targetId:target.id,requiresKernelReverification:true,mayOpenDevice:false});
assert.ok(!Object.hasOwn(ok,"device"));
assert.ok(!Object.hasOwn(ok,"instanceId"));

for (const mutated of [
  {...linux,device:"/dev/ttyUSB1"},
  {...linux,instanceId:linux.instanceId+"/different"},
  {...linux,identity:"188:1"},
  {...linux,instanceId:"/sys/devices/../escape"},
  {...linux,identity:"not-device-number"},
  {...linux,dtr:true},
  {...linux,rts:true},
  {...linux,verified:false},
  {...linux,command:"show config"},
]) assert.equal(compareSerialWitnesses(plan,target,linux,mutated).ok,false);

for (const tampered of [
  {...target,device:"/dev/ttyUSB1"},
  {...target,baudRate:115200},
  {...target,profile:"configure"},
  {...target,dtr:true},
  {...target,rts:true},
  {...target,command:"show config"},
]) assert.equal(compareSerialWitnesses(plan,tampered,linux,linux).ok,false);

const rejected = planSerialCapture({...request,command:"write"},[target],approval,"linux");
assert.equal(compareSerialWitnesses(rejected,target,linux,linux).status,"SERIAL_PLAN_REQUIRED");

const winTarget = Object.freeze({
  id:"serial_lab_w",platform:"win32",device:"COM7",
  profile:"status-only",baudRate:115200,dtr:false,rts:false,
});
const winPlan = planSerialCapture({targetId:winTarget.id,observation:"capture"},
  [winTarget],{targetId:winTarget.id,observation:"capture",approved:true},"win32");
assert.equal(winPlan.ok,true);
const win = Object.freeze({
  platform:"win32",device:"COM7",instanceId:"USB\\VID_0403&PID_6001\\A001",
  identity:"USB\\VID_0403&PID_6001\\A001",dtr:false,rts:false,verified:true,
});
assert.equal(compareSerialWitnesses(winPlan,winTarget,win,{...win}).ok,true);
for (const changed of [
  {...win,device:"COM8"},
  {...win,instanceId:"USB\\VID_0403&PID_6001\\A002"},
  {...win,identity:"USB\\VID_0403&PID_6001\\A002"},
  {...win,instanceId:"\\\\.\\COM7"},
  {...win,dtr:true},
]) assert.equal(compareSerialWitnesses(winPlan,winTarget,win,changed).ok,false);

console.log("NETWORK_SERIAL_IDENTITY_WITNESS_PASS");
