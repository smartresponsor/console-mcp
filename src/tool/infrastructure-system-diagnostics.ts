import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { classifyCommandFailure } from "./infrastructure-failure-contract.js";

// Internal Linux-only implementation. No MCP registration or admission in this iteration.
const target = z.object({ targetId: z.literal("local") }).strict();
export const memoryStatusInput = target;
export const processDetailInput = target.extend({ pid: z.number().int().min(1).max(4194304) }).strict();
export const serviceStatusInput = target.extend({
  serviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/),
}).strict();
export const journalRecordsInput = target.extend({
  serviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/).optional(),
  minutes: z.number().int().min(1).max(60).default(15),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();

type Status = "complete" | "partial" | "unavailable" | "unsupported" | "permission_denied" | "timeout" | "no_data";
type Evidence = {
  ok: boolean;
  status: Status;
  targetId: "local";
  vantage: "local";
  collectedAt: string;
  source: string;
  data: Record<string, unknown>;
  warnings: string[];
  truncated: boolean;
};

function evidence(source: string, data: Record<string, unknown>, status: Status = "complete", warnings: string[] = [], truncated = false): Evidence {
  return { ok: status === "complete" || status === "partial", status, targetId: "local",
    vantage: "local", collectedAt: new Date().toISOString(), source, data, warnings, truncated };
}
function linuxOnly(source: string): Evidence | null {
  return process.platform === "linux" ? null : evidence(source, {}, "unsupported", ["unsupported platform"]);
}
async function command(executable: string, args: string[], source: string, maxBytes = 65536): Promise<{ stdout: string } | { failure: Evidence }> {
  const result = await runSupervisedCommand(process.cwd(), executable, args, 10000, maxBytes);
  if (!result.ok) { const failure=classifyCommandFailure(result); return { failure: evidence(source, {}, failure.status, [failure.warning]) }; }
  return { stdout: result.stdout };
}

export function parseMemoryInfo(stdout: string): Record<string, number> {
  const allowed = new Set(["MemTotal", "MemAvailable", "MemFree", "SwapTotal", "SwapFree", "Buffers", "Cached"]);
  const entries: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s+(\d+)\s+kB$/.exec(line.trim());
    if (m && allowed.has(m[1])) entries[m[1]] = Number(m[2]) * 1024;
  }
  return entries;
}

export async function inspectMemoryStatus(input: unknown): Promise<Evidence> {
  memoryStatusInput.parse(input);
  const source = "/proc/meminfo";
  const notLinux = linuxOnly(source); if (notLinux) return notLinux;
  const r = await command("cat", ["/proc/meminfo"], source);
  if ("failure" in r) return r.failure;
  const bytes = parseMemoryInfo(r.stdout);
  if (bytes.MemTotal === undefined || bytes.MemAvailable === undefined)
    return evidence(source, { bytes }, "partial", ["missing required memory counters"]);
  return evidence(source, { bytes });
}

export function parseServiceProperties(stdout: string): Record<string, string | number | null> {
  const allowed = new Set(["Id", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "Result"]);
  const values: Record<string, string | number | null> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const pos = line.indexOf("=");
    if (pos < 1) continue;
    const key = line.slice(0, pos);
    if (!allowed.has(key)) continue;
    const raw = line.slice(pos + 1);
    values[key] = key === "MainPID" ? (/^\d+$/.test(raw) ? Number(raw) : null) : raw;
  }
  return values;
}

export async function inspectServiceStatus(input: unknown): Promise<Evidence> {
  const { serviceId } = serviceStatusInput.parse(input);
  const source = "systemctl show";
  const notLinux = linuxOnly(source); if (notLinux) return notLinux;
  const r = await command("systemctl", ["show", serviceId, "--no-pager",
    "--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,Result"], source);
  if ("failure" in r) return r.failure;
  const service = parseServiceProperties(r.stdout);
  if (service.Id === undefined) return evidence(source, {}, "unavailable", ["service record unavailable"]);
  return evidence(source, { service });
}

export function parseProcessProperties(stdout: string): Record<string, string | number | null> {
  const parts = stdout.trim().split(/\s+/, 5);
  if (parts.length < 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return {};
  return { pid: Number(parts[0]), ppid: Number(parts[1]), state: parts[2],
    rssBytes: /^\d+$/.test(parts[3]) ? Number(parts[3]) * 1024 : null,
    name: parts[4] };
}
export async function inspectProcessDetail(input: unknown): Promise<Evidence> {
  const { pid } = processDetailInput.parse(input);
  const source = "ps -p";
  const notLinux = linuxOnly(source); if (notLinux) return notLinux;
  const r = await command("ps", ["-p", String(pid), "-o", "pid=,ppid=,stat=,rss=,comm="], source);
  if ("failure" in r) return r.failure;
  const processInfo = parseProcessProperties(r.stdout);
  return Object.keys(processInfo).length
    ? evidence(source, { process: processInfo })
    : evidence(source, {}, "unavailable", ["process not found"]);
}

// Journal messages can carry secrets. This v1 returns only source, timestamps, priority and a
// bounded record cursor, not message content. Content access requires a separate privacy review.
export function parseJournalMetadata(stdout: string, limit: number): { records: Record<string, unknown>[]; invalid: number; truncated: boolean } {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let invalid = 0;
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (records.length >= limit) break;
    try {
      const obj: unknown = JSON.parse(line);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) { invalid++; continue; }
      const item = obj as Record<string, unknown>;
      records.push({
        cursor: typeof item.__CURSOR === "string" && /^[A-Za-z0-9_.;=:-]{8,512}$/.test(item.__CURSOR) ? item.__CURSOR : null,
        timestampUsec: typeof item.__REALTIME_TIMESTAMP === "string" && /^\d+$/.test(item.__REALTIME_TIMESTAMP) ? item.__REALTIME_TIMESTAMP : null,
        priority: typeof item.PRIORITY === "string" && /^[0-7]$/.test(item.PRIORITY) ? item.PRIORITY : null,
        unit: typeof item._SYSTEMD_UNIT === "string" ? item._SYSTEMD_UNIT.slice(0, 128) : null,
      });
    } catch { invalid++; }
  }
  return { records, invalid, truncated: lines.length > limit };
}
export async function listJournalRecords(input: unknown): Promise<Evidence> {
  const params = journalRecordsInput.parse(input);
  const source = "journalctl metadata";
  const notLinux = linuxOnly(source); if (notLinux) return notLinux;
  const args = ["--no-pager", "--output=json", "--since", `-${params.minutes}min`,
    "--lines", String(params.limit + 1)];
  if (params.serviceId) args.push("--unit", params.serviceId);
  const r = await command("journalctl", args, source, 128 * 1024);
  if ("failure" in r) return r.failure;
  const parsed = parseJournalMetadata(r.stdout, params.limit);
  const partial = parsed.truncated || parsed.invalid > 0;
  return evidence(source, { records: parsed.records, invalidRecords: parsed.invalid },
    partial ? "partial" : "complete", parsed.invalid ? ["invalid journal records omitted"] : [], parsed.truncated);
}
