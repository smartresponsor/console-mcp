import { readdir, readFile, readlink, stat } from "node:fs/promises";
const PORT = 9223;
const PROFILE = "/var/lib/console-mcp-browser/edge-profile";
export type BackgroundProof = { ok: boolean; reason: string; browserInstance?: string; targetId?: string; targetUrl?: string };
export async function inspectIsolatedBackground(targetId?: string): Promise<BackgroundProof> {
  try {
    const endpoint = "http://127.0.0.1:" + PORT;
    const versionResponse = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(2000) });
    if (!versionResponse.ok) return { ok: false, reason: "BACKGROUND_CDP_UNAVAILABLE" };
    const version = await versionResponse.json() as { webSocketDebuggerUrl?: string };
    const browserInstance = new URL(version.webSocketDebuggerUrl ?? "").pathname;
    if (!browserInstance.startsWith("/devtools/browser/")) return { ok: false, reason: "BACKGROUND_CDP_INVALID" };
    let targetUrl: string | undefined;
    if (targetId) {
      if (!/^[a-fA-F0-9]{32}$/.test(targetId)) return { ok: false, reason: "BACKGROUND_TARGET_INVALID" };
      const pagesResponse = await fetch(endpoint + "/json/list", { signal: AbortSignal.timeout(2000) });
      if (!pagesResponse.ok) return { ok: false, reason: "BACKGROUND_TARGET_UNAVAILABLE" };
      const pages = await pagesResponse.json() as Array<{ id?: string; type?: string; url?: string }>;
      const page = pages.find(page => page.id === targetId && page.type === "page");
      if (!page) return { ok: false, reason: "BACKGROUND_TARGET_NOT_FOUND" };
      targetUrl = page.url;
    }
    const tables = await Promise.all(["tcp", "tcp6"].map(t => readFile("/proc/net/" + t, "utf8").catch(() => "")));
    const inodes = new Set(tables.flatMap(t => t.split("\n").slice(1).map(l => l.trim().split(/\s+/)).filter(c => c[3] === "0A" && parseInt(c[1]?.split(":")[1], 16) === PORT && c[1]?.startsWith("0100007F:")).map(c => c[9])));
    if (inodes.size !== 1) return { ok: false, reason: "BACKGROUND_SOCKET_UNVERIFIED" };
    let matches = 0;
    for (const id of (await readdir("/proc")).filter(v => /^\d+$/.test(v))) {
      try {
        const cmd = (await readFile("/proc/" + id + "/cmdline", "utf8")).replace(/\0+$/, "");
        const argv = cmd.includes("\0") ? cmd.split("\0") : cmd.split(/\s+/);
        if (!/edge|chromium|chrome/.test(argv[0] ?? "") || argv.some(v => v.startsWith("--type="))) continue;
        if (!argv.includes("--remote-debugging-port=" + PORT) || !argv.includes("--user-data-dir=" + PROFILE)) continue;
        const owner = (await stat("/proc/" + id)).uid;
        if (owner === 0 || owner === 1000) continue;
        const links = await Promise.all((await readdir("/proc/" + id + "/fd")).map(fd => readlink("/proc/" + id + "/fd/" + fd).catch(() => "")));
        if (links.some(link => inodes.has(link.match(/^socket:\[(\d+)\]$/)?.[1] ?? ""))) matches++;
      } catch { /* fail closed if a process cannot be inspected */ }
    }
    return matches === 1 ? { ok: true, reason: "BACKGROUND_ISOLATED_VERIFIED", browserInstance, targetId, targetUrl } : { ok: false, reason: "BACKGROUND_PROCESS_UNVERIFIED" };
  } catch { return { ok: false, reason: "BACKGROUND_PROBE_FAILED" }; }
}
