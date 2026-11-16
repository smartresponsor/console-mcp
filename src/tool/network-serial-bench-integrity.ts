/**
 * Network M2: offline artifact byte-integrity and scope matching.
 *
 * This verifies only that supplied bytes match manifest hashes and self-declared
 * target/driver scope. It cannot attest a hardware measurement or an operator.
 * Do NOT expose as a physical device authorization or MCP tool.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  inspectSerialBenchEvidence,
  type SerialBenchEvidenceCheck,
  type SerialBenchEvidenceManifest,
} from "./network-serial-bench-evidence.js";

const MAX_ARTIFACT_BYTES = 65536;
const EXPECTED_SCOPE_KEYS = [
  "adapterModel", "check", "driverName", "driverVersion", "platform",
  "schema", "targetId",
].sort().join(",");
const hex = /^[a-f0-9]{64}$/;

type RawArtifact = Readonly<{ check: SerialBenchEvidenceCheck; bytes: Uint8Array }>;
export type SerialBenchIntegrityResult = Readonly<{
  ok: false;
  status: "SERIAL_BENCH_ARTIFACTS_INVALID" | "SERIAL_BENCH_INTEGRITY_CHECKED_REVIEW_REQUIRED";
  mayOpenDevice: false;
  verifiedByteHashes: number;
  hardwareAttested: false;
}>;

function invalid(): SerialBenchIntegrityResult {
  return {ok:false,status:"SERIAL_BENCH_ARTIFACTS_INVALID",
    mayOpenDevice:false,verifiedByteHashes:0,hardwareAttested:false};
}

/**
 * Caller controls manifest AND bytes. No filesystem, signature store, OS handle,
 * hardware access or trust-anchor lookup takes place. All positive byte matches
 * STILL require an independent physical-device review.
 */
export function inspectSerialBenchArtifactBytes(
  manifestInput: unknown, artifactsInput: unknown,
): SerialBenchIntegrityResult {
  const intake = inspectSerialBenchEvidence(manifestInput);
  if (!intake.validManifest || intake.missingChecks.length !== 0 ||
      !Array.isArray(artifactsInput) || artifactsInput.length !== 5)
    return invalid();
  const manifest = manifestInput as SerialBenchEvidenceManifest;
  const expected = new Map(manifest.evidence.map(item=>[item.check,item.artifactSha256]));
  const seen = new Set<SerialBenchEvidenceCheck>();
  let verified = 0;
  for (const raw of artifactsInput as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const entry = raw as Record<string,unknown>;
    if (Object.keys(entry).sort().join(",") !== "bytes,check" ||
        !expected.has(entry.check as SerialBenchEvidenceCheck) ||
        seen.has(entry.check as SerialBenchEvidenceCheck) ||
        !(entry.bytes instanceof Uint8Array) ||
        entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_ARTIFACT_BYTES)
      return invalid();
    const check = entry.check as SerialBenchEvidenceCheck;
    const expectedHash = expected.get(check);
    if (!expectedHash || !hex.test(expectedHash)) return invalid();
    const actualHash = createHash("sha256").update(entry.bytes).digest();
    const claimedHash = Buffer.from(expectedHash, "hex");
    if (!timingSafeEqual(actualHash, claimedHash)) return invalid();
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(entry.bytes));
    } catch { return invalid(); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return invalid();
    const record = payload as Record<string,unknown>;
    if (Object.keys(record).sort().join(",") !== EXPECTED_SCOPE_KEYS ||
        record.schema !== "serial-bench-evidence-v1" ||
        record.targetId !== manifest.targetId ||
        record.platform !== manifest.platform ||
        record.driverName !== manifest.driverName ||
        record.driverVersion !== manifest.driverVersion ||
        record.adapterModel !== manifest.adapterModel ||
        record.check !== check) return invalid();
    seen.add(check);
    verified++;
  }
  if (seen.size !== expected.size) return invalid();
  return {ok:false,status:"SERIAL_BENCH_INTEGRITY_CHECKED_REVIEW_REQUIRED",
    mayOpenDevice:false,verifiedByteHashes:verified,hardwareAttested:false};
}
