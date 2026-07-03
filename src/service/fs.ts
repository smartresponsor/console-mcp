import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertReadablePath, assertAllowedRoot, getDeniedReason } from "./path.js";
import type { ConsolePolicy } from "./policy.js";
import { sanitizeText } from "./process.js";

const SKIP_DIRS = new Set(["vendor", "node_modules", "var", ".git", "build", "dist"]);

export async function readTextFile(policy: ConsolePolicy, filePath: string): Promise<{ path: string; sizeBytes: number; truncated: boolean; content: string }> {
  const resolved = assertReadablePath(filePath, policy.deniedPath, policy.allowedRoots);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) {
    throw new Error("Path is not a regular file.");
  }

  if (fileStat.size > policy.maxFileBytes) {
    throw new Error(`File exceeds the size cap of ${policy.maxFileBytes} bytes.`);
  }

  const content = sanitizeText(await readFile(resolved, "utf8"));
  return {
    path: resolved,
    sizeBytes: fileStat.size,
    truncated: false,
    content,
  };
}

export async function searchText(policy: ConsolePolicy, workspacePath: string, query: string, maxResults: number): Promise<{ root: string; query: string; scannedFiles: number; matches: Array<{ file: string; line: number; column: number; snippet: string }> }> {
  const root = assertAllowedRoot(workspacePath, policy.allowedRoots);
  await assertSearchRootDirectory(root);
  const needle = query.trim();
  if (!needle) {
    throw new Error("Query must not be empty.");
  }

  const matches: Array<{ file: string; line: number; column: number; snippet: string }> = [];
  let scannedFiles = 0;

  await walk(root, async (filePath) => {
    if (matches.length >= maxResults) {
      return;
    }

    if (getDeniedReason(filePath, policy.deniedPath)) {
      return;
    }

    scannedFiles += 1;
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > policy.maxFileBytes) {
      return;
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return;
    }

    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex += 1) {
      const line = lines[lineIndex];
      const column = line.toLowerCase().indexOf(needle.toLowerCase());
      if (column >= 0) {
        matches.push({
          file: filePath,
          line: lineIndex + 1,
          column: column + 1,
          snippet: sanitizeSnippet(line),
        });
      }
    }
  });

  return {
    root,
    query: needle,
    scannedFiles,
    matches,
  };
}

async function assertSearchRootDirectory(root: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workspace path is not readable as a directory: ${root}. ${message}`);
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${root}`);
  }
}

async function walk(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const lower = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(lower)) {
        continue;
      }
      await walk(entryPath, visit);
      continue;
    }

    if (entry.isFile()) {
      await visit(entryPath);
    }
  }
}

function sanitizeSnippet(line: string): string {
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}
