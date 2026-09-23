import { AsyncLocalStorage } from "node:async_hooks";

export type RepositoryExecutionObservation = {
  cwd: string;
  command: string;
  elapsedMs: number;
  dispatchMs: number;
  exitCode: number | null;
};

export type McpRequestContextState = {
  correlationId: string;
  repositoryExecutions: RepositoryExecutionObservation[];
};

const storage = new AsyncLocalStorage<McpRequestContextState>();

export function runWithMcpRequestContext<T>(correlationId: string, run: () => Promise<T>): Promise<T> {
  return storage.run({ correlationId, repositoryExecutions: [] }, run);
}

export function recordRepositoryExecutionObservation(observation: RepositoryExecutionObservation): void {
  const context = storage.getStore();
  if (!context) {
    return;
  }

  context.repositoryExecutions.push(observation);
}

export function getMcpRequestContext(): McpRequestContextState | null {
  return storage.getStore() ?? null;
}
