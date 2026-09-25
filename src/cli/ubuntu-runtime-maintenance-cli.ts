import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

type Args = { root: string; mcpOk: boolean; cdpOk: boolean; watchdogPid: number };

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root);
const runDir = path.join(root, "var", "run");
const logDir = path.join(root, "var", "log");
await mkdir(path.join(runDir, "server-control"), { recursive: true });
await mkdir(logDir, { recursive: true });
await mkdir(path.join(runDir, "engine", "task"), { recursive: true });
const now = new Date();
const nowIso = now.toISOString();

const engine = await readEnginePressure(path.join(runDir, "engine", "task"), now.getTime());
const totalMem = os.totalmem();
const freeMem = os.freemem();
const usedPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;
const loadPerCpu = os.cpus().length > 0 ? os.loadavg()[0] / os.cpus().length : 0;
const pressure = classifyPressure(usedPercent, loadPerCpu);
const failureClasses = [
  ...(args.mcpOk ? [] : ["MCP_PROTOCOL_UNRESPONSIVE"]),
  ...(args.cdpOk ? [] : ["CDP_UNRESPONSIVE"]),
];
const previousStability = await readJson(path.join(runDir, "runtime-stability-last.json"));
const previousFailureClasses = Array.isArray(previousStability?.current_failure_classes) ? previousStability.current_failure_classes.map(String) : [];
const recovering = failureClasses.length === 0 && previousFailureClasses.length > 0;
const stability = failureClasses.length > 0 ? "DEGRADED" : (recovering ? "RECOVERING" : "NORMAL");

await atomicJson(path.join(runDir, "console-mcp-watchdog-loop-state.json"), {
  schema_version: 1, at: nowIso, pid: args.watchdogPid, ok: args.mcpOk && args.cdpOk, status: args.mcpOk && args.cdpOk ? "CADENCE_HEALTHY" : "CADENCE_DEGRADED",
  platform: process.platform, owner: "systemd-watchdog",
});
await atomicJson(path.join(runDir, "server-control", "broker.json"), {
  schema_version: 1, pid: args.watchdogPid, generation: `systemd-${args.watchdogPid}`, started_at: nowIso, heartbeat_at: nowIso, platform: process.platform,
});
const environmentSample = {
  schema_version: 1, sampled_at: nowIso, sampler_pid: process.pid, failure_classification: pressure.level === "CRITICAL" ? "DEGRADED" : "HEALTHY",
  platform: process.platform, resource_pressure: pressure, engine_execution_pressure: engine.pressure,
  resources: {
    host: { physical_total_bytes: totalMem, physical_available_bytes: freeMem, physical_used_percent: round1(usedPercent), load_1m_per_cpu: round2(loadPerCpu), uptime_seconds: Math.round(os.uptime()) },
    telemetry_errors: [],
  },
  engine: engine.summary,
};
await atomicJson(path.join(runDir, "runtime-environment-last.json"), environmentSample);
await appendFile(path.join(logDir, "runtime-environment.ndjson"), `${JSON.stringify(environmentSample)}\n`, "utf8");

const stabilitySample = {
  schema_version: 1, sampled_at: nowIso, watchdog_pid: args.watchdogPid,
  current_failure_classes: failureClasses, current_failure_count: failureClasses.length,
  recent: { stability, failures_5m: failureClasses.length, failures_15m: failureClasses.length, failures_60m: failureClasses.length, interval_trend: "INSUFFICIENT_DATA" },
  process: { alive: args.mcpOk }, protocol: { ok: args.mcpOk, stale: false, status: args.mcpOk ? "LOCAL_AUTH_HEALTHY" : "MCP_PROTOCOL_UNRESPONSIVE" },
  cdp_http: { ok: args.cdpOk }, environment: { available: true, stale: false, resource_pressure: pressure.level },
};
await atomicJson(path.join(runDir, "runtime-stability-last.json"), stabilitySample);
for (const failureClass of failureClasses.filter((item) => !previousFailureClasses.includes(item))) {
  await appendFile(path.join(logDir, "runtime-failures.ndjson"), `${JSON.stringify({ timestamp: nowIso, event: "failure_started", failure_class: failureClass, watchdog_pid: args.watchdogPid, platform: process.platform })}\n`, "utf8");
}
for (const failureClass of previousFailureClasses.filter((item: string) => !failureClasses.includes(item))) {
  await appendFile(path.join(logDir, "runtime-failures.ndjson"), `${JSON.stringify({ timestamp: nowIso, event: "failure_recovered", failure_class: failureClass, watchdog_pid: args.watchdogPid, platform: process.platform })}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ ok: args.mcpOk && args.cdpOk, status: "UBUNTU_RUNTIME_MAINTENANCE_COMPLETE", platform: process.platform, pressure: pressure.level, engine_pressure: engine.pressure.status, failure_classes: failureClasses })}\n`);

function parseArgs(values: string[]): Args {
  const root = option(values, "--root=") ?? process.cwd();
  const mcpOk = option(values, "--mcp-ok=") !== "false";
  const cdpOk = option(values, "--cdp-ok=") !== "false";
  const watchdogPid = Number.parseInt(option(values, "--watchdog-pid=") ?? String(process.ppid || process.pid), 10);
  return { root, mcpOk, cdpOk, watchdogPid: Number.isInteger(watchdogPid) && watchdogPid > 0 ? watchdogPid : process.pid };
}
function option(values: string[], prefix: string): string | null { const v = values.find((x) => x.startsWith(prefix)); return v ? v.slice(prefix.length) : null; }
function classifyPressure(memoryPercent: number, loadPerCpu: number): { level: string; signals: string[] } {
  const signals: string[] = [];
  let level = "NORMAL";
  if (memoryPercent >= 95 || loadPerCpu >= 1.5) { level = "CRITICAL"; signals.push(memoryPercent >= 95 ? "PHYSICAL_MEMORY_CRITICAL" : "CPU_LOAD_CRITICAL"); }
  else if (memoryPercent >= 90 || loadPerCpu >= 1.1) { level = "WARN"; signals.push(memoryPercent >= 90 ? "PHYSICAL_MEMORY_WARN" : "CPU_LOAD_WARN"); }
  else if (memoryPercent >= 85 || loadPerCpu >= 0.85) { level = "WATCH"; signals.push(memoryPercent >= 85 ? "PHYSICAL_MEMORY_WATCH" : "CPU_LOAD_WATCH"); }
  return { level, signals };
}
async function readEnginePressure(taskDir: string, nowMs: number): Promise<{ pressure: Record<string, unknown>; summary: Record<string, unknown> }> {
  const names = await readdir(taskDir).catch(() => []);
  const counts: Record<string, number> = {}; const pressureCounts: Record<string, number> = {}; let staleNonterminal = 0;
  const cutoff = nowMs - 6 * 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const task = JSON.parse(await readFile(path.join(taskDir, name), "utf8")) as Record<string, unknown>;
      const status = String(task.status ?? "unknown").toLowerCase(); counts[status] = (counts[status] ?? 0) + 1;
      if (/blocked|failed|error|completed|done|cancelled/.test(status)) continue;
      const updated = Date.parse(String(task.updated_at ?? ""));
      if (!Number.isFinite(updated) || updated < cutoff) { staleNonterminal += 1; continue; }
      pressureCounts[status] = (pressureCounts[status] ?? 0) + 1;
    } catch { /* keep sampling */ }
  }
  const active = sum(pressureCounts, ["executing","waiting_assistant","running"]);
  const queued = sum(pressureCounts, ["queued","pending","ready","planned","dispatch_ready"]);
  const status = active >= 3 || queued >= 12 ? "HIGH" : (active > 0 || queued >= 6 ? "WATCH" : "NORMAL");
  return { pressure: { status, active, queued, task_count: names.length }, summary: { task_count: names.length, counts, pressure_counts: pressureCounts, stale_nonterminal_task_count: staleNonterminal } };
}
function sum(counts: Record<string, number>, keys: string[]): number { return keys.reduce((n, k) => n + (counts[k] ?? 0), 0); }
async function readJson(file: string): Promise<any> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }
async function atomicJson(file: string, value: unknown): Promise<void> { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, file); }
function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
