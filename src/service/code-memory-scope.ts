import { readFile } from "node:fs/promises";
import path from "node:path";
import { runSupervisedCommand, truncateOutput } from "./command.js";
import { normalizePath, type ConsolePolicy } from "./policy.js";

export type CodeMemoryScopeEvidence = Record<string, unknown>;

export async function readComposerScripts(workspacePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path.join(workspacePath, "composer.json"), "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? null;
  } catch {
    return null;
  }
}

export function isWorkspaceUmbrellaRoot(policy: Pick<ConsolePolicy, "workspaceRoot">, workspacePath: string): boolean {
  return samePath(workspacePath, policy.workspaceRoot);
}

export function assertNotWorkspaceUmbrellaRoot(policy: Pick<ConsolePolicy, "workspaceRoot">, workspacePath: string, action: string): void {
  if (!isWorkspaceUmbrellaRoot(policy, workspacePath)) {
    return;
  }

  throw new Error(`WORKSPACE_ROOT_IS_UMBRELLA: ${action} requires a child active project root. The workspace root may exist as a backup Git repository, but it is navigation-only for implementation writes.`);
}

export function buildWorkspaceUmbrellaWarning(policy: ConsolePolicy, workspacePath: string): CodeMemoryScopeEvidence {
  return {
    ok: false,
    status: "WORKSPACE_ROOT_IS_UMBRELLA",
    workspacePath: normalizePath(workspacePath),
    workspaceRoot: normalizePath(policy.workspaceRoot),
    activeProjectRequired: true,
    physicalGitRepositoryAllowed: true,
    message: "The workspace root is an umbrella/trust boundary. Use a child project root as the active workspace; the umbrella graph is navigation-only.",
    examples: [
      path.join(policy.workspaceRoot, "App"),
      path.join(policy.workspaceRoot, "Cataloging"),
      path.join(policy.workspaceRoot, "mcp", "console-mcp"),
    ],
    globalProject: {
      project: memoryProjectName(policy.workspaceRoot),
      root: normalizeForMemoryRoot(policy.workspaceRoot),
      mode: "navigation-only",
      weight: 0.1,
    },
    rules: {
      rawUnscopedGraphSearchAllowed: false,
      linkedProjectEditAllowedByDefault: false,
      editScope: "child-active-project-only",
    },
  };
}

export async function resolveCompactCodeMemoryScope(workspacePath: string, composerScripts?: Record<string, unknown> | null): Promise<CodeMemoryScopeEvidence> {
  const scripts = composerScripts === undefined ? await readComposerScripts(workspacePath) : composerScripts;
  if (scripts === null) {
    return { ok: true, status: "CODE_MEMORY_SCOPE_COMPOSER_JSON_NOT_FOUND", declared: false };
  }

  if (!("memory:scope:resolve" in scripts)) {
    return { ok: true, status: "CODE_MEMORY_SCOPE_SCRIPT_NOT_DECLARED", declared: false };
  }

  const result = await runSupervisedCommand(workspacePath, "composer", ["run-script", "memory:scope:resolve"], 120000, 4 * 1024 * 1024);
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
    cwd: workspacePath,
    exitCode: result.exitCode,
    parse_error: parseError,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrTruncated: stderr.truncated,
    summary: scope === null ? null : summarizeCodeMemoryScope(scope),
  };
}

export function buildCodeMemoryGraphSearchPlan(policy: ConsolePolicy, workspacePath: string, scopeEvidence: CodeMemoryScopeEvidence, operation: string, implementationFlow: boolean): CodeMemoryScopeEvidence {
  const umbrella = isWorkspaceUmbrellaRoot(policy, workspacePath);
  const summary = typeof scopeEvidence.summary === "object" && scopeEvidence.summary !== null
    ? scopeEvidence.summary as Record<string, unknown>
    : (typeof scopeEvidence.scope === "object" && scopeEvidence.scope !== null ? summarizeCodeMemoryScope(scopeEvidence.scope as Record<string, unknown>) : null);
  const activeProject = typeof summary?.activeProject === "string" ? summary.activeProject : memoryProjectName(workspacePath);
  const readProjectNames = Array.isArray(summary?.readProjectNames) ? summary.readProjectNames.map(String).filter(Boolean) : [activeProject];
  const editProjectNames = Array.isArray(summary?.editProjectNames) ? summary.editProjectNames.map(String).filter(Boolean) : [activeProject];
  const globalProject = typeof summary?.globalProject === "object" && summary.globalProject !== null ? summary.globalProject as Record<string, unknown> : {
    project: memoryProjectName(policy.workspaceRoot),
    root: normalizeForMemoryRoot(policy.workspaceRoot),
    mode: "navigation-only",
    weight: 0.1,
  };
  const uniqueReadProjects = [...new Set(readProjectNames)];
  const activeRoot = typeof summary?.activeRoot === "string" ? summary.activeRoot : normalizeForMemoryRoot(workspacePath);

  if (umbrella) {
    return {
      ok: !implementationFlow,
      status: implementationFlow ? "CODE_MEMORY_GRAPH_PLAN_BLOCKED_UMBRELLA_IMPLEMENTATION" : "CODE_MEMORY_GRAPH_PLAN_WORKSPACE_NAVIGATION_ONLY",
      operation,
      implementationFlow,
      workspacePath: normalizePath(workspacePath),
      activeRoot: null,
      activeProject: null,
      rawUnscopedGraphSearchAllowed: false,
      graphTargets: [
        {
          project: String(globalProject.project ?? memoryProjectName(policy.workspaceRoot)),
          root: String(globalProject.root ?? normalizeForMemoryRoot(policy.workspaceRoot)),
          role: "global-navigation",
          access: "read-only",
          weight: 0.1,
          allowedForImplementation: false,
        },
      ],
      editProjects: [],
      readProjects: [],
      globalProject,
      blockingReasons: implementationFlow ? ["workspace_root_is_umbrella", "active_child_project_root_required"] : [],
      nextAction: implementationFlow ? "use_child_active_project_root" : "navigation_only_query_allowed",
      scopeEvidence,
    };
  }

  const targets = uniqueReadProjects.map((project) => {
    const isActive = project === activeProject;
    const editable = editProjectNames.includes(project);
    return {
      project,
      root: isActive ? activeRoot : null,
      role: isActive ? "active" : "related-composer-path",
      access: editable ? "read-write-boundary" : "read-only",
      weight: isActive ? 1.0 : 0.7,
      allowedForImplementation: isActive,
    };
  });

  targets.push({
    project: String(globalProject.project ?? memoryProjectName(policy.workspaceRoot)),
    root: String(globalProject.root ?? normalizeForMemoryRoot(policy.workspaceRoot)),
    role: "global-navigation",
    access: "read-only",
    weight: 0.1,
    allowedForImplementation: false,
  });

  return {
    ok: true,
    status: "CODE_MEMORY_GRAPH_PLAN_READY",
    operation,
    implementationFlow,
    workspacePath: normalizePath(workspacePath),
    activeRoot,
    activeProject,
    mode: summary?.mode ?? "repo-local",
    source: summary?.source ?? "active-workspace-fallback",
    dependencyFingerprint: summary?.dependencyFingerprint ?? null,
    rawUnscopedGraphSearchAllowed: false,
    graphTargets: targets,
    editProjects: editProjectNames,
    readProjects: uniqueReadProjects,
    globalProject,
    blockingReasons: [],
    nextAction: "call_codebase_memory_with_explicit_project_targets_only",
    scopeEvidence,
  };
}

export function summarizeCodeMemoryScope(scope: Record<string, unknown>): Record<string, unknown> {
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
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "object" && item !== null ? { project: stringOrNull((item as Record<string, unknown>).project) } : { project: null });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left).replaceAll("/", "\\").toLowerCase() === normalizePath(right).replaceAll("/", "\\").toLowerCase();
}

function normalizeForMemoryRoot(value: string): string {
  return normalizePath(value).replaceAll("\\", "/");
}

function memoryProjectName(rootPath: string): string {
  return normalizeForMemoryRoot(rootPath).replace(/^[A-Za-z]:\//, (prefix) => prefix[0].toUpperCase() + "-").replaceAll("/", "-");
}
