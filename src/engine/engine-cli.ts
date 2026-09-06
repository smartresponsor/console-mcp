import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConsolePolicy } from "../Policy/ConsolePolicy.js";
import { createEngineBrowserCycleExecutor } from "./engine-cycle-browser.js";
import { authorizeEngineTaskExecution, createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, listEngineTask, recordEngineExecutionSpecification, runWorkerLoop, tailEngineEvent, workerTick } from "./engine-core.js";
import { runEngineCycleRounds } from "./engine-cycle-browser.js";
import { runEngineCycleStep } from "./engine-cycle.js";
import { buildChatGptEntrypointPlan } from "../service/chatgpt-entrypoint-preset.js";

type EngineTaskStatus = "queued" | "planned" | "running" | "dispatch_ready" | "executing" | "waiting_runtime" | "waiting_assistant" | "evaluating" | "blocked" | "failed" | "completed" | "done" | "cancelled";
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
const execFileAsync = promisify(execFile);
const CHATGPT_LOOP_RUNNER = path.resolve(NORMALIZED_ROOT, "..", "chatgpt-loop", "tool", "runner-repo-smoke.ps1");

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
      case "go": {
        const result = await go(args);
        printJson(args.includes("--verbose") || args.includes("--diagnostic") ? result : compactGoResult(result));
        return;
      }
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
    return { ok: false, error: "component_required", example: "npm run engine -- go console-mcp M1 --live" };
  }
  const live = args.includes("--live");
  const maxAutoIterations = Math.max(5, parseGoIterations(args, 5));
  const workspacePath = await resolveCliGoWorkspace(componentInput, parseOptionalStringOption(args, "--workspace="));
  const rawCommand = `Cmcp go ${componentInput} M${maxAutoIterations}`;
  if (live && !args.includes("--native-engine")) {
    return await runChatGptLoopGo(componentInput, workspacePath, maxAutoIterations, rawCommand);
  }
  const plan = buildChatGptEntrypointPlan({ rawPrompt: rawCommand, workspacePath, componentName: componentInput, taskPreset: "repo_rc_implementation", maxAutoIterations });
  const enrichedPrompt = typeof plan.enrichedPrompt === "string" ? plan.enrichedPrompt : "";
  const enqueue = await enqueueTask(SHARED_ENGINE_PATHS, componentInput, live, "cli", workspacePath);
  const taskId = typeof enqueue.task_id === "string" ? enqueue.task_id : null;
  const specification = taskId && enqueue.ok === true
    ? await recordEngineExecutionSpecification(SHARED_ENGINE_PATHS, taskId, { content: enrichedPrompt, sourcePrompt: rawCommand, templateVersion: "repo_rc_implementation_v1" })
    : null;
  const authorization = live && taskId && specification?.ok === true
    ? await authorizeEngineTaskExecution(SHARED_ENGINE_PATHS, taskId, { authorizedBy: "go", maxAutoIterations })
    : { ok: !live && specification?.ok === true, status: live ? "ENGINE_CLI_GO_AUTHORIZATION_BLOCKED" : "ENGINE_CLI_GO_PREPARED_NOT_LIVE" };
  const loop = live && taskId && authorization.ok === true
    ? await runWorkerLoop(SHARED_ENGINE_PATHS, { taskId, stopOnIdle: true, stopOnWaitingUser: true })
    : null;
  const cycles = live && taskId && loop?.ok === true
    ? await runEngineCycleRounds(SHARED_ENGINE_PATHS, await buildCliBrowserExecutorOptions(args), { taskId, maxRounds: maxAutoIterations, maxStepsPerRound: 9, stopOnBlocked: true, stopOnNotReady: true })
    : null;
  return {
    ok: enqueue.ok === true && specification?.ok === true && (!live || (authorization.ok === true && loop?.ok === true && cycles?.ok === true)),
    status: enqueue.ok !== true ? "ENGINE_CLI_GO_ENQUEUE_BLOCKED" : (specification?.ok !== true ? "ENGINE_CLI_GO_SPECIFICATION_BLOCKED" : (!live ? "ENGINE_CLI_GO_PREPARED" : (authorization.ok !== true ? "ENGINE_CLI_GO_AUTHORIZATION_BLOCKED" : (loop?.ok !== true ? "ENGINE_CLI_GO_WORKER_BLOCKED" : (cycles?.ok === true ? "ENGINE_CLI_GO_EXECUTED" : "ENGINE_CLI_GO_CYCLE_BLOCKED"))))),
    task_id: taskId,
    component: componentInput,
    workspace_path: workspacePath,
    max_auto_iterations: maxAutoIterations,
    live,
    plan: { status: plan.status, intent: plan.intent, enrichment: plan.enrichment, enriched_prompt_length: enrichedPrompt.length },
    enqueue,
    specification,
    authorization,
    loop,
    run_n: cycles,
    local_cli: true,
  };
}

async function runChatGptLoopGo(component: string, workspacePath: string, maxAutoIterations: number, rawCommand: string): Promise<Record<string, unknown>> {
  if (!existsSync(CHATGPT_LOOP_RUNNER)) {
    return { ok: false, status: "TASK_BANK_RUNNER_NOT_FOUND", component, workspace_path: workspacePath, runner_path: CHATGPT_LOOP_RUNNER };
  }
  const runnerArgs = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", CHATGPT_LOOP_RUNNER,
    "-TargetRepo", workspacePath,
    "-MaxIterations", String(maxAutoIterations),
    "-Name", component,
    "-EngineExecutor",
    "-Chain",
    "-PromptMode", "enriched",
    "-RawCommand", rawCommand,
  ];
  try {
    const { stdout, stderr } = await execFileAsync("pwsh", runnerArgs, { cwd: path.dirname(CHATGPT_LOOP_RUNNER), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const parsed = await enrichChatGptLoopBlockedResult(parseTrailingJson(stdout), component, workspacePath);
    return {
      ...parsed,
      status: parsed.ok === true ? "ENGINE_CLI_GO_CHATGPT_LOOP_EXECUTED" : "ENGINE_CLI_GO_CHATGPT_LOOP_BLOCKED",
      component,
      workspace_path: workspacePath,
      max_auto_iterations: maxAutoIterations,
      live: true,
      execution_path: "chatgpt_loop",
      native_engine_used: false,
      runner_path: CHATGPT_LOOP_RUNNER,
      stderr: stderr.trim() || undefined,
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    let parsed: Record<string, unknown> | null = null;
    try { parsed = failure.stdout ? parseTrailingJson(failure.stdout) : null; } catch {}
    return {
      ...(parsed ?? {}),
      ok: false,
      status: "ENGINE_CLI_GO_CHATGPT_LOOP_FAILED",
      component,
      workspace_path: workspacePath,
      max_auto_iterations: maxAutoIterations,
      live: true,
      execution_path: "chatgpt_loop",
      native_engine_used: false,
      runner_path: CHATGPT_LOOP_RUNNER,
      exit_code: failure.code ?? null,
      error: failure.message,
      stderr: failure.stderr?.trim() || undefined,
    };
  }
}

async function enrichChatGptLoopBlockedResult(parsed: Record<string, unknown>, component: string, workspacePath: string): Promise<Record<string, unknown>> {
  const hasBlock = typeof parsed.blockedStage === "string"
    || typeof parsed.blocked_stage === "string"
    || typeof parsed.blockedReason === "string"
    || typeof parsed.blocked_reason === "string";
  const finalStatus = typeof parsed.finalStatus === "string" ? parsed.finalStatus : typeof parsed.final_status === "string" ? parsed.final_status : null;
  if (hasBlock || finalStatus !== "CMCP_GO_ENGINE_CYCLE_BLOCKED") return parsed;
  const listed = await listEngineTask(SHARED_ENGINE_PATHS);
  const tasks = Array.isArray(listed.tasks) ? listed.tasks as Record<string, unknown>[] : [];
  const normalizedComponent = component.trim().toLowerCase();
  const normalizedWorkspace = path.resolve(workspacePath).toLowerCase();
  const selected = tasks
    .filter((task) => String(task.status ?? "") === "blocked")
    .filter((task) => String(task.component ?? task.component_label ?? "").toLowerCase() === normalizedComponent)
    .filter((task) => path.resolve(String(task.workspace_path ?? "")).toLowerCase() === normalizedWorkspace)
    .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")))[0];
  const taskId = typeof selected?.task_id === "string" ? selected.task_id : null;
  if (!taskId) return parsed;
  const status = await getEngineTaskStatus(SHARED_ENGINE_PATHS, taskId);
  const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : selected;
  return {
    ...parsed,
    taskId,
    blockedStage: task.execution_blocked_stage ?? parsed.blockedStage ?? parsed.blocked_stage ?? null,
    blockedReason: task.execution_blocked_reason ?? parsed.blockedReason ?? parsed.blocked_reason ?? null,
    blockedReceipt: task.execution_blocked_receipt ?? parsed.blockedReceipt ?? parsed.blocked_receipt ?? null,
    nextAction: task.next_action ?? parsed.nextAction ?? parsed.next_action ?? null,
    targetId: task.target_id ?? parsed.targetId ?? parsed.target_id ?? null,
    chatId: task.chat_id ?? parsed.chatId ?? parsed.chat_id ?? null,
  };
}

function parseTrailingJson(output: string): Record<string, unknown> {
  const normalized = output.trim();
  for (let index = normalized.lastIndexOf("\n{"); index >= 0; index = normalized.lastIndexOf("\n{", index - 1)) {
    const candidate = normalized.slice(index + 1);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  const parsed = JSON.parse(normalized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("task-bank runner did not emit a final JSON object");
  return parsed as Record<string, unknown>;
}

async function tick(args: string[]): Promise<Record<string, unknown>> {
  const requestedTaskId = args[0]?.trim();
  return await workerTick(SHARED_ENGINE_PATHS, requestedTaskId || undefined);
}

async function loop(args: string[]): Promise<Record<string, unknown>> {
  const maxTicks = parseMaxTicks(args, 7);
  const taskId = args.find((arg) => !arg.startsWith("--") && !/^M\d+$/i.test(arg))?.trim();
  return await runWorkerLoop(SHARED_ENGINE_PATHS, { taskId: taskId || undefined, maxTicks, stopOnIdle: true, stopOnWaitingUser: true });
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
    recoverComposer: args.includes("--recover-composer"),
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

async function resolveCliGoWorkspace(component: string, explicitWorkspace?: string): Promise<string> {
  if (explicitWorkspace) return path.resolve(explicitWorkspace);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(DEFAULT_WORKSPACE_ROOT, cwd);
  const withinRoot = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  if (withinRoot) {
    try {
      const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.trim().toLowerCase() === component.trim().toLowerCase()) return cwd;
    } catch {}
    if (path.basename(cwd).toLowerCase() === component.trim().toLowerCase()) return cwd;
  }
  return path.resolve(DEFAULT_WORKSPACE_ROOT, COMPONENT_WORKSPACE[component.trim().toLowerCase()] ?? component);
}

function parseGoIterations(args: string[], fallback: number): number {
  const positional = args.find((arg) => /^M\d+$/i.test(arg));
  const explicit = parseOptionalStringOption(args, "--max-auto-iterations=");
  const raw = explicit ?? positional?.slice(1);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : fallback;
}

async function buildCliBrowserExecutorOptions(args: string[]) {
  const policy = await loadConsolePolicy(NORMALIZED_ROOT);
  return {
    policy,
    baseDir: NORMALIZED_ROOT,
    ports: parsePorts(args, [9222, 9223]),
    url: parseStringOption(args, "--url=", "https://chatgpt.com/"),
    activate: !args.includes("--no-activate"),
    allowOverwrite: args.includes("--allow-overwrite"),
    recoverComposer: args.includes("--recover-composer"),
    maxMessages: parseIntOption(args, "--max-messages=", 30, 1, 100),
    timeoutMs: parseIntOption(args, "--timeout-ms=", 10000, 250, 30000),
    readinessProfile: parseReadinessProfile(args),
    maxWaitMs: parseOptionalIntOption(args, "--max-wait-ms=", 1000, 600000),
    observationBudgetMs: parseOptionalIntOption(args, "--observation-budget-ms=", 1000, 60000),
    pollMs: parseOptionalIntOption(args, "--poll-ms=", 250, 5000),
    gatewayModel: parseOptionalStringOption(args, "--gateway-model="),
    gatewayMaxOutputTokens: parseIntOption(args, "--gateway-max-output-tokens=", 1200, 64, 6000),
    gatewayTemperature: parseFloatOption(args, "--gateway-temperature=", 0.1, 0, 2),
    gatewayTimeoutMs: parseIntOption(args, "--gateway-timeout-ms=", 60000, 5000, 180000),
    gatewayRaw: args.includes("--gateway-raw"),
    gatewayConsoleEndpoint: parseOptionalStringOption(args, "--gateway-console-endpoint="),
  };
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
    commands: ["status", "go <component> [M<number>] [--live] [--workspace=<path>] [--recover-composer]", "tick [task-id]", "loop [task-id] [--max-ticks=7]", "cycle-step <task-id> [--execute]", "cycle-run <task-id> [--max-steps=7]", "bank-step [--task-id=<task-id>] [--timeout-ms=3000]", "bank-run [--task-id=<task-id>] [--max-tasks=3] [--max-steps-per-task=2]", "task-status <task-id>", "event-tail [task-id] [--limit=30]"],
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

function compactGoResult(value: Record<string, unknown>): Record<string, unknown> {
  if (value.execution_path === "chatgpt_loop") {
    const blockedStage = value.blockedStage ?? value.blocked_stage ?? value.executionBlockedStage ?? value.execution_blocked_stage ?? null;
    const blockedReason = value.blockedReason ?? value.blocked_reason ?? value.executionBlockedReason ?? value.execution_blocked_reason ?? null;
    const blockedReceipt = objectField(value, "blockedReceipt") ?? objectField(value, "blocked_receipt") ?? objectField(value, "execution_blocked_receipt");
    const forwardedNextAction = value.nextAction ?? value.next_action ?? null;
    return {
      ok: value.ok === true,
      status: value.status ?? null,
      component: value.component ?? null,
      workspace_path: value.workspace_path ?? null,
      max_auto_iterations: value.max_auto_iterations ?? null,
      live: value.live === true,
      execution_path: value.execution_path,
      native_engine_used: value.native_engine_used === true,
      final_status: value.finalStatus ?? null,
      acceptance_status: value.acceptanceStatus ?? null,
      acceptance_failures: value.acceptanceFailures ?? [],
      interaction_cycle_count: value.interactionCycleCount ?? null,
      submitted_count: value.submittedCount ?? null,
      assistant_captured_count: value.assistantCapturedCount ?? null,
      chat_id: value.chatId ?? value.chat_id ?? null,
      target_id: value.targetId ?? value.target_id ?? null,
      blocked_stage: blockedStage,
      blocked_reason: blockedReason,
      reasoning_status: blockedReceipt?.reasoning_status ?? null,
      reasoning_mutation_status: blockedReceipt?.reasoning_mutation_status ?? null,
      reasoning_mutation_picker_label: blockedReceipt?.reasoning_mutation_picker_label ?? null,
      reasoning_mutation_control_sample: blockedReceipt?.reasoning_mutation_control_sample ?? null,
      reasoning_observed_mode: blockedReceipt?.reasoning_observed_mode ?? null,
      reasoning_observed_effort: blockedReceipt?.reasoning_observed_effort ?? null,
      reasoning_observed_model_label: blockedReceipt?.reasoning_observed_model_label ?? null,
      readiness_status: blockedReceipt?.readiness_status ?? null,
      readiness_retryable: blockedReceipt?.readiness_retryable ?? null,
      readiness_attempt_count: blockedReceipt?.readiness_attempt_count ?? null,
      readiness_elapsed_ms: blockedReceipt?.readiness_elapsed_ms ?? null,
      readiness_classification_status: blockedReceipt?.readiness_classification_status ?? null,
      readiness_classification_reason: blockedReceipt?.readiness_classification_reason ?? null,
      readiness_href: blockedReceipt?.readiness_href ?? null,
      readiness_temporary_chat: blockedReceipt?.readiness_temporary_chat ?? null,
      rate_limit_status: blockedReceipt?.rate_limit_status ?? value.rate_limit_status ?? null,
      rate_limit_detected: blockedReceipt?.rate_limit_detected ?? value.rate_limit_detected ?? false,
      rate_limit_attempt: blockedReceipt?.rate_limit_attempt ?? value.rate_limit_attempt ?? null,
      rate_limit_retry_after_ms: blockedReceipt?.rate_limit_retry_after_ms ?? value.rate_limit_retry_after_ms ?? null,
      rate_limit_cooldown_until: blockedReceipt?.rate_limit_cooldown_until ?? value.cooldown_until ?? null,
      rate_limit_remaining_ms: blockedReceipt?.rate_limit_remaining_ms ?? value.cooldown_remaining_ms ?? null,
      rate_limit_dismissed: blockedReceipt?.rate_limit_dismissed ?? null,
      reused_active_task: value.reused_active_task === true,
      acceptance_artifact_path: value.acceptanceArtifactPath ?? value.acceptance_artifact_path ?? null,
      task_bank_path: value.taskBankPath ?? value.task_bank_path ?? null,
      chat_bank_path: value.chatBankPath ?? value.chat_bank_path ?? null,
      next_action: forwardedNextAction,
      error: value.error ?? null,
      stderr: value.stderr ?? null,
    };
  }
  const runN = typeof value.run_n === "object" && value.run_n !== null ? value.run_n as Record<string, unknown> : {};
  const rounds = Array.isArray(runN.rounds) ? runN.rounds as Record<string, unknown>[] : [];
  const lastRound = rounds[rounds.length - 1] ?? {};
  const timeline = Array.isArray(lastRound.timeline) ? lastRound.timeline as Record<string, unknown>[] : [];
  const lastStep = timeline[timeline.length - 1] ?? {};
  const receipt = typeof lastStep.receipt === "object" && lastStep.receipt !== null ? lastStep.receipt as Record<string, unknown> : {};
  const outcome = typeof runN.outcome === "object" && runN.outcome !== null ? runN.outcome as Record<string, unknown> : {};
  return {
    ok: value.ok === true,
    status: value.status ?? null,
    task_id: value.task_id ?? null,
    component: value.component ?? null,
    workspace_path: value.workspace_path ?? null,
    max_auto_iterations: value.max_auto_iterations ?? null,
    live: value.live === true,
    planning_status: typeof value.loop === "object" && value.loop !== null ? (value.loop as Record<string, unknown>).stop_reason ?? null : null,
    execution_status: outcome.status ?? (runN.ok === true ? "completed" : runN.stop_reason ?? null),
    stop_reason: runN.stop_reason ?? null,
    blocked_stage: lastStep.stage ?? outcome.stage ?? null,
    blocked_reason: receipt.inner_status ?? outcome.reason ?? null,
    next_action: outcome.next_action ?? lastStep.next_action ?? null,
    details_omitted: true,
    diagnostic_command: typeof value.task_id === "string" ? `npm run engine -- task-status ${value.task_id}` : null,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main();

