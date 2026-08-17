import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const environmentSchema = z.enum(["dev", "test", "prod"]);
const configurationPattern = /^bin\/[A-Za-z0-9._-]+\.ya?ml$/;

const planSchema = z.object({
  workspacePath: z.string().min(1),
  configurationPath: z.string().regex(configurationPattern).optional(),
  env: environmentSchema.default("prod"),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
}).strict();

const migrateSchema = planSchema.extend({
  expectedPlanFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.boolean().default(false),
}).strict();

type PlanInput = z.infer<typeof planSchema>;
type MigrationPlan = {
  ok: boolean;
  status: string;
  workspacePath: string;
  env: string;
  configurationPath: string | null;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  planFingerprint: string;
};

export function registerDoctrineMigrationTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.database.doctrine.migrations.plan",
    {
      description: "Build a guarded Doctrine migrations dry-run plan and return a fingerprint required for execution.",
      inputSchema: planSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await buildPlan(policy, input)),
  );

  server.registerTool(
    "console.write.database.doctrine.migrations.migrate",
    {
      description: "Apply pending Doctrine migrations only after a matching guarded dry-run plan. Requires explicit confirmation and rejects stale plans.",
      inputSchema: migrateSchema,
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await migrate(policy, input)),
  );
}

async function buildPlan(policy: ConsolePolicy, input: PlanInput): Promise<MigrationPlan> {
  const cwd = resolveWorkspace(policy, input.workspacePath);
  const configurationPath = resolveConfiguration(cwd, input.configurationPath);
  const args = migrationArgs(input.env, configurationPath, true);
  const result = await runSupervisedCommand(cwd, "php", args, input.timeoutMs ?? 180000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);
  const planFingerprint = fingerprint({
    workspacePath: cwd,
    env: input.env,
    configurationPath,
    command: ["php", ...args].join(" "),
    exitCode: result.exitCode,
    stdout: normalizePlanOutput(result.stdout),
    stderr: normalizePlanOutput(result.stderr),
  });

  return {
    ok: result.ok,
    status: result.ok ? "MIGRATION_PLAN_READY" : "MIGRATION_PLAN_FAILED",
    workspacePath: cwd,
    env: input.env,
    configurationPath,
    command: ["php", ...args].join(" "),
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    planFingerprint,
  };
}

async function migrate(policy: ConsolePolicy, input: z.infer<typeof migrateSchema>): Promise<Record<string, unknown>> {
  if (!input.confirm) {
    return { ok: false, status: "MIGRATION_CONFIRMATION_REQUIRED", expectedPlanFingerprint: input.expectedPlanFingerprint };
  }

  const freshPlan = await buildPlan(policy, input);
  if (!freshPlan.ok) {
    return { ok: false, status: "MIGRATION_PLAN_FAILED", plan: freshPlan };
  }
  if (freshPlan.planFingerprint !== input.expectedPlanFingerprint) {
    return {
      ok: false,
      status: "MIGRATION_PLAN_STALE",
      expectedPlanFingerprint: input.expectedPlanFingerprint,
      actualPlanFingerprint: freshPlan.planFingerprint,
      plan: freshPlan,
    };
  }

  const cwd = freshPlan.workspacePath;
  const args = migrationArgs(input.env, freshPlan.configurationPath, false);
  const result = await runSupervisedCommand(cwd, "php", args, input.timeoutMs ?? 300000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);

  return {
    ok: result.ok,
    status: result.ok ? "MIGRATION_APPLIED" : "MIGRATION_FAILED",
    verifiedPlanFingerprint: freshPlan.planFingerprint,
    command: ["php", ...args].join(" "),
    cwd,
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function resolveWorkspace(policy: ConsolePolicy, workspacePath: string): string {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  if (!existsSync(path.join(cwd, "bin", "console"))) {
    throw new Error("COMMAND_NOT_FOUND: workspace does not contain bin/console.");
  }
  return cwd;
}

function resolveConfiguration(cwd: string, configurationPath: string | undefined): string | null {
  if (!configurationPath) return null;
  const normalized = configurationPath.replace(/\\/g, "/");
  if (!configurationPattern.test(normalized)) throw new Error("ARGUMENT_NOT_ALLOWED: invalid migration configuration path.");
  if (!existsSync(path.join(cwd, ...normalized.split("/")))) throw new Error(`COMMAND_NOT_FOUND: migration configuration file does not exist: ${normalized}`);
  return normalized;
}

function migrationArgs(env: string, configurationPath: string | null, dryRun: boolean): string[] {
  const args = ["bin/console", "doctrine:migrations:migrate", "--no-interaction", `--env=${env}`];
  if (configurationPath) args.push(`--configuration=${configurationPath}`);
  if (dryRun) args.push("--dry-run");
  return args;
}

function normalizePlanOutput(output: string): string {
  return output.replace(/finished in [0-9.]+ms, used [0-9.]+[KMG]? memory,/gu, "finished in <elapsed>, used <memory>,");
}

function fingerprint(value: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
