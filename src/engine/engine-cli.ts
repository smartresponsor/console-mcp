import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConsolePolicy } from "../service/policy.js";
import { createEngineBrowserCycleExecutor } from "./engine-cycle-browser.js";
import { createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, runWorkerLoop, tailEngineEvent, workerTick } from "./engine-core.js";
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
    commands: ["status", "go <component> [--live]", "tick [task-id]", "loop [--max-ticks=7]", "cycle-step <task-id> [--execute]", "task-status <task-id>", "event-tail [task-id] [--limit=30]"],
    examples: [
      "npm run engine -- go cataloging",
      "npm run engine:tick",
      "npm run engine -- cycle-step <task-id>",
      "npm run engine -- task-status <task-id>",
      "npm run engine -- event-tail <task-id>",
    ],
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main();
