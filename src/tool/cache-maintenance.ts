import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";


export function registerCacheMaintenanceTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const registration = buildConsoleMutationToolRegistration(authConfig);
  server.registerTool("console.var_prune", {
    description: "Prune workspace var path with dry-run by default and explicit confirmation required.",
    inputSchema: z.object({ workspacePath: z.string().min(1), target: z.string().min(1).default("var"), dryRun: z.boolean().default(true), confirm: z.boolean().default(false) }).strict(),
    ...registration,
  }, async ({ workspacePath, target, dryRun, confirm }) => textResult(await pruneVarPath(policy, workspacePath, target, dryRun, confirm)));
  server.registerTool("console.cache_clear", {
    description: "Run allowlisted PHP or Symfony cache maintenance for a workspace.",
    inputSchema: z.object({ workspacePath: z.string().min(1), mode: z.enum(["php_opcache_reset", "symfony_cache_clear", "both"]).default("symfony_cache_clear"), env: z.enum(["dev", "prod", "test"]).default("dev") }).strict(),
    ...registration,
  }, async ({ workspacePath, mode, env }) => textResult(await clearRuntimeCache(policy, workspacePath, mode, env)));
}

async function pruneVarPath(policy: ConsolePolicy, workspacePath: string, target: string, dryRun: boolean, confirm: boolean): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const targetPath = resolveVarTarget(workspace, target);
  const exists = existsSync(targetPath);
  if (dryRun || !confirm || !exists) {
    return { ok: dryRun || !exists, action: "var_prune", dryRun, confirmed: confirm, deleted: false, exists, workspace, target: toRepoPath(workspace, targetPath) };
  }
  await rm(targetPath, { recursive: true, force: true });
  return { ok: true, action: "var_prune", dryRun, confirmed: confirm, deleted: true, exists, workspace, target: toRepoPath(workspace, targetPath) };
}

function resolveVarTarget(workspace: string, target: string): string {
  const normalizedTarget = target.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalizedTarget !== "var" && !normalizedTarget.startsWith("var/")) {
    throw new Error("Target must be var or a child path inside var.");
  }
  const resolved = path.resolve(workspace, normalizedTarget);
  const relative = path.relative(workspace, resolved).replaceAll("\\", "/");
  if (relative !== "var" && !relative.startsWith("var/")) throw new Error("Resolved target escaped workspace var boundary.");
  return resolved;
}
function toRepoPath(workspace: string, absolutePath: string): string {
  return path.relative(workspace, absolutePath).replaceAll("\\", "/");
}

async function clearRuntimeCache(policy: ConsolePolicy, workspacePath: string, mode: "php_opcache_reset" | "symfony_cache_clear" | "both", env: "dev" | "prod" | "test"): Promise<Record<string, unknown>> {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const results = [] as Array<Record<string, unknown>>;
  if (mode === "php_opcache_reset" || mode === "both") results.push(await runCacheCommand(workspace, "php", buildPhpOpcacheResetArgs()));
  if (mode === "symfony_cache_clear" || mode === "both") results.push(await runCacheCommand(workspace, "php", ["bin/console", "cache:clear", "--env", env, "--no-warmup"]));
  return { ok: results.every((result) => result.ok === true), action: "cache_clear", mode, env, workspace, results };
}

async function runCacheCommand(workspace: string, command: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await runSupervisedCommand(workspace, command, args, 120000, 1024 * 1024);
  return { ok: result.ok, command: [result.command, ...result.args].join(" "), cwd: result.cwd, exit_code: result.exitCode };
}

function buildPhpOpcacheResetArgs(): string[] {
  const script = "echo 'opcache_check';";
  return ["-r", script];
}

