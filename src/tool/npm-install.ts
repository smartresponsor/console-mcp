import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

const installStrategies = ["auto", "ci", "install"] as const;
type InstallStrategy = (typeof installStrategies)[number];
type ResolvedInstallStrategy = "ci" | "install";

export function registerNpmInstallTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.write.package.npm.install",
    {
      description: "Install workspace npm dependencies. Auto mode uses frozen npm ci when package-lock.json exists and a lockfile-preserving npm install --no-package-lock bootstrap otherwise. Mutable npm install requires explicit confirmation.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        strategy: z.enum(installStrategies).default("auto"),
        omitDev: z.boolean().default(false),
        ignoreScripts: z.boolean().default(true),
        confirmMutableInstall: z.boolean().default(false),
        timeoutMs: z.number().int().min(10000).max(600000).optional(),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await installNpmDependencies(policy, input))
  );
}

async function installNpmDependencies(
  policy: ConsolePolicy,
  input: {
    workspacePath: string;
    strategy: InstallStrategy;
    omitDev: boolean;
    ignoreScripts: boolean;
    confirmMutableInstall: boolean;
    timeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  const packageJsonPath = path.join(workspace, "package.json");
  const packageLockPath = path.join(workspace, "package-lock.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error("package.json was not found in the workspace root.");
  }

  const packageLockPresent = existsSync(packageLockPath);
  const resolvedStrategy: ResolvedInstallStrategy = input.strategy === "auto"
    ? packageLockPresent ? "ci" : "install"
    : input.strategy;
  const preserveMissingLockfile = input.strategy === "auto" && !packageLockPresent;

  if (resolvedStrategy === "ci" && !packageLockPresent) {
    throw new Error("npm ci requires package-lock.json in the workspace root.");
  }
  if (input.strategy === "install" && input.confirmMutableInstall !== true) {
    throw new Error("Mutable npm install may modify package-lock.json and requires confirmMutableInstall=true.");
  }

  const args = [resolvedStrategy];
  if (preserveMissingLockfile) args.push("--no-package-lock");
  if (input.omitDev) args.push("--omit=dev");
  if (input.ignoreScripts) args.push("--ignore-scripts");
  args.push("--no-audit", "--no-fund");

  const timeoutMs = input.timeoutMs ?? 300000;
  const result = await runSupervisedCommand(workspace, "npm", args, timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, 24000);
  const stderr = truncateOutput(result.stderr, 24000);

  return {
    ok: result.exitCode === 0,
    status: result.exitCode === 0 ? "NPM_DEPENDENCIES_INSTALLED" : "NPM_DEPENDENCY_INSTALL_FAILED",
    mode: "guarded-npm-dependency-install",
    requested_strategy: input.strategy,
    resolved_strategy: resolvedStrategy,
    reproducibility: resolvedStrategy === "ci" ? "lockfile-frozen" : preserveMissingLockfile ? "lockfile-absent-bootstrap" : "mutable-install",
    workspace_path: workspace,
    package_lock_present: packageLockPresent,
    package_lock_preserved: preserveMissingLockfile,
    ignore_scripts: input.ignoreScripts,
    omit_dev: input.omitDev,
    command: ["npm", ...args],
    exitCode: result.exitCode,
    timeoutMs,
    stdout: stdout.text,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
  };
}
