export interface RedEvidenceEnvelope {
  front: string | null;
  report_paths: string[];
  text: string;
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
