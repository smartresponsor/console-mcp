import assert from "node:assert/strict";
import {inspectSerialBenchEvidence} from "../dist/tool/network-serial-bench-evidence.js";

const checks=[
  "DRIVER_VERSION_PINNED","PRE_OPEN_LINE_TRANSITION_MEASURED",
  "HANDLE_IDENTITY_ATTESTED_BY_OS","CANCEL_AND_CLOSE_VERIFIED",
  "INDEPENDENT_HARDWARE_REVIEW",
];
const base={targetId:"bench_1",platform:"linux",driverName:"usbserial",
  driverVersion:"1.0.0",adapterModel:"LAB-USB-001",evidence:[]};
const hash="a".repeat(64);
const evaluate=x=>inspectSerialBenchEvidence(x);
for (const platform of ["linux","win32"]) {
  const empty=evaluate({...base,platform});
  assert.equal(empty.ok,false);
  assert.equal(empty.mayOpenDevice,false);
  assert.equal(empty.validManifest,true);
  assert.deepEqual(empty.missingChecks,checks);
  const complete=evaluate({...base,platform,evidence:checks.map(check=>({check,artifactSha256:hash}))});
  assert.equal(complete.ok,false);
  assert.equal(complete.mayOpenDevice,false);
  assert.equal(complete.status,"SERIAL_BENCH_HARDWARE_REVIEW_REQUIRED");
  assert.deepEqual(complete.missingChecks,[]);
  assert.ok(Object.isFrozen(complete.missingChecks));
  const partial=evaluate({...base,platform,evidence:[{check:checks[0],artifactSha256:hash}]});
  assert.deepEqual(partial.missingChecks,checks.slice(1));
}
for (const bad of [
  null,[],{}, {...base,platform:"darwin"}, {...base,targetId:"../ttyUSB0"},
  {...base,driverName:""}, {...base,driverVersion:"0\nunsafe"},
  {...base,adapterModel:"/dev/ttyUSB0"},
  {...base,approved:true},{...base,mayOpenDevice:true},
  {...base,evidence:[{check:checks[0],artifactSha256:"x"}]},
  {...base,evidence:[{check:checks[0],artifactSha256:hash,approved:true}]},
  {...base,evidence:[{check:checks[0],artifactSha256:hash},{check:checks[0],artifactSha256:hash}]},
  {...base,evidence:[{check:"SIGNATURE_VALID",artifactSha256:hash}]},
  {...base,evidence:checks.concat(checks[0]).map(check=>({check,artifactSha256:hash}))},
]) {
 const r=evaluate(bad);
 assert.equal(r.ok,false);
 assert.equal(r.mayOpenDevice,false);
 assert.equal(r.status,"SERIAL_BENCH_EVIDENCE_INVALID");
}
assert.equal(evaluate({...base,evidence:[{check:checks[0],artifactSha256:hash}]}).validManifest,true);
console.log("NETWORK_SERIAL_BENCH_EVIDENCE_DENY_ONLY_PASS");
