import { connect } from "node:net";

export type DesktopAgentStatus = {
  ok: boolean;
  status: string;
  desktopEligible: boolean;
  visibilityVerified: false;
  userInteractionReady: false;
};

/**
 * Status-only IPC probe. Transport reachability never proves GUI visibility.
 * The system-service caller must have independently authorized socket access.
 */
export async function inspectDesktopSessionAgent(uid: number, timeoutMs = 1000): Promise<DesktopAgentStatus> {
  const unavailable = (status: string): DesktopAgentStatus => ({
    ok: false, status, desktopEligible: false,
    visibilityVerified: false, userInteractionReady: false,
  });
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) return unavailable("DESKTOP_AGENT_INVALID_UID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3000) return unavailable("DESKTOP_AGENT_INVALID_TIMEOUT");

  const path = `/run/user/${uid}/console-mcp-desktop-agent.sock`;
  return new Promise((resolve) => {
    const socket = connect({ path });
    let finished = false;
    let data = "";
    const finish = (result: DesktopAgentStatus) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(unavailable("DESKTOP_AGENT_TIMEOUT")));
    socket.on("error", () => finish(unavailable("DESKTOP_AGENT_UNAVAILABLE")));
    socket.on("connect", () => socket.write("status\n"));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 4096) return finish(unavailable("DESKTOP_AGENT_RESPONSE_INVALID"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const reply: unknown = JSON.parse(data.slice(0, end));
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Invalid reply");
        const body = reply as Record<string, unknown>;
        if (typeof body.ok !== "boolean" || typeof body.status !== "string"
            || body.visibility_verified !== false || body.user_interaction_ready !== false) {
          throw new Error("Untrusted readiness response");
        }
        finish({
          ok: body.ok, status: body.status, desktopEligible: body.ok,
          visibilityVerified: false, userInteractionReady: false,
        });
      } catch {
        finish(unavailable("DESKTOP_AGENT_RESPONSE_INVALID"));
      }
    });
    socket.on("end", () => finish(unavailable("DESKTOP_AGENT_RESPONSE_INCOMPLETE")));
  });
}
