import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "./ConsolePolicy.js";
import type { DeniedPathPolicy } from "./ConsolePolicy.js";

export function assertAllowedRoot(candidatePath: string, allowedRoots: string[]): string {
  if (!candidatePath || candidatePath.includes("\0")) {
    throw new Error("Path is empty or malformed.");
  }
  const resolved = canonicalizePath(candidatePath);
  if (!allowedRoots.some((root) => isWithinRoot(resolved, canonicalizePath(root)))) {
    throw new Error(`Path is outside the allowed roots: ${candidatePath}`);
  }

  return resolved;
}

export function assertReadablePath(candidatePath: string, policy: DeniedPathPolicy, allowedRoots: string[]): string {
  const resolved = assertAllowedRoot(candidatePath, allowedRoots);
  const denial = getDeniedReason(resolved, policy);
  if (denial) {
    throw new Error(`Refused by path policy: ${denial}`);
  }

  return resolved;
}

export function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const windows = isWindowsAbsolute(candidatePath) || isWindowsAbsolute(rootPath);
  const implementation = windows ? path.win32 : path;
  const candidate = windows ? implementation.resolve(candidatePath).toLowerCase() : implementation.resolve(candidatePath);
  const root = windows ? implementation.resolve(rootPath).toLowerCase() : implementation.resolve(rootPath);
  const relative = implementation.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${implementation.sep}`) && relative !== ".." && !implementation.isAbsolute(relative));
}

function isWindowsAbsolute(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input);
}

export function getDeniedReason(candidatePath: string, policy: DeniedPathPolicy): string | null {
  const normalized = normalizeComparable(candidatePath);
  const basename = path.win32.basename(candidatePath).toLowerCase();

  // The configured browser credential directory is never a repository-readable
  // allowlist exception. Resolve aliases so a symlink cannot reveal its files.
  const secretRoot = process.env.CONSOLE_WEB_SECRET_ROOT;
  if (secretRoot) {
    const paths = [candidatePath];
    try { paths.push(realpathSync(candidatePath)); } catch { /* lexical check still applies */ }
    if (paths.some(candidate => isWithinRoot(candidate, secretRoot))) return "protected browser secret directory";
  }

  if (policy.allowlist.some((allowed) => isWithinRoot(normalized, allowed))) {
    return null;
  }

  if (policy.denyBasenames.some((item) => item.toLowerCase() === basename)) {
    return `denied basename ${basename}`;
  }

  if (policy.denyExtensions.some((ext) => basename.endsWith(ext.toLowerCase()))) {
    return `denied extension for ${basename}`;
  }

  const segments = normalized.split("\\").map((segment) => segment.toUpperCase());
  for (const fragment of policy.denyPathFragments) {
    if (segments.some((segment) => segment === fragment.toUpperCase())) {
      return `denied path fragment ${fragment}`;
    }
  }

  return null;
}

function normalizeComparable(input: string): string {
  return normalizePath(input).replaceAll("/", "\\").toLowerCase();
}

function canonicalizePath(input: string): string {
  const resolved = normalizePath(input);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const missing: string[] = [];
  let existing = resolved;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`Path has no existing ancestor: ${input}`);
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...missing);
}

