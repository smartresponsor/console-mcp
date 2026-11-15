/**
 * Canonical Console MCP SSH adapter. No user-supplied host, credentials or CLI.
 * Python Scrapli worker is separate protocol engine, not another MCP runtime.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PYTHON = process.platform === "win32"
  ? "C:\\ProgramData\\ConsoleMCP\\network-ssh\\Scripts\\python.exe"
  : "/opt/console-mcp-network/venv/bin/python3";
const SCRIPT = fileURLToPath(new URL("../../tool/network-ssh-scrapli-worker.py", import.meta.url));
const MAX_STDOUT = 16384;
const TIMEOUT_MS = 25000;

type Observation = "version" | "interfaces" | "neighbors";
type Result = { ok: boolean; status: string; targetId?: string; observation?: string; output?: string; truncated?: boolean };

export async function inspectSshCapability(): Promise<{
  ok: true; status: string; engine: string; targetPolicy: string; authorizedTargets: string;
  configured: boolean; reason?: string;
}> {
  try {
    await Promise.all([access(PYTHON), access(SCRIPT)]);
  } catch {
    return {
      ok: true, status: "SSH_ENGINE_UNAVAILABLE", engine: "scrapli",
      targetPolicy: "administrator-managed fixed inventory",
      authorizedTargets: "never supplied by ChatGPT", configured: false,
      reason: "PROVISIONING_REQUIRED",
    };
  }
  return {
    ok: true, status: "SSH_ENGINE_PRESENT", engine: "scrapli",
    targetPolicy: "administrator-managed fixed inventory",
    authorizedTargets: "never supplied by ChatGPT", configured: true,
  };
}

export async function inspectSshDevice(
  targetId: string, observation: Observation,
): Promise<Result> {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(targetId) ||
      !["version", "interfaces", "neighbors"].includes(observation)) {
    return { ok: false, status: "SSH_REQUEST_INVALID" };
  }
  try {
    await Promise.all([access(PYTHON), access(SCRIPT)]);
  } catch {
    return { ok: false, status: "SSH_ENGINE_UNAVAILABLE" };
  }
  return await new Promise<Result>((resolve) => {
    let complete = false;
    let stdout = "";
    let bytes = 0;
    const child = spawn(PYTHON, ["-I", "-B", SCRIPT], {
      stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true,
      env: { PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
        PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    const finish = (result: Result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, status: "SSH_DIAGNOSTIC_DEADLINE_EXCEEDED" });
    }, TIMEOUT_MS);
    child.on("error", () => finish({ ok: false, status: "SSH_ENGINE_START_FAILED" }));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT) {
        child.kill("SIGKILL");
        finish({ ok: false, status: "SSH_RESPONSE_TOO_LARGE" });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (complete) return;
      if (code !== 0) {
        finish({ ok: false, status: "SSH_WORKER_FAILED" });
        return;
      }
      try {
        const result: unknown = JSON.parse(stdout);
        if (!result || typeof result !== "object" || Array.isArray(result) ||
            typeof (result as { ok?: unknown }).ok !== "boolean" ||
            typeof (result as { status?: unknown }).status !== "string") {
          throw new Error("worker schema");
        }
        finish(result as Result);
      } catch {
        finish({ ok: false, status: "SSH_WORKER_RESULT_INVALID" });
      }
    });
    child.stdin.on("error", () => { /* handled by child close/error */ });
    child.stdin.end(JSON.stringify({ targetId, observation }));
  });
}
