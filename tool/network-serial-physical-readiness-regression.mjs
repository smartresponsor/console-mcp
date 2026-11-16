import assert from "node:assert/strict";
import { planSerialCapture } from "../dist/tool/network-serial-admission.js";
import { assessPhysicalSerialReadiness } from "../dist/tool/network-serial-physical-readiness.js";

for (const platform of ["linux","win32"]) {
  const target = Object.freeze({
    id:"serial_lab", platform,
    device:platform==="linux"?"/dev/ttyUSB0":"COM7",
    profile:"status-only", baudRate:9600, dtr:false, rts:false,
  });
  const plan=planSerialCapture({targetId:target.id,observation:"capture"},[target],
    {targetId:target.id,observation:"capture",approved:true},platform);
  assert.equal(plan.ok,true);
  const result=assessPhysicalSerialReadiness(plan,target);
  assert.equal(result.ok,false);
  assert.equal(result.status,"SERIAL_PHYSICAL_OPEN_BLOCKED");
  assert.equal(result.mayOpenDevice,false);
  assert.deepEqual(result.blockers,[
    "NO_DRIVER_SPECIFIC_NO_TOGGLE_PROOF",
    "NO_KERNEL_BOUND_HANDLE_IDENTITY",
    "NO_OS_ENFORCED_LINE_STATE",
    "NO_PRIVILEGED_CLEANUP_ATTESTATION",
    "NO_HARDWARE_ACCEPTANCE",
  ]);
  assert.ok(Object.isFrozen(result.blockers));

  for(const forged of [
    {...plan,mayOpenDevice:true},
    {...plan,status:"SERIAL_HARDWARE_APPROVED"},
    {...plan,requiresOsDeviceVerification:false},
    {...plan,hardwareEvidence:"signed",driverSafety:"verified"},
    {ok:false,status:"SERIAL_AUTHORIZATION_REQUIRED"},
  ]) {
    const rejected=assessPhysicalSerialReadiness(forged,target);
    // An extraneous field does not grant any authority, regardless of result.
    assert.equal(rejected.ok,false);
    assert.equal(rejected.mayOpenDevice,false);
  }

  for(const changed of [
    {...target,id:"other"},
    {...target,platform:platform==="linux"?"win32":"linux"},
    {...target,dtr:true},
    {...target,rts:true},
    {...target,baudRate:115200},
    {...target,profile:"interactive"},
  ]) {
    const rejected=assessPhysicalSerialReadiness(plan,changed);
    assert.equal(rejected.ok,false);
    assert.equal(rejected.status,"SERIAL_PHYSICAL_PLAN_DENIED");
    assert.equal(rejected.mayOpenDevice,false);
  }
}
console.log("NETWORK_SERIAL_PHYSICAL_READINESS_BLOCKED_PASS");
