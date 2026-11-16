import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {inspectSerialBenchSignerPolicy} from "../dist/tool/network-serial-bench-signer-policy.js";
const checks=["DRIVER_VERSION_PINNED","PRE_OPEN_LINE_TRANSITION_MEASURED","HANDLE_IDENTITY_ATTESTED_BY_OS","CANCEL_AND_CLOSE_VERIFIED","INDEPENDENT_HARDWARE_REVIEW"];
const manifest={targetId:"bench_1",platform:"linux",driverName:"usbserial",driverVersion:"1.0.0",adapterModel:"LAB-USB-1",evidence:checks.map(check=>({check,artifactSha256:"a".repeat(64)}))};
const bytes=Buffer.from(JSON.stringify(manifest));
const makeKey=()=>{const {privateKey,publicKey}=generateKeyPairSync("ed25519");const publicKeyPem=publicKey.export({format:"pem",type:"spki"});const fingerprint=createHash("sha256").update(publicKey.export({format:"der",type:"spki"})).digest("hex");return {privateKey,publicKeyPem,fingerprint};};
const a=makeKey(),b=makeKey();
const key=(k,start=100,end=300)=>({fingerprint:k.fingerprint,publicKeyPem:k.publicKeyPem,notBeforeMs:start,notAfterMs:end});
const sig=sign(null,bytes,a.privateKey);
const policy={version:1,keys:[key(a)],revokedFingerprints:[]};
const verify=(p=policy,t=200,s=sig,m=bytes)=>inspectSerialBenchSignerPolicy(m,s,p,t);
assert.deepEqual(verify(),{ok:false,mayOpenDevice:false,hardwareAttested:false,signerVerified:true,status:"SERIAL_BENCH_SIGNER_POLICY_REVIEW_REQUIRED"});
const rotated={...policy,keys:[key(a,100,200),key(b,200,300)]};
assert.equal(verify(rotated,199).signerVerified,true);
assert.equal(verify(rotated,200).signerVerified,false);
const bsig=sign(null,bytes,b.privateKey);
assert.equal(verify(rotated,200,bsig).signerVerified,true);
for(const [p,t,s,m] of [
  [{...policy,revokedFingerprints:[a.fingerprint]},200,sig,bytes],
  [policy,99,sig,bytes],[policy,300,sig,bytes],
  [{...policy,keys:[key(b)]},200,sig,bytes],
  [{...policy,keys:[key(a),key(a)]},200,sig,bytes],
  [{...policy,keys:[{...key(a),fingerprint:b.fingerprint}]},200,sig,bytes],
  [{...policy,revokedFingerprints:[a.fingerprint,a.fingerprint]},200,sig,bytes],
  [{...policy,revokedFingerprints:["invalid"]},200,sig,bytes],
  [{...policy,keys:[{...key(a),notAfterMs:100}]},200,sig,bytes],
  [{...policy,approved:true},200,sig,bytes],
  [policy,-1,sig,bytes],[policy,NaN,sig,bytes],
  [policy,200,Buffer.alloc(64),bytes],
  [policy,200,sig,Buffer.from(JSON.stringify({...manifest,targetId:"other"}))],
]) {
 const result=verify(p,t,s,m);
 assert.equal(result.status,"SERIAL_BENCH_SIGNER_POLICY_DENIED");
 assert.equal(result.signerVerified,false);
 assert.equal(result.mayOpenDevice,false);
 assert.equal(result.hardwareAttested,false);
}
console.log("NETWORK_SERIAL_BENCH_SIGNER_ROTATION_REVOCATION_DENY_ONLY_PASS");
