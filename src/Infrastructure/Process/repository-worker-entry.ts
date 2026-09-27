import { realpathSync } from "node:fs";
import path from "node:path";
import { startAsyncCommandRun, type AsyncCommandRunStartInput } from "./AsyncCommandRun.js";

type RepositoryWorkerScope = {
  scopeId: string;
  canonicalName: string;
  workspacePath: string;
  relativeWorkspacePath: string;
};

type WorkerRequest = {
  id: string;
  type: "startAsyncCommandRun";
  correlationId: string | null;
  sentAt: number;
  scope: RepositoryWorkerScope;
  input: AsyncCommandRunStartInput;
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
    assertImmutableScope(request.value.scope, request.value.input);
    const result = await startAsyncCommandRun({
      ...request.value.input,
      workspacePath: immutableWorkspacePath,
    });
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
  if (candidate.type !== "startAsyncCommandRun" || typeof candidate.id !== "string" || !candidate.scope || !candidate.input) {
    return { ok: false, id, error: { name: "RepositoryWorkerProtocolError", message: "Repository worker request is missing required fields." } };
  }
  return { ok: true, value: candidate as WorkerRequest };
}

function assertImmutableScope(scope: RepositoryWorkerScope, input: AsyncCommandRunStartInput): void {
  if (scope.scopeId !== immutableScopeId) {
    throw new Error(`Repository worker scope mismatch: expected=${immutableScopeId}, actual=${scope.scopeId}`);
  }
  const scopeWorkspace = realpathSync(scope.workspacePath);
  const inputWorkspace = realpathSync(input.workspacePath);
  if (!samePath(scopeWorkspace, immutableWorkspacePath) || !samePath(inputWorkspace, immutableWorkspacePath)) {
    throw new Error(`Repository worker workspace mismatch: scope=${scope.relativeWorkspacePath}`);
  }
  if (!samePath(realpathSync(process.cwd()), immutableWorkspacePath)) {
    throw new Error(`Repository worker cwd drift detected: scope=${scope.relativeWorkspacePath}`);
  }
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
