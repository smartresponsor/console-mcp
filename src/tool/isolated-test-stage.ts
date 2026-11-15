import { spawn } from "node:child_process";
import { buildSafeEnv, resolveCommandInvocation, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

export class IsolatedTestTreeTerminationError extends Error {
  constructor(message: string) { super(message); this.name = "IsolatedTestTreeTerminationError"; }
}

let activeStagePid: number | null = null;
let activeStageCwd: string | null = null;
let cancellationRequested = false;

/** SIGTERM from the outer async controller must forward to the active, detached stage group. */
export async function cancelActiveIsolatedTestStage(): Promise<void> {
  cancellationRequested = true;
  const pid = activeStagePid;
  if (!pid || !activeStageCwd) return;
  if (process.platform === "win32") {
    const result = await runSupervisedCommand(activeStageCwd, "taskkill", ["/PID", String(pid), "/T", "/F"], 15000);
    if (!result.ok) throw new IsolatedTestTreeTerminationError("ISOLATED_TEST_PROCESS_TREE_KILL_FAILED");
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new IsolatedTestTreeTerminationError("ISOLATED_TEST_PROCESS_GROUP_KILL_FAILED");
      }
    }
  }
}

export function assertIsolatedTestNotCancelled(): void {
  if (cancellationRequested) throw new Error("ISOLATED_TEST_CANCELLED");
}

/** Bounded, non-shell, process-tree-aware isolated acceptance stage. */
export async function runIsolatedTestStage(
  cwd: string, command: string, args: string[], timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  assertIsolatedTestNotCancelled();
  const invocation = resolveCommandInvocation(command, args);
  if (invocation.shell) throw new Error("ISOLATED_TEST_SHELL_FORBIDDEN");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
    throw new Error("ISOLATED_TEST_TIMEOUT_INVALID");
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd, windowsHide: true, shell: false, env: buildSafeEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeStagePid = child.pid ?? null;
  activeStageCwd = cwd;
  const maxBytes = 2 * 1024 * 1024;
  let stdout = "", stderr = "";
  let stdoutBytes = 0, stderrBytes = 0;
  const collect = (stream: NodeJS.ReadableStream | null, side: "stdout" | "stderr") => {
    stream?.on("data", (data: Buffer) => {
      if (side === "stdout") {
        stdoutBytes += data.byteLength;
        if (stdoutBytes <= maxBytes) stdout += data.toString("utf8");
      } else {
        stderrBytes += data.byteLength;
        if (stderrBytes <= maxBytes) stderr += data.toString("utf8");
      }
    });
  };
  collect(child.stdout, "stdout");
  collect(child.stderr, "stderr");
  let timedOut = false;
  let settled = false;
  let killPromise: Promise<void> | null = null;
  const stopTree = async () => {
    if (!child.pid || settled) return;
    if (process.platform === "win32") {
      const stopped = await runSupervisedCommand(cwd, "taskkill", ["/PID", String(child.pid), "/T", "/F"], 15000);
      if (!stopped.ok) throw new IsolatedTestTreeTerminationError("ISOLATED_TEST_PROCESS_TREE_KILL_FAILED: " + stopped.stderr.slice(0, 500));
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw new IsolatedTestTreeTerminationError("ISOLATED_TEST_PROCESS_GROUP_KILL_FAILED");
        }
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killPromise = stopTree();
  }, timeoutMs);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code));
    });
    settled = true;
    return {
      ok: exitCode === 0 && !timedOut && stdoutBytes <= maxBytes && stderrBytes <= maxBytes,
      exitCode, timedOut,
      stdout: sanitizeText(stdout),
      stderr: sanitizeText(stderr) + ((stdoutBytes > maxBytes || stderrBytes > maxBytes) ? "\nISOLATED_TEST_OUTPUT_LIMIT_EXCEEDED" : ""),
    };
  } finally {
    clearTimeout(timeout);
    if (killPromise) await killPromise;
    if (activeStagePid === child.pid) { activeStagePid = null; activeStageCwd = null; }
  }
}
