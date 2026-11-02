import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { assertNotWorkspaceUmbrellaRoot } from "../service/code-memory-scope.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const branchSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"), "Unsafe Git branch name.");

export function registerGitWorktreeTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "write.repo.git.worktree.create",
    {
      description: "Create an isolated Git worktree at a repository-relative path and a new feature branch from an exact existing commit or ref. The source worktree is never switched, staged, committed, reset, or cleaned.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        worktreePath: z.string().min(1).max(500).refine((value) => !path.isAbsolute(value) && !value.split(/[\\\\/]+/).includes(".."), "Worktree path must be relative and cannot traverse upward."),
        branchName: branchSchema,
        startPoint: z.string().min(1).max(200).default("HEAD"),
        confirmCreate: z.boolean().default(false),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async ({ workspacePath, worktreePath, branchName, startPoint, confirmCreate }) => textResult(await createGitWorktree(policy, { workspacePath, worktreePath, branchName, startPoint, confirmCreate })),
  );
  server.registerTool(
    "read_.repo.git.worktree.list",
    {
      description: "List registered Git worktrees for a source repository without mutation.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => textResult(await listGitWorktrees(policy, workspacePath)),
  );
  server.registerTool(
    "write.repo.git.worktree.remove",
    {
      description: "Remove only a registered, completely clean feature worktree from the dedicated .worktrees directory, without force or branch deletion.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        worktreePath: z.string().min(1).max(140),
        confirmRemove: z.boolean().default(false),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async ({ workspacePath, worktreePath, confirmRemove }) => textResult(await removeGitWorktree(policy, { workspacePath, worktreePath, confirmRemove })),
  );
}

export async function createGitWorktree(policy: ConsolePolicy, input: { workspacePath: string; worktreePath: string; branchName: string; startPoint: string; confirmCreate: boolean }): Promise<Record<string, unknown>> {
  const source = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, source, "git.worktree.create");
  const sourceReal = await realpath(source);
  const rootResult = await runSupervisedCommand(sourceReal, "git", ["rev-parse", "--show-toplevel"], 15000, 1024 * 1024);
  if (!rootResult.ok) return { ok: false, status: "GIT_WORKTREE_SOURCE_INVALID", source: sourceReal, stderr: rootResult.stderr };
  const repoRoot = await realpath(rootResult.stdout.trim());
  if (!/^\.worktrees\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.worktreePath)) throw new Error("GIT_WORKTREE_PATH_MUST_USE_DOT_WORKTREES");
  const destination = assertAllowedRoot(path.resolve(path.dirname(repoRoot), input.worktreePath), policy.allowedRoots);
  const relative = path.relative(path.dirname(repoRoot), destination);
  if (!relative.startsWith(".worktrees" + path.sep)) throw new Error("GIT_WORKTREE_DESTINATION_OUTSIDE_WORKTREE_ROOT");
  if (existsSync(destination)) return { ok: false, status: "GIT_WORKTREE_DESTINATION_EXISTS", source: repoRoot, destination };
  const resolvedStart = await runSupervisedCommand(repoRoot, "git", ["rev-parse", "--verify", "--end-of-options", `${input.startPoint}^{commit}`], 15000, 1024 * 1024);
  if (!resolvedStart.ok) return { ok: false, status: "GIT_WORKTREE_START_POINT_INVALID", source: repoRoot, startPoint: input.startPoint };
  const commit = resolvedStart.stdout.trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) return { ok: false, status: "GIT_WORKTREE_COMMIT_ID_INVALID", source: repoRoot, startPoint: input.startPoint };
  const branchExists = await runSupervisedCommand(repoRoot, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${input.branchName}`], 15000, 1024 * 1024);
  if (branchExists.ok) return { ok: false, status: "GIT_WORKTREE_BRANCH_EXISTS", source: repoRoot, branchName: input.branchName };
  const plan = { source: repoRoot, destination, branchName: input.branchName, startPoint: input.startPoint, commit, policy: { sourceWorktreeMutated: false, sourceBranchSwitched: false, reset: false, clean: false, force: false } };
  if (!input.confirmCreate) return { ok: false, status: "CONFIRM_GIT_WORKTREE_CREATE_REQUIRED", ...plan, requires: { ...input, confirmCreate: true } };
  await mkdir(path.dirname(destination), { recursive: true });
  const created = await runSupervisedCommand(repoRoot, "git", ["worktree", "add", "-b", input.branchName, destination, commit], 120000, 4 * 1024 * 1024);
  if (!created.ok) return { ok: false, status: "GIT_WORKTREE_CREATE_FAILED", ...plan, exitCode: created.exitCode, stderr: created.stderr };
  const [head, branch, status, marker] = await Promise.all([
    runSupervisedCommand(destination, "git", ["rev-parse", "HEAD"], 15000, 1024 * 1024),
    runSupervisedCommand(destination, "git", ["branch", "--show-current"], 15000, 1024 * 1024),
    runSupervisedCommand(destination, "git", ["status", "--porcelain=v1"], 15000, 1024 * 1024),
    realpath(path.join(destination, ".git")).catch(() => null),
  ]);
  const verified = head.ok && head.stdout.trim() === commit && branch.ok && branch.stdout.trim() === input.branchName && status.ok && status.stdout.trim() === "" && marker !== null;
  return { ok: verified, status: verified ? "GIT_WORKTREE_CREATED" : "GIT_WORKTREE_POSTCONDITION_FAILED", ...plan, actualHead: head.ok ? head.stdout.trim() : null, actualBranch: branch.ok ? branch.stdout.trim() : null, clean: status.ok ? status.stdout.trim() === "" : false, gitMetadataResolved: marker !== null };
}
async function listGitWorktrees(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, workspace, "git.worktree.list");
  const current = await realpath(workspace);
  const result = await runSupervisedCommand(current, "git", ["worktree", "list", "--porcelain"], 15000, 1024 * 1024);
  if (!result.ok) return { ok: false, status: "GIT_WORKTREE_LIST_FAILED" };
  const worktrees = result.stdout.trim().split(/\n\s*\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/);
    return {
      path: lines.find(line => line.startsWith("worktree "))?.slice(9) ?? null,
      head: lines.find(line => line.startsWith("HEAD "))?.slice(5) ?? null,
      branch: lines.find(line => line.startsWith("branch "))?.slice(7) ?? null,
      detached: lines.includes("detached"),
      locked: lines.some(line => line.startsWith("locked")),
    };
  });
  return { ok: true, status: "GIT_WORKTREES_LISTED", worktrees };
}

export async function removeGitWorktree(policy: ConsolePolicy, input: { workspacePath: string; worktreePath: string; confirmRemove: boolean }): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, workspace, "git.worktree.remove");
  const source = await realpath(workspace);
  const top = await runSupervisedCommand(source, "git", ["rev-parse", "--show-toplevel"], 15000, 1024 * 1024);
  if (!top.ok) return { ok: false, status: "GIT_WORKTREE_SOURCE_INVALID" };
  const repoRoot = await realpath(top.stdout.trim());
  if (!/^\.worktrees\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.worktreePath)) throw new Error("GIT_WORKTREE_PATH_MUST_USE_DOT_WORKTREES");
  const destination = assertAllowedRoot(path.resolve(path.dirname(repoRoot), input.worktreePath), policy.allowedRoots);
  if (!existsSync(destination)) return { ok: false, status: "GIT_WORKTREE_MISSING", destination };
  const destinationReal = await realpath(destination);
  if (destinationReal !== destination) return { ok: false, status: "GIT_WORKTREE_SYMLINK_REJECTED", destination };
  const listing = await listGitWorktrees(policy, repoRoot);
  const listed = (listing.worktrees as {path:string|null;locked:boolean;branch:string|null}[] | undefined)?.find(item => item.path === destination);
  if (!listing.ok || !listed || listed.locked || !listed.branch) return { ok: false, status: "GIT_WORKTREE_NOT_REGISTERED_OR_LOCKED", destination };
  const status = await runSupervisedCommand(destination, "git", ["status", "--porcelain=v1", "--untracked-files=all"], 15000, 1024 * 1024);
  if (!status.ok || status.stdout.trim()) return { ok: false, status: "GIT_WORKTREE_DIRTY", destination };
  const plan = { source: repoRoot, destination, branch: listed.branch, removesBranch: false, force: false };
  if (!input.confirmRemove) return { ok: false, status: "CONFIRM_GIT_WORKTREE_REMOVE_REQUIRED", ...plan };
  const removed = await runSupervisedCommand(repoRoot, "git", ["worktree", "remove", destination], 120000, 4 * 1024 * 1024);
  return { ok: removed.ok && !existsSync(destination), status: removed.ok && !existsSync(destination) ? "GIT_WORKTREE_REMOVED" : "GIT_WORKTREE_REMOVE_FAILED", ...plan, exitCode: removed.exitCode };
}
