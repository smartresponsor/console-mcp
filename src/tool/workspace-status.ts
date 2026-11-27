import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { observeOwnerGitEvidence } from "../Infrastructure/Process/OwnerGitEvidence.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { buildWorkspaceUmbrellaWarning, isWorkspaceUmbrellaRoot } from "../service/code-memory-scope.js";

import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerWorkspaceStatusTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "read_.repo.workspace.status",
    {
      description: "Run approved git status commands in a workspace under the allowed root.",
      inputSchema: z.object({ workspacePath: z.string().min(1), evidenceNonce: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, evidenceNonce }) => {
      if (evidenceNonce) {
        try { return textResult(observeOwnerGitEvidence(policy,assertAllowedRoot(workspacePath,policy.allowedRoots),evidenceNonce)); }
        catch { return textResult({ok:false,status:"OWNER_GIT_OBSERVATION_UNAVAILABLE",executionAuthorized:false}); }
      }
      return textResult(await getWorkspaceStatus(policy, workspacePath));
    }
  );
}

export async function getWorkspaceStatus(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);

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

  const results = await Promise.all([
    runSupervisedCommand(cwd, "git", ["status", "--short"], 15000, 1024 * 1024),
    runSupervisedCommand(cwd, "git", ["branch", "--show-current"], 15000, 1024 * 1024),
    runSupervisedCommand(cwd, "git", ["rev-parse", "--show-toplevel"], 15000, 1024 * 1024),
  ]);
  const failures = results.filter(r => !r.ok);
  if (failures.length) return { ok: false, workspace_path: cwd,
    status: failures.some(r => /dubious ownership/i.test(r.stderr)) ? "GIT_OWNERSHIP_UNSAFE" : "GIT_STATUS_UNAVAILABLE",
    git_top_level: null, branch: null, status_line_count: null, status_lines: null,
    failures: failures.map(r => ({ args: r.args, exitCode: r.exitCode, stderr: r.stderr })) };
  const [status, branch, topLevel] = results.map(r => r.stdout);

  const statusLines = status.trim() ? status.trim().split(/\r?\n/).slice(0, policy.maxStatusLines) : [];

  return {
    workspace_path: cwd,
    git_top_level: topLevel.trim() || null,
    branch: branch.trim() || null,
    status_line_count: status.trim() ? status.trim().split(/\r?\n/).length : 0,
    status_lines: statusLines,
    status_lines_truncated: statusLines.length < (status.trim() ? status.trim().split(/\r?\n/).length : 0),
  };
}
