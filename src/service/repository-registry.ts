import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";

export type RepositoryScope = {
  ok: true;
  scopeId: string;
  canonicalName: string;
  componentName: string;
  workspaceRoot: string;
  workspacePath: string;
  relativeWorkspacePath: string;
  source: "componentName" | "workspacePath" | "registry";
};

export type RepositoryRegistryEntry = {
  canonicalName: string;
  scopeId: string;
  workspacePath: string;
  relativeWorkspacePath: string;
  markers: string[];
};

export type RepositoryRegistry = {
  ok: true;
  workspaceRoot: string;
  entries: RepositoryRegistryEntry[];
};

type ScopeInput = {
  componentName?: string | null;
  workspacePath?: string | null;
};

type RepositoryRegistryCacheEntry = {
  registry: RepositoryRegistry;
  expiresAt: number;
};

const repositoryRegistryCache = new Map<string, RepositoryRegistryCacheEntry>();
const repositoryRegistryRefreshes = new Map<string, Promise<RepositoryRegistry>>();
const repositoryRegistryCacheTtlMs = 5000;

const excludedDirectoryNames = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "var",
  "tmp",
]);

const repositoryMarkerFiles = [
  ".git",
  "composer.json",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];

export async function buildRepositoryRegistry(policy: ConsolePolicy): Promise<RepositoryRegistry> {
  const workspaceRoot = assertAllowedRoot(policy.workspaceRoot, policy.allowedRoots);
  const cacheKey = repositoryRegistryCacheKey(workspaceRoot);
  const cached = repositoryRegistryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.registry;
  }

  const inFlight = repositoryRegistryRefreshes.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const refresh = scanRepositoryRegistry(workspaceRoot)
    .then((registry) => {
      repositoryRegistryCache.set(cacheKey, {
        registry,
        expiresAt: Date.now() + repositoryRegistryCacheTtlMs,
      });
      return registry;
    })
    .finally(() => {
      repositoryRegistryRefreshes.delete(cacheKey);
    });

  repositoryRegistryRefreshes.set(cacheKey, refresh);
  return refresh;
}

export function invalidateRepositoryRegistry(workspaceRoot?: string): void {
  if (!workspaceRoot) {
    repositoryRegistryCache.clear();
    repositoryRegistryRefreshes.clear();
    return;
  }

  const cacheKey = repositoryRegistryCacheKey(workspaceRoot);
  repositoryRegistryCache.delete(cacheKey);
  repositoryRegistryRefreshes.delete(cacheKey);
}

async function scanRepositoryRegistry(workspaceRoot: string): Promise<RepositoryRegistry> {
  const entries: RepositoryRegistryEntry[] = [];
  await scanRepositoryCandidates(workspaceRoot, workspaceRoot, entries, 0, 3);
  entries.sort((left, right) => left.relativeWorkspacePath.localeCompare(right.relativeWorkspacePath));
  return { ok: true, workspaceRoot, entries: dedupeRegistryEntries(entries) };
}

export async function resolveRepositoryScope(policy: ConsolePolicy, input: ScopeInput): Promise<RepositoryScope> {
  const componentName = input.componentName?.trim() || null;
  const workspaceRoot = assertAllowedRoot(policy.workspaceRoot, policy.allowedRoots);
  if (!componentName && !input.workspacePath) {
    throw new Error("Either componentName or workspacePath is required.");
  }

  const registry = await buildRepositoryRegistry(policy);
  if (input.workspacePath) {
    const workspacePath = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
    if (!isWithinWorkspaceRoot(workspacePath, workspaceRoot)) {
      throw new Error(`Resolved workspace is outside the configured workspace root: ${workspacePath}`);
    }

    const entry = registry.entries.find((candidate) => samePath(candidate.workspacePath, workspacePath));
    return scopeFromEntry(entry ?? fallbackEntry(workspaceRoot, workspacePath, componentName ?? path.basename(workspacePath)), workspaceRoot, "workspacePath");
  }

  const requested = componentName ?? "";
  const match = registry.entries.find((entry) =>
    entry.canonicalName.toLowerCase() === requested.toLowerCase()
    || path.basename(entry.workspacePath).toLowerCase() === requested.toLowerCase()
    || entry.scopeId === normalizeScopeId(requested)
    || entry.relativeWorkspacePath.toLowerCase() === requested.replaceAll("\\", "/").toLowerCase()
  );
  if (match) {
    return scopeFromEntry(match, workspaceRoot, "componentName");
  }

  const workspacePath = assertAllowedRoot(path.join(workspaceRoot, assertSafeComponentName(requested)), policy.allowedRoots);
  if (!isWithinWorkspaceRoot(workspacePath, workspaceRoot)) {
    throw new Error(`Resolved workspace is outside the configured workspace root: ${workspacePath}`);
  }

  return scopeFromEntry(fallbackEntry(workspaceRoot, workspacePath, requested), workspaceRoot, "componentName");
}

export function normalizeScopeId(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").toLowerCase();
  return normalized.replace(/[^a-z0-9_.\/-]+/g, "-").replace(/[\/]+/g, ".");
}

export function isWithinWorkspaceRoot(candidatePath: string, workspacePath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function scopeFromEntry(entry: RepositoryRegistryEntry, workspaceRoot: string, source: RepositoryScope["source"]): RepositoryScope {
  return {
    ok: true,
    scopeId: entry.scopeId,
    canonicalName: entry.canonicalName,
    componentName: path.basename(entry.workspacePath),
    workspaceRoot,
    workspacePath: entry.workspacePath,
    relativeWorkspacePath: entry.relativeWorkspacePath,
    source,
  };
}

function fallbackEntry(workspaceRoot: string, workspacePath: string, name: string): RepositoryRegistryEntry {
  const relativeWorkspacePath = path.relative(workspaceRoot, workspacePath).replaceAll("\\", "/");
  const canonicalName = relativeWorkspacePath || name || path.basename(workspacePath);
  return {
    canonicalName,
    scopeId: normalizeScopeId(relativeWorkspacePath || canonicalName),
    workspacePath,
    relativeWorkspacePath,
    markers: [],
  };
}

async function scanRepositoryCandidates(
  workspaceRoot: string,
  directory: string,
  entries: RepositoryRegistryEntry[],
  depth: number,
  maxDepth: number,
): Promise<void> {
  if (depth > maxDepth) {
    return;
  }

  let children: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const markers = await readRepositoryMarkers(directory, children.map((child) => child.name));
  if (markers.length > 0 && directory !== workspaceRoot) {
    const relativeWorkspacePath = path.relative(workspaceRoot, directory).replaceAll("\\", "/");
    entries.push({
      canonicalName: relativeWorkspacePath,
      scopeId: normalizeScopeId(relativeWorkspacePath),
      workspacePath: path.resolve(directory),
      relativeWorkspacePath,
      markers,
    });
  }

  for (const child of children) {
    if (!child.isDirectory() || excludedDirectoryNames.has(child.name)) {
      continue;
    }
    await scanRepositoryCandidates(workspaceRoot, path.join(directory, child.name), entries, depth + 1, maxDepth);
  }
}

async function readRepositoryMarkers(directory: string, childNames: string[]): Promise<string[]> {
  const children = new Set(childNames);
  const markers: string[] = [];
  for (const marker of repositoryMarkerFiles) {
    if (!children.has(marker)) {
      continue;
    }
    try {
      await stat(path.join(directory, marker));
      markers.push(marker);
    } catch {
      // Ignore races with concurrent filesystem changes.
    }
  }
  return markers;
}

function dedupeRegistryEntries(entries: RepositoryRegistryEntry[]): RepositoryRegistryEntry[] {
  const seen = new Set<string>();
  const result: RepositoryRegistryEntry[] = [];
  for (const entry of entries) {
    const key = path.resolve(entry.workspacePath).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function assertSafeComponentName(componentName: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(componentName)) {
    throw new Error(`Component name contains unsupported characters: ${componentName}`);
  }

  return componentName;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function repositoryRegistryCacheKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}
