import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { assertAllowedRoot } from "../service/path.js";
import type { ConsolePolicy } from "../service/policy.js";
import { getWorkspaceStatus } from "./workspace-status.js";
import { readLatestBuildCommand } from "../service/transcript.js";
import { runSupervisedCommand, truncateOutput } from "../service/command.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

export function registerCaptureContextTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.context.capture",
    {
      description: "Capture compact workspace context using only approved read-only operations.",
      inputSchema: z.object({ workspacePath: z.string().min(1) }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ workspacePath }) => textResult(await captureContext(policy, baseDir, workspacePath))
  );
}

export async function captureContext(policy: ConsolePolicy, baseDir: string, workspacePath: string): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const status = await getWorkspaceStatus(policy, cwd);

  const packageJsonPath = path.join(cwd, "package.json");
  const composerJsonPath = path.join(cwd, "composer.json");

  const packageScripts = await readScriptsIfPresent(packageJsonPath);
  const composerScripts = await readScriptsIfPresent(composerJsonPath);
  const codeMemoryScope = await resolveCompactCodeMemoryScope(cwd, composerScripts);
  const latestBuildCommand = await readLatestBuildCommand(path.join(baseDir, "var", "transcript"));

  return {
    cwd,
    git: status,
    package_scripts: packageScripts,
    composer_scripts: composerScripts,
    code_memory_scope: codeMemoryScope,
    last_build_test_command: latestBuildCommand,
  };
}

async function readScriptsIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? null;
  } catch {
    return null;
  }
}

async function resolveCompactCodeMemoryScope(cwd: string, composerScripts: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  if (composerScripts === null) {
    return { ok: true, status: "CODE_MEMORY_SCOPE_COMPOSER_JSON_NOT_FOUND", declared: false };
  }

  if (!("memory:scope:resolve" in composerScripts)) {
    return { ok: true, status: "CODE_MEMORY_SCOPE_SCRIPT_NOT_DECLARED", declared: false };
  }

  const result = await runSupervisedCommand(cwd, "composer", ["run-script", "memory:scope:resolve"], 120000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, 30000);
  const stderr = truncateOutput(result.stderr, 8000);
  let scope: Record<string, unknown> | null = null;
  let parseError: string | null = null;

  try {
    const parsed = JSON.parse(stdout.text.trim()) as unknown;
    scope = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: result.ok && scope !== null,
    status: result.ok && scope !== null ? "CODE_MEMORY_SCOPE_RESOLVED" : "CODE_MEMORY_SCOPE_RESOLVE_FAILED",
    declared: true,
    command: "composer run-script memory:scope:resolve",
    cwd,
    exitCode: result.exitCode,
    parse_error: parseError,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    summary: scope === null ? null : summarizeCodeMemoryScope(scope),
  };
}

function summarizeCodeMemoryScope(scope: Record<string, unknown>): Record<string, unknown> {
  const editProjects = normalizeScopeProjectList(scope.editProjects);
  const readProjects = normalizeScopeProjectList(scope.readProjects);
  const globalProject = typeof scope.globalProject === "object" && scope.globalProject !== null ? scope.globalProject as Record<string, unknown> : null;
  const rules = typeof scope.rules === "object" && scope.rules !== null ? scope.rules as Record<string, unknown> : null;

  return {
    activeRoot: stringOrNull(scope.activeRoot),
    activeProject: stringOrNull(scope.activeProject),
    mode: stringOrNull(scope.mode),
    source: stringOrNull(scope.source),
    dependencyFingerprint: stringOrNull(scope.dependencyFingerprint),
    editProjectCount: editProjects.length,
    editProjectNames: editProjects.map((project) => project.project).filter((value): value is string => value !== null),
    readProjectCount: readProjects.length,
    readProjectNames: readProjects.map((project) => project.project).filter((value): value is string => value !== null),
    globalProject: globalProject === null ? null : {
      project: stringOrNull(globalProject.project),
      root: stringOrNull(globalProject.root),
      mode: stringOrNull(globalProject.mode),
      weight: typeof globalProject.weight === "number" ? globalProject.weight : null,
    },
    rules: rules === null ? null : {
      rawUnscopedGraphSearchAllowed: rules.rawUnscopedGraphSearchAllowed === true,
      linkedProjectEditAllowedByDefault: rules.linkedProjectEditAllowedByDefault === true,
      relatedProjectSourceOfTruth: stringOrNull(rules.relatedProjectSourceOfTruth),
    },
  };
}

function normalizeScopeProjectList(value: unknown): Array<{ project: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => {
    if (typeof item !== "object" || item === null) {
      return { project: null };
    }

    return { project: stringOrNull((item as Record<string, unknown>).project) };
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
