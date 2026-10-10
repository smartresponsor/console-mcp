import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { assertNotWorkspaceUmbrellaRoot } from "../service/code-memory-scope.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const outputLimit = 30000;
const remoteNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const branchNameSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"), "Unsafe Git branch name.");

export function registerGitRepoPeerTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const readRegistration = buildConsoleToolRegistration(authConfig);
  const writeRegistration = buildConsoleMutationToolRegistration(authConfig);

  server.registerTool(
    "read_.git.repo.inspect",
    {
      description: "Inspect one Git repo HEAD, branch, cleanliness, upstream, and configured remotes without mutation.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...readRegistration,
    },
    async ({ workspacePath }) => textResult(await inspectRepo(policy, workspacePath)),
  );

  server.registerTool(
    "read_.git.repo.compare",
    {
      description: "Compare local HEAD with one configured remote-tracking branch using Git ancestry and ahead/behind counts without mutation.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        remote: remoteNameSchema,
        branch: branchNameSchema.default("master"),
      }).strict(),
      ...readRegistration,
    },
    async ({ workspacePath, remote, branch }) => textResult(await compareRepo(policy, workspacePath, remote, branch)),
  );

  server.registerTool(
    "write.git.repo.fetch",
    {
      description: "Fetch refs and missing Git objects from one already-configured remote. It never merges, prunes, resets, deletes refs, or force-updates branches.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        remote: remoteNameSchema,
        confirmFetch: z.boolean().default(false),
      }).strict(),
      ...writeRegistration,
    },
    async ({ workspacePath, remote, confirmFetch }) => textResult(await fetchRepo(policy, workspacePath, remote, Boolean(confirmFetch))),
  );

  server.registerTool(
    "write.git.repo.fast_forward",
    {
      description: "Fast-forward the current clean local branch to an existing remote-tracking branch after ancestry verification. Merge commits, reset, rebase, delete, and force are forbidden.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        remote: remoteNameSchema,
        branch: branchNameSchema.default("master"),
        confirmFastForward: z.boolean().default(false),
      }).strict(),
      ...writeRegistration,
    },
    async ({ workspacePath, remote, branch, confirmFastForward }) => textResult(await fastForwardRepo(policy, workspacePath, remote, branch, Boolean(confirmFastForward))),
  );
}

async function inspectRepo(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = guardedRepo(policy, workspacePath, "git.repo.inspect");
  const [branch, head, status, upstream, remotes] = await Promise.all([
    gitPlain(cwd, ["branch", "--show-current"]),
    gitPlain(cwd, ["rev-parse", "HEAD"]),
    gitPlain(cwd, ["status", "--porcelain=v1"]),
    gitPlain(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    gitPlain(cwd, ["remote", "-v"]),
  ]);
  const dirtyLines = status.ok && status.value ? status.value.split(/\r?\n/).filter(Boolean) : [];
  return {
    ok: head.ok,
    status: head.ok ? "GIT_REPO_INSPECTED" : "GIT_REPO_HEAD_UNAVAILABLE",
    cwd,
    branch: branch.ok && branch.value ? branch.value : null,
    head: head.ok ? head.value : null,
    clean: dirtyLines.length === 0,
    dirtyCount: dirtyLines.length,
    upstream: upstream.ok ? upstream.value : null,
    remotes: remotes.ok ? remotes.value : "",
  };
}

async function compareRepo(policy: ConsolePolicy, workspacePath: string, remote: string, branch: string): Promise<Record<string, unknown>> {
  const cwd = guardedRepo(policy, workspacePath, "git.repo.compare");
  await assertConfiguredRemote(cwd, remote);
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const [localHead, remoteHead, status] = await Promise.all([
    gitPlain(cwd, ["rev-parse", "HEAD"]),
    gitPlain(cwd, ["rev-parse", "--verify", remoteRef]),
    gitPlain(cwd, ["status", "--porcelain=v1"]),
  ]);
  const clean = status.ok && status.value.length === 0;
  if (!localHead.ok || !remoteHead.ok) {
    return {
      ok: false,
      status: "GIT_REPO_COMPARE_REF_UNAVAILABLE",
      cwd,
      remote,
      branch,
      localHead: localHead.ok ? localHead.value : null,
      remoteHead: remoteHead.ok ? remoteHead.value : null,
      fetchSuggested: !remoteHead.ok,
      clean,
    };
  }
  if (localHead.value === remoteHead.value) {
    return { ok: true, status: "GIT_REPO_EQUAL", relation: "equal", cwd, remote, branch, localHead: localHead.value, remoteHead: remoteHead.value, ahead: 0, behind: 0, clean };
  }
  const counts = await gitPlain(cwd, ["rev-list", "--left-right", "--count", `HEAD...${remoteRef}`]);
  const [ahead, behind] = parseAheadBehind(counts.value);
  const localAncestor = await gitPlain(cwd, ["merge-base", "--is-ancestor", "HEAD", remoteRef]);
  const remoteAncestor = await gitPlain(cwd, ["merge-base", "--is-ancestor", remoteRef, "HEAD"]);
  const relation = localAncestor.ok ? "remote_ahead" : remoteAncestor.ok ? "local_ahead" : "diverged";
  return { ok: true, status: `GIT_REPO_${relation.toUpperCase()}`, relation, cwd, remote, branch, localHead: localHead.value, remoteHead: remoteHead.value, ahead, behind, clean };
}

async function fetchRepo(policy: ConsolePolicy, workspacePath: string, remote: string, confirmFetch: boolean): Promise<Record<string, unknown>> {
  const cwd = guardedRepo(policy, workspacePath, "git.repo.fetch");
  const remoteUrl = await assertConfiguredRemote(cwd, remote);
  const args = ["fetch", "--no-prune", remote];
  if (!confirmFetch) {
    return {
      ok: false,
      status: "CONFIRM_GIT_REPO_FETCH_REQUIRED",
      cwd,
      remote,
      remoteUrl,
      command: ["git", ...args].join(" "),
      requires: { workspacePath: cwd, remote, confirmFetch: true },
      policy: { deleteRefs: false, prune: false, merge: false, reset: false, force: false },
    };
  }
  const result = await gitCommand(cwd, args, 120000);
  return { ...result, status: result.ok === true ? "GIT_REPO_FETCHED" : "GIT_REPO_FETCH_FAILED", remote, remoteUrl, policy: { deleteRefs: false, prune: false, merge: false, reset: false, force: false } };
}

async function fastForwardRepo(policy: ConsolePolicy, workspacePath: string, remote: string, branch: string, confirmFastForward: boolean): Promise<Record<string, unknown>> {
  const cwd = guardedRepo(policy, workspacePath, "git.repo.fast_forward");
  await assertConfiguredRemote(cwd, remote);
  const [currentBranch, status] = await Promise.all([
    gitPlain(cwd, ["branch", "--show-current"]),
    gitPlain(cwd, ["status", "--porcelain=v1"]),
  ]);
  if (!currentBranch.ok || !currentBranch.value) return { ok: false, status: "GIT_REPO_FAST_FORWARD_DETACHED_HEAD", cwd };
  if (currentBranch.value !== branch) return { ok: false, status: "GIT_REPO_FAST_FORWARD_BRANCH_MISMATCH", cwd, currentBranch: currentBranch.value, requestedBranch: branch };
  if (!status.ok || status.value.length > 0) return { ok: false, status: "GIT_REPO_FAST_FORWARD_DIRTY", cwd, dirty: status.value };

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const remoteHead = await gitPlain(cwd, ["rev-parse", "--verify", remoteRef]);
  if (!remoteHead.ok) return { ok: false, status: "GIT_REPO_FAST_FORWARD_REMOTE_REF_MISSING", cwd, remote, branch, fetchRequired: true };
  const localHead = await gitPlain(cwd, ["rev-parse", "HEAD"]);
  if (localHead.ok && localHead.value === remoteHead.value) return { ok: true, status: "GIT_REPO_ALREADY_EQUAL", cwd, remote, branch, head: localHead.value, changed: false };

  const localAncestor = await gitPlain(cwd, ["merge-base", "--is-ancestor", "HEAD", remoteRef]);
  if (!localAncestor.ok) return { ok: false, status: "GIT_REPO_FAST_FORWARD_BLOCKED_NOT_ANCESTOR", cwd, remote, branch, localHead: localHead.ok ? localHead.value : null, remoteHead: remoteHead.value };

  const args = ["merge", "--ff-only", remoteRef];
  if (!confirmFastForward) {
    return {
      ok: false,
      status: "CONFIRM_GIT_REPO_FAST_FORWARD_REQUIRED",
      cwd,
      remote,
      branch,
      command: ["git", ...args].join(" "),
      requires: { workspacePath: cwd, remote, branch, confirmFastForward: true },
      policy: { mergeCommit: false, reset: false, rebase: false, delete: false, force: false },
    };
  }
  const result = await gitCommand(cwd, args, 120000);
  const after = await gitPlain(cwd, ["rev-parse", "HEAD"]);
  const verified = result.ok === true && after.ok && after.value === remoteHead.value;
  return { ...result, ok: verified, status: verified ? "GIT_REPO_FAST_FORWARDED" : "GIT_REPO_FAST_FORWARD_VERIFICATION_FAILED", head: after.ok ? after.value : null, expectedHead: remoteHead.value, verified };
}

function guardedRepo(policy: ConsolePolicy, workspacePath: string, operation: string): string {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, cwd, operation);
  return cwd;
}

async function assertConfiguredRemote(cwd: string, remote: string): Promise<string> {
  const result = await gitPlain(cwd, ["remote", "get-url", remote]);
  if (!result.ok || !result.value) throw new Error(`Git remote '${remote}' is not configured in this repo.`);
  return result.value;
}

async function gitPlain(cwd: string, args: string[]): Promise<{ ok: boolean; value: string }> {
  const result = await runSupervisedCommand(cwd, "git", args, 30000, 1024 * 1024);
  return { ok: result.ok, value: result.stdout.trim() };
}

async function gitCommand(cwd: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(cwd, "git", args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, outputLimit);
  const stderr = truncateOutput(result.stderr, outputLimit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function parseAheadBehind(raw: string): [number | null, number | null] {
  const match = raw.trim().match(/^(\d+)\s+(\d+)$/);
  return match ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)] : [null, null];
}
