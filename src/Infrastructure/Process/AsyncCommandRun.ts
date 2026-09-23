import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { buildSafeEnv, resolveCommandInvocation, sanitizeText } from "./ProcessRuntime.js";
import { runSupervisedCommand } from "./SupervisedCommand.js";

const terminalStatuses = ["succeeded", "failed", "stopped", "timed_out"] as const;
const maxOutputBytes = 16 * 1024 * 1024;
const retentionMs = 24 * 60 * 60 * 1000;
const activeRuns = new Map<string, ChildProcess>();
const timeoutHandles = new Map<string, NodeJS.Timeout>();

type TerminalStatus = (typeof terminalStatuses)[number];
type RunStatus = "running" | "stopping" | TerminalStatus;

export type AsyncCommandRunState = {
  schemaVersion: 1;
  runId: string;
  kind: string;
  status: RunStatus;
  pid: number;
  workspacePath: string;
  command: string;
  args: string[];
  startedAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stopReason: string | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export async function startAsyncCommandRun(input: { workspacePath: string; command: string; args: string[]; timeoutMs: number; kind: string }): Promise<Record<string, unknown>> {
  const workspace = realpathSync(input.workspacePath);
  await pruneExpiredRuns(workspace);

  const runId = randomUUID();
  const runDir = getRunDir(workspace, runId);
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, "", "utf8")]);

  const startedAt = new Date();
  const timeoutMs = clampTimeout(input.timeoutMs);
  const resolved = resolveCommandInvocation(input.command, input.args);
  const state: AsyncCommandRunState = {
    schemaVersion: 1,
    runId,
    kind: input.kind,
    status: "running",
    pid: 0,
    workspacePath: workspace,
    command: resolved.command,
    args: resolved.args,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
    finishedAt: null,
    exitCode: null,
    stopReason: null,
    stdoutPath,
    stderrPath,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };

  const child = spawn(resolved.command, resolved.args, {
    cwd: workspace,
    windowsHide: true,
    env: buildSafeEnv(),
    shell: resolved.shell,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForSpawn(child);
  state.pid = child.pid ?? 0;
  await writeRunState(workspace, state);
  activeRuns.set(runId, child);

  captureBoundedOutput(child.stdout, stdoutPath, state, "stdout");
  captureBoundedOutput(child.stderr, stderrPath, state, "stderr");
  child.once("error", async (error) => finalizeRun(state, "failed", null, sanitizeText(error.message)));
  child.once("close", async (code) => {
    const current = await readRunState(workspace, runId);
    if (!current || isTerminal(current.status)) return;
    await finalizeRun(current, code === 0 ? "succeeded" : "failed", code, code === 0 ? null : "process_exit");
  });

  const timer = setTimeout(async () => {
    const current = await readRunState(workspace, runId);
    if (!current || isTerminal(current.status)) return;
    await terminateProcessTree(current);
    await finalizeRun(current, "timed_out", null, "runtime_limit_exceeded");
  }, timeoutMs);
  timer.unref();
  timeoutHandles.set(runId, timer);

  return summarizeState(state);
}

export async function getAsyncCommandRunStatus(workspacePath: string, runId: string): Promise<Record<string, unknown>> {
  const workspace = realpathSync(workspacePath);
  let state = await requireRunState(workspace, runId);
  if (!isTerminal(state.status) && Date.now() >= Date.parse(state.deadlineAt)) {
    await terminateProcessTree(state);
    await finalizeRun(state, "timed_out", null, "runtime_limit_exceeded");
    state = await requireRunState(workspace, runId);
  } else if (state.status === "running" && !activeRuns.has(runId) && !(await isProcessRunning(state.pid))) {
    await finalizeRun(state, "failed", state.exitCode, "process_not_running");
    state = await requireRunState(workspace, runId);
  }
  refreshOutputMetadata(state);
  return summarizeState(state);
}

export async function getAsyncCommandRunOutput(input: { workspacePath: string; runId: string; stdoutOffset?: number; stderrOffset?: number; limitBytes?: number }): Promise<Record<string, unknown>> {
  const workspace = realpathSync(input.workspacePath);
  const state = await requireRunState(workspace, input.runId);
  const limit = Math.max(1024, Math.min(262144, input.limitBytes ?? 65536));
  const stdout = await readOutputChunk(state.stdoutPath, input.stdoutOffset ?? 0, limit);
  const stderr = await readOutputChunk(state.stderrPath, input.stderrOffset ?? 0, limit);
  return {
    ok: true,
    run_id: state.runId,
    kind: state.kind,
    status: state.status,
    stdout: stdout.text,
    stderr: stderr.text,
    stdout_offset: stdout.offset,
    stderr_offset: stderr.offset,
    next_stdout_offset: stdout.nextOffset,
    next_stderr_offset: stderr.nextOffset,
    stdout_eof: stdout.nextOffset >= stdout.totalBytes,
    stderr_eof: stderr.nextOffset >= stderr.totalBytes,
    stdout_truncated: state.stdoutTruncated,
    stderr_truncated: state.stderrTruncated,
  };
}

export async function stopAsyncCommandRun(workspacePath: string, runId: string, confirmStop: boolean | undefined): Promise<Record<string, unknown>> {
  if (confirmStop !== true) throw new Error("Async command stop requires confirmStop=true.");
  const workspace = realpathSync(workspacePath);
  const state = await requireRunState(workspace, runId);
  if (isTerminal(state.status)) return { ...summarizeState(state), already_terminal: true };
  state.status = "stopping";
  await writeRunState(workspace, state);
  await terminateProcessTree(state);
  await finalizeRun(state, "stopped", null, "requested");
  return { ...summarizeState(await requireRunState(workspace, runId)), already_terminal: false };
}

function getRunsRoot(workspace: string): string { return path.join(workspace, ".console-mcp", "command-run"); }
function getRunDir(workspace: string, runId: string): string { return path.join(getRunsRoot(workspace), runId); }
function getStatePath(workspace: string, runId: string): string { return path.join(getRunDir(workspace, runId), "state.json"); }

async function writeRunState(workspace: string, state: AsyncCommandRunState): Promise<void> {
  await mkdir(getRunDir(workspace, state.runId), { recursive: true });
  await writeFile(getStatePath(workspace, state.runId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readRunState(workspace: string, runId: string): Promise<AsyncCommandRunState | null> {
  const statePath = getStatePath(workspace, runId);
  if (!existsSync(statePath)) return null;
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as AsyncCommandRunState;
  return parsed.schemaVersion === 1 && parsed.runId === runId ? parsed : null;
}

async function requireRunState(workspace: string, runId: string): Promise<AsyncCommandRunState> {
  const state = await readRunState(workspace, runId);
  if (!state) throw new Error(`Async command run was not found: ${runId}`);
  if (realpathSync(state.workspacePath) !== workspace) throw new Error("Async command run workspace mismatch.");
  return state;
}

async function readAllRunStates(workspace: string): Promise<AsyncCommandRunState[]> {
  const root = getRunsRoot(workspace);
  if (!existsSync(root)) return [];
  const states = await Promise.all((await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRunState(workspace, entry.name)));
  return states.filter((state): state is AsyncCommandRunState => state !== null);
}

async function pruneExpiredRuns(workspace: string): Promise<void> {
  const now = Date.now();
  for (const state of await readAllRunStates(workspace)) {
    if (isTerminal(state.status) && state.finishedAt && now - Date.parse(state.finishedAt) > retentionMs) {
      await rm(getRunDir(workspace, state.runId), { recursive: true, force: true });
    }
  }
}

function captureBoundedOutput(stream: NodeJS.ReadableStream | null, outputPath: string, state: AsyncCommandRunState, channel: "stdout" | "stderr"): void {
  if (!stream) return;
  stream.on("data", async (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const byteKey = channel === "stdout" ? "stdoutBytes" : "stderrBytes";
    const truncatedKey = channel === "stdout" ? "stdoutTruncated" : "stderrTruncated";
    const remaining = Math.max(0, maxOutputBytes - state[byteKey]);
    if (remaining > 0) {
      const accepted = buffer.subarray(0, remaining);
      await writeFile(outputPath, accepted, { flag: "a" });
      state[byteKey] += accepted.length;
    }
    if (buffer.length > remaining) state[truncatedKey] = true;
  });
}

async function finalizeRun(state: AsyncCommandRunState, status: TerminalStatus, exitCode: number | null, stopReason: string | null): Promise<void> {
  if (isTerminal(state.status)) return;
  refreshOutputMetadata(state);
  state.status = status;
  state.exitCode = exitCode;
  state.stopReason = stopReason;
  state.finishedAt = new Date().toISOString();
  await writeRunState(state.workspacePath, state);
  activeRuns.delete(state.runId);
  const timer = timeoutHandles.get(state.runId);
  if (timer) clearTimeout(timer);
  timeoutHandles.delete(state.runId);
}

function refreshOutputMetadata(state: AsyncCommandRunState): void {
  state.stdoutBytes = existsSync(state.stdoutPath) ? statSync(state.stdoutPath).size : 0;
  state.stderrBytes = existsSync(state.stderrPath) ? statSync(state.stderrPath).size : 0;
}

async function terminateProcessTree(state: AsyncCommandRunState): Promise<void> {
  if (state.pid <= 0) return;
  if (process.platform === "win32") {
    await runSupervisedCommand(state.workspacePath, "taskkill", ["/PID", String(state.pid), "/T", "/F"], 30000, 1024 * 1024);
  } else {
    try { process.kill(state.pid, "SIGTERM"); } catch {}
  }
  activeRuns.delete(state.runId);
}

async function isProcessRunning(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  if (process.platform === "win32") {
    const result = await runSupervisedCommand(process.cwd(), "tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 30000, 1024 * 1024);
    return result.ok && result.stdout.includes(`"${pid}"`);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readOutputChunk(filePath: string, offset: number, limit: number): Promise<{ text: string; offset: number; nextOffset: number; totalBytes: number }> {
  const content = existsSync(filePath) ? await readFile(filePath) : Buffer.alloc(0);
  const safeOffset = Math.min(Math.max(0, offset), content.length);
  const chunk = content.subarray(safeOffset, Math.min(content.length, safeOffset + limit));
  return { text: sanitizeText(chunk.toString("utf8")), offset: safeOffset, nextOffset: safeOffset + chunk.length, totalBytes: content.length };
}

function summarizeState(state: AsyncCommandRunState): Record<string, unknown> {
  return {
    ok: state.status === "running" || state.status === "succeeded",
    run_id: state.runId,
    kind: state.kind,
    status: state.status,
    pid: state.pid,
    workspace_path: state.workspacePath,
    command: state.command,
    args: state.args,
    started_at: state.startedAt,
    deadline_at: state.deadlineAt,
    finished_at: state.finishedAt,
    duration_ms: (state.finishedAt ? Date.parse(state.finishedAt) : Date.now()) - Date.parse(state.startedAt),
    exit_code: state.exitCode,
    stop_reason: state.stopReason,
    stdout_bytes: state.stdoutBytes,
    stderr_bytes: state.stderrBytes,
    stdout_truncated: state.stdoutTruncated,
    stderr_truncated: state.stderrTruncated,
    max_output_bytes_per_stream: maxOutputBytes,
    retention_ms: retentionMs,
  };
}

function isTerminal(status: RunStatus): status is TerminalStatus { return terminalStatuses.includes(status as TerminalStatus); }
function clampTimeout(value: number): number { return Math.max(1000, Math.min(1800000, Math.trunc(value))); }

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid && child.pid > 0) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

