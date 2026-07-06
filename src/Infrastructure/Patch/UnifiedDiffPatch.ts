import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConsolePolicy } from "../../Policy/ConsolePolicy.js";
import { normalizePath } from "../../Policy/ConsolePolicy.js";
import { assertAllowedRoot, isWithinRoot } from "../../Policy/PathGuard.js";
import { assertNotWorkspaceUmbrellaRoot } from "../../service/code-memory-scope.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Process/ProcessRuntime.js";

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_CHANGED_FILES = 20;
const FORBIDDEN_PATH_PREFIXES = [
  ".git",
  "vendor",
  "node_modules",
  "var/cache",
  "var/log",
  "dist",
  "build",
  "coverage",
];

type GitCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type ParsedPatchFile = {
  headerLeft: string;
  headerRight: string;
  oldPathMarker: string | null;
  newPathMarker: string | null;
};

export type ApplyPatchInput = {
  workspacePath: string;
  patch: string;
  dryRun?: boolean;
  expectedChangedFiles?: string[];
  reason?: string;
};

export type ApplyPatchResult = {
  ok: boolean;
  dry_run: boolean;
  applied: boolean;
  applicable: boolean;
  message: string;
  changed_files: string[];
  rejected_files: string[];
  expected_changed_files: string[] | null;
  transcript_path: string;
  error?: string;
  reason?: string | null;
  patch_bytes: number;
};

type PatchTranscript = {
  timestamp: string;
  workspace_path: string;
  dry_run: boolean;
  reason: string | null;
  patch_bytes: number;
  patch_sha256: string;
  expected_changed_files: string[] | null;
  changed_files: string[];
  rejected_files: string[];
  validation_ok: boolean;
  git_check: {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  } | null;
  git_apply: {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  } | null;
  ok: boolean;
  applied: boolean;
  applicable: boolean;
  message: string;
  error: string | null;
};

export async function applyUnifiedDiffPatch(
  policy: Pick<ConsolePolicy, "allowedRoots" | "transcriptDir" | "workspaceRoot">,
  input: ApplyPatchInput,
): Promise<ApplyPatchResult> {
  const dryRun = input.dryRun ?? false;
  const patchBytes = Buffer.byteLength(input.patch, "utf8");
  const patchSha256 = crypto.createHash("sha256").update(input.patch, "utf8").digest("hex");
  const workspaceRoot = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  assertNotWorkspaceUmbrellaRoot(policy, workspaceRoot, "patch.apply");
  const transcriptDir = path.resolve(policy.transcriptDir);
  const transcriptPath = path.join(transcriptDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-apply-patch-${crypto.randomBytes(4).toString("hex")}.json`);
  const transcript: PatchTranscript = {
    timestamp: new Date().toISOString(),
    workspace_path: workspaceRoot,
    dry_run: dryRun,
    reason: input.reason?.trim() || null,
    patch_bytes: patchBytes,
    patch_sha256: patchSha256,
    expected_changed_files: null,
    changed_files: [],
    rejected_files: [],
    validation_ok: false,
    git_check: null,
    git_apply: null,
    ok: false,
    applied: false,
    applicable: false,
    message: "",
    error: null,
  };

  try {
    if (patchBytes > MAX_PATCH_BYTES) {
      throw new Error(`Patch exceeds the size cap of ${MAX_PATCH_BYTES} bytes.`);
    }

    const parsed = parseUnifiedDiff(input.patch);
    const changedFiles = parsed.changedFiles;
    const rejectedFiles = parsed.rejectedFiles;

    transcript.changed_files = changedFiles;
    transcript.rejected_files = rejectedFiles;
    transcript.expected_changed_files = input.expectedChangedFiles ? normalizeExpectedChangedFiles(input.expectedChangedFiles, workspaceRoot) : null;

    if (rejectedFiles.length > 0) {
      throw new Error(`Patch touches forbidden files: ${rejectedFiles.join(", ")}.`);
    }

    if (changedFiles.length === 0) {
      throw new Error("Patch does not change any files.");
    }

    if (changedFiles.length > MAX_CHANGED_FILES) {
      throw new Error(`Patch changes ${changedFiles.length} files, which exceeds the limit of ${MAX_CHANGED_FILES}.`);
    }

    if (transcript.expected_changed_files) {
      assertExactFileSetMatch(changedFiles, transcript.expected_changed_files);
    }

    await assertPatchTargetsInsideWorkspace(workspaceRoot, changedFiles);
    transcript.validation_ok = true;

    const git = resolveCommandExecutable("git");
    const check = await runGitApply(git, workspaceRoot, input.patch, ["apply", "--check", "--whitespace=nowarn", "-"]);
    transcript.git_check = toTranscriptCommandResult(check);
    if (check.exitCode !== 0) {
      throw new Error(`Patch check failed: ${sanitizeText(check.stderr || check.stdout || `git apply --check exited with code ${check.exitCode ?? "unknown"}.`)}`);
    }

    transcript.applicable = true;

    if (dryRun) {
      transcript.ok = true;
      transcript.applied = false;
      transcript.message = "Patch is applicable.";
      await writePatchTranscript(transcriptDir, transcriptPath, transcript);
      return {
        ok: true,
        dry_run: true,
        applied: false,
        applicable: true,
        message: transcript.message,
        changed_files: changedFiles,
        rejected_files: rejectedFiles,
        expected_changed_files: transcript.expected_changed_files,
        transcript_path: transcriptPath,
        reason: transcript.reason,
        patch_bytes: patchBytes,
      };
    }

    const apply = await runGitApply(git, workspaceRoot, input.patch, ["apply", "--whitespace=nowarn", "-"]);
    transcript.git_apply = toTranscriptCommandResult(apply);
    if (apply.exitCode !== 0) {
      throw new Error(`Patch apply failed: ${sanitizeText(apply.stderr || apply.stdout || `git apply exited with code ${apply.exitCode ?? "unknown"}.`)}`);
    }

    transcript.ok = true;
    transcript.applied = true;
    transcript.message = "Patch applied.";
    await writePatchTranscript(transcriptDir, transcriptPath, transcript);
    return {
      ok: true,
      dry_run: false,
      applied: true,
      applicable: true,
      message: transcript.message,
      changed_files: changedFiles,
      rejected_files: rejectedFiles,
      expected_changed_files: transcript.expected_changed_files,
      transcript_path: transcriptPath,
      reason: transcript.reason,
      patch_bytes: patchBytes,
    };
  } catch (error) {
    transcript.error = sanitizeText(error instanceof Error ? error.message : String(error));
    transcript.message = transcript.error || "Patch application failed.";
    await writePatchTranscript(transcriptDir, transcriptPath, transcript);
    return {
      ok: false,
      dry_run: dryRun,
      applied: false,
      applicable: transcript.applicable,
      message: transcript.message,
      changed_files: transcript.changed_files,
      rejected_files: transcript.rejected_files,
      expected_changed_files: transcript.expected_changed_files,
      transcript_path: transcriptPath,
      error: transcript.error,
      reason: transcript.reason,
      patch_bytes: patchBytes,
    };
  }
}

function parseUnifiedDiff(patch: string): { changedFiles: string[]; rejectedFiles: string[] } {
  const lines = patch.split(/\r?\n/);
  const changedFiles: string[] = [];
  const rejectedFiles: string[] = [];
  const seen = new Set<string>();
  let current: ParsedPatchFile | null = null;
  let seenHeader = false;

  const flush = () => {
    if (!current) {
      return;
    }

    const left = normalizeDiffPath(current.headerLeft);
    const right = normalizeDiffPath(current.headerRight);
    if (left !== right) {
      throw new Error(`Rename and copy patches are not allowed: ${left} -> ${right}.`);
    }

    if (current.oldPathMarker === null || current.newPathMarker === null) {
      throw new Error(`Patch entry is missing file markers for ${right}.`);
    }

    if (current.newPathMarker === "/dev/null") {
      throw new Error(`File deletion is not allowed: ${right}.`);
    }

    const changedFile = right;
    validateRelativePatchPath(changedFile);

    if (isForbiddenPatchPath(changedFile)) {
      rejectedFiles.push(changedFile);
    } else if (!seen.has(changedFile)) {
      seen.add(changedFile);
      changedFiles.push(changedFile);
    }

    current = null;
  };

  for (const line of lines) {
    if (!seenHeader) {
      if (line.trim().length === 0) {
        continue;
      }

      if (!line.startsWith("diff --git ")) {
        throw new Error("Patch must be a unified diff with diff --git headers.");
      }

      seenHeader = true;
    }

    if (line.startsWith("diff --git ")) {
      flush();
      current = parseDiffHeader(line);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      throw new Error("Rename and copy patches are not allowed.");
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      throw new Error("Binary patches are not allowed.");
    }

    if (line.startsWith("--- ")) {
      current.oldPathMarker = line.slice(4).trim();
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPathMarker = line.slice(4).trim();
    }
  }

  flush();

  if (changedFiles.length + rejectedFiles.length === 0) {
    throw new Error("Patch does not contain any file changes.");
  }

  return {
    changedFiles,
    rejectedFiles,
  };
}

function parseDiffHeader(line: string): ParsedPatchFile {
  const match = line.match(/^diff --git (.+?) (.+)$/);
  if (!match) {
    throw new Error("Invalid diff header.");
  }

  return {
    headerLeft: stripPatchPrefix(match[1]),
    headerRight: stripPatchPrefix(match[2]),
    oldPathMarker: null,
    newPathMarker: null,
  };
}

function stripPatchPrefix(raw: string): string {
  const value = raw.trim().replace(/^"|"$/g, "");
  if (value.startsWith("a/")) {
    return value.slice(2);
  }

  if (value.startsWith("b/")) {
    return value.slice(2);
  }

  return value;
}

function normalizeDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }

  validateRelativePatchPath(value);
  return value.replaceAll("\\", "/");
}

function validateRelativePatchPath(value: string): void {
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized) {
    throw new Error("Patch path must not be empty.");
  }

  if (normalized === "/dev/null") {
    return;
  }

  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Absolute paths are not allowed in patches: ${value}.`);
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Path traversal is not allowed in patches: ${value}.`);
  }

  if (normalized.includes(":")) {
    throw new Error(`Colon-separated paths are not allowed in patches: ${value}.`);
  }
}

function isForbiddenPatchPath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => lowered === prefix || lowered.startsWith(`${prefix}/`));
}

async function assertPatchTargetsInsideWorkspace(workspaceRoot: string, changedFiles: string[]): Promise<void> {
  for (const relative of changedFiles) {
    const absolute = normalizeWorkspaceRelativePath(workspaceRoot, relative);
    if (!isWithinRoot(absolute, workspaceRoot)) {
      throw new Error(`Patch target is outside the workspace: ${relative}.`);
    }
  }
}

function normalizeWorkspaceRelativePath(workspaceRoot: string, relativePath: string): string {
  return normalizePath(path.join(workspaceRoot, relativePath));
}

function normalizeExpectedChangedFiles(expectedChangedFiles: string[], workspaceRoot: string): string[] {
  const normalized = expectedChangedFiles.map((file) => normalizeExpectedChangedFile(file, workspaceRoot));
  const unique = Array.from(new Set(normalized));
  if (unique.length !== normalized.length) {
    throw new Error("expectedChangedFiles must not contain duplicates.");
  }

  return unique.sort();
}

function normalizeExpectedChangedFile(file: string, workspaceRoot: string): string {
  const value = file.trim().replaceAll("\\", "/");
  if (!value) {
    throw new Error("expectedChangedFiles must not contain empty entries.");
  }

  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    const absolute = normalizePath(value);
    if (!isWithinRoot(absolute, workspaceRoot)) {
      throw new Error(`expectedChangedFiles entry is outside the workspace: ${file}.`);
    }

    return absolute.slice(workspaceRoot.length + 1).replaceAll("\\", "/");
  }

  validateRelativePatchPath(value);
  return value;
}

function assertExactFileSetMatch(actual: string[], expected: string[]): void {
  const normalizedActual = Array.from(new Set(actual)).sort();
  const normalizedExpected = Array.from(new Set(expected)).sort();
  if (normalizedActual.length !== normalizedExpected.length || normalizedActual.some((file, index) => file !== normalizedExpected[index])) {
    throw new Error(`Changed files did not match expectedChangedFiles. Actual: ${normalizedActual.join(", ") || "(none)"}; Expected: ${normalizedExpected.join(", ") || "(none)"}.`);
  }
}

async function runGitApply(
  gitExecutable: string,
  cwd: string,
  patch: string,
  args: string[],
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolve, reject) => {
    const child = spawn(gitExecutable, args, {
      cwd,
      env: buildSafeEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });

    child.stdin.end(patch, "utf8");
  });
}

async function writePatchTranscript(transcriptDir: string, transcriptPath: string, transcript: PatchTranscript): Promise<void> {
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
}

function toTranscriptCommandResult(result: GitCommandResult): { exit_code: number | null; signal: string | null; stdout: string; stderr: string } {
  return {
    exit_code: result.exitCode,
    signal: result.signal,
    stdout: sanitizeText(result.stdout),
    stderr: sanitizeText(result.stderr),
  };
}

