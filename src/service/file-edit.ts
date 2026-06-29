import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ConsolePolicy } from "./policy.js";
import { assertReadablePath } from "./path.js";
import { sanitizeText } from "./process.js";

export type ReplaceInFileInput = {
  workspacePath: string;
  filePath: string;
  search: string;
  replace: string;
  expectedOccurrences?: number;
  dryRun?: boolean;
  reason?: string;
};

export type ReplaceInFileResult = {
  ok: boolean;
  dry_run: boolean;
  applied: boolean;
  applicable: boolean;
  workspace_path: string;
  file_path: string;
  search: string;
  replace: string;
  expected_occurrences: number | null;
  actual_occurrences: number;
  before_bytes: number;
  after_bytes: number;
  before_sha256: string;
  after_sha256: string;
  transcript_path: string;
  reason: string | null;
  message: string;
  error?: string;
};

type ReplaceTranscript = {
  timestamp: string;
  workspace_path: string;
  file_path: string;
  dry_run: boolean;
  reason: string | null;
  search: string;
  replace: string;
  expected_occurrences: number | null;
  actual_occurrences: number;
  before_bytes: number;
  after_bytes: number;
  before_sha256: string;
  after_sha256: string;
  applicable: boolean;
  applied: boolean;
  ok: boolean;
  message: string;
  error: string | null;
};

export async function replaceTextInFile(
  policy: Pick<ConsolePolicy, "allowedRoots" | "deniedPath" | "transcriptDir">,
  input: ReplaceInFileInput,
): Promise<ReplaceInFileResult> {
  const dryRun = input.dryRun ?? false;
  const workspaceRoot = normalizeWorkspaceRoot(policy.allowedRoots, input.workspacePath);
  const candidateFilePath = path.isAbsolute(input.filePath) ? input.filePath : path.join(workspaceRoot, input.filePath);
  const resolvedFile = assertReadablePath(candidateFilePath, policy.deniedPath, [workspaceRoot]);
  const transcriptDir = path.resolve(policy.transcriptDir);
  const transcriptPath = path.join(transcriptDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-replace-in-file-${crypto.randomBytes(4).toString("hex")}.json`);

  const transcript: ReplaceTranscript = {
    timestamp: new Date().toISOString(),
    workspace_path: workspaceRoot,
    file_path: resolvedFile,
    dry_run: dryRun,
    reason: input.reason?.trim() || null,
    search: input.search,
    replace: input.replace,
    expected_occurrences: input.expectedOccurrences ?? null,
    actual_occurrences: 0,
    before_bytes: 0,
    after_bytes: 0,
    before_sha256: "",
    after_sha256: "",
    applicable: false,
    applied: false,
    ok: false,
    message: "",
    error: null,
  };

  try {
    const search = input.search;
    if (search.length === 0) {
      throw new Error("Search text must not be empty.");
    }

    const original = await readFile(resolvedFile, "utf8");
    const beforeBytes = Buffer.byteLength(original, "utf8");
    const beforeSha256 = crypto.createHash("sha256").update(original, "utf8").digest("hex");
    const actualOccurrences = countOccurrences(original, search);

    transcript.before_bytes = beforeBytes;
    transcript.before_sha256 = beforeSha256;
    transcript.actual_occurrences = actualOccurrences;

    if (actualOccurrences === 0) {
      throw new Error("Search text was not found in the file.");
    }

    if (typeof input.expectedOccurrences === "number" && input.expectedOccurrences !== actualOccurrences) {
      throw new Error(`Expected ${input.expectedOccurrences} occurrence(s) but found ${actualOccurrences}.`);
    }

    const updated = original.split(search).join(input.replace);
    const afterBytes = Buffer.byteLength(updated, "utf8");
    const afterSha256 = crypto.createHash("sha256").update(updated, "utf8").digest("hex");

    transcript.after_bytes = afterBytes;
    transcript.after_sha256 = afterSha256;
    transcript.applicable = true;

    if (dryRun) {
      transcript.ok = true;
      transcript.message = "Replacement is applicable.";
      await writeTranscript(transcriptDir, transcriptPath, transcript);
      return {
        ok: true,
        dry_run: true,
        applied: false,
        applicable: true,
        workspace_path: workspaceRoot,
        file_path: resolvedFile,
        search,
        replace: input.replace,
        expected_occurrences: transcript.expected_occurrences,
        actual_occurrences: actualOccurrences,
        before_bytes: beforeBytes,
        after_bytes: afterBytes,
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        transcript_path: transcriptPath,
        reason: transcript.reason,
        message: transcript.message,
      };
    }

    await mkdir(path.dirname(resolvedFile), { recursive: true });
    await writeFile(resolvedFile, updated, "utf8");

    transcript.ok = true;
    transcript.applied = true;
    transcript.message = "Replacement applied.";
    await writeTranscript(transcriptDir, transcriptPath, transcript);

    return {
      ok: true,
      dry_run: false,
      applied: true,
      applicable: true,
      workspace_path: workspaceRoot,
      file_path: resolvedFile,
      search,
      replace: input.replace,
      expected_occurrences: transcript.expected_occurrences,
      actual_occurrences: actualOccurrences,
      before_bytes: beforeBytes,
      after_bytes: afterBytes,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      transcript_path: transcriptPath,
      reason: transcript.reason,
      message: transcript.message,
    };
  } catch (error) {
    transcript.error = sanitizeText(error instanceof Error ? error.message : String(error));
    transcript.message = transcript.error || "Replacement failed.";
    await writeTranscript(transcriptDir, transcriptPath, transcript);
    return {
      ok: false,
      dry_run: dryRun,
      applied: false,
      applicable: transcript.applicable,
      workspace_path: workspaceRoot,
      file_path: resolvedFile,
      search: input.search,
      replace: input.replace,
      expected_occurrences: transcript.expected_occurrences,
      actual_occurrences: transcript.actual_occurrences,
      before_bytes: transcript.before_bytes,
      after_bytes: transcript.after_bytes,
      before_sha256: transcript.before_sha256,
      after_sha256: transcript.after_sha256,
      transcript_path: transcriptPath,
      reason: transcript.reason,
      message: transcript.message,
      error: transcript.error,
    };
  }
}

function normalizeWorkspaceRoot(allowedRoots: string[], workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  if (!allowedRoots.some((root) => resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}\\`))) {
    throw new Error(`Path is outside the allowed roots: ${workspacePath}`);
  }

  return resolved;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

async function writeTranscript(transcriptDir: string, transcriptPath: string, transcript: ReplaceTranscript): Promise<void> {
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
}
