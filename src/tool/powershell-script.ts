import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSupervisedCommand, normalizeRepoPath, truncateOutput } from "../Infrastructure/Process/SupervisedCommand.js";
import { buildSafeEnv, resolveCommandExecutable, sanitizeText } from "../Infrastructure/Process/ProcessRuntime.js";
import { assertAllowedRoot, isWithinRoot } from "../Policy/PathGuard.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const allowedScriptRoots = ["tool", "bin"] as const;
const allowedExecutables = ["pwsh", "powershell"] as const;
const terminalStatuses = ["succeeded", "failed", "stopped", "timed_out"] as const;
const maxConcurrentRuns = 4;
const maxOutputBytes = 16 * 1024 * 1024;
const retentionMs = 24 * 60 * 60 * 1000;
const activeRuns = new Map<string, ChildProcess>();
const timeoutHandles = new Map<string, NodeJS.Timeout>();

type Executable = (typeof allowedExecutables)[number];
type TerminalStatus = (typeof terminalStatuses)[number];
type RunStatus = "running" | "stopping" | TerminalStatus;

type PowerShellRunState = {
  schemaVersion: 1;
  runId: string;
  status: RunStatus;
  pid: number;
  executable: Executable;
  workspacePath: string;
  scriptPath: string;
  scriptRelativePath: string;
  arguments: string[];
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

export function registerPowerShellScriptTool(server: McpServer, policy: ConsolePolicy, authConfig: ConsoleAuthConfig): void {
  const mutationRegistration = buildConsoleMutationToolRegistration(authConfig);
  const readRegistration = buildConsoleToolRegistration(authConfig);

  server.registerTool(
    "console.write.repo.powershell.script.run",
    {
      ...mutationRegistration,
      description: "Run an explicitly approved repository-local .ps1 script from tool/ or bin/. The script path is confined by realpath, arguments are passed without shell interpolation, and runtime/output are bounded.",
      inputSchema: z.object({ workspacePath: z.string().min(1), scriptPath: z.string().min(1).max(500), arguments: z.array(z.string().max(1000)).max(100).optional(), executable: z.enum(allowedExecutables).optional(), timeoutMs: z.number().int().min(1000).max(1800000).optional(), confirmRun: z.boolean().optional() }).shape
    },
    async ({ workspacePath, scriptPath, arguments: scriptArguments, executable, timeoutMs, confirmRun }) => textResult(await runPowerShellScript(policy, workspacePath, scriptPath, scriptArguments, executable, timeoutMs, confirmRun))
  );

  server.registerTool(
    "console.write.repo.powershell.script.start",
    {
      ...mutationRegistration,
      description: "Start a bounded repository-local PowerShell script run and return a durable run ID immediately.",
      inputSchema: z.object({ workspacePath: z.string().min(1), scriptPath: z.string().min(1).max(500), arguments: z.array(z.string().max(1000)).max(100).optional(), executable: z.enum(allowedExecutables).optional(), timeoutMs: z.number().int().min(1000).max(1800000).optional(), confirmRun: z.boolean().optional() }).shape
    },
    async (input) => textResult(await startPowerShellScript(policy, input))
  );

  server.registerTool(
    "console.read_.repo.powershell.script.status",
    {
      ...readRegistration,
      description: "Read the current lifecycle status of a bounded PowerShell script run.",
      inputSchema: z.object({ workspacePath: z.string().min(1), runId: z.string().uuid() }).shape
    },
    async ({ workspacePath, runId }) => textResult(await getPowerShellScriptStatus(policy, workspacePath, runId))
  );

  server.registerTool(
    "console.read_.repo.powershell.script.output",
    {
      ...readRegistration,
      description: "Read bounded incremental stdout and stderr chunks for a PowerShell script run using independent byte offsets.",
      inputSchema: z.object({ workspacePath: z.string().min(1), runId: z.string().uuid(), stdoutOffset: z.number().int().min(0).optional(), stderrOffset: z.number().int().min(0).optional(), limitBytes: z.number().int().min(1024).max(262144).optional() }).shape
    },
    async (input) => textResult(await getPowerShellScriptOutput(policy, input))
  );

  server.registerTool(
    "console.write.repo.powershell.script.stop",
    {
      ...mutationRegistration,
      description: "Idempotently stop a bounded PowerShell run and its Windows process tree.",
      inputSchema: z.object({ workspacePath: z.string().min(1), runId: z.string().uuid(), confirmStop: z.boolean().optional() }).shape
    },
    async ({ workspacePath, runId, confirmStop }) => textResult(await stopPowerShellScript(policy, workspacePath, runId, confirmStop))
  );
}

async function startPowerShellScript(policy: ConsolePolicy, input: { workspacePath: string; scriptPath: string; arguments?: string[]; executable?: Executable; timeoutMs?: number; confirmRun?: boolean }): Promise<Record<string, unknown>> {
  if (input.confirmRun !== true) throw new Error("PowerShell script execution requires confirmRun=true.");
  const resolved = resolveScript(policy, input.workspacePath, input.scriptPath, input.arguments, input.executable, input.timeoutMs);
  await pruneExpiredRuns(resolved.workspaceRealPath);
  const runningCount = (await readAllRunStates(resolved.workspaceRealPath)).filter((state) => state.status === "running" || state.status === "stopping").length;
  if (runningCount >= maxConcurrentRuns) throw new Error(`PowerShell runner concurrency limit reached (${maxConcurrentRuns}).`);

  const runId = randomUUID();
  const runDir = getRunDir(resolved.workspaceRealPath, runId);
  await mkdir(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  await Promise.all([writeFile(stdoutPath, "", "utf8"), writeFile(stderrPath, "", "utf8")]);
  const startedAt = new Date();
  const state: PowerShellRunState = { schemaVersion: 1, runId, status: "running", pid: 0, executable: resolved.executable, workspacePath: resolved.workspaceRealPath, scriptPath: resolved.resolvedScriptPath, scriptRelativePath: resolved.scriptPath, arguments: resolved.scriptArguments, startedAt: startedAt.toISOString(), deadlineAt: new Date(startedAt.getTime() + resolved.timeoutMs).toISOString(), finishedAt: null, exitCode: null, stopReason: null, stdoutPath, stderrPath, stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };

  const executablePath = resolvePowerShellExecutable(resolved.executable);
  const child = spawn(executablePath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved.resolvedScriptPath, ...resolved.scriptArguments], { cwd: resolved.workspaceRealPath, windowsHide: true, env: buildSafeEnv(), stdio: ["ignore", "pipe", "pipe"] }); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- executable is restricted to pwsh/powershell native .exe; script realpath is confined to tool/bin under workspace; arguments are passed as an argv vector without shell interpolation.
  await waitForSpawn(child);
  state.pid = child.pid ?? 0;
  await writeRunState(resolved.workspaceRealPath, state);
  activeRuns.set(runId, child);
  captureBoundedOutput(child.stdout, stdoutPath, state, "stdout");
  captureBoundedOutput(child.stderr, stderrPath, state, "stderr");
  child.once("error", async (error) => finalizeRun(state, "failed", null, sanitizeText(error.message)));
  child.once("close", async (code) => {
    const current = await readRunState(resolved.workspaceRealPath, runId);
    if (!current || isTerminal(current.status)) return;
    await finalizeRun(current, code === 0 ? "succeeded" : "failed", code, code === 0 ? null : "process_exit");
  });

  const timer = setTimeout(async () => {
    const current = await readRunState(resolved.workspaceRealPath, runId);
    if (!current || isTerminal(current.status)) return;
    await terminateProcessTree(current);
    await finalizeRun(current, "timed_out", null, "runtime_limit_exceeded");
  }, resolved.timeoutMs);
  timer.unref();
  timeoutHandles.set(runId, timer);
  return summarizeState(state);
}

async function getPowerShellScriptStatus(policy: ConsolePolicy, workspacePath: string, runId: string): Promise<Record<string, unknown>> {
  const workspace = realWorkspace(policy, workspacePath);
  let state = await requireRunState(workspace, runId);
  if (!isTerminal(state.status) && Date.now() >= Date.parse(state.deadlineAt)) {
    await terminateProcessTree(state);
    await finalizeRun(state, "timed_out", null, "runtime_limit_exceeded");
    state = await requireRunState(workspace, runId);
  } else if (state.status === "running" && !activeRuns.has(runId) && !(await isProcessRunning(state.pid))) {
    await finalizeRun(state, "failed", state.exitCode, "process_not_running");
    state = await requireRunState(workspace, runId);
  }
  return summarizeState(state);
}

async function getPowerShellScriptOutput(policy: ConsolePolicy, input: { workspacePath: string; runId: string; stdoutOffset?: number; stderrOffset?: number; limitBytes?: number }): Promise<Record<string, unknown>> {
  const workspace = realWorkspace(policy, input.workspacePath);
  const state = await requireRunState(workspace, input.runId);
  const limit = input.limitBytes ?? 65536;
  const stdout = await readOutputChunk(state.stdoutPath, input.stdoutOffset ?? 0, limit);
  const stderr = await readOutputChunk(state.stderrPath, input.stderrOffset ?? 0, limit);
  return { ok: true, run_id: state.runId, status: state.status, stdout: stdout.text, stderr: stderr.text, stdout_offset: stdout.offset, stderr_offset: stderr.offset, next_stdout_offset: stdout.nextOffset, next_stderr_offset: stderr.nextOffset, stdout_eof: stdout.nextOffset >= stdout.totalBytes, stderr_eof: stderr.nextOffset >= stderr.totalBytes, stdout_truncated: state.stdoutTruncated, stderr_truncated: state.stderrTruncated };
}

async function stopPowerShellScript(policy: ConsolePolicy, workspacePath: string, runId: string, confirmStop: boolean | undefined): Promise<Record<string, unknown>> {
  if (confirmStop !== true) throw new Error("PowerShell script stop requires confirmStop=true.");
  const workspace = realWorkspace(policy, workspacePath);
  const state = await requireRunState(workspace, runId);
  if (isTerminal(state.status)) return { ...summarizeState(state), already_terminal: true };
  state.status = "stopping";
  await writeRunState(workspace, state);
  await terminateProcessTree(state);
  await finalizeRun(state, "stopped", null, "requested");
  return { ...summarizeState(await requireRunState(workspace, runId)), already_terminal: false };
}

async function runPowerShellScript(policy: ConsolePolicy, workspacePath: string, scriptPathInput: string, scriptArgumentsInput: string[] | undefined, executableInput: Executable | undefined, timeoutMsInput: number | undefined, confirmRun: boolean | undefined): Promise<Record<string, unknown>> {
  if (confirmRun !== true) throw new Error("PowerShell script execution requires confirmRun=true.");
  const resolved = resolveScript(policy, workspacePath, scriptPathInput, scriptArgumentsInput, executableInput, timeoutMsInput);
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved.resolvedScriptPath, ...resolved.scriptArguments];
  const result = await runSupervisedCommand(resolved.workspaceRealPath, resolved.executable, args, resolved.timeoutMs, 4 * 1024 * 1024);
  const stdout = truncateOutput(sanitizeText(result.stdout), 24000);
  const stderr = truncateOutput(sanitizeText(result.stderr), 24000);
  return { ok: result.exitCode === 0, status: result.exitCode === 0 ? "POWERSHELL_SCRIPT_COMPLETED" : "POWERSHELL_SCRIPT_FAILED", mode: "guarded-repository-powershell-script-runner", executable: resolved.executable, cwd: resolved.workspaceRealPath, script_path: resolved.resolvedScriptPath, script_relative_path: resolved.scriptPath, arguments: resolved.scriptArguments, allowed_script_roots: allowedScriptRoots, exitCode: result.exitCode, timeoutMs: resolved.timeoutMs, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function resolveScript(policy: ConsolePolicy, workspacePath: string, scriptPathInput: string, scriptArgumentsInput: string[] | undefined, executableInput: Executable | undefined, timeoutMsInput: number | undefined) {
  const workspace = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const workspaceRealPath = realpathSync(workspace);
  const scriptPath = normalizeRepoPath(scriptPathInput);
  const firstSegment = scriptPath.split("/")[0]?.toLowerCase();
  if (!allowedScriptRoots.includes(firstSegment as (typeof allowedScriptRoots)[number])) throw new Error(`PowerShell scripts may run only from: ${allowedScriptRoots.join(", ")}.`);
  if (path.posix.extname(scriptPath).toLowerCase() !== ".ps1") throw new Error("scriptPath must reference a .ps1 file.");
  const candidatePath = path.resolve(workspace, ...scriptPath.split("/"));
  if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) throw new Error(`PowerShell script was not found: ${scriptPath}`);
  const resolvedScriptPath = realpathSync(candidatePath);
  if (!isWithinRoot(resolvedScriptPath, workspaceRealPath)) throw new Error("Resolved script path escapes the workspace.");
  const scriptArguments = (scriptArgumentsInput ?? []).map((argument) => { if (argument.includes("\0")) throw new Error("PowerShell script arguments must not contain null bytes."); return argument; });
  return { workspaceRealPath, scriptPath, resolvedScriptPath, scriptArguments, executable: executableInput ?? "pwsh", timeoutMs: clampTimeout(timeoutMsInput) };
}

function realWorkspace(policy: ConsolePolicy, workspacePath: string): string { return realpathSync(assertAllowedRoot(workspacePath, policy.allowedRoots)); }
function getRunsRoot(workspace: string): string { return path.join(workspace, ".console-mcp", "powershell-script-run"); }
function getRunDir(workspace: string, runId: string): string { return path.join(getRunsRoot(workspace), runId); }
function getStatePath(workspace: string, runId: string): string { return path.join(getRunDir(workspace, runId), "state.json"); }

async function writeRunState(workspace: string, state: PowerShellRunState): Promise<void> {
  const statePath = getStatePath(workspace, state.runId);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readRunState(workspace: string, runId: string): Promise<PowerShellRunState | null> {
  const statePath = getStatePath(workspace, runId);
  if (!existsSync(statePath)) return null;
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as PowerShellRunState;
  return parsed.schemaVersion === 1 && parsed.runId === runId ? parsed : null;
}

async function requireRunState(workspace: string, runId: string): Promise<PowerShellRunState> {
  const state = await readRunState(workspace, runId);
  if (!state) throw new Error(`PowerShell run was not found: ${runId}`);
  if (realpathSync(state.workspacePath) !== workspace) throw new Error("PowerShell run workspace mismatch.");
  return state;
}

async function readAllRunStates(workspace: string): Promise<PowerShellRunState[]> {
  const root = getRunsRoot(workspace);
  if (!existsSync(root)) return [];
  const states = await Promise.all((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => readRunState(workspace, entry.name)));
  return states.filter((state): state is PowerShellRunState => state !== null);
}

async function pruneExpiredRuns(workspace: string): Promise<void> {
  const now = Date.now();
  for (const state of await readAllRunStates(workspace)) if (isTerminal(state.status) && state.finishedAt && now - Date.parse(state.finishedAt) > retentionMs) await rm(getRunDir(workspace, state.runId), { recursive: true, force: true });
}

function captureBoundedOutput(stream: NodeJS.ReadableStream, outputPath: string, state: PowerShellRunState, channel: "stdout" | "stderr"): void {
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

async function finalizeRun(state: PowerShellRunState, status: TerminalStatus, exitCode: number | null, stopReason: string | null): Promise<void> {
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

function refreshOutputMetadata(state: PowerShellRunState): void {
  state.stdoutBytes = existsSync(state.stdoutPath) ? statSync(state.stdoutPath).size : 0;
  state.stderrBytes = existsSync(state.stderrPath) ? statSync(state.stderrPath).size : 0;
}

async function terminateProcessTree(state: PowerShellRunState): Promise<void> {
  if (state.pid <= 0) return;
  await runSupervisedCommand(state.workspacePath, "taskkill", ["/PID", String(state.pid), "/T", "/F"], 30000, 1024 * 1024);
  activeRuns.delete(state.runId);
}

async function isProcessRunning(pid: number): Promise<boolean> {
  if (pid <= 0) return false;
  const result = await runSupervisedCommand(process.cwd(), "tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], 30000, 1024 * 1024);
  return result.ok && result.stdout.includes(`"${pid}"`);
}

async function readOutputChunk(filePath: string, offset: number, limit: number): Promise<{ text: string; offset: number; nextOffset: number; totalBytes: number }> {
  const content = existsSync(filePath) ? await readFile(filePath) : Buffer.alloc(0);
  const safeOffset = Math.min(offset, content.length);
  const chunk = content.subarray(safeOffset, Math.min(content.length, safeOffset + limit));
  return { text: sanitizeText(chunk.toString("utf8")), offset: safeOffset, nextOffset: safeOffset + chunk.length, totalBytes: content.length };
}

function summarizeState(state: PowerShellRunState): Record<string, unknown> {
  return { ok: state.status === "running" || state.status === "succeeded", run_id: state.runId, status: state.status, pid: state.pid, workspace_path: state.workspacePath, script_relative_path: state.scriptRelativePath, started_at: state.startedAt, deadline_at: state.deadlineAt, finished_at: state.finishedAt, duration_ms: (state.finishedAt ? Date.parse(state.finishedAt) : Date.now()) - Date.parse(state.startedAt), exit_code: state.exitCode, stop_reason: state.stopReason, stdout_bytes: state.stdoutBytes, stderr_bytes: state.stderrBytes, stdout_truncated: state.stdoutTruncated, stderr_truncated: state.stderrTruncated, max_output_bytes_per_stream: maxOutputBytes, max_concurrent_runs: maxConcurrentRuns, retention_ms: retentionMs };
}

function isTerminal(status: RunStatus): status is TerminalStatus { return terminalStatuses.includes(status as TerminalStatus); }
function clampTimeout(value: number | undefined): number { if (!Number.isFinite(value ?? Number.NaN)) return 300000; return Math.max(1000, Math.min(1800000, Math.trunc(value as number))); }

function resolvePowerShellExecutable(executable: Executable): string {
  if (executable === "powershell") {
    const systemPowerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(systemPowerShell)) return systemPowerShell;
  }

  const resolved = resolveCommandExecutable(executable).replaceAll("\"", "");
  if (path.extname(resolved).toLowerCase() !== ".exe") {
    throw new Error(`PowerShell executable must resolve to a native .exe, received: ${resolved}`);
  }
  return resolved;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid && child.pid > 0) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
