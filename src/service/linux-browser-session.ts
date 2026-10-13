import { readdir, readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

type Options = { ports: number[]; healthUrls: string[]; includeBrowserProcesses: boolean; includeListeners: boolean; includeHealthUrls: boolean; includeRawDetails: boolean; timeoutMs: number };

export async function inspectLinuxBrowserSession(options: Options): Promise<Record<string, unknown>> {
  const processes = options.includeBrowserProcesses ? (await Promise.all((await readdir("/proc")).filter(id => /^\d+$/.test(id)).map(async id => {
    try {
      if ((await stat(`/proc/${id}`)).uid !== process.getuid?.()) return null;
      const args = (await readFile(`/proc/${id}/cmdline`, "utf8")).split("\0");
      const name = path.basename(args[0]);
      if (!/^(msedge|chrome|chromium)(-browser|-stable)?$/.test(name)) return null;
      return { pid: Number(id), name, headless: args.some(arg => arg.startsWith("--headless")), child: args.some(arg => arg.startsWith("--type=")) };
    } catch { return null; }
  }))).filter(item => item !== null) : [];
  const listeners = options.includeListeners ? await Promise.all(options.ports.map(port => new Promise<{ port: number; open: boolean }>(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve({ port, open }); };
    socket.setTimeout(Math.min(options.timeoutMs, 1000));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  }))) : [];
  const health = options.includeHealthUrls ? await Promise.all(options.healthUrls.map(async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs), redirect: "error" });
      await response.body?.cancel();
      return { url, ok: response.ok, status_code: response.status };
    } catch { return { url, ok: false, status_code: null }; }
  })) : [];
  const open = listeners.filter(item => item.open).length;
  const healthy = health.filter(item => item.ok).length;
  const result: Record<string, unknown> = {
    ok: true, status: "BROWSER_SESSION_DIAGNOSTIC_READY", platform: "linux", mode: "safe-browser-session-status-readonly",
    summary: { browser_process_count: processes.length, visible_browser_window_count: null, headless_browser_process_count: processes.filter(item => item.headless).length, listener_open_count: open, health_ok_count: healthy },
    browser: { status: processes.length ? "BROWSER_PROCESSES_FOUND" : "BROWSER_PROCESSES_NOT_OBSERVED", process_scope: "current-service-user", process_count: processes.length, visible_window_count: null, has_visible_browser_window: null, visibility_supported: false },
    listeners: { status: listeners.length ? (open ? "LISTENERS_OPEN" : "LISTENERS_CLOSED") : "LISTENERS_NOT_REQUESTED", requested_count: listeners.length, open_count: open, ports: listeners },
    health: { status: health.length ? (healthy === health.length ? "HEALTH_OK" : healthy ? "HEALTH_PARTIAL" : "HEALTH_FAILED") : "HEALTH_NOT_REQUESTED", requested_count: health.length, ok_count: healthy, urls: health },
    diagnostic: { windows_apis_used: false, starts_browser: false, visibility: "not measured; process presence is not window visibility" },
  };
  if (options.includeRawDetails) result.details = { browser_processes: processes };
  return result;
}
