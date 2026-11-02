import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const allowedDevConsoleCommands = [
  "browser-status",
  "browser-ensure-visible",
  "chatgpt-page-status",
  "chatgpt-ensure-page",
  "chatgpt-session-status",
  "desktop-preflight",
  "desktop-heal-plan",
  "desktop-agent-heartbeat",
  "desktop-agent-heartbeat-loop",
  "desktop-agent-start-loop",
  "desktop-agent-stop-loop",
  "desktop-agent-loop-status",
  "desktop-agent-install-task-plan",
  "stack-snapshot",
  "stack-preflight",
  "watchdog-heal",
  "watchdog-status",
  "watchdog-freshness-status",
  "watchdog-loop-status",
  "runtime-environment-status",
  "runtime-release-provenance",
  "aws-status",
  "aws-secrets-qodana-status",
  "aws-secret-qodana-check"
] as const;

type AllowedDevConsoleCommand = (typeof allowedDevConsoleCommands)[number];

export function registerDevConsoleCommandTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const diagnosticCommands = [
    { name: "read_.runtime.watchdog.status", command: "watchdog-status" },
    { name: "read_.runtime.watchdog.freshness", command: "watchdog-freshness-status" },
    { name: "read_.runtime.watchdog.loop.status", command: "watchdog-loop-status" },
    { name: "read_.runtime.environment.status", command: "runtime-environment-status" },
    { name: "read_.runtime.release.provenance", command: "runtime-release-provenance" },
    { name: "read_.runtime.desktop.preflight", command: "desktop-preflight" },
    { name: "read_.runtime.desktop.agent.status", command: "desktop-agent-loop-status" },
    { name: "read_.runtime.browser.status", command: "browser-status" },
    { name: "read_.runtime.chatgpt.session.status", command: "chatgpt-session-status" }
  ] as const;
  for (const diagnostic of diagnosticCommands) {
    server.registerTool(diagnostic.name, {
      ...buildConsoleToolRegistration(authConfig),
      description: `Read-only diagnostic: execute only the fixed dev-console ${diagnostic.command} status operation. No caller-selected commands, scripts, or arguments.`,
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict().shape
    }, async ({ workspacePath }) => textResult(await runDevConsoleCommand(policy, workspacePath, diagnostic.command, 30000)));
  }
  server.registerTool("write.runtime.desktop.heartbeat", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Write one desktop-agent heartbeat using the fixed dev-console heartbeat operation; does not start or stop the agent.",
    inputSchema: z.object({ workspacePath: z.string().min(1), confirm: z.literal(true) }).strict().shape
  }, async ({ workspacePath }) => textResult(await runDevConsoleCommand(policy, workspacePath, "desktop-agent-heartbeat", 30000)));
  server.registerTool(
    "write.dev.console.command.run",
    {
      ...buildConsoleMutationToolRegistration(authConfig),
      description: "Run an allowlisted dev-console.ps1 command for diagnostics, safe browser/watchdog recovery, or watchdog-owned server stop. Restart, watchdog shutdown, cleanup, prompt drafting, and prompt submission commands are not allowed.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        command: z.enum(allowedDevConsoleCommands),
        timeoutMs: z.number().int().min(1000).max(120000).optional()
      }).shape
    },
    async ({ workspacePath, command, timeoutMs }) => textResult(await runDevConsoleCommand(policy, workspacePath, command, timeoutMs))
  );
}

async function runDevConsoleCommand(policy: ConsolePolicy, workspacePath: string, command: AllowedDevConsoleCommand, timeoutMsInput: number | undefined): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const scriptPath = path.join(workspace, "tool", "dev-console.ps1");
  if (!existsSync(scriptPath)) {
    throw new Error(`dev-console.ps1 was not found at ${scriptPath}`);
  }

  const timeoutMs = clampTimeout(timeoutMsInput);
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, command];
  const result = await runSupervisedCommand(workspace, "pwsh", args, timeoutMs, 2 * 1024 * 1024);
  const stdout = truncateOutput(sanitizeText(result.stdout), 12000);
  const stderr = truncateOutput(sanitizeText(result.stderr), 12000);
  const parsed = parseJsonObject(stdout.text);
  const parsedOk = parsed && typeof parsed.ok === "boolean" ? parsed.ok : null;

  return {
    ok: result.exitCode === 0 && parsedOk !== false,
    status: result.exitCode === 0 ? "DEV_CONSOLE_COMMAND_COMPLETED" : "DEV_CONSOLE_COMMAND_FAILED",
    mode: "allowlisted-dev-console-command-runner",
    command,
    cwd: workspace,
    script_path: scriptPath,
    allowlist: allowedDevConsoleCommands,
    exitCode: result.exitCode,
    timeoutMs,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    parsed_json: parsed
  };
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 30000;
  return Math.max(1000, Math.min(120000, Math.trunc(value as number)));
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

