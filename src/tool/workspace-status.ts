import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertAllowedRoot } from "../service/path.js";
import type { ConsolePolicy } from "../service/policy.js";
import { resolveCommandExecutable } from "../service/process.js";
import { buildSafeEnv } from "../service/process.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const execFileAsync = promisify(execFile);

export function registerWorkspaceStatusTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.workspace_status",
    {
      description: "Run approved git status commands in a workspace under the allowed root.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => textResult(await getWorkspaceStatus(policy, workspacePath))
  );

  server.registerTool(
    "console.read_.repo.workspace.status",
    {
      description: "Canonical alias for console.workspace_status. Run approved git status commands in a workspace under the allowed root.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => textResult(await getWorkspaceStatus(policy, workspacePath))
  );
}

export async function getWorkspaceStatus(policy: ConsolePolicy, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
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
  };
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync(resolveCommandExecutable("git"), args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: buildSafeEnv(),
  });

  return String(result.stdout ?? "");
}
