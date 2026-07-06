import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";
import { createEngineBrowserCycleExecutor } from "./engine-cycle-browser.js";
import { createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, listEngineTask, runWorkerLoop, tailEngineEvent, workerTick } from "./engine-core.js";
import { runEngineCycleStep } from "./engine-cycle.js";

type EngineTaskStatus = "queued" | "planned" | "running" | "waiting_user" | "blocked" | "failed" | "done" | "cancelled";
type EngineTaskType = "repo_rc_implementation";

interface EngineTask {
  task_id: string;
  type: EngineTaskType;
  source: "cli";
  component: string;
  component_label: string;
  workspace_path: string;
  preset: "repo_rc_implementation";
  task_class: "repo_rc_implementation";
  status: EngineTaskStatus;
  created_at: string;
  updated_at: string;
  attempt: number;
  dry_run: boolean;
  next_action: string;
  last_event_id: string | null;
}

interface EngineEvent {
  event_id: string;
  ts: string;
  task_id: string | null;
  event: string;
  source: "cli" | "engine";
  data: Record<string, unknown>;
}

interface EngineStatus {
  ok: boolean;
  root: string;
  run_dir: string;
  log_dir: string;
  task_count: number;
  counts: Record<string, number>;
  latest_event: EngineEvent | null;
}

const ENGINE_CLI_FILE = fileURLToPath(import.meta.url);
const NORMALIZED_ROOT = path.resolve(path.join(path.dirname(ENGINE_CLI_FILE), "..", ".."));
const ENGINE_RUN_DIR = path.join(NORMALIZED_ROOT, "var", "run", "engine");
const TASK_DIR = path.join(ENGINE_RUN_DIR, "task");
const LOCK_DIR = path.join(ENGINE_RUN_DIR, "lock");
const WORKER_DIR = path.join(ENGINE_RUN_DIR, "worker");
const SESSION_DIR = path.join(ENGINE_RUN_DIR, "session");
const ENGINE_LOG_DIR = path.join(NORMALIZED_ROOT, "var", "log", "engine");
const EVENT_LOG = path.join(ENGINE_LOG_DIR, "event.jsonl");
const WORKER_LOG = path.join(ENGINE_LOG_DIR, "worker.jsonl");
const ERROR_LOG = path.join(ENGINE_LOG_DIR, "error.jsonl");

const DEFAULT_WORKSPACE_ROOT = process.env.CONSOLE_MCP_WORKSPACE_ROOT
  ? path.resolve(process.env.CONSOLE_MCP_WORKSPACE_ROOT)
  : path.resolve("D:\\PhpstormProjects\\www");
const SHARED_ENGINE_PATHS = createEnginePaths(NORMALIZED_ROOT, DEFAULT_WORKSPACE_ROOT);

const COMPONENT_WORKSPACE: Record<string, string> = {
  cataloging: "cataloging",
  shipping: "shipping",
  attaching: "attaching",
  paying: "paying",
  mobiling: "mobiling",
  cruding: "cruding",
  navigating: "navigating",
  interfacing: "interfacing",
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  await ensureRuntime();

  try {
    switch (command ?? "status") {
      case "status":
        printJson(await getStatus());
        return;
      case "go":
        printJson(await go(args));
        return;
      case "task-status":
        printJson(await taskStatus(args));
        return;
      case "event-tail":
        printJson(await eventTail(args));
        return;
      case "tick":
        printJson(await tick(args));
        return;
      case "loop":
        printJson(await loop(args));
        return;
      case "cycle-step":
        printJson(await cycleStep(args));
        return;
      case "cycle-run":
        printJson(await cycleRun(args));
        return;
      case "bank-step":
        printJson(await bankStep(args));
        return;
      case "bank-run":
        printJson(await bankRun(args));
        return;
      case "help":
      case "--help":
      case "-h":
        printJson(help());
        return;
      default:
        await appendError({ error: "unknown_command", command, args });
        printJson({ ok: false, error: "unknown_command", command, usage: help() });
        process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendError({ error: "fatal", message, command, args });
    printJson({ ok: false, error: message });
    process.exitCode = 1;
  }
}

async function ensureRuntime(): Promise<void> {
  await Promise.all([
    mkdir(TASK_DIR, { recursive: true }),
    mkdir(LOCK_DIR, { recursive: true }),
    mkdir(WORKER_DIR, { recursive: true }),
    mkdir(SESSION_DIR, { recursive: true }),
    mkdir(ENGINE_LOG_DIR, { recursive: true }),
  ]);
  await touchJsonl(EVENT_LOG);
  await touchJsonl(WORKER_LOG);
  await touchJsonl(ERROR_LOG);
}

async function touchJsonl(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    await writeFile(filePath, "", "utf8");
  }
}

async function go(args: string[]): Promise<Record<string, unknown>> {
  const componentInput = args[0]?.trim();
  if (!componentInput) {
    return { ok: false, error: "component_required", example: "npm run engine -- go cataloging" };
  }
  return await enqueueTask(SHARED_ENGINE_PATHS, componentInput, args.includes("--live"), "cli");
}

async function tick(args: string[]): Promise<Record<string, unknown>> {
  const requestedTaskId = args[0]?.trim();
  return await workerTick(SHARED_ENGINE_PATHS, requestedTaskId || undefined);
}

async function loop(args: string[]): Promise<Record<string, unknown>> {
  const maxTicks = parseMaxTicks(args, 7);
  return await runWorkerLoop(SHARED_ENGINE_PATHS, { maxTicks, stopOnIdle: true, stopOnWaitingUser: true });
}

async function cycleStep(args: string[]): Promise<Record<string, unknown>> {
  const taskId = args.find((arg) => !arg.startsWith("--"))?.trim();
  const execute = args.includes("--execute");
  if (!taskId) return { ok: false, error: "task_id_required", example: "npm run engine -- cycle-step <task-id> [--execute]" };
  if (!execute) return await runEngineCycleStep(SHARED_ENGINE_PATHS, { taskId, mode: "plan" });
  const policy = await loadConsolePolicy(NORMALIZED_ROOT);
  return await runEngineCycleStep(SHARED_ENGINE_PATHS, { taskId, mode: "execute" }, createEngineBrowserCycleExecutor({
    policy,
    baseDir: NORMALIZED_ROOT,
    ports: parsePorts(args, [9222, 9223]),
    url: parseStringOption(args, "--url=", "https://chatgpt.com/"),
    activate: !args.includes("--no-activate"),
    allowOverwrite: args.includes("--allow-overwrite"),
    maxMessages: parseIntOption(args, "--max-messages=", 30, 1, 100),
    timeoutMs: parseIntOption(args, "--timeout-ms=", 3000, 250, 10000),
    readinessProfile: parseReadinessProfile(args),
    maxWaitMs: parseOptionalIntOption(args, "--max-wait-ms=", 1000, 600000),
    observationBudgetMs: parseOptionalIntOption(args, "--observation-budget-ms=", 1000, 60000),
    pollMs: parseOptionalIntOption(args, "--poll-ms=", 250, 5000),
    gatewayModel: parseOptionalStringOption(args, "--gateway-model="),
    gatewayMaxOutputTokens: parseIntOption(args, "--gateway-max-output-tokens=", 900, 64, 6000),
    gatewayTemperature: parseFloatOption(args, "--gateway-temperature=", 0.1, 0, 2),
    gatewayTimeoutMs: parseIntOption(args, "--gateway-timeout-ms=", 60000, 5000, 180000),
    gatewayRaw: args.includes("--gateway-raw"),
    gatewayConsoleEndpoint: parseOptionalStringOption(args, "--gateway-console-endpoint="),
  }));
}

async function cycleRun(args: string[]): Promise<Record<string, unknown>> {
  const taskId = args.find((arg) => !arg.startsWith("--"))?.trim();
  if (!taskId) return { ok: false, error: "task_id_required", example: "npm run engine -- cycle-run <task-id> [--max-steps=7]" };
  const maxSteps = parseIntOption(args, "--max-steps=", 7, 1, 20);
  const baseArgs = args.filter((arg) => !arg.startsWith("--max-steps="));
  const timeline: Record<string, unknown>[] = [];
  let stopReason = "max_steps";
  for (let index = 0; index < maxSteps; index += 1) {
    const result = await cycleStep(baseArgs.includes("--execute") ? baseArgs : [...baseArgs, "--execute"]);
    const stage = typeof result.stage === "string" ? result.stage : "unknown";
    const status = typeof result.status === "string" ? result.status : null;
    timeline.push({ index, ok: result.ok === true, stage, status, next_action: result.next_action ?? null });
    if (stage === "complete" || status === "ENGINE_CYCLE_COMPLETE") { stopReason = "complete"; break; }
    if (status === "ENGINE_CYCLE_STAGE_NOT_READY") { stopReason = "not_ready"; break; }
    if (status === "ENGINE_CYCLE_STAGE_BLOCKED" || result.ok !== true) { stopReason = "blocked"; break; }
  }
  return { ok: stopReason !== "blocked", status: "ENGINE_CYCLE_RUN_COMPLETE", task_id: taskId, max_steps: maxSteps, step_count: timeline.length, stop_reason: stopReason, timeline, local_cli: true };
}

async function bankStep(args: string[]): Promise<Record<string, unknown>> {
  const listed = await listEngineTask(SHARED_ENGINE_PATHS);
  const tasks = Array.isArray(listed.tasks) ? listed.tasks as Record<string, unknown>[] : [];
  const terminal = new Set(["done", "cancelled", "failed", "blocked"]);
  const requestedTaskId = parseOptionalStringOption(args, "--task-id=");
  const selected = requestedTaskId
    ? tasks.find((task) => task.task_id === requestedTaskId)
    : tasks.find((task) => typeof task.task_id === "string" && !terminal.has(String(task.status ?? "")));
  if (!selected) return { ok: true, status: "ENGINE_BANK_IDLE", task_count: tasks.length, requested_task_id: requestedTaskId ?? null, local_cli: true };
  if (requestedTaskId && terminal.has(String(selected.status ?? ""))) return { ok: false, status: "ENGINE_BANK_TASK_TERMINAL", task_id: requestedTaskId, selected_status: selected.status ?? null, local_cli: true };
  const taskId = String(selected.task_id);
  const stepArgs = [taskId, ...args.filter((arg) => arg.startsWith("--") && !arg.startsWith("--task-id="))];
  const result = await cycleStep(stepArgs.includes("--execute") ? stepArgs : [...stepArgs, "--execute"]);
  return { ok: result.ok === true, status: "ENGINE_BANK_STEP_COMPLETE", task_id: taskId, selected_status: selected.status ?? null, result, local_cli: true };
}

async function bankRun(args: string[]): Promise<Record<string, unknown>> {
  const maxTasks = parseIntOption(args, "--max-tasks=", 3, 1, 20);
  const maxStepsPerTask = parseIntOption(args, "--max-steps-per-task=", 2, 1, 20);
  const runArgs = args.filter((arg) => !arg.startsWith("--max-tasks=") && !arg.startsWith("--max-steps-per-task="));
  const timeline: Record<string, unknown>[] = [];
  let stopReason = "max_tasks";
  for (let taskIndex = 0; taskIndex < maxTasks; taskIndex += 1) {
    for (let stepIndex = 0; stepIndex < maxStepsPerTask; stepIndex += 1) {
      const result = await bankStep(runArgs);
      const status = typeof result.status === "string" ? result.status : null;
      const inner = typeof result.result === "object" && result.result !== null ? result.result as Record<string, unknown> : {};
      const innerStatus = typeof inner.status === "string" ? inner.status : null;
      const taskSnapshot = typeof result.task_id === "string" ? await taskStatus([String(result.task_id)]) : null;
      timeline.push({ task_index: taskIndex, step_index: stepIndex, ok: result.ok === true, status, task_id: result.task_id ?? null, task: summarizeTaskSnapshot(taskSnapshot), inner_status: innerStatus, inner_stage: inner.stage ?? null, inner_next_action: inner.next_action ?? null, block: summarizeBlock(inner) });
      if (status === "ENGINE_BANK_IDLE") { stopReason = "idle"; break; }
      if (innerStatus === "ENGINE_CYCLE_STAGE_NOT_READY") { stopReason = "not_ready"; break; }
      if (innerStatus === "ENGINE_CYCLE_STAGE_BLOCKED" || result.ok !== true) { stopReason = "blocked"; break; }
    }
    if (stopReason !== "max_tasks") break;
  }
  return { ok: stopReason !== "blocked", status: "ENGINE_BANK_RUN_COMPLETE", max_tasks: maxTasks, max_steps_per_task: maxStepsPerTask, step_count: timeline.length, stop_reason: stopReason, timeline, local_cli: true };
}

async function taskStatus(args: string[]): Promise<Record<string, unknown>> {
  const taskId = args[0]?.trim();
  if (!taskId) return { ok: false, error: "task_id_required" };
  return await getEngineTaskStatus(SHARED_ENGINE_PATHS, taskId);
}

async function eventTail(args: string[]): Promise<Record<string, unknown>> {
  const maybeTaskId = args.find((arg) => !arg.startsWith("--"));
  const limit = parseLimit(args, 30);
  return await tailEngineEvent(SHARED_ENGINE_PATHS, maybeTaskId, limit);
}

async function getStatus(): Promise<Record<string, unknown>> {
  return await getEngineStatus(SHARED_ENGINE_PATHS);
}

async function appendError(data: Record<string, unknown>): Promise<void> {
  process.stderr.write(`${JSON.stringify({ ok: false, source: "engine-cli", ...data })}\n`);
}

function summarizeTaskSnapshot(value: Record<string, unknown> | null): Record<string, unknown> | null {
  const task = value && typeof value.task === "object" && value.task !== null ? value.task as Record<string, unknown> : null;
  if (!task) return null;
  return {
    status: task.status ?? null,
    target_id: task.target_id ?? null,
    current_url: task.current_url ?? null,
    chat_id: task.chat_id ?? null,
    draft_hash: task.draft_hash ?? null,
    draft_length: task.draft_length ?? null,
    next_action: task.next_action ?? null,
  };
}

function summarizeBlock(value: Record<string, unknown>): Record<string, unknown> | null {
  const result = objectField(value, "result");
  const source = objectField(value, "drafted")
    ?? objectField(result, "drafted")
    ?? objectField(value, "opened")
    ?? objectField(result, "opened")
    ?? objectField(value, "settled")
    ?? objectField(result, "settled")
    ?? objectField(value, "sent")
    ?? objectField(result, "sent")
    ?? objectField(value, "dispatched")
    ?? objectField(result, "dispatched")
    ?? result;
  if (!source) return null;
  return {
    status: source.status ?? null,
    error: source.error ?? null,
    reason: source.reason ?? null,
    detail: source.detail ?? source.message ?? null,
    stage: value.stage ?? source.stage ?? null,
    target_id: source.target_id ?? source.expected_target_id ?? null,
    current_url: source.current_url ?? null,
    next_action: source.next_action ?? value.next_action ?? null,
    expected_hash: source.expected_draft_hash ?? null,
    current_hash: source.current_draft_hash ?? null,
    expected_length: source.expected_draft_length ?? null,
    current_length: source.current_draft_length ?? null,
    recovery: objectField(value, "recovery"),
  };
}

function objectField(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseMaxTicks(args: string[], fallback: number): number {
  const arg = args.find((value) => value.startsWith("--max-ticks="));
  if (!arg) return fallback;
  const value = Number.parseInt(arg.slice("--max-ticks=".length), 10);
  return Number.isFinite(value) && value > 0 && value <= 50 ? value : fallback;
}

function parseLimit(args: string[], fallback: number): number {
  const arg = args.find((value) => value.startsWith("--limit="));
  if (!arg) return fallback;
  const value = Number.parseInt(arg.slice("--limit=".length), 10);
  return Number.isFinite(value) && value > 0 && value <= 500 ? value : fallback;
}

function parsePorts(args: string[], fallback: number[]): number[] {
  const value = parseOptionalStringOption(args, "--ports=");
  if (!value) return fallback;
  const ports = value.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535);
  return ports.length > 0 && ports.length <= 20 ? ports : fallback;
}

function parseStringOption(args: string[], prefix: string, fallback: string): string {
  return parseOptionalStringOption(args, prefix) ?? fallback;
}

function parseOptionalStringOption(args: string[], prefix: string): string | undefined {
  const arg = args.find((value) => value.startsWith(prefix));
  const parsed = arg?.slice(prefix.length).trim();
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function parseIntOption(args: string[], prefix: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = parseOptionalIntOption(args, prefix, minimum, maximum);
  return parsed ?? fallback;
}

function parseOptionalIntOption(args: string[], prefix: string, minimum: number, maximum: number): number | undefined {
  const raw = parseOptionalStringOption(args, prefix);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function parseFloatOption(args: string[], prefix: string, fallback: number, minimum: number, maximum: number): number {
  const raw = parseOptionalStringOption(args, prefix);
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function parseReadinessProfile(args: string[]): "quick_probe" | "rc_gate" | "long_run" {
  const value = parseOptionalStringOption(args, "--readiness-profile=");
  return value === "quick_probe" || value === "long_run" ? value : "rc_gate";
}

function help(): Record<string, unknown> {
  return {
    ok: true,
    commands: ["status", "go <component> [--live]", "tick [task-id]", "loop [--max-ticks=7]", "cycle-step <task-id> [--execute]", "cycle-run <task-id> [--max-steps=7]", "bank-step [--task-id=<task-id>] [--timeout-ms=3000]", "bank-run [--task-id=<task-id>] [--max-tasks=3] [--max-steps-per-task=2]", "task-status <task-id>", "event-tail [task-id] [--limit=30]"],
    examples: [
      "npm run engine -- go cataloging",
      "npm run engine:tick",
      "npm run engine -- cycle-step <task-id>",
      "npm run engine -- cycle-run <task-id> --max-steps=2",
      "npm run engine -- bank-step --timeout-ms=3000",
      "npm run engine -- bank-run --max-tasks=3 --max-steps-per-task=2 --timeout-ms=3000",
      "npm run engine -- bank-run --task-id=<task-id> --max-tasks=1 --max-steps-per-task=2 --timeout-ms=3000",
      "npm run engine -- task-status <task-id>",
      "npm run engine -- event-tail <task-id>",
    ],
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main();

