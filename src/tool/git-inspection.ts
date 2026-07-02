import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const outputLimit = 30000;

export function registerGitInspectionTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);

  registerGitDiffTool(server, policy, registration, "console.read_.repo.git.diff", "Show git diff for a workspace, optionally limited to one repository path.");
  registerGitDiffStatTool(server, policy, registration, "console.read_.repo.git.diff.stat", "Show git diff --stat for a workspace.");
  registerGitGrepTool(server, policy, registration, "console.read_.repo.git.grep", "Run git grep with an optional repository pathspec.");
  registerGitLogFileTool(server, policy, registration, "console.read_.repo.git.file.log", "Show recent git log entries for a repository file.");
  registerGitReflogSearchTool(server, policy, registration, "console.read_.repo.git.reflog.search", "Search recent git reflog entries for a text fragment.");
  registerGitShowFileTool(server, policy, registration, "console.read_.repo.git.file.show", "Show file content from a specific git commit using commit:path syntax.");
  registerGitCommitTool(server, policy, mutationRegistration, "console.write.repo.git.commit.signed", "Canonical alias for console.git_commit. Always creates a signed git commit.");

  server.registerTool(
    "console.git_commit",
    {
      description: "Stage explicit repository files and create a git commit with the provided message.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        files: z.array(z.string().min(1)).min(1).max(50),
        message: z.string().min(1).max(200),
      }).strict(),
      ...mutationRegistration,
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

function registerGitDiffTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), filePath: z.string().min(1).optional(), cached: z.boolean().optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath, cached }) => textResult(await gitText(policy, workspacePath, buildDiffArgs(filePath, Boolean(cached))))
  );
}

function registerGitDiffStatTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), cached: z.boolean().optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, cached }) => textResult(await gitText(policy, workspacePath, Boolean(cached) ? ["diff", "--cached", "--stat"] : ["diff", "--stat"]))
  );
}

function registerGitGrepTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), pattern: z.string().min(1), filePath: z.string().min(1).optional(), maxMatches: z.number().int().positive().max(500).optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, pattern, filePath, maxMatches }) => textResult(await gitText(policy, workspacePath, buildGrepArgs(pattern, filePath, maxMatches)))
  );
}

function registerGitLogFileTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), filePath: z.string().min(1), maxCount: z.number().int().positive().max(100).optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath, maxCount }) => textResult(await gitText(policy, workspacePath, ["log", `--max-count=${Math.min(maxCount ?? 20, 100)}`, "--oneline", "--decorate", "--", normalizeRepoPath(filePath)]))
  );
}

function registerGitShowFileTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), commit: z.string().min(1), filePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath, commit, filePath }) => textResult(await gitText(policy, workspacePath, ["show", `${sanitizeCommitish(commit)}:${normalizeRepoPath(filePath)}`]))
  );
}

function registerGitReflogSearchTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), query: z.string().min(1), maxCount: z.number().int().positive().max(200).optional() }).strict(),
      ...registration,
    },
    async ({ workspacePath, query, maxCount }) => textResult(await gitReflogSearch(policy, workspacePath, query, maxCount ?? 100))
  );
}

function registerGitCommitTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
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

  const commitArgs = ["commit", "-S", "-m", normalizedMessage];
  let commitResult = await runSupervisedCommand(cwd, "git", commitArgs, 30000, 4 * 1024 * 1024);
  let signingRecovery: Record<string, unknown> | null = null;
  if (!commitResult.ok && shouldAttemptSshSigningRecovery(commitResult.stderr)) {
    signingRecovery = await recoverSshSigningAgent(cwd);
    if (signingRecovery.ok === true) {
      commitResult = await runSupervisedCommand(cwd, "git", commitArgs, 30000, 4 * 1024 * 1024);
    }
  }

  const stdout = truncateOutput(commitResult.stdout, outputLimit);
  const stderr = truncateOutput(commitResult.stderr, outputLimit);
  const diagnostics = commitResult.ok ? null : await buildCommitFailureDiagnostics(cwd, stderr.text, signingRecovery);
  return {
    ok: commitResult.ok,
    stage: "commit",
    command: ["git", ...commitArgs].join(" "),
    cwd,
    files: uniqueFiles,
    message: normalizedMessage,
    exitCode: commitResult.exitCode,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    signingRecovery,
    diagnostics,
  };
}

async function buildCommitFailureDiagnostics(cwd: string, stderr: string, signingRecovery: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  const configKeys = [
    "commit.gpgsign",
    "gpg.format",
    "gpg.program",
    "gpg.ssh.program",
    "user.email",
    "user.name",
    "user.signingkey",
  ];
  const config: Record<string, unknown> = {};
  for (const key of configKeys) {
    config[key] = await readGitConfigValue(cwd, key);
  }

  return {
    probableCause: inferCommitFailureCause(stderr),
    signedCommitPolicy: "console.git_commit always uses git commit -S and does not fall back to unsigned commits.",
    signingRecovery,
    environmentPresence: buildSigningEnvironmentPresence(),
    config,
  };
}

async function readGitConfigValue(cwd: string, key: string): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(cwd, "git", ["config", "--show-origin", "--get", key], 30000, 1024 * 1024);
  const stdout = truncateOutput(result.stdout, outputLimit);
  const stderr = truncateOutput(result.stderr, outputLimit);
  return {
    configured: result.ok,
    exitCode: result.exitCode,
    stdout: stdout.text.trim(),
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text.trim(),
    stderrTruncated: stderr.truncated,
  };
}

function inferCommitFailureCause(stderr: string): string {
  if (/agent refused operation|sshsig_wrap_sign|sshsig_sign_fd/i.test(stderr)) {
    return "ssh_signing_agent_refused_operation";
  }

  if (/gpg failed to sign|failed to write commit object|sign/i.test(stderr)) {
    return "commit_signing_failed_or_non_interactive_signer";
  }

  return "git_commit_failed";
}

function buildSigningEnvironmentPresence(): Record<string, boolean> {
  return Object.fromEntries([
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GPG_TTY",
    "GNUPGHOME",
    "PINENTRY_USER_DATA",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
  ].map((name) => [name, typeof process.env[name] === "string" && String(process.env[name]).trim() !== ""]));
}

function shouldAttemptSshSigningRecovery(stderr: string): boolean {
  return /agent refused operation|sshsig_wrap_sign|sshsig_sign_fd/i.test(stderr);
}

async function recoverSshSigningAgent(cwd: string): Promise<Record<string, unknown>> {
  const format = await readGitConfigPlainValue(cwd, "gpg.format");
  if (format !== "ssh") {
    return { ok: false, attempted: false, reason: "git_signing_format_is_not_ssh", format };
  }

  const signingKey = await readGitConfigPlainValue(cwd, "user.signingkey");
  if (!signingKey) {
    return { ok: false, attempted: false, reason: "user_signingkey_is_not_configured" };
  }

  const publicKeyPath = path.resolve(cwd, signingKey);
  const privateKeyPath = publicKeyPath.toLowerCase().endsWith(".pub") ? publicKeyPath.slice(0, -4) : publicKeyPath;
  if (!existsSync(privateKeyPath)) {
    return { ok: false, attempted: false, reason: "private_signing_key_not_found", publicKeyPath, privateKeyPath };
  }

  const before = await testSshSigning(publicKeyPath);
  if (before.ok) {
    return { ok: true, attempted: false, reason: "ssh_signing_already_available", publicKeyPath, privateKeyPath };
  }

  const removeResult = await runSupervisedCommand(cwd, "ssh-add", ["-d", privateKeyPath], 30000, 1024 * 1024);
  const addResult = await runSupervisedCommand(cwd, "ssh-add", [privateKeyPath], 30000, 1024 * 1024);
  const after = await testSshSigning(publicKeyPath);

  return {
    ok: after.ok,
    attempted: true,
    reason: after.ok ? "ssh_signing_agent_reloaded" : "ssh_signing_agent_reload_failed",
    publicKeyPath,
    privateKeyPath,
    removeExitCode: removeResult.exitCode,
    addExitCode: addResult.exitCode,
    before,
    after,
  };
}

async function readGitConfigPlainValue(cwd: string, key: string): Promise<string | null> {
  const result = await runSupervisedCommand(cwd, "git", ["config", "--get", key], 30000, 1024 * 1024);
  if (!result.ok) {
    return null;
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function testSshSigning(publicKeyPath: string): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "console-mcp-ssh-sign-"));
  const payloadPath = path.join(tempDir, "payload.txt");
  try {
    await writeFile(payloadPath, "console-mcp ssh signing probe\n", "utf8");
    const result = await runSupervisedCommand(tempDir, "ssh-keygen", ["-Y", "sign", "-f", publicKeyPath, "-n", "git", "-q", payloadPath], 30000, 1024 * 1024);
    return { ok: result.ok, exitCode: result.exitCode, stderr: truncateOutput(result.stderr, 2000).text };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
