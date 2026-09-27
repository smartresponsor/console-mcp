import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
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
type DedupeDecision = "started_new" | "reused_running" | "reused_recent_result" | "stale_lease_recovered";

type AsyncCommandCapacityInput = {
  class: "heavy";
  rootPath: string;
  limit?: number;
};

type AsyncCommandCapacityLease = {
  class: "heavy";
  leaseId: string;
  slot: number;
  lockPath: string;
  limit: number;
  ownerPid: number;
};

type AsyncCommandRunDedupeInput = {
  operationKey: string;
  repositoryFingerprint: string;
  reuseSuccessful?: boolean;
  recentResultTtlMs?: number;
  leaseTtlMs?: number;
};

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
  capacity?: AsyncCommandCapacityLease;
  dedupe?: {
    operationHash: string;
    operationKey: string;
    repositoryFingerprint: string;
    leasePath: string;
    recentResultTtlMs: number;
    reuseSuccessful: boolean;
  };
};

export type AsyncCommandRunStartInput = {
  workspacePath: string;
  command: string;
  args: string[];
  timeoutMs: number;
  kind: string;
  capacity?: AsyncCommandCapacityInput;
  dedupe?: AsyncCommandRunDedupeInput;
};

type AsyncCommandCapacityAcquireResult =
  | { ok: true; lease: AsyncCommandCapacityLease }
  | { ok: false; status: "ASYNC_COMMAND_WAITING_HEAVY_CAPACITY"; limit: number; occupied: number; retryAfterMs: number };

function resolveHeavyExecutionSlotLimit(value?: number): number {
  const configured = value ?? Number.parseInt(process.env.CONSOLE_MCP_HEAVY_EXECUTION_SLOTS ?? "2", 10);
  return Number.isInteger(configured) && configured > 0 && configured <= 16 ? configured : 2;
}

async function acquireAsyncCommandCapacity(input: AsyncCommandCapacityInput, kind: string): Promise<AsyncCommandCapacityAcquireResult> {
  const limit = resolveHeavyExecutionSlotLimit(input.limit);
  const slotDir = path.join(path.resolve(input.rootPath), "var", "run", "runtime-capacity-heavy");
  await mkdir(slotDir, { recursive: true });
  let occupied = 0;
  for (let slot = 0; slot < limit; slot += 1) {
    const lockPath = path.join(slotDir, `slot-${slot}.lock`);
    const leaseId = randomUUID();
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ schema_version: 1, class: "heavy", lease_id: leaseId, slot, limit, owner_pid: process.pid, run_id: null, kind, acquired_at: new Date().toISOString() })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { ok: true, lease: { class: "heavy", leaseId, slot, lockPath, limit, ownerPid: process.pid } };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code !== "EEXIST") throw error;
      const existing = await readAsyncCapacityLock(lockPath);
      const ownerPid = typeof existing?.owner_pid === "number" ? existing.owner_pid : null;
      if (ownerPid === null || !(await isProcessRunning(ownerPid))) {
        await unlink(lockPath).catch(() => undefined);
        slot -= 1;
        continue;
      }
      occupied += 1;
    }
  }
  return { ok: false, status: "ASYNC_COMMAND_WAITING_HEAVY_CAPACITY", limit, occupied, retryAfterMs: 30000 };
}

async function bindAsyncCommandCapacityToChild(lease: AsyncCommandCapacityLease, childPid: number, runId: string, kind: string): Promise<AsyncCommandCapacityLease> {
  const existing = await readAsyncCapacityLock(lease.lockPath);
  if (existing?.lease_id !== lease.leaseId) throw new Error("Heavy capacity lease ownership changed before child binding.");
  await writeFile(lease.lockPath, `${JSON.stringify({ ...existing, owner_pid: childPid, run_id: runId, kind, child_bound_at: new Date().toISOString() })}\n`, "utf8");
  return { ...lease, ownerPid: childPid };
}

async function releaseAsyncCommandCapacity(lease: AsyncCommandCapacityLease | undefined): Promise<void> {
  if (!lease) return;
  const existing = await readAsyncCapacityLock(lease.lockPath);
  if (existing?.lease_id !== lease.leaseId) return;
  await unlink(lease.lockPath).catch(() => undefined);
}

async function readAsyncCapacityLock(lockPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function startAsyncCommandRun(input: AsyncCommandRunStartInput): Promise<Record<string, unknown>> {
  const workspace = realpathSync(input.workspacePath);
  await pruneExpiredRuns(workspace);

  const dedupe = input.dedupe ? normalizeDedupeInput(workspace, input.kind, input.dedupe) : null;
  if (dedupe) {
    const existing = await resolveDedupeLease(workspace, dedupe);
    if (existing.state) {
      return withDedupeDecision(summarizeState(existing.state), existing.decision, existing.leaseRecovered);
    }
  }
  const startLock = dedupe ? await acquireDedupeStartLock(workspace, dedupe) : null;
  if (startLock?.state) {
    return withDedupeDecision(summarizeState(startLock.state), startLock.decision, startLock.leaseRecovered);
  }

  const capacityAcquire = input.capacity ? await acquireAsyncCommandCapacity(input.capacity, input.kind) : null;
  if (capacityAcquire && capacityAcquire.ok !== true) {
    await startLock?.release();
    return {
      ok: false,
      status: capacityAcquire.status,
      capacity_class: "heavy",
      capacity: { limit: capacityAcquire.limit, occupied: capacityAcquire.occupied, available: 0 },
      starts_process: false,
      retry_after_ms: capacityAcquire.retryAfterMs,
    };
  }
  let capacityLease = capacityAcquire?.ok === true ? capacityAcquire.lease : undefined;

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
    capacity: capacityLease,
    dedupe: dedupe ? {
      operationHash: dedupe.operationHash,
      operationKey: dedupe.operationKey,
      repositoryFingerprint: dedupe.repositoryFingerprint,
      leasePath: dedupe.leasePath,
      recentResultTtlMs: dedupe.recentResultTtlMs,
      reuseSuccessful: dedupe.reuseSuccessful,
    } : undefined,
  };

  let child: ChildProcess;
  try {
    child = spawn(resolved.command, resolved.args, {
      cwd: workspace,
      windowsHide: true,
      env: buildSafeEnv(),
      shell: resolved.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForSpawn(child);
    state.pid = child.pid ?? 0;
    if (capacityLease) {
      capacityLease = await bindAsyncCommandCapacityToChild(capacityLease, state.pid, runId, input.kind);
      state.capacity = capacityLease;
    }
  } catch (error) {
    await releaseAsyncCommandCapacity(capacityLease);
    await startLock?.release();
    throw error;
  }
  await writeRunState(workspace, state);
  if (dedupe) {
    await writeDedupeLease(dedupe, state);
  }
  await startLock?.release();
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

  return withDedupeDecision(summarizeState(state), dedupe ? "started_new" : null, dedupe?.leaseRecovered ?? false);
}

export async function getAsyncCommandRunStatus(workspacePath: string, runId: string): Promise<Record<string, unknown>> {
  const workspace = realpathSync(workspacePath);
  let state = await requireRunState(workspace, runId);
  if (!isTerminal(state.status) && Date.now() >= Date.parse(state.deadlineAt)) {
    await terminateProcessTree(state);
    await finalizeRun(state, "timed_out", null, "runtime_limit_exceeded");
    state = await requireRunState(workspace, runId);
  } else if (state.status === "running" && !activeRuns.has(runId) && !(await isProcessRunning(state.pid))) {
    state = await reconcileMissingProcess(workspace, state);
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
    output_limit_reached: state.stdoutTruncated || state.stderrTruncated,
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
function getLeaseRoot(workspace: string): string { return path.join(workspace, ".console-mcp", "command-run-lease"); }
function getLeasePath(workspace: string, operationHash: string): string { return path.join(getLeaseRoot(workspace), `${operationHash}.json`); }

async function writeRunState(workspace: string, state: AsyncCommandRunState): Promise<void> {
  await mkdir(getRunDir(workspace, state.runId), { recursive: true });
  await atomicWriteText(getStatePath(workspace, state.runId), `${JSON.stringify(state, null, 2)}\n`);
}

async function readRunState(workspace: string, runId: string): Promise<AsyncCommandRunState | null> {
  const parsed = await readJsonWithRetry<AsyncCommandRunState>(getStatePath(workspace, runId));


  return parsed?.schemaVersion === 1 && parsed.runId === runId ? parsed : null;
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

type NormalizedDedupe = {
  operationHash: string;
  operationKey: string;
  repositoryFingerprint: string;
  leasePath: string;
  recentResultTtlMs: number;
  reuseSuccessful: boolean;
  leaseTtlMs: number;
  leaseRecovered: boolean;
};

type DedupeLease = {
  schemaVersion: 1;
  operationHash: string;
  operationKey: string;
  repositoryFingerprint: string;
  workspacePath: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeDedupeInput(workspace: string, kind: string, input: AsyncCommandRunDedupeInput): NormalizedDedupe {
  const operationKey = stableStringify({ kind, operationKey: input.operationKey });
  const repositoryFingerprint = input.repositoryFingerprint.trim();
  const operationHash = createHash("sha256")
    .update(stableStringify({ workspace, operationKey, repositoryFingerprint }))
    .digest("hex");
  return {
    operationHash,
    operationKey,
    repositoryFingerprint,
    leasePath: getLeasePath(workspace, operationHash),
    recentResultTtlMs: Math.max(0, Math.min(60 * 60 * 1000, input.recentResultTtlMs ?? 10 * 60 * 1000)),
    reuseSuccessful: input.reuseSuccessful === true,
    leaseTtlMs: Math.max(60 * 1000, Math.min(24 * 60 * 60 * 1000, input.leaseTtlMs ?? retentionMs)),
    leaseRecovered: false,
  };
}

async function resolveDedupeLease(workspace: string, dedupe: NormalizedDedupe): Promise<{ state: AsyncCommandRunState | null; decision: DedupeDecision | null; leaseRecovered: boolean }> {
  const lease = await readDedupeLease(dedupe.leasePath);
  if (!lease) {
    return { state: null, decision: null, leaseRecovered: false };
  }

  if (lease.operationHash !== dedupe.operationHash || lease.workspacePath !== workspace || lease.repositoryFingerprint !== dedupe.repositoryFingerprint) {
    await unlink(dedupe.leasePath).catch(() => undefined);
    dedupe.leaseRecovered = true;
    return { state: null, decision: null, leaseRecovered: true };
  }

  const leaseAgeMs = Date.now() - Date.parse(lease.updatedAt);
  const state = await readRunState(workspace, lease.runId);
  if (!state || leaseAgeMs > dedupe.leaseTtlMs) {
    await unlink(dedupe.leasePath).catch(() => undefined);
    dedupe.leaseRecovered = true;
    return { state: null, decision: null, leaseRecovered: true };
  }

  if (!isTerminal(state.status)) {
    if (state.status === "running" && !activeRuns.has(state.runId) && !(await isProcessRunning(state.pid))) {
      const reconciled = await reconcileMissingProcess(workspace, state);
      if (isTerminal(reconciled.status)) {
        if (reconciled.status === "succeeded" && dedupe.reuseSuccessful && reconciled.finishedAt && Date.now() - Date.parse(reconciled.finishedAt) <= dedupe.recentResultTtlMs) {
          return { state: reconciled, decision: "reused_recent_result", leaseRecovered: false };
        }
        await unlink(dedupe.leasePath).catch(() => undefined);
        dedupe.leaseRecovered = true;
        return { state: null, decision: null, leaseRecovered: true };
      }
      return { state: reconciled, decision: "reused_running", leaseRecovered: false };
    }
    return { state, decision: "reused_running", leaseRecovered: false };
  }

  if (state.status === "succeeded" && dedupe.reuseSuccessful && state.finishedAt && Date.now() - Date.parse(state.finishedAt) <= dedupe.recentResultTtlMs) {
    return { state, decision: "reused_recent_result", leaseRecovered: false };
  }

  await unlink(dedupe.leasePath).catch(() => undefined);
  dedupe.leaseRecovered = true;
  return { state: null, decision: null, leaseRecovered: true };
}

async function readDedupeLease(leasePath: string): Promise<DedupeLease | null> {
  const parsed = await readJsonWithRetry<DedupeLease>(leasePath);
  return parsed?.schemaVersion === 1 && typeof parsed.runId === "string" ? parsed : null;
}

async function writeDedupeLease(dedupe: NormalizedDedupe, state: AsyncCommandRunState): Promise<void> {
  await mkdir(path.dirname(dedupe.leasePath), { recursive: true });
  const now = new Date().toISOString();
  const lease: DedupeLease = {
    schemaVersion: 1,
    operationHash: dedupe.operationHash,
    operationKey: dedupe.operationKey,
    repositoryFingerprint: dedupe.repositoryFingerprint,
    workspacePath: state.workspacePath,
    runId: state.runId,
    createdAt: now,
    updatedAt: now,
  };
  await atomicWriteText(dedupe.leasePath, `${JSON.stringify(lease, null, 2)}\n`);
}

async function acquireDedupeStartLock(workspace: string, dedupe: NormalizedDedupe): Promise<{ release: () => Promise<void>; state?: never; decision?: never; leaseRecovered?: never } | { release?: never; state: AsyncCommandRunState; decision: DedupeDecision; leaseRecovered: boolean }> {
  const lockPath = `${dedupe.leasePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const existing = await resolveDedupeLease(workspace, dedupe);
    if (existing.state) {
      return { state: existing.state, decision: existing.decision ?? "reused_running", leaseRecovered: existing.leaseRecovered };
    }
    try {
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
      return { release: async () => { await unlink(lockPath).catch(() => undefined); } };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isStaleLock(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        dedupe.leaseRecovered = true;
        continue;
      }
      await delay(50);
    }
  }
  await unlink(lockPath).catch(() => undefined);
  dedupe.leaseRecovered = true;
  return { release: async () => { await unlink(lockPath).catch(() => undefined); } };
}

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > 30000;
  } catch {
    return true;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !new Set(["EEXIST", "EPERM"]).has(String((error as NodeJS.ErrnoException).code))) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    await unlink(filePath).catch(() => undefined);
    await rename(tempPath, filePath);
  }
}

async function readJsonWithRetry<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!existsSync(filePath)) {
      if (attempt < 4) {
        await delay(10);
        continue;
      }
      return null;
    }
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === 4) {
        throw error;
      }
      await delay(10);
    }
  }
  return null;
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
  await releaseAsyncCommandCapacity(state.capacity);
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

async function reconcileMissingProcess(workspace: string, state: AsyncCommandRunState): Promise<AsyncCommandRunState> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const refreshed = await requireRunState(workspace, state.runId);
  if (isTerminal(refreshed.status) || activeRuns.has(refreshed.runId) || await isProcessRunning(refreshed.pid)) return refreshed;
  await finalizeRun(refreshed, "failed", refreshed.exitCode, "process_not_running");
  return requireRunState(workspace, refreshed.runId);
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
    output_limit_reached: state.stdoutTruncated || state.stderrTruncated,
    child_timeout: state.status === "timed_out",
    capacity_class: state.capacity?.class ?? null,
    capacity_slot: state.capacity?.slot ?? null,
    capacity_limit: state.capacity?.limit ?? null,
    dedupe_operation_hash: state.dedupe?.operationHash ?? null,
    repository_fingerprint: state.dedupe?.repositoryFingerprint ?? null,
    max_output_bytes_per_stream: maxOutputBytes,
    retention_ms: retentionMs,
  };
}

function isTerminal(status: RunStatus): status is TerminalStatus { return terminalStatuses.includes(status as TerminalStatus); }
function clampTimeout(value: number): number { return Math.max(1000, Math.min(1800000, Math.trunc(value))); }

function withDedupeDecision(state: Record<string, unknown>, decision: DedupeDecision | null, leaseRecovered: boolean): Record<string, unknown> {
  if (!decision) return state;
  return {
    ...state,
    dedupe: {
      decision,
      started_new: decision === "started_new",
      reused_running: decision === "reused_running",
      reused_recent_result: decision === "reused_recent_result",
      stale_lease_recovered: decision === "stale_lease_recovered" || leaseRecovered,
    },
    job_reused: decision === "reused_running" || decision === "reused_recent_result",
    lease_recovered: decision === "stale_lease_recovered" || leaseRecovered,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid && child.pid > 0) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

