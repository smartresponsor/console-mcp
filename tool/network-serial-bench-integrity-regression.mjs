import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {inspectSerialBenchArtifactBytes} from "../dist/tool/network-serial-bench-integrity.js";

const checks=[
  "DRIVER_VERSION_PINNED","PRE_OPEN_LINE_TRANSITION_MEASURED",
  "HANDLE_IDENTITY_ATTESTED_BY_OS","CANCEL_AND_CLOSE_VERIFIED",
  "INDEPENDENT_HARDWARE_REVIEW",
];
const scope={targetId:"serial_bench_1",platform:"win32",driverName:"FTDIBUS",
  driverVersion:"3.0.0",adapterModel:"LAB-USB-1"};
const payload=check=>({
  schema:"serial-bench-evidence-v1",...scope,check,
});
const encode=p=>Buffer.from(JSON.stringify(p),"utf8");
const artifacts=checks.map(check=>({check,bytes:encode(payload(check))}));
const manifest={...scope,evidence:artifacts.map(a=>({
  check:a.check,artifactSha256:createHash("sha256").update(a.bytes).digest("hex"),
}))};
const verify=(m=manifest,a=artifacts)=>inspectSerialBenchArtifactBytes(m,a);
const okay=verify();
assert.equal(okay.ok,false);
assert.equal(okay.mayOpenDevice,false);
assert.equal(okay.hardwareAttested,false);
assert.equal(okay.status,"SERIAL_BENCH_INTEGRITY_CHECKED_REVIEW_REQUIRED");
assert.equal(okay.verifiedByteHashes,5);
for(const [m,a] of [
  [manifest,artifacts.slice(0,4)],
  [manifest,[...artifacts.slice(0,4),artifacts[0]]],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],bytes:encode({...payload(checks[4]),driverVersion:"3.1.0"})}]],
  [{...manifest,targetId:"other"},artifacts],
  [{...manifest,driverVersion:"3.1.0"},artifacts],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],bytes:encode({...payload(checks[4]),driverVersion:"3.1.0"})}]],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],bytes:new Uint8Array(65537)}]],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],bytes:new Uint8Array(0)}]],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],bytes:"not-bytes"}]],
  [{...manifest,evidence:manifest.evidence.slice(1)},artifacts],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],force:true}]],
  [manifest,[...artifacts.slice(0,4),{...artifacts[4],check:"OTHER"}]],
]) {
  const r=verify(m,a);
  assert.equal(r.ok,false);
  assert.equal(r.mayOpenDevice,false);
  assert.equal(r.hardwareAttested,false);
  assert.equal(r.status,"SERIAL_BENCH_ARTIFACTS_INVALID");
  assert.equal(r.verifiedByteHashes,0);
}
// Valid hashes alone cannot make an invalid scope an attestation.
for(const change of [
  {...payload(checks[0]),platform:"linux"},
  {...payload(checks[0]),targetId:"serial_bench_2"},
  {...payload(checks[0]),adapterModel:"OTHER"},
  {...payload(checks[0]),extra:"approved"},
  {...payload(checks[0]),schema:"untrusted-v2"},
]) {
  const bytes=encode(change);
  const m={...manifest,evidence:manifest.evidence.map(e=>
    e.check===checks[0]?{...e,artifactSha256:createHash("sha256").update(bytes).digest("hex")}:e)};
  const a=[{check:checks[0],bytes},...artifacts.slice(1)];
  assert.equal(verify(m,a).status,"SERIAL_BENCH_ARTIFACTS_INVALID");
}
// Untrusted authors may construct valid self-consistent bytes: always deny.
const rewritten=artifacts.map(a=>({check:a.check,bytes:encode({...payload(a.check)})}));
const spoofed={...manifest,evidence:rewritten.map(a=>({
  check:a.check,artifactSha256:createHash("sha256").update(a.bytes).digest("hex"),
}))};
assert.equal(verify(spoofed,rewritten).hardwareAttested,false);
assert.equal(verify(spoofed,rewritten).mayOpenDevice,false);
console.log("NETWORK_SERIAL_BENCH_ARTIFACT_INTEGRITY_PASS");
