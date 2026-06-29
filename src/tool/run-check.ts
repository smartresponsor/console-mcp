import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { AllowedCheck, ConsolePolicy } from "../service/policy.js";
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
  const check = await resolveCheckDefinition(policy, workspace, checkName);

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

async function resolveCheckDefinition(policy: ConsolePolicy, workspace: string, checkName: string): Promise<AllowedCheck | null> {
  const direct = policy.allowedChecks.checks[checkName];
  if (direct) {
    return direct;
  }

  if (!isSafeComposerScriptName(checkName)) {
    return null;
  }

  const composerPath = path.join(workspace, "composer.json");
  if (!existsSync(composerPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(await readFile(composerPath, "utf8")) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
      return null;
    }

    if (!(checkName in parsed.scripts)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    command: "composer",
    args: ["run-script", checkName],
    cwdMode: "workspaceRoot",
    timeoutMs: policy.allowedChecks.defaultTimeoutMs,
  };
}

function isSafeComposerScriptName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$/.test(name);
}
