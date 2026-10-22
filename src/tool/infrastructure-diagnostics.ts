import { z } from "zod";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";

const localOnly = z.object({ targetId: z.literal("local") }).strict();
const limitSchema = z.number().int().min(1).max(100).default(50);
export const ipv4RoutesInput = localOnly;
export const tcpListenersInput = localOnly.extend({ port: z.number().int().min(1).max(65535).optional(), limit: limitSchema }).strict();
export const processesInput = localOnly.extend({ limit: limitSchema }).strict();

type Observation = {
  ok: boolean;
  status: "complete" | "unsupported" | "unavailable" | "partial";
  targetId: "local";
  vantage: "local";
  collectedAt: string;
  source: string;
  data: Record<string, unknown>;
  warnings: string[];
  truncated: boolean;
};

async function executeRead(args: string[], source: string): Promise<{ data: unknown; warning: string | null }> {
  const result = await runSupervisedCommand(process.cwd(), args[0], args.slice(1), 10000, 256 * 1024);
  if (!result.ok) return { data: null, warning: `${source} unavailable (exit ${result.exitCode ?? "unknown"})` };
  try { return { data: JSON.parse(result.stdout), warning: null }; }
  catch { return { data: null, warning: `${source} produced invalid JSON` }; }
}

function response(source: string, data: Record<string, unknown>, warning: string | null, truncated = false): Observation {
  return {
    ok: warning === null,
    status: warning === "unsupported platform" ? "unsupported" : warning !== null ? "unavailable" : truncated ? "partial" : "complete",
    targetId: "local",
    vantage: "local",
    collectedAt: new Date().toISOString(),
    source,
    data,
    warnings: warning ? [warning] : [],
    truncated,
  };
}

/** Local-only first slice. Not registered as MCP tools until admission and tests pass. */
export async function inspectIpv4Routes(input: unknown): Promise<Observation> {
  ipv4RoutesInput.parse(input);
  if (process.platform !== "linux") return response("ip -j -4 route show", {}, "unsupported platform");
  const x = await executeRead(["ip", "-j", "-4", "route", "show"], "ip");
  if (!Array.isArray(x.data)) return response("ip -j -4 route show", {}, x.warning ?? "unexpected response");
  const routes = parseIpv4Routes(x.data);
  return response("ip -j -4 route show", { routes: routes.slice(0, 200), total: routes.length }, null, routes.length > 200);
}

export async function inspectTcpListeners(input: unknown): Promise<Observation> {
  const params = tcpListenersInput.parse(input);
  if (process.platform !== "linux") return response("ss -H -ltn", {}, "unsupported platform");
  const result = await runSupervisedCommand(process.cwd(), "ss", ["-H", "-ltn"], 10000, 256 * 1024);
  if (!result.ok) return response("ss -H -ltn", {}, "ss unavailable");
  const rows = parseTcpListeners(result.stdout, params.port);
  return response("ss -H -ltn", { listeners: rows.slice(0, params.limit), total: rows.length }, null, rows.length > params.limit);
}

export async function inspectProcesses(input: unknown): Promise<Observation> {
  const params = processesInput.parse(input);
  if (process.platform !== "linux") return response("ps", {}, "unsupported platform");
  const result = await runSupervisedCommand(process.cwd(), "ps", ["-eo", "pid=,ppid=,stat=,pcpu=,rss=,comm=", "--sort=-pcpu"], 10000, 256 * 1024);
  if (!result.ok) return response("ps", {}, "ps unavailable");
  const rows = parseProcesses(result.stdout);
  return response("ps", { processes: rows.slice(0, params.limit), total: rows.length }, null, rows.length > params.limit);
}

/** Deterministic parsers, separate from local process execution for fixture-based testing. */
export function parseTcpListeners(stdout: string, selectedPort?: number) {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0] !== "LISTEN") return [];
    const socket = fields[3];
    const match = socket.match(/:(\d+)$/);
    if (!match) return [];
    const port = Number(match[1]);
    if (port < 1 || port > 65535 || (selectedPort !== undefined && selectedPort !== port)) return [];
    const recvQueue = Number(fields[1]), sendQueue = Number(fields[2]);
    if (!Number.isFinite(recvQueue) || !Number.isFinite(sendQueue)) return [];
    return [{ address: socket.slice(0, -match[0].length), port, state: "LISTEN", recvQueue, sendQueue }];
  });
}

export function parseProcesses(stdout: string) {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) return [];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), state: m[3], cpuPercent: Number(m[4]), rssBytes: Number(m[5]) * 1024, name: m[6] }];
  });
}

export function parseIpv4Routes(value: unknown): Array<{ destination: unknown; gateway: unknown; interface: unknown; metric: unknown; protocol: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item)
  ).map((r) => ({
    destination: r.dst ?? null, gateway: r.gateway ?? null, interface: r.dev ?? null,
    metric: r.metric ?? null, protocol: r.protocol ?? null,
  }));
}
