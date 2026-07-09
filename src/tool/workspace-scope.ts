import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot, assertReadablePath } from "../Policy/PathGuard.js";
import { normalizePath } from "../Policy/ConsolePolicy.js";
import { readTextFile, searchText } from "../Infrastructure/FileSystem/SafeFileSystem.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const scopeInputSchema = z.object({
  componentName: z.string().min(1).max(120).optional(),
  workspacePath: z.string().min(1).optional(),
}).strict();

const relativePathSchema = z.string().min(1).max(500).refine((value) => !path.isAbsolute(value), {
  message: "Path must be relative to the resolved workspace scope.",
}).refine((value) => !value.split(/[\\/]+/).includes(".."), {
  message: "Path must not traverse outside the resolved workspace scope.",
});

type ScopeInput = z.infer<typeof scopeInputSchema>;

export function registerWorkspaceScopeTools(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.workspace.scope.resolve",
    {
      description: "Resolve a repository workspace scope from a component name or optional compatibility workspace path.",
      inputSchema: scopeInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(resolveWorkspaceScope(policy, input))
  );

  server.registerTool(
    "console.read_.repo.file.bundle.read",
    {
      description: "Read allowlisted relative files from a resolved workspace scope without passing absolute file paths.",
      inputSchema: scopeInputSchema.extend({
        paths: z.array(relativePathSchema).min(1).max(50),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await readRelativeFileBundle(policy, input))
  );

  server.registerTool(
    "console.read_.repo.text.scope.search",
    {
      description: "Search text under a resolved workspace scope without passing an absolute workspace path.",
      inputSchema: scopeInputSchema.extend({
        query: z.string().min(1),
        maxResults: z.number().int().positive().max(200).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await searchScopedText(policy, input))
  );
}

function resolveWorkspaceScope(policy: ConsolePolicy, input: ScopeInput): {
  ok: true;
  scopeId: string;
  workspaceRoot: string;
  workspacePath: string;
  relativeWorkspacePath: string;
  source: "componentName" | "workspacePath";
  componentName: string | null;
} {
  const componentName = input.componentName?.trim() || null;
  if (!componentName && !input.workspacePath) {
    throw new Error("Either componentName or workspacePath is required.");
  }

  const workspaceRoot = assertAllowedRoot(policy.workspaceRoot, policy.allowedRoots);
  const workspacePath = input.workspacePath
    ? assertAllowedRoot(input.workspacePath, policy.allowedRoots)
    : assertAllowedRoot(path.join(workspaceRoot, assertSafeComponentName(componentName ?? "")), policy.allowedRoots);

  if (!isWithinWorkspaceRoot(workspacePath, workspaceRoot)) {
    throw new Error(`Resolved workspace is outside the configured workspace root: ${workspacePath}`);
  }

  const inferredComponent = componentName ?? path.basename(workspacePath);
  return {
    ok: true,
    scopeId: normalizeScopeId(inferredComponent),
    workspaceRoot,
    workspacePath,
    relativeWorkspacePath: path.relative(workspaceRoot, workspacePath).replaceAll("\\", "/"),
    source: input.workspacePath ? "workspacePath" : "componentName",
    componentName: inferredComponent,
  };
}

async function readRelativeFileBundle(policy: ConsolePolicy, input: ScopeInput & { paths: string[] }): Promise<{
  ok: true;
  scope: ReturnType<typeof resolveWorkspaceScope>;
  files: Array<{ path: string; sizeBytes: number; truncated: boolean; content: string }>;
}> {
  const scope = resolveWorkspaceScope(policy, input);
  const files = [];
  for (const relativePath of input.paths) {
    const absolutePath = resolveRelativePath(scope.workspacePath, relativePath);
    assertReadablePath(absolutePath, policy.deniedPath, [scope.workspacePath]);
    const file = await readTextFile(policy, absolutePath);
    files.push({
      path: path.relative(scope.workspacePath, file.path).replaceAll("\\", "/"),
      sizeBytes: file.sizeBytes,
      truncated: file.truncated,
      content: file.content,
    });
  }

  return { ok: true, scope, files };
}

async function searchScopedText(policy: ConsolePolicy, input: ScopeInput & { query: string; maxResults?: number }): Promise<{
  ok: true;
  scope: ReturnType<typeof resolveWorkspaceScope>;
  query: string;
  scannedFiles: number;
  matches: Array<{ file: string; line: number; column: number; snippet: string }>;
}> {
  const scope = resolveWorkspaceScope(policy, input);
  const result = await searchText(policy, scope.workspacePath, input.query, input.maxResults ?? policy.maxSearchResults);
  return {
    ok: true,
    scope,
    query: result.query,
    scannedFiles: result.scannedFiles,
    matches: result.matches.map((match) => ({
      ...match,
      file: path.relative(scope.workspacePath, match.file).replaceAll("\\", "/"),
    })),
  };
}

function assertSafeComponentName(componentName: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(componentName)) {
    throw new Error(`Component name contains unsupported characters: ${componentName}`);
  }

  return componentName;
}

function resolveRelativePath(workspacePath: string, relativePath: string): string {
  const resolved = normalizePath(path.join(workspacePath, relativePath));
  if (!isWithinWorkspaceRoot(resolved, workspacePath)) {
    throw new Error(`Relative path escapes the workspace scope: ${relativePath}`);
  }

  return resolved;
}

function isWithinWorkspaceRoot(candidatePath: string, workspacePath: string): boolean {
  const relative = path.relative(normalizePath(workspacePath), normalizePath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeScopeId(componentName: string): string {
  return componentName.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}
