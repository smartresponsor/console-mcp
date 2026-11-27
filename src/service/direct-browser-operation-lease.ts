import { existsSync } from "node:fs";
import { inspectIsolatedCdpSocket } from "./isolated-cdp-socket-proof.js";
import { withVisibleProcessLease } from "./visible-browser-process-lock.js";

const endpoint = "http://127.0.0.1:9223";
type Identity = { key: string; pid: number; started: string };
async function prove(): Promise<Identity> {
  const before = await inspectIsolatedCdpSocket();
  if (!before.ok) throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_UNAVAILABLE");
  const response = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(2000), redirect: "error" });
  if (!response.ok) throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_UNAVAILABLE");
  const body = await response.json() as { webSocketDebuggerUrl?: string };
  const url = new URL(body.webSocketDebuggerUrl ?? "");
  if (url.origin !== "ws://127.0.0.1:9223" || !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(url.pathname) ||
      url.username || url.password || url.search || url.hash) throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_UNAVAILABLE");
  const after = await inspectIsolatedCdpSocket();
  if (!after.ok || before.pid !== after.pid || before.started !== after.started)
    throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_CHANGED");
  return { key: JSON.stringify([endpoint,url.pathname]), pid: after.pid, started: after.started };
}
function same(a: Identity, b: Identity) { return a.key === b.key && a.pid === b.pid && a.started === b.started; }

// Opt-in rollout: all callers that can reach isolated port 9223 participate.
// Acquire before the operation, not merely around a single CDP command.
export async function withDirectBrowserOperationLease<T>(ports: number[] | undefined, run: () => Promise<T>, identity = prove): Promise<T> {
  if (process.platform !== "linux" || (ports && ports.length && !ports.includes(9223))) return run();
  if (process.env.CONSOLE_MCP_VISIBLE_OS_LEASES !== "required") {
    if (existsSync("/run/console-mcp-browser-leases")) throw new Error("DIRECT_BROWSER_LEASE_CONFIGURATION_REQUIRED");
    return run();
  }
  const before = await identity();
  return withVisibleProcessLease(before.key, async () => {
    if (!same(before, await identity())) throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_CHANGED");
    const result = await run();
    if (!same(before, await identity())) throw new Error("DIRECT_BROWSER_LEASE_IDENTITY_CHANGED");
    return result;
  });
}
