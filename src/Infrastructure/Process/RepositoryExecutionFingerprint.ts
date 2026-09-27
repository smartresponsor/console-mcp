import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { runSupervisedCommand } from "./SupervisedCommand.js";

const fingerprintTimeoutMs = 15000;
const fingerprintMaxBuffer = 8 * 1024 * 1024;

export async function buildRepositoryExecutionFingerprint(workspacePath: string, operationInputs: Record<string, unknown>): Promise<string> {
  const workspace = realpathSync(workspacePath);
  const git = await readGitFingerprintInputs(workspace);
  return createHash("sha256")
    .update(stableStringify({
      workspace,
      git,
      operationInputs,
    }))
    .digest("hex");
}

async function readGitFingerprintInputs(workspace: string): Promise<Record<string, unknown>> {
  if (!existsSync(path.join(workspace, ".git"))) {
    return { mode: "non_git_workspace" };
  }

  const [head, status, diff, stagedDiff, untracked] = await Promise.all([
    runGit(workspace, ["rev-parse", "HEAD"]),
    runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    runGit(workspace, ["diff", "--no-ext-diff", "--full-index", "--binary", "--", "."]),
    runGit(workspace, ["diff", "--cached", "--no-ext-diff", "--full-index", "--binary", "--", "."]),
    runGit(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  return {
    mode: "git",
    head: head.ok ? head.stdout.trim() : null,
    status_hash: hashBounded(status.stdout),
    diff_hash: diff.ok ? hashBounded(diff.stdout) : null,
    staged_diff_hash: stagedDiff.ok ? hashBounded(stagedDiff.stdout) : null,
    untracked_hash: untracked.ok ? hashBounded(untracked.stdout) : null,
    degraded: !head.ok || !status.ok || !diff.ok || !stagedDiff.ok || !untracked.ok,
  };
}

async function runGit(workspace: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await runSupervisedCommand(workspace, "git", args, fingerprintTimeoutMs, fingerprintMaxBuffer);
    return { ok: result.exitCode === 0, stdout: result.stdout };
  } catch (error) {
    return { ok: false, stdout: error instanceof Error ? error.message : String(error) };
  }
}

function hashBounded(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
