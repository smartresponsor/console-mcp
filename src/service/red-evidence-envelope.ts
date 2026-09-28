export interface RedEvidenceEnvelope {
  front: string | null;
  report_paths: string[];
  text: string;
}

export interface VerificationEvidenceEnvelope {
  report_paths: string[];
  fingerprint: string | null;
  text: string;
}

export function buildVerificationEvidenceEnvelope(reportPaths: string[], fingerprint?: string): VerificationEvidenceEnvelope {
  const uniquePaths = Array.from(new Set(reportPaths.map((value) => value.trim()).filter((value) => value.length > 0)));
  const normalizedFingerprint = fingerprint?.trim() || null;
  if (uniquePaths.length === 0) {
    return { report_paths: [], fingerprint: normalizedFingerprint, text: "" };
  }

  const lines = [
    "Fresh verification evidence envelope:",
    ...(normalizedFingerprint ? ["- Verification fingerprint at scan time: " + normalizedFingerprint] : []),
    "- These reports were already produced by the upstream CanonScanning verification pass. Consume them before deciding to run the same verifier again.",
    "- Do not re-run an already represented verifier merely to rediscover the same state while the target repository still matches the supplied verification fingerprint.",
    "- A GREEN/passed report is reusable acceptance evidence for that unchanged fingerprint and does not require a duplicate pre-remediation run.",
    "- Re-run the affected verifier only after relevant repository mutation, when the evidence is missing/stale for the current fingerprint, or when a RED/degraded report explicitly requires post-remediation verification.",
    ...uniquePaths.map((reportPath) => "- Verification report: " + reportPath),
  ];

  return { report_paths: uniquePaths, fingerprint: normalizedFingerprint, text: lines.join("\n") };
}

export function buildRedEvidenceEnvelope(reportPaths: string[], front?: string): RedEvidenceEnvelope {
  const normalizedFront = front?.trim() || null;
  const uniquePaths = Array.from(new Set(reportPaths.map((value) => value.trim()).filter((value) => value.length > 0)));
  if (uniquePaths.length === 0) {
    return { front: normalizedFront, report_paths: [], text: "" };
  }

  const lines = [
    "Red evidence envelope:",
    ...(normalizedFront ? ["- Remediation front: " + normalizedFront] : []),
    ...(normalizedFront === "inspecting" ? [
      "- Inspecting is mandatory for this remediation front as an external verification engine; it is not an application dependency requirement.",
      "- Read the referenced Inspecting report, remediate applicable actionable findings, and re-run Inspecting before claiming this front green.",
      "- Do not dismiss this front because the target repository has no direct Composer/source reference to Inspecting.",
    ] : []),
    "- The references below are durable reports from local checks that are currently RED.",
    "- Treat these reports as the initial failure backlog and evidence, not as a file allowlist or scope boundary.",
    "- Read the referenced reports through Console MCP before selecting remediation work.",
    "- Investigate and fix adjacent repository code when required by the underlying causes; do not restrict fixes only to paths named by a report.",
    "- Re-run the relevant local checks after remediation and use their actual green/red result as the acceptance signal.",
    ...uniquePaths.map((reportPath) => "- RED report: " + reportPath),
  ];

  return {
    front: normalizedFront,
    report_paths: uniquePaths,
    text: lines.join("\n"),
  };
}
