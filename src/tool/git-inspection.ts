import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const outputLimit = 30000;

export function registerGitInspectionTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);

  server.registerTool(
    "console.git_diff",
    {
      description: "Show git diff for a workspace, optionally limited to one repository path.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        filePath: z.string().min(1).optional(),
        cached: z.boolean().optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath, cached }) => textResult(await gitText(policy, workspacePath, buildDiffArgs(filePath, Boolean(cached))))
  );

  server.registerTool(
    "console.git_diff_stat",
    {
      description: "Show git diff --stat for a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        cached: z.boolean().optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, cached }) => textResult(await gitText(policy, workspacePath, Boolean(cached) ? ["diff", "--cached", "--stat"] : ["diff", "--stat"]))
  );

  server.registerTool(
    "console.git_log_file",
    {
      description: "Show recent git log entries for a repository file.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        filePath: z.string().min(1),
        maxCount: z.number().int().positive().max(100).optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath, maxCount }) => textResult(await gitText(policy, workspacePath, ["log", `--max-count=${Math.min(maxCount ?? 20, 100)}`, "--oneline", "--decorate", "--", normalizeRepoPath(filePath)]))
  );

  server.registerTool(
    "console.git_show_file",
    {
      description: "Show file content from a specific git commit using commit:path syntax.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        commit: z.string().min(1),
        filePath: z.string().min(1),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, commit, filePath }) => textResult(await gitText(policy, workspacePath, ["show", `${sanitizeCommitish(commit)}:${normalizeRepoPath(filePath)}`]))
  );

  server.registerTool(
    "console.git_grep",
    {
      description: "Run git grep with an optional repository pathspec.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        pattern: z.string().min(1),
        filePath: z.string().min(1).optional(),
        maxMatches: z.number().int().positive().max(500).optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, pattern, filePath, maxMatches }) => textResult(await gitText(policy, workspacePath, buildGrepArgs(pattern, filePath, maxMatches)))
  );

  server.registerTool(
    "console.git_reflog_search",
    {
      description: "Search recent git reflog entries for a text fragment.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        query: z.string().min(1),
        maxCount: z.number().int().positive().max(200).optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, query, maxCount }) => textResult(await gitReflogSearch(policy, workspacePath, query, maxCount ?? 100))
  );

  server.registerTool(
    "console.git_commit",
    {
      description: "Stage explicit repository files and create a git commit with the provided message.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        files: z.array(z.string().min(1)).min(1).max(50),
        message: z.string().min(1).max(200),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, files, message }) => textResult(await gitCommit(policy, workspacePath, files, message))
  );
}

function buildDiffArgs(filePath: string | undefined, cached: boolean): string[] {
  const args = cached ? ["diff", "--cached"] : ["diff"];
  if (filePath) {
    args.push("--", normalizeRepoPath(filePath));
  }

  return args;
}

function buildGrepArgs(pattern: string, filePath: string | undefined, maxMatches: number | undefined): string[] {
  const args = ["grep", "-n", "-I", "--full-name", "-m", String(Math.min(maxMatches ?? 100, 500)), "--", pattern];
  if (filePath) {
    args.push(normalizeRepoPath(filePath));
  }

  return args;
}

async function gitText(policy: ConsolePolicy, workspacePath: string, args: string[]): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, "git", args, 30000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, outputLimit);
  const stderr = truncateOutput(result.stderr, outputLimit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function gitCommit(policy: ConsolePolicy, workspacePath: string, files: string[], message: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const uniqueFiles = [...new Set(files.map((file) => normalizeRepoPath(file)))];
  const normalizedMessage = message.trim();
  if (normalizedMessage === "") {
    throw new Error("Commit message must not be empty.");
  }

  const addArgs = ["add", "--", ...uniqueFiles];
  const addResult = await runSupervisedCommand(cwd, "git", addArgs, 30000, 4 * 1024 * 1024);
  if (!addResult.ok) {
    const stdout = truncateOutput(addResult.stdout, outputLimit);
    const stderr = truncateOutput(addResult.stderr, outputLimit);
    return { ok: false, stage: "add", command: ["git", ...addArgs].join(" "), cwd, exitCode: addResult.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
  }

  const commitArgs = ["commit", "-m", normalizedMessage];
  const commitResult = await runSupervisedCommand(cwd, "git", commitArgs, 30000, 4 * 1024 * 1024);
  const stdout = truncateOutput(commitResult.stdout, outputLimit);
  const stderr = truncateOutput(commitResult.stderr, outputLimit);
  return { ok: commitResult.ok, stage: "commit", command: ["git", ...commitArgs].join(" "), cwd, files: uniqueFiles, message: normalizedMessage, exitCode: commitResult.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function gitReflogSearch(policy: ConsolePolicy, workspacePath: string, query: string, maxCount: number): Promise<Record<string, unknown>> {
  const result = await gitText(policy, workspacePath, ["reflog", "--date=iso", `--max-count=${Math.min(maxCount, 200)}`]);
  const lines = String(result.stdout || "").split(/\r?\n/).filter((line) => line.toLowerCase().includes(query.toLowerCase()));
  return { ...result, query, matches: lines.slice(0, Math.min(maxCount, 200)), matchCount: lines.length };
}

function sanitizeCommitish(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/@{}~^:-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Commit value contains unsupported characters.");
  }

  return normalized;
}
