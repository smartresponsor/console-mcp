import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

type InspectionReport = {
  target?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  analyzers?: unknown;
  findings?: unknown;
  metrics?: unknown;
  summary?: unknown;
  rawReportReferences?: unknown;
};

export function registerQualityInspectionTools(
  server: McpServer,
  policy: ConsolePolicy,
  baseDir: string,
  authConfig: ConsoleAuthConfig,
): void {
  const registration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);
  const inspectingRoot = path.resolve(baseDir, "..", "..", "Inspecting");

  server.registerTool(
    "console.read_.repo.quality.status",
    {
      description: "Inspect availability of the standalone Inspecting quality engine for a repository without running analysis.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath }) => textResult(qualityStatus(policy, inspectingRoot, workspacePath)),
  );

  server.registerTool(
    "console.write.repo.quality.inspect",
    {
      description: "Run the standalone Inspecting quality engine for a repository and persist normalized/raw reports. Returns a bounded finding sample plus report references.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        findingLimit: z.number().int().min(0).max(200).default(50),
        timeoutMs: z.number().int().min(10000).max(600000).default(300000),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, findingLimit, timeoutMs }) => textResult(
      await runQualityInspection(policy, inspectingRoot, workspacePath, findingLimit, timeoutMs),
    ),
  );

  server.registerTool(
    "console.read_.repo.quality.report",
    {
      description: "Read compact metadata, summary, metrics, analyzers, and raw artifact references from a persisted Inspecting report.",
      inputSchema: z.object({ reportPath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ reportPath }) => textResult(readQualityReport(inspectingRoot, reportPath)),
  );

  server.registerTool(
    "console.read_.repo.quality.findings",
    {
      description: "Read a bounded, filterable slice of findings from a persisted Inspecting report.",
      inputSchema: z.object({
        reportPath: z.string().min(1),
        source: z.string().min(1).optional(),
        severity: z.string().min(1).optional(),
        category: z.string().min(1).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(50),
      }).strict(),
      ...registration,
    },
    async (input) => textResult(readQualityFindings(inspectingRoot, input)),
  );
}

function qualityStatus(policy: ConsolePolicy, inspectingRoot: string, workspacePath: string) {
  const target = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const runner = path.join(inspectingRoot, "bin", "inspecting");

  return {
    ok: existsSync(runner),
    status: existsSync(runner) ? "INSPECTING_READY" : "INSPECTING_UNAVAILABLE",
    target,
    inspectingRoot,
    runner,
    targetAnalyzers: {
      phpstan: existsSync(path.join(target, "vendor", "bin", process.platform === "win32" ? "phpstan.bat" : "phpstan"))
        || existsSync(path.join(target, "vendor", "bin", "phpstan")),
      rector: existsSync(path.join(target, "vendor", "bin", process.platform === "win32" ? "rector.bat" : "rector"))
        || existsSync(path.join(target, "vendor", "bin", "rector")),
      native: true,
    },
    reportRoot: path.join(inspectingRoot, ".inspecting", "reports"),
    rawReportRoot: path.join(inspectingRoot, ".inspecting", "raw"),
  };
}

async function runQualityInspection(
  policy: ConsolePolicy,
  inspectingRoot: string,
  workspacePath: string,
  findingLimit: number,
  timeoutMs: number,
) {
  const target = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const runner = path.join(inspectingRoot, "bin", "inspecting");

  if (!existsSync(runner)) {
    return { ok: false, status: "INSPECTING_UNAVAILABLE", target, runner };
  }

  const result = await runSupervisedCommand(
    inspectingRoot,
    "php",
    [runner, "inspect", target],
    timeoutMs,
    8 * 1024 * 1024,
  );

  if (!result.ok) {
    return {
      ok: false,
      status: "INSPECTING_FAILED",
      target,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 12000),
      stdout: result.stdout.slice(0, 12000),
    };
  }

  const parsed = parseInspectionOutput(result.stdout);
  if (!parsed) {
    return {
      ok: false,
      status: "INSPECTING_OUTPUT_INVALID",
      target,
      stdout: result.stdout.slice(0, 12000),
    };
  }

  const findings = Array.isArray(parsed.report.findings) ? parsed.report.findings : [];

  return {
    ok: true,
    status: "INSPECTION_COMPLETE",
    target,
    reportPath: parsed.reportPath,
    startedAt: parsed.report.startedAt ?? null,
    finishedAt: parsed.report.finishedAt ?? null,
    analyzers: Array.isArray(parsed.report.analyzers) ? parsed.report.analyzers : [],
    metrics: asRecord(parsed.report.metrics),
    summary: asRecord(parsed.report.summary),
    rawReportReferences: stringList(parsed.report.rawReportReferences),
    findings: findings.slice(0, findingLimit),
    findingCount: findings.length,
    findingsTruncated: findings.length > findingLimit,
  };
}

function readQualityReport(inspectingRoot: string, reportPath: string) {
  const { path: resolvedPath, report } = loadPersistedReport(inspectingRoot, reportPath);
  const findings = Array.isArray(report.findings) ? report.findings : [];

  return {
    ok: true,
    status: "INSPECTION_REPORT_READY",
    reportPath: resolvedPath,
    target: report.target ?? null,
    startedAt: report.startedAt ?? null,
    finishedAt: report.finishedAt ?? null,
    analyzers: Array.isArray(report.analyzers) ? report.analyzers : [],
    metrics: asRecord(report.metrics),
    summary: asRecord(report.summary),
    rawReportReferences: stringList(report.rawReportReferences),
    findingCount: findings.length,
  };
}

function readQualityFindings(
  inspectingRoot: string,
  input: {
    reportPath: string;
    source?: string;
    severity?: string;
    category?: string;
    offset: number;
    limit: number;
  },
) {
  const { path: resolvedPath, report } = loadPersistedReport(inspectingRoot, input.reportPath);
  const findings = Array.isArray(report.findings) ? report.findings.filter(isRecord) : [];
  const filtered = findings.filter((finding) =>
    matchesFilter(finding, "source", input.source)
    && matchesFilter(finding, "severity", input.severity)
    && matchesFilter(finding, "category", input.category)
  );
  const page = filtered.slice(input.offset, input.offset + input.limit);

  return {
    ok: true,
    status: "INSPECTION_FINDINGS_READY",
    reportPath: resolvedPath,
    total: filtered.length,
    offset: input.offset,
    limit: input.limit,
    returned: page.length,
    hasMore: input.offset + page.length < filtered.length,
    findings: page,
  };
}

function loadPersistedReport(inspectingRoot: string, requestedPath: string): { path: string; report: InspectionReport } {
  const reportRoot = path.join(inspectingRoot, ".inspecting", "reports");
  if (!existsSync(requestedPath)) {
    throw new Error(`Inspection report does not exist: ${requestedPath}`);
  }

  const resolvedPath = realpathSync(requestedPath);
  const resolvedRoot = existsSync(reportRoot) ? realpathSync(reportRoot) : reportRoot;
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Inspection report path escapes the Inspecting report root.");
  }

  const decoded: unknown = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (!isRecord(decoded)) {
    throw new Error("Inspection report JSON root must be an object.");
  }

  return { path: resolvedPath, report: decoded };
}

function parseInspectionOutput(stdout: string): { report: InspectionReport; reportPath: string } | null {
  const marker = /\r?\nReport written:\s*/;
  const match = marker.exec(stdout);
  if (!match || match.index < 0) {
    return null;
  }

  const json = stdout.slice(0, match.index).trim();
  const reportPath = stdout.slice(match.index + match[0].length).trim();
  if (!json || !reportPath) {
    return null;
  }

  const decoded: unknown = JSON.parse(json);
  if (!isRecord(decoded)) {
    return null;
  }

  return { report: decoded, reportPath };
}

function matchesFilter(record: Record<string, unknown>, key: string, expected?: string): boolean {
  return expected === undefined || record[key] === expected;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

