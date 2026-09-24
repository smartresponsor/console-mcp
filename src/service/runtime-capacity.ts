import fs from "node:fs";
import path from "node:path";

type RuntimeCapacityDecision = "ADMIT" | "ADMIT_LIGHT_ONLY" | "WAIT" | "DRAIN";

type RuntimeCapacityInput = {
  watchdogFresh: boolean;
  watchdogOwnershipConsistent: boolean;
  resourceTelemetryFresh: boolean;
  resourcePressure: string;
  stability: string;
  currentFailureCount: number;
  enginePressure: string;
};

export function evaluateRuntimeCapacity(input: RuntimeCapacityInput): Record<string, unknown> {
  const reasons: string[] = [];
  let decision: RuntimeCapacityDecision = "ADMIT";
  const escalate = (next: RuntimeCapacityDecision, reason: string): void => {
    const rank: Record<RuntimeCapacityDecision, number> = { ADMIT: 0, ADMIT_LIGHT_ONLY: 1, WAIT: 2, DRAIN: 3 };
    if (rank[next] > rank[decision]) decision = next;
    reasons.push(reason);
  };

  if (!input.watchdogFresh) escalate("DRAIN", "WATCHDOG_STALE");
  if (!input.watchdogOwnershipConsistent) escalate("DRAIN", "WATCHDOG_OWNERSHIP_MISMATCH");
  if (!input.resourceTelemetryFresh) escalate("WAIT", "RESOURCE_TELEMETRY_STALE");
  if (input.resourcePressure === "CRITICAL") escalate("DRAIN", "RESOURCE_PRESSURE_CRITICAL");
  else if (input.resourcePressure === "WARN") escalate("WAIT", "RESOURCE_PRESSURE_WARN");
  else if (input.resourcePressure === "WATCH") escalate("ADMIT_LIGHT_ONLY", "RESOURCE_PRESSURE_WATCH");

  if (input.stability === "CRITICAL") escalate("DRAIN", "STABILITY_CRITICAL");
  else if (input.stability === "UNSTABLE") escalate("WAIT", "STABILITY_UNSTABLE");
  else if (input.stability === "RECOVERING") escalate("ADMIT_LIGHT_ONLY", "STABILITY_RECOVERING");
  else if (input.stability === "DEGRADED") escalate("ADMIT_LIGHT_ONLY", "STABILITY_DEGRADED");

  if (input.currentFailureCount > 0) escalate("WAIT", "ACTIVE_RUNTIME_FAILURE");
  if (input.enginePressure === "HIGH") escalate("ADMIT_LIGHT_ONLY", "ENGINE_BACKLOG_HIGH");

  return {
    ok: decision === "ADMIT" || decision === "ADMIT_LIGHT_ONLY",
    status: "RUNTIME_CAPACITY_" + decision,
    decision,
    reasons: [...new Set(reasons)],
    allow_new_work: decision === "ADMIT" || decision === "ADMIT_LIGHT_ONLY",
    allow_heavy_work: decision === "ADMIT",
    inputs: input,
  };
}

export function runtimeCapacityAllowsNewWork(verdict: Record<string, unknown>): boolean {
  return verdict.decision === "ADMIT" || verdict.decision === "ADMIT_LIGHT_ONLY";
}

export function runtimeCapacityAllowsHeavyWork(verdict: Record<string, unknown>): boolean {
  return verdict.allow_heavy_work === true && verdict.decision === "ADMIT";
}

export function readRuntimeCapacity(projectRoot: string): Record<string, unknown> {
  const runDir = path.join(projectRoot, "var", "run");
  const stability = readJson(path.join(runDir, "runtime-stability-last.json"));
  const environment = readJson(path.join(runDir, "runtime-environment-last.json"));
  const watchdogLoop = readJson(path.join(runDir, "console-mcp-watchdog-loop-state.json"));
  const watchdogBroker = readJson(path.join(runDir, "server-control", "broker.json"));
  const now = Date.now();
  const watchdogAgeSeconds = ageSeconds(watchdogLoop?.at, now);
  const brokerAgeSeconds = ageSeconds(watchdogBroker?.heartbeat_at, now);
  const environmentAgeSeconds = ageSeconds(environment?.sampled_at, now);
  const watchdogFresh = watchdogAgeSeconds !== null && watchdogAgeSeconds <= 120 && brokerAgeSeconds !== null && brokerAgeSeconds <= 15;
  const watchdogOwnershipConsistent = Number.isInteger(watchdogLoop?.pid) && Number.isInteger(watchdogBroker?.pid) && watchdogLoop.pid === watchdogBroker.pid;
  const environmentFresh = environmentAgeSeconds !== null && environmentAgeSeconds <= 180;
  const currentFailureClasses = Array.isArray(stability?.current_failure_classes) ? stability.current_failure_classes : [];

  const slotLimit = resolveRuntimeSlotLimit();
  const slotOccupancy = readRuntimeSlotOccupancy(path.join(runDir, "engine", "lock", "runtime-capacity-chat"), slotLimit);
  const heavySlotLimit = resolveHeavyRuntimeSlotLimit();
  const heavySlotOccupancy = readRuntimeSlotOccupancy(path.join(runDir, "runtime-capacity-heavy"), heavySlotLimit);

  const verdict = evaluateRuntimeCapacity({
    watchdogFresh,
    watchdogOwnershipConsistent,
    resourceTelemetryFresh: environmentFresh,
    resourcePressure: stringValue(environment?.resource_pressure?.level, "UNKNOWN"),
    stability: stringValue(stability?.recent?.stability, currentFailureClasses.length > 0 ? "DEGRADED" : "NORMAL"),
    currentFailureCount: currentFailureClasses.length,
    enginePressure: stringValue(environment?.engine_execution_pressure?.status, "UNKNOWN"),
  });

  return {
    ...verdict,
    observed_at: new Date(now).toISOString(),
    watchdog: { fresh: watchdogFresh, age_seconds: watchdogAgeSeconds, broker_age_seconds: brokerAgeSeconds, ownership_consistent: watchdogOwnershipConsistent, loop_pid: watchdogLoop?.pid ?? null, broker_pid: watchdogBroker?.pid ?? null },
    resource_telemetry: { fresh: environmentFresh, age_seconds: environmentAgeSeconds },
    stability_sampled_at: stability?.sampled_at ?? null,
    chat_execution_slots: slotOccupancy,
    heavy_execution_slots: heavySlotOccupancy,
  };
}

function resolveRuntimeSlotLimit(): number {
  const parsed = Number.parseInt(process.env.CONSOLE_MCP_CHAT_EXECUTION_SLOTS ?? "6", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 32 ? parsed : 6;
}

function resolveHeavyRuntimeSlotLimit(): number {
  const parsed = Number.parseInt(process.env.CONSOLE_MCP_HEAVY_EXECUTION_SLOTS ?? "2", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : 2;
}

function readRuntimeSlotOccupancy(slotDir: string, limit: number): Record<string, unknown> {
  let occupied = 0;
  let stale = 0;
  try {
    for (let slot = 0; slot < limit; slot += 1) {
      const lockPath = path.join(slotDir, `slot-${slot}.lock`);
      if (!fs.existsSync(lockPath)) continue;
      let live = true;
      try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
        const pid = typeof parsed.pid === "number" ? parsed.pid : (typeof parsed.owner_pid === "number" ? parsed.owner_pid : null);
        live = pid !== null && processAlive(pid);
      } catch { live = false; }
      if (live) occupied += 1; else stale += 1;
    }
  } catch {}
  return { limit, occupied, available: Math.max(0, limit - occupied), stale };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && String((error as { code?: unknown }).code ?? "") === "EPERM";
  }
}

function readJson(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function ageSeconds(value: unknown, now: number): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 100) / 10) : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : fallback;
}

