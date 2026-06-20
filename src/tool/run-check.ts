import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { runNamedCheck, sanitizeText } from "../service/process.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

export function registerRunCheckTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.run_check",
    {
      description: "Run a named check from policy/allowed-check.json only.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        checkName: z.string().min(1),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath, checkName }) => textResult(await executeNamedCheck(policy, baseDir, workspacePath, checkName))
  );
}

export async function executeNamedCheck(policy: ConsolePolicy, baseDir: string, workspacePath: string, checkName: string): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const check = policy.allowedChecks.checks[checkName];

  if (!check) {
    throw new Error(`Unknown check name: ${checkName}`);
  }

  const result = await runNamedCheck(baseDir, checkName, workspace, check);
  const stdout = truncateText(sanitizeText(result.stdout), 12000);
  const stderr = truncateText(sanitizeText(result.stderr), 12000);

  return {
    ok: result.exitCode === 0,
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
