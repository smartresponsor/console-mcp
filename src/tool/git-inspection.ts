import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { buildWorkspaceUmbrellaWarning, assertNotWorkspaceUmbrellaRoot, isWorkspaceUmbrellaRoot } from "../service/code-memory-scope.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const outputLimit = 30000;
const protectedPushBranches = new Set(["main", "master"]);
const defaultRemoteName = "origin";

export function registerGitInspectionTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);

  registerGitDiffTool(server, policy, registration, "console.read_.repo.git.diff", "Show git diff for a workspace, optionally limited to one repository path.");
  registerGitDiffStatTool(server, policy, registration, "console.read_.repo.git.diff.stat", "Show git diff --stat for a workspace.");
  registerGitGrepTool(server, policy, registration, "console.read_.repo.git.grep", "Run git grep with an optional repository pathspec.");
  registerGitLogFileTool(server, policy, registration, "console.read_.repo.git.file.log", "Show recent git log entries for a repository file.");
  registerGitReflogSearchTool(server, policy, registration, "console.read_.repo.git.reflog.search", "Search recent git reflog entries for a text fragment.");
  registerGitShowFileTool(server, policy, registration, "console.read_.repo.git.file.show", "Show file content from a specific git commit using commit:path syntax.");
  registerGitCommitTool(server, policy, mutationRegistration, "console.write.repo.git.commit.signed", "Stage explicit repository files and create a signed git commit with the provided message.");
  registerGitBranchCreateTool(server, policy, mutationRegistration, "console.write.repo.git.branch.create", "Create a guarded checkpoint branch at an explicit start point.");
  registerGitRebaseTool(server, policy, mutationRegistration, "console.write.repo.git.rebase", "Run a guarded Git rebase lifecycle action: start, continue, abort, or skip.");
  registerGitStageTool(server, policy, mutationRegistration, "console.write.repo.git.stage", "Stage only explicitly listed repository file paths.");
  registerGitCheckoutFileTool(server, policy, mutationRegistration, "console.write.repo.git.checkout.file", "Resolve one conflicted file using Git ours or theirs after semantic analysis.");
  registerGitBranchStatusTool(server, policy, registration, "console.read_.repo.git.branch.status", "Inspect current Git branch, upstream, cleanliness, and ahead/behind status.");
  registerGitRemoteSummaryTool(server, policy, registration, "console.read_.repo.git.remote.summary", "Inspect Git remotes and current branch upstream mapping.");
  registerGitSyncPlanTool(server, policy, registration, "console.read_.repo.git.sync.plan", "Plan the safest Git synchronization action without mutating repository state.");
  registerGitFetchTool(server, policy, mutationRegistration, "console.write.repo.git.fetch", "Run guarded git fetch for the selected remote after confirmation.");
  registerGitPullFastForwardOnlyTool(server, policy, mutationRegistration, "console.write.repo.git.pull.ff.only", "Run guarded git pull --ff-only for the current branch after confirmation.");
  registerGitPushCurrentTool(server, policy, mutationRegistration, "console.write.repo.git.push.current", "Push the current branch to its configured upstream after confirmation.");
  registerGitPushCurrentSetUpstreamTool(server, policy, mutationRegistration, "console.write.repo.git.push.current.set.upstream", "Push the current branch to origin HEAD and set upstream after confirmation.");

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

function registerGitBranchCreateTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), branchName: z.string().min(1).max(200), startPoint: z.string().min(1).default("HEAD"), confirmCreate: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, branchName, startPoint, confirmCreate }) => textResult(await gitBranchCreate(policy, workspacePath, branchName, startPoint, Boolean(confirmCreate)))
  );
}

function registerGitRebaseTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), action: z.enum(["start", "continue", "abort", "skip"]), upstream: z.string().min(1).default("origin/master"), confirmRebase: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, action, upstream, confirmRebase }) => textResult(await gitRebase(policy, workspacePath, action, upstream, Boolean(confirmRebase)))
  );
}

function registerGitStageTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), files: z.array(z.string().min(1)).min(1).max(100), confirmStage: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, files, confirmStage }) => textResult(await gitStage(policy, workspacePath, files, Boolean(confirmStage)))
  );
}

function registerGitCheckoutFileTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), strategy: z.enum(["ours", "theirs"]), filePath: z.string().min(1), confirmCheckout: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, strategy, filePath, confirmCheckout }) => textResult(await gitCheckoutFile(policy, workspacePath, strategy, filePath, Boolean(confirmCheckout)))
  );
}

function registerGitBranchStatusTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath }) => textResult(await buildGitBranchStatus(policy, workspacePath))
  );
}

function registerGitRemoteSummaryTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath }) => textResult(await buildGitRemoteSummary(policy, workspacePath))
  );
}

function registerGitSyncPlanTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...registration,
    },
    async ({ workspacePath }) => textResult(await buildGitSyncPlan(policy, workspacePath))
  );
}

function registerGitFetchTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), remote: z.literal(defaultRemoteName).optional(), prune: z.boolean().optional(), confirmFetch: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, remote, prune, confirmFetch }) => textResult(await gitFetch(policy, workspacePath, remote ?? defaultRemoteName, Boolean(prune), Boolean(confirmFetch)))
  );
}

function registerGitPullFastForwardOnlyTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), confirmPull: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, confirmPull }) => textResult(await gitPullFastForwardOnly(policy, workspacePath, Boolean(confirmPull)))
  );
}

function registerGitPushCurrentTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), confirmPush: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, confirmPush }) => textResult(await gitPushCurrent(policy, workspacePath, Boolean(confirmPush), false))
  );
}

function registerGitPushCurrentSetUpstreamTool(server: McpServer, policy: ConsolePolicy, registration: Record<string, unknown>, name: string, description: string): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object({ workspacePath: z.string().min(1), confirmPush: z.boolean().default(false) }).strict(),
      ...registration,
    },
    async ({ workspacePath, confirmPush }) => textResult(await gitPushCurrent(policy, workspacePath, Boolean(confirmPush), true))
  );
}

async function gitText(policy: ConsolePolicy, workspacePath: string, args: string[]): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);

  if (isWorkspaceUmbrellaRoot(policy, cwd)) {
    return {
      ok: false,
      status: "WORKSPACE_ROOT_IS_UMBRELLA",
      command: ["git", ...args].join(" "),
      cwd,
      exitCode: null,
      stdout: "",
      stdoutTruncated: false,
      stderr: "",
      stderrTruncated: false,
      workspace_kind: "umbrella",
      backup_git_allowed: true,
      active_project_required: true,
      code_memory_scope: buildWorkspaceUmbrellaWarning(policy, cwd),
    };
  }

  const result = await runSupervisedCommand(cwd, "git", args, 30000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, outputLimit);
  const stderr = truncateOutput(result.stderr, outputLimit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function gitCommit(policy: ConsolePolicy, workspacePath: string, files: string[], message: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, cwd, "git.commit.signed");
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

async function gitBranchCreate(policy: ConsolePolicy, workspacePath: string, branchName: string, startPoint: string, confirmCreate: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, "git.branch.create");
  const normalizedBranch = sanitizeCheckpointBranchName(branchName);
  const normalizedStartPoint = sanitizeCommitish(startPoint);
  const args = ["branch", normalizedBranch, normalizedStartPoint];
  if (!confirmCreate) return { ok: false, status: "CONFIRM_GIT_BRANCH_CREATE_REQUIRED", command: ["git", ...args].join(" "), cwd, requires: { workspacePath: cwd, branchName: normalizedBranch, startPoint: normalizedStartPoint, confirmCreate: true } };
  return gitDeliveryCommand(cwd, args, 30000);
}

async function gitRebase(policy: ConsolePolicy, workspacePath: string, action: "start" | "continue" | "abort" | "skip", upstream: string, confirmRebase: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, `git.rebase.${action}`);
  const rebaseInProgress = isGitOperationInProgress(cwd, ["rebase-merge", "rebase-apply"]);
  const normalizedUpstream = sanitizeRebaseUpstream(upstream);
  const args = action === "start"
    ? ["rebase", normalizedUpstream]
    : action === "continue"
      ? ["-c", "core.editor=true", "rebase", "--continue"]
      : ["rebase", `--${action}`];
  const blocks: string[] = [];
  if (action === "start") {
    const status = await buildGitBranchStatus(policy, workspacePath) as BranchStatus;
    if (status.branch === null) blocks.push("detached_head_or_no_current_branch");
    if (status.isDirty) blocks.push("working_tree_dirty");
    if (rebaseInProgress) blocks.push("rebase_already_in_progress");
  } else if (!rebaseInProgress) {
    blocks.push("rebase_not_in_progress");
  }
  if (blocks.length > 0) return { ok: false, status: "GIT_REBASE_GUARD_BLOCKED", action, blocks, command: ["git", ...args].join(" "), cwd };
  if (!confirmRebase) return { ok: false, status: "CONFIRM_GIT_REBASE_REQUIRED", action, command: ["git", ...args].join(" "), cwd, requires: { workspacePath: cwd, action, upstream: normalizedUpstream, confirmRebase: true } };
  return gitDeliveryCommand(cwd, args, 120000);
}

async function gitStage(policy: ConsolePolicy, workspacePath: string, files: string[], confirmStage: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, "git.stage");
  const uniqueFiles = [...new Set(files.map((file) => normalizeRepoPath(file)))];
  const args = ["add", "--", ...uniqueFiles];
  if (!confirmStage) return { ok: false, status: "CONFIRM_GIT_STAGE_REQUIRED", command: ["git", ...args].join(" "), cwd, files: uniqueFiles, requires: { workspacePath: cwd, files: uniqueFiles, confirmStage: true } };
  return gitDeliveryCommand(cwd, args, 30000);
}

async function gitCheckoutFile(policy: ConsolePolicy, workspacePath: string, strategy: "ours" | "theirs", filePath: string, confirmCheckout: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, "git.checkout.file");
  const normalizedFile = normalizeRepoPath(filePath);
  const conflicted = await gitPlain(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  const conflictedFiles = conflicted.ok ? conflicted.value.split(/\r?\n/).filter(Boolean).map(normalizeRepoPath) : [];
  if (!conflictedFiles.includes(normalizedFile)) return { ok: false, status: "GIT_CHECKOUT_FILE_NOT_UNMERGED", cwd, filePath: normalizedFile, conflictedFiles };
  const args = ["checkout", `--${strategy}`, "--", normalizedFile];
  if (!confirmCheckout) return { ok: false, status: "CONFIRM_GIT_CHECKOUT_FILE_REQUIRED", command: ["git", ...args].join(" "), cwd, warning: "During rebase, ours is the rebased upstream side and theirs is the replayed commit side.", requires: { workspacePath: cwd, strategy, filePath: normalizedFile, confirmCheckout: true } };
  return gitDeliveryCommand(cwd, args, 30000);
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
    signedCommitPolicy: "Signed repo commit tool always uses git commit -S and does not fall back to unsigned commits.",
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

type BranchStatus = {
  ok: boolean;
  cwd: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  remote: string | null;
  isProtectedPushBranch: boolean;
  isDirty: boolean;
  dirtyCount: number;
  ahead: number | null;
  behind: number | null;
  statusShort: string;
  statusPorcelain: string;
};

async function buildGitBranchStatus(policy: ConsolePolicy, workspacePath: string): Promise<BranchStatus | Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  if (isWorkspaceUmbrellaRoot(policy, cwd)) return buildWorkspaceUmbrellaWarning(policy, cwd);

  const branch = await gitPlain(cwd, ["branch", "--show-current"]);
  const head = await gitPlain(cwd, ["rev-parse", "HEAD"]);
  const upstream = await gitPlain(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const statusShort = await gitPlain(cwd, ["status", "-sb"]);
  const statusPorcelain = await gitPlain(cwd, ["status", "--porcelain=v1"]);
  const aheadBehind = upstream.ok ? await gitPlain(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]) : { ok: false, value: "" };
  const [ahead, behind] = parseAheadBehind(aheadBehind.ok ? aheadBehind.value : "");
  const branchName = branch.ok && branch.value !== "" ? branch.value : null;
  const upstreamName = upstream.ok && upstream.value !== "" ? upstream.value : null;
  const dirtyLines = statusPorcelain.ok && statusPorcelain.value.length > 0 ? statusPorcelain.value.split(/\r?\n/).filter(Boolean) : [];

  return {
    ok: true,
    cwd,
    branch: branchName,
    head: head.ok ? head.value : null,
    upstream: upstreamName,
    remote: upstreamName ? upstreamName.split("/")[0] ?? null : null,
    isProtectedPushBranch: branchName !== null && protectedPushBranches.has(branchName),
    isDirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    ahead,
    behind,
    statusShort: statusShort.ok ? statusShort.value : "",
    statusPorcelain: statusPorcelain.ok ? statusPorcelain.value : "",
  };
}

async function buildGitRemoteSummary(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  if (isWorkspaceUmbrellaRoot(policy, cwd)) return buildWorkspaceUmbrellaWarning(policy, cwd);

  const remotes = await gitPlain(cwd, ["remote", "-v"]);
  const originUrl = await gitPlain(cwd, ["remote", "get-url", defaultRemoteName]);
  const branchStatus = await buildGitBranchStatus(policy, workspacePath);
  return {
    ok: true,
    cwd,
    defaultRemote: defaultRemoteName,
    originConfigured: originUrl.ok,
    originUrl: originUrl.ok ? originUrl.value : null,
    remotes: remotes.ok ? remotes.value : "",
    branchStatus,
  };
}

async function buildGitSyncPlan(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const status = await buildGitBranchStatus(policy, workspacePath);
  if ("status" in status && status.status === "WORKSPACE_ROOT_IS_UMBRELLA") return status;
  const branchStatus = status as BranchStatus;
  const blocks: string[] = [];
  let nextAction = "none";
  let executeTool: string | null = null;

  if (branchStatus.branch === null) blocks.push("detached_head_or_no_current_branch");
  if (branchStatus.isDirty) blocks.push("working_tree_dirty");
  if (branchStatus.isProtectedPushBranch) blocks.push("protected_push_branch");

  if (branchStatus.upstream === null) {
    nextAction = "push_current_set_upstream";
    executeTool = "console.write.repo.git.push.current.set.upstream";
  } else if ((branchStatus.behind ?? 0) > 0 && (branchStatus.ahead ?? 0) > 0) {
    nextAction = "manual_divergence_resolution_required";
    executeTool = null;
    blocks.push("branch_diverged_from_upstream");
  } else if ((branchStatus.behind ?? 0) > 0) {
    nextAction = "pull_ff_only";
    executeTool = "console.write.repo.git.pull.ff.only";
  } else if ((branchStatus.ahead ?? 0) > 0) {
    nextAction = "push_current";
    executeTool = "console.write.repo.git.push.current";
  } else {
    nextAction = "already_synced";
  }

  const pushAction = nextAction === "push_current" || nextAction === "push_current_set_upstream";
  return {
    ok: blocks.length === 0 && !pushAction ? true : blocks.length === 0,
    status: blocks.length > 0 ? "GIT_SYNC_BLOCKED_OR_GUARDED" : "GIT_SYNC_PLAN_READY",
    branchStatus,
    nextAction,
    executeTool,
    executeRequires: executeTool ? executeRequirementsForSyncTool(executeTool, branchStatus.cwd) : null,
    blocks,
    policy: {
      mutates: false,
      fetchNotPerformed: true,
      forcePushNotAvailable: true,
      protectedPushBranches: [...protectedPushBranches],
    },
  };
}

function executeRequirementsForSyncTool(tool: string, workspacePath: string): Record<string, unknown> {
  if (tool === "console.write.repo.git.pull.ff.only") return { workspacePath, confirmPull: true };
  return { workspacePath, confirmPush: true };
}

async function gitFetch(policy: ConsolePolicy, workspacePath: string, remote: string, prune: boolean, confirmFetch: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, "git.fetch");
  assertSafeRemoteName(remote);
  const args = ["fetch", remote];
  if (prune) args.push("--prune");
  if (!confirmFetch) return { ok: false, status: "CONFIRM_GIT_FETCH_REQUIRED", command: ["git", ...args].join(" "), cwd, requires: { workspacePath: cwd, remote, prune, confirmFetch: true } };
  return gitDeliveryCommand(cwd, args, 120000);
}

async function gitPullFastForwardOnly(policy: ConsolePolicy, workspacePath: string, confirmPull: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, "git.pull.ff.only");
  const status = await buildGitBranchStatus(policy, workspacePath) as BranchStatus;
  const guard = guardCurrentBranchForLocalSync(status);
  if (!guard.ok) return guard;
  const args = ["pull", "--ff-only"];
  if (!confirmPull) return { ok: false, status: "CONFIRM_GIT_PULL_FF_ONLY_REQUIRED", command: ["git", ...args].join(" "), cwd, branchStatus: status, requires: { workspacePath: cwd, confirmPull: true } };
  return gitDeliveryCommand(cwd, args, 120000);
}

async function gitPushCurrent(policy: ConsolePolicy, workspacePath: string, confirmPush: boolean, setUpstream: boolean): Promise<Record<string, unknown>> {
  const cwd = assertGitDeliveryWorkspace(policy, workspacePath, setUpstream ? "git.push.current.set.upstream" : "git.push.current");
  const status = await buildGitBranchStatus(policy, workspacePath) as BranchStatus;
  const guard = guardCurrentBranchForPush(status, setUpstream);
  if (!guard.ok) return guard;
  const args = setUpstream ? ["push", "-u", defaultRemoteName, "HEAD"] : ["push"];
  if (!confirmPush) return { ok: false, status: "CONFIRM_GIT_PUSH_REQUIRED", command: ["git", ...args].join(" "), cwd, branchStatus: status, requires: { workspacePath: cwd, confirmPush: true } };
  return gitDeliveryCommand(cwd, args, 120000);
}

function assertGitDeliveryWorkspace(policy: ConsolePolicy, workspacePath: string, operation: string): string {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, cwd, operation);
  return cwd;
}

function guardCurrentBranchForLocalSync(status: BranchStatus): Record<string, unknown> {
  const blocks = basicBranchBlocks(status);
  if (status.upstream === null) blocks.push("upstream_missing");
  return blocks.length === 0 ? { ok: true } : { ok: false, status: "GIT_LOCAL_SYNC_GUARD_BLOCKED", blocks, branchStatus: status };
}

function guardCurrentBranchForPush(status: BranchStatus, setUpstream: boolean): Record<string, unknown> {
  const blocks = basicBranchBlocks(status);
  if (status.isProtectedPushBranch) blocks.push("protected_push_branch");
  if (!setUpstream && status.upstream === null) blocks.push("upstream_missing_use_push_current_set_upstream");
  if (setUpstream && status.upstream !== null) blocks.push("upstream_already_configured_use_push_current");
  if ((status.behind ?? 0) > 0) blocks.push("branch_behind_upstream");
  return blocks.length === 0 ? { ok: true } : { ok: false, status: "GIT_PUSH_GUARD_BLOCKED", blocks, branchStatus: status, policy: { forcePushNotAvailable: true, protectedPushBranches: [...protectedPushBranches] } };
}

function basicBranchBlocks(status: BranchStatus): string[] {
  const blocks: string[] = [];
  if (status.branch === null) blocks.push("detached_head_or_no_current_branch");
  if (status.isDirty) blocks.push("working_tree_dirty");
  return blocks;
}

async function gitDeliveryCommand(cwd: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(cwd, "git", args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, outputLimit);
  const stderr = truncateOutput(result.stderr, outputLimit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function gitPlain(cwd: string, args: string[]): Promise<{ ok: boolean; value: string }> {
  const result = await runSupervisedCommand(cwd, "git", args, 30000, 1024 * 1024);
  return { ok: result.ok, value: result.stdout.trim() };
}

function parseAheadBehind(raw: string): [number | null, number | null] {
  const match = raw.trim().match(/^(\d+)\s+(\d+)$/);
  return match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)] : [null, null];
}

function assertSafeRemoteName(remote: string): void {
  if (remote !== defaultRemoteName) {
    throw new Error(`Only '${defaultRemoteName}' remote is allowed for guarded Git delivery tools.`);
  }
}

function sanitizeCommitish(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/@{}~^:-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Commit value contains unsupported characters.");
  }

  return normalized;
}

function sanitizeCheckpointBranchName(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized.startsWith("checkpoint/") || !/^[A-Za-z0-9._/-]+$/.test(normalized) || normalized.includes("..") || normalized.endsWith("/") || normalized.includes("//")) {
    throw new Error("Checkpoint branch name must use the checkpoint/<name> namespace and safe Git ref characters.");
  }
  return normalized;
}

function sanitizeRebaseUpstream(value: string): string {
  const normalized = sanitizeCommitish(value);
  if (!normalized.startsWith("origin/") || normalized === "origin/") {
    throw new Error("Rebase upstream must be an origin/<branch> remote-tracking ref.");
  }
  return normalized;
}

function isGitOperationInProgress(cwd: string, markers: string[]): boolean {
  return markers.some((marker) => existsSync(path.join(cwd, ".git", marker)));
}

