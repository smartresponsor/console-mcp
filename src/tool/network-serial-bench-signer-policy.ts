/**
 * Offline deny-only Serial bench signer rotation/revocation policy.
 * The policy, trusted keys and evaluation time MUST be obtained independently
 * from administrator-controlled state. This function does not prove that.
 * Even a verified signer never grants permission to open physical ports.
 */
import {createHash, createPublicKey} from "node:crypto";
import {inspectSerialBenchSignature} from "./network-serial-bench-signature.js";

export type SerialBenchSignerPolicyResult = Readonly<{
  ok:false;
  mayOpenDevice:false;
  hardwareAttested:false;
  signerVerified:boolean;
  status:"SERIAL_BENCH_SIGNER_POLICY_DENIED" | "SERIAL_BENCH_SIGNER_POLICY_REVIEW_REQUIRED";
}>;

const denied=():SerialBenchSignerPolicyResult=>({
  ok:false,mayOpenDevice:false,hardwareAttested:false,signerVerified:false,
  status:"SERIAL_BENCH_SIGNER_POLICY_DENIED",
});
const hash=/^[a-f0-9]{64}$/;
const exact=(o:Record<string,unknown>,keys:string[]) =>
  Object.keys(o).sort().join(",")===keys.slice().sort().join(",");

/** A pure policy check; no key store, wall clock, network or hardware access. */
export function inspectSerialBenchSignerPolicy(
  manifestBytes:unknown, signature:unknown, policyInput:unknown,
  evaluationTimeMs:unknown,
):SerialBenchSignerPolicyResult {
  if (!Number.isSafeInteger(evaluationTimeMs) ||
      (evaluationTimeMs as number)<0 ||
      !policyInput || typeof policyInput!=="object" || Array.isArray(policyInput))
    return denied();
  const policy=policyInput as Record<string,unknown>;
  if (!exact(policy,["version","keys","revokedFingerprints"]) ||
      policy.version!==1 || !Array.isArray(policy.keys) ||
      policy.keys.length===0 || policy.keys.length>16 ||
      !Array.isArray(policy.revokedFingerprints) ||
      policy.revokedFingerprints.length>32) return denied();
  const revoked=new Set<string>();
  for (const item of policy.revokedFingerprints) {
    if (typeof item!=="string" || !hash.test(item) || revoked.has(item))
      return denied();
    revoked.add(item);
  }
  const fingerprints=new Set<string>();
  let matched=0;
  for (const entry of policy.keys as unknown[]) {
    if (!entry || typeof entry!=="object" || Array.isArray(entry)) return denied();
    const k=entry as Record<string,unknown>;
    if (!exact(k,["fingerprint","publicKeyPem","notBeforeMs","notAfterMs"]) ||
        typeof k.fingerprint!=="string" || !hash.test(k.fingerprint) ||
        fingerprints.has(k.fingerprint) ||
        typeof k.publicKeyPem!=="string" || k.publicKeyPem.length>4096 ||
        !Number.isSafeInteger(k.notBeforeMs) || !Number.isSafeInteger(k.notAfterMs) ||
        (k.notBeforeMs as number)<0 ||
        (k.notAfterMs as number)<=(k.notBeforeMs as number)) return denied();
    fingerprints.add(k.fingerprint);
    try {
      const key=createPublicKey(k.publicKeyPem);
      if (key.asymmetricKeyType!=="ed25519") return denied();
      const actual=createHash("sha256").update(key.export({format:"der",type:"spki"})).digest("hex");
      if (actual!==k.fingerprint) return denied();
    } catch { return denied(); }
    if (revoked.has(k.fingerprint) ||
        (evaluationTimeMs as number)<(k.notBeforeMs as number) ||
        (evaluationTimeMs as number)>=(k.notAfterMs as number)) continue;
    if (inspectSerialBenchSignature(manifestBytes,signature,k.publicKeyPem,k.fingerprint).signerVerified)
      matched++;
  }
  if (matched!==1) return denied();
  return {ok:false,mayOpenDevice:false,hardwareAttested:false,signerVerified:true,
    status:"SERIAL_BENCH_SIGNER_POLICY_REVIEW_REQUIRED"};
}
