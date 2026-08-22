import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import { createChatGptArtifactCursor, createChatGptSessionBinding, extractChatGptChatId, hashChatGptArtifactText } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type BoundTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null };
type CapturedMessage = { role: "user" | "assistant" | "system" | "unknown"; text: string; hash: string; index: number };
type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };
type AnswerSettleTiming = { maxWaitMs: number; observationBudgetMs: number; pollMs: number; minStableSamples: number; idleQuietMs: number; composerStopConfirmMs: number };
type OutlineMetrics = { visible: boolean; section_count: number; hash: string | null; latest_section_text: string | null; latest_section_hash: string | null };
type ScrollMetrics = { height: number; top: number; viewport_height: number; latest_assistant_bottom: number | null };
type ClientStreamErrorSignal = { detected: boolean; mode: string; text: string | null; retry_visible: boolean; connecting_to_app: boolean; error_in_message_stream: boolean; delivery_timed_out: boolean; rate_limited: boolean };
type LatestAssistantControls = { copy_visible: boolean; retry_visible: boolean; regenerate_visible: boolean; rethink_visible: boolean; button_count: number; labels: string[] };

const messageCaptureInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  expectedTargetId: z.string().min(1).optional(),
  expectedTaskId: z.string().min(1).max(200).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
}).strict();

const answerSettleInputSchema = messageCaptureInputSchema.extend({
  baselineAssistantHash: z.string().min(1).optional(),
  lastGuardedAssistantHash: z.string().min(1).optional(),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  minStableSamples: z.number().int().min(2).max(30).optional(),
  idleQuietMs: z.number().int().min(1000).max(300000).optional(),
  composerStopConfirmMs: z.number().int().min(1000).max(300000).optional(),
  requireComposerSendMode: z.boolean().default(false),
}).strict();

const watchTaskClassSchema = z.enum(["startup_light", "tiny_validation", "short_reply", "normal_answer", "code_patch", "repo_scan", "repo_rc_implementation", "repair_iteration"]);

const watchProbeInputSchema = messageCaptureInputSchema.extend({
  phase: z.enum(["startup", "after_send", "reply_watch", "settle_gate"]).default("reply_watch"),
  taskClass: watchTaskClassSchema.default("normal_answer"),
  sentAt: z.string().min(1).optional(),
  baselineAssistantHash: z.string().min(1).optional(),
  previousAssistantHash: z.string().min(1).optional(),
  previousTextLength: z.number().int().min(0).optional(),
  previousTailHash: z.string().min(1).optional(),
  previousOutlineHash: z.string().min(1).optional(),
  previousOutlineSectionCount: z.number().int().min(0).optional(),
  previousScrollHeight: z.number().int().min(0).optional(),
  lastProgressAt: z.string().min(1).optional(),
  attempt: z.number().int().min(0).max(1000).default(0),
  inputTokens: z.number().int().min(0).max(200000).optional(),
  expectedOutputTokens: z.number().int().min(0).max(200000).optional(),
}).strict();

const watchNextInputSchema = z.object({
  phase: z.enum(["startup", "after_send", "reply_watch", "settle_gate"]).default("reply_watch"),
  taskClass: watchTaskClassSchema.default("normal_answer"),
  sentAt: z.string().min(1).optional(),
  lastProgressAt: z.string().min(1).optional(),
  attempt: z.number().int().min(0).max(1000).default(0),
  currentStatus: z.string().min(1).optional(),
  progressSeen: z.boolean().optional(),
  composerActionMode: z.string().min(1).optional(),
  devtoolsOk: z.boolean().default(true),
  chatBindingOk: z.boolean().default(true),
  inputTokens: z.number().int().min(0).max(200000).optional(),
  expectedOutputTokens: z.number().int().min(0).max(200000).optional(),
}).strict();

const messageControlClickInputSchema = messageCaptureInputSchema.extend({
  action: z.enum(["copy", "retry", "regenerate", "rethink"]),
  confirmAction: z.boolean().default(false),
}).strict();

const sessionControlInventoryInputSchema = messageCaptureInputSchema;

const sessionControlCopyInputSchema = messageCaptureInputSchema.extend({
  confirmCopy: z.boolean().default(false),
}).strict();

const sessionControlActivateInputSchema = messageCaptureInputSchema.extend({
  controlName: z.enum(["retry", "regenerate", "rethink"]),
  confirmControlActivation: z.boolean().default(false),
}).strict();

const runLoopPlanInputSchema = z.object({
  phase: z.enum(["startup", "after_send", "reply_watch", "pre_ask", "return_to_chat"]).default("reply_watch"),
  taskClass: watchTaskClassSchema.default("normal_answer"),
  iteration: z.number().int().min(0).max(1000).default(0),
  maxIterations: z.number().int().min(1).max(1000).default(20),
  watchStatus: z.string().min(1).optional(),
  watchNextAction: z.string().min(1).optional(),
  watchNextProbeAfterMs: z.number().int().min(0).optional(),
  preAskStatus: z.string().min(1).optional(),
  preAskReady: z.boolean().optional(),
  sentAt: z.string().min(1).optional(),
  lastProgressAt: z.string().min(1).optional(),
  attempt: z.number().int().min(0).max(1000).default(0),
  chatId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  beforeHead: z.string().min(1).optional(),
  lastSeenAssistantHash: z.string().min(1).optional(),
  lastSeenTextLength: z.number().int().min(0).optional(),
  lastSeenTailHash: z.string().min(1).optional(),
  lastSeenOutlineHash: z.string().min(1).optional(),
  lastSeenOutlineSectionCount: z.number().int().min(0).optional(),
  lastSeenScrollHeight: z.number().int().min(0).optional(),
}).strict();

export function registerChatGptMessageCaptureTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.browser.chatgpt.message.capture", {
    description: "Read-only capture preparation for ChatGPT user and assistant messages from a supervised browser tab.",
    inputSchema: messageCaptureInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await captureChatGptMessages(input)));

  server.registerTool("console.read_.browser.chatgpt.answer.settle", {
    description: "Read-only watcher that waits until the latest ChatGPT assistant answer is stable before ASK or semantic gate verification.",
    inputSchema: answerSettleInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await settleChatGptAnswer(input)));

  server.registerTool("console.read_.browser.chatgpt.watch.probe", {
    description: "Read-only lightweight ChatGPT watch probe with progress signals, outline metrics, scroll metrics, and next-action recommendation.",
    inputSchema: watchProbeInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await probeChatGptWatch(input)));

  server.registerTool("console.read_.browser.chatgpt.watch.next", {
    description: "Read-only ChatGPT watch policy decision from task class, timing, and progress evidence.",
    inputSchema: watchNextInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(planChatGptWatchNext(input)));

  server.registerTool("console.read_.browser.chatgpt.run.loop.plan", {
    description: "Read-only ChatGPT run-loop planner that turns watch/pre-ASK status and iteration context into the next orchestration action.",
    inputSchema: runLoopPlanInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(planChatGptRunLoop(input)));

  server.registerTool("console.read_.browser.session.control.inventory", {
    description: "Read visible controls for the latest assistant artifact in the bound browser session. It does not click controls.",
    inputSchema: sessionControlInventoryInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await inventoryLatestAssistantSessionControls(input)));

  server.registerTool("console.write.browser.session.control.copy", {
    description: "Copy the latest assistant artifact through a visible copy control after explicit confirmation.",
    inputSchema: sessionControlCopyInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await copyLatestAssistantSessionControl(input)));

  server.registerTool("console.write.browser.session.control.activate", {
    description: "Activate a visible retry, regenerate, or rethink control for the latest assistant artifact after explicit confirmation.",
    inputSchema: sessionControlActivateInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await activateLatestAssistantSessionControl(input)));

}

async function captureChatGptMessages(input: z.infer<typeof messageCaptureInputSchema>): Promise<Record<string, unknown>> {
  const tabResult = await findChatGptTarget(input);
  if (!tabResult.ok || tabResult.target === null) {
    return { ...tabResult, messages: [], latest_assistant: null, policy: buildMessageCapturePolicy() };
  }
  const target = tabResult.target;
  if (input.requireChatId && target.chat_id === null) {
    return { ...tabResult, ok: false, status: "NEED_CHAT_ID", messages: [], latest_assistant: null, policy: buildMessageCapturePolicy() };
  }
  if (!target.web_socket_debugger_url) {
    return { ...tabResult, ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", messages: [], latest_assistant: null, policy: buildMessageCapturePolicy() };
  }
  const rawMessages = await evaluateMessageDom(target.web_socket_debugger_url, input.maxMessages, input.timeoutMs);
  const messages = normalizeMessages(rawMessages, input.maxMessages);
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const binding = target.chat_id === null ? null : createChatGptSessionBinding({ url: target.url ?? "", boundAt: new Date().toISOString(), baselineAssistantHash: latestAssistant?.hash ?? null });
  return {
    ok: true,
    status: "MESSAGES_CAPTURED",
    selected: target,
    scans: tabResult.scans,
    binding,
    cursor: binding === null ? null : createChatGptArtifactCursor(binding),
    messages,
    latest_assistant: latestAssistant,
    policy: buildMessageCapturePolicy(),
  };
}

export const runChatGptMessageCapture = captureChatGptMessages;
export const runChatGptAnswerSettle = settleChatGptAnswer;
export const runChatGptWatchProbe = probeChatGptWatch;
export const runChatGptWatchNext = planChatGptWatchNext;
export const runChatGptRunLoopPlan = planChatGptRunLoop;

async function inventoryLatestAssistantSessionControls(input: z.infer<typeof sessionControlInventoryInputSchema>): Promise<Record<string, unknown>> {
  const probe = await probeChatGptWatch({ ...input, phase: "reply_watch", taskClass: "normal_answer", attempt: 0 });
  const latestAssistantControls = (probe.probe as { latest_assistant_controls?: unknown } | null)?.latest_assistant_controls ?? null;
  return { ok: probe.ok === true, status: probe.ok === true ? "SESSION_CONTROL_INVENTORY_READY" : "SESSION_CONTROL_INVENTORY_BLOCKED", selected: probe.selected ?? null, controls: latestAssistantControls, policy: buildSessionControlInventoryPolicy() };
}

async function copyLatestAssistantSessionControl(input: z.infer<typeof sessionControlCopyInputSchema>): Promise<Record<string, unknown>> {
  const result = await clickLatestAssistantMessageControl({ ...input, action: "copy", confirmAction: input.confirmCopy });
  return { ...result, status: result.ok === true ? "SESSION_CONTROL_COPIED" : String(result.status ?? "SESSION_CONTROL_COPY_BLOCKED"), policy: buildSessionControlCopyPolicy() };
}

async function activateLatestAssistantSessionControl(input: z.infer<typeof sessionControlActivateInputSchema>): Promise<Record<string, unknown>> {
  const result = await clickLatestAssistantMessageControl({ ...input, action: input.controlName, confirmAction: input.confirmControlActivation });
  return { ...result, status: result.ok === true ? "SESSION_CONTROL_ACTIVATED" : String(result.status ?? "SESSION_CONTROL_ACTIVATION_BLOCKED"), control_name: input.controlName, policy: buildSessionControlActivatePolicy() };
}

async function clickLatestAssistantMessageControl(input: z.infer<typeof messageControlClickInputSchema>): Promise<Record<string, unknown>> {
  const tabResult = await findChatGptTarget(input);
  if (!tabResult.ok || tabResult.target === null) {
    return { ...tabResult, ok: false, status: "CONTROL_TARGET_NOT_BOUND", clicked: false, policy: buildMessageControlClickPolicy() };
  }
  const target = tabResult.target;
  if (input.requireChatId && target.chat_id === null) {
    return { ...tabResult, ok: false, status: "NEED_CHAT_ID", clicked: false, policy: buildMessageControlClickPolicy() };
  }
  if (!target.web_socket_debugger_url) {
    return { ...tabResult, ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", clicked: false, policy: buildMessageControlClickPolicy() };
  }
  if (!input.confirmAction) {
    return { ok: false, status: "CONFIRM_MESSAGE_CONTROL_CLICK_REQUIRED", clicked: false, action: input.action, selected: target, scans: tabResult.scans, policy: buildMessageControlClickPolicy() };
  }

  const result = await evaluateLatestAssistantControlClick(target.web_socket_debugger_url, input.action, input.timeoutMs);
  const clicked = typeof result === "object" && result !== null && (result as Record<string, unknown>).clicked === true;
  return { ok: clicked, status: clicked ? "MESSAGE_CONTROL_CLICKED" : "MESSAGE_CONTROL_NOT_AVAILABLE", action: input.action, selected: target, scans: tabResult.scans, result, policy: buildMessageControlClickPolicy() };
}

async function probeChatGptWatch(input: z.infer<typeof watchProbeInputSchema>): Promise<Record<string, unknown>> {
  const tabResult = await findChatGptTarget(input);
  if (!tabResult.ok || tabResult.target === null) {
    return {
      ...tabResult,
      ok: false,
      status: "TRANSPORT_UNHEALTHY",
      probe: null,
      decision: planChatGptWatchNext({ ...input, devtoolsOk: false, chatBindingOk: false, currentStatus: "TRANSPORT_UNHEALTHY" }),
      policy: buildWatchPolicy(),
    };
  }

  const target = tabResult.target;
  if (input.requireChatId && target.chat_id === null) {
    return {
      ...tabResult,
      ok: false,
      status: "CHAT_BINDING_LOST",
      probe: null,
      decision: planChatGptWatchNext({ ...input, devtoolsOk: true, chatBindingOk: false, currentStatus: "CHAT_BINDING_LOST" }),
      policy: buildWatchPolicy(),
    };
  }
  if (!target.web_socket_debugger_url) {
    return {
      ...tabResult,
      ok: false,
      status: "TRANSPORT_UNHEALTHY",
      probe: null,
      decision: planChatGptWatchNext({ ...input, devtoolsOk: false, chatBindingOk: Boolean(target.chat_id), currentStatus: "TRANSPORT_UNHEALTHY" }),
      policy: buildWatchPolicy(),
    };
  }

  let rawState: unknown;
  try {
    rawState = await evaluateConversationState(target.web_socket_debugger_url, input.maxMessages, input.timeoutMs);
  } catch (error) {
    return {
      ok: false,
      status: "TRANSPORT_UNHEALTHY",
      selected: target,
      scans: tabResult.scans,
      error: error instanceof Error ? error.message : String(error),
      probe: null,
      decision: planChatGptWatchNext({ ...input, devtoolsOk: false, chatBindingOk: Boolean(target.chat_id), currentStatus: "TRANSPORT_UNHEALTHY" }),
      policy: buildWatchPolicy(),
    };
  }

  const state = normalizeConversationState(rawState, input.maxMessages);
  const latestAssistant = state.latestAssistant;
  const latestHash = latestAssistant?.hash ?? null;
  const textLength = latestAssistant?.text.length ?? 0;
  const tailText = latestAssistant?.text.slice(-500) ?? "";
  const tailHash = tailText === "" ? null : hashChatGptArtifactText(tailText);
  const progress = buildWatchProgressEvidence(input, state, latestHash, textLength, tailHash);
  const currentStatus = classifyWatchProbeStatus(input, state, progress);
  const decision = planChatGptWatchNext({
    ...input,
    currentStatus,
    progressSeen: progress.progress_seen,
    composerActionMode: state.composerActionMode,
    devtoolsOk: true,
    chatBindingOk: !input.requireChatId || target.chat_id !== null,
  });

  return {
    ok: true,
    status: currentStatus,
    selected: target,
    scans: tabResult.scans,
    messages: state.messages,
    latest_assistant: latestAssistant,
    probe: {
      phase: input.phase,
      task_class: input.taskClass,
      attempt: input.attempt,
      latest_assistant_hash: latestHash,
      latest_assistant_text_length: textLength,
      latest_assistant_tail_hash: tailHash,
      composer_action_mode: state.composerActionMode,
      composer_stop_control_mode: state.composerStopControlMode,
      busy: state.busy,
      devtools_ok: true,
      chat_binding_ok: !input.requireChatId || target.chat_id !== null,
      outline: state.outline,
      scroll: state.scroll,
      tail_activity_mode: state.tailActivityMode,
      animated_status_mode: state.animatedStatusMode,
      client_stream_error: state.clientStreamError,
      latest_assistant_controls: state.latestAssistantControls,
    },
    progress,
    decision,
    context_update: {
      phase: input.phase,
      taskClass: input.taskClass,
      chatId: target.chat_id,
      sentAt: input.sentAt ?? null,
      lastSeenAssistantHash: latestHash,
      lastSeenTextLength: textLength,
      lastSeenTailHash: tailHash,
      lastSeenOutlineHash: state.outline.hash,
      lastSeenOutlineSectionCount: state.outline.section_count,
      lastSeenScrollHeight: state.scroll.height,
      lastProgressAt: progress.progress_seen ? new Date().toISOString() : (input.lastProgressAt ?? null),
      attempt: input.attempt + 1,
    },
    policy: buildWatchPolicy(),
  };
}

function planChatGptRunLoop(input: z.infer<typeof runLoopPlanInputSchema>): Record<string, unknown> {
  const stopReason = input.iteration >= input.maxIterations ? "max_iterations_reached" : null;
  if (stopReason !== null) {
    return buildRunLoopPlan(input, "STOP_FOR_USER", "RUN_LOOP_STOPPED", null, stopReason);
  }

  if (input.preAskReady === true || input.preAskStatus === "PRE_ASK_READY") {
    return buildRunLoopPlan(input, "RETURN_TO_CHAT", "PRE_ASK_READY", 0, "pre_ask_ready");
  }

  if (input.preAskStatus && input.preAskStatus.startsWith("PRE_ASK_BLOCKED_")) {
    return buildRunLoopPlan(input, "STOP_FOR_USER", input.preAskStatus, null, "pre_ask_blocked");
  }

  if (input.preAskStatus === "PRE_ASK_WAITING_REPLY") {
    return buildRunLoopPlan(input, "WAIT_AND_PROBE", "PRE_ASK_WAITING_REPLY", input.watchNextProbeAfterMs ?? null, "pre_ask_watch_waiting");
  }

  if (input.watchStatus === "READY_FOR_STABLE_CAPTURE") {
    return buildRunLoopPlan(input, "RUN_PRE_ASK_CAPTURE", "READY_FOR_STABLE_CAPTURE", 0, "watch_ready_for_stable_capture");
  }

  if (input.watchStatus === "TRANSPORT_UNHEALTHY" || input.watchStatus === "CHAT_BINDING_LOST" || input.watchStatus === "CLIENT_STREAM_ERROR" || input.watchStatus === "HUNG_STREAM_CANDIDATE" || input.watchStatus === "MAX_WATCH_EXPIRED") {
    return buildRunLoopPlan(input, "STOP_FOR_USER", input.watchStatus, null, "watch_hard_stop");
  }

  if (input.watchNextAction === "WAIT_AND_PROBE" || input.watchStatus === "STREAMING_PROGRESS" || input.watchStatus === "STREAMING_NO_RECENT_PROGRESS" || input.watchStatus === "WAITING_INITIAL_COOLDOWN" || input.watchStatus === "PROBING" || input.watchStatus === "STARTUP_WAITING_FOR_COMPOSER") {
    return buildRunLoopPlan(input, "WAIT_AND_PROBE", input.watchStatus ?? "WATCH_WAITING", input.watchNextProbeAfterMs ?? 30000, "watch_requires_more_observation");
  }

  if (input.phase === "startup") {
    return buildRunLoopPlan(input, "RUN_WATCH_PROBE", "STARTUP_PROBE_REQUIRED", 0, "startup_needs_probe");
  }

  return buildRunLoopPlan(input, "RUN_WATCH_PROBE", input.watchStatus ?? "WATCH_PROBE_REQUIRED", 0, "default_probe_required");
}

function buildRunLoopPlan(input: z.infer<typeof runLoopPlanInputSchema>, nextAction: string, status: string, delayMs: number | null, reason: string): Record<string, unknown> {
  return {
    ok: nextAction !== "STOP_FOR_USER",
    status,
    next_action: nextAction,
    next_probe_after_ms: delayMs,
    reason,
    iteration: input.iteration,
    next_iteration: nextAction === "RETURN_TO_CHAT" ? input.iteration + 1 : input.iteration,
    context: {
      phase: input.phase,
      taskClass: input.taskClass,
      chatId: input.chatId ?? null,
      workspacePath: input.workspacePath ?? null,
      beforeHead: input.beforeHead ?? null,
      sentAt: input.sentAt ?? null,
      lastProgressAt: input.lastProgressAt ?? null,
      attempt: input.attempt,
      lastSeenAssistantHash: input.lastSeenAssistantHash ?? null,
      lastSeenTextLength: input.lastSeenTextLength ?? null,
      lastSeenTailHash: input.lastSeenTailHash ?? null,
      lastSeenOutlineHash: input.lastSeenOutlineHash ?? null,
      lastSeenOutlineSectionCount: input.lastSeenOutlineSectionCount ?? null,
      lastSeenScrollHeight: input.lastSeenScrollHeight ?? null,
    },
    recommended_call: buildRunLoopRecommendedCall(input, nextAction),
    policy: {
      browser_mutation: false,
      prompt_injection: false,
      auto_submit: false,
      dom_write: false,
      schedules_future_work: false,
    },
  };
}

function buildRunLoopRecommendedCall(input: z.infer<typeof runLoopPlanInputSchema>, nextAction: string): Record<string, unknown> | null {
  if (nextAction === "RUN_WATCH_PROBE" || nextAction === "WAIT_AND_PROBE") {
    return {
      tool: "console.read_.browser.chatgpt.watch.probe",
      arguments: {
        preferredChatId: input.chatId ?? undefined,
        phase: input.phase === "pre_ask" || input.phase === "return_to_chat" ? "reply_watch" : input.phase,
        taskClass: input.taskClass,
        sentAt: input.sentAt,
        previousAssistantHash: input.lastSeenAssistantHash,
        previousTextLength: input.lastSeenTextLength,
        previousTailHash: input.lastSeenTailHash,
        previousOutlineHash: input.lastSeenOutlineHash,
        previousOutlineSectionCount: input.lastSeenOutlineSectionCount,
        previousScrollHeight: input.lastSeenScrollHeight,
        lastProgressAt: input.lastProgressAt,
        attempt: input.attempt + 1,
      },
    };
  }
  if (nextAction === "RUN_PRE_ASK_CAPTURE") {
    return {
      tool: "console.read_.browser.chatgpt.implementation.pre_ask.capture",
      arguments: {
        workspacePath: input.workspacePath,
        beforeHead: input.beforeHead,
        preferredChatId: input.chatId,
        watchMode: "probe_only",
        watchPhase: "reply_watch",
        watchTaskClass: input.taskClass,
        watchSentAt: input.sentAt,
        watchLastProgressAt: input.lastProgressAt,
        watchAttempt: input.attempt,
        watchPreviousAssistantHash: input.lastSeenAssistantHash,
        watchPreviousTextLength: input.lastSeenTextLength,
        watchPreviousTailHash: input.lastSeenTailHash,
        watchPreviousOutlineHash: input.lastSeenOutlineHash,
        watchPreviousOutlineSectionCount: input.lastSeenOutlineSectionCount,
        watchPreviousScrollHeight: input.lastSeenScrollHeight,
      },
    };
  }
  return null;
}

function buildWatchProgressEvidence(
  input: z.infer<typeof watchProbeInputSchema>,
  state: NormalizedConversationState,
  latestHash: string | null,
  textLength: number,
  tailHash: string | null,
): Record<string, unknown> & { progress_seen: boolean } {
  const evidence = {
    assistant_hash_changed: Boolean(input.previousAssistantHash && latestHash && input.previousAssistantHash !== latestHash),
    assistant_hash_newer_than_baseline: Boolean(input.baselineAssistantHash && latestHash && input.baselineAssistantHash !== latestHash),
    assistant_text_length_grew: typeof input.previousTextLength === "number" && textLength > input.previousTextLength,
    assistant_tail_hash_changed: Boolean(input.previousTailHash && tailHash && input.previousTailHash !== tailHash),
    outline_section_count_changed: typeof input.previousOutlineSectionCount === "number" && state.outline.section_count !== input.previousOutlineSectionCount,
    outline_hash_changed: Boolean(input.previousOutlineHash && state.outline.hash && input.previousOutlineHash !== state.outline.hash),
    scroll_height_changed: typeof input.previousScrollHeight === "number" && state.scroll.height !== input.previousScrollHeight,
    composer_stop_visible: state.composerActionMode === "stop",
    active_busy_signal: state.busy,
  };
  const strongSignals = [evidence.assistant_hash_changed, evidence.assistant_text_length_grew, evidence.assistant_tail_hash_changed];
  const supplementalSignals = [evidence.outline_section_count_changed, evidence.outline_hash_changed, evidence.scroll_height_changed, evidence.active_busy_signal];
  const progressSeen = strongSignals.some(Boolean) || supplementalSignals.some(Boolean);
  const progressScore = Math.min(1, strongSignals.filter(Boolean).length * 0.35 + supplementalSignals.filter(Boolean).length * 0.15);
  return { ...evidence, progress_seen: progressSeen, progress_score: progressScore };
}

function classifyWatchProbeStatus(input: z.infer<typeof watchProbeInputSchema>, state: NormalizedConversationState, progress: { progress_seen: boolean }): string {
  if (state.clientStreamError.detected) {
    return state.clientStreamError.mode === "rate_limited" ? "RATE_LIMITED" : "CLIENT_STREAM_ERROR";
  }

  if (input.phase === "startup") {
    return state.composerActionMode === "send" || state.composerActionMode === "disabled" ? "STARTUP_READY" : "STARTUP_WAITING_FOR_COMPOSER";
  }

  if (progress.progress_seen) {
    return "STREAMING_PROGRESS";
  }

  if (state.composerActionMode === "stop") {
    return "STREAMING_NO_RECENT_PROGRESS";
  }

  if (state.composerActionMode === "send") {
    return "LIKELY_STABLE";
  }

  return state.busy ? "PROBING" : "LIKELY_STABLE";
}

function planChatGptWatchNext(input: z.infer<typeof watchNextInputSchema>): Record<string, unknown> {
  const policy = resolveWatchPolicy(input);
  const now = Date.now();
  const sentAtMs = parseTimeMs(input.sentAt);
  const lastProgressAtMs = parseTimeMs(input.lastProgressAt);
  const elapsedSinceSendMs = sentAtMs === null ? null : Math.max(0, now - sentAtMs);
  const lastProgressAgeMs = lastProgressAtMs === null
    ? elapsedSinceSendMs
    : Math.max(0, now - lastProgressAtMs);

  if (!input.devtoolsOk) {
    return { status: "TRANSPORT_UNHEALTHY", next_action: "STOP_FOR_USER_OR_REFRESH", next_probe_after_ms: null, soft_recovery_actions: buildSoftRecoveryActions("TRANSPORT_UNHEALTHY"), policy, evidence: { devtools_ok: false, chat_binding_ok: input.chatBindingOk } };
  }
  if (!input.chatBindingOk) {
    return { status: "CHAT_BINDING_LOST", next_action: "STOP_FOR_USER_OR_REBIND", next_probe_after_ms: null, soft_recovery_actions: buildSoftRecoveryActions("CHAT_BINDING_LOST"), policy, evidence: { devtools_ok: input.devtoolsOk, chat_binding_ok: false } };
  }

  if (input.currentStatus === "CLIENT_STREAM_ERROR") {
    return { status: "CLIENT_STREAM_ERROR", next_action: "STOP_FOR_USER_OR_RETRY", next_probe_after_ms: null, soft_recovery_actions: buildSoftRecoveryActions("CLIENT_STREAM_ERROR"), policy, evidence: { client_stream_error: true } };
  }

  if (input.currentStatus === "RATE_LIMITED") {
    // ChatGPT's own "Too many requests" modal explicitly says to wait a few minutes - retrying on
    // the normal quick_probe/backoff cadence just re-triggers the same limit. Wait long (90s) and
    // do not treat this as a hard stop; it usually clears on its own.
    return { status: "RATE_LIMITED", next_action: "WAIT_AND_PROBE", next_probe_after_ms: 90000, recommended_profile: "quick_probe", soft_recovery_actions: buildSoftRecoveryActions("RATE_LIMITED"), policy, evidence: { rate_limited: true } };
  }

  if (input.phase === "after_send" && elapsedSinceSendMs !== null && elapsedSinceSendMs < policy.initial_cooldown_ms) {
    return { status: "WAITING_INITIAL_COOLDOWN", next_action: "WAIT_AND_PROBE", next_probe_after_ms: policy.initial_cooldown_ms - elapsedSinceSendMs, policy, evidence: { elapsed_since_send_ms: elapsedSinceSendMs } };
  }

  if (input.currentStatus === "LIKELY_STABLE" && input.composerActionMode === "send") {
    return { status: "READY_FOR_STABLE_CAPTURE", next_action: "RUN_STABLE_CAPTURE", next_probe_after_ms: 0, recommended_profile: "stable_capture", policy, evidence: { composer_action_mode: input.composerActionMode } };
  }

  if (input.progressSeen) {
    return { status: "STREAMING_PROGRESS", next_action: "WAIT_AND_PROBE", next_probe_after_ms: selectBackoff(policy.backoff_ms, input.attempt), recommended_profile: "quick_probe", policy, evidence: { progress_seen: true, last_progress_age_ms: lastProgressAgeMs } };
  }

  if (input.composerActionMode === "stop" && lastProgressAgeMs !== null && lastProgressAgeMs >= policy.no_progress_hard_ms) {
    return { status: "HUNG_STREAM_CANDIDATE", next_action: "STOP_FOR_USER_OR_REFRESH", next_probe_after_ms: null, soft_recovery_actions: buildSoftRecoveryActions("HUNG_STREAM_CANDIDATE"), policy, evidence: { last_progress_age_ms: lastProgressAgeMs, no_progress_hard_ms: policy.no_progress_hard_ms } };
  }

  if (elapsedSinceSendMs !== null && elapsedSinceSendMs >= policy.max_watch_ms) {
    return { status: "MAX_WATCH_EXPIRED", next_action: "STOP_FOR_USER_OR_CAPTURE_CURRENT", next_probe_after_ms: null, soft_recovery_actions: buildSoftRecoveryActions("MAX_WATCH_EXPIRED"), policy, evidence: { elapsed_since_send_ms: elapsedSinceSendMs, max_watch_ms: policy.max_watch_ms } };
  }

  return { status: input.currentStatus ?? "PROBING", next_action: "WAIT_AND_PROBE", next_probe_after_ms: selectBackoff(policy.backoff_ms, input.attempt), recommended_profile: "quick_probe", policy, evidence: { elapsed_since_send_ms: elapsedSinceSendMs, last_progress_age_ms: lastProgressAgeMs } };
}

function buildSoftRecoveryActions(status: string): string[] {
  if (status === "CLIENT_STREAM_ERROR") return ["CLICK_LATEST_RETRY", "REFRESH_PAGE", "OPEN_FRESH_CHAT"];
  if (status === "RATE_LIMITED") return ["WAIT_LONGER", "DO_NOT_REFRESH", "DO_NOT_RETRY_IMMEDIATELY"];
  if (status === "HUNG_STREAM_CANDIDATE") return ["COPY_LATEST_ASSISTANT", "CLICK_LATEST_RETHINK", "CLICK_LATEST_REGENERATE", "REFRESH_PAGE"];
  if (status === "MAX_WATCH_EXPIRED") return ["COPY_LATEST_ASSISTANT", "CAPTURE_CURRENT_ASSISTANT", "CLICK_LATEST_RETHINK", "OPEN_FRESH_CHAT"];
  if (status === "CHAT_BINDING_LOST") return ["RE_BIND_CHAT", "OPEN_FRESH_CHAT"];
  if (status === "TRANSPORT_UNHEALTHY") return ["REFRESH_PAGE", "OPEN_FRESH_CHAT"];
  return [];
}

function resolveWatchPolicy(input: z.infer<typeof watchNextInputSchema>): Record<string, number | number[] | string> & { initial_cooldown_ms: number; max_watch_ms: number; no_progress_hard_ms: number; backoff_ms: number[] } {
  const byClass: Record<z.infer<typeof watchTaskClassSchema>, { initial: number; max: number; noProgressHard: number; backoff: number[]; base: number; inputMs: number; outputMs: number }> = {
    startup_light: { initial: 500, max: 60000, noProgressHard: 15000, backoff: [500, 1000, 1500, 2500], base: 500, inputMs: 1, outputMs: 5 },
    tiny_validation: { initial: 3000, max: 30000, noProgressHard: 15000, backoff: [3000, 5000, 8000], base: 5000, inputMs: 2, outputMs: 30 },
    short_reply: { initial: 8000, max: 60000, noProgressHard: 30000, backoff: [8000, 12000, 15000], base: 10000, inputMs: 3, outputMs: 35 },
    normal_answer: { initial: 30000, max: 180000, noProgressHard: 90000, backoff: [20000, 30000, 45000], base: 15000, inputMs: 4, outputMs: 40 },
    code_patch: { initial: 30000, max: 600000, noProgressHard: 180000, backoff: [20000, 30000, 45000, 60000], base: 45000, inputMs: 6, outputMs: 50 },
    repo_scan: { initial: 60000, max: 900000, noProgressHard: 240000, backoff: [30000, 45000, 60000, 90000], base: 60000, inputMs: 8, outputMs: 55 },
    repo_rc_implementation: { initial: 60000, max: 1200000, noProgressHard: 240000, backoff: [30000, 45000, 60000, 90000], base: 90000, inputMs: 8, outputMs: 60 },
    repair_iteration: { initial: 30000, max: 900000, noProgressHard: 180000, backoff: [20000, 30000, 45000, 60000], base: 45000, inputMs: 6, outputMs: 50 },
  };
  const selected = byClass[input.taskClass];
  const tokenEstimate = selected.base + (input.inputTokens ?? 0) * selected.inputMs + (input.expectedOutputTokens ?? 0) * selected.outputMs;
  return {
    source: "task_class_token_estimate",
    task_class: input.taskClass,
    initial_cooldown_ms: readNumberEnv("CONSOLE_CHATGPT_REPLY_INITIAL_COOLDOWN_MS", selected.initial),
    estimated_watch_ms: Math.min(selected.max, Math.max(selected.initial, tokenEstimate)),
    max_watch_ms: readNumberEnv("CONSOLE_CHATGPT_REPLY_MAX_WATCH_MS", selected.max),
    no_progress_hard_ms: readNumberEnv("CONSOLE_CHATGPT_REPLY_NO_PROGRESS_HARD_MS", selected.noProgressHard),
    backoff_ms: readNumberListEnv("CONSOLE_CHATGPT_REPLY_BACKOFF_MS", selected.backoff),
  };
}

function buildWatchPolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false, progress_aware: true, outline_signal: true, scroll_signal: true, recovery_signal_only: true, client_stream_error_signal: true, env_overrides: ["CONSOLE_CHATGPT_REPLY_INITIAL_COOLDOWN_MS", "CONSOLE_CHATGPT_REPLY_MAX_WATCH_MS", "CONSOLE_CHATGPT_REPLY_NO_PROGRESS_HARD_MS", "CONSOLE_CHATGPT_REPLY_BACKOFF_MS"] };
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectBackoff(values: number[], attempt: number): number {
  return values[Math.min(Math.max(0, attempt), Math.max(0, values.length - 1))] ?? 30000;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readNumberListEnv(name: string, fallback: number[]): number[] {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = value.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

async function settleChatGptAnswer(input: z.infer<typeof answerSettleInputSchema>): Promise<Record<string, unknown>> {
  const tabResult = await findChatGptTarget(input);
  if (!tabResult.ok || tabResult.target === null) {
    return { ...tabResult, messages: [], latest_assistant: null, settled: false, ready_for_gate: false, policy: buildAnswerSettlePolicy() };
  }

  const target = tabResult.target;
  if (input.requireChatId && target.chat_id === null) {
    return { ...tabResult, ok: false, status: "NEED_CHAT_ID", messages: [], latest_assistant: null, settled: false, ready_for_gate: false, policy: buildAnswerSettlePolicy() };
  }
  if (!target.web_socket_debugger_url) {
    return { ...tabResult, ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", messages: [], latest_assistant: null, settled: false, ready_for_gate: false, policy: buildAnswerSettlePolicy() };
  }

  const timing = resolveAnswerSettleTiming(input);
  const observationStartedAt = Date.now();
  const deadline = observationStartedAt + timing.maxWaitMs;
  let stableSamples = 0;
  let previousAssistantHash: string | null = null;
  let previousActivitySignature: string | null = null;
  let idleSince: number | null = null;
  let assistantHashStableSince: number | null = null;
  let lastState: NormalizedConversationState | null = null;

  while (Date.now() <= deadline) {
    let rawState: unknown;
    try {
      rawState = await evaluateConversationState(target.web_socket_debugger_url, input.maxMessages, input.timeoutMs);
    } catch (error) {
      return { ok: false, status: "CONVERSATION_STATE_EVALUATE_FAILED", settled: false, ready_for_gate: false, selected: target, scans: tabResult.scans, messages: [], latest_assistant: null, stability: { stable_samples: stableSamples, min_stable_samples: timing.minStableSamples, busy: null, composer_action_mode: null, composer_control_reason: null, composer_stop_control_mode: null, composer_stop_control_reason: null, composer_control_count: null, visible_composer_control_count: null, hidden_composer_control_count: null, sidebar_activity_mode: null, sidebar_activity_reason: null, animated_status_mode: null, animated_status_reason: null, animated_status_text: null, tail_activity_mode: null, tail_activity_reason: null, tail_activity_text: null, require_composer_send_mode: input.requireComposerSendMode, idle_quiet_ms: timing.idleQuietMs, composer_stop_confirm_ms: timing.composerStopConfirmMs, waited_ms: Date.now() - observationStartedAt, observation_budget_ms: timing.observationBudgetMs, max_wait_ms: timing.maxWaitMs, evaluation_error: error instanceof Error ? error.message : String(error) }, policy: buildAnswerSettlePolicy() };
    }
    const state = normalizeConversationState(rawState, input.maxMessages);
    lastState = state;
    const latestAssistant = state.latestAssistant;
    const currentHash = latestAssistant?.hash ?? null;
    const hasNewAssistant = currentHash !== null && currentHash !== input.baselineAssistantHash && currentHash !== input.lastGuardedAssistantHash;
    const now = Date.now();
    if (state.activitySignature === previousActivitySignature && !state.busy) {
      idleSince ??= now;
    } else {
      idleSince = null;
    }
    if (currentHash !== null && currentHash === previousAssistantHash && !state.busy) {
      assistantHashStableSince ??= now;
    } else {
      assistantHashStableSince = null;
    }
    previousActivitySignature = state.activitySignature;
    const idleStableMs = idleSince === null ? 0 : now - idleSince;
    const assistantHashStableMs = assistantHashStableSince === null ? 0 : now - assistantHashStableSince;
    const stickyStopCandidate = state.composerStopControlMode === "visible_idle_unconfirmed" && !state.busy;
    const stickyStopConfirmed = stickyStopCandidate && assistantHashStableMs >= timing.composerStopConfirmMs;
    const idleQuiet = idleStableMs >= timing.idleQuietMs;
    const noVisibleActivity = state.sidebarActivityMode === "idle" && state.animatedStatusMode === "not_found" && state.tailActivityMode === "not_found";
    const hungObservationMs = Math.max(30000, timing.composerStopConfirmMs * 4);
    if (input.requireComposerSendMode && stickyStopCandidate && noVisibleActivity && now - observationStartedAt >= hungObservationMs) {
      const hungState = buildHungStreamCandidate("ANSWER_HUNG_STREAM_CANDIDATE", state, true, timing, now - observationStartedAt);
      return {
        ok: false,
        status: "ANSWER_HUNG_STREAM_CANDIDATE",
        settled: false,
        ready_for_gate: false,
        hung_stream_candidate: hungState,
        refresh_probe: buildRefreshProbeRecommendation("ANSWER_HUNG_STREAM_CANDIDATE", state, true, hungState),
        selected: target,
        scans: tabResult.scans,
        messages: state.messages,
        latest_assistant: latestAssistant,
        stability: {
          stable_samples: stableSamples,
          min_stable_samples: timing.minStableSamples,
          busy: state.busy,
          composer_action_mode: state.composerActionMode,
          composer_control_reason: state.composerControlReason,
          composer_stop_control_mode: state.composerStopControlMode,
          composer_stop_control_reason: state.composerStopControlReason,
          require_composer_send_mode: true,
          waited_ms: now - observationStartedAt,
          hung_observation_ms: hungObservationMs,
        },
        policy: buildAnswerSettlePolicy(),
      };
    }

    // A visible Stop control is generation authority, even when every secondary busy signal is idle.
    // Never turn a quiet/sticky Stop button into a successful settle: that can capture a partial or stale
    // assistant artifact. stickyStopConfirmed remains diagnostic evidence for hung-stream recovery only.
    const composerReady = !input.requireComposerSendMode || state.composerActionMode === "send";

    if (hasNewAssistant && idleQuiet && composerReady && currentHash === previousAssistantHash) {
      stableSamples += 1;
    } else if (hasNewAssistant && idleQuiet && composerReady) {
      stableSamples = 1;
    } else {
      stableSamples = 0;
    }

    previousAssistantHash = currentHash;

    if (hasNewAssistant && stableSamples >= timing.minStableSamples) {
      const binding = target.chat_id === null ? null : createChatGptSessionBinding({ url: target.url ?? "", boundAt: new Date().toISOString(), baselineAssistantHash: latestAssistant?.hash ?? null });
      return { ok: true, status: "ANSWER_STABLE", settled: true, ready_for_gate: true, selected: target, scans: tabResult.scans, binding, cursor: binding === null ? null : createChatGptArtifactCursor(binding), messages: state.messages, latest_assistant: latestAssistant, stability: { stable_samples: stableSamples, min_stable_samples: timing.minStableSamples, busy: state.busy, composer_action_mode: state.composerActionMode, composer_control_reason: state.composerControlReason, composer_stop_control_mode: state.composerStopControlMode, composer_stop_control_reason: state.composerStopControlReason, composer_control_count: state.composerControlCount, visible_composer_control_count: state.visibleComposerControlCount, hidden_composer_control_count: state.hiddenComposerControlCount, composer_control_snapshot: state.composerControlSnapshot, sidebar_activity_mode: state.sidebarActivityMode, sidebar_activity_reason: state.sidebarActivityReason, animated_status_mode: state.animatedStatusMode, animated_status_reason: state.animatedStatusReason, animated_status_text: state.animatedStatusText, tail_activity_mode: state.tailActivityMode, tail_activity_reason: state.tailActivityReason, tail_activity_text: state.tailActivityText, require_composer_send_mode: input.requireComposerSendMode, idle_quiet_ms: timing.idleQuietMs, composer_stop_confirm_ms: timing.composerStopConfirmMs, idle_since_ms: idleSince === null ? null : now - idleSince, waited_ms: Date.now() - observationStartedAt, observation_budget_ms: timing.observationBudgetMs, max_wait_ms: timing.maxWaitMs }, policy: buildAnswerSettlePolicy() };
    }

    await delay(timing.pollMs);
  }

  const finalComposerMode = lastState?.composerActionMode ?? null;
  const strictComposerBlocked = input.requireComposerSendMode && finalComposerMode !== "send";
  const staleComposerStopCandidate = strictComposerBlocked && lastState?.composerStopControlMode === "visible_idle_unconfirmed";
  const finalStatus = staleComposerStopCandidate ? "ANSWER_IDLE_BUT_COMPOSER_STOP_STALE_CANDIDATE" : (strictComposerBlocked ? "ANSWER_IDLE_BUT_COMPOSER_NOT_SEND" : "ANSWER_MAX_WAIT_EXPIRED");
  const hungState = buildHungStreamCandidate(finalStatus, lastState, input.requireComposerSendMode, timing, Date.now() - observationStartedAt);
  const refreshProbe = buildRefreshProbeRecommendation(finalStatus, lastState, input.requireComposerSendMode, hungState);
  return { ok: false, status: finalStatus, settled: false, ready_for_gate: false, hung_stream_candidate: hungState, refresh_probe: refreshProbe, selected: target, scans: tabResult.scans, messages: lastState?.messages ?? [], latest_assistant: lastState?.latestAssistant ?? null, stability: { stable_samples: stableSamples, min_stable_samples: timing.minStableSamples, busy: lastState?.busy ?? null, composer_action_mode: finalComposerMode, composer_control_reason: lastState?.composerControlReason ?? null, composer_stop_control_mode: lastState?.composerStopControlMode ?? null, composer_stop_control_reason: lastState?.composerStopControlReason ?? null, composer_control_count: lastState?.composerControlCount ?? null, visible_composer_control_count: lastState?.visibleComposerControlCount ?? null, hidden_composer_control_count: lastState?.hiddenComposerControlCount ?? null, composer_control_snapshot: lastState?.composerControlSnapshot ?? null, sidebar_activity_mode: lastState?.sidebarActivityMode ?? null, sidebar_activity_reason: lastState?.sidebarActivityReason ?? null, animated_status_mode: lastState?.animatedStatusMode ?? null, animated_status_reason: lastState?.animatedStatusReason ?? null, animated_status_text: lastState?.animatedStatusText ?? null, tail_activity_mode: lastState?.tailActivityMode ?? null, tail_activity_reason: lastState?.tailActivityReason ?? null, tail_activity_text: lastState?.tailActivityText ?? null, require_composer_send_mode: input.requireComposerSendMode, idle_quiet_ms: timing.idleQuietMs, composer_stop_confirm_ms: timing.composerStopConfirmMs, waited_ms: Date.now() - observationStartedAt, observation_budget_ms: timing.observationBudgetMs, max_wait_ms: timing.maxWaitMs }, policy: buildAnswerSettlePolicy() };
}

export function selectExactTaskBinding(candidates: BoundTarget[], expectedTaskId: string, latestUserTextByTargetId: Readonly<Record<string, string>>): { ok: boolean; status: string; target: BoundTarget | null } {
  const marker = `Task ID: ${expectedTaskId}`;
  const matches = candidates.filter((candidate) => typeof candidate.id === "string" && latestUserTextByTargetId[candidate.id]?.includes(marker));
  if (matches.length === 1) return { ok: true, status: "BOUND_BY_TASK_ID", target: matches[0] };
  return { ok: false, status: matches.length > 1 ? "TASK_BINDING_AMBIGUOUS" : "TASK_BINDING_NOT_FOUND", target: null };
}

async function findChatGptTarget(input: z.infer<typeof messageCaptureInputSchema>): Promise<{ ok: boolean; status: string; target: BoundTarget | null; candidates: BoundTarget[]; scans: unknown[] }> {
  const scans = [];
  const candidates: BoundTarget[] = [];
  for (const port of [...new Set(input.ports)]) {
    try {
      const targets = await readDevToolsTargetList(port, input.timeoutMs);
      scans.push({ port, ok: true, target_count: targets.length });
      for (const target of targets) {
        const normalized = normalizeTarget(port, target);
        if (normalized !== null) candidates.push(normalized);
      }
    } catch (error) {
      scans.push({ port, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const exactTargetMatches = input.expectedTargetId ? candidates.filter((candidate) => candidate.id === input.expectedTargetId) : [];
  if (exactTargetMatches.length > 0) {
    const target = exactTargetMatches.find((candidate) => candidate.chat_id !== null) ?? exactTargetMatches[0] ?? null;
    return { ok: target !== null, status: target === null ? "NEED_BINDING" : "BOUND", target, candidates, scans };
  }

  const chatMatches = input.preferredChatId ? candidates.filter((candidate) => candidate.chat_id === input.preferredChatId) : [];
  if (chatMatches.length === 1) {
    return { ok: true, status: input.expectedTargetId ? "BOUND_REBOUND_BY_CHAT_ID" : "BOUND", target: chatMatches[0], candidates, scans };
  }
  if (chatMatches.length > 1) {
    return { ok: false, status: "CHAT_BINDING_AMBIGUOUS", target: null, candidates, scans };
  }

  if (input.expectedTaskId) {
    const latestUserTextByTargetId: Record<string, string> = {};
    for (const candidate of candidates) {
      if (!candidate.id || !candidate.web_socket_debugger_url || candidate.chat_id === null) continue;
      try {
        const rawMessages = await evaluateMessageDom(candidate.web_socket_debugger_url, input.maxMessages, input.timeoutMs);
        const messages = normalizeMessages(rawMessages, input.maxMessages);
        const latestUser = [...messages].reverse().find((message) => message.role === "user") ?? null;
        if (latestUser) latestUserTextByTargetId[candidate.id] = latestUser.text;
      } catch {
        // Ignore stale/closing tabs and continue checking exact task identity on remaining targets.
      }
    }
    const selected = selectExactTaskBinding(candidates, input.expectedTaskId, latestUserTextByTargetId);
    return { ...selected, candidates, scans };
  }

  return { ok: false, status: "NEED_EXACT_BINDING", target: null, candidates, scans };
}

function normalizeTarget(port: number, target: BrowserDebugTarget): BoundTarget | null { const url = typeof target.url === "string" ? target.url : ""; if (target.type !== "page" || !isChatGptUrl(url)) return null; return { ...target, port, chat_id: extractChatGptChatId(url), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null }; }
function isChatGptUrl(rawUrl: string): boolean { try { const url = new URL(rawUrl); const host = url.hostname.toLowerCase(); return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com"; } catch { return false; } }
async function readDevToolsTargetList(port: number, timeoutMs: number): Promise<BrowserDebugTarget[]> { const raw = await readLoopbackText(port, "/json/list", timeoutMs); const parsed = JSON.parse(raw) as unknown; if (!Array.isArray(parsed)) throw new Error("DevTools target list did not return an array."); return parsed as BrowserDebugTarget[]; }
function readLoopbackText(port: number, path: string, timeoutMs: number): Promise<string> { return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => { const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`))); req.on("error", reject); req.end(); }); }
function resolveAnswerSettleTiming(input: z.infer<typeof answerSettleInputSchema>): AnswerSettleTiming {
  const profileTiming: Record<z.infer<typeof answerSettleInputSchema>["readinessProfile"], AnswerSettleTiming> = {
    quick_probe: { maxWaitMs: 60000, observationBudgetMs: 12000, pollMs: 750, minStableSamples: 3, idleQuietMs: 2000, composerStopConfirmMs: 4000 },
    rc_gate: { maxWaitMs: 300000, observationBudgetMs: 30000, pollMs: 1000, minStableSamples: 5, idleQuietMs: 2000, composerStopConfirmMs: 8000 },
    long_run: { maxWaitMs: 600000, observationBudgetMs: 45000, pollMs: 1500, minStableSamples: 6, idleQuietMs: 3000, composerStopConfirmMs: 12000 },
  };

  return {
    maxWaitMs: input.maxWaitMs ?? profileTiming[input.readinessProfile].maxWaitMs,
    observationBudgetMs: input.observationBudgetMs ?? profileTiming[input.readinessProfile].observationBudgetMs,
    pollMs: input.pollMs ?? profileTiming[input.readinessProfile].pollMs,
    minStableSamples: input.minStableSamples ?? profileTiming[input.readinessProfile].minStableSamples,
    idleQuietMs: input.idleQuietMs ?? profileTiming[input.readinessProfile].idleQuietMs,
    composerStopConfirmMs: input.composerStopConfirmMs ?? profileTiming[input.readinessProfile].composerStopConfirmMs,
  };
}

function buildMessageCapturePolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false };
}

function buildMessageControlClickPolicy(): Record<string, unknown> {
  return { browser_mutation: true, prompt_injection: false, auto_submit: false, dom_write: true, requires_explicit_confirmation: true, revalidates_latest_assistant_control: true };
}

function buildSessionControlInventoryPolicy(): Record<string, unknown> {
  return { browser_mutation: false, reads_visible_controls: true, activates_controls: false };
}

function buildSessionControlCopyPolicy(): Record<string, unknown> {
  return { browser_mutation: true, copy_only: true, activates_generation: false, requires_explicit_confirmation: true };
}

function buildSessionControlActivatePolicy(): Record<string, unknown> {
  return { browser_mutation: true, activates_existing_visible_control_only: true, accepts_text: false, requires_explicit_confirmation: true };
}

function buildAnswerSettlePolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false, waits_for_stable_assistant: true, requires_idle_quiet_window: true };
}

async function evaluateLatestAssistantControlClick(webSocketUrl: string, action: z.infer<typeof messageControlClickInputSchema>["action"], timeoutMs: number): Promise<unknown> {
  return callDevToolsRuntimeEvaluate(webSocketUrl, buildLatestAssistantControlClickExpression(action), timeoutMs);
}

function buildLatestAssistantControlClickExpression(action: z.infer<typeof messageControlClickInputSchema>["action"]): string {
  const actionJson = JSON.stringify(action);
  return `(() => { const action = ${actionJson}; const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const latestAssistantNode = [...nodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'assistant') || null; const isVisibleActionable = (node) => { if (!(node instanceof HTMLElement)) return false; if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false; const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; const style = window.getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false; return true; }; if (!latestAssistantNode) return { clicked: false, status: 'LATEST_ASSISTANT_NOT_FOUND', action }; const buttons = Array.from(latestAssistantNode.querySelectorAll('button, [role="button"]')).filter(isVisibleActionable); const patterns = { copy: /copy|копир|скопир/i, retry: /retry|try again|повторить|повторіть/i, regenerate: /regenerate|rerun|generate again|обнов|перегенер|сгенер/i, rethink: /rethink|think again|перепродум|подум|reason/i }; const pattern = patterns[action]; const labeled = buttons.map((node, index) => ({ node, index, label: String(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('data-testid') || node.getAttribute('title') || '').trim() })); const match = labeled.find((item) => pattern.test(item.label)); if (!match) return { clicked: false, status: 'CONTROL_NOT_FOUND', action, button_count: buttons.length, labels: labeled.map((item) => item.label).slice(0, 20) }; match.node.click(); return { clicked: true, status: 'CONTROL_CLICKED', action, matched_index: match.index, matched_label: match.label, button_count: buttons.length, labels: labeled.map((item) => item.label).slice(0, 20) }; })()`;
}

async function evaluateMessageDom(webSocketUrl: string, maxMessages: number, timeoutMs: number): Promise<unknown> { return callDevToolsRuntimeEvaluate(webSocketUrl, buildMessageDomExpression(maxMessages), timeoutMs); }
function buildMessageDomExpression(maxMessages: number): string { return `(() => { const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const items = nodes.map((node, index) => { const role = String(node.getAttribute('data-message-author-role') || 'unknown'); const wholeText = String(node.innerText || node.textContent || '').trim(); const turnRoot = role === 'assistant' ? (node.closest('article') || node.closest('[data-testid^="conversation-turn-"]')) : null; const turnText = turnRoot ? String(turnRoot.innerText || turnRoot.textContent || '').trim() : ''; const explicitContents = role === 'assistant' ? Array.from(node.querySelectorAll('[data-message-content]')) : []; const markdownRoots = role === 'assistant' ? Array.from(node.querySelectorAll('.markdown')).filter((candidate) => !candidate.parentElement?.closest('.markdown')) : []; const semanticCandidates = role === 'assistant' ? [wholeText, turnText, ...explicitContents.map((candidate) => String(candidate.innerText || candidate.textContent || '').trim()), ...markdownRoots.map((candidate) => String(candidate.innerText || candidate.textContent || '').trim())].filter(Boolean) : []; const assistantText = semanticCandidates.sort((a, b) => b.length - a.length)[0] || ''; const text = String(((role === 'assistant' && assistantText.length > 0 ? assistantText : wholeText) || '')).trim(); return { role, text, index }; }).filter((item) => item.text.length > 0); return items.slice(Math.max(0, items.length - ${maxMessages})); })()`; }

async function evaluateConversationState(webSocketUrl: string, maxMessages: number, timeoutMs: number): Promise<unknown> { return callDevToolsRuntimeEvaluate(webSocketUrl, buildConversationStateExpression(maxMessages), timeoutMs); }
function buildConversationStateExpression(maxMessages: number): string { return `(() => { const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const messages = nodes.map((node, index) => { const role = String(node.getAttribute('data-message-author-role') || 'unknown'); const wholeText = String(node.innerText || node.textContent || '').trim(); const turnRoot = role === 'assistant' ? (node.closest('article') || node.closest('[data-testid^="conversation-turn-"]')) : null; const turnText = turnRoot ? String(turnRoot.innerText || turnRoot.textContent || '').trim() : ''; const explicitContents = role === 'assistant' ? Array.from(node.querySelectorAll('[data-message-content]')) : []; const markdownRoots = role === 'assistant' ? Array.from(node.querySelectorAll('.markdown')).filter((candidate) => !candidate.parentElement?.closest('.markdown')) : []; const semanticCandidates = role === 'assistant' ? [wholeText, turnText, ...explicitContents.map((candidate) => String(candidate.innerText || candidate.textContent || '').trim()), ...markdownRoots.map((candidate) => String(candidate.innerText || candidate.textContent || '').trim())].filter(Boolean) : []; const assistantText = semanticCandidates.sort((a, b) => b.length - a.length)[0] || ''; const text = String(((role === 'assistant' && assistantText.length > 0 ? assistantText : wholeText) || '')).trim(); return { role, text, index }; }).filter((item) => item.text.length > 0).slice(-${maxMessages}); const controlSelectors = ['button[data-testid="stop-button"]', 'button[data-testid="composer-stop-button"]', 'button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const composerInput = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'); const composerRoot = composerInput ? (composerInput.closest('form') || composerInput.closest('[data-testid*="composer" i]') || composerInput.parentElement) : null; const composerButtons = composerRoot ? Array.from(composerRoot.querySelectorAll('button')) : []; const globalControls = controlSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(Boolean); const controlCandidates = Array.from(new Set([...globalControls, ...composerButtons].filter(Boolean))); const isVisibleActionable = (node) => { if (!(node instanceof HTMLElement)) return false; if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false; const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; const style = window.getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false; return true; }; const pageText = String((document.querySelector('main') || document.body)?.innerText || '').toLowerCase(); const retryButtons = Array.from(document.querySelectorAll('button')).filter((node) => isVisibleActionable(node) && /retry|try again|повторить|повторіть/i.test(String(node.innerText || node.textContent || node.getAttribute('aria-label') || ''))); const errorInMessageStream = pageText.includes('error in message stream'); const connectingToApp = pageText.includes('connecting to app'); const deliveryTimedOut = pageText.includes('message delivery timed out') || pageText.includes('please try again'); const rateLimited = pageText.includes('too many requests') || pageText.includes('making requests too quickly') || pageText.includes('temporarily limited access'); const clientStreamErrorDetected = errorInMessageStream || deliveryTimedOut || rateLimited || (connectingToApp && retryButtons.length > 0); const clientStreamError = { detected: clientStreamErrorDetected, mode: clientStreamErrorDetected ? (rateLimited ? 'rate_limited' : (deliveryTimedOut ? 'message_delivery_timeout' : 'message_stream_error')) : 'not_found', text: clientStreamErrorDetected ? String((document.querySelector('main') || document.body)?.innerText || '').split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean).filter((line) => /error in message stream|connecting to app|message delivery timed out|please try again|too many requests|making requests too quickly|temporarily limited access|retry/i.test(line)).slice(0, 8).join(' | ').slice(0, 500) : null, retry_visible: retryButtons.length > 0, connecting_to_app: connectingToApp, error_in_message_stream: errorInMessageStream, delivery_timed_out: deliveryTimedOut, rate_limited: rateLimited }; const controls = controlCandidates.filter(isVisibleActionable); const composerControls = controls.filter((node) => composerButtons.includes(node)); const hiddenControlCount = controlCandidates.length - controls.length; const controlText = composerControls.map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('data-testid') || '')).join('|').toLowerCase(); const controlHtml = composerControls.map((node) => String(node.outerHTML || '')).join('|').toLowerCase().slice(0, 4000); const stopMode = controlText.includes('stop') || controlText.includes('останов') || controlHtml.includes('stop-button') || controlHtml.includes('composer-stop-button') || controlHtml.includes('stop generating') || controlHtml.includes('stop streaming'); const primaryControl = composerControls[0] || null; const submitDisabled = primaryControl ? Boolean(primaryControl.disabled) || primaryControl.getAttribute('aria-disabled') === 'true' : null; const enabledSubmitMode = controls.some((node) => node instanceof HTMLButtonElement && node.matches('form button[type="submit"]') && !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const enabledComposerButtonMode = controls.some((node) => node instanceof HTMLButtonElement && composerButtons.includes(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const sendMode = controlText.includes('send') || controlText.includes('отправ') || controlHtml.includes('send-button') || controlHtml.includes('composer-submit-button') || controlHtml.includes('send prompt') || controlHtml.includes('send message') || enabledSubmitMode || enabledComposerButtonMode; const composerActionMode = stopMode ? 'stop' : (sendMode ? (submitDisabled ? 'disabled' : 'send') : 'unknown'); const composerControlReason = composerControls.length === 0 ? (controls.length === 0 ? (controlCandidates.length === 0 ? 'no_control_candidates' : 'all_control_candidates_hidden') : 'global_controls_ignored') : (stopMode ? 'composer_scoped_stop_control' : (sendMode ? (submitDisabled ? 'composer_scoped_send_control_disabled' : 'composer_scoped_send_control') : 'composer_scoped_control_unknown')); const composerControlSnapshot = composerControls.slice(0, 8).map((node, index) => { const rect = node.getBoundingClientRect(); return { index, tag: node.tagName.toLowerCase(), type: node instanceof HTMLButtonElement ? node.type : null, text: String(node.innerText || node.textContent || '').trim().slice(0, 80), aria_label: node.getAttribute('aria-label'), data_testid: node.getAttribute('data-testid'), title: node.getAttribute('title'), disabled: node instanceof HTMLButtonElement ? node.disabled : null, aria_disabled: node.getAttribute('aria-disabled'), rect: { width: Math.round(rect.width), height: Math.round(rect.height) } }; }); const pathParts = location.pathname.split('/'); const currentChatId = pathParts[1] === 'c' ? (pathParts[2] || '') : ''; const currentChatLink = currentChatId ? document.querySelector('a[href*="/c/' + currentChatId + '"]') : null; const sidebarRow = currentChatLink ? (currentChatLink.closest('li') || currentChatLink.closest('[role="listitem"]') || currentChatLink.closest('div')) : null; const sidebarBusyNodes = sidebarRow ? Array.from(sidebarRow.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="loading" i], [class*="animate-spin" i]')) : []; const sidebarLoading = Boolean(sidebarRow && (sidebarRow.getAttribute('aria-busy') === 'true' || sidebarBusyNodes.length > 0)); const sidebarActivityMode = !currentChatId ? 'unknown' : (!sidebarRow ? 'current_chat_not_found' : (sidebarLoading ? 'loading' : 'idle')); const sidebarActivityReason = !currentChatId ? 'missing_current_chat_id' : (!sidebarRow ? 'current_chat_row_not_found' : (sidebarLoading ? 'current_chat_loader' : 'current_chat_idle')); const animatedStatusTerms = ['connecting to app', 'thinking', 'analyzing', 'analyzing data', 'working', 'reading', 'searching', 'running']; const latestAssistantNode = [...nodes].reverse().find((node) => node.getAttribute('data-message-author-role') === 'assistant') || null; const latestAssistantButtonNodes = latestAssistantNode ? Array.from(latestAssistantNode.querySelectorAll('button, [role="button"]')).filter(isVisibleActionable) : []; const latestAssistantButtonLabels = latestAssistantButtonNodes.map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('data-testid') || node.getAttribute('title') || '').trim()).filter(Boolean).slice(0, 20); const latestAssistantControlText = latestAssistantButtonLabels.join('|').toLowerCase(); const latestAssistantControls = { copy_visible: /copy|копир|скопир/.test(latestAssistantControlText), retry_visible: /retry|try again|повторить|повторіть/.test(latestAssistantControlText), regenerate_visible: /regenerate|rerun|generate again|обнов|перегенер|сгенер/.test(latestAssistantControlText), rethink_visible: /rethink|think again|перепродум|подум|reason/.test(latestAssistantControlText), button_count: latestAssistantButtonNodes.length, labels: latestAssistantButtonLabels }; const statusScope = latestAssistantNode || document.querySelector('main'); const animatedStatusCandidates = Array.from(statusScope ? statusScope.querySelectorAll('*') : []).filter((node) => { const text = String(node.innerText || node.textContent || '').toLowerCase().trim(); return text.length > 0 && text.length < 120 && animatedStatusTerms.some((term) => text.includes(term)); }); const animatedStatusNode = animatedStatusCandidates.find((node) => { if (!(node instanceof HTMLElement) || !isVisibleActionable(node)) return false; const style = window.getComputedStyle(node); const hasCssAnimation = style.animationName !== 'none' && style.animationDuration !== '0s'; const hasCssTransition = style.transitionDuration !== '0s'; const hasWebAnimation = typeof node.getAnimations === 'function' && node.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'); const className = String(node.className || '').toLowerCase(); return hasCssAnimation || hasCssTransition || hasWebAnimation || className.includes('animate') || className.includes('shimmer') || className.includes('pulse'); }) || null; const animatedStatusText = animatedStatusNode ? String(animatedStatusNode.innerText || animatedStatusNode.textContent || '').trim().slice(0, 120) : null; const animatedStatusMode = animatedStatusNode ? 'animated' : (animatedStatusCandidates.length > 0 ? 'static_or_unverified' : 'not_found'); const animatedStatusReason = animatedStatusNode ? 'visible_animated_status_text' : (animatedStatusCandidates.length > 0 ? 'status_text_without_detected_animation' : 'status_text_not_found'); const tailNodes = latestAssistantNode ? Array.from(latestAssistantNode.querySelectorAll('*')).slice(-60) : []; const tailActivityCandidates = tailNodes.filter((node) => { const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').toLowerCase().trim(); const className = String(node.className || '').toLowerCase(); return node.getAttribute('aria-busy') === 'true' || node.getAttribute('role') === 'progressbar' || className.includes('spinner') || className.includes('loading') || className.includes('animate-spin') || className.includes('pulse') || className.includes('shimmer') || (text.length > 0 && text.length < 120 && animatedStatusTerms.some((term) => text.includes(term))); }); const tailActivityNode = tailActivityCandidates.find((node) => { if (!(node instanceof HTMLElement) || !isVisibleActionable(node)) return false; if (node.getAttribute('aria-busy') === 'true' || node.getAttribute('role') === 'progressbar') return true; const style = window.getComputedStyle(node); const hasCssAnimation = style.animationName !== 'none' && style.animationDuration !== '0s'; const hasWebAnimation = typeof node.getAnimations === 'function' && node.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'); const className = String(node.className || '').toLowerCase(); return hasCssAnimation || hasWebAnimation || className.includes('animate') || className.includes('spinner') || className.includes('loading') || className.includes('pulse') || className.includes('shimmer'); }) || null; const tailActivityText = tailActivityNode ? String(tailActivityNode.innerText || tailActivityNode.textContent || tailActivityNode.getAttribute('aria-label') || '').trim().slice(0, 120) : null; const tailActivityMode = tailActivityNode ? 'animated' : (tailActivityCandidates.length > 0 ? 'static_or_unverified' : 'not_found'); const tailActivityReason = tailActivityNode ? 'latest_assistant_tail_activity' : (tailActivityCandidates.length > 0 ? 'latest_assistant_tail_static_or_unverified' : 'latest_assistant_tail_activity_not_found'); const busySelectors = ['[data-testid*="tool"]', '[aria-label*="tool" i]', '[class*="tool" i]', '[class*="progress" i]', '[class*="spinner" i]']; const busyNodes = busySelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(Boolean); const toolText = busyNodes.map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || '')).join('|').slice(0, 2000); const toolBusy = busyNodes.some((node) => { const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').toLowerCase(); return text.includes('running') || text.includes('working') || text.includes('calling') || text.includes('searching') || text.includes('reading') || text.includes('using') || text.includes('in progress') || text.includes('подожд') || text.includes('выполня'); }); const activeNonComposerBusy = toolBusy || sidebarLoading || animatedStatusMode === 'animated' || tailActivityMode === 'animated'; const composerStopControlMode = stopMode ? (activeNonComposerBusy ? 'active_busy_context' : 'visible_idle_unconfirmed') : 'not_found'; const composerStopControlReason = stopMode ? (activeNonComposerBusy ? 'stop_control_with_active_busy_signal' : 'stop_control_without_active_busy_signal') : 'stop_control_not_found'; const generating = activeNonComposerBusy; const latestAssistant = [...messages].reverse().find((item) => item.role === 'assistant'); const outlineSelectors = ['nav[aria-label*="contents" i]', 'nav[aria-label*="outline" i]', 'aside nav', 'aside [role="navigation"]', '[data-testid*="outline" i]', '[data-testid*="toc" i]', '[class*="outline" i]', '[class*="toc" i]']; const outlineRoots = outlineSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter((node) => node instanceof HTMLElement && isVisibleActionable(node)); const outlineRoot = outlineRoots.find((node) => String(node.innerText || node.textContent || '').trim().length > 0) || null; const outlineItems = outlineRoot ? Array.from(outlineRoot.querySelectorAll('a, button, [role="link"], [role="button"], li, h1, h2, h3, h4')).map((node) => String(node.innerText || node.textContent || '').trim()).filter((text, index, all) => text.length > 0 && text.length < 200 && all.indexOf(text) === index).slice(0, 80) : []; const outlineText = outlineItems.join('|'); const outlineHashText = outlineText.slice(-1200); const scrollMetrics = { height: Math.round(document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0), top: Math.round(document.scrollingElement?.scrollTop || document.documentElement.scrollTop || 0), viewport_height: Math.round(window.innerHeight || 0), latest_assistant_bottom: latestAssistantNode ? Math.round(latestAssistantNode.getBoundingClientRect().bottom) : null }; const activitySignature = [messages.length, latestAssistant ? latestAssistant.text.length : 0, latestAssistant ? latestAssistant.text.slice(-200) : '', composerActionMode, composerControlReason, composerStopControlMode, composerStopControlReason, generating, toolText, submitDisabled, controls.length, hiddenControlCount, tailActivityMode, tailActivityReason, tailActivityText, JSON.stringify(latestAssistantControls), outlineItems.length, outlineHashText, scrollMetrics.height].join('::'); return { messages, generating, toolBusy, toolText, composerActionMode, composerControlReason, composerStopControlMode, composerStopControlReason, composerControlCount: composerButtons.length, visibleComposerControlCount: composerControls.length, hiddenComposerControlCount: composerButtons.length - composerControls.length, composerControlSnapshot, activitySignature, submitDisabled, sidebarActivityMode, sidebarActivityReason, animatedStatusMode, animatedStatusReason, animatedStatusText, tailActivityMode, tailActivityReason, tailActivityText, clientStreamError, latestAssistantControls, outline: { visible: Boolean(outlineRoot), sectionCount: outlineItems.length, text: outlineText.slice(0, 4000), latestSectionText: outlineItems.length > 0 ? outlineItems[outlineItems.length - 1] : null }, scroll: scrollMetrics, readyState: document.readyState, href: location.href, title: document.title }; })()`; }

type NormalizedConversationState = {
  [key: string]: unknown;
  messages: CapturedMessage[];
  latestAssistant: CapturedMessage | null;
  busy: boolean;
  activitySignature: string;
  composerActionMode: string;
  composerControlReason: string;
  composerStopControlMode: string;
  composerStopControlReason: string;
  composerControlCount: number | null;
  visibleComposerControlCount: number | null;
  hiddenComposerControlCount: number | null;
  sidebarActivityMode: string;
  sidebarActivityReason: string;
  animatedStatusMode: string;
  animatedStatusReason: string;
  animatedStatusText: string | null;
  tailActivityMode: string;
  tailActivityReason: string;
  tailActivityText: string | null;
  clientStreamError: ClientStreamErrorSignal;
  latestAssistantControls: LatestAssistantControls;
  outline: OutlineMetrics;
  scroll: ScrollMetrics;
};

function normalizeConversationState(raw: unknown, maxMessages: number): NormalizedConversationState {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const messages = normalizeMessages(source.messages, maxMessages);
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const composerActionMode = String(source.composerActionMode ?? "unknown");
  const composerControlReason = String(source.composerControlReason ?? "unknown");
  const composerStopControlMode = String(source.composerStopControlMode ?? (composerActionMode === "stop" ? "visible_unclassified" : "not_found"));
  const composerStopControlReason = String(source.composerStopControlReason ?? (composerActionMode === "stop" ? "legacy_stop_control_without_classification" : "stop_control_not_found"));
  const busy = source.generating === true || source.toolBusy === true || composerStopControlMode === "active_busy_context";
  const composerControlCount = typeof source.composerControlCount === "number" ? source.composerControlCount : null;
  const visibleComposerControlCount = typeof source.visibleComposerControlCount === "number" ? source.visibleComposerControlCount : null;
  const hiddenComposerControlCount = typeof source.hiddenComposerControlCount === "number" ? source.hiddenComposerControlCount : null;
  const sidebarActivityMode = String(source.sidebarActivityMode ?? "unknown");
  const sidebarActivityReason = String(source.sidebarActivityReason ?? "unknown");
  const animatedStatusMode = String(source.animatedStatusMode ?? "unknown");
  const animatedStatusReason = String(source.animatedStatusReason ?? "unknown");
  const animatedStatusText = typeof source.animatedStatusText === "string" ? source.animatedStatusText : null;
  const tailActivityMode = String(source.tailActivityMode ?? animatedStatusMode);
  const tailActivityReason = String(source.tailActivityReason ?? animatedStatusReason);
  const tailActivityText = typeof source.tailActivityText === "string" ? source.tailActivityText : null;
  const clientStreamError = normalizeClientStreamErrorSignal(source.clientStreamError);
  const latestAssistantControls = normalizeLatestAssistantControls(source.latestAssistantControls);
  const composerControlSnapshot = Array.isArray(source.composerControlSnapshot) ? source.composerControlSnapshot.slice(0, 8) : [];
  const outline = normalizeOutlineMetrics(source.outline);
  const scroll = normalizeScrollMetrics(source.scroll);
  const activitySignature = String(source.activitySignature ?? `${latestAssistant?.hash ?? "no-assistant"}:${composerActionMode}:${composerControlReason}:${sidebarActivityMode}:${animatedStatusMode}:${String(source.toolText ?? "")}:${String(source.submitDisabled ?? "")}:${messages.length}:${outline.hash ?? "no-outline"}:${scroll.height}`);
  return { messages, latestAssistant, busy, activitySignature, composerActionMode, composerControlReason, composerStopControlMode, composerStopControlReason, composerControlCount, visibleComposerControlCount, hiddenComposerControlCount, composerControlSnapshot, sidebarActivityMode, sidebarActivityReason, animatedStatusMode, animatedStatusReason, animatedStatusText, tailActivityMode, tailActivityReason, tailActivityText, clientStreamError, latestAssistantControls, outline, scroll };
}

function normalizeLatestAssistantControls(raw: unknown): LatestAssistantControls {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const labels = Array.isArray(source.labels) ? source.labels.map((item) => String(item)).filter((item) => item.length > 0).slice(0, 20) : [];
  return {
    copy_visible: source.copy_visible === true,
    retry_visible: source.retry_visible === true,
    regenerate_visible: source.regenerate_visible === true,
    rethink_visible: source.rethink_visible === true,
    button_count: typeof source.button_count === "number" ? source.button_count : labels.length,
    labels,
  };
}

function normalizeClientStreamErrorSignal(raw: unknown): ClientStreamErrorSignal {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const retryVisible = source.retry_visible === true;
  const connectingToApp = source.connecting_to_app === true;
  const errorInMessageStream = source.error_in_message_stream === true;
  const deliveryTimedOut = source.delivery_timed_out === true;
  const rateLimited = source.rate_limited === true;
  const detected = source.detected === true || errorInMessageStream || deliveryTimedOut || rateLimited || (connectingToApp && retryVisible);
  return {
    detected,
    mode: typeof source.mode === "string" && source.mode.length > 0 ? source.mode : (detected ? "message_stream_error" : "not_found"),
    text: typeof source.text === "string" && source.text.length > 0 ? source.text : null,
    retry_visible: retryVisible,
    connecting_to_app: connectingToApp,
    error_in_message_stream: errorInMessageStream,
    delivery_timed_out: deliveryTimedOut,
    rate_limited: rateLimited,
  };
}

function normalizeOutlineMetrics(raw: unknown): OutlineMetrics {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const text = typeof source.text === "string" ? source.text : "";
  const latestSectionText = typeof source.latestSectionText === "string" ? source.latestSectionText : null;
  return {
    visible: source.visible === true,
    section_count: typeof source.sectionCount === "number" ? source.sectionCount : 0,
    hash: text.trim() === "" ? null : hashChatGptArtifactText(text),
    latest_section_text: latestSectionText,
    latest_section_hash: latestSectionText === null || latestSectionText.trim() === "" ? null : hashChatGptArtifactText(latestSectionText),
  };
}

function normalizeScrollMetrics(raw: unknown): ScrollMetrics {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  return {
    height: typeof source.height === "number" ? source.height : 0,
    top: typeof source.top === "number" ? source.top : 0,
    viewport_height: typeof source.viewport_height === "number" ? source.viewport_height : 0,
    latest_assistant_bottom: typeof source.latest_assistant_bottom === "number" ? source.latest_assistant_bottom : null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHungStreamCandidate(status: string, state: NormalizedConversationState | null, requireComposerSendMode: boolean, timing: AnswerSettleTiming, waitedMs: number): Record<string, unknown> {
  const stopWithoutBusy = requireComposerSendMode && state?.composerActionMode === "stop" && state.composerStopControlMode === "visible_idle_unconfirmed" && state.busy === false;
  const noVisibleActivity = state?.sidebarActivityMode === "idle" && state.animatedStatusMode === "not_found" && state.tailActivityMode === "not_found";
  const longEnough = waitedMs >= Math.max(timing.composerStopConfirmMs, timing.idleQuietMs * 2);
  const candidate = Boolean(stopWithoutBusy && noVisibleActivity && longEnough);
  const reasons = [];
  if (stopWithoutBusy) reasons.push("stop_button_visible_without_busy_signal");
  if (noVisibleActivity) reasons.push("sidebar_tail_and_status_idle");
  if (longEnough) reasons.push("waited_beyond_sticky_stop_confirmation");
  if (status === "ANSWER_IDLE_BUT_COMPOSER_STOP_STALE_CANDIDATE") reasons.push("stale_stop_status");
  return {
    candidate,
    severity: candidate ? "OPS_REQUIRED" : "INFO",
    reasons,
    waited_ms: waitedMs,
    recommended_next_action: candidate ? "refresh_or_open_fresh_chat_probe_then_repeat_settle" : "continue_standard_settle_or_refresh_probe_if_recommended",
  };
}

function buildRefreshProbeRecommendation(status: string, state: NormalizedConversationState | null, requireComposerSendMode: boolean, hungState: Record<string, unknown> | null = null): Record<string, unknown> {
  const ambiguousComposer = requireComposerSendMode && state?.composerActionMode === "stop" && state.composerStopControlMode !== "active_busy_context";
  const ambiguousStaticTail = state?.tailActivityMode === "static_or_unverified" || state?.animatedStatusMode === "static_or_unverified";
  const hungCandidate = hungState?.candidate === true;
  const recommended = status !== "ANSWER_STABLE" && (ambiguousComposer || ambiguousStaticTail || status === "OBSERVATION_WINDOW_EXPIRED" || status === "ANSWER_MAX_WAIT_EXPIRED" || hungCandidate);
  const reasons = [];
  if (ambiguousComposer) reasons.push("composer_stop_visible_without_active_busy_signal");
  if (ambiguousStaticTail) reasons.push("status_or_tail_activity_static_or_unverified");
  if (status === "OBSERVATION_WINDOW_EXPIRED") reasons.push("observation_window_expired");
  if (status === "ANSWER_MAX_WAIT_EXPIRED") reasons.push("answer_max_wait_expired");
  if (hungCandidate) reasons.push("hung_stream_candidate");
  return {
    recommended,
    performed: false,
    policy: "read_only_settle_does_not_reload_browser",
    reasons,
  };
}

function normalizeRole(role: unknown): CapturedMessage["role"] { return role === "user" || role === "assistant" || role === "system" ? role : "unknown"; }
function validateRuntimeExpressionSyntax(expression: string): void { try { new Function(`return (${expression});`); } catch (error) { throw new Error(`Generated Runtime.evaluate expression syntax error: ${error instanceof Error ? error.message : String(error)}`); } }
function callDevToolsRuntimeEvaluate(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> { validateRuntimeExpressionSyntax(expression); const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket; if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process.")); return new Promise((resolve, reject) => { const ws = new Ctor(webSocketUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools Runtime read timed out.")); }, timeoutMs); ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); }; ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime." + "evaluate", params: { expression, returnByValue: true, awaitPromise: false } })); ws.onmessage = (event) => { const response = JSON.parse(String(event.data)) as DevToolsRpcResponse; if (response.id !== 1) return; clearTimeout(timer); ws.close(); if (response.error) reject(new Error(`DevTools Runtime read failed: ${JSON.stringify(response.error)}`)); else if (response.result?.exceptionDetails) reject(new Error(`DevTools Runtime evaluation exception: ${JSON.stringify(response.result.exceptionDetails)}`)); else resolve(response.result?.result?.value ?? null); }; }); }
function normalizeMessages(raw: unknown, maxMessages: number): CapturedMessage[] { if (!Array.isArray(raw)) return []; return raw.slice(-maxMessages).map((item, index) => { const source = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}; const role = normalizeRole(source.role); const text = truncateText(String(source.text ?? "").trim(), 20000).text; return { role, text, hash: hashChatGptArtifactText(text), index }; }).filter((message) => message.text.length > 0); }

