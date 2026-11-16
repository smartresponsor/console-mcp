import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {inspectSerialBenchSignature} from "../dist/tool/network-serial-bench-signature.js";
const checks=["DRIVER_VERSION_PINNED","PRE_OPEN_LINE_TRANSITION_MEASURED",
  "HANDLE_IDENTITY_ATTESTED_BY_OS","CANCEL_AND_CLOSE_VERIFIED","INDEPENDENT_HARDWARE_REVIEW"];
const manifest={targetId:"bench_1",platform:"linux",driverName:"usbserial",
  driverVersion:"1.0.0",adapterModel:"LAB-USB-1",
  evidence:checks.map(check=>({check,artifactSha256:"a".repeat(64)}))};
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const pem=publicKey.export({type:"spki",format:"pem"});
const pin=createHash("sha256").update(publicKey.export({type:"spki",format:"der"})).digest("hex");
const bytes=Buffer.from(JSON.stringify(manifest));
const sig=sign(null,bytes,privateKey);
const check=(b=bytes,s=sig,k=pem,f=pin)=>inspectSerialBenchSignature(b,s,k,f);
const valid=check();
assert.deepEqual(valid,{ok:false,mayOpenDevice:false,hardwareAttested:false,
  status:"SERIAL_BENCH_SIGNER_VERIFIED_REVIEW_REQUIRED",signerVerified:true});
const {publicKey:other}=generateKeyPairSync("ed25519");
for(const [b,s,k,f] of [
  [Buffer.from(JSON.stringify({...manifest,targetId:"other"})),sig,pem,pin],
  [bytes,Buffer.from(sig.map((v,i)=>i===0?v^1:v)),pem,pin],
  [bytes,sig,other.export({type:"spki",format:"pem"}),pin],
  [bytes,sig,pem,"b".repeat(64)],
  [bytes,sig,pem,"INVALID"],
  [bytes,new Uint8Array(0),pem,pin],
  [new Uint8Array(65537),sig,pem,pin],
  [Buffer.from("not json"),sig,pem,pin],
  [Buffer.from(JSON.stringify({...manifest,evidence:[]})),sig,pem,pin],
  [bytes,sig,"not a key",pin],
  [bytes,sig,pem+"x".repeat(4096),pin],
]) {
  const r=check(b,s,k,f);
  assert.equal(r.signerVerified,false);
  assert.equal(r.ok,false);
  assert.equal(r.mayOpenDevice,false);
  assert.equal(r.hardwareAttested,false);
  assert.equal(r.status,"SERIAL_BENCH_SIGNATURE_INVALID");
}
// A valid self-signed manifest does not imply independent physical attestation.
const selfSigned=sign(null,bytes,privateKey);
assert.equal(check(bytes,selfSigned).hardwareAttested,false);
console.log("NETWORK_SERIAL_BENCH_ED25519_PROVENANCE_DENY_ONLY_PASS");
