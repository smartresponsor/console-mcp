import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot, getDeniedReason } from "../service/path.js";
import { getWorkspaceStatus } from "./workspace-status.js";
import { runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

async function writeRcEvidenceArtifacts(workspace: string, evidence: RcEvidenceArtifactModel, readiness: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runDir = path.join(workspace, evidence.run_dir);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, evidence.diagnostic_report_path), `${JSON.stringify({ tool: "console.rc", run_id: evidence.run_id }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.readiness_report_path), `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.validation_report_path), `${JSON.stringify({ validation_results: null }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.ai_review_result_path), `${JSON.stringify({ ai_review_result: null }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.manifest_path), `${JSON.stringify({ run_id: evidence.run_id, files: [evidence.diagnostic_report_path, evidence.validation_report_path, evidence.ai_review_result_path, evidence.readiness_report_path] }, null, 2)}\n`, "utf8");
  return { ok: true, written: true, run_dir: evidence.run_dir, manifest_path: evidence.manifest_path, readiness };
}

type RcMode = "diagnose" | "validate" | "plan";

type FileSample = {
  path: string;
  bytes: number;
};

type Inventory = {
  total_files_seen: number;
  total_files_returned: number;
  truncated: boolean;
  directories: Record<string, number>;
  files: FileSample[];
};

type GovernanceFile = {
  path: string;
  exists: boolean;
  bytes: number | null;
  summary: string | null;
};

type ValidationInventory = {
  composer_json: boolean;
  package_json: boolean;
  composer_scripts: string[];
  package_scripts: string[];
  suggested_checks: string[];
};

type ValidationCommandStatus =
  | "passed"
  | "warning_only"
  | "evidence_required"
  | "autowiring_failure"
  | "file_format_failure"
  | "false_green_suspected"
  | "runtime_failure"
  | "configuration_failure"
  | "unsafe_or_not_callable";

type ValidationCommandResult = {
  ok: boolean;
  process_ok: boolean;
  status: ValidationCommandStatus;
  classification: ValidationCommandStatus;
  severity: "info" | "warning" | "error";
  diagnostic: string;
  readiness_blocker: string | null;
  label: string;
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stdout_truncated: boolean;
  stderr: string;
  stderr_truncated: boolean;
};

type ValidationProfileResult = {
  ok: boolean;
  command_count: number;
  commands: ValidationCommandResult[];
  classifications: Record<ValidationCommandStatus, number>;
  blockers: string[];
  suspicious_count: number;
  evidence_required_count: number;
  failed_count: number;
};

type CanonIssue = {
  rule: string;
  severity: "error" | "warning";
  path: string;
  detail: string;
};

type CanonScan = {
  ok: boolean;
  issue_count: number;
  issues: CanonIssue[];
  truncated: boolean;
};

type BoundaryReport = {
  component: string | null;
  target: string | null;
  likely_component_paths: string[];
  responsibility_hint: string | null;
};

const governanceFiles = [
  "AGENTS.md",
  "README.md",
  "composer.json",
  "package.json",
  "symfony.lock",
  "phpunit.xml",
  "phpunit.xml.dist",
  "phpstan.neon",
  "qodana.yaml",
  "rector.php",
  "ecs.php",
  ".php-cs-fixer.dist.php",
  "config/routes.yaml",
  "config/services.yaml",
];

const inventoryRoots = [
  "src",
  "config",
  "templates",
  "tests",
  "docs",
  "fixtures",
  "migrations",
  "assets",
  ".github",
  "tool",
  "bin",
];

const skippedDirectoryNames = new Set([
  ".git",
  ".idea",
  "node_modules",
  "vendor",
  "var",
  "dist",
  "build",
  "coverage",
  "cache",
  "log",
  "tmp",
]);

const textFileExtensions = new Set([
  ".adoc",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".md",
  ".neon",
  ".php",
  ".ps1",
  ".ts",
  ".twig",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function registerRcTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.rc",
    {
      description: "Run a read-only release-candidate diagnostic pass for a workspace or component.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        component: z.string().min(1).max(120).optional(),
        target: z.string().min(1).max(120).optional(),
        mode: z.enum(["diagnose", "validate", "plan"]).default("diagnose"),
        maxFiles: z.number().int().min(20).max(2000).default(500),
        maxIssues: z.number().int().min(10).max(500).default(120),
        dirtyPolicy: z.enum(["block_uncommitted", "allow_existing_readonly", "allow_owned_paths"]).default("block_uncommitted"),
        validationProfile: z.enum(["auto", "symfony_host", "node_package", "mixed"]).default("auto"),
        allowedPaths: z.array(z.string().min(1)).max(100).default([]),
        forbiddenPaths: z.array(z.string().min(1)).max(100).default([]),
        repairLimit: z.number().int().min(0).max(10).default(0),
        advisorMode: z.enum(["off", "optional", "required"]).default("optional"),
        commitPolicy: z.enum(["none", "commit_on_green"]).default("none"),
        pushPolicy: z.enum(["none", "push_on_green"]).default("none"),
        prPolicy: z.enum(["none", "open_on_green"]).default("none"),
        writeEvidence: z.boolean().default(false),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await executeRcDiagnose(
      policy,
      input.workspacePath,
      input.component ?? null,
      input.target ?? null,
      input.mode,
      input.maxFiles,
      input.maxIssues,
      buildRunEnvelope(input),
      input.writeEvidence,
    ))
  );
}

async function executeRcDiagnose(
  policy: ConsolePolicy,
  workspacePath: string,
  component: string | null,
  target: string | null,
  mode: RcMode,
  maxFiles: number,
  maxIssues: number,
  runEnvelope: RcRunEnvelope,
  writeEvidence: boolean,
): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const status = await getWorkspaceStatus(policy, workspace);
  const governance = await readGovernance(workspace, policy);
  const inventory = await buildInventory(workspace, policy, maxFiles);
  const validation = await detectValidation(workspace);
  const canon = await scanCanon(workspace, policy, inventory.files, maxIssues);
  const boundary = buildBoundaryReport(component, target, inventory.files);
  const validationResults = mode === "validate" ? await runValidationProfile(workspace, validation) : null;
  const evidence = buildEvidenceArtifactModel(component, target, mode);
  evidence.write_enabled = writeEvidence;
  const readiness = buildReadiness(status, canon, validation, inventory, validationResults);
  const artifactWrite = writeEvidence ? await writeRcEvidenceArtifacts(workspace, evidence, readiness) : { ok: true, written: false };

  return {
    ok: readiness.ok,
    tool: "console.rc",
    mode,
    workspace_path: workspace,
    run_envelope: runEnvelope,
    evidence,
    artifact_write: artifactWrite,
    repair_plan: mode === "plan" ? buildRepairPlanContract(runEnvelope, readiness) : null,
    boundary,
    git: status,
    governance,
    inventory,
    validation,
    validation_results: validationResults,
    canon,
    readiness,
    next_modes: ["validate", "repair", "full"],
    advisor: buildAdvisorPrompt(component, target, readiness, canon, validation),
  };
}

async function readGovernance(workspace: string, policy: ConsolePolicy): Promise<GovernanceFile[]> {
  const files: GovernanceFile[] = [];
  for (const relativePath of governanceFiles) {
    const absolutePath = path.join(workspace, relativePath);
    if (!existsSync(absolutePath) || getDeniedReason(absolutePath, policy.deniedPath)) {
      files.push({ path: relativePath, exists: false, bytes: null, summary: null });
      continue;
    }

    const info = await stat(absolutePath);
    const text = await readSmallTextFile(absolutePath, 24000);
    files.push({
      path: relativePath,
      exists: true,
      bytes: info.size,
      summary: summarizeText(text),
    });
  }

  return files;
}

async function buildInventory(workspace: string, policy: ConsolePolicy, maxFiles: number): Promise<Inventory> {
  const files: FileSample[] = [];
  const directories: Record<string, number> = {};
  let totalFilesSeen = 0;

  for (const rootName of inventoryRoots) {
    const rootPath = path.join(workspace, rootName);
    if (!existsSync(rootPath)) {
      directories[rootName] = 0;
      continue;
    }

    const rootCountBefore = totalFilesSeen;
    await walk(rootPath);
    directories[rootName] = totalFilesSeen - rootCountBefore;
  }

  return {
    total_files_seen: totalFilesSeen,
    total_files_returned: files.length,
    truncated: files.length < totalFilesSeen,
    directories,
    files,
  };

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (getDeniedReason(absolutePath, policy.deniedPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (skippedDirectoryNames.has(entry.name.toLowerCase())) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      totalFilesSeen += 1;
      if (files.length >= maxFiles) {
        continue;
      }

      const info = await stat(absolutePath);
      files.push({ path: toRepoPath(workspace, absolutePath), bytes: info.size });
    }
  }
}

async function detectValidation(workspace: string): Promise<ValidationInventory> {
  const composer = await readJsonObject(path.join(workspace, "composer.json"));
  const packageJson = await readJsonObject(path.join(workspace, "package.json"));
  const composerScripts = objectKeys(composer?.scripts);
  const packageScripts = objectKeys(packageJson?.scripts);
  const suggestedChecks = new Set<string>();

  if (composer) {
    suggestedChecks.add("composer validate");
  }
  for (const script of composerScripts) {
    if (isValidationScript(script)) {
      suggestedChecks.add(`composer run-script ${script}`);
    }
  }
  for (const script of packageScripts) {
    if (isValidationScript(script)) {
      suggestedChecks.add(`npm run ${script}`);
    }
  }

  return {
    composer_json: composer !== null,
    package_json: packageJson !== null,
    composer_scripts: composerScripts,
    package_scripts: packageScripts,
    suggested_checks: Array.from(suggestedChecks),
  };
}

async function runValidationProfile(workspace: string, validation: ValidationInventory): Promise<ValidationProfileResult> {
  const commands: ValidationCommandResult[] = [];
  const run = async (label: string, commandName: string, args: string[]): Promise<void> => {
    const result = await runSupervisedCommand(workspace, commandName, args, 180000, 4 * 1024 * 1024);
    const stdout = truncateOutput(result.stdout, 10000);
    const stderr = truncateOutput(result.stderr, 10000);
    const classification = classifyValidationCommand(label, result.ok, result.exitCode, stdout.text, stderr.text);
    commands.push({
      ok: classification.ok,
      process_ok: result.ok,
      status: classification.status,
      classification: classification.status,
      severity: classification.severity,
      diagnostic: classification.diagnostic,
      readiness_blocker: classification.readiness_blocker,
      label,
      command: [result.command, ...result.args].join(" "),
      cwd: result.cwd,
      exit_code: result.exitCode,
      stdout: stdout.text,
      stdout_truncated: stdout.truncated,
      stderr: stderr.text,
      stderr_truncated: stderr.truncated,
    });
  };

  if (validation.composer_json) {
    await run("composer_validate", "composer", ["validate"]);
  }
  for (const script of validation.composer_scripts) {
    if (commands.length >= 8) break;
    if (/fix|write|reset|drop|delete|migrate|load|seed|fixture|install|update|deploy/i.test(script)) continue;
    if (/^(test|test:|lint|lint:|analyse|analyze|check|check:|phpstan|stan|canon|canon:|owner:canon:enforce|pipeline:local:full|gating:|ai-review:|inspect:|smoke|smoke:)/i.test(script)) {
      await run(`composer:${script}`, "composer", ["run-script", script]);
    }
  }
  for (const script of validation.package_scripts) {
    if (commands.length >= 8) break;
    if (/fix|write|deploy|start|restart|serve|watch|dev/i.test(script)) continue;
    if (/^(test|test:|typecheck|ui:check|build|lint|lint:|check|check:|smoke|smoke:)/i.test(script)) {
      await run(`npm:${script}`, "npm", ["run", script]);
    }
  }

  const classifications = {} as Record<ValidationCommandStatus, number>;
  const blockers = new Set<string>();
  for (const command of commands) {
    classifications[command.status] = (classifications[command.status] ?? 0) + 1;
    if (command.readiness_blocker !== null) blockers.add(command.readiness_blocker);
  }
  return {
    ok: commands.every((command) => command.ok),
    command_count: commands.length,
    commands,
    classifications,
    blockers: Array.from(blockers).sort(),
    suspicious_count: classifications.false_green_suspected ?? 0,
    evidence_required_count: classifications.evidence_required ?? 0,
    failed_count: commands.filter((command) => !command.ok).length,
  };
}

async function scanCanon(workspace: string, policy: ConsolePolicy, files: FileSample[], maxIssues: number): Promise<CanonScan> {
  const issues: CanonIssue[] = [];
  let truncated = false;

  for (const file of files) {
    if (issues.length >= maxIssues) {
      truncated = true;
      break;
    }

    scanPath(file.path, issues);
    if (!isTextCandidate(file.path) || file.bytes > 262144) {
      continue;
    }

    const absolutePath = path.join(workspace, file.path);
    if (getDeniedReason(absolutePath, policy.deniedPath)) {
      continue;
    }

    const text = await readSmallTextFile(absolutePath, 262144);
    scanContent(file.path, text, issues, maxIssues);
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issue_count: issues.length,
    issues,
    truncated,
  };
}

function scanPath(relativePath: string, issues: CanonIssue[]): void {
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^src\/Domain(?:\/|$)/i.test(normalized)) {
    issues.push({ rule: "no_src_domain", severity: "error", path: relativePath, detail: "src/Domain is forbidden by SmartResponsor Symfony canon." });
  }
  if (/(?:^|\/)(Port|Adapter)(?:\/|$)/i.test(normalized)) {
    issues.push({ rule: "no_port_adapter_pattern", severity: "error", path: relativePath, detail: "Port and Adapter pattern naming is forbidden for this workspace." });
  }
}

function scanContent(relativePath: string, text: string, issues: CanonIssue[], maxIssues: number): void {
  if (issues.length >= maxIssues) {
    return;
  }

  if (/\b(TODO|FIXME|STUB|PLACEHOLDER)\b/i.test(text)) {
    issues.push({ rule: "no_todo_stub_placeholder", severity: "warning", path: relativePath, detail: "File contains TODO/FIXME/STUB/PLACEHOLDER marker." });
  }

  if (relativePath.endsWith(".php")) {
    const match = text.match(/\bnamespace\s+([^;]+);/);
    if (relativePath.startsWith("src/") && match && match[1] && !/^App(?:\\|$)/.test(match[1].trim())) {
      issues.push({ rule: "app_namespace_only", severity: "error", path: relativePath, detail: `PHP namespace is ${match[1].trim()}, expected App\\...` });
    }
  }

  if (/\b(PortInterface|AdapterInterface|InboundPort|OutboundPort)\b/i.test(text)) {
    issues.push({ rule: "no_port_adapter_pattern", severity: "warning", path: relativePath, detail: "File contains Port/Adapter vocabulary." });
  }
}

function buildBoundaryReport(component: string | null, target: string | null, files: FileSample[]): BoundaryReport {
  const componentKey = component?.trim().toLowerCase() ?? "";
  const likelyPaths = componentKey === ""
    ? []
    : files
      .map((file) => file.path)
      .filter((filePath) => filePath.toLowerCase().includes(componentKey))
      .slice(0, 80);

  return {
    component,
    target,
    likely_component_paths: likelyPaths,
    responsibility_hint: component ? `RC diagnostic boundary for ${component}.` : "Workspace-level RC diagnostic boundary.",
  };
}

function buildReadiness(
  status: Record<string, unknown>,
  canon: CanonScan,
  validation: ValidationInventory,
  inventory: Inventory,
  validationResults: ValidationProfileResult | null,
): Record<string, unknown> {
  const statusCount = typeof status.status_line_count === "number" ? status.status_line_count : 0;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (statusCount > 0) {
    blockers.push("workspace_has_uncommitted_changes");
  }
  if (!canon.ok) {
    blockers.push("canon_errors_detected");
  }
  if (validation.suggested_checks.length === 0) {
    warnings.push("no_validation_commands_detected");
  }
  if (inventory.truncated) {
    warnings.push("inventory_truncated");
  }
  if (validationResults !== null) {
    for (const blocker of validationResults.blockers) {
      if (!blockers.includes(blocker)) {
        blockers.push(blocker);
      }
    }
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? "rc_diagnostic_green" : "rc_diagnostic_blocked",
    blockers,
    warnings,
  };
}

function buildAdvisorPrompt(
  component: string | null,
  target: string | null,
  readiness: Record<string, unknown>,
  canon: CanonScan,
  validation: ValidationInventory,
): Record<string, unknown> {
  return {
    recommended_tool: "console.ask",
    use_when: "Need cheap second-opinion classification for gaps, validation failures, PR text, or RC notes.",
    suggested_prompt: [
      "Review this RC diagnostic summary.",
      component ? `Component: ${component}.` : "Component: workspace-level.",
      target ? `Target: ${target}.` : "Target: not specified.",
      `Readiness: ${JSON.stringify(readiness)}.`,
      `Canon issues: ${canon.issue_count}.`,
      `Suggested checks: ${validation.suggested_checks.join(", ") || "none"}.`,
      "Return only risks, next safe validation step, and missing RC evidence.",
    ].join("\n"),
  };
}

function isValidationScript(script: string): boolean {
  return /test|lint|analyse|analyze|phpstan|stan|cs|build|check|smoke|doctor|validate|canon|pipeline/i.test(script);
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value).sort();
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readSmallTextFile(filePath: string, maxBytes: number): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.subarray(0, maxBytes).toString("utf8");
}

function summarizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 8)
    .join(" | ")
    .slice(0, 1200);
}

function isTextCandidate(relativePath: string): boolean {
  return textFileExtensions.has(path.extname(relativePath).toLowerCase());
}

function toRepoPath(workspace: string, absolutePath: string): string {
  return path.relative(workspace, absolutePath).replaceAll("\\", "/");
}

function classifyValidationCommand(
  label: string,
  processOk: boolean,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): { ok: boolean; status: ValidationCommandStatus; severity: "info" | "warning" | "error"; diagnostic: string; readiness_blocker: string | null } {
  const combined = `${stdout}\n${stderr}`;

  if (looksLikeRawSourceOutput(label, stdout)) {
    return {
      ok: false,
      status: "false_green_suspected",
      severity: "error",
      diagnostic: "Command exited successfully but stdout looks like raw PHP/source output instead of an inspection verdict.",
      readiness_blocker: "validation_suspicious",
    };
  }

  if (processOk) {
    if (isWarningOnlyOutput(label, combined)) {
      return {
        ok: true,
        status: "warning_only",
        severity: "warning",
        diagnostic: "Command passed with warnings only.",
        readiness_blocker: null,
      };
    }

    return {
      ok: true,
      status: "passed",
      severity: "info",
      diagnostic: "Command passed.",
      readiness_blocker: null,
    };
  }

  if (isEvidenceRequiredOutput(label, combined)) {
    return {
      ok: false,
      status: "evidence_required",
      severity: "error",
      diagnostic: "Command requires a missing evidence artifact rather than a generic runtime repair.",
      readiness_blocker: "validation_evidence_required",
    };
  }

  return classifyFailedValidationCommand(label, exitCode, combined);
}

function classifyFailedValidationCommand(
  label: string,
  exitCode: number | null,
  output: string,
): { ok: boolean; status: ValidationCommandStatus; severity: "info" | "warning" | "error"; diagnostic: string; readiness_blocker: string | null } {
  if (isAutowiringFailure(output)) {
    return {
      ok: false,
      status: "autowiring_failure",
      severity: "error",
      diagnostic: "Symfony dependency injection/autowiring failed.",
      readiness_blocker: "validation_failed",
    };
  }

  if (isFileFormatFailure(label, output)) {
    return {
      ok: false,
      status: "file_format_failure",
      severity: "error",
      diagnostic: "Validation failed on file format/header/content shape.",
      readiness_blocker: "validation_failed",
    };
  }

  if (isUnsafeOrNotCallable(exitCode, output)) {
    return {
      ok: false,
      status: "unsafe_or_not_callable",
      severity: "error",
      diagnostic: "Command was not callable or was blocked by execution policy.",
      readiness_blocker: "validation_not_callable",
    };
  }

  if (isConfigurationFailure(output)) {
    return {
      ok: false,
      status: "configuration_failure",
      severity: "error",
      diagnostic: "Validation failed on missing/invalid configuration or service wiring.",
      readiness_blocker: "validation_failed",
    };
  }

  return {
    ok: false,
    status: "runtime_failure",
    severity: "error",
    diagnostic: "Validation command failed without a more specific classifier match.",
    readiness_blocker: "validation_failed",
  };
}

function looksLikeRawSourceOutput(label: string, stdout: string): boolean {
  const output = stdout.trim();
  if (output === "") {
    return false;
  }

  const hasPhpHeader = output.includes("<?php") || output.includes("declare(strict_types=1)");
  const hasSourceMarkers = /\b(namespace|function|final class|use)\b|\$[A-Za-z_][A-Za-z0-9_]*|\bexit\s*\(/.test(output);
  const inspectionOutputTooLarge = /^composer:inspect:/.test(label) && output.length > 1200;

  return hasPhpHeader && hasSourceMarkers && (inspectionOutputTooLarge || output.length > 200);
}

function isWarningOnlyOutput(label: string, output: string): boolean {
  return label === "composer_validate" && /is valid, but with a few warnings|# General warnings|warnings? only/i.test(output);
}

function isEvidenceRequiredOutput(label: string, output: string): boolean {
  return /ai-review/i.test(label) && /--result is required|Missing explicit AI review result|Missing file: .*review|review result .*not present|evidence .*required/i.test(output);
}

function isAutowiringFailure(output: string): boolean {
  return /Cannot autowire service|autowir(e|ing)|DefinitionErrorExceptionPass/i.test(output);
}

function isFileFormatFailure(label: string, output: string): boolean {
  return /^composer:inspect:/.test(label) && /must start with|strict types guard failed|header|file format|Parse error|syntax error/i.test(output);
}

function isUnsafeOrNotCallable(exitCode: number | null, output: string): boolean {
  return exitCode === null || /not recognized as .*cmdlet|command not found|ENOENT|EACCES|permission denied|blocked by .*policy|not allowed|unsafe|denied by policy/i.test(output);
}

function isConfigurationFailure(output: string): boolean {
  return /non-existent service|no such service exists|Invalid configuration|There is no extension able to load|CheckExceptionOnInvalidReferenceBehaviorPass|dependency on a non-existent service|YAML|services\.yaml|framework\.workflows/i.test(output);
}

type RcDirtyPolicy = "block_uncommitted" | "allow_existing_readonly" | "allow_owned_paths";
type RcValidationProfile = "auto" | "symfony_host" | "node_package" | "mixed";
type RcAdvisorMode = "off" | "optional" | "required";
type RcCommitPolicy = "none" | "commit_on_green";
type RcPushPolicy = "none" | "push_on_green";
type RcPrPolicy = "none" | "open_on_green";

type RcRunEnvelope = {
  dirty_policy: RcDirtyPolicy;
  validation_profile: RcValidationProfile;
  allowed_paths: string[];
  forbidden_paths: string[];
  repair_limit: number;
  advisor_mode: RcAdvisorMode;
  commit_policy: RcCommitPolicy;
  push_policy: RcPushPolicy;
  pr_policy: RcPrPolicy;
  active_capabilities: string[];
  inactive_capabilities: string[];
};

function buildRunEnvelope(input: RcRunEnvelopeInput): RcRunEnvelope {
  const envelope = buildRunEnvelopeDefaults();
  envelope.dirty_policy = input.dirtyPolicy;
  envelope.validation_profile = input.validationProfile;
  envelope.allowed_paths = input.allowedPaths;
  envelope.forbidden_paths = input.forbiddenPaths;
  envelope.repair_limit = input.repairLimit;
  envelope.advisor_mode = input.advisorMode;
  envelope.commit_policy = input.commitPolicy;
  envelope.push_policy = input.pushPolicy;
  envelope.pr_policy = input.prPolicy;
  return envelope;
}
function buildRunEnvelopeDefaults(): RcRunEnvelope {
  const envelope = {} as RcRunEnvelope;
  envelope.dirty_policy = "block_uncommitted";
  envelope.validation_profile = "auto";
  envelope.allowed_paths = [];
  envelope.forbidden_paths = [];
  envelope.repair_limit = 0;
  envelope.advisor_mode = "optional";
  envelope.commit_policy = "none";
  envelope.push_policy = "none";
  envelope.pr_policy = "none";
  envelope.active_capabilities = ["diagnose", "validate", "classify_validation_results", "detect_false_green", "read_governance"];
  envelope.inactive_capabilities = ["plan", "repair", "full", "commit", "push", "pull_request"];
  return envelope;
}
type RcRunEnvelopeInput = {
  dirtyPolicy: RcDirtyPolicy;
  validationProfile: RcValidationProfile;
  allowedPaths: string[];
  forbiddenPaths: string[];
  repairLimit: number;
  advisorMode: RcAdvisorMode;
  commitPolicy: RcCommitPolicy;
  pushPolicy: RcPushPolicy;
  prPolicy: RcPrPolicy;
};

type RcEvidenceArtifactModel = {
  write_enabled: boolean;
  run_id: string;
  run_dir: string;
  diagnostic_report_path: string;
  validation_report_path: string;
  ai_review_result_path: string;
  readiness_report_path: string;
  manifest_path: string;
  note: string;
};

function buildEvidenceArtifactModel(component: string | null, target: string | null, mode: RcMode): RcEvidenceArtifactModel {
  return buildEvidenceArtifactDefaults(buildRunId(component, target, mode));
}

function buildRunId(component: string | null, target: string | null, mode: RcMode): string {
  const raw = [component ?? "workspace", target ?? "diagnostic", mode].join("-");
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workspace-diagnostic";
}
function buildEvidenceArtifactDefaults(runId: string): RcEvidenceArtifactModel {
  const evidence = {} as RcEvidenceArtifactModel;
  const runDir = `var/rc-run/${runId}`;
  evidence.write_enabled = false;
  evidence.run_id = runId;
  evidence.run_dir = runDir;
  populateEvidenceArtifactPaths(evidence, runDir);
  return evidence;
}
function populateEvidenceArtifactPaths(evidence: RcEvidenceArtifactModel, runDir: string): void {
  evidence.diagnostic_report_path = `${runDir}/diagnostic.json`;
  evidence.validation_report_path = `${runDir}/validation.json`;
  evidence.ai_review_result_path = `${runDir}/ai-review-result.json`;
  evidence.readiness_report_path = `${runDir}/readiness.json`;
  evidence.manifest_path = `${runDir}/manifest.json`;
  evidence.note = "Artifact paths are modeled only; this rc mode does not write files.";
}
type RcRepairPlanContract = {
  enabled: boolean;
  mode: "plan";
  allowed_paths: string[];
  forbidden_paths: string[];
  stop_conditions: string[];
  readiness_plan: string[];
  repair_limit: number;
  note: string;
  candidate_actions: string[];
  classification_summary: Record<string, number>;
  evidence_requirements: string[];
  manual_review_required: boolean;
};
function buildRepairPlanContract(runEnvelope: RcRunEnvelope, readiness: Record<string, unknown>): RcRepairPlanContract {
  const plan = {} as RcRepairPlanContract;
  plan.enabled = false;
  plan.mode = "plan";
  plan.allowed_paths = runEnvelope.allowed_paths;
  plan.forbidden_paths = runEnvelope.forbidden_paths;
  plan.repair_limit = runEnvelope.repair_limit;
  plan.stop_conditions = buildPlanStopConditions(readiness);
  plan.readiness_plan = buildReadinessPlan(readiness);
  plan.note = "Plan mode is contract-only and does not modify files.";
  plan.candidate_actions = buildPlanCandidateActions(readiness);
  plan.classification_summary = buildPlanClassificationSummary(readiness);
  plan.evidence_requirements = buildPlanEvidenceRequirements(readiness);
  plan.manual_review_required = plan.stop_conditions.length > 4;
  return plan;
}
function buildPlanStopConditions(readiness: Record<string, unknown>): string[] {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  const conditions = ["do_not_modify_files", "do_not_run_repair", "do_not_commit", "do_not_push"];
  return [...conditions, ...blockers.map((blocker) => `blocked_by_${blocker}`)];
}

function buildReadinessPlan(readiness: Record<string, unknown>): string[] {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  return blockers.length > 0 ? blockers.map((blocker) => `resolve_${blocker}`) : ["confirm_validation_evidence", "prepare_repair_scope_if_requested"];
}

function buildPlanCandidateActions(readiness: Record<string, unknown>): string[] {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  return blockers.map((blocker) => `prepare_fix_for_${blocker}`);
}

function buildPlanClassificationSummary(readiness: Record<string, unknown>): Record<string, number> {
  return {};
}

function buildPlanEvidenceRequirements(readiness: Record<string, unknown>): string[] {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  return blockers.includes("validation_evidence_required") ? ["diagnostic_report", "readiness_report", "ai_review_result"] : ["diagnostic_report", "readiness_report"];
}

