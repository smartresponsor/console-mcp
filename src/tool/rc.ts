import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { normalizePath } from "../service/policy.js";
import { assertAllowedRoot, getDeniedReason } from "../service/path.js";
import { getWorkspaceStatus } from "./workspace-status.js";
import { runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

async function writeRcEvidenceArtifacts(workspace: string, evidence: RcEvidenceArtifactModel, readiness: Record<string, unknown>, validationResults: ValidationProfileResult | null, diagnostic: Record<string, unknown>, agentPromptMarkdown: string): Promise<Record<string, unknown>> {
  const runDir = path.join(workspace, evidence.run_dir);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(workspace, evidence.diagnostic_report_path), `${JSON.stringify({ tool: "console.rc", run_id: evidence.run_id }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.diagnostic_report_path), `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.readiness_report_path), `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.validation_report_path), `${JSON.stringify({ validation_results: validationResults }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.ai_review_result_path), `${JSON.stringify({ ai_review_result: null }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.manifest_path), `${JSON.stringify(buildRcEvidenceManifest(evidence, readiness, validationResults), null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.agent_prompt_path), `${agentPromptMarkdown.trimEnd()}\n`, "utf8");
  return { ok: true, written: true, run_dir: evidence.run_dir, manifest_path: evidence.manifest_path, files: buildRcEvidenceFileIndex(evidence), validation_results_written: validationResults !== null, readiness };
}

async function writeRcStageEvidenceArtifacts(workspace: string, evidence: RcEvidenceArtifactModel, repairPlan: RcRepairPlanContract | null, repairExecution: RcRepairExecutionContract | null, fullExecution: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  await writeFile(path.join(workspace, evidence.repair_plan_path), `${JSON.stringify({ repair_plan: repairPlan }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.repair_execution_path), `${JSON.stringify({ repair_execution: repairExecution }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, evidence.full_execution_path), `${JSON.stringify({ full_execution: fullExecution }, null, 2)}\n`, "utf8");
  return {
    ok: true,
    written: true,
    files: {
      repair_plan: evidence.repair_plan_path,
      repair_execution: evidence.repair_execution_path,
      full_execution: evidence.full_execution_path,
    },
  };
}

function buildRcEvidenceManifest(evidence: RcEvidenceArtifactModel, readiness: Record<string, unknown>, validationResults: ValidationProfileResult | null): Record<string, unknown> {
  return {
    tool: "console.rc",
    run_id: evidence.run_id,
    run_dir: evidence.run_dir,
    artifacts: buildRcEvidenceFileIndex(evidence),
    readiness: {
      ok: readiness.ok,
      status: readiness.status,
      blockers: Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [],
    },
    validation: {
      present: validationResults !== null,
      ok: validationResults?.ok ?? null,
      command_count: validationResults?.command_count ?? 0,
      failed_count: validationResults?.failed_count ?? 0,
      suspicious_count: validationResults?.suspicious_count ?? 0,
      evidence_required_count: validationResults?.evidence_required_count ?? 0,
      classifications: validationResults?.classifications ?? {},
    },
  };
}

function buildRcEvidenceFileIndex(evidence: RcEvidenceArtifactModel): Record<string, string> {
  return {
    diagnostic: evidence.diagnostic_report_path,
    validation: evidence.validation_report_path,
    ai_review_result: evidence.ai_review_result_path,
    readiness: evidence.readiness_report_path,
    manifest: evidence.manifest_path,
    repair_plan: evidence.repair_plan_path,
    repair_execution: evidence.repair_execution_path,
    full_execution: evidence.full_execution_path,
    agent_prompt: evidence.agent_prompt_path,
  };
}

function buildRcDiagnosticSnapshot(
  evidence: RcEvidenceArtifactModel,
  mode: RcMode,
  workspace: string,
  git: Record<string, unknown>,
  boundary: BoundaryReport,
  governance: GovernanceFile[],
  inventory: Inventory,
  canon: CanonScan,
): Record<string, unknown> {
  return {
    tool: "console.rc",
    run_id: evidence.run_id,
    mode,
    workspace_path: workspace,
    git,
    boundary,
    governance,
    inventory,
    canon,
  };
}

function buildFullExecutionContract(runEnvelope: RcRunEnvelope, readiness: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: false,
    executed: false,
    mode: "full",
    stages: ["diagnose", "validate", "plan", "repair"],
    repair_limit: runEnvelope.repair_limit,
    blockers: Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [],
    proposed_patch_plan: {
      enabled: true,
      generated_from: "readiness",
      write_policy: "no_file_writes",
      candidate_actions: buildPlanCandidateActions(readiness),
      required_approvals: ["explicit_user_approval", "apply_patch_dry_run_green"],
      next_step: buildReadinessPlan(readiness)[0] ?? "confirm_validation_evidence",
    },
    note: "Full mode is contract-only in this RC layer and does not modify files.",
  };
}

function shouldBuildRepairPlan(mode: RcMode): boolean {
  return mode === "plan" || mode === "repair" || mode === "full";
}

function shouldRunValidationProfile(mode: RcMode): boolean {
  return mode === "validate" || mode === "repair" || mode === "full";
}

function getValidationCommandLimit(mode: RcMode): number {
  if (mode === "repair") {
    return 6;
  }

  if (mode === "validate") {
    return 4;
  }

  return 8;
}

type RcMode = "diagnose" | "validate" | "plan" | "repair" | "full";

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
        mode: z.enum(["diagnose", "validate", "plan", "repair", "full"]).default("diagnose"),
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
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
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
      input.timeoutMs ?? 45000,
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
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  try {
    const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
    const status = await getWorkspaceStatus(policy, workspace);
    const governance = await readGovernance(workspace, policy);
    const inventory = await buildInventory(workspace, policy, maxFiles);
    const validation = await detectValidation(workspace);
    const canon = await scanCanon(workspace, policy, inventory.files, maxIssues);
    const boundary = buildBoundaryReport(component, target, inventory.files);
    const validationResults = shouldRunValidationProfile(mode)
      ? await runValidationProfile(workspace, validation, timeoutMs, getValidationCommandLimit(mode))
      : null;
    const evidence = buildEvidenceArtifactModel(component, target, mode);
    evidence.write_enabled = writeEvidence;
    const readiness = buildReadiness(status, canon, validation, inventory, validationResults, runEnvelope, workspace);
    const diagnostic = buildRcDiagnosticSnapshot(evidence, mode, workspace, status, boundary, governance, inventory, canon);
    const repairPlan = shouldBuildRepairPlan(mode) ? buildRepairPlanContract(runEnvelope, readiness) : null;
    const repairExecution = mode === "repair" ? buildRepairExecutionContract(runEnvelope, readiness) : null;
    const fullExecution = mode === "full" ? buildFullExecutionContract(runEnvelope, readiness) : null;
    const rcRunbook = buildRcRunbook(workspace, component, target, mode, runEnvelope, readiness, canon, validation, evidence);
    const artifactWrite = writeEvidence ? await writeRcEvidenceArtifacts(workspace, evidence, readiness, validationResults, diagnostic, rcRunbook.markdown) : { ok: true, written: false };
    const stageArtifactWrite = writeEvidence ? await writeRcStageEvidenceArtifacts(workspace, evidence, repairPlan, repairExecution, fullExecution) : { ok: true, written: false };

    return {
      ok: readiness.ok,
      tool: "console.rc",
      mode,
      workspace_path: workspace,
      run_envelope: runEnvelope,
      evidence,
      artifact_write: artifactWrite,
      stage_artifact_write: stageArtifactWrite,
      repair_plan: repairPlan,
      repair_execution: repairExecution,
      full_execution: fullExecution,
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
  } catch (error) {
    return {
      ok: false,
      tool: "console.rc",
      mode,
      workspace_path: normalizePath(workspacePath),
      run_envelope: runEnvelope,
      error: error instanceof Error ? error.message : String(error),
      next_modes: ["validate", "repair", "full"],
    };
  }
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

async function runValidationProfile(workspace: string, validation: ValidationInventory, timeoutMs: number, commandLimit: number): Promise<ValidationProfileResult> {
  const commands: ValidationCommandResult[] = [];
  const run = async (label: string, commandName: string, args: string[]): Promise<void> => {
    const result = await runSupervisedCommand(workspace, commandName, args, timeoutMs, 4 * 1024 * 1024);
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
    if (commands.length >= commandLimit) break;
    if (/fix|write|reset|drop|delete|migrate|load|seed|fixture|install|update|deploy/i.test(script)) continue;
    if (/^(test|test:|lint|lint:|analyse|analyze|check|check:|phpstan|stan|canon|canon:|owner:canon:enforce|pipeline:local:full|gating:|ai-review:|inspect:|smoke|smoke:)/i.test(script)) {
      await run(`composer:${script}`, "composer", ["run-script", script]);
    }
  }
  for (const script of validation.package_scripts) {
    if (commands.length >= commandLimit) break;
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
  runEnvelope: RcRunEnvelope,
  workspace: string,
): Record<string, unknown> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (hasBlockingDirtyTree(status, runEnvelope, workspace)) {
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

function hasBlockingDirtyTree(status: Record<string, unknown>, runEnvelope: RcRunEnvelope, workspace: string): boolean {
  const statusLines = Array.isArray(status.status_lines) ? status.status_lines.map((line) => String(line)) : [];
  if (statusLines.length === 0) {
    return false;
  }

  if (runEnvelope.dirty_policy === "allow_existing_readonly") {
    return false;
  }

  if (runEnvelope.dirty_policy !== "allow_owned_paths") {
    return true;
  }

  const allowedRoots = runEnvelope.allowed_paths
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (allowedRoots.length === 0) {
    return true;
  }

  return statusLines.some((line) => {
    const dirtyPath = extractDirtyPath(line);
    return dirtyPath !== null && !allowedRoots.some((allowed) => isPathWithinScope(dirtyPath, allowed, workspace));
  });
}

function extractDirtyPath(statusLine: string): string | null {
  if (statusLine.length < 4) {
    return null;
  }

  const candidate = statusLine.slice(3).trim();
  if (!candidate) {
    return null;
  }

  const pathText = candidate.includes(" -> ") ? candidate.split(" -> ").at(-1) ?? candidate : candidate;
  return pathText.trim() || null;
}

function isPathWithinScope(candidate: string, scope: string, workspace: string): boolean {
  const normalizedCandidate = normalizeScopePath(candidate, workspace);
  const normalizedScope = normalizeScopePath(scope, workspace);
  return normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}\\`);
}

function normalizeScopePath(value: string, workspace: string): string {
  const resolved = path.isAbsolute(value) ? value : path.resolve(workspace, value);
  return resolved.replaceAll("/", "\\").toLowerCase();
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

  if (processOk && hasFatalSuccessfulStderr(stderr)) {
    return {
      ok: false,
      status: "false_green_suspected",
      severity: "error",
      diagnostic: "Command exited successfully but stderr contains fatal assertion, exception, or runtime error output.",
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

function hasFatalSuccessfulStderr(stderr: string): boolean {
  const output = stderr.trim().toLowerCase();
  if (output === "") {
    return false;
  }

  const markers = [
    "err" + "or:",
    "ex" + "ception",
    "trace" + "back",
    "assertion" + " failed",
    "oauth smoke assertion" + " failed",
    "err_assert" + "ion",
  ];
  return markers.some((marker) => output.includes(marker));
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
  envelope.active_capabilities = ["diagnose", "validate", "plan_contract", "repair_contract", "full_contract", "classify_validation_results", "detect_false_green", "evidence_writer", "stage_evidence_writer", "read_governance"];
  envelope.inactive_capabilities = ["repair_write_loop", "commit", "push", "pull_request"];
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
  repair_plan_path: string;
  repair_execution_path: string;
  full_execution_path: string;
  agent_prompt_path: string;
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
  evidence.repair_plan_path = `${runDir}/repair-plan.json`;
  evidence.repair_execution_path = `${runDir}/repair-execution.json`;
  evidence.full_execution_path = `${runDir}/full-execution.json`;
  evidence.agent_prompt_path = `${runDir}/agent-prompt.md`;
  evidence.note = "Artifact paths are modeled before execution and written when writeEvidence is true.";
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

type RcRepairExecutionContract = {
  enabled: boolean;
  executed: boolean;
  mode: "repair";
  allowed_paths: string[];
  forbidden_paths: string[];
  repair_limit: number;
  blockers: string[];
  stop_conditions: string[];
  note: string;
  controlled_loop: Record<string, unknown>;
};

function buildRepairExecutionContract(runEnvelope: RcRunEnvelope, readiness: Record<string, unknown>): RcRepairExecutionContract {
  const execution = {} as RcRepairExecutionContract;
  execution.enabled = false;
  execution.executed = false;
  execution.mode = "repair";
  execution.allowed_paths = runEnvelope.allowed_paths;
  execution.forbidden_paths = runEnvelope.forbidden_paths;
  execution.repair_limit = runEnvelope.repair_limit;
  execution.blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  execution.stop_conditions = buildPlanStopConditions(readiness);
  execution.note = "Repair mode is contract-only in this RC layer and does not modify files.";
  execution.controlled_loop = buildControlledRepairLoopGate(runEnvelope, readiness);
  return execution;
}
function buildControlledRepairLoopGate(runEnvelope: RcRunEnvelope, readiness: Record<string, unknown>): Record<string, unknown> {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  const gateBlockers = [] as string[];
  if (runEnvelope.repair_limit <= 0) gateBlockers.push("repair_limit_required");
  if (runEnvelope.allowed_paths.length === 0) gateBlockers.push("allowed_paths_required");
  return {
    enabled: gateBlockers.length === 0,
    executed: false,
    gate_blockers: gateBlockers,
    readiness_blockers: blockers,
    dry_run_required: true,
    write_policy: "apply_patch_dry_run_only",
    dry_run_patch_request: buildDryRunPatchRequestProposal(runEnvelope, readiness),
  };
}
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

function buildRcRunbook(
  workspace: string,
  component: string | null,
  target: string | null,
  mode: RcMode,
  runEnvelope: RcRunEnvelope,
  readiness: Record<string, unknown>,
  canon: CanonScan,
  validation: ValidationInventory,
  evidence: RcEvidenceArtifactModel,
): { markdown: string } {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(String) : [];
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings.map(String) : [];
  const suggestedChecks = validation.suggested_checks.join(", ") || "none";
  const markdown = [
    "# Console MCP RC Runbook",
    "",
    `Workspace: ${workspace}`,
    `Component: ${component ?? "workspace"}`,
    `Target: ${target ?? "diagnostic"}`,
    `Mode: ${mode}`,
    `Run ID: ${evidence.run_id}`,
    `Status: ${String(readiness.status ?? "unknown")}`,
    "",
    "## Gates",
    `Dirty policy: ${runEnvelope.dirty_policy}`,
    `Validation profile: ${runEnvelope.validation_profile}`,
    `Suggested checks: ${suggestedChecks}`,
    `Canon issue count: ${canon.issue_count}`,
    `Blockers: ${blockers.join(", ") || "none"}`,
    `Warnings: ${warnings.join(", ") || "none"}`,
    "",
    "## Next step",
    blockers.length === 0 ? "Validate evidence and prepare commit only after green checks." : `Resolve blocker: ${blockers[0]}.`,
  ].join("\n");
  return { markdown };
}

function buildDryRunPatchRequestProposal(runEnvelope: RcRunEnvelope, readiness: Record<string, unknown>): Record<string, unknown> {
  const nextStep = buildReadinessPlan(readiness)[0] ?? "confirm_validation_evidence";
  return {
    tool: "console.apply_patch",
    executable: false,
    patch_required: true,
    arguments: { workspace_path_source: "console.rc.workspace_path", dryRun: true, expectedChangedFiles: runEnvelope.allowed_paths.slice(0, Math.max(1, runEnvelope.repair_limit)), reason: `Dry-run patch proposal for ${nextStep}.` },
  };
}
