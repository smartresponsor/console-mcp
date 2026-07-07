import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must be owner/repo");
const ownerSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, "owner must be GitHub owner or organization");
const runIdSchema = z.number().int().positive();
const jobIdSchema = z.number().int().positive();
const limitSchema = z.number().int().positive().max(100).optional();
const workflowOutputLimit = 120000;
const workflowCommandTimeoutMs = 120000;
const workflowCommandMaxBuffer = 16 * 1024 * 1024;

type WorkflowToolboxResult = {
  ok: boolean;
  command: string;
  message: string;
  data: unknown;
};

export function registerGitHubWorkflowTools(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);

  server.registerTool(
    "console.read_.github.workflow.run.jobs",
    {
      description: "Read GitHub Actions jobs for a workflow run through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), repo: repoSchema, runId: runIdSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, repo, runId }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, ["workflow:run:jobs", repo, String(runId)])),
  );

  server.registerTool(
    "console.read_.github.workflow.job.log",
    {
      description: "Read a GitHub Actions job log through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), repo: repoSchema, runId: runIdSchema, jobId: jobIdSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, repo, runId, jobId }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, ["workflow:job:log", repo, String(runId), String(jobId)])),
  );

  server.registerTool(
    "console.read_.github.workflow.run.failed_log",
    {
      description: "Read failed GitHub Actions logs for a workflow run through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), repo: repoSchema, runId: runIdSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, repo, runId }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, ["workflow:run:log-failed", repo, String(runId)])),
  );

  server.registerTool(
    "console.read_.github.workflow.failure.card",
    {
      description: "Build a read-only GitHub Actions failure card through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), repo: repoSchema, runId: runIdSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, repo, runId }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, ["actions:failure-card", repo, String(runId)])),
  );

  server.registerTool(
    "console.read_.github.workflow.owner.failed_harvest",
    {
      description: "Harvest failed GitHub Actions workflow runs across an owner or organization through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), owner: ownerSchema, repoLimit: limitSchema, runLimit: limitSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, owner, repoLimit, runLimit }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, buildOptionalLimitArgs("workflow:failed:harvest", owner, repoLimit, runLimit))),
  );

  server.registerTool(
    "console.read_.github.fleet.scan",
    {
      description: "Scan GitHub repositories across an owner or organization through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), owner: ownerSchema, limit: limitSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, owner, limit }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, buildOptionalLimitArgs("fleet:scan", owner, limit))),
  );

  server.registerTool(
    "console.read_.github.fleet.digest",
    {
      description: "Build a GitHub fleet digest for an owner or organization through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), owner: ownerSchema, limit: limitSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, owner, limit }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, buildOptionalLimitArgs("fleet:digest", owner, limit))),
  );

  server.registerTool(
    "console.read_.github.fleet.triage",
    {
      description: "Build a GitHub fleet triage snapshot for an owner or organization through github-toolbox.",
      inputSchema: z.object({ workspacePath: z.string().min(1), owner: ownerSchema, limit: limitSchema }).strict(),
      ...registration,
    },
    async ({ workspacePath, owner, limit }) => textResult(await runToolboxCommand(policy, baseDir, workspacePath, buildOptionalLimitArgs("fleet:triage", owner, limit))),
  );
}

function buildOptionalLimitArgs(command: string, owner: string, firstLimit?: number, secondLimit?: number): string[] {
  const args = [command, owner];

  if (secondLimit !== undefined) {
    args.push(String(firstLimit ?? 50), String(secondLimit));
    return args;
  }

  if (firstLimit !== undefined) {
    args.push(String(firstLimit));
  }

  return args;
}

async function runToolboxCommand(policy: ConsolePolicy, baseDir: string, workspacePath: string, args: string[]): Promise<Record<string, unknown>> {
  const workspaceRoot = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const toolboxRoot = assertAllowedRoot(path.resolve(baseDir, "..", "github-toolbox"), policy.allowedRoots);
  const cliPath = path.join(toolboxRoot, "dist", "cli", "GitHubToolboxCli.js");

  if (!existsSync(cliPath)) {
    return {
      ok: false,
      status: "GITHUB_TOOLBOX_CLI_NOT_BUILT",
      message: "github-toolbox dist CLI was not found. Build github-toolbox before using this bridge.",
      workspaceRoot,
      toolboxRoot,
      cliPath,
    };
  }

  const commandArgs = [cliPath, ...args];
  const result = await runSupervisedCommand(toolboxRoot, "node", commandArgs, workflowCommandTimeoutMs, workflowCommandMaxBuffer);
  const stdout = truncateOutput(result.stdout, workflowOutputLimit);
  const stderr = truncateOutput(result.stderr, 30000);
  const parsed = parseToolboxStdout(result.stdout);

  return {
    ok: result.ok && parsed.ok,
    status: parsed.ok ? "OK" : "GITHUB_TOOLBOX_OUTPUT_PARSE_FAILED",
    command: ["node", ...commandArgs].join(" "),
    cwd: result.cwd,
    workspaceRoot,
    exitCode: result.exitCode,
    stdout: parsed.ok ? undefined : stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    result: parsed.ok ? trimToolboxResult(parsed.value) : null,
  };
}

function parseToolboxStdout(stdout: string): { ok: true; value: WorkflowToolboxResult } | { ok: false } {
  try {
    const parsed = JSON.parse(stdout) as WorkflowToolboxResult;
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

function trimToolboxResult(result: WorkflowToolboxResult): WorkflowToolboxResult & { dataTruncated?: boolean } {
  const data = trimLogPayload(result.data);
  return {
    ...result,
    data: data.value,
    ...(data.truncated ? { dataTruncated: true } : {}),
  };
}

function trimLogPayload(value: unknown): { value: unknown; truncated: boolean } {
  if (!isRecord(value) || typeof value.log !== "string") {
    return { value, truncated: false };
  }

  const trimmed = truncateOutput(value.log, workflowOutputLimit);
  return {
    value: {
      ...value,
      log: trimmed.text,
      logTruncated: trimmed.truncated,
    },
    truncated: trimmed.truncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
