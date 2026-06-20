import path from "node:path";
import { normalizePath } from "./policy.js";
import type { DeniedPathPolicy } from "./policy.js";

export function assertAllowedRoot(candidatePath: string, allowedRoots: string[]): string {
  const resolved = normalizePath(candidatePath);
  if (!allowedRoots.some((root) => isWithinRoot(resolved, root))) {
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
  const candidate = normalizeComparable(candidatePath);
  const root = normalizeComparable(rootPath);
  return candidate === root || candidate.startsWith(`${root}\\`);
}

export function getDeniedReason(candidatePath: string, policy: DeniedPathPolicy): string | null {
  const normalized = normalizeComparable(candidatePath);
  const basename = path.win32.basename(candidatePath).toLowerCase();

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
    if (segments.some((segment) => segment.includes(fragment.toUpperCase()))) {
      return `denied path fragment ${fragment}`;
    }
  }

  return null;
}

function normalizeComparable(input: string): string {
  return normalizePath(input).replaceAll("/", "\\").toLowerCase();
}
