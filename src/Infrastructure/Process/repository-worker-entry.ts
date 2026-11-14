import { realpathSync } from "node:fs";
import path from "node:path";
import { getAsyncCommandRunStatus, startAsyncCommandRun, type AsyncCommandRunStartInput } from "./AsyncCommandRun.js";

type RepositoryWorkerScope = {
  scopeId: string;
  canonicalName: string;
  workspacePath: string;
  relativeWorkspacePath: string;
};

type WorkerRequest =
  | {
      id: string;
      type: "startAsyncCommandRun";
      correlationId: string | null;
      sentAt: number;
      scope: RepositoryWorkerScope;
      input: AsyncCommandRunStartInput;
    }
  | {
      id: string;
      type: "getAsyncCommandRunStatus";
      correlationId: null;
      sentAt: number;
      scope: RepositoryWorkerScope;
      runId: string;
    };

const workerId = process.env.CMCP_REPOSITORY_WORKER_ID ?? "unknown-worker";
const immutableScopeId = process.env.CMCP_REPOSITORY_SCOPE_ID ?? "";
const immutableWorkspacePath = process.env.CMCP_REPOSITORY_WORKSPACE_PATH ? realpathSync(process.env.CMCP_REPOSITORY_WORKSPACE_PATH) : realpathSync(process.cwd());

process.on("message", async (message: unknown) => {
  const startedAt = Date.now();
  const request = parseRequest(message);
  if (!request.ok) {
    sendResponse({ id: request.id, ok: false, error: request.error, startedAt });
    return;
  }

  try {
    const result = request.value.type === "startAsyncCommandRun"
      ? await startAsyncCommandRun({
          ...request.value.input,
          workspacePath: assertImmutableScope(request.value.scope, request.value.input.workspacePath),
        })
      : await getAsyncCommandRunStatus(assertImmutableScope(request.value.scope, request.value.scope.workspacePath), request.value.runId);
    sendResponse({ id: request.value.id, ok: true, result, startedAt });
  } catch (error) {
    sendResponse({ id: request.value.id, ok: false, error: serializeError(error), startedAt });
  }
});

function parseRequest(message: unknown): { ok: true; value: WorkerRequest } | { ok: false; id: string; error: { name: string; message: string; stack?: string } } {
  const id = message && typeof message === "object" && "id" in message && typeof message.id === "string" ? message.id : "invalid-request";
  if (!message || typeof message !== "object") {
    return { ok: false, id, error: { name: "RepositoryWorkerProtocolError", message: "Repository worker request must be an object." } };
  }
  const candidate = message as Partial<WorkerRequest>;
  if (candidate.type === "startAsyncCommandRun" && typeof candidate.id === "string" && candidate.scope && candidate.input) {
    return { ok: true, value: candidate as WorkerRequest };
  }
  if (candidate.type === "getAsyncCommandRunStatus" && typeof candidate.id === "string" && candidate.scope && typeof candidate.runId === "string") {
    return { ok: true, value: candidate as WorkerRequest };
  }
  return { ok: false, id, error: { name: "RepositoryWorkerProtocolError", message: "Repository worker request is missing required fields." } };
}

function assertImmutableScope(scope: RepositoryWorkerScope, workspacePath: string): string {
  if (scope.scopeId !== immutableScopeId) {
    throw new Error(`Repository worker scope mismatch: expected=${immutableScopeId}, actual=${scope.scopeId}`);
  }
  const scopeWorkspace = realpathSync(scope.workspacePath);
  const inputWorkspace = realpathSync(workspacePath);
  if (!samePath(scopeWorkspace, immutableWorkspacePath) || !samePath(inputWorkspace, immutableWorkspacePath)) {
    throw new Error(`Repository worker workspace mismatch: scope=${scope.relativeWorkspacePath}`);
  }
  if (!samePath(realpathSync(process.cwd()), immutableWorkspacePath)) {
    throw new Error(`Repository worker cwd drift detected: scope=${scope.relativeWorkspacePath}`);
  }
  return immutableWorkspacePath;
}

function sendResponse(input: { id: string; ok: boolean; result?: Record<string, unknown>; error?: { name: string; message: string; stack?: string }; startedAt: number }): void {
  process.send?.({
    id: input.id,
    ok: input.ok,
    result: input.result,
    error: input.error,
    metrics: {
      workerExecutionMs: Date.now() - input.startedAt,
      workerPid: process.pid,
      workerId,
    },
  });
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
