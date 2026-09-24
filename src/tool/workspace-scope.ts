import path from "node:path";
import { mkdir, rename, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot, assertReadablePath } from "../Policy/PathGuard.js";
import { normalizePath } from "../Policy/ConsolePolicy.js";
import { readTextFile, searchText } from "../Infrastructure/FileSystem/SafeFileSystem.js";
import { runSupervisedCommand, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildRepositoryRegistry, invalidateRepositoryRegistry, isWithinWorkspaceRoot, resolveRepositoryScope, type RepositoryScope } from "../service/repository-registry.js";
import { createRepositoryBinding, removeRepositoryBinding, resolveRepositoryBinding, resolveRepositoryScopeWithBinding } from "../service/repository-binding.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const scopeInputSchema = z.object({
  bindingId: z.string().uuid().optional(),
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
    async (input) => textResult(await resolveWorkspaceScope(policy, input))
  );

  server.registerTool(
    "console.write.repo.workspace.bind",
    {
      description: "Create a durable opaque binding ID for one canonical repository scope. Use the returned bindingId in later scope-aware repository calls.",
      inputSchema: z.object({
        componentName: z.string().min(1).max(120).optional(),
        workspacePath: z.string().min(1).optional(),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await createRepositoryBinding(policy, input))
  );

  server.registerTool(
    "console.read_.repo.workspace.binding.resolve",
    {
      description: "Resolve a durable repository binding ID to its canonical repository scope.",
      inputSchema: z.object({ bindingId: z.string().uuid() }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async ({ bindingId }) => textResult(await resolveRepositoryBinding(policy, bindingId))
  );

  server.registerTool(
    "console.write.repo.workspace.binding.remove",
    {
      description: "Remove a durable repository binding ID. This does not modify the bound repository.",
      inputSchema: z.object({ bindingId: z.string().uuid(), confirmRemove: z.boolean().default(false) }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async ({ bindingId, confirmRemove }) => {
      if (!confirmRemove) {
        return textResult({ ok: false, status: "CONFIRM_REPOSITORY_BINDING_REMOVE_REQUIRED", bindingId });
      }
      return textResult(await removeRepositoryBinding(policy, bindingId));
    }
  );

  server.registerTool(
    "console.read_.repo.workspace.registry",
    {
      description: "List canonical repository/component scopes discovered under the configured sandbox workspace root.",
      inputSchema: z.object({}).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async () => textResult(await buildRepositoryRegistry(policy))
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
        timeoutMs: z.number().int().min(250).max(30000).optional(),
      }).strict(),
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await searchScopedText(policy, input))
  );

  server.registerTool(
    "console.write.repo.workspace.create",
    {
      description: "Create a new repository directory under the configured sandbox workspace root and initialize Git without overwriting an existing path.",
      inputSchema: z.object({
        repositoryName: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/),
        initialBranch: z.string().min(1).max(120).regex(/^[A-Za-z0-9._\/-]+$/).default("master"),
        initializeGit: z.boolean().default(true),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await createWorkspaceRepository(policy, input))
  );

  server.registerTool(
    "console.write.repo.path.move",
    {
      description: "Move or rename one existing file or directory within a single workspace root. Cross-workspace moves and overwrites are refused.",
      inputSchema: z.object({
        workspacePath: z.string().min(1),
        sourcePath: relativePathSchema,
        destinationPath: relativePathSchema,
        dryRun: z.boolean().default(true),
        confirmMove: z.boolean().default(false),
      }).strict(),
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await moveWorkspacePath(policy, input))
  );
}

async function moveWorkspacePath(policy: ConsolePolicy, input: { workspacePath: string; sourcePath: string; destinationPath: string; dryRun: boolean; confirmMove: boolean }): Promise<Record<string, unknown>> {
  const scope = await resolveWorkspaceScope(policy, { workspacePath: input.workspacePath });
  const sourcePath = resolveRelativePath(scope.workspacePath, input.sourcePath);
  const destinationPath = resolveRelativePath(scope.workspacePath, input.destinationPath);
  if (sourcePath === destinationPath) throw new Error("Source and destination paths must be different.");

  const sourceStat = await stat(sourcePath);
  try {
    await stat(destinationPath);
    throw new Error(`Destination path already exists: ${input.destinationPath}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const plan = {
    workspacePath: scope.workspacePath,
    sourcePath: input.sourcePath.replaceAll("\\", "/"),
    destinationPath: input.destinationPath.replaceAll("\\", "/"),
    sourceType: sourceStat.isDirectory() ? "directory" : sourceStat.isFile() ? "file" : "other",
  };
  if (input.dryRun) return { ok: true, status: "PATH_MOVE_DRY_RUN", dryRun: true, ...plan };
  if (!input.confirmMove) return { ok: false, status: "CONFIRM_PATH_MOVE_REQUIRED", dryRun: false, ...plan, requires: { workspacePath: scope.workspacePath, sourcePath: input.sourcePath, destinationPath: input.destinationPath, dryRun: false, confirmMove: true } };

  await rename(sourcePath, destinationPath);
  return { ok: true, status: "PATH_MOVED", dryRun: false, ...plan };
}

async function createWorkspaceRepository(
  policy: ConsolePolicy,
  input: { repositoryName: string; initialBranch: string; initializeGit: boolean },
): Promise<Record<string, unknown>> {
  const workspaceRoot = assertAllowedRoot(policy.workspaceRoot, policy.allowedRoots);
  const repositoryName = assertSafeComponentName(input.repositoryName.trim());
  const workspacePath = assertAllowedRoot(path.join(workspaceRoot, repositoryName), policy.allowedRoots);

  if (!isWithinWorkspaceRoot(workspacePath, workspaceRoot) || workspacePath === workspaceRoot) {
    throw new Error(`Refused repository path outside the sandbox workspace root: ${workspacePath}`);
  }

  try {
    await stat(workspacePath);
    throw new Error(`Repository path already exists: ${workspacePath}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(workspacePath, { recursive: false });
  invalidateRepositoryRegistry(workspaceRoot);

  let git: Record<string, unknown> = { initialized: false };
  if (input.initializeGit) {
    const result = await runSupervisedCommand(workspacePath, "git", ["init", "-b", input.initialBranch], 30000, 1024 * 1024);
    git = {
      initialized: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: truncateOutput(result.stdout, 64 * 1024),
      stderr: truncateOutput(result.stderr, 64 * 1024),
    };
    if (result.exitCode !== 0) {
      return {
        ok: false,
        status: "directory_created_git_init_failed",
        repositoryName,
        workspaceRoot,
        workspacePath,
        git,
      };
    }
  }

  return {
    ok: true,
    status: input.initializeGit ? "repository_created" : "directory_created",
    repositoryName,
    workspaceRoot,
    workspacePath,
    relativeWorkspacePath: path.relative(workspaceRoot, workspacePath).replaceAll("\\", "/"),
    git,
  };
}

async function resolveWorkspaceScope(policy: ConsolePolicy, input: ScopeInput): Promise<RepositoryScope> {
  return resolveRepositoryScopeWithBinding(policy, input);
}

async function readRelativeFileBundle(policy: ConsolePolicy, input: ScopeInput & { paths: string[] }): Promise<{
  ok: true;
  scope: RepositoryScope;
  files: Array<{ path: string; sizeBytes: number; truncated: boolean; content: string }>;
}> {
  const scope = await resolveWorkspaceScope(policy, input);
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

async function searchScopedText(policy: ConsolePolicy, input: ScopeInput & { query: string; maxResults?: number; timeoutMs?: number }): Promise<{
  ok: true;
  scope: RepositoryScope;
  query: string;
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
  status: string;
  matches: Array<{ file: string; line: number; column: number; snippet: string }>;
}> {
  const scope = await resolveWorkspaceScope(policy, input);
  const result = await searchText(policy, scope.workspacePath, input.query, input.maxResults ?? policy.maxSearchResults, input.timeoutMs);
  return {
    ok: true,
    scope,
    query: result.query,
    scannedFiles: result.scannedFiles,
    skippedFiles: result.skippedFiles,
    truncated: result.truncated,
    status: result.status,
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
