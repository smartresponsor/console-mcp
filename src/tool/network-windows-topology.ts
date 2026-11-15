/**
 * Windows native passive IPv4 L3 snapshots via fixed audited PowerShell script.
 * No user supplied args, paths or commands; no network packets or modifications.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../tool/network-windows-snapshot.ps1", import.meta.url));
const MAX_OUTPUT = 131072;
const LIMIT_MS = 15000;
const MAX_ROWS = 128;
const IPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAC = /^(?:[a-f0-9]{2}[:-]){5}[a-f0-9]{2}$/i;
const Alias = /^[^\r\n\u0000-\u001f]{1,128}$/;

const validIp = (ip: unknown): ip is string => typeof ip === "string" && IPv4.test(ip) &&
  ip.split(".").every((v) => Number(v) <= 255 && Number(v) >= 0);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseWindowsSnapshot(raw: unknown, kind: "routes" | "neighbors") {
  const obj = asObject(raw);
  if (!obj || obj.ok !== true || obj.kind !== kind ||
      !Array.isArray(obj.rows) || obj.rows.length > MAX_ROWS || typeof obj.truncated !== "boolean") {
    return { ok: false, status: "WINDOWS_NETWORK_SNAPSHOT_INVALID", kind };
  }
  const output: Record<string, unknown>[] = [];
  let discarded = 0;
  for (const entry of obj.rows) {
    const row = asObject(entry);
    if (!row) { discarded++; continue; }
    const name = row.InterfaceAlias;
    if (typeof name !== "string" || !Alias.test(name)) { discarded++; continue; }
    if (kind === "routes") {
      const prefix = row.DestinationPrefix;
      const nextHop = row.NextHop;
      const metric = row.RouteMetric;
      if (typeof prefix !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix) ||
          !validIp(prefix.split("/")[0]) || !validIp(nextHop) ||
          !Number.isSafeInteger(metric) || (metric as number) < 0) {
        discarded++; continue;
      }
      output.push({ interface: name, destinationPrefix: prefix, gateway: nextHop, metric });
    } else {
      const ip = row.IPAddress;
      const state = row.State;
      const mac = row.LinkLayerAddress;
      if (!validIp(ip) || typeof state !== "string" || !/^[A-Za-z]{2,24}$/.test(state) ||
          (typeof mac !== "string" && mac !== null)) {
        discarded++; continue;
      }
      const resolved = typeof mac === "string" && MAC.test(mac) && !/^(?:00[:-]){5}00$/i.test(mac);
      output.push({ interface: name, ip, mac: resolved ? (mac as string).replaceAll("-", ":").toLowerCase() : null,
        state: resolved ? "resolved" : "incomplete", kernelState: state });
    }
  }
  return kind === "routes"
    ? { ok: true, platform: "win32", source: "Get-NetRoute", truncated: obj.truncated, discarded, routes: output }
    : { ok: true, platform: "win32", source: "Get-NetNeighbor", truncated: obj.truncated, discarded, neighbors: output };
}

export async function inspectWindowsNetworkSnapshot(kind: "routes" | "neighbors"): Promise<Record<string, unknown>> {
  if (process.platform !== "win32") {
    return { ok: false, platform: process.platform, reason: "WINDOWS_ONLY" };
  }
  return await new Promise<Record<string, unknown>>((resolve) => {
    let finished = false;
    let bytes = 0;
    let stdout = "";
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", SCRIPT, "-Kind", kind], {
      shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finish = (value: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, platform: "win32", reason: "WINDOWS_NETWORK_SNAPSHOT_TIMEOUT" });
    }, LIMIT_MS);
    child.on("error", () => finish({ ok: false, platform: "win32", reason: "WINDOWS_POWERSHELL_UNAVAILABLE" }));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish({ ok: false, platform: "win32", reason: "WINDOWS_NETWORK_OUTPUT_TOO_LARGE" });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (finished) return;
      if (code !== 0) {
        finish({ ok: false, platform: "win32", reason: "WINDOWS_NETWORK_SNAPSHOT_FAILED" });
        return;
      }
      try {
        const data: unknown = JSON.parse(stdout);
        const obj = asObject(data);
        if (obj?.ok === false) {
          finish({ ok: false, platform: "win32", reason: "WINDOWS_NETWORK_SNAPSHOT_UNAVAILABLE" });
          return;
        }
        finish(parseWindowsSnapshot(data, kind));
      } catch {
        finish({ ok: false, platform: "win32", reason: "WINDOWS_NETWORK_SNAPSHOT_INVALID" });
      }
    });
  });
}
