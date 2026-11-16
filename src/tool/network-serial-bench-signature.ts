/**
 * Offline Ed25519 signature verification for a Serial bench evidence manifest.
 *
 * Trust boundary: trustedKeyPem and expectedKeyFingerprint MUST come from
 * independent administrator-controlled configuration, never from the manifest
 * or an MCP caller. A valid signature authenticates a signer, NOT hardware.
 * This module cannot authorize physical COM/TTY opening.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { inspectSerialBenchEvidence } from "./network-serial-bench-evidence.js";

export type SerialBenchSignatureResult = Readonly<{
  ok: false;
  mayOpenDevice: false;
  hardwareAttested: false;
  status: "SERIAL_BENCH_SIGNATURE_INVALID" | "SERIAL_BENCH_SIGNER_VERIFIED_REVIEW_REQUIRED";
  signerVerified: boolean;
}>;

const deny = ():SerialBenchSignatureResult=>({
  ok:false,mayOpenDevice:false,hardwareAttested:false,
  status:"SERIAL_BENCH_SIGNATURE_INVALID",signerVerified:false,
});

/**
 * Verify exact manifest bytes (no reserialization) under independently pinned
 * Ed25519 SPKI key fingerprint. Does not access files, devices, network, or OS.
 */
export function inspectSerialBenchSignature(
  manifestBytes: unknown,
  signature: unknown,
  trustedKeyPem: unknown,
  expectedKeyFingerprint: unknown,
): SerialBenchSignatureResult {
  if (!(manifestBytes instanceof Uint8Array) ||
      manifestBytes.byteLength === 0 || manifestBytes.byteLength > 65536 ||
      !(signature instanceof Uint8Array) || signature.byteLength !== 64 ||
      typeof trustedKeyPem !== "string" || trustedKeyPem.length > 4096 ||
      typeof expectedKeyFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedKeyFingerprint)) return deny();
  try {
    const key = createPublicKey(trustedKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return deny();
    const spki = key.export({type:"spki",format:"der"});
    const actualFingerprint = createHash("sha256").update(spki).digest("hex");
    if (actualFingerprint !== expectedKeyFingerprint) return deny();
    const decoded = new TextDecoder("utf-8",{fatal:true}).decode(manifestBytes);
    const manifest = JSON.parse(decoded);
    const result = inspectSerialBenchEvidence(manifest);
    if (!result.validManifest || result.missingChecks.length !== 0) return deny();
    if (!verify(null, manifestBytes, key, signature)) return deny();
    return {ok:false,mayOpenDevice:false,hardwareAttested:false,
      status:"SERIAL_BENCH_SIGNER_VERIFIED_REVIEW_REQUIRED",signerVerified:true};
  } catch { return deny(); }
}
