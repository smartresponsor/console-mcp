import { spawn } from "node:child_process";
import { platform } from "node:os";

const HELPER = "/opt/console-mcp-deploy/admission-lock.py";
const SHARED_LOCK_MAX_SECONDS = 2700;
const PYTHON = "/usr/bin/python3";

/**
 * Opt-in migration boundary: installed services must set 'required' only after
 * installing the independently reviewed root-owned helper and lock inode.
 * This never represents an active barrier while disabled.
 */
export async function withDeploymentSharedAdmission<T>(operation: () => Promise<T>): Promise<T> {
  const setting = process.env.CONSOLE_MCP_DEPLOYMENT_ADMISSION;
  if (setting === undefined || setting === "disabled") return operation();
  if (setting !== "required" || platform() !== "linux") {
    throw new Error("DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID");
  }
  const helper = spawn(PYTHON, ["-I", HELPER, "shared", "--max-seconds", String(SHARED_LOCK_MAX_SECONDS)], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: { PATH: "/usr/bin:/bin" },
  });
  let acquired = false;
  let closed = false;
  let ended = false;
  let buffer = "";
  let rejection = "";
  const deadline = setTimeout(() => helper.kill("SIGKILL"), 20000);
  try {
    await new Promise<void>((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", () => {
        closed = true;
        if (!acquired) reject(new Error("DEPLOYMENT_ADMISSION_UNAVAILABLE"));
      });
      helper.stderr?.on("data", (chunk: Buffer) => {
        rejection = (rejection + chunk.toString("utf8")).slice(-1024);
      });
      helper.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 4096) {
          reject(new Error("DEPLOYMENT_ADMISSION_PROTOCOL_TOO_LARGE"));
          return;
        }
        const end = buffer.indexOf("\n");
        if (end < 0 || acquired) return;
        try {
          const response = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
          if (response.ok !== true || response.status !== "ADMISSION_LOCKED" || response.mode !== "shared") {
            reject(new Error("DEPLOYMENT_ADMISSION_DENIED"));
            return;
          }
          acquired = true;
          resolve();
        } catch {
          reject(new Error("DEPLOYMENT_ADMISSION_INVALID_HANDSHAKE"));
        }
      });
    });
  } finally {
    clearTimeout(deadline);
    if (!acquired) {
      helper.stdin?.destroy();
      helper.kill("SIGKILL");
    }
  }
  if (closed) throw new Error("DEPLOYMENT_ADMISSION_LOST_BEFORE_OPERATION");
  const guard = new Promise<never>((_, reject) => {
    helper.once("close", () => {
      closed = true;
      if (!ended) reject(new Error("DEPLOYMENT_ADMISSION_LOST_DURING_OPERATION"));
    });
  });
  try {
    return await Promise.race([operation(), guard]);
  } finally {
    ended = true;
    helper.stdin?.end();
    // No process remains intentionally after parent closes stdin.
  }
}
