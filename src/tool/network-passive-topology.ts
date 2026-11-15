/**
 * Local, passive Linux L3 route and ARP snapshots.
 * No subprocess, network socket, packet, DNS lookup or credential access.
 * /proc snapshots are kernel-maintained observations, not active discovery.
 */
import { open } from "node:fs/promises";
import { platform } from "node:os";
import { inspectWindowsNetworkSnapshot } from "./network-windows-topology.js";

const MAX_BYTES = 131072;
const MAX_ROWS = 128;
const DEV = /^[A-Za-z0-9_.:-]{1,64}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const HEX32 = /^[0-9a-fA-F]{8}$/;

type Route = { interface: string; destination: string; gateway: string; mask: string; flags: number; metric: number };
type Neighbor = { interface: string; ip: string; mac: string | null; flags: number; state: "resolved" | "incomplete" };

function littleEndianIpv4(raw: string): string | null {
  if (!HEX32.test(raw)) return null;
  const bytes = raw.match(/../g);
  if (!bytes) return null;
  return bytes.reverse().map((pair) => parseInt(pair, 16)).join(".");
}

function validIpv4(ip: string): boolean {
  return IPV4.test(ip) && ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

export function parseLinuxRoutes(input: string): { routes: Route[]; truncated: boolean; discarded: number } {
  const lines = input.split(/\r?\n/).slice(1).filter((line) => line.trim() !== "");
  const routes: Route[] = [];
  let discarded = 0;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 11 || !DEV.test(fields[0])) { discarded++; continue; }
    const [dev, dst, gw, flags, , , metric, mask] = fields;
    if (!HEX32.test(flags) && !/^[0-9a-fA-F]{1,4}$/.test(flags)) { discarded++; continue; }
    const destination = littleEndianIpv4(dst);
    const gateway = littleEndianIpv4(gw);
    const netmask = littleEndianIpv4(mask);
    const flagsValue = Number.parseInt(flags, 16);
    const metricValue = Number(metric);
    if (destination === null || gateway === null || netmask === null ||
        !/^\d{1,10}$/.test(metric) || !Number.isSafeInteger(metricValue) ||
        !Number.isSafeInteger(flagsValue)) { discarded++; continue; }
    if (routes.length < MAX_ROWS) routes.push({
      interface: dev, destination, gateway, mask: netmask, flags: flagsValue, metric: metricValue,
    });
  }
  return { routes, truncated: lines.length - discarded > MAX_ROWS, discarded };
}

export function parseLinuxArp(input: string): { neighbors: Neighbor[]; truncated: boolean; discarded: number } {
  const lines = input.split(/\r?\n/).slice(1).filter((line) => line.trim() !== "");
  const neighbors: Neighbor[] = [];
  let discarded = 0;
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !validIpv4(fields[0]) || !DEV.test(fields[5]) ||
        !/^0x[0-9a-fA-F]{1,8}$/.test(fields[2])) { discarded++; continue; }
    const flags = Number.parseInt(fields[2].slice(2), 16);
    if (!Number.isSafeInteger(flags)) { discarded++; continue; }
    const resolved = (flags & 0x2) !== 0 && MAC.test(fields[3]) && fields[3] !== "00:00:00:00:00:00";
    if (neighbors.length < MAX_ROWS) neighbors.push({
      ip: fields[0], interface: fields[5], mac: resolved ? fields[3].toLowerCase() : null,
      flags, state: resolved ? "resolved" : "incomplete",
    });
  }
  return { neighbors, truncated: lines.length - discarded > MAX_ROWS, discarded };
}

async function boundedRead(file: string): Promise<string> {
  // Kernel pseudo-files report size 0: read at most MAX_BYTES+1 bytes
  // rather than loading arbitrary kernel table sizes into process memory.
  const fd = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_BYTES) {
      const part = Buffer.allocUnsafe(Math.min(8192, MAX_BYTES + 1 - total));
      const result = await fd.read(part, 0, part.length, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      chunks.push(part.subarray(0, result.bytesRead));
    }
    if (total > MAX_BYTES) throw new Error("KERNEL_SNAPSHOT_TOO_LARGE");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await fd.close();
  }
}

export async function inspectHostRoutes(): Promise<{
  ok: boolean; platform: string; source: string; reason?: string; truncated: boolean;
  discarded: number; routes: Route[];
}> {
  const osName = platform();
  if (osName === "win32") return await inspectWindowsNetworkSnapshot("routes") as Awaited<ReturnType<typeof inspectHostRoutes>>;
  if (osName !== "linux") return { ok: false, platform: osName, source: "unsupported",
    reason: "ROUTE_SNAPSHOT_UNSUPPORTED_ON_PLATFORM", truncated: false, discarded: 0, routes: [] };
  try {
    const data = parseLinuxRoutes(await boundedRead("/proc/net/route"));
    return { ok: true, platform: osName, source: "/proc/net/route", ...data };
  } catch {
    return { ok: false, platform: osName, source: "/proc/net/route",
      reason: "ROUTE_SNAPSHOT_UNAVAILABLE", truncated: false, discarded: 0, routes: [] };
  }
}

export async function inspectHostNeighbors(): Promise<{
  ok: boolean; platform: string; source: string; reason?: string; truncated: boolean;
  discarded: number; neighbors: Neighbor[];
}> {
  const osName = platform();
  if (osName === "win32") return await inspectWindowsNetworkSnapshot("neighbors") as Awaited<ReturnType<typeof inspectHostNeighbors>>;
  if (osName !== "linux") return { ok: false, platform: osName, source: "unsupported",
    reason: "ARP_SNAPSHOT_UNSUPPORTED_ON_PLATFORM", truncated: false, discarded: 0, neighbors: [] };
  try {
    const data = parseLinuxArp(await boundedRead("/proc/net/arp"));
    return { ok: true, platform: osName, source: "/proc/net/arp", ...data };
  } catch {
    return { ok: false, platform: osName, source: "/proc/net/arp",
      reason: "ARP_SNAPSHOT_UNAVAILABLE", truncated: false, discarded: 0, neighbors: [] };
  }
}
