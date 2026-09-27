import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertReadablePath, assertAllowedRoot, getDeniedReason } from "../../Policy/PathGuard.js";
import type { ConsolePolicy } from "../../Policy/ConsolePolicy.js";
import { sanitizeText } from "../Process/ProcessRuntime.js";

const SKIP_DIRS = new Set([".git", "vendor", "node_modules", "var", "dist", "build", "coverage", ".venv", "venv", "cache", "tmp"]);
const BINARY_EXTENSIONS = new Set([".7z", ".bin", ".dll", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpg", ".jpeg", ".pdf", ".png", ".pyc", ".sqlite", ".sqlite3", ".wasm", ".webp", ".zip"]);
const DEFAULT_SEARCH_DEADLINE_MS = 5000;
const MAX_SEARCHED_FILES = 5000;

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

export async function searchText(policy: ConsolePolicy, workspacePath: string, query: string, maxResults: number, timeoutMs = DEFAULT_SEARCH_DEADLINE_MS): Promise<{ root: string; query: string; scannedFiles: number; skippedFiles: number; truncated: boolean; status: "OK" | "TIME_BUDGET_EXCEEDED" | "FILE_BUDGET_EXCEEDED" | "RESULT_LIMIT_REACHED"; matches: Array<{ file: string; line: number; column: number; snippet: string }> }> {
  const root = assertAllowedRoot(workspacePath, policy.allowedRoots);
  await assertSearchRootDirectory(root);
  const needle = query.trim();
  if (!needle) {
    throw new Error("Query must not be empty.");
  }

  const matches: Array<{ file: string; line: number; column: number; snippet: string }> = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let truncated = false;
  let status: "OK" | "TIME_BUDGET_EXCEEDED" | "FILE_BUDGET_EXCEEDED" | "RESULT_LIMIT_REACHED" = "OK";
  const deadlineAt = Date.now() + Math.max(1, Math.min(30000, Math.trunc(timeoutMs)));

  await walk(root, deadlineAt, async (filePath) => {
    if (matches.length >= maxResults) {
      status = "RESULT_LIMIT_REACHED";
      truncated = true;
      return;
    }
    if (Date.now() >= deadlineAt) {
      status = "TIME_BUDGET_EXCEEDED";
      truncated = true;
      return;
    }
    if (scannedFiles >= MAX_SEARCHED_FILES) {
      status = "FILE_BUDGET_EXCEEDED";
      truncated = true;
      return;
    }

    if (getDeniedReason(filePath, policy.deniedPath) || isBinaryPath(filePath)) {
      skippedFiles += 1;
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > policy.maxFileBytes) {
      skippedFiles += 1;
      return;
    }
    if (await looksBinary(filePath)) {
      skippedFiles += 1;
      return;
    }
    scannedFiles += 1;

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
    if (matches.length >= maxResults) {
      status = "RESULT_LIMIT_REACHED";
      truncated = true;
    }
  });

  if (status === "OK" && Date.now() >= deadlineAt) {
    status = "TIME_BUDGET_EXCEEDED";
    truncated = true;
  }

  return {
    root,
    query: needle,
    scannedFiles,
    skippedFiles,
    truncated,
    status,
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

async function walk(root: string, deadlineAt: number, visit: (filePath: string) => Promise<void>): Promise<void> {
  if (Date.now() >= deadlineAt) {
    return;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (Date.now() >= deadlineAt) {
      return;
    }
    const entryPath = path.join(root, entry.name);
    const lower = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(lower)) {
        continue;
      }
      await walk(entryPath, deadlineAt, visit);
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

function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function looksBinary(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

