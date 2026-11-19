import { spawn } from "node:child_process";
import { platform } from "node:os";

const HELPER = "/opt/console-mcp-deploy/admission-lock.py";
const SHARED_LOCK_MAX_SECONDS = 2700;
const PYTHON = "/usr/bin/python3";

type AdmissionFrame = { ok: true; status: string; mode?: string; nonce?: string };

/**
 * Opt-in deployment admission. The root-controller must check durable
 * in-flight markers while holding exclusive flock. A crashed helper never
 * clears its marker, even when the JavaScript callback is still executing.
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
  let closed = false;
  let pending = "";
  let responseFrames: Array<AdmissionFrame> = [];
  let reader: ((value: AdmissionFrame) => void) | null = null;
  let readerFailure: ((error: Error) => void) | null = null;
  let failed: Error | null = null;

  const error = (cause: Error) => {
    failed = cause;
    readerFailure?.(cause);
    reader = null;
    readerFailure = null;
  };
  helper.on("error", () => error(new Error("DEPLOYMENT_ADMISSION_HELPER_ERROR")));
  helper.on("close", () => {
    closed = true;
    error(new Error("DEPLOYMENT_ADMISSION_HELPER_LOST_FENCE_RETAINED"));
  });
  helper.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    if (pending.length > 4096) return error(new Error("DEPLOYMENT_ADMISSION_PROTOCOL_TOO_LARGE"));
    while (pending.includes("\n")) {
      const pos = pending.indexOf("\n");
      const frame = pending.slice(0, pos);
      pending = pending.slice(pos + 1);
      try {
        const parsed = JSON.parse(frame) as AdmissionFrame;
        if (parsed.ok !== true || typeof parsed.status !== "string") throw new Error("bad-frame");
        if (reader) {
          const resolve = reader;
          reader = null;
          readerFailure = null;
          resolve(parsed);
        } else {
          responseFrames.push(parsed);
        }
      } catch {
        return error(new Error("DEPLOYMENT_ADMISSION_INVALID_HANDSHAKE"));
      }
    }
  });
  const nextFrame = async (timeoutMs: number): Promise<AdmissionFrame> => {
    if (failed) throw failed;
    if (responseFrames.length) return responseFrames.shift()!;
    return new Promise<AdmissionFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reader = null;
        readerFailure = null;
        reject(new Error("DEPLOYMENT_ADMISSION_RESPONSE_TIMEOUT"));
      }, timeoutMs);
      reader = (frame) => { clearTimeout(timeout); resolve(frame); };
      readerFailure = (cause) => { clearTimeout(timeout); reject(cause); };
    });
  };

  let acquired = false;
  let nonce = "";
  try {
    const hello = await nextFrame(20000);
    if (hello.status !== "ADMISSION_LOCKED" || hello.mode !== "shared"
        || typeof hello.nonce !== "string" || !/^[a-f0-9]{48}$/.test(hello.nonce)) {
      throw new Error("DEPLOYMENT_ADMISSION_INVALID_HANDSHAKE");
    }
    acquired = true;
    nonce = hello.nonce;
    if (closed || failed) throw new Error("DEPLOYMENT_ADMISSION_HELPER_LOST_FENCE_RETAINED");

    let result: T | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    try {
      // Do NOT race the operation against helper death: a Promise.race rejection
      // leaves the callback alive. Its durable fence MUST remain intact.
      result = await operation();
    } catch (cause) {
      callbackFailed = true;
      callbackError = cause;
    }
    if (closed || failed) throw new Error("DEPLOYMENT_ADMISSION_HELPER_LOST_FENCE_RETAINED");
    // A rejected callback may have spawned an untracked detached child before
    // throwing. Even a caller-side cleanup error must not clear the fence.
    // Only an explicitly successful critical section can acknowledge release.
    if (callbackFailed) throw callbackError;
    // Callback has settled successfully. Explicit release removes the marker
    // while shared flock is still held; EOF/crash never removes the marker.
    helper.stdin?.write("RELEASE " + nonce + "\n");
    const released = await nextFrame(20000);
    if (released.status !== "ADMISSION_RELEASED" || released.nonce !== nonce) {
      throw new Error("DEPLOYMENT_ADMISSION_RELEASE_NOT_ACKNOWLEDGED");
    }
    if (callbackFailed) throw callbackError;
    return result as T;
  } finally {
    // No implicit release. If the handshake failed the orphan fence remains
    // and privileged validation must refuse until independent reconciliation.
    helper.stdin?.end();
    if (!acquired || failed) helper.kill("SIGKILL");
  }
}
