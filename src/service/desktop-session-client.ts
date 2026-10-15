
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

  try {
    const { execFile } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { randomUUID } = await import("node:crypto");
    if (uid !== 1000) return unavailable("DESKTOP_AGENT_INVALID_UID");
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("/usr/bin/python3", [fileURLToPath(new URL("../../ops/ubuntu/script/desktop-agent-client.py", import.meta.url))],
        { timeout: timeoutMs, maxBuffer: 65536 }, (error, output) => error ? reject(error) : resolve(output));
      child.stdin?.end(JSON.stringify({ version: 1, operation: "status", requestId: randomUUID() }));
    });
    const body = JSON.parse(stdout);
    const eligible = body.ok === true && body.status === "DESKTOP_SESSION_ELIGIBLE";
    return { ok: eligible, status: body.status, desktopEligible: eligible, visibilityVerified: false, userInteractionReady: false };
  } catch { return unavailable("DESKTOP_AGENT_UNAVAILABLE"); }
}
