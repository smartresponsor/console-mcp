import net from "node:net";

export type ReleaseOperation = "status" | "prepare" | "validate" | "activate" | "rollback";
export const releaseBrokerSocket = "/run/console-mcp-release/release-broker.sock";
const fullSha = /^[0-9a-f]{40}$/;

export async function requestReleaseBroker(operation: ReleaseOperation, sha?: string, runId?: string): Promise<Record<string, unknown>> {
  if (operation !== "status" && (!sha || !fullSha.test(sha))) {
    return { ok: false, status: "RELEASE_FULL_SHA_REQUIRED" };
  }
  if (runId && !/^[0-9a-f]{32}$/.test(runId)) return { ok: false, status: "RELEASE_RUN_ID_INVALID" };
  const request = JSON.stringify({ version: 1, operation, ...(sha ? { sha } : {}), ...(runId ? { runId } : {}) }) + "\n";
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: releaseBrokerSocket });
    let complete = false;
    let data = "";
    const finish = (value: Record<string, unknown>) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(15000, () => finish({ ok: false, status: "RELEASE_BROKER_TIMEOUT" }));
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > 65536) return finish({ ok: false, status: "RELEASE_BROKER_RESPONSE_TOO_LARGE" });
      const line = data.indexOf("\n");
      if (line !== -1) {
        try {
          const reply: unknown = JSON.parse(data.slice(0, line));
          if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Invalid reply");
          finish(reply as Record<string, unknown>);
        } catch {
          finish({ ok: false, status: "RELEASE_BROKER_RESPONSE_INVALID" });
        }
      }
    });
    socket.on("end", () => finish({ ok: false, status: "RELEASE_BROKER_EMPTY_RESPONSE" }));
    socket.on("error", (err: NodeJS.ErrnoException) => finish({
      ok: false,
      status: err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "RELEASE_BROKER_NOT_CONFIGURED" : "RELEASE_BROKER_UNAVAILABLE",
    }));
  });
}
