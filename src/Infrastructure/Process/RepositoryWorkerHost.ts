import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMcpRequestContext, recordRepositoryExecutionObservation } from "../Diagnostics/RequestContext.js";
import type { RepositoryScope } from "../../service/repository-registry.js";
import { buildSafeEnv } from "./ProcessRuntime.js";
import type { AsyncCommandRunStartInput } from "./AsyncCommandRun.js";
import { readRuntimeCapacity, runtimeCapacityAllowsHeavyWork } from "../../service/runtime-capacity.js";

type WorkerRequest = {
  id: string;
  type: "startAsyncCommandRun";
  correlationId: string | null;
  sentAt: number;
  scope: RepositoryWorkerScope;
  input: AsyncCommandRunStartInput;
};

type WorkerResponse = {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string };
  metrics?: {
    workerExecutionMs: number;
    workerPid: number;
    workerId: string;
  };
};

type RepositoryWorkerScope = {
  scopeId: string;
  canonicalName: string;
  workspacePath: string;
  relativeWorkspacePath: string;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  startedAt: number;
  timer: NodeJS.Timeout;
};

type WorkerRecord = {
  workerId: string;
  scope: RepositoryWorkerScope;
  child: ChildProcess;
  pending: Map<string, PendingRequest>;
  createdAt: number;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  dispatchCount: number;
};

const workers = new Map<string, WorkerRecord>();
const idleWorkerTtlMs = 30_000;
const requestTimeoutMs = 30_000;

export type RepositoryWorkerDispatchOptions = {
  enforceRuntimeCapacity?: boolean;
  enforceHeavySemaphore?: boolean;
};

export async function startRepositoryWorkerCommand(scope: RepositoryScope, input: AsyncCommandRunStartInput, options: RepositoryWorkerDispatchOptions = {}): Promise<Record<string, unknown>> {
  if (options.enforceRuntimeCapacity !== false) {
    const capacity = readRuntimeCapacity(resolveConsoleProjectRoot());
    if (!runtimeCapacityAllowsHeavyWork(capacity)) {
      return {
        ok: false,
        status: "REPOSITORY_WORKER_WAITING_RUNTIME_CAPACITY",
        capacity_class: "heavy",
        capacity,
        starts_process: false,
        retry_after_ms: 30000,
      };
    }
  }
  const canonicalScope = freezeRepositoryWorkerScope(scope);
  const inputWorkspace = realpathSync(input.workspacePath);
  if (!samePath(inputWorkspace, canonicalScope.workspacePath)) {
    throw new Error(`Repository worker dispatch workspace mismatch: scope=${canonicalScope.relativeWorkspacePath}, input=${input.workspacePath}`);
  }

  const gatewayStartedAt = Date.now();
  const worker = ensureWorker(canonicalScope);
  const workerReused = worker.dispatchCount > 0;
  worker.dispatchCount += 1;
  worker.lastUsedAt = Date.now();
  clearIdleTimer(worker);

  const id = randomUUID();
  const correlationId = getMcpRequestContext()?.correlationId ?? null;
  const request: WorkerRequest = {
    id,
    type: "startAsyncCommandRun",
    correlationId,
    sentAt: Date.now(),
    scope: canonicalScope,
    input: {
      ...input,
      workspacePath: canonicalScope.workspacePath,
      capacity: options.enforceHeavySemaphore === false ? input.capacity : { class: "heavy", rootPath: resolveConsoleProjectRoot() },
    },
  };

  const result = await sendWorkerRequest(worker, request);
  scheduleIdleRetirement(worker);
  const gatewayElapsedMs = Date.now() - gatewayStartedAt;
  const workerMetrics = result.__repository_worker_metrics as Record<string, unknown> | undefined;
  delete result.__repository_worker_metrics;

  recordRepositoryExecutionObservation({
    cwd: canonicalScope.workspacePath,
    command: String(input.command),
    elapsedMs: gatewayElapsedMs,
    dispatchMs: Number(workerMetrics?.dispatch_ms ?? gatewayElapsedMs),
    exitCode: null,
  });

  return {
    ...result,
    repository_worker: {
      scope_id: canonicalScope.scopeId,
      canonical_name: canonicalScope.canonicalName,
      relative_workspace_path: canonicalScope.relativeWorkspacePath,
      worker_id: worker.workerId,
      worker_pid: worker.child.pid ?? null,
      worker_created: workerReused ? false : true,
      worker_reused: workerReused,
      gateway_elapsed_ms: gatewayElapsedMs,
      dispatch_ms: workerMetrics?.dispatch_ms ?? null,
      worker_execution_ms: workerMetrics?.worker_execution_ms ?? null,
    },
  };
}

export function getRepositoryWorkerSnapshot(): Array<Record<string, unknown>> {
  return Array.from(workers.values()).map((worker) => ({
    worker_id: worker.workerId,
    pid: worker.child.pid ?? null,
    scope_id: worker.scope.scopeId,
    canonical_name: worker.scope.canonicalName,
    relative_workspace_path: worker.scope.relativeWorkspacePath,
    pending_requests: worker.pending.size,
    age_ms: Date.now() - worker.createdAt,
    idle_ms: Date.now() - worker.lastUsedAt,
    connected: worker.child.connected,
    exit_code: worker.child.exitCode,
    signal_code: worker.child.signalCode,
  }));
}

function ensureWorker(scope: RepositoryWorkerScope): WorkerRecord {
  const existing = workers.get(scope.scopeId);
  if (existing && existing.child.connected && existing.child.exitCode === null) {
    return existing;
  }
  if (existing) {
    workers.delete(scope.scopeId);
  }

  const workerId = randomUUID();
  const child = fork(getWorkerEntryPath(), [], {
    cwd: scope.workspacePath,
    env: {
      ...buildSafeEnv(),
      CMCP_REPOSITORY_WORKER_ID: workerId,
      CMCP_REPOSITORY_SCOPE_ID: scope.scopeId,
      CMCP_REPOSITORY_WORKSPACE_PATH: scope.workspacePath,
    },
    execArgv: [],
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });

  const record: WorkerRecord = {
    workerId,
    scope,
    child,
    pending: new Map(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    idleTimer: null,
    dispatchCount: 0,
  };

  child.on("message", (message) => handleWorkerMessage(record, message));
  child.once("exit", (code, signal) => {
    workers.delete(scope.scopeId);
    clearIdleTimer(record);
    const error = new Error(`Repository worker exited: scope=${scope.scopeId} pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`);
    rejectPending(record, error);
  });
  child.once("error", (error) => {
    workers.delete(scope.scopeId);
    clearIdleTimer(record);
    rejectPending(record, error);
  });

  workers.set(scope.scopeId, record);
  return record;
}

function sendWorkerRequest(worker: WorkerRecord, request: WorkerRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(request.id);
      reject(new Error(`Repository worker request timed out: scope=${worker.scope.scopeId} worker=${worker.workerId}`));
    }, requestTimeoutMs);
    timer.unref();
    worker.pending.set(request.id, { resolve, reject, startedAt: Date.now(), timer });
    const sent = worker.child.send(request);
    if (!sent) {
      clearTimeout(timer);
      worker.pending.delete(request.id);
      reject(new Error(`Repository worker IPC send failed: scope=${worker.scope.scopeId} worker=${worker.workerId}`));
      return;
    }
  });
}

function handleWorkerMessage(worker: WorkerRecord, message: unknown): void {
  if (!message || typeof message !== "object" || !("id" in message)) return;
  const response = message as WorkerResponse;
  const pending = worker.pending.get(response.id);
  if (!pending) return;
  worker.pending.delete(response.id);
  clearTimeout(pending.timer);
  const dispatchMs = Date.now() - pending.startedAt;
  if (!response.ok) {
    const error = new Error(response.error?.message ?? "Repository worker request failed.");
    error.name = response.error?.name ?? "RepositoryWorkerError";
    pending.reject(error);
    return;
  }
  pending.resolve({
    ...(response.result ?? {}),
    __repository_worker_metrics: {
      dispatch_ms: dispatchMs,
      worker_execution_ms: response.metrics?.workerExecutionMs ?? null,
      worker_pid: response.metrics?.workerPid ?? null,
      worker_id: response.metrics?.workerId ?? worker.workerId,
    },
  });
}

function rejectPending(worker: WorkerRecord, error: Error): void {
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  worker.pending.clear();
}

function scheduleIdleRetirement(worker: WorkerRecord): void {
  clearIdleTimer(worker);
  worker.idleTimer = setTimeout(() => {
    if (worker.pending.size === 0) {
      workers.delete(worker.scope.scopeId);
      worker.child.disconnect();
      setTimeout(() => {
        if (worker.child.exitCode === null) worker.child.kill();
      }, 1000).unref();
    }
  }, idleWorkerTtlMs);
  worker.idleTimer.unref();
}

function clearIdleTimer(worker: WorkerRecord): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
}

function freezeRepositoryWorkerScope(scope: RepositoryScope): RepositoryWorkerScope {
  return {
    scopeId: scope.scopeId,
    canonicalName: scope.canonicalName,
    workspacePath: realpathSync(scope.workspacePath),
    relativeWorkspacePath: scope.relativeWorkspacePath,
  };
}

function getWorkerEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "repository-worker-entry.js");
}

function resolveConsoleProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
