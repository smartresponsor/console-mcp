import path from "node:path";
import { realpathSync } from "node:fs";
import { isOwnerManagedGitPath } from "./GitOwnershipContract.js";

/** Admission, not a sandbox. Opt-in only; generic programs never inherit owner authority. */
export function managedExecutionRouting(cwd: string): boolean {
  if (process.platform !== "linux" || process.env.CONSOLE_MCP_REPO_OWNER_ROUTING !== "1") return false;
  return isOwnerManagedGitPath(cwd) || isOwnerManagedGitPath(realpathSync(path.resolve(cwd)));
}

export function assertManagedExecutionAdmission(cwd: string, command: string, asynchronous = false): void {
  if (!managedExecutionRouting(cwd)) return;
  // Async workers also create logs, leases and run metadata inside the checkout.
  // Until a separate output/worker namespace is available, even async Git is held.
  if (asynchronous) throw new Error("MANAGED_ASYNC_EXECUTION_ISOLATION_REQUIRED");
  if (command !== "git") throw new Error("MANAGED_INDIRECT_WRITER_ISOLATION_REQUIRED");
}
