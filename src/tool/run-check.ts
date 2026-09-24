import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { AllowedCheck, ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { runNamedCheck, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { getAsyncCommandRunOutput, getAsyncCommandRunStatus, startAsyncCommandRun, stopAsyncCommandRun } from "../Infrastructure/Process/AsyncCommandRun.js";
import { buildRepositoryExecutionFingerprint } from "../Infrastructure/Process/RepositoryExecutionFingerprint.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

export function registerRunCheckTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);
  server.registerTool(
    "console.read_.repo.gate.check.run",
    {
      description: "Run a named check from policy/allowed-check.json only.",
      inputSchema: z.object({ workspacePath: z.string().min(1), checkName: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath, checkName }) => textResult(await executeNamedCheck(policy, baseDir, workspacePath, checkName))
  );

  server.registerTool(
    "console.write.repo.gate.check.start",
    {
      description: "Start a named allowed check asynchronously and return a durable run ID immediately.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        checkName: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
      }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, checkName, timeoutMs }) => textResult(await startNamedCheck(policy, workspacePath, checkName, timeoutMs))
  );

  server.registerTool(
    "console.read_.repo.gate.check.status",
    {
      description: "Read lifecycle status for an asynchronous named check run.",
      inputSchema: z.object({ workspacePath: z.string().min(1), runId: z.string().uuid() }).strict(),
      ...registration,
    },
    async ({ workspacePath, runId }) => textResult(await getAsyncCommandRunStatus(assertAllowedRoot(workspacePath, policy.allowedRoots), runId))
  );

  server.registerTool(
    "console.read_.repo.gate.check.output",
    {
      description: "Read incremental stdout/stderr for an asynchronous named check run.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        runId: z.string().uuid(),
        stdoutOffset: z.number().int().min(0).optional(),
        stderrOffset: z.number().int().min(0).optional(),
        limitBytes: z.number().int().min(1024).max(262144).optional(),
      }).strict(),
      ...registration,
    },
    async (input) => textResult(await getAsyncCommandRunOutput({
      ...input,
      workspacePath: assertAllowedRoot(input.workspacePath, policy.allowedRoots),
    }))
  );

  server.registerTool(
    "console.write.repo.gate.check.stop",
    {
      description: "Stop an asynchronous named check run.",
      inputSchema: z.object({ workspacePath: z.string().min(1), runId: z.string().uuid(), confirmStop: z.boolean().default(false) }).strict(),
      ...mutationRegistration,
    },
    async ({ workspacePath, runId, confirmStop }) => textResult(await stopAsyncCommandRun(assertAllowedRoot(workspacePath, policy.allowedRoots), runId, confirmStop))
  );
}

export async function executeNamedCheck(policy: ConsolePolicy, baseDir: string, workspacePath: string, checkName: string): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const check = await resolveCheckDefinition(policy, workspace, checkName);

  if (!check) {
    throw new Error(`Unknown check name: ${checkName}`);
  }

  const result = await runNamedCheck(baseDir, checkName, workspace, check);
  const stdout = truncateText(sanitizeText(result.stdout), 12000);
  const stderr = truncateText(sanitizeText(result.stderr), 12000);

  const targetCapabilityMissing = isTargetCapabilityMissing(checkName, stderr.text);
  const ok = result.exitCode === 0 || targetCapabilityMissing;

  return {
    ok,
    status: targetCapabilityMissing ? "SKIPPED" : result.exitCode === 0 ? "PASS" : "FAIL",
    classification: targetCapabilityMissing ? "TARGET_CAPABILITY_MISSING" : result.exitCode === 0 ? "PASSED" : "CHECK_FAILED",
    gate_effect: targetCapabilityMissing ? "NEUTRAL" : result.exitCode === 0 ? "PASS" : "BLOCKING",
    check_name: checkName,
    command: [result.command, ...result.args].join(" "),
    cwd: result.cwd,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    stdout: stdout.text,
    stdout_truncated: stdout.truncated,
    stderr: stderr.text,
    stderr_truncated: stderr.truncated,
    transcript_path: result.transcriptPath,
  };
}

async function startNamedCheck(policy: ConsolePolicy, workspacePath: string, checkName: string, timeoutMs?: number): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const check = await resolveCheckDefinition(policy, workspace, checkName);
  if (!check) {
    throw new Error(`Unknown check name: ${checkName}`);
  }
  const operationInputs = {
    operation: "repo.gate.check",
    checkName,
    command: check.command,
    args: check.args,
    timeoutMs: timeoutMs ?? check.timeoutMs ?? policy.allowedChecks.defaultTimeoutMs,
  };
  const repositoryFingerprint = await buildRepositoryExecutionFingerprint(workspace, operationInputs);

  return {
    check_name: checkName,
    ...(await startAsyncCommandRun({
      workspacePath: workspace,
      command: check.command,
      args: check.args,
      timeoutMs: operationInputs.timeoutMs,
      kind: `gate-check:${checkName}`,
      dedupe: {
        operationKey: JSON.stringify(operationInputs),
        repositoryFingerprint,
        reuseSuccessful: true,
        recentResultTtlMs: 10 * 60 * 1000,
      },
    })),
  };
}

async function resolveCheckDefinition(policy: ConsolePolicy, workspace: string, checkName: string): Promise<AllowedCheck | null> {
  const direct = policy.allowedChecks.checks[checkName];
  if (direct) {
    return direct;
  }

  if (!isSafeComposerScriptName(checkName)) {
    return null;
  }

  const composerPath = path.join(workspace, "composer.json");
  if (!existsSync(composerPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(composerPath, "utf8")) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
      return null;
    }

    if (!(checkName in parsed.scripts)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    command: "composer",
    args: ["run-script", checkName],
    cwdMode: "workspaceRoot",
    timeoutMs: policy.allowedChecks.defaultTimeoutMs,
  };
}

function isSafeComposerScriptName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$/.test(name);
}

function isTargetCapabilityMissing(checkName: string, stderr: string): boolean {
  if (!checkName.includes(".composer.script.")) {
    return false;
  }

  return /Script \"[^\"]+\" is not defined in this package/i.test(stderr);
}

