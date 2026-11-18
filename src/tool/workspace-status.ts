import { realpath } from "node:fs/promises";
import { inspectReadOnlyMerge } from "./git-merge-review.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildWorkspaceUmbrellaWarning, isWorkspaceUmbrellaRoot } from "../service/code-memory-scope.js";
import { resolveCommandExecutable } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildSafeEnv } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const execFileAsync = promisify(execFile);

export function registerWorkspaceStatusTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "read_.repo.workspace.status",
    {
      description: "Read Git status; optionally simulate merging a specified local commit SHA into HEAD using an isolated temporary object database.",
      inputSchema: z.object({ workspacePath: z.string().min(1), mergeWithSha: z.string().regex(/^[0-9a-f]{40}$/i).optional() }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, mergeWithSha }) => textResult(await getWorkspaceStatus(policy, workspacePath, mergeWithSha))
  );
}

export async function getWorkspaceStatus(policy: ConsolePolicy, workspacePath: string, mergeWithSha?: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(await realpath(assertAllowedRoot(workspacePath, policy.allowedRoots)), policy.allowedRoots);

  if (isWorkspaceUmbrellaRoot(policy, cwd)) {
    return {
      ok: false,
      status: "WORKSPACE_ROOT_IS_UMBRELLA",
      workspace_path: cwd,
      workspace_kind: "umbrella",
      git_top_level: null,
      branch: null,
      status_line_count: 0,
      status_lines: [],
      status_lines_truncated: false,
      backup_git_allowed: true,
      active_project_required: true,
      code_memory_scope: buildWorkspaceUmbrellaWarning(policy, cwd),
    };
  }

  const status = await execGit(cwd, ["status", "--short"]);
  const branch = await execGit(cwd, ["branch", "--show-current"]);
  const topLevel = await execGit(cwd, ["rev-parse", "--show-toplevel"]);

  const statusLines = status.trim() ? status.trim().split(/\r?\n/).slice(0, policy.maxStatusLines) : [];

  return {
    workspace_path: cwd,
    git_top_level: topLevel.trim() || null,
    branch: branch.trim() || null,
    status_line_count: status.trim() ? status.trim().split(/\r?\n/).length : 0,
    status_lines: statusLines,
    status_lines_truncated: statusLines.length < (status.trim() ? status.trim().split(/\r?\n/).length : 0),
    ...(mergeWithSha ? { merge_review: await inspectReadOnlyMerge(cwd, mergeWithSha) } : {}),
  };
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  // Git status can execute core.fsmonitor from repository-local configuration.
  // Disable it at command scope: read-only tools must never run repo-defined hooks.
  const result = await execFileAsync(resolveCommandExecutable("git"), ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...buildSafeEnv(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: cwd, GIT_OPTIONAL_LOCKS: "0" },
  });

  return String(result.stdout ?? "");
}

