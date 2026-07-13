import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

export type EnginePaths = {
  root: string;
  workspaceRoot: string;
  runDir: string;
  taskDir: string;
  lockDir: string;
  workerDir: string;
  sessionDir: string;
  logDir: string;
  eventLog: string;
  workerLog: string;
  errorLog: string;
};

export type EngineEvent = {
  event_id: string;
  ts: string;
  task_id: string | null;
  event: string;
  source: "cli" | "mcp" | "engine";
  data: Record<string, unknown>;
};

type EngineTask = {
  task_id: string;
  source: "cli" | "mcp";
  component: string;
  component_label: string;
  workspace_path: string;
  status: string;
  created_at: string;
  updated_at: string;
  attempt: number;
  dry_run: boolean;
  next_action: string;
  last_event_id: string | null;
  phase_index?: number;
  phase_key?: string;
  phase_plan?: string[];
  executor_request_id?: string;
  executor_request_path?: string;
  session_binding_id?: string;
  session_binding_path?: string;
  chat_id?: string | null;
  target_id?: string | null;
  current_url?: string | null;
  draft_hash?: string | null;
  draft_length?: number | null;
  prompt_path?: string | null;
  submitted_at?: string | null;
  submitted_hash?: string | null;
  submitted_length?: number | null;
  assistant_hash?: string | null;
  baseline_assistant_hash?: string | null;
  assistant_length?: number | null;
  answer_captured_at?: string | null;
  decision_status?: string | null;
  decision_next_action?: string | null;
  decision_recorded_at?: string | null;
  reply_back_hash?: string | null;
  reply_back_length?: number | null;
  reply_back_path?: string | null;
  reply_back_sent_at?: string | null;
  reply_back_sent_hash?: string | null;
  reply_back_sent_length?: number | null;
  execution_authorized?: boolean;
  execution_authorized_by?: "adopt" | "go";
  execution_authorized_at?: string | null;
  max_auto_iterations?: number | null;
  cycle_round_index?: number;
};

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

const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled", "failed", "blocked"]);

const REPO_RC_PHASE_PLAN = [
  "reconnaissance",
  "workspace_state",
  "boundary_policy",
  "implementation_plan",
  "patch_materialization",
  "gate_execution",
  "status_report",
] as const;

export function createEnginePaths(root: string, workspaceRoot = process.env.CONSOLE_MCP_WORKSPACE_ROOT ?? "D:\\PhpstormProjects\\www"): EnginePaths {
  const runDir = path.join(root, "var", "run", "engine");
  const logDir = path.join(root, "var", "log", "engine");
  return {
    root,
    workspaceRoot: path.resolve(workspaceRoot),
    runDir,
    taskDir: path.join(runDir, "task"),
    lockDir: path.join(runDir, "lock"),
    workerDir: path.join(runDir, "worker"),
    sessionDir: path.join(runDir, "session"),
    logDir,
    eventLog: path.join(logDir, "event.jsonl"),
    workerLog: path.join(logDir, "worker.jsonl"),
    errorLog: path.join(logDir, "error.jsonl"),
  };
}

export type EngineWorkspaceResolution = {
  ok: boolean;
  workspacePath: string;
  source: "explicit" | "component_mapping" | "component_name";
  withinWorkspaceRoot: boolean;
};

export function resolveEngineWorkspacePath(paths: EnginePaths, component: string, explicitWorkspacePath?: string): EngineWorkspaceResolution {
  const source = explicitWorkspacePath
    ? "explicit"
    : (COMPONENT_WORKSPACE[component] ? "component_mapping" : "component_name");
  const workspacePath = explicitWorkspacePath
    ? path.resolve(explicitWorkspacePath)
    : path.resolve(paths.workspaceRoot, COMPONENT_WORKSPACE[component] ?? component);
  const relative = path.relative(paths.workspaceRoot, workspacePath);
  const withinWorkspaceRoot = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
  return { ok: withinWorkspaceRoot, workspacePath, source, withinWorkspaceRoot };
}

export async function enqueueTask(paths: EnginePaths, componentInput: string, live = false, source: "cli" | "mcp" = "mcp", explicitWorkspacePath?: string): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const component = componentInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!component) return { ok: false, error: "component_required" };
  const workspace = resolveEngineWorkspacePath(paths, component, explicitWorkspacePath);
  const workspacePath = workspace.workspacePath;
  const workspaceExists = workspace.ok && existsSync(workspacePath);
  const now = new Date().toISOString();
  const taskId = "engine-" + stamp() + "-" + component + "-" + crypto.randomBytes(3).toString("hex");
  const task: EngineTask = {
    task_id: taskId,
    source,
    component,
    component_label: component.charAt(0).toUpperCase() + component.slice(1),
    workspace_path: workspacePath,
    status: workspaceExists ? "queued" : "blocked",
    created_at: now,
    updated_at: now,
    attempt: 0,
    dry_run: !live,
    next_action: workspaceExists ? "engine tick: reconnaissance" : (workspace.ok ? "fix workspace path or component name" : "workspace path escapes configured workspace root"),
    last_event_id: null,
    phase_index: 0,
    phase_key: REPO_RC_PHASE_PLAN[0],
    phase_plan: [...REPO_RC_PHASE_PLAN],
  };
  const event = await appendEvent(paths, { task_id: taskId, event: workspaceExists ? "task_queued" : "task_blocked", source, data: { component, requested_workspace_path: explicitWorkspacePath ?? null, workspace_path: workspacePath, workspace_path_source: workspace.source, workspace_within_root: workspace.withinWorkspaceRoot, workspace_exists: workspaceExists, dry_run: !live } });
  task.last_event_id = event.event_id;
  await saveTask(paths, task);
  return { ok: workspaceExists, task_id: taskId, status: task.status, component: task.component_label, requested_workspace_path: explicitWorkspacePath ?? null, workspace_path: workspacePath, workspace_path_source: workspace.source, workspace_within_root: workspace.withinWorkspaceRoot, dry_run: !live, next_command: workspaceExists ? "engine tick" : null };
}

export async function getEngineStatus(paths: EnginePaths): Promise<Record<string, unknown>> {
  await ensureReadRuntime(paths);
  const tasks = await readTaskSummary(paths);
  const counts = tasks.reduce<Record<string, number>>((carry, task) => {
    carry[task.status] = (carry[task.status] ?? 0) + 1;
    return carry;
  }, {});
  const latest = (await tailEngineEvent(paths, undefined, 1)).events[0] ?? null;
  return { ok: true, root: paths.root, run_dir: paths.runDir, log_dir: paths.logDir, task_count: tasks.length, counts, latest_event: latest };
}

export async function listEngineTask(paths: EnginePaths): Promise<Record<string, unknown>> {
  await ensureReadRuntime(paths);
  const tasks = await readTaskSummary(paths);
  return { ok: true, count: tasks.length, tasks };
}

export async function workerTick(paths: EnginePaths, taskId?: string): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = taskId ? await readTask(paths, taskId) : (await readTaskSummary(paths)).find((item) => item.status === "queued" || item.status === "planned" || item.status === "running");
  if (!task) {
    const event = await appendEvent(paths, { task_id: null, event: "tick_no_task", source: "engine", data: {} });
    return { ok: true, status: "idle", event_id: event.event_id };
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    const event = await appendEvent(paths, { task_id: task.task_id, event: "tick_skipped_terminal", source: "engine", data: { status: task.status, next_action: task.next_action } });
    return { ok: true, status: "idle", task_id: task.task_id, after_status: task.status, next_action: task.next_action, event_id: event.event_id };
  }
  const lockPath = path.join(paths.lockDir, task.task_id + ".lock");
  if (existsSync(lockPath)) {
    const event = await appendEvent(paths, { task_id: task.task_id, event: "tick_skipped_locked", source: "engine", data: { lock_path: lockPath } });
    return { ok: false, status: "locked", task_id: task.task_id, event_id: event.event_id };
  }
  await writeFile(lockPath, JSON.stringify({ task_id: task.task_id, locked_at: new Date().toISOString(), pid: process.pid }, null, 2), "utf8");
  try {
    normalizePhase(task);
    const before = task.status;
    const phaseBefore = task.phase_key ?? REPO_RC_PHASE_PLAN[0];
    const currentIndex = task.phase_index ?? 0;
    const isLastPhase = currentIndex >= REPO_RC_PHASE_PLAN.length - 1;
    const authorized = isTaskExecutionAuthorized(task);
    const decision = isLastPhase
      ? (authorized
        ? { status: "done", event: "task_phase_plan_complete_dispatch_ready", next: "repo_rc_implementation phase plan complete; execution_authorized=true; dispatch executor wave via console.write.engine.cycle.step/run_n" }
        : { status: "waiting_user", event: "task_waiting_user", next: "repo_rc_implementation phase plan complete; approve executor wave" })
      : { status: "running", event: "task_phase_completed", next: "engine tick: " + REPO_RC_PHASE_PLAN[currentIndex + 1] };
    task.status = decision.status;
    task.phase_index = isLastPhase ? currentIndex : currentIndex + 1;
    task.phase_key = REPO_RC_PHASE_PLAN[task.phase_index];
    task.phase_plan = [...REPO_RC_PHASE_PLAN];
    task.next_action = decision.next;
    task.updated_at = new Date().toISOString();
    const event = await appendEvent(paths, { task_id: task.task_id, event: decision.event, source: "engine", data: { before_status: before, after_status: task.status, phase_before: phaseBefore, phase_after: task.phase_key, next_action: task.next_action, component: task.component, workspace_path: task.workspace_path, dry_run: task.dry_run } });
    const executorRequest = await writeExecutorRequest(paths, task, phaseBefore);
    const executorEvent = await appendEvent(paths, { task_id: task.task_id, event: "executor_request_prepared", source: "engine", data: executorRequest });
    task.executor_request_id = String(executorRequest.request_id);
    task.executor_request_path = String(executorRequest.request_path);
    task.last_event_id = executorEvent.event_id;
    await saveTask(paths, task);
    return { ok: true, task_id: task.task_id, before_status: before, after_status: task.status, phase_before: phaseBefore, phase_after: task.phase_key, event_id: event.event_id, executor_event_id: executorEvent.event_id, next_action: task.next_action, executor_request: executorRequest };
  } finally {
    await rename(lockPath, path.join(paths.lockDir, task.task_id + "." + Date.now() + ".released")).catch(() => undefined);
  }
}

export async function runWorkerLoop(paths: EnginePaths, options: { taskId?: string; maxTicks?: number; stopOnIdle?: boolean; stopOnWaitingUser?: boolean } = {}): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const maxTicks = options.maxTicks === undefined ? null : Math.max(1, Math.min(options.maxTicks, 50));
  const stopOnIdle = options.stopOnIdle ?? true;
  const stopOnWaitingUser = options.stopOnWaitingUser ?? true;
  const loopId = "worker-" + stamp() + "-" + crypto.randomBytes(4).toString("hex");
  const tickResults: Record<string, unknown>[] = [];
  let stopReason = "max_ticks";
  let previousTickSignature: string | null = null;
  for (let index = 0; maxTicks === null || index < maxTicks; index += 1) {
    const result = await workerTick(paths, options.taskId);
    tickResults.push(result);
    await appendWorkerLog(paths, { loop_id: loopId, tick_index: index, result });
    if (stopOnIdle && result.status === "idle") {
      stopReason = "idle";
      break;
    }
    if (stopOnWaitingUser && result.after_status === "waiting_user") {
      stopReason = "waiting_user";
      break;
    }
    if (result.ok === true && typeof result.after_status === "string") {
      const signature = JSON.stringify({ phase_before: result.phase_before ?? null, phase_after: result.phase_after ?? null, next_action: result.next_action ?? null, status: result.after_status });
      if (previousTickSignature !== null && signature === previousTickSignature) {
        stopReason = "ENGINE_WORKER_STALLED_NO_PROGRESS";
        break;
      }
      previousTickSignature = signature;
    } else {
      previousTickSignature = null;
    }
  }
  return { ok: true, loop_id: loopId, task_id: options.taskId ?? null, max_ticks: maxTicks, tick_count: tickResults.length, stop_reason: stopReason, ticks: tickResults };
}

export async function bindEngineChatSession(paths: EnginePaths, taskId: string, bindingInput: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const bindingId = "binding-" + stamp() + "-" + crypto.randomBytes(4).toString("hex");
  const bindingPath = path.join(paths.sessionDir, bindingId + ".json");
  const selected = typeof bindingInput.selected === "object" && bindingInput.selected !== null ? bindingInput.selected as Record<string, unknown> : {};
  const chatId = stringOrNull(bindingInput.chat_id) ?? stringOrNull(selected.chat_id);
  const targetId = stringOrNull(selected.id) ?? stringOrNull(bindingInput.target_id);
  const currentUrl = stringOrNull(bindingInput.current_url) ?? stringOrNull(selected.url);
  const binding = {
    ok: true,
    binding_id: bindingId,
    binding_path: bindingPath,
    task_id: task.task_id,
    component: task.component,
    workspace_path: task.workspace_path,
    chat_id: chatId,
    target_id: targetId,
    current_url: currentUrl,
    status: "ENGINE_CHAT_SESSION_BOUND",
    opened: bindingInput,
    created_at: new Date().toISOString(),
  };
  await writeFile(bindingPath, JSON.stringify(binding, null, 2) + "\n", "utf8");
  const event = await appendEvent(paths, { task_id: task.task_id, event: "executor_chat_bound", source: "engine", data: binding });
  task.session_binding_id = bindingId;
  task.session_binding_path = bindingPath;
  task.chat_id = chatId;
  task.target_id = targetId;
  task.current_url = currentUrl;
  task.last_event_id = event.event_id;
  task.updated_at = new Date().toISOString();
  await saveTask(paths, task);
  return { ...binding, event_id: event.event_id };
}

export async function authorizeEngineTaskExecution(paths: EnginePaths, taskId: string, input: { authorizedBy: "adopt" | "go"; maxAutoIterations: number }): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const authorizedAt = new Date().toISOString();
  const maxAutoIterations = Math.max(1, Math.min(input.maxAutoIterations, 100));
  task.execution_authorized = true;
  task.execution_authorized_by = input.authorizedBy;
  task.execution_authorized_at = authorizedAt;
  task.max_auto_iterations = maxAutoIterations;
  task.updated_at = authorizedAt;
  const event = await appendEvent(paths, { task_id: task.task_id, event: "engine_execution_authorized", source: "engine", data: { authorized_by: input.authorizedBy, authorized_at: authorizedAt, max_auto_iterations: maxAutoIterations, browser_submit: true } });
  task.last_event_id = event.event_id;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, execution_authorized: true, execution_authorized_by: input.authorizedBy, execution_authorized_at: authorizedAt, max_auto_iterations: maxAutoIterations, event_id: event.event_id };
}

export async function isEngineTaskExecutionAuthorized(paths: EnginePaths, taskId: string): Promise<boolean> {
  await ensureReadRuntime(paths);
  const task = await readTask(paths, taskId);
  return task !== null && isTaskExecutionAuthorized(task);
}

function isTaskExecutionAuthorized(task: EngineTask): boolean {
  return task.execution_authorized === true && typeof task.max_auto_iterations === "number" && task.max_auto_iterations > 0;
}

export async function buildEnginePhasePrompt(paths: EnginePaths, taskId: string): Promise<Record<string, unknown>> {
  await ensureReadRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const phase = task.phase_key ?? REPO_RC_PHASE_PLAN[0];
  const prompt = [
    "Engine task execution request.",
    "",
    `Task ID: ${task.task_id}`,
    `Component: ${task.component_label}`,
    `Workspace: ${task.workspace_path}`,
    `Current phase: ${phase}`,
    `Next action: ${task.next_action}`,
    "",
    "Execute only this phase. Return a concise status, changed files if any, gates run, and the next safe action.",
  ].join("\n");
  const promptHash = sha256(prompt);
  const promptPath = path.join(paths.sessionDir, "prompt-" + stamp() + "-" + crypto.randomBytes(4).toString("hex") + ".txt");
  await writeFile(promptPath, prompt + "\n", "utf8");
  return { ok: true, task_id: task.task_id, phase, prompt, prompt_hash: promptHash, prompt_length: prompt.length, prompt_path: promptPath, target_id: task.target_id ?? null };
}

export async function recordEnginePromptDraft(paths: EnginePaths, taskId: string, draft: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const draftHash = stringOrNull(draft.draft_hash);
  const draftLength = numberOrNull(draft.draft_length);
  const promptPath = stringOrNull(draft.prompt_path);
  const event = await appendEvent(paths, { task_id: task.task_id, event: "executor_prompt_drafted", source: "engine", data: { ...draft, draft_hash: draftHash, draft_length: draftLength, prompt_path: promptPath } });
  task.draft_hash = draftHash;
  task.draft_length = draftLength;
  task.prompt_path = promptPath;
  task.last_event_id = event.event_id;
  task.updated_at = new Date().toISOString();
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, draft_hash: draftHash, draft_length: draftLength, prompt_path: promptPath };
}

export async function recordEnginePromptSubmit(paths: EnginePaths, taskId: string, submit: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  if (submit.submitted !== true) return { ok: false, error: "prompt_submit_not_confirmed", task_id: taskId, submitted: false };
  const submittedHash = stringOrNull(submit.current_draft_hash) ?? stringOrNull(submit.submitted_hash) ?? task.draft_hash ?? null;
  const submittedLength = numberOrNull(submit.current_draft_length) ?? numberOrNull(submit.submitted_length) ?? task.draft_length ?? null;
  const submittedAt = new Date().toISOString();
  const event = await appendEvent(paths, { task_id: task.task_id, event: "executor_prompt_submitted", source: "engine", data: { ...submit, submitted_at: submittedAt, submitted_hash: submittedHash, submitted_length: submittedLength } });
  task.submitted_at = submittedAt;
  task.submitted_hash = submittedHash;
  task.submitted_length = submittedLength;
  task.baseline_assistant_hash = stringOrNull(submit.baseline_assistant_hash) ?? task.baseline_assistant_hash ?? null;
  task.last_event_id = event.event_id;
  task.updated_at = submittedAt;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, submitted_at: submittedAt, submitted_hash: submittedHash, submitted_length: submittedLength };
}

export async function recordEngineAnswerCapture(paths: EnginePaths, taskId: string, capture: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const latest = typeof capture.latest_assistant === "object" && capture.latest_assistant !== null ? capture.latest_assistant as Record<string, unknown> : {};
  const assistantHash = stringOrNull(latest.hash) ?? stringOrNull(capture.assistant_hash);
  const text = typeof latest.text === "string" ? latest.text : "";
  const assistantLength = text.length > 0 ? text.length : numberOrNull(capture.assistant_length);
  const selected = typeof capture.selected === "object" && capture.selected !== null ? capture.selected as Record<string, unknown> : {};
  const selectedChatId = stringOrNull(selected.chat_id);
  const selectedTargetId = stringOrNull(selected.id);
  const selectedUrl = stringOrNull(selected.url);
  const capturedAt = new Date().toISOString();
  const event = await appendEvent(paths, { task_id: task.task_id, event: "executor_answer_captured", source: "engine", data: { ...capture, assistant_hash: assistantHash, assistant_length: assistantLength, answer_captured_at: capturedAt } });
  task.assistant_hash = assistantHash;
  task.assistant_length = assistantLength;
  task.answer_captured_at = capturedAt;
  if (selectedChatId) task.chat_id = selectedChatId;
  if (selectedTargetId) task.target_id = selectedTargetId;
  if (selectedUrl) task.current_url = selectedUrl;
  task.last_event_id = event.event_id;
  task.updated_at = capturedAt;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, assistant_hash: assistantHash, assistant_length: assistantLength, answer_captured_at: capturedAt };
}

export async function recordEngineGatewayDecision(paths: EnginePaths, taskId: string, decision: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const parsed = typeof decision.stdout_json === "object" && decision.stdout_json !== null ? decision.stdout_json as Record<string, unknown> : {};
  const directResponse = typeof parsed.direct_response === "object" && parsed.direct_response !== null ? parsed.direct_response as Record<string, unknown> : {};
  const nestedJson = typeof directResponse.json === "object" && directResponse.json !== null ? directResponse.json as Record<string, unknown> : {};
  const decisionStatus = stringOrNull(parsed.status) ?? stringOrNull(parsed.decision_status) ?? stringOrNull(parsed.verdict) ?? stringOrNull(nestedJson.status) ?? stringOrNull(nestedJson.decision_status) ?? stringOrNull(nestedJson.verdict) ?? stringOrNull(decision.status);
  const decisionNextAction = stringOrNull(parsed.next_action) ?? stringOrNull(parsed.decision_next_action) ?? stringOrNull(parsed.recommended_next_action) ?? stringOrNull(nestedJson.next_action) ?? stringOrNull(nestedJson.decision_next_action) ?? stringOrNull(nestedJson.recommended_next_action) ?? stringOrNull(nestedJson.chatgpt_comment);
  const recordedAt = new Date().toISOString();
  const event = await appendEvent(paths, { task_id: task.task_id, event: "engine_decision_recorded", source: "engine", data: { ...decision, decision_status: decisionStatus, decision_next_action: decisionNextAction, decision_recorded_at: recordedAt } });
  task.decision_status = decisionStatus;
  task.decision_next_action = decisionNextAction;
  task.decision_recorded_at = recordedAt;
  task.last_event_id = event.event_id;
  task.updated_at = recordedAt;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, decision_status: decisionStatus, decision_next_action: decisionNextAction, decision_recorded_at: recordedAt };
}

export async function recordEngineReplyBackDraft(paths: EnginePaths, taskId: string, reply: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const replyText = typeof reply.reply_back_text === "string" ? reply.reply_back_text : "";
  const replyHash = stringOrNull(reply.reply_back_hash) ?? (replyText.length > 0 ? sha256(replyText) : null);
  const replyLength = numberOrNull(reply.reply_back_length) ?? (replyText.length > 0 ? replyText.length : null);
  const replyPath = stringOrNull(reply.reply_back_path);
  const event = await appendEvent(paths, { task_id: task.task_id, event: "engine_reply_back_drafted", source: "engine", data: { ...reply, reply_back_hash: replyHash, reply_back_length: replyLength, reply_back_path: replyPath } });
  task.reply_back_hash = replyHash;
  task.reply_back_length = replyLength;
  task.reply_back_path = replyPath;
  task.last_event_id = event.event_id;
  task.updated_at = new Date().toISOString();
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, reply_back_hash: replyHash, reply_back_length: replyLength, reply_back_path: replyPath };
}

export async function recordEngineReplyBackDispatch(paths: EnginePaths, taskId: string, dispatch: Record<string, unknown>): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  if (dispatch.submitted !== true) return { ok: false, error: "reply_back_submit_not_confirmed", task_id: taskId, submitted: false };
  const replyHash = stringOrNull(dispatch.current_draft_hash) ?? stringOrNull(dispatch.reply_back_sent_hash) ?? task.reply_back_hash ?? null;
  const replyLength = numberOrNull(dispatch.current_draft_length) ?? numberOrNull(dispatch.reply_back_sent_length) ?? task.reply_back_length ?? null;
  const recordedAt = new Date().toISOString();
  const event = await appendEvent(paths, { task_id: task.task_id, event: "engine_reply_back_dispatched", source: "engine", data: { ...dispatch, reply_back_sent_at: recordedAt, reply_back_sent_hash: replyHash, reply_back_sent_length: replyLength } });
  task.reply_back_sent_at = recordedAt;
  task.reply_back_sent_hash = replyHash;
  task.reply_back_sent_length = replyLength;
  task.last_event_id = event.event_id;
  task.updated_at = recordedAt;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, event_id: event.event_id, reply_back_sent_at: recordedAt, reply_back_sent_hash: replyHash, reply_back_sent_length: replyLength };
}

export async function resetEngineCycleRoundState(paths: EnginePaths, taskId: string): Promise<Record<string, unknown>> {
  await ensureWriteRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const completedRoundIndex = task.cycle_round_index ?? 0;
  const nextRoundIndex = completedRoundIndex + 1;
  const previousAssistantHash = task.assistant_hash ?? null;
  const nextPromptHash = task.reply_back_sent_hash ?? task.reply_back_hash ?? null;
  const nextPromptLength = task.reply_back_sent_length ?? task.reply_back_length ?? null;
  const nextPromptPath = task.reply_back_path ?? null;
  const nextSubmittedAt = task.reply_back_sent_at ?? null;
  task.cycle_round_index = nextRoundIndex;
  task.draft_hash = nextPromptHash;
  task.draft_length = nextPromptLength;
  task.prompt_path = nextPromptPath;
  task.submitted_at = nextSubmittedAt;
  task.submitted_hash = nextPromptHash;
  task.submitted_length = nextPromptLength;
  task.baseline_assistant_hash = previousAssistantHash;
  task.assistant_hash = null;
  task.assistant_length = null;
  task.answer_captured_at = null;
  task.decision_status = null;
  task.decision_next_action = null;
  task.decision_recorded_at = null;
  task.reply_back_hash = null;
  task.reply_back_length = null;
  task.reply_back_path = null;
  task.reply_back_sent_at = null;
  task.reply_back_sent_hash = null;
  task.reply_back_sent_length = null;
  const recordedAt = new Date().toISOString();
  task.updated_at = recordedAt;
  const event = await appendEvent(paths, { task_id: task.task_id, event: "engine_cycle_round_reset", source: "engine", data: { completed_round_index: completedRoundIndex, next_round_index: nextRoundIndex, chat_id: task.chat_id ?? null, target_id: task.target_id ?? null } });
  task.last_event_id = event.event_id;
  await saveTask(paths, task);
  return { ok: true, task_id: task.task_id, completed_round_index: completedRoundIndex, next_round_index: nextRoundIndex, event_id: event.event_id };
}

export async function getEngineTaskStatus(paths: EnginePaths, taskId: string): Promise<Record<string, unknown>> {
  await ensureReadRuntime(paths);
  const task = await readTask(paths, taskId);
  if (!task) return { ok: false, error: "task_not_found", task_id: taskId };
  const events = (await readEvent(paths)).filter((event) => event.task_id === taskId).slice(-20);
  return { ok: true, task, events };
}

export async function tailEngineEvent(paths: EnginePaths, taskId?: string, limit = 30): Promise<{ ok: true; task_id: string | null; count: number; events: EngineEvent[] }> {
  await ensureReadRuntime(paths);
  const safeLimit = Number.isFinite(limit) && limit > 0 && limit <= 500 ? limit : 30;
  const events = (await readEvent(paths)).filter((event) => !taskId || event.task_id === taskId).slice(-safeLimit);
  return { ok: true, task_id: taskId ?? null, count: events.length, events };
}

async function ensureWriteRuntime(paths: EnginePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.taskDir, { recursive: true }),
    mkdir(paths.lockDir, { recursive: true }),
    mkdir(paths.workerDir, { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(paths.logDir, { recursive: true }),
  ]);
  await Promise.all([touch(paths.eventLog), touch(paths.workerLog), touch(paths.errorLog)]);
}

async function ensureReadRuntime(paths: EnginePaths): Promise<void> {
  await Promise.all([mkdir(paths.taskDir, { recursive: true }), mkdir(paths.logDir, { recursive: true })]);
}

async function writeExecutorRequest(paths: EnginePaths, task: EngineTask, phaseBefore: string): Promise<Record<string, unknown>> {
  const requestId = "executor-" + stamp() + "-" + crypto.randomBytes(4).toString("hex");
  const requestPath = path.join(paths.sessionDir, requestId + ".json");
  const request = {
    ok: true,
    request_id: requestId,
    request_path: requestPath,
    executor: "chatgpt_browser",
    mode: "prepare_only",
    action: "repo_rc_phase_execution_request",
    task_id: task.task_id,
    component: task.component,
    workspace_path: task.workspace_path,
    dry_run: task.dry_run,
    phase_before: phaseBefore,
    phase_after: task.phase_key,
    next_action: task.next_action,
    safety_boundary: "no_browser_mutation_in_wave_5",
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2) + "\n", "utf8");
  return request;
}

function normalizePhase(task: EngineTask): void {
  const index = Number.isInteger(task.phase_index) ? task.phase_index as number : 0;
  task.phase_index = Math.max(0, Math.min(index, REPO_RC_PHASE_PLAN.length - 1));
  task.phase_plan = [...REPO_RC_PHASE_PLAN];
  task.phase_key = REPO_RC_PHASE_PLAN[task.phase_index] ?? REPO_RC_PHASE_PLAN[0];
}

async function touch(filePath: string): Promise<void> {
  if (!existsSync(filePath)) await writeFile(filePath, "", "utf8");
}

async function saveTask(paths: EnginePaths, task: EngineTask): Promise<void> {
  await writeFile(path.join(paths.taskDir, task.task_id + ".json"), JSON.stringify(task, null, 2) + "\n", "utf8");
}

async function appendEvent(paths: EnginePaths, input: Omit<EngineEvent, "event_id" | "ts">): Promise<EngineEvent> {
  const event: EngineEvent = { event_id: "event-" + stamp() + "-" + crypto.randomBytes(4).toString("hex"), ts: new Date().toISOString(), ...input };
  await writeFile(paths.eventLog, JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
  return event;
}

async function appendWorkerLog(paths: EnginePaths, data: Record<string, unknown>): Promise<void> {
  await writeFile(paths.workerLog, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n", { encoding: "utf8", flag: "a" });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function readTask(paths: EnginePaths, taskId: string): Promise<EngineTask | null> {
  const filePath = path.join(paths.taskDir, taskId + ".json");
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8")) as EngineTask;
}

async function readTaskSummary(paths: EnginePaths): Promise<EngineTask[]> {
  if (!existsSync(paths.taskDir)) return [];
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(paths.taskDir)).filter((file) => file.endsWith(".json"));
  const tasks = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(paths.taskDir, file), "utf8")) as EngineTask));
  return tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function readEvent(paths: EnginePaths): Promise<EngineEvent[]> {
  if (!existsSync(paths.eventLog)) return [];
  const raw = await readFile(paths.eventLog, "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as EngineEvent);
}
