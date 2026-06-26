import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const allowedComposerScripts = new Set(["validate", "test", "canon:interfacing", "cs:fix", "php-cs-fixer"]);
const allowedNpmScripts = new Set(["build", "test", "ui:check", "typecheck"]);

export function registerQaTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleToolRegistration(authConfig);

  server.registerTool(
    "console.composer_script",
    {
      description: "Run an allowed Composer script or command in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        script: z.enum(["validate", "test", "canon:interfacing", "cs:fix", "php-cs-fixer"]),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, script }) => textResult(await runComposer(policy, workspacePath, script))
  );

  server.registerTool(
    "console.npm_script",
    {
      description: "Run an allowed npm script in a workspace.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        script: z.enum(["build", "test", "ui:check", "typecheck"]),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, script }) => textResult(await runAllowedScript(policy, workspacePath, "npm", ["run", script], 120000))
  );

  server.registerTool(
    "console.php_lint_file",
    {
      description: "Run php -l for one repository PHP file.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        filePath: z.string().min(1),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, filePath }) => textResult(await runAllowedScript(policy, workspacePath, "php", ["-l", normalizeRepoPath(filePath)], 30000))
  );

  server.registerTool(
    "console.php_lint_changed",
    {
      description: "Run php -l for changed repository PHP files.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        includeUntracked: z.boolean().optional(),
      }).strict(),
      ...registration,
    },
    async ({ workspacePath, includeUntracked }) => textResult(await lintChangedPhp(policy, workspacePath, Boolean(includeUntracked)))
  );
}

async function runComposer(policy: ConsolePolicy, workspacePath: string, script: string): Promise<Record<string, unknown>> {
  if (!allowedComposerScripts.has(script)) {
    throw new Error(`Composer script is not allowed: ${script}`);
  }

  const args = script === "validate" ? ["validate"] : ["run-script", script];
  return runAllowedScript(policy, workspacePath, "composer", args, 120000);
}

async function runAllowedScript(policy: ConsolePolicy, workspacePath: string, commandName: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, commandName, args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  return { ok: result.ok, command: [commandName, ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

async function lintChangedPhp(policy: ConsolePolicy, workspacePath: string, includeUntracked: boolean): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const diff = await runSupervisedCommand(cwd, "git", ["diff", "--name-only", "--diff-filter=ACMRT"], 30000);
  const files = new Set(diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".php")));

  if (includeUntracked) {
    const untracked = await runSupervisedCommand(cwd, "git", ["ls-files", "--others", "--exclude-standard"], 30000);
    for (const file of untracked.stdout.split(/\r?\n/)) {
      const trimmed = file.trim();
      if (trimmed.endsWith(".php")) {
        files.add(trimmed);
      }
    }
  }

  const selected = Array.from(files).slice(0, 100).map(normalizeRepoPath);
  const results = [];
  for (const file of selected) {
    results.push(await runAllowedScript(policy, workspacePath, "php", ["-l", file], 30000));
  }

  return { ok: results.every((item) => item.ok), fileCount: selected.length, files: selected, truncated: files.size > selected.length, results };
}
