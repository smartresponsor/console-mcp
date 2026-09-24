import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { resolveRepositoryScope, type RepositoryScope } from "./repository-registry.js";

const bindingRetentionMs = 7 * 24 * 60 * 60 * 1000;

export type RepositoryBinding = {
  schemaVersion: 1;
  bindingId: string;
  scopeId: string;
  canonicalName: string;
  workspacePath: string;
  relativeWorkspacePath: string;
  createdAt: string;
  lastUsedAt: string;
};

export async function createRepositoryBinding(
  policy: ConsolePolicy,
  input: { componentName?: string | null; workspacePath?: string | null },
): Promise<{ ok: true; status: "repository_binding_created"; binding: RepositoryBinding; scope: RepositoryScope }> {
  const scope = await resolveRepositoryScope(policy, input);
  await pruneExpiredBindings(policy);
  const now = new Date().toISOString();
  const binding: RepositoryBinding = {
    schemaVersion: 1,
    bindingId: randomUUID(),
    scopeId: scope.scopeId,
    canonicalName: scope.canonicalName,
    workspacePath: scope.workspacePath,
    relativeWorkspacePath: scope.relativeWorkspacePath,
    createdAt: now,
    lastUsedAt: now,
  };
  await persistBinding(policy, binding);
  return { ok: true, status: "repository_binding_created", binding, scope };
}

export async function resolveRepositoryBinding(
  policy: ConsolePolicy,
  bindingId: string,
): Promise<{ ok: true; status: "repository_binding_resolved"; binding: RepositoryBinding; scope: RepositoryScope }> {
  const binding = await requireBinding(policy, bindingId);
  const scope = await resolveRepositoryScope(policy, { workspacePath: binding.workspacePath });
  if (scope.scopeId !== binding.scopeId || !samePath(scope.workspacePath, binding.workspacePath)) {
    throw new Error(`Repository binding scope mismatch: ${bindingId}`);
  }
  binding.lastUsedAt = new Date().toISOString();
  await persistBinding(policy, binding);
  return { ok: true, status: "repository_binding_resolved", binding, scope };
}

export async function resolveRepositoryScopeWithBinding(
  policy: ConsolePolicy,
  input: { bindingId?: string | null; componentName?: string | null; workspacePath?: string | null },
): Promise<RepositoryScope> {
  const bindingId = input.bindingId?.trim() || null;
  if (!bindingId) {
    return resolveRepositoryScope(policy, input);
  }

  const resolved = await resolveRepositoryBinding(policy, bindingId);
  const boundScope = resolved.scope;
  if (input.workspacePath) {
    const compatibilityScope = await resolveRepositoryScope(policy, { workspacePath: input.workspacePath });
    assertSameScope(boundScope, compatibilityScope, "workspacePath");
  }
  if (input.componentName) {
    const compatibilityScope = await resolveRepositoryScope(policy, { componentName: input.componentName });
    assertSameScope(boundScope, compatibilityScope, "componentName");
  }
  return { ...boundScope, source: "binding" };
}

export async function removeRepositoryBinding(
  policy: ConsolePolicy,
  bindingId: string,
): Promise<{ ok: true; status: "repository_binding_removed"; bindingId: string; removed: boolean }> {
  assertBindingId(bindingId);
  const bindingPath = getBindingPath(policy, bindingId);
  const removed = existsSync(bindingPath);
  await rm(bindingPath, { force: true });
  return { ok: true, status: "repository_binding_removed", bindingId, removed };
}

async function requireBinding(policy: ConsolePolicy, bindingId: string): Promise<RepositoryBinding> {
  assertBindingId(bindingId);
  const bindingPath = getBindingPath(policy, bindingId);
  if (!existsSync(bindingPath)) {
    throw new Error(`Repository binding was not found: ${bindingId}`);
  }
  const parsed = JSON.parse(await readFile(bindingPath, "utf8")) as RepositoryBinding;
  if (parsed.schemaVersion !== 1 || parsed.bindingId !== bindingId) {
    throw new Error(`Repository binding is invalid: ${bindingId}`);
  }
  return parsed;
}

async function persistBinding(policy: ConsolePolicy, binding: RepositoryBinding): Promise<void> {
  const root = getBindingsRoot(policy);
  await mkdir(root, { recursive: true });
  await writeFile(getBindingPath(policy, binding.bindingId), `${JSON.stringify(binding, null, 2)}\n`, "utf8");
}

async function pruneExpiredBindings(policy: ConsolePolicy): Promise<void> {
  const root = getBindingsRoot(policy);
  if (!existsSync(root)) return;
  const now = Date.now();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(root, entry.name);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as RepositoryBinding;
      if (!parsed.lastUsedAt || now - Date.parse(parsed.lastUsedAt) > bindingRetentionMs) {
        await rm(filePath, { force: true });
      }
    } catch {
      await rm(filePath, { force: true });
    }
  }
}

function getBindingsRoot(policy: ConsolePolicy): string {
  return path.join(policy.transcriptDir, "repository-bindings");
}

function getBindingPath(policy: ConsolePolicy, bindingId: string): string {
  assertBindingId(bindingId);
  return path.join(getBindingsRoot(policy), `${bindingId}.json`);
}

function assertBindingId(bindingId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bindingId)) {
    throw new Error("Repository binding ID must be a UUID.");
  }
}

function assertSameScope(bound: RepositoryScope, supplied: RepositoryScope, source: string): void {
  if (bound.scopeId !== supplied.scopeId || !samePath(bound.workspacePath, supplied.workspacePath)) {
    throw new Error(`Repository binding conflicts with supplied ${source}: bound=${bound.relativeWorkspacePath}, supplied=${supplied.relativeWorkspacePath}`);
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

