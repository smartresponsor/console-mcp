/**
 * Network M2: offline evidence INTAKE for a future controlled serial bench.
 *
 * This is not a driver certification, authorization check, or kernel barrier.
 * Even a complete evidence manifest does not permit open(2)/CreateFile.
 * No hardware access, raw device commands, or MCP registration here.
 */
export type SerialBenchEvidenceCheck =
  | "DRIVER_VERSION_PINNED"
  | "PRE_OPEN_LINE_TRANSITION_MEASURED"
  | "HANDLE_IDENTITY_ATTESTED_BY_OS"
  | "CANCEL_AND_CLOSE_VERIFIED"
  | "INDEPENDENT_HARDWARE_REVIEW";

const required = Object.freeze([
  "DRIVER_VERSION_PINNED",
  "PRE_OPEN_LINE_TRANSITION_MEASURED",
  "HANDLE_IDENTITY_ATTESTED_BY_OS",
  "CANCEL_AND_CLOSE_VERIFIED",
  "INDEPENDENT_HARDWARE_REVIEW",
] as const);

/** Data supplied by a bench operator is untrusted and never authorizes opening. */
export type SerialBenchEvidenceManifest = Readonly<{
  targetId: string;
  platform: "linux" | "win32";
  driverName: string;
  driverVersion: string;
  adapterModel: string;
  evidence: readonly Readonly<{ check: SerialBenchEvidenceCheck; artifactSha256: string }>[];
}>;

export type SerialBenchEvidenceReport = Readonly<{
  ok: false;
  status: "SERIAL_BENCH_EVIDENCE_INVALID" | "SERIAL_BENCH_HARDWARE_REVIEW_REQUIRED";
  mayOpenDevice: false;
  validManifest: boolean;
  missingChecks: readonly SerialBenchEvidenceCheck[];
}>;

const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const labelPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.+ -]{0,95}$/;
const hashPattern = /^[a-f0-9]{64}$/;

/**
 * Syntax/provenance completeness ONLY. Hashes are not verified against files,
 * and supplied signatures/claims have no authority. Never return ok:true.
 */
export function inspectSerialBenchEvidence(input: unknown): SerialBenchEvidenceReport {
  const invalid = ():SerialBenchEvidenceReport => ({
    ok:false,status:"SERIAL_BENCH_EVIDENCE_INVALID",
    mayOpenDevice:false,validManifest:false,missingChecks:required
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const manifest = input as Record<string,unknown>;
  if (Object.keys(manifest).sort().join(",") !==
      ["adapterModel","driverName","driverVersion","evidence","platform","targetId"].sort().join(",") ||
      typeof manifest.targetId !== "string" || !idPattern.test(manifest.targetId) ||
      (manifest.platform !== "linux" && manifest.platform !== "win32") ||
      typeof manifest.driverName !== "string" || !labelPattern.test(manifest.driverName) ||
      typeof manifest.driverVersion !== "string" || !labelPattern.test(manifest.driverVersion) ||
      typeof manifest.adapterModel !== "string" || !labelPattern.test(manifest.adapterModel) ||
      !Array.isArray(manifest.evidence) || manifest.evidence.length > required.length)
    return invalid();
  const observed = new Set<SerialBenchEvidenceCheck>();
  for (const item of manifest.evidence as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    const fields = item as Record<string,unknown>;
    if (Object.keys(fields).sort().join(",") !== "artifactSha256,check" ||
        !required.includes(fields.check as SerialBenchEvidenceCheck) ||
        typeof fields.artifactSha256 !== "string" || !hashPattern.test(fields.artifactSha256) ||
        observed.has(fields.check as SerialBenchEvidenceCheck)) return invalid();
    observed.add(fields.check as SerialBenchEvidenceCheck);
  }
  return {
    ok:false,status:"SERIAL_BENCH_HARDWARE_REVIEW_REQUIRED",
    mayOpenDevice:false,validManifest:true,
    missingChecks:Object.freeze(required.filter(check=>!observed.has(check)))
  };
}
