import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSafeEnv, resolveCommandInvocation, sanitizeText } from "./ProcessRuntime.js";

const execFileAsync = promisify(execFile);

export type SupervisedCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runSupervisedCommand(cwd: string, commandName: string, args: string[], timeoutMs = 30000, maxBuffer = 2 * 1024 * 1024): Promise<SupervisedCommandResult> {
  const resolvedCommand = resolveCommandInvocation(commandName, args);
  const commandForExec = resolvedCommand.command;
  const commandArgs = resolvedCommand.args;
  const useShell = resolvedCommand.shell;

  try {
    const result = await execFileAsync(commandForExec, commandArgs, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer,
      env: buildSafeEnv(),
      shell: useShell,
    });

    return {
      ok: true,
      command: commandForExec,
      args,
      cwd,
      exitCode: 0,
      stdout: sanitizeText(String(result.stdout ?? "")),
      stderr: sanitizeText(String(result.stderr ?? "")),
    };
  } catch (error) {
    const captured = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return {
      ok: false,
      command: commandForExec,
      args,
      cwd,
      exitCode: typeof captured.code === "number" ? captured.code : null,
      stdout: sanitizeText(String(captured.stdout ?? "")),
      stderr: sanitizeText(String(captured.stderr ?? captured.message ?? error)),
    };
  }
}

export function truncateOutput(text: string, maxBytes = 12000): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }

  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export function normalizeRepoPath(input: string): string {
  const normalized = String(input || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Path must be a relative repository path.");
  }

  return normalized;
}


