import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { executeAsk } from "./ask.js";
import { executeNamedCheck } from "./run-check.js";
import { runChatGptAnswerSettle, runChatGptRunLoopPlan, runChatGptWatchProbe } from "./chatgpt-message-capture.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

const outputLimit = 30000;

export const implementationRunCaptureInputSchema = z.object({
  workspacePath: z.string().min(1),
  beforeHead: z.string().min(1).optional(),
  assistantMessage: z.string().max(60000).optional(),
  checkNames: z.array(z.string().min(1)).max(20).default([]),
  includeDiff: z.boolean().default(true),
  diffMaxChars: z.number().int().min(1000).max(120000).default(30000),
  maxCommits: z.number().int().min(1).max(100).default(30),
}).strict();

const runLoopStepInputSchema = z.object({
  workspacePath: z.string().min(1).optional(),
  beforeHead: z.string().min(1).optional(),
  checkNames: z.array(z.string().min(1)).max(20).default([]),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
  phase: z.enum(["startup", "after_send", "reply_watch", "pre_ask", "return_to_chat"]).default("reply_watch"),
  taskClass: z.enum(["startup_light", "tiny_validation", "short_reply", "normal_answer", "code_patch", "repo_scan", "repo_rc_implementation", "repair_iteration"]).default("normal_answer"),
  iteration: z.number().int().min(0).max(1000).default(0),
  maxIterations: z.number().int().min(1).max(1000).default(20),
  sentAt: z.string().min(1).optional(),
  lastProgressAt: z.string().min(1).optional(),
  attempt: z.number().int().min(0).max(1000).default(0),
  baselineAssistantHash: z.string().min(1).optional(),
  lastSeenAssistantHash: z.string().min(1).optional(),
  lastSeenTextLength: z.number().int().min(0).optional(),
  lastSeenTailHash: z.string().min(1).optional(),
  lastSeenOutlineHash: z.string().min(1).optional(),
  lastSeenOutlineSectionCount: z.number().int().min(0).optional(),
  lastSeenScrollHeight: z.number().int().min(0).optional(),
  inputTokens: z.number().int().min(0).max(200000).optional(),
  expectedOutputTokens: z.number().int().min(0).max(200000).optional(),
  executePreAsk: z.boolean().default(true),
  gatewayAskMode: z.enum(["off", "blocked_only"]).default("blocked_only"),
  gatewayMaxOutputTokens: z.number().int().min(64).max(6000).default(1200),
  gatewayTemperature: z.number().min(0).max(2).default(0.1),
  gatewayTimeoutMs: z.number().int().min(5000).max(180000).default(60000),
}).strict();

const runLoopAutoSummaryInputSchema = runLoopStepInputSchema.extend({
  maxAutoIterations: z.number().int().min(1).max(100).default(12),
  maxElapsedMs: z.number().int().min(1000).max(7200000).default(300000),
  pollMs: z.number().int().min(250).max(60000).default(15000),
  minWaitMs: z.number().int().min(0).max(60000).default(1000),
  maxWaitMs: z.number().int().min(250).max(60000).default(30000),
  stopOnReturnToChat: z.boolean().default(true),
  stopOnPreAskExecuted: z.boolean().default(true),
}).strict();

const runLoopDaemonStartInputSchema = runLoopAutoSummaryInputSchema.extend({
  runId: z.string().min(1).max(120).optional(),
  replaceExisting: z.boolean().default(false),
}).strict();

const runLoopDaemonStatusInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
}).strict();

const runLoopDaemonStopInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  reason: z.string().min(1).max(500).default("user_stop_requested"),
}).strict();

const runLoopDaemonLogTailInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  maxLines: z.number().int().min(1).max(500).default(80),
}).strict();

const runLoopRecoverPlanInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
}).strict();

const runLoopRecoverStepInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  executePreAsk: z.boolean().optional(),
  gatewayAskMode: z.enum(["off", "blocked_only"]).optional(),
  gatewayMaxOutputTokens: z.number().int().min(64).max(6000).optional(),
  gatewayTemperature: z.number().min(0).max(2).optional(),
  gatewayTimeoutMs: z.number().int().min(5000).max(180000).optional(),
}).strict();

const runLoopRecoverPruneMissingChatInputSchema = z.object({
  runId: z.string().min(1).max(120).optional(),
  missingChatIds: z.array(z.string().min(1)).max(200).default([]),
  confirmMissingChatRemoval: z.boolean().default(false),
}).strict();

type RunLoopDaemonRuntime = {
  runId: string;
  stopRequested: boolean;
  startedAt: string;
};

const activeRunLoopDaemons = new Map<string, RunLoopDaemonRuntime>();
const defaultRunLoopDaemonId = "default";
const runLoopDaemonStaleAfterMs = 60000;
const runLoopDaemonMaxLogBytes = 1024 * 1024;

const preAskImplementationCaptureInputSchema = z.object({
  workspacePath: z.string().min(1),
  beforeHead: z.string().min(1),
  checkNames: z.array(z.string().min(1)).max(20).default([]),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
  baselineAssistantHash: z.string().min(1).optional(),
  lastGuardedAssistantHash: z.string().min(1).optional(),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  minStableSamples: z.number().int().min(2).max(30).optional(),
  idleQuietMs: z.number().int().min(1000).max(300000).optional(),
  requireComposerSendMode: z.boolean().default(true),
  watchMode: z.enum(["off", "probe_only", "required"]).default("off"),
  watchPhase: z.enum(["startup", "after_send", "reply_watch", "settle_gate"]).default("reply_watch"),
  watchTaskClass: z.enum(["startup_light", "tiny_validation", "short_reply", "normal_answer", "code_patch", "repo_scan", "repo_rc_implementation", "repair_iteration"]).default("normal_answer"),
  watchSentAt: z.string().min(1).optional(),
  watchLastProgressAt: z.string().min(1).optional(),
  watchAttempt: z.number().int().min(0).max(1000).default(0),
  watchPreviousAssistantHash: z.string().min(1).optional(),
  watchPreviousTextLength: z.number().int().min(0).optional(),
  watchPreviousTailHash: z.string().min(1).optional(),
  watchPreviousOutlineHash: z.string().min(1).optional(),
  watchPreviousOutlineSectionCount: z.number().int().min(0).optional(),
  watchPreviousScrollHeight: z.number().int().min(0).optional(),
  watchInputTokens: z.number().int().min(0).max(200000).optional(),
  watchExpectedOutputTokens: z.number().int().min(0).max(200000).optional(),
  includeDiff: z.boolean().default(true),
  diffMaxChars: z.number().int().min(1000).max(120000).default(30000),
  maxCommits: z.number().int().min(1).max(100).default(30),
  gatewayAskMode: z.enum(["off", "blocked_only"]).default("blocked_only"),
  gatewayModel: z.string().min(1).max(200).optional(),
  gatewayMaxOutputTokens: z.number().int().min(64).max(6000).default(1200),
  gatewayTemperature: z.number().min(0).max(2).default(0.1),
  gatewayTimeoutMs: z.number().int().min(5000).max(180000).default(60000),
  gatewayRaw: z.boolean().default(false),
  gatewayConsoleEndpoint: z.string().min(1).max(200).optional(),
}).strict();

type GitCommandResult = {
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
};

export function registerImplementationRunCaptureTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.implementation.run.capture",
    {
      description: "Read-only hybrid capture for a ChatGPT implementation run: compare before/after Git state, collect commits and diffs, and run deterministic gate checks.",
      inputSchema: implementationRunCaptureInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await captureImplementationRun(policy, baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.step",
    {
      description: "Read-only controlled single ChatGPT run-loop step: probe, plan, and optionally run pre-ASK without sleeping or submitting prompts.",
      inputSchema: runLoopStepInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await captureChatGptRunLoopStep(policy, baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.step.summary",
    {
      description: "Read-only compact summary for one controlled ChatGPT run-loop step without large nested watch, plan, or pre-ASK payloads.",
      inputSchema: runLoopStepInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await captureChatGptRunLoopStepSummary(policy, baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.auto.summary",
    {
      description: "Read-only bounded automatic ChatGPT run-loop summary: repeats controlled steps until ready, stopped, or bounded limits are reached; never submits prompts or mutates the browser.",
      inputSchema: runLoopAutoSummaryInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await captureChatGptRunLoopAutoSummary(policy, baseDir, input))
  );

  server.registerTool(
    "console.write.browser.chatgpt.run.loop.daemon.start",
    {
      description: "Start a supervised bounded ChatGPT run-loop daemon in the MCP server process; it writes state/log files and never submits prompts or mutates the browser.",
      inputSchema: runLoopDaemonStartInputSchema,
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await startChatGptRunLoopDaemon(policy, baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.daemon.status",
    {
      description: "Read supervised ChatGPT run-loop daemon status from memory and state files.",
      inputSchema: runLoopDaemonStatusInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await readChatGptRunLoopDaemonStatus(baseDir, input))
  );

  server.registerTool(
    "console.write.browser.chatgpt.run.loop.daemon.stop",
    {
      description: "Request a supervised ChatGPT run-loop daemon to stop; no browser mutation or prompt submission is performed.",
      inputSchema: runLoopDaemonStopInputSchema,
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await stopChatGptRunLoopDaemon(baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.daemon.log.tail",
    {
      description: "Read the tail of the supervised ChatGPT run-loop daemon compact log.",
      inputSchema: runLoopDaemonLogTailInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await tailChatGptRunLoopDaemonLog(baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.run.loop.recover.plan",
    {
      description: "Read-only recovery plan for non-terminal supervised ChatGPT run-loop daemon state files after server restart.",
      inputSchema: runLoopRecoverPlanInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await planChatGptRunLoopRecovery(baseDir, input))
  );

  server.registerTool(
    "console.write.browser.chatgpt.run.loop.recover.step",
    {
      description: "Controlled single recovery step for a non-terminal ChatGPT run-loop: re-bind/probe through the existing run-loop pipeline and persist a new checkpoint; never submits prompts.",
      inputSchema: runLoopRecoverStepInputSchema,
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await stepChatGptRunLoopRecovery(policy, baseDir, input))
  );

  server.registerTool(
    "console.write.browser.chatgpt.run.loop.recover.prune.missing_chat",
    {
      description: "Remove durable ChatGPT run-loop state/journal sections whose chat id was explicitly confirmed as missing; never infers deletion from a lost tab binding alone.",
      inputSchema: runLoopRecoverPruneMissingChatInputSchema,
      ...buildConsoleMutationToolRegistration(authConfig),
    },
    async (input) => textResult(await pruneMissingChatRunLoopRecovery(baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.implementation.pre_ask.capture",
    {
      description: "Read-only pre-ASK chain: settle ChatGPT answer, capture assistant intent, compare Git before/after state, collect diffs, and run deterministic gate checks.",
      inputSchema: preAskImplementationCaptureInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await capturePreAskImplementationRun(policy, baseDir, input))
  );
}

async function captureChatGptRunLoopStep(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof runLoopStepInputSchema>): Promise<Record<string, unknown>> {
  const watch = await runChatGptWatchProbe({
    ports: input.ports,
    preferredChatId: input.preferredChatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    phase: input.phase === "pre_ask" || input.phase === "return_to_chat" ? "reply_watch" : input.phase,
    taskClass: input.taskClass,
    sentAt: input.sentAt,
    baselineAssistantHash: input.baselineAssistantHash,
    previousAssistantHash: input.lastSeenAssistantHash,
    previousTextLength: input.lastSeenTextLength,
    previousTailHash: input.lastSeenTailHash,
    previousOutlineHash: input.lastSeenOutlineHash,
    previousOutlineSectionCount: input.lastSeenOutlineSectionCount,
    previousScrollHeight: input.lastSeenScrollHeight,
    lastProgressAt: input.lastProgressAt,
    attempt: input.attempt,
    inputTokens: input.inputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
  });
  const watchDecision = typeof watch.decision === "object" && watch.decision !== null ? watch.decision as Record<string, unknown> : {};
  const contextUpdate = typeof watch.context_update === "object" && watch.context_update !== null ? watch.context_update as Record<string, unknown> : {};
  const selected = typeof watch.selected === "object" && watch.selected !== null ? watch.selected as Record<string, unknown> : {};
  const chatId = typeof contextUpdate.chatId === "string" ? contextUpdate.chatId : (typeof selected.chat_id === "string" ? selected.chat_id : input.preferredChatId);
  const plan = runChatGptRunLoopPlan({
    phase: input.phase,
    taskClass: input.taskClass,
    iteration: input.iteration,
    maxIterations: input.maxIterations,
    watchStatus: typeof watchDecision.status === "string" ? watchDecision.status : String(watch.status ?? "WATCH_UNKNOWN"),
    watchNextAction: typeof watchDecision.next_action === "string" ? watchDecision.next_action : undefined,
    watchNextProbeAfterMs: typeof watchDecision.next_probe_after_ms === "number" ? watchDecision.next_probe_after_ms : undefined,
    sentAt: typeof contextUpdate.sentAt === "string" ? contextUpdate.sentAt : input.sentAt,
    lastProgressAt: typeof contextUpdate.lastProgressAt === "string" ? contextUpdate.lastProgressAt : input.lastProgressAt,
    attempt: typeof contextUpdate.attempt === "number" ? contextUpdate.attempt : input.attempt + 1,
    chatId,
    workspacePath: input.workspacePath,
    beforeHead: input.beforeHead,
    lastSeenAssistantHash: typeof contextUpdate.lastSeenAssistantHash === "string" ? contextUpdate.lastSeenAssistantHash : input.lastSeenAssistantHash,
    lastSeenTextLength: typeof contextUpdate.lastSeenTextLength === "number" ? contextUpdate.lastSeenTextLength : input.lastSeenTextLength,
    lastSeenTailHash: typeof contextUpdate.lastSeenTailHash === "string" ? contextUpdate.lastSeenTailHash : input.lastSeenTailHash,
    lastSeenOutlineHash: typeof contextUpdate.lastSeenOutlineHash === "string" ? contextUpdate.lastSeenOutlineHash : input.lastSeenOutlineHash,
    lastSeenOutlineSectionCount: typeof contextUpdate.lastSeenOutlineSectionCount === "number" ? contextUpdate.lastSeenOutlineSectionCount : input.lastSeenOutlineSectionCount,
    lastSeenScrollHeight: typeof contextUpdate.lastSeenScrollHeight === "number" ? contextUpdate.lastSeenScrollHeight : input.lastSeenScrollHeight,
  });
  const nextAction = typeof plan.next_action === "string" ? plan.next_action : "UNKNOWN";
  const shouldRunPreAsk = input.executePreAsk && nextAction === "RUN_PRE_ASK_CAPTURE" && input.workspacePath && input.beforeHead;
  const preAsk = shouldRunPreAsk ? await capturePreAskImplementationRun(policy, baseDir, {
    workspacePath: input.workspacePath as string,
    beforeHead: input.beforeHead as string,
    checkNames: input.checkNames,
    ports: input.ports,
    preferredChatId: chatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    readinessProfile: "rc_gate",
    requireComposerSendMode: true,
    watchMode: "probe_only",
    watchPhase: "reply_watch",
    watchTaskClass: input.taskClass,
    watchSentAt: input.sentAt,
    watchLastProgressAt: typeof contextUpdate.lastProgressAt === "string" ? contextUpdate.lastProgressAt : input.lastProgressAt,
    watchAttempt: typeof contextUpdate.attempt === "number" ? contextUpdate.attempt : input.attempt + 1,
    watchPreviousAssistantHash: typeof contextUpdate.lastSeenAssistantHash === "string" ? contextUpdate.lastSeenAssistantHash : input.lastSeenAssistantHash,
    watchPreviousTextLength: typeof contextUpdate.lastSeenTextLength === "number" ? contextUpdate.lastSeenTextLength : input.lastSeenTextLength,
    watchPreviousTailHash: typeof contextUpdate.lastSeenTailHash === "string" ? contextUpdate.lastSeenTailHash : input.lastSeenTailHash,
    watchPreviousOutlineHash: typeof contextUpdate.lastSeenOutlineHash === "string" ? contextUpdate.lastSeenOutlineHash : input.lastSeenOutlineHash,
    watchPreviousOutlineSectionCount: typeof contextUpdate.lastSeenOutlineSectionCount === "number" ? contextUpdate.lastSeenOutlineSectionCount : input.lastSeenOutlineSectionCount,
    watchPreviousScrollHeight: typeof contextUpdate.lastSeenScrollHeight === "number" ? contextUpdate.lastSeenScrollHeight : input.lastSeenScrollHeight,
    includeDiff: true,
    diffMaxChars: 30000,
    maxCommits: 30,
    gatewayAskMode: input.gatewayAskMode,
    gatewayRaw: false,
    gatewayMaxOutputTokens: input.gatewayMaxOutputTokens,
    gatewayTemperature: input.gatewayTemperature,
    gatewayTimeoutMs: input.gatewayTimeoutMs,
  }) : null;

  const status = preAsk === null ? String(plan.status ?? "RUN_LOOP_PLANNED") : String(preAsk.status ?? "PRE_ASK_DONE");
  const resolvedNextAction = preAsk === null ? nextAction : (preAsk.preAskReady === true || preAsk.status === "PRE_ASK_READY" ? "RETURN_TO_CHAT" : "WAIT_AND_PROBE");
  const preAskCaptureExecuted = preAsk !== null;
  return {
    ok: preAsk === null ? plan.ok !== false : preAsk.ok === true,
    status,
    next_action: resolvedNextAction,
    summary: {
      tool: "console.read_.browser.chatgpt.run.loop.step",
      status,
      next_action: resolvedNextAction,
      watch_status: String(watch.status ?? "WATCH_UNKNOWN"),
      watch_decision_status: typeof watchDecision.status === "string" ? watchDecision.status : null,
      plan_status: typeof plan.status === "string" ? plan.status : null,
      plan_next_action: typeof plan.next_action === "string" ? plan.next_action : null,
      pre_ask_status: preAsk === null ? null : String(preAsk.status ?? "PRE_ASK_DONE"),
      executed_watch_probe: true,
      executed_pre_ask_capture: preAskCaptureExecuted,
      prompt_submit: false,
      sleep: false,
      safe_to_continue: resolvedNextAction === "WAIT_AND_PROBE" || resolvedNextAction === "RUN_PRE_ASK_CAPTURE" || resolvedNextAction === "RETURN_TO_CHAT",
      canonical_next_tool: resolveCanonicalNextTool(resolvedNextAction),
    },
    watch,
    plan,
    pre_ask: preAsk,
    executed: {
      watch_probe: true,
      pre_ask_capture: preAskCaptureExecuted,
      prompt_submit: false,
      sleep: false,
    },
    policy: {
      browser_mutation: false,
      prompt_injection: false,
      auto_submit: false,
      dom_write: false,
      single_step_only: true,
    },
  };
}

async function captureChatGptRunLoopStepSummary(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof runLoopStepInputSchema>): Promise<Record<string, unknown>> {
  const result = await captureChatGptRunLoopStep(policy, baseDir, input);
  const baseSummary = typeof result.summary === "object" && result.summary !== null ? result.summary as Record<string, unknown> : {};
  const status = String(result.status ?? baseSummary.status ?? "RUN_LOOP_UNKNOWN");
  const nextAction = String(result.next_action ?? baseSummary.next_action ?? "UNKNOWN");
  const summary = {
    tool: "console.read_.browser.chatgpt.run.loop.step.summary",
    underlying_tool: "console.read_.browser.chatgpt.run.loop.step",
    status,
    next_action: nextAction,
    watch_status: String(baseSummary.watch_status ?? "WATCH_UNKNOWN"),
    watch_decision_status: typeof baseSummary.watch_decision_status === "string" ? baseSummary.watch_decision_status : null,
    plan_status: typeof baseSummary.plan_status === "string" ? baseSummary.plan_status : null,
    plan_next_action: typeof baseSummary.plan_next_action === "string" ? baseSummary.plan_next_action : null,
    pre_ask_status: typeof baseSummary.pre_ask_status === "string" ? baseSummary.pre_ask_status : null,
    executed_watch_probe: baseSummary.executed_watch_probe === true,
    executed_pre_ask_capture: baseSummary.executed_pre_ask_capture === true,
    prompt_submit: false,
    sleep: false,
    safe_to_continue: baseSummary.safe_to_continue === true,
    canonical_next_tool: typeof baseSummary.canonical_next_tool === "string" ? baseSummary.canonical_next_tool : null,
  };

  return {
    ok: result.ok === true,
    status,
    next_action: nextAction,
    summary,
    policy: compactRunLoopPolicy(),
  };
}

async function captureChatGptRunLoopAutoSummary(policy: ConsolePolicy, baseDir: string, rawInput: z.infer<typeof runLoopAutoSummaryInputSchema>): Promise<Record<string, unknown>> {
  const input = normalizeRunLoopTimingInput(rawInput);
  const startedAt = Date.now();
  const trace = [];
  let currentInput: z.infer<typeof runLoopStepInputSchema> = {
    workspacePath: input.workspacePath,
    beforeHead: input.beforeHead,
    checkNames: input.checkNames,
    ports: input.ports,
    preferredChatId: input.preferredChatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    phase: input.phase,
    taskClass: input.taskClass,
    iteration: input.iteration,
    maxIterations: input.maxIterations,
    sentAt: input.sentAt,
    lastProgressAt: input.lastProgressAt,
    attempt: input.attempt,
    baselineAssistantHash: input.baselineAssistantHash,
    lastSeenAssistantHash: input.lastSeenAssistantHash,
    lastSeenTextLength: input.lastSeenTextLength,
    lastSeenTailHash: input.lastSeenTailHash,
    lastSeenOutlineHash: input.lastSeenOutlineHash,
    lastSeenOutlineSectionCount: input.lastSeenOutlineSectionCount,
    lastSeenScrollHeight: input.lastSeenScrollHeight,
    inputTokens: input.inputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
    executePreAsk: input.executePreAsk,
    gatewayAskMode: input.gatewayAskMode,
    gatewayMaxOutputTokens: input.gatewayMaxOutputTokens,
    gatewayTemperature: input.gatewayTemperature,
    gatewayTimeoutMs: input.gatewayTimeoutMs,
  };
  let lastResult: Record<string, unknown> | null = null;
  let stopReason = "max_auto_iterations_reached";
  let iterations = 0;
  let waitedMs = 0;

  for (let index = 0; index < input.maxAutoIterations; index += 1) {
    if (Date.now() - startedAt >= input.maxElapsedMs) {
      stopReason = "max_elapsed_ms_reached_before_step";
      break;
    }

    const result = await captureChatGptRunLoopStep(policy, baseDir, currentInput);
    lastResult = result;
    iterations += 1;
    const summary = typeof result.summary === "object" && result.summary !== null ? result.summary as Record<string, unknown> : {};
    const plan = typeof result.plan === "object" && result.plan !== null ? result.plan as Record<string, unknown> : {};
    const watch = typeof result.watch === "object" && result.watch !== null ? result.watch as Record<string, unknown> : {};
    const nextAction = String(result.next_action ?? summary.next_action ?? "UNKNOWN");
    const preAskExecuted = summary.executed_pre_ask_capture === true;
    trace.push({
      iteration: currentInput.iteration,
      status: String(result.status ?? summary.status ?? "RUN_LOOP_UNKNOWN"),
      next_action: nextAction,
      watch_status: String(summary.watch_status ?? "WATCH_UNKNOWN"),
      plan_status: typeof summary.plan_status === "string" ? summary.plan_status : null,
      pre_ask_status: typeof summary.pre_ask_status === "string" ? summary.pre_ask_status : null,
      executed_pre_ask_capture: preAskExecuted,
      elapsed_ms: Date.now() - startedAt,
    });

    if (nextAction === "STOP_FOR_USER") {
      stopReason = "planner_stop_for_user";
      break;
    }
    if (input.stopOnReturnToChat && nextAction === "RETURN_TO_CHAT") {
      stopReason = "return_to_chat_reached";
      break;
    }
    if (input.stopOnPreAskExecuted && preAskExecuted) {
      stopReason = "pre_ask_capture_executed";
      break;
    }
    if (nextAction !== "WAIT_AND_PROBE") {
      stopReason = `non_wait_next_action:${nextAction}`;
      break;
    }

    const waitMs = clampWaitMs(typeof plan.next_probe_after_ms === "number" ? plan.next_probe_after_ms : input.pollMs, input.minWaitMs, input.maxWaitMs);
    if (Date.now() - startedAt + waitMs > input.maxElapsedMs) {
      stopReason = "max_elapsed_ms_reached_before_wait";
      break;
    }
    await sleepMs(waitMs);
    waitedMs += waitMs;
    currentInput = buildNextRunLoopStepInput(currentInput, watch, index + 1);
  }

  const finalSummary = lastResult !== null && typeof lastResult.summary === "object" && lastResult.summary !== null ? lastResult.summary as Record<string, unknown> : {};
  const status = String(lastResult?.status ?? finalSummary.status ?? stopReason);
  const nextAction = String(lastResult?.next_action ?? finalSummary.next_action ?? "UNKNOWN");
  return {
    ok: lastResult !== null && lastResult.ok === true,
    status,
    next_action: nextAction,
    stop_reason: stopReason,
    iterations,
    elapsed_ms: Date.now() - startedAt,
    waited_ms: waitedMs,
    summary: {
      tool: "console.read_.browser.chatgpt.run.loop.auto.summary",
      underlying_tool: "console.read_.browser.chatgpt.run.loop.step.summary",
      status,
      next_action: nextAction,
      stop_reason: stopReason,
      iterations,
      waited_ms: waitedMs,
      watch_status: String(finalSummary.watch_status ?? "WATCH_UNKNOWN"),
      watch_decision_status: typeof finalSummary.watch_decision_status === "string" ? finalSummary.watch_decision_status : null,
      plan_status: typeof finalSummary.plan_status === "string" ? finalSummary.plan_status : null,
      plan_next_action: typeof finalSummary.plan_next_action === "string" ? finalSummary.plan_next_action : null,
      pre_ask_status: typeof finalSummary.pre_ask_status === "string" ? finalSummary.pre_ask_status : null,
      executed_watch_probe: iterations > 0,
      executed_pre_ask_capture: finalSummary.executed_pre_ask_capture === true,
      prompt_submit: false,
      sleep: waitedMs > 0,
      safe_to_continue: finalSummary.safe_to_continue === true,
      canonical_next_tool: typeof finalSummary.canonical_next_tool === "string" ? finalSummary.canonical_next_tool : null,
    },
    trace,
    policy: compactRunLoopAutoPolicy(),
  };
}

async function startChatGptRunLoopDaemon(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof runLoopDaemonStartInputSchema>): Promise<Record<string, unknown>> {
  const runId = normalizeRunLoopDaemonId(input.runId);
  if (activeRunLoopDaemons.has(runId) && !input.replaceExisting) {
    return {
      ok: false,
      status: "DAEMON_ALREADY_RUNNING",
      run_id: runId,
      policy: compactRunLoopDaemonPolicy(),
    };
  }

  const paths = runLoopDaemonPaths(baseDir, runId);
  await mkdir(paths.dir, { recursive: true });
  await rm(paths.stop, { force: true });
  const runtime: RunLoopDaemonRuntime = { runId, stopRequested: false, startedAt: new Date().toISOString() };
  activeRunLoopDaemons.set(runId, runtime);
  const daemonInput = normalizeRunLoopTimingInput(toRunLoopAutoSummaryInput(input));
  await writeRunLoopDaemonState(paths.state, {
    ok: true,
    status: "DAEMON_STARTED",
    run_id: runId,
    server_pid: process.pid,
    started_at: runtime.startedAt,
    heartbeat_at: runtime.startedAt,
    completed_at: null,
    active: true,
    input: compactDaemonInput(daemonInput),
    memory: buildMemorySnapshot(),
    policy: compactRunLoopDaemonPolicy(),
  });
  await appendRunLoopDaemonLog(paths.log, { event: "started", run_id: runId, server_pid: process.pid, at: runtime.startedAt });
  void runChatGptRunLoopDaemon(policy, baseDir, runId, runtime, daemonInput).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    await appendRunLoopDaemonLog(paths.log, { event: "fatal_error", run_id: runId, at: new Date().toISOString(), error: message });
    await writeRunLoopDaemonState(paths.state, {
      ok: false,
      status: "DAEMON_ERROR",
      run_id: runId,
      server_pid: process.pid,
      active: false,
      completed_at: new Date().toISOString(),
      last_error: message,
      error: message,
      memory: buildMemorySnapshot(),
      policy: compactRunLoopDaemonPolicy(),
    });
    activeRunLoopDaemons.delete(runId);
  });

  return {
    ok: true,
    status: "DAEMON_STARTED",
    run_id: runId,
    server_pid: process.pid,
    state_file: paths.state,
    log_file: paths.log,
    stop_file: paths.stop,
    policy: compactRunLoopDaemonPolicy(),
  };
}

async function readChatGptRunLoopDaemonStatus(baseDir: string, input: z.infer<typeof runLoopDaemonStatusInputSchema>): Promise<Record<string, unknown>> {
  const runId = normalizeRunLoopDaemonId(input.runId);
  const paths = runLoopDaemonPaths(baseDir, runId);
  const state = await readRunLoopDaemonState(paths.state);
  const activeInMemory = activeRunLoopDaemons.has(runId);
  const staleState = isRunLoopDaemonStateStale(state, activeInMemory);
  return {
    ok: state !== null,
    status: state === null ? "DAEMON_STATE_NOT_FOUND" : String(state.status ?? "DAEMON_STATE_FOUND"),
    status_effective: state === null ? "missing" : staleState ? "stale" : activeInMemory ? "active" : String(state.status ?? "unknown"),
    run_id: runId,
    active_in_memory: activeInMemory,
    stale_state: staleState,
    state_file: paths.state,
    log_file: paths.log,
    stop_file: paths.stop,
    state,
    policy: compactRunLoopDaemonPolicy(),
  };
}

async function stopChatGptRunLoopDaemon(baseDir: string, input: z.infer<typeof runLoopDaemonStopInputSchema>): Promise<Record<string, unknown>> {
  const runId = normalizeRunLoopDaemonId(input.runId);
  const paths = runLoopDaemonPaths(baseDir, runId);
  await mkdir(paths.dir, { recursive: true });
  const runtime = activeRunLoopDaemons.get(runId);
  if (runtime) {
    runtime.stopRequested = true;
  }
  const stopPayload = { event: "stop_requested", run_id: runId, at: new Date().toISOString(), reason: input.reason };
  await writeFile(paths.stop, JSON.stringify(stopPayload, null, 2), "utf8");
  await appendRunLoopDaemonLog(paths.log, stopPayload);
  return {
    ok: true,
    status: runtime ? "DAEMON_STOP_REQUESTED" : "DAEMON_STOP_FILE_WRITTEN",
    run_id: runId,
    active_in_memory: Boolean(runtime),
    stop_file: paths.stop,
    policy: compactRunLoopDaemonPolicy(),
  };
}

async function tailChatGptRunLoopDaemonLog(baseDir: string, input: z.infer<typeof runLoopDaemonLogTailInputSchema>): Promise<Record<string, unknown>> {
  const runId = normalizeRunLoopDaemonId(input.runId);
  const paths = runLoopDaemonPaths(baseDir, runId);
  const text = await readTextIfExists(paths.log);
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    ok: text.length > 0,
    status: text.length > 0 ? "DAEMON_LOG_FOUND" : "DAEMON_LOG_NOT_FOUND",
    run_id: runId,
    log_file: paths.log,
    line_count: lines.length,
    max_lines: input.maxLines,
    lines: lines.slice(-input.maxLines),
    policy: compactRunLoopDaemonPolicy(),
  };
}

async function planChatGptRunLoopRecovery(baseDir: string, input: z.infer<typeof runLoopRecoverPlanInputSchema>): Promise<Record<string, unknown>> {
  const runIds = input.runId ? [normalizeRunLoopDaemonId(input.runId)] : await listRunLoopDaemonIds(baseDir);
  const runs = [];
  for (const runId of runIds) {
    const paths = runLoopDaemonPaths(baseDir, runId);
    const state = await readRunLoopDaemonState(paths.state);
    const activeInMemory = activeRunLoopDaemons.has(runId);
    const staleState = isRunLoopDaemonStateStale(state, activeInMemory);
    const classification = classifyRunLoopRecoveryState(state, activeInMemory);
    runs.push({
      run_id: runId,
      status: state === null ? "DAEMON_STATE_NOT_FOUND" : String(state.status ?? "DAEMON_STATE_FOUND"),
      status_effective: state === null ? "missing" : staleState ? "stale" : activeInMemory ? "active" : String(state.status ?? "unknown"),
      active_in_memory: activeInMemory,
      stale_state: staleState,
      recoverable: classification.recoverable,
      decision: classification.decision,
      reason: classification.reason,
      next_tool: classification.recoverable ? "console.write.browser.chatgpt.run.loop.recover.step" : null,
      workspacePath: extractStringPath(state, ["resume_input", "workspacePath"]) ?? extractStringPath(state, ["input", "workspacePath"]),
      preferredChatId: extractStringPath(state, ["resume_input", "preferredChatId"]) ?? extractStringPath(state, ["input", "preferredChatId"]),
      iteration: typeof state?.iteration === "number" ? state.iteration : null,
      iterations: typeof state?.iterations === "number" ? state.iterations : null,
      next_action: extractStringPath(state, ["summary", "next_action"]),
      state_file: paths.state,
      log_file: paths.log,
      stop_file: paths.stop,
    });
  }

  const recoverableRuns = runs.filter((run) => run.recoverable === true);
  return {
    ok: true,
    status: recoverableRuns.length > 0 ? "RECOVERABLE_RUNS_FOUND" : "NO_RECOVERABLE_RUNS",
    recoverable_count: recoverableRuns.length,
    run_count: runs.length,
    runs,
    policy: compactRunLoopRecoveryPolicy(),
  };
}

async function stepChatGptRunLoopRecovery(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof runLoopRecoverStepInputSchema>): Promise<Record<string, unknown>> {
  const runId = normalizeRunLoopDaemonId(input.runId);
  const paths = runLoopDaemonPaths(baseDir, runId);
  const state = await readRunLoopDaemonState(paths.state);
  const activeInMemory = activeRunLoopDaemons.has(runId);
  const classification = classifyRunLoopRecoveryState(state, activeInMemory);
  if (state === null || !classification.recoverable) {
    return {
      ok: false,
      status: "RUN_LOOP_RECOVERY_NOT_ALLOWED",
      run_id: runId,
      decision: classification.decision,
      reason: classification.reason,
      active_in_memory: activeInMemory,
      state_file: paths.state,
      policy: compactRunLoopRecoveryPolicy(),
    };
  }

  const restoredInput = restoreRunLoopStepInputFromState(state, input);
  const result = await captureChatGptRunLoopStep(policy, baseDir, restoredInput);
  const summary = typeof result.summary === "object" && result.summary !== null ? result.summary as Record<string, unknown> : {};
  const watch = typeof result.watch === "object" && result.watch !== null ? result.watch as Record<string, unknown> : {};
  const nextAction = String(result.next_action ?? summary.next_action ?? "UNKNOWN");
  const nextInput = nextAction === "WAIT_AND_PROBE"
    ? buildNextRunLoopStepInput(restoredInput, watch, restoredInput.iteration + 1)
    : restoredInput;
  const recoveredAt = new Date().toISOString();
  const checkpoint = {
    ok: result.ok === true,
    status: "RECOVERY_STEP_CAPTURED",
    result_status: String(result.status ?? summary.status ?? "RUN_LOOP_UNKNOWN"),
    next_action: nextAction,
    run_id: runId,
    server_pid: process.pid,
    active: true,
    heartbeat_at: recoveredAt,
    completed_at: null,
    iteration: restoredInput.iteration,
    iterations: typeof state.iterations === "number" ? state.iterations + 1 : 1,
    recovery: {
      recovered_at: recoveredAt,
      recovered_from_status: String(state.status ?? "unknown"),
      recovered_from_server_pid: typeof state.server_pid === "number" ? state.server_pid : null,
      decision: classification.decision,
    },
    input: state.input ?? {},
    resume_input: compactResumeInput(nextInput),
    memory: buildMemorySnapshot(),
    summary: compactStepSummaryForDaemon(summary),
    policy: compactRunLoopRecoveryPolicy(),
  };
  await writeRunLoopDaemonState(paths.state, checkpoint);
  await appendRunLoopDaemonLog(paths.log, { event: "recovery_step", at: recoveredAt, ...checkpoint });

  return {
    ok: result.ok === true,
    status: "RUN_LOOP_RECOVERY_STEP_CAPTURED",
    run_id: runId,
    next_action: nextAction,
    recovered_input: compactResumeInput(restoredInput),
    next_resume_input: compactResumeInput(nextInput),
    checkpoint_file: paths.state,
    log_file: paths.log,
    result,
    policy: compactRunLoopRecoveryPolicy(),
  };
}

async function pruneMissingChatRunLoopRecovery(baseDir: string, input: z.infer<typeof runLoopRecoverPruneMissingChatInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmMissingChatRemoval) {
    return {
      ok: false,
      status: "MISSING_CHAT_PRUNE_CONFIRMATION_REQUIRED",
      reason: "Cleanup requires confirmMissingChatRemoval=true and at least one confirmed missing chat id.",
      policy: compactRunLoopMissingChatPrunePolicy(),
    };
  }
  const missingChatIds = new Set(input.missingChatIds.map((value) => value.trim()).filter((value) => value.length > 0));
  if (missingChatIds.size === 0) {
    return {
      ok: false,
      status: "MISSING_CHAT_ID_REQUIRED",
      reason: "No confirmed missing chat ids were supplied.",
      policy: compactRunLoopMissingChatPrunePolicy(),
    };
  }

  const runIds = input.runId ? [normalizeRunLoopDaemonId(input.runId)] : await listRunLoopDaemonIds(baseDir);
  const pruned = [];
  const skipped = [];
  for (const runId of runIds) {
    const paths = runLoopDaemonPaths(baseDir, runId);
    const state = await readRunLoopDaemonState(paths.state);
    const chatId = extractRunLoopStateChatId(state);
    if (chatId === null) {
      skipped.push({ run_id: runId, reason: "state_has_no_chat_id", state_file: paths.state });
      continue;
    }
    if (!missingChatIds.has(chatId)) {
      skipped.push({ run_id: runId, chat_id: chatId, reason: "chat_id_not_in_confirmed_missing_set", state_file: paths.state });
      continue;
    }
    if (activeRunLoopDaemons.has(runId)) {
      skipped.push({ run_id: runId, chat_id: chatId, reason: "daemon_active_in_memory", state_file: paths.state });
      continue;
    }
    await rm(paths.dir, { recursive: true, force: true });
    pruned.push({ run_id: runId, chat_id: chatId, removed_dir: paths.dir });
  }

  return {
    ok: true,
    status: pruned.length > 0 ? "MISSING_CHAT_SECTIONS_PRUNED" : "NO_MISSING_CHAT_SECTIONS_PRUNED",
    requested_missing_chat_ids: Array.from(missingChatIds).sort(),
    pruned_count: pruned.length,
    skipped_count: skipped.length,
    pruned,
    skipped,
    policy: compactRunLoopMissingChatPrunePolicy(),
  };
}

async function runChatGptRunLoopDaemon(policy: ConsolePolicy, baseDir: string, runId: string, runtime: RunLoopDaemonRuntime, input: z.infer<typeof runLoopAutoSummaryInputSchema>): Promise<void> {
  const paths = runLoopDaemonPaths(baseDir, runId);
  const startedAtMs = Date.now();
  let currentInput: z.infer<typeof runLoopStepInputSchema> = toRunLoopStepInput(input);
  let stopReason = "max_auto_iterations_reached";
  let iterations = 0;
  let waitedMs = 0;
  let lastSummary: Record<string, unknown> = {};

  for (let index = 0; index < input.maxAutoIterations; index += 1) {
    if (runtime.stopRequested || await fileExists(paths.stop)) {
      stopReason = "stop_requested";
      break;
    }
    if (Date.now() - startedAtMs >= input.maxElapsedMs) {
      stopReason = "max_elapsed_ms_reached_before_step";
      break;
    }

    const result = await captureChatGptRunLoopStep(policy, baseDir, currentInput);
    iterations += 1;
    const summary = typeof result.summary === "object" && result.summary !== null ? result.summary as Record<string, unknown> : {};
    const plan = typeof result.plan === "object" && result.plan !== null ? result.plan as Record<string, unknown> : {};
    const watch = typeof result.watch === "object" && result.watch !== null ? result.watch as Record<string, unknown> : {};
    const nextAction = String(result.next_action ?? summary.next_action ?? "UNKNOWN");
    const preAskExecuted = summary.executed_pre_ask_capture === true;
    lastSummary = summary;

    const stepState = {
      ok: result.ok === true,
      status: String(result.status ?? summary.status ?? "RUN_LOOP_UNKNOWN"),
      next_action: nextAction,
      run_id: runId,
      server_pid: process.pid,
      active: true,
      heartbeat_at: new Date().toISOString(),
      completed_at: null,
      iteration: currentInput.iteration,
      iterations,
      elapsed_ms: Date.now() - startedAtMs,
      waited_ms: waitedMs,
      memory: buildMemorySnapshot(),
      input: compactDaemonInput(input),
      resume_input: compactResumeInput(currentInput),
      summary: compactStepSummaryForDaemon(summary),
      policy: compactRunLoopDaemonPolicy(),
    };
    await writeRunLoopDaemonState(paths.state, stepState);
    await appendRunLoopDaemonLog(paths.log, { event: "step", at: new Date().toISOString(), ...stepState });

    if (nextAction === "STOP_FOR_USER") {
      stopReason = "planner_stop_for_user";
      break;
    }
    if (input.stopOnReturnToChat && nextAction === "RETURN_TO_CHAT") {
      stopReason = "return_to_chat_reached";
      break;
    }
    if (input.stopOnPreAskExecuted && preAskExecuted) {
      stopReason = "pre_ask_capture_executed";
      break;
    }
    if (nextAction !== "WAIT_AND_PROBE") {
      stopReason = `non_wait_next_action:${nextAction}`;
      break;
    }

    const waitMs = clampWaitMs(typeof plan.next_probe_after_ms === "number" ? plan.next_probe_after_ms : input.pollMs, input.minWaitMs, input.maxWaitMs);
    if (Date.now() - startedAtMs + waitMs > input.maxElapsedMs) {
      stopReason = "max_elapsed_ms_reached_before_wait";
      break;
    }
    const waited = await waitForRunLoopDaemon(runtime, paths.stop, waitMs);
    waitedMs += waited;
    if (runtime.stopRequested || await fileExists(paths.stop)) {
      stopReason = "stop_requested";
      break;
    }
    currentInput = buildNextRunLoopStepInput(currentInput, watch, index + 1);
  }

  const finalState = {
    ok: true,
    status: "DAEMON_STOPPED",
    stop_reason: stopReason,
    run_id: runId,
    server_pid: process.pid,
    active: false,
    heartbeat_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    iterations,
    elapsed_ms: Date.now() - startedAtMs,
    waited_ms: waitedMs,
    memory: buildMemorySnapshot(),
    input: compactDaemonInput(input),
    resume_input: compactResumeInput(currentInput),
    summary: compactStepSummaryForDaemon(lastSummary),
    policy: compactRunLoopDaemonPolicy(),
  };
  await writeRunLoopDaemonState(paths.state, finalState);
  await appendRunLoopDaemonLog(paths.log, { event: "stopped", at: new Date().toISOString(), ...finalState });
  activeRunLoopDaemons.delete(runId);
}

async function captureImplementationRun(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof implementationRunCaptureInputSchema>): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  const currentHeadResult = await gitText(policy, cwd, ["rev-parse", "HEAD"]);
  const currentHead = currentHeadResult.ok ? currentHeadResult.stdout.trim() : null;
  const beforeHead = input.beforeHead ? sanitizeCommitish(input.beforeHead) : currentHead;
  const branchResult = await gitText(policy, cwd, ["branch", "--show-current"]);
  const statusResult = await gitText(policy, cwd, ["status", "--short"]);
  const statusLines = splitLines(statusResult.stdout);
  const repoClean = statusResult.ok && statusLines.length === 0;
  const headChanged = Boolean(beforeHead && currentHead && beforeHead !== currentHead);
  const hasBeforeHead = Boolean(input.beforeHead);

  const commitRange = beforeHead && currentHead && beforeHead !== currentHead ? `${beforeHead}..${currentHead}` : null;
  const commitLogResult = commitRange
    ? await gitText(policy, cwd, ["log", `--max-count=${input.maxCommits}`, "--oneline", "--decorate", commitRange])
    : null;
  const commitList = commitLogResult ? splitLines(commitLogResult.stdout) : [];
  const committedDiffStatResult = commitRange
    ? await gitText(policy, cwd, ["diff", "--stat", commitRange])
    : null;
  const committedDiffResult = commitRange && input.includeDiff
    ? await gitText(policy, cwd, ["diff", commitRange], input.diffMaxChars)
    : null;
  const dirtyDiffStatResult = repoClean ? null : await gitText(policy, cwd, ["diff", "--stat"]);
  const dirtyDiffResult = !repoClean && input.includeDiff
    ? await gitText(policy, cwd, ["diff"], input.diffMaxChars)
    : null;

  const gateResults = [];
  for (const checkName of input.checkNames) {
    const startedAt = Date.now();
    try {
      const result = await executeNamedCheck(policy, baseDir, cwd, checkName);
      gateResults.push({ ...result, duration_wrapper_ms: Date.now() - startedAt });
    } catch (error) {
      gateResults.push({ ok: false, check_name: checkName, error: error instanceof Error ? error.message : String(error), duration_wrapper_ms: Date.now() - startedAt });
    }
  }

  const gateOk = gateResults.length === 0 ? null : gateResults.every((result) => result.ok === true);
  const status = classifyRunCapture({ hasBeforeHead, headChanged, repoClean, gateOk });
  const blockingReasons = buildImplementationBlockingReasons({ hasBeforeHead, headChanged, repoClean, gateOk, statusLines, gateResults });
  const deterministicVerdict = buildDeterministicVerdict({ hasBeforeHead, headChanged, repoClean, gateOk, blockingReasons });
  const assistantSummary = summarizeAssistantMessage(input.assistantMessage ?? "");

  return {
    ok: status === "NO_REPO_CHANGE" || status === "REPO_CHANGED_GATE_GREEN" || status === "REPO_CHANGED_NO_GATE_REQUESTED",
    status,
    deterministic_verdict: deterministicVerdict,
    deterministic_finding_count: blockingReasons.length,
    blocking_reasons: blockingReasons,
    workspace: {
      path: cwd,
      branch: branchResult.ok ? branchResult.stdout.trim() : null,
      branch_read_ok: branchResult.ok,
    },
    git: {
      before_head: beforeHead,
      before_head_supplied: hasBeforeHead,
      current_head: currentHead,
      head_changed: headChanged,
      commit_range: commitRange,
      repo_clean: repoClean,
      status_lines: statusLines,
      status_line_count: statusLines.length,
      current_head_read: currentHeadResult,
      status_read: statusResult,
    },
    commits: {
      count: commitList.length,
      lines: commitList,
      log: commitLogResult,
    },
    diff: {
      committed_stat: committedDiffStatResult,
      committed: committedDiffResult,
      dirty_stat: dirtyDiffStatResult,
      dirty: dirtyDiffResult,
    },
    gate: {
      requested: input.checkNames,
      ok: gateOk,
      results: gateResults,
    },
    assistant: assistantSummary,
    ask_material: buildAskMaterial({
      status,
      beforeHead,
      currentHead,
      branch: branchResult.ok ? branchResult.stdout.trim() : null,
      statusLines,
      commitList,
      committedDiffStat: committedDiffStatResult?.stdout ?? "",
      dirtyDiffStat: dirtyDiffStatResult?.stdout ?? "",
      gateResults,
      assistantMessage: input.assistantMessage ?? "",
      diffText: committedDiffResult?.stdout || dirtyDiffResult?.stdout || "",
      diffMaxChars: input.diffMaxChars,
    }),
  };
}

async function capturePreAskImplementationRun(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof preAskImplementationCaptureInputSchema>): Promise<Record<string, unknown>> {
  const watch = input.watchMode === "off" ? null : await runChatGptWatchProbe({
    ports: input.ports,
    preferredChatId: input.preferredChatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    phase: input.watchPhase,
    taskClass: input.watchTaskClass,
    sentAt: input.watchSentAt,
    baselineAssistantHash: input.baselineAssistantHash,
    previousAssistantHash: input.watchPreviousAssistantHash,
    previousTextLength: input.watchPreviousTextLength,
    previousTailHash: input.watchPreviousTailHash,
    previousOutlineHash: input.watchPreviousOutlineHash,
    previousOutlineSectionCount: input.watchPreviousOutlineSectionCount,
    previousScrollHeight: input.watchPreviousScrollHeight,
    lastProgressAt: input.watchLastProgressAt,
    attempt: input.watchAttempt,
    inputTokens: input.watchInputTokens,
    expectedOutputTokens: input.watchExpectedOutputTokens,
  });

  const watchDecisionStatus = extractWatchDecisionStatus(watch);
  if (watch !== null && shouldReturnBeforePreAsk(input.watchMode, watchDecisionStatus)) {
    const status = mapWatchDecisionToPreAskStatus(watchDecisionStatus);
    return {
      ok: false,
      status,
      preAskReady: false,
      blocking_reasons: [`watch:${watchDecisionStatus}`],
      watch,
      settle: null,
      implementation: null,
      gateway: {
        mode: input.gatewayAskMode,
        prompted: false,
        prompt: null,
        review: null,
      },
      chatgpt_return_material: null,
      policy: {
        browser_mutation: false,
        prompt_injection: false,
        auto_submit: false,
        dom_write: false,
        sends_ask: false,
        runs_deterministic_gates: false,
        watch_mode: input.watchMode,
      },
    };
  }

  const settle = await runChatGptAnswerSettle({
    ports: input.ports,
    preferredChatId: input.preferredChatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    baselineAssistantHash: input.baselineAssistantHash,
    lastGuardedAssistantHash: input.lastGuardedAssistantHash,
    readinessProfile: input.readinessProfile,
    maxWaitMs: input.maxWaitMs,
    observationBudgetMs: input.observationBudgetMs,
    pollMs: input.pollMs,
    minStableSamples: input.minStableSamples,
    idleQuietMs: input.idleQuietMs,
    requireComposerSendMode: input.requireComposerSendMode,
  });
  const latestAssistant = extractLatestAssistant(settle);
  const implementation = await captureImplementationRun(policy, baseDir, {
    workspacePath: input.workspacePath,
    beforeHead: input.beforeHead,
    assistantMessage: latestAssistant?.text ?? "",
    checkNames: input.checkNames,
    includeDiff: input.includeDiff,
    diffMaxChars: input.diffMaxChars,
    maxCommits: input.maxCommits,
  });
  const settleOk = settle.status === "ANSWER_STABLE" && settle.settled === true && settle.ready_for_gate === true;
  const implementationOk = implementation.ok === true;
  const gate = implementation.gate as { ok?: unknown } | undefined;
  const gateOk = typeof gate?.ok === "boolean" ? gate.ok : null;
  const preAskReady = settleOk && implementationOk && gateOk !== false;
  const blockingReasons = buildPreAskBlockingReasons({ settleOk, implementationOk, gateOk, implementation });
  const admissionInput = buildImplementationAdmissionInput({ settle, implementation, latestAssistant });
  const gatewayPrompt = preAskReady || input.gatewayAskMode === "off" ? null : buildGatewayAskPrompt({ implementation, blockingReasons });
  const gatewayReview = gatewayPrompt === null ? null : await executeAsk(
    policy,
    baseDir,
    input.workspacePath,
    gatewayPrompt,
    input.gatewayModel,
    input.gatewayMaxOutputTokens,
    input.gatewayTemperature,
    input.gatewayTimeoutMs,
    input.gatewayRaw,
    input.gatewayConsoleEndpoint,
  );
  const chatgptReturnMaterial = gatewayPrompt === null || gatewayReview === null ? null : buildChatGptReturnMaterial({
    askMaterial: String(implementation.ask_material ?? ""),
    gatewayReview,
    blockingReasons,
  });

  return {
    ok: preAskReady,
    status: preAskReady ? "PRE_ASK_READY" : "PRE_ASK_BLOCKED",
    blocking_reasons: blockingReasons,
    settle_ok: settleOk,
    implementation_ok: implementationOk,
    gate_ok: gateOk,
    implementation_admission_input: admissionInput,
    gateway: {
      mode: input.gatewayAskMode,
      prompted: gatewayPrompt !== null,
      prompt: gatewayPrompt,
      review: gatewayReview,
    },
    chatgpt_return_material: chatgptReturnMaterial,
    latest_assistant_hash: latestAssistant?.hash ?? null,
    latest_assistant_index: latestAssistant?.index ?? null,
    watch,
    settle,
    implementation,
    ask_material: implementation.ask_material,
    policy: {
      browser_mutation: false,
      prompt_injection: false,
      auto_submit: false,
      dom_write: false,
      sends_ask: false,
      runs_deterministic_gates: true,
    },
  };
}

function resolveCanonicalNextTool(nextAction: string): string | null {
  if (nextAction === "WAIT_AND_PROBE") return "console.read_.browser.chatgpt.watch.probe";
  if (nextAction === "RUN_PRE_ASK_CAPTURE") return "console.read_.browser.chatgpt.implementation.pre_ask.capture";
  if (nextAction === "RETURN_TO_CHAT") return null;
  if (nextAction === "STOP_FOR_USER") return null;
  return null;
}

function compactRunLoopPolicy(): Record<string, unknown> {
  return {
    browser_mutation: false,
    prompt_injection: false,
    auto_submit: false,
    dom_write: false,
    single_step_only: true,
  };
}

function compactRunLoopAutoPolicy(): Record<string, unknown> {
  return {
    browser_mutation: false,
    prompt_injection: false,
    auto_submit: false,
    dom_write: false,
    bounded_auto_loop: true,
    background_daemon: false,
  };
}

function clampWaitMs(value: number, minWaitMs: number, maxWaitMs: number): number {
  return Math.max(minWaitMs, Math.min(maxWaitMs, value));
}

function normalizeRunLoopTimingInput(input: z.infer<typeof runLoopAutoSummaryInputSchema>): z.infer<typeof runLoopAutoSummaryInputSchema> {
  const maxWaitMs = Math.max(input.maxWaitMs, input.minWaitMs, 250);
  const pollMs = clampWaitMs(input.pollMs, input.minWaitMs, maxWaitMs);
  const perIterationBudgetMs = pollMs + input.timeoutMs + 1000;
  const requiredElapsedMs = Math.min(7200000, Math.max(1000, input.maxAutoIterations * perIterationBudgetMs));
  return {
    ...input,
    maxWaitMs,
    pollMs,
    maxElapsedMs: Math.max(input.maxElapsedMs, requiredElapsedMs),
  };
}

async function sleepMs(waitMs: number): Promise<void> {
  if (waitMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function buildNextRunLoopStepInput(currentInput: z.infer<typeof runLoopStepInputSchema>, watch: Record<string, unknown>, nextIteration: number): z.infer<typeof runLoopStepInputSchema> {
  const contextUpdate = typeof watch.context_update === "object" && watch.context_update !== null ? watch.context_update as Record<string, unknown> : {};
  const selected = typeof watch.selected === "object" && watch.selected !== null ? watch.selected as Record<string, unknown> : {};
  const chatId = typeof contextUpdate.chatId === "string" ? contextUpdate.chatId : (typeof selected.chat_id === "string" ? selected.chat_id : currentInput.preferredChatId);
  return {
    ...currentInput,
    phase: "reply_watch",
    iteration: nextIteration,
    preferredChatId: chatId,
    sentAt: typeof contextUpdate.sentAt === "string" ? contextUpdate.sentAt : currentInput.sentAt,
    lastProgressAt: typeof contextUpdate.lastProgressAt === "string" ? contextUpdate.lastProgressAt : currentInput.lastProgressAt,
    attempt: typeof contextUpdate.attempt === "number" ? contextUpdate.attempt : currentInput.attempt + 1,
    lastSeenAssistantHash: typeof contextUpdate.lastSeenAssistantHash === "string" ? contextUpdate.lastSeenAssistantHash : currentInput.lastSeenAssistantHash,
    lastSeenTextLength: typeof contextUpdate.lastSeenTextLength === "number" ? contextUpdate.lastSeenTextLength : currentInput.lastSeenTextLength,
    lastSeenTailHash: typeof contextUpdate.lastSeenTailHash === "string" ? contextUpdate.lastSeenTailHash : currentInput.lastSeenTailHash,
    lastSeenOutlineHash: typeof contextUpdate.lastSeenOutlineHash === "string" ? contextUpdate.lastSeenOutlineHash : currentInput.lastSeenOutlineHash,
    lastSeenOutlineSectionCount: typeof contextUpdate.lastSeenOutlineSectionCount === "number" ? contextUpdate.lastSeenOutlineSectionCount : currentInput.lastSeenOutlineSectionCount,
    lastSeenScrollHeight: typeof contextUpdate.lastSeenScrollHeight === "number" ? contextUpdate.lastSeenScrollHeight : currentInput.lastSeenScrollHeight,
  };
}

function compactRunLoopDaemonPolicy(): Record<string, unknown> {
  return {
    browser_mutation: false,
    prompt_injection: false,
    auto_submit: false,
    dom_write: false,
    supervised_daemon: true,
    background_process: false,
    in_process: true,
  };
}

function compactRunLoopRecoveryPolicy(): Record<string, unknown> {
  return {
    browser_mutation: false,
    prompt_injection: false,
    auto_submit: false,
    dom_write: false,
    uses_existing_run_state: true,
    blind_continue_prompt: false,
    controlled_single_step: true,
  };
}

function compactRunLoopMissingChatPrunePolicy(): Record<string, unknown> {
  return {
    removes_durable_state: true,
    removes_browser_chat: false,
    browser_mutation: false,
    prompt_injection: false,
    auto_submit: false,
    dom_write: false,
    requires_confirmed_missing_chat_id: true,
    binding_lost_is_not_missing_chat: true,
  };
}

function normalizeRunLoopDaemonId(value: string | undefined): string {
  const raw = (value ?? defaultRunLoopDaemonId).trim();
  const normalized = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return normalized.length > 0 ? normalized : defaultRunLoopDaemonId;
}

function runLoopDaemonPaths(baseDir: string, runId: string): { dir: string; state: string; log: string; stop: string } {
  const dir = path.join(baseDir, "var", "run", "chatgpt-run-loop", runId);
  return {
    dir,
    state: path.join(dir, "state.json"),
    log: path.join(dir, "daemon.jsonl"),
    stop: path.join(dir, "stop.json"),
  };
}

async function listRunLoopDaemonIds(baseDir: string): Promise<string[]> {
  const root = path.join(baseDir, "var", "run", "chatgpt-run-loop");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => normalizeRunLoopDaemonId(entry.name)).sort();
  } catch {
    return [];
  }
}

function classifyRunLoopRecoveryState(state: Record<string, unknown> | null, activeInMemory: boolean): { recoverable: boolean; decision: string; reason: string } {
  if (state === null) {
    return { recoverable: false, decision: "NO_STATE", reason: "daemon_state_file_not_found" };
  }
  if (activeInMemory) {
    return { recoverable: false, decision: "ALREADY_ACTIVE", reason: "daemon_is_active_in_current_server_memory" };
  }
  if (state.active === true && state.completed_at === null) {
    return { recoverable: true, decision: "RESUME_PIPELINE_FROM_RUN_LOOP_STEP", reason: "active_state_without_in_memory_daemon" };
  }
  if (String(state.status ?? "") === "RECOVERY_STEP_CAPTURED" && state.completed_at === null) {
    return { recoverable: true, decision: "RESUME_PIPELINE_FROM_RECOVERY_CHECKPOINT", reason: "prior_recovery_step_left_non_terminal_checkpoint" };
  }
  return { recoverable: false, decision: "TERMINAL_OR_STOPPED", reason: "state_is_not_active_non_terminal" };
}

function extractStringPath(source: Record<string, unknown> | null, keys: string[]): string | null {
  let current: unknown = source;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function extractRunLoopStateChatId(state: Record<string, unknown> | null): string | null {
  return extractStringPath(state, ["resume_input", "preferredChatId"])
    ?? extractStringPath(state, ["input", "preferredChatId"])
    ?? extractStringPath(state, ["context_update", "chatId"])
    ?? extractStringPath(state, ["selected", "chat_id"])
    ?? null;
}

function restoreRunLoopStepInputFromState(state: Record<string, unknown>, overrides: z.infer<typeof runLoopRecoverStepInputSchema>): z.infer<typeof runLoopStepInputSchema> {
  const resumeSource = typeof state.resume_input === "object" && state.resume_input !== null ? state.resume_input as Record<string, unknown> : {};
  const originalInput = typeof state.input === "object" && state.input !== null ? state.input as Record<string, unknown> : {};
  const merged = pickRunLoopStepInput({ ...originalInput, ...resumeSource });
  if (typeof overrides.executePreAsk === "boolean") merged.executePreAsk = overrides.executePreAsk;
  if (typeof overrides.gatewayAskMode === "string") merged.gatewayAskMode = overrides.gatewayAskMode;
  if (typeof overrides.gatewayMaxOutputTokens === "number") merged.gatewayMaxOutputTokens = overrides.gatewayMaxOutputTokens;
  if (typeof overrides.gatewayTemperature === "number") merged.gatewayTemperature = overrides.gatewayTemperature;
  if (typeof overrides.gatewayTimeoutMs === "number") merged.gatewayTimeoutMs = overrides.gatewayTimeoutMs;
  return runLoopStepInputSchema.parse(merged);
}

function pickRunLoopStepInput(source: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "workspacePath", "beforeHead", "checkNames", "ports", "preferredChatId", "requireChatId", "maxMessages", "timeoutMs",
    "phase", "taskClass", "iteration", "maxIterations", "sentAt", "lastProgressAt", "attempt", "baselineAssistantHash",
    "lastSeenAssistantHash", "lastSeenTextLength", "lastSeenTailHash", "lastSeenOutlineHash", "lastSeenOutlineSectionCount",
    "lastSeenScrollHeight", "inputTokens", "expectedOutputTokens", "executePreAsk", "gatewayAskMode", "gatewayMaxOutputTokens",
    "gatewayTemperature", "gatewayTimeoutMs",
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source && source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

function compactResumeInput(input: z.infer<typeof runLoopStepInputSchema>): Record<string, unknown> {
  return pickRunLoopStepInput(input as unknown as Record<string, unknown>);
}

async function writeRunLoopDaemonState(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readRunLoopDaemonState(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(filePath);
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return { status: "DAEMON_STATE_INVALID_JSON", raw: text.slice(0, 4000) };
  }
}

async function appendRunLoopDaemonLog(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await rotateRunLoopDaemonLogIfNeeded(filePath);
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function rotateRunLoopDaemonLogIfNeeded(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.size <= runLoopDaemonMaxLogBytes) {
      return;
    }
    const text = await readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const retained = lines.slice(-500).join("\n");
    await writeFile(filePath, `${retained}\n`, "utf8");
  } catch {
    return;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForRunLoopDaemon(runtime: RunLoopDaemonRuntime, stopFilePath: string, waitMs: number): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    if (runtime.stopRequested || await fileExists(stopFilePath)) {
      break;
    }
    const remaining = waitMs - (Date.now() - startedAt);
    await sleepMs(Math.min(1000, Math.max(0, remaining)));
  }
  return Date.now() - startedAt;
}

function toRunLoopAutoSummaryInput(input: z.infer<typeof runLoopDaemonStartInputSchema>): z.infer<typeof runLoopAutoSummaryInputSchema> {
  const { runId: _runId, replaceExisting: _replaceExisting, ...rest } = input;
  return rest;
}

function toRunLoopStepInput(input: z.infer<typeof runLoopAutoSummaryInputSchema>): z.infer<typeof runLoopStepInputSchema> {
  const { maxAutoIterations: _maxAutoIterations, maxElapsedMs: _maxElapsedMs, pollMs: _pollMs, minWaitMs: _minWaitMs, maxWaitMs: _maxWaitMs, stopOnReturnToChat: _stopOnReturnToChat, stopOnPreAskExecuted: _stopOnPreAskExecuted, ...rest } = input;
  return rest;
}

function compactDaemonInput(input: z.infer<typeof runLoopAutoSummaryInputSchema>): Record<string, unknown> {
  return {
    workspacePath: input.workspacePath,
    beforeHead: input.beforeHead,
    preferredChatId: input.preferredChatId,
    taskClass: input.taskClass,
    phase: input.phase,
    executePreAsk: input.executePreAsk,
    gatewayAskMode: input.gatewayAskMode,
    maxAutoIterations: input.maxAutoIterations,
    maxElapsedMs: input.maxElapsedMs,
    pollMs: input.pollMs,
    minWaitMs: input.minWaitMs,
    maxWaitMs: input.maxWaitMs,
  };
}

function buildMemorySnapshot(): Record<string, unknown> {
  const usage = process.memoryUsage();
  return {
    rss_mb: Math.round(usage.rss / 1024 / 1024),
    heap_used_mb: Math.round(usage.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(usage.heapTotal / 1024 / 1024),
    external_mb: Math.round(usage.external / 1024 / 1024),
  };
}

function isRunLoopDaemonStateStale(state: Record<string, unknown> | null, activeInMemory: boolean): boolean {
  if (state === null || activeInMemory) {
    return false;
  }
  if (state.active !== true) {
    return false;
  }
  const heartbeat = typeof state.heartbeat_at === "string" ? Date.parse(state.heartbeat_at) : Number.NaN;
  if (!Number.isFinite(heartbeat)) {
    return true;
  }
  return Date.now() - heartbeat > runLoopDaemonStaleAfterMs;
}

function compactStepSummaryForDaemon(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    status: typeof summary.status === "string" ? summary.status : null,
    next_action: typeof summary.next_action === "string" ? summary.next_action : null,
    watch_status: typeof summary.watch_status === "string" ? summary.watch_status : null,
    watch_decision_status: typeof summary.watch_decision_status === "string" ? summary.watch_decision_status : null,
    plan_status: typeof summary.plan_status === "string" ? summary.plan_status : null,
    plan_next_action: typeof summary.plan_next_action === "string" ? summary.plan_next_action : null,
    pre_ask_status: typeof summary.pre_ask_status === "string" ? summary.pre_ask_status : null,
    executed_watch_probe: summary.executed_watch_probe === true,
    executed_pre_ask_capture: summary.executed_pre_ask_capture === true,
    prompt_submit: false,
    sleep: false,
    safe_to_continue: summary.safe_to_continue === true,
    canonical_next_tool: typeof summary.canonical_next_tool === "string" ? summary.canonical_next_tool : null,
  };
}

function extractWatchDecisionStatus(watch: Record<string, unknown> | null): string {
  if (watch === null) {
    return "WATCH_OFF";
  }
  const decision = typeof watch.decision === "object" && watch.decision !== null ? watch.decision as Record<string, unknown> : null;
  if (typeof decision?.status === "string") {
    return decision.status;
  }
  return typeof watch.status === "string" ? watch.status : "WATCH_UNKNOWN";
}

function shouldReturnBeforePreAsk(mode: "off" | "probe_only" | "required", status: string): boolean {
  if (mode === "off") {
    return false;
  }
  if (status === "READY_FOR_PRE_ASK" || status === "STARTUP_READY") {
    return false;
  }
  if (mode === "probe_only" && status === "LIKELY_STABLE") {
    return false;
  }
  return true;
}

function mapWatchDecisionToPreAskStatus(status: string): string {
  if (status === "TRANSPORT_UNHEALTHY") return "PRE_ASK_BLOCKED_TRANSPORT";
  if (status === "CHAT_BINDING_LOST") return "PRE_ASK_BLOCKED_CHAT_BINDING";
  if (status === "HUNG_STREAM_CANDIDATE") return "PRE_ASK_BLOCKED_HUNG_STREAM_CANDIDATE";
  if (status === "MAX_WATCH_EXPIRED") return "PRE_ASK_BLOCKED_MAX_WATCH_EXPIRED";
  if (status === "WAITING_INITIAL_COOLDOWN" || status === "STREAMING_PROGRESS" || status === "STREAMING_NO_RECENT_PROGRESS" || status === "PROBING" || status === "STARTUP_WAITING_FOR_COMPOSER") return "PRE_ASK_WAITING_REPLY";
  return "PRE_ASK_BLOCKED_BY_WATCH";
}

function classifyRunCapture(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null }): string {
  if (!input.hasBeforeHead) {
    return "BASELINE_CAPTURED";
  }

  if (!input.repoClean) {
    return input.headChanged ? "REPO_CHANGED_DIRTY_AFTER_RUN" : "REPO_DIRTY_AFTER_RUN";
  }

  if (!input.headChanged) {
    return "NO_REPO_CHANGE";
  }

  if (input.gateOk === null) {
    return "REPO_CHANGED_NO_GATE_REQUESTED";
  }

  return input.gateOk ? "REPO_CHANGED_GATE_GREEN" : "REPO_CHANGED_GATE_RED";
}

function buildImplementationBlockingReasons(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null; statusLines: string[]; gateResults: Record<string, unknown>[] }): string[] {
  const reasons = [];
  if (!input.hasBeforeHead) {
    reasons.push("baseline_only_no_before_head_supplied");
  }
  if (!input.repoClean) {
    reasons.push("repo_dirty_after_run");
    for (const line of input.statusLines.slice(0, 20)) {
      reasons.push(`dirty:${line}`);
    }
  }
  if (input.gateOk === false) {
    reasons.push("deterministic_gate_failed");
    for (const result of input.gateResults.filter((item) => item.ok !== true).slice(0, 20)) {
      reasons.push(`gate_failed:${String(result.check_name ?? "unknown")}`);
    }
  }
  if (input.hasBeforeHead && !input.headChanged && input.repoClean) {
    reasons.push("no_repo_change_detected");
  }
  return reasons;
}

function buildPreAskBlockingReasons(input: { settleOk: boolean; implementationOk: boolean; gateOk: boolean | null; implementation: Record<string, unknown> }): string[] {
  const reasons = [];
  if (!input.settleOk) {
    reasons.push("answer_not_stable_or_not_ready_for_gate");
  }
  if (!input.implementationOk) {
    reasons.push("implementation_capture_not_green");
    const nested = input.implementation.blocking_reasons;
    if (Array.isArray(nested)) {
      for (const reason of nested.slice(0, 40)) {
        reasons.push(`implementation:${String(reason)}`);
      }
    }
  }
  if (input.gateOk === false) {
    reasons.push("deterministic_gate_failed");
  }
  return reasons;
}

function buildDeterministicVerdict(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null; blockingReasons: string[] }): string {
  if (!input.repoClean || input.gateOk === false) {
    return "RED";
  }
  if (!input.hasBeforeHead) {
    return "NEED_BINDING";
  }
  if (!input.headChanged) {
    return "AMBER";
  }
  return "GREEN";
}

function buildImplementationAdmissionInput(input: { settle: Record<string, unknown>; implementation: Record<string, unknown>; latestAssistant: { text: string; hash: string; index: number } | null }): Record<string, unknown> {
  const selected = typeof input.settle.selected === "object" && input.settle.selected !== null ? input.settle.selected as Record<string, unknown> : {};
  const deterministicVerdict = typeof input.implementation.deterministic_verdict === "string" ? input.implementation.deterministic_verdict : "RED";
  const deterministicFindingCount = typeof input.implementation.deterministic_finding_count === "number" ? input.implementation.deterministic_finding_count : 0;
  const git = typeof input.implementation.git === "object" && input.implementation.git !== null ? input.implementation.git as Record<string, unknown> : {};
  return {
    currentUrl: typeof selected.url === "string" ? selected.url : "",
    expectedChatId: typeof selected.chat_id === "string" ? selected.chat_id : undefined,
    expectedAssistantHash: input.latestAssistant?.hash,
    currentLatestAssistantHash: input.latestAssistant?.hash,
    deterministicVerdict,
    deterministicFindingCount,
    repoClean: typeof git.repo_clean === "boolean" ? git.repo_clean : undefined,
  };
}

async function gitText(policy: ConsolePolicy, workspacePath: string, args: string[], limit = outputLimit): Promise<GitCommandResult> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, "git", args, 30000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, limit);
  const stderr = truncateOutput(result.stderr, limit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function summarizeAssistantMessage(message: string): Record<string, unknown> {
  const trimmed = message.trim();
  return { supplied: trimmed.length > 0, length: trimmed.length, preview: truncateText(trimmed, 4000).text };
}

function buildAskMaterial(input: { status: string; beforeHead: string | null; currentHead: string | null; branch: string | null; statusLines: string[]; commitList: string[]; committedDiffStat: string; dirtyDiffStat: string; gateResults: Record<string, unknown>[]; assistantMessage: string; diffText: string; diffMaxChars: number }): string {
  const gateLines = input.gateResults.map((result) => {
    const status = typeof result.status === "string" ? result.status : result.ok === true ? "PASS" : "FAIL";
    const classification = typeof result.classification === "string" ? ` (${result.classification})` : "";
    return `${String(result.check_name ?? "unknown")}: ${status}${classification}`;
  }).join("\n");
  const gateDetails = input.gateResults.map(formatGateResultForAsk).join("\n\n");
  const diff = truncateText(input.diffText, input.diffMaxChars).text;
  return [
    "HYBRID IMPLEMENTATION RUN CAPTURE",
    `status: ${input.status}`,
    `branch: ${input.branch ?? "unknown"}`,
    `before_head: ${input.beforeHead ?? "unknown"}`,
    `current_head: ${input.currentHead ?? "unknown"}`,
    "",
    "ASSISTANT MESSAGE / INTENT:",
    truncateText(input.assistantMessage.trim(), 12000).text || "(not supplied)",
    "",
    "NEW COMMITS:",
    input.commitList.length > 0 ? input.commitList.join("\n") : "(none)",
    "",
    "WORKTREE STATUS:",
    input.statusLines.length > 0 ? input.statusLines.join("\n") : "clean",
    "",
    "DIFF STAT:",
    input.committedDiffStat.trim() || input.dirtyDiffStat.trim() || "(none)",
    "",
    "GATE RESULTS:",
    gateLines || "(not requested)",
    "",
    "GATE RESULT DETAILS:",
    gateDetails || "(not requested)",
    "",
    "DIFF:",
    diff || "(none)",
  ].join("\n");
}

function buildGatewayAskPrompt(input: { implementation: Record<string, unknown>; blockingReasons: string[] }): string {
  const askMaterial = String(input.implementation.ask_material ?? "").trim();
  const gate = typeof input.implementation.gate === "object" && input.implementation.gate !== null ? input.implementation.gate as Record<string, unknown> : {};
  const gateResults = Array.isArray(gate.results) ? gate.results : [];
  const gateSummary = gateResults.map((item) => {
    const result = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const name = String(result.check_name ?? "unknown");
    const status = String(result.status ?? (result.ok === true ? "PASS" : "FAIL"));
    const classification = String(result.classification ?? (result.ok === true ? "PASSED" : "CHECK_FAILED"));
    const gateEffect = String(result.gate_effect ?? (result.ok === true ? "PASS" : "BLOCKING"));
    return `${name}: ${status} / ${classification} / ${gateEffect}`;
  }).join("\n");
  const compactAskMaterial = truncateText(askMaterial, 9500).text;

  return [
    "Review the captured implementation evidence and gate streams below.",
    "Return concise JSON with verdict, summary, blocking_findings, and chatgpt_comment.",
    "PASS gates are evidence. SKIPPED capability-missing gates are neutral. FAIL blocking gates need concrete fixes.",
    "Do not invent unsupported files or fixes.",
    "",
    "BLOCKING REASONS:",
    input.blockingReasons.length > 0 ? input.blockingReasons.join("\n") : "(none)",
    "",
    "GATE SUMMARY:",
    gateSummary || "(none)",
    "",
    "ASK MATERIAL:",
    compactAskMaterial || "(empty)",
  ].join("\n");
}

function buildChatGptReturnMaterial(input: { askMaterial: string; gatewayReview: Record<string, unknown>; blockingReasons: string[] }): string {
  const stdout = typeof input.gatewayReview.stdout === "string" ? input.gatewayReview.stdout.trim() : "";
  const stderr = typeof input.gatewayReview.stderr === "string" ? input.gatewayReview.stderr.trim() : "";
  const gatewayOk = input.gatewayReview.ok === true;
  const gatewayJson = input.gatewayReview.stdout_json_parse_ok === true ? input.gatewayReview.stdout_json : null;
  const gatewayAnswer = stdout || stderr || "(gateway returned no text)";
  const askMaterial = truncateText(input.askMaterial.trim(), 12000).text;
  const gatewayAnswerText = truncateText(gatewayAnswer, 8000).text;

  return [
    "IMPLEMENTATION GATE REVIEW",
    "",
    "Deterministic gate evidence was captured first, then reviewed through the advisory gateway.",
    "",
    `gateway_ok: ${gatewayOk}`,
    `gateway_stdout_json_parse_ok: ${input.gatewayReview.stdout_json_parse_ok === true}`,
    "",
    "BLOCKING REASONS:",
    input.blockingReasons.length > 0 ? input.blockingReasons.join("\n") : "(none)",
    "",
    "ORIGINAL ASK MATERIAL:",
    askMaterial || "(empty)",
    "",
    "ADVISORY GATEWAY RESPONSE:",
    gatewayJson === null ? gatewayAnswerText : JSON.stringify(gatewayJson, null, 2),
    "",
    "NEXT ACTION:",
    "Use only the gate evidence and advisory response. Keep the target repo clean. Rerun the requested gates and report exact results.",
  ].join("\n");
}

function formatGateResultForAsk(result: Record<string, unknown>): string {
  const name = String(result.check_name ?? "unknown");
  const status = typeof result.status === "string" ? result.status : result.ok === true ? "PASS" : "FAIL";
  const classification = typeof result.classification === "string" ? result.classification : result.ok === true ? "PASSED" : "CHECK_FAILED";
  const gateEffect = typeof result.gate_effect === "string" ? result.gate_effect : result.ok === true ? "PASS" : "BLOCKING";
  const command = typeof result.command === "string" ? result.command : "unknown";
  const cwd = typeof result.cwd === "string" ? result.cwd : "unknown";
  const exitCode = typeof result.exit_code === "number" ? String(result.exit_code) : result.exit_code === null ? "null" : "unknown";
  const signal = typeof result.signal === "string" ? result.signal : result.signal === null ? "null" : "unknown";
  const durationMs = typeof result.duration_ms === "number" ? String(result.duration_ms) : "unknown";
  const stdout = typeof result.stdout === "string" && result.stdout.trim().length > 0 ? truncateText(result.stdout.trim(), 6000).text : "(empty)";
  const stderr = typeof result.stderr === "string" && result.stderr.trim().length > 0 ? truncateText(result.stderr.trim(), 6000).text : "(empty)";
  const error = typeof result.error === "string" && result.error.trim().length > 0 ? `\nerror: ${truncateText(result.error.trim(), 2000).text}` : "";

  return [
    `gate: ${name}`,
    `status: ${status}`,
    `classification: ${classification}`,
    `gate_effect: ${gateEffect}`,
    `command: ${command}`,
    `cwd: ${cwd}`,
    `exit_code: ${exitCode}`,
    `signal: ${signal}`,
    `duration_ms: ${durationMs}${error}`,
    "stdout:",
    stdout,
    "stderr:",
    stderr,
  ].join("\n");
}

function sanitizeCommitish(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/@{}~^:-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Commit value contains unsupported characters.");
  }

  return normalized;
}

function extractLatestAssistant(value: Record<string, unknown>): { text: string; hash: string; index: number } | null {
  const latest = value.latest_assistant;
  if (typeof latest !== "object" || latest === null) {
    return null;
  }

  const source = latest as Record<string, unknown>;
  const text = typeof source.text === "string" ? source.text : "";
  const hash = typeof source.hash === "string" ? source.hash : "";
  const index = typeof source.index === "number" ? source.index : -1;
  return text.length > 0 && hash.length > 0 && index >= 0 ? { text, hash, index } : null;
}
