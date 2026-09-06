import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConsoleAuthConfig } from "../Security/Auth/ConsoleAuth.js";
import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { assertAllowedRoot } from "../Policy/PathGuard.js";
import { bindEngineChatSession, buildEnginePhasePrompt, createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, isEngineTaskExecutionAuthorized, recordEngineAnswerCapture, recordEngineGatewayDecision, recordEnginePromptDraft, recordEnginePromptSubmit, recordEngineReplyBackDispatch, recordEngineReplyBackDraft, resolveEngineIterationMandate, runWorkerLoop, tailEngineEvent, workerTick } from "../engine/engine-core.js";
import { createEngineBrowserCycleExecutor, isEngineAnswerOrphaned, runEngineCycleRounds } from "../engine/engine-cycle-browser.js";
import { buildActionMarkerReplyBackText, classifyActionMarkerFromText } from "../engine/action-marker-router.js";
import { runEngineCycleStep as runSharedEngineCycleStep } from "../engine/engine-cycle.js";
import { draftBrowserSessionInput, openChatGptChat, submitBrowserSession } from "./chatgpt-chat-open.js";
import { runChatGptAnswerSettle } from "./chatgpt-message-capture.js";
import { buildConsoleMutationToolRegistration, buildConsoleToolRegistration, textResult } from "./common.js";

const enqueueSchema = z.object({
  component: z.string().min(1).max(120),
  live: z.boolean().optional(),
}).strict();

const taskStatusSchema = z.object({
  taskId: z.string().min(1).max(200),
}).strict();

const eventTailSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

const tickSchema = z.object({
  taskId: z.string().min(1).max(200).optional(),
  maxTicks: z.number().int().min(1).max(50).optional(),
  stopOnIdle: z.boolean().optional(),
  stopOnWaitingUser: z.boolean().optional(),
}).strict();

const chatBindSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  activate: z.boolean().default(true),
  confirmBind: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const promptDraftSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  allowOverwrite: z.boolean().default(false),
  confirmDraft: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const promptSendSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  confirmSend: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const answerCaptureSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  confirmCapture: z.boolean().default(false),
}).strict();

const answerResubmitOrphanedSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  allowOverwrite: z.boolean().default(false),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  confirmResubmit: z.boolean().default(false),
}).strict();

const gatewayDecisionSchema = z.object({
  taskId: z.string().min(1).max(200),
  model: z.string().min(1).max(200).optional(),
  maxOutputTokens: z.number().int().min(64).max(6000).default(900),
  temperature: z.number().min(0).max(2).default(0.1),
  timeoutMs: z.number().int().min(5000).max(180000).default(60000),
  raw: z.boolean().default(false),
  consoleEndpoint: z.string().min(1).max(200).optional(),
  confirmDecision: z.boolean().default(false),
}).strict();

const replyBackDraftSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  allowOverwrite: z.boolean().default(false),
  confirmDraft: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const replyBackSubmitSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1).optional(),
  confirmSubmit: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const cycleStepSchema = z.object({
  taskId: z.string().min(1).max(200),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  activate: z.boolean().default(true),
  allowOverwrite: z.boolean().default(false),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  gatewayModel: z.string().min(1).max(200).optional(),
  gatewayMaxOutputTokens: z.number().int().min(64).max(6000).default(900),
  gatewayTemperature: z.number().min(0).max(2).default(0.1),
  gatewayTimeoutMs: z.number().int().min(5000).max(180000).default(60000),
  gatewayRaw: z.boolean().default(false),
  gatewayConsoleEndpoint: z.string().min(1).max(200).optional(),
  confirmStep: z.boolean().default(false),
}).strict();

const cycleRunSchema = cycleStepSchema.extend({
  maxSteps: z.number().int().min(1).max(20).default(7),
  stopOnBlocked: z.boolean().default(true),
  stopOnNotReady: z.boolean().default(true),
  stopOnComplete: z.boolean().default(true),
  confirmRun: z.boolean().default(false),
}).strict();

const cycleRunNSchema = cycleStepSchema.extend({
  maxRounds: z.number().int().min(1).max(200).default(70),
  maxStepsPerRound: z.number().int().min(1).max(20).default(8),
  stopOnBlocked: z.boolean().default(true),
  stopOnNotReady: z.boolean().default(true),
  confirmRun: z.boolean().default(false),
}).strict();

const emptySchema = z.object({}).strict();

const ENGINE_CHAT_URL_BLOCKLIST = ["#settings", "/settings", "/connectors", "connector="];

export function registerEngineTools(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.engine.task.enqueue", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Enqueue an engine task through the shared CLI-first engine runtime.",
    inputSchema: enqueueSchema,
  }, async ({ component, live }) => textResult(await enqueueTask(enginePathFor(policy, baseDir), component, Boolean(live))));

  server.registerTool("console.read_.engine.task.status", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read one engine task and its recent event history.",
    inputSchema: taskStatusSchema,
  }, async ({ taskId }) => textResult(await getEngineTaskStatus(enginePathFor(policy, baseDir), taskId)));

  server.registerTool("console.read_.engine.task.list", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read engine task counts and latest event from the shared runtime.",
    inputSchema: emptySchema,
  }, async () => textResult(await getEngineStatus(enginePathFor(policy, baseDir))));

  server.registerTool("console.read_.engine.event.tail", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read the engine event log tail, optionally scoped to one task id.",
    inputSchema: eventTailSchema,
  }, async ({ taskId, limit }) => {
    const args = ["event-tail"];
    if (taskId) args.push(taskId);
    if (limit) args.push(`--limit=${limit}`);
    return textResult(await tailEngineEvent(enginePathFor(policy, baseDir), taskId, limit));
  });

  server.registerTool("console.write.engine.worker.tick", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Run exactly one bounded engine worker tick through the shared runtime.",
    inputSchema: tickSchema,
  }, async ({ taskId, maxTicks, stopOnIdle, stopOnWaitingUser }) => {
    const paths = enginePathFor(policy, baseDir);
    if (maxTicks && maxTicks > 1) return textResult(await runWorkerLoop(paths, { taskId, maxTicks, stopOnIdle, stopOnWaitingUser }));
    return textResult(await workerTick(paths, taskId));
  });

  server.registerTool("console.write.engine.chat.bind", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Open or reuse a ChatGPT browser document and persist a durable engine task-to-chat binding without drafting or submitting input.",
    inputSchema: chatBindSchema,
  }, async ({ taskId, ports, url, activate, confirmBind, timeoutMs }) => {
    if (!confirmBind) return textResult({ ok: false, status: "CONFIRM_ENGINE_CHAT_BIND_REQUIRED", task_id: taskId, will_open_browser_document: true, will_submit: false });
    const paths = enginePathFor(policy, baseDir);
    const opened = await openChatGptChat(policy, { ports, url, activate, confirmOpen: true, timeoutMs });
    if (opened.ok !== true) return textResult({ ok: false, status: "ENGINE_CHAT_BIND_OPEN_BLOCKED", task_id: taskId, opened });
    return textResult(await bindEngineChatSession(paths, taskId, opened));
  });

  server.registerTool("console.write.engine.prompt.draft", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Build the current engine phase prompt, draft it into the bound ChatGPT target, and persist draft metadata without submitting.",
    inputSchema: promptDraftSchema,
  }, async ({ taskId, ports, expectedTargetId, allowOverwrite, confirmDraft, timeoutMs }) => {
    if (!confirmDraft) return textResult({ ok: false, status: "CONFIRM_ENGINE_PROMPT_DRAFT_REQUIRED", task_id: taskId, will_write_input: true, will_submit: false });
    const paths = enginePathFor(policy, baseDir);
    const built = await buildEnginePhasePrompt(paths, taskId);
    if (built.ok !== true) return textResult(built);
    const targetId = expectedTargetId ?? (typeof built.target_id === "string" ? built.target_id : null);
    if (!targetId) return textResult({ ok: false, status: "ENGINE_PROMPT_DRAFT_TARGET_ID_REQUIRED", task_id: taskId, prompt: { prompt_hash: built.prompt_hash, prompt_length: built.prompt_length, prompt_path: built.prompt_path } });
    const drafted = await draftBrowserSessionInput({ ports, expectedTargetId: targetId, draftText: String(built.prompt), allowOverwrite, confirmDraft: true, timeoutMs });
    if (drafted.ok !== true) return textResult({ ok: false, status: "ENGINE_PROMPT_DRAFT_BLOCKED", task_id: taskId, target_id: targetId, prompt: { prompt_hash: built.prompt_hash, prompt_length: built.prompt_length, prompt_path: built.prompt_path }, drafted });
    const recorded = await recordEnginePromptDraft(paths, taskId, { ...drafted, prompt_hash: built.prompt_hash, prompt_path: built.prompt_path });
    return textResult({ ok: recorded.ok === true, status: "ENGINE_PROMPT_DRAFTED", task_id: taskId, target_id: targetId, prompt: { prompt_hash: built.prompt_hash, prompt_length: built.prompt_length, prompt_path: built.prompt_path }, drafted, recorded, submitted: false });
  });

  server.registerTool("console.write.engine.prompt.submit", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Submit the already drafted bound ChatGPT target for an engine task and persist submit metadata. It does not poll or capture the answer.",
    inputSchema: promptSendSchema,
  }, async ({ taskId, ports, expectedTargetId, confirmSend, timeoutMs }) => {
    const paths = enginePathFor(policy, baseDir);
    const autoAuthorized = await isEngineTaskExecutionAuthorized(paths, taskId);
    if (!confirmSend && !autoAuthorized) return textResult({ ok: false, status: "CONFIRM_ENGINE_PROMPT_SEND_REQUIRED", task_id: taskId, will_send_existing_draft: true, will_poll: false });
    const status = await getEngineTaskStatus(paths, taskId);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const targetId = expectedTargetId ?? (typeof task.target_id === "string" ? task.target_id : null);
    const draftHash = typeof task.draft_hash === "string" ? task.draft_hash : undefined;
    const draftLength = typeof task.draft_length === "number" ? task.draft_length : undefined;
    if (!targetId || !draftHash || typeof draftLength !== "number") return textResult({ ok: false, status: "ENGINE_PROMPT_SEND_DRAFT_METADATA_REQUIRED", task_id: taskId, has_target_id: Boolean(targetId), has_draft_hash: Boolean(draftHash), has_draft_length: typeof draftLength === "number" });
    const sent = await submitBrowserSession({ ports, expectedTargetId: targetId, expectedDraftHash: draftHash, expectedDraftLength: draftLength, confirmSubmit: true, timeoutMs });
    if (sent.ok !== true) return textResult({ ok: false, status: "ENGINE_PROMPT_SEND_BLOCKED", task_id: taskId, target_id: targetId, sent });
    const recorded = await recordEnginePromptSubmit(paths, taskId, sent);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_PROMPT_SENT", task_id: taskId, target_id: targetId, sent, recorded, polling_started: false });
  });

  server.registerTool("console.write.engine.answer.capture", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Wait for a stable bound ChatGPT assistant answer and persist answer metadata in the engine task. It does not run ASK/gateway or reply back.",
    inputSchema: answerCaptureSchema,
  }, async ({ taskId, ports, preferredChatId, requireChatId, maxMessages, timeoutMs, readinessProfile, maxWaitMs, observationBudgetMs, pollMs, confirmCapture }) => {
    if (!confirmCapture) return textResult({ ok: false, status: "CONFIRM_ENGINE_ANSWER_CAPTURE_REQUIRED", task_id: taskId, will_wait_for_answer: true, will_run_gateway: false, will_reply_back: false });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, taskId);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const chatId = preferredChatId ?? (typeof task.chat_id === "string" ? task.chat_id : undefined);
    const baselineAssistantHash = typeof task.assistant_hash === "string" ? task.assistant_hash : undefined;
    const settled = await runChatGptAnswerSettle({ ports, preferredChatId: chatId, expectedTaskId: taskId, requireChatId, maxMessages, timeoutMs, readinessProfile, maxWaitMs, observationBudgetMs, pollMs, baselineAssistantHash, requireComposerSendMode: false });
    if (settled.ok !== true || settled.ready_for_gate !== true) return textResult({ ok: false, status: "ENGINE_ANSWER_CAPTURE_NOT_READY", task_id: taskId, settled });
    const recorded = await recordEngineAnswerCapture(paths, taskId, settled);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_ANSWER_CAPTURED", task_id: taskId, settled, recorded, gateway_ran: false, reply_back: false });
  });

  server.registerTool("console.write.engine.answer.resubmit_orphaned", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Re-verify that the previously submitted prompt is orphaned (zero assistant messages long after submit) and, only then, redraft and resubmit the same phase prompt into the bound ChatGPT target. It does not run gateway or reply-back.",
    inputSchema: answerResubmitOrphanedSchema,
  }, async ({ taskId, ports, allowOverwrite, maxMessages, timeoutMs, readinessProfile, maxWaitMs, observationBudgetMs, pollMs, confirmResubmit }) => {
    const paths = enginePathFor(policy, baseDir);
    const autoAuthorized = await isEngineTaskExecutionAuthorized(paths, taskId);
    if (!confirmResubmit && !autoAuthorized) return textResult({ ok: false, status: "CONFIRM_ENGINE_ANSWER_RESUBMIT_REQUIRED", task_id: taskId, will_redraft_input: true, will_resubmit: true });
    const status = await getEngineTaskStatus(paths, taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    if (typeof task.assistant_hash === "string") return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_ALREADY_CAPTURED", task_id: taskId });
    const targetId = typeof task.target_id === "string" ? task.target_id : null;
    if (!targetId) return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_BINDING_REQUIRED", task_id: taskId });
    if (typeof task.submitted_at !== "string") return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_NOT_YET_SUBMITTED", task_id: taskId });

    const chatId = typeof task.chat_id === "string" ? task.chat_id : undefined;
    const settled = await runChatGptAnswerSettle({ ports, preferredChatId: chatId, expectedTargetId: targetId, expectedTaskId: taskId, requireChatId: chatId !== undefined, maxMessages, timeoutMs, readinessProfile, maxWaitMs, observationBudgetMs, pollMs, requireComposerSendMode: false });
    if (settled.ready_for_gate === true) return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_REJECTED_ALREADY_READY", task_id: taskId, settled });
    if (!isEngineAnswerOrphaned(task, settled)) return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_REJECTED_NOT_ORPHANED", task_id: taskId, settled });

    const built = await buildEnginePhasePrompt(paths, taskId);
    if (built.ok !== true) return textResult(built);
    const drafted = await draftBrowserSessionInput({ ports, expectedTargetId: targetId, draftText: String(built.prompt), allowOverwrite, confirmDraft: true, timeoutMs });
    if (drafted.ok !== true) return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_DRAFT_BLOCKED", task_id: taskId, drafted });
    const sent = await submitBrowserSession({ ports, expectedTargetId: targetId, expectedDraftHash: String(drafted.draft_hash), expectedDraftLength: Number(drafted.draft_length), confirmSubmit: true, timeoutMs });
    if (sent.ok !== true) return textResult({ ok: false, status: "ENGINE_ANSWER_RESUBMIT_SUBMIT_BLOCKED", task_id: taskId, sent });
    const recorded = await recordEnginePromptSubmit(paths, taskId, sent);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_ANSWER_RESUBMITTED", task_id: taskId, target_id: targetId, prompt: { prompt_hash: built.prompt_hash, prompt_length: built.prompt_length }, drafted, sent, recorded, next_action: "capture assistant answer" });
  });

  server.registerTool("console.write.engine.gateway.decide", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Classify the captured engine answer through the deterministic action-marker router and persist the engine decision. It does not call Ask and does not reply back to ChatGPT.",
    inputSchema: gatewayDecisionSchema,
  }, async ({ taskId, model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint, confirmDecision }) => {
    if (!confirmDecision) return textResult({ ok: false, status: "CONFIRM_ENGINE_GATEWAY_DECISION_REQUIRED", task_id: taskId, will_call_gateway: true, will_reply_back: false });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    if (typeof task.assistant_hash !== "string" || typeof task.assistant_length !== "number") return textResult({ ok: false, status: "ENGINE_GATEWAY_DECISION_CAPTURE_REQUIRED", task_id: taskId, has_assistant_hash: typeof task.assistant_hash === "string", has_assistant_length: typeof task.assistant_length === "number" });
    const routed = classifyActionMarkerFromText(extractLatestAssistantText(Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []));
    const recorded = await recordEngineGatewayDecision(paths, taskId, routed as unknown as Record<string, unknown>);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_GATEWAY_DECISION_RECORDED", task_id: taskId, routed, recorded, reply_back: false, ask_skipped: true, ignored_ask_options: { model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint } });
  });

  server.registerTool("console.write.engine.reply.draft", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Draft a reply-back message into the bound ChatGPT target from the recorded gateway decision. It does not submit.",
    inputSchema: replyBackDraftSchema,
  }, async ({ taskId, ports, expectedTargetId, allowOverwrite, confirmDraft, timeoutMs }) => {
    if (!confirmDraft) return textResult({ ok: false, status: "CONFIRM_ENGINE_REPLY_BACK_DRAFT_REQUIRED", task_id: taskId, will_write_input: true, will_submit: false });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const targetId = expectedTargetId ?? (typeof task.target_id === "string" ? task.target_id : null);
    if (!targetId) return textResult({ ok: false, status: "ENGINE_REPLY_BACK_TARGET_ID_REQUIRED", task_id: taskId });
    if (typeof task.decision_status !== "string") return textResult({ ok: false, status: "ENGINE_REPLY_BACK_DECISION_REQUIRED", task_id: taskId });
    const replyText = buildReplyBackText(taskId, task);
    const replyHash = hashText(replyText);
    const drafted = await draftBrowserSessionInput({ ports, expectedTargetId: targetId, draftText: replyText, allowOverwrite, confirmDraft: true, timeoutMs });
    if (drafted.ok !== true) return textResult({ ok: false, status: "ENGINE_REPLY_BACK_DRAFT_BLOCKED", task_id: taskId, target_id: targetId, drafted });
    const recorded = await recordEngineReplyBackDraft(paths, taskId, { ...drafted, reply_back_text: replyText, reply_back_hash: replyHash, reply_back_length: replyText.length });
    return textResult({ ok: recorded.ok === true, status: "ENGINE_REPLY_BACK_DRAFTED", task_id: taskId, target_id: targetId, reply_back_hash: replyHash, reply_back_length: replyText.length, drafted, recorded, submitted: false });
  });

  server.registerTool("console.write.engine.reply.submit", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Submit the already drafted reply-back message for a bound engine task and persist dispatch metadata. It does not capture the next answer.",
    inputSchema: replyBackSubmitSchema,
  }, async ({ taskId, ports, expectedTargetId, confirmSubmit, timeoutMs }) => {
    if (!confirmSubmit) return textResult({ ok: false, status: "CONFIRM_ENGINE_REPLY_BACK_SUBMIT_REQUIRED", task_id: taskId, will_submit_existing_reply_draft: true, will_capture: false });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const targetId = expectedTargetId ?? (typeof task.target_id === "string" ? task.target_id : null);
    const replyHash = typeof task.reply_back_hash === "string" ? task.reply_back_hash : undefined;
    const replyLength = typeof task.reply_back_length === "number" ? task.reply_back_length : undefined;
    if (!targetId || !replyHash || typeof replyLength !== "number") return textResult({ ok: false, status: "ENGINE_REPLY_BACK_SUBMIT_DRAFT_METADATA_REQUIRED", task_id: taskId, has_target_id: Boolean(targetId), has_reply_back_hash: Boolean(replyHash), has_reply_back_length: typeof replyLength === "number" });
    const dispatched = await submitBrowserSession({ ports, expectedTargetId: targetId, expectedDraftHash: replyHash, expectedDraftLength: replyLength, confirmSubmit: true, timeoutMs });
    if (dispatched.ok !== true) return textResult({ ok: false, status: "ENGINE_REPLY_BACK_SUBMIT_BLOCKED", task_id: taskId, target_id: targetId, dispatched });
    const recorded = await recordEngineReplyBackDispatch(paths, taskId, dispatched);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_REPLY_BACK_SUBMITTED", task_id: taskId, target_id: targetId, dispatched, recorded, capture_started: false });
  });

  server.registerTool("console.write.engine.cycle.step", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Execute exactly one missing stage for an engine task lifecycle and return the next safe action.",
    inputSchema: cycleStepSchema,
  }, async (input) => {
    const authorizationPaths = enginePathFor(policy, baseDir);
    const autoAuthorized = await isEngineTaskExecutionAuthorized(authorizationPaths, input.taskId);
    if (!input.confirmStep && !autoAuthorized) return textResult({ ok: false, status: "CONFIRM_ENGINE_CYCLE_STEP_REQUIRED", task_id: input.taskId, executes_exactly_one_stage: true });
    return textResult(await runSharedEngineCycleStep(enginePathFor(policy, baseDir), { taskId: input.taskId, mode: "execute" }, createEngineBrowserCycleExecutor({
      policy,
      baseDir,
      ports: input.ports,
      url: input.url,
      activate: input.activate,
      allowOverwrite: input.allowOverwrite,
      maxMessages: input.maxMessages,
      timeoutMs: input.timeoutMs,
      readinessProfile: input.readinessProfile,
      maxWaitMs: input.maxWaitMs,
      observationBudgetMs: input.observationBudgetMs,
      pollMs: input.pollMs,
      gatewayModel: typeof input.gatewayModel === "string" ? input.gatewayModel : undefined,
      gatewayMaxOutputTokens: input.gatewayMaxOutputTokens,
      gatewayTemperature: input.gatewayTemperature,
      gatewayTimeoutMs: input.gatewayTimeoutMs,
      gatewayRaw: input.gatewayRaw,
      gatewayConsoleEndpoint: typeof input.gatewayConsoleEndpoint === "string" ? input.gatewayConsoleEndpoint : undefined,
    })));
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, input.taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    if (typeof task.target_id !== "string") {
      const opened = await openEngineChatPage(policy, { ports: input.ports, url: input.url, activate: input.activate, timeoutMs: input.timeoutMs });
      if (opened.ok !== true) return textResult({ ok: false, stage: "chat_bind", status: "ENGINE_CYCLE_STAGE_BLOCKED", opened });
      const bound = await bindEngineChatSession(paths, input.taskId, opened);
      return textResult({ ok: bound.ok === true, stage: "chat_bind", result: bound, next_action: "draft phase prompt" });
    }
    if (typeof task.draft_hash !== "string" || typeof task.draft_length !== "number") {
      const built = await buildEnginePhasePrompt(paths, input.taskId);
      if (built.ok !== true) return textResult(built);
      const drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId: String(task.target_id), draftText: String(built.prompt), allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: input.timeoutMs });
      if (drafted.ok !== true) return textResult({ ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", drafted });
      const recorded = await recordEnginePromptDraft(paths, input.taskId, { ...drafted, prompt_hash: built.prompt_hash, prompt_path: built.prompt_path });
      return textResult({ ok: recorded.ok === true, stage: "prompt_draft", result: recorded, next_action: "submit phase prompt" });
    }
    if (typeof task.submitted_at !== "string") {
      const sent = await submitBrowserSession({ ports: input.ports, expectedTargetId: String(task.target_id), expectedDraftHash: String(task.draft_hash), expectedDraftLength: Number(task.draft_length), confirmSubmit: true, timeoutMs: input.timeoutMs });
      if (sent.ok !== true) return textResult({ ok: false, stage: "prompt_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", sent });
      const recorded = await recordEnginePromptSubmit(paths, input.taskId, sent);
      return textResult({ ok: recorded.ok === true, stage: "prompt_submit", result: recorded, next_action: "capture assistant answer" });
    }
    if (typeof task.assistant_hash !== "string" || typeof task.assistant_length !== "number") {
      const settled = await runChatGptAnswerSettle({ ports: input.ports, preferredChatId: typeof task.chat_id === "string" ? String(task.chat_id) : undefined, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs, readinessProfile: input.readinessProfile, maxWaitMs: input.maxWaitMs, observationBudgetMs: input.observationBudgetMs, pollMs: input.pollMs, requireComposerSendMode: false });
      if (settled.ok !== true || settled.ready_for_gate !== true) return textResult({ ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_STAGE_NOT_READY", settled });
      const recorded = await recordEngineAnswerCapture(paths, input.taskId, settled);
      return textResult({ ok: recorded.ok === true, stage: "answer_capture", result: recorded, next_action: "gateway decision" });
    }
    if (typeof task.decision_status !== "string") {
      const routed = classifyActionMarkerFromText(extractLatestAssistantText(Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []));
      const recorded = await recordEngineGatewayDecision(paths, input.taskId, routed as unknown as Record<string, unknown>);
      return textResult({ ok: recorded.ok === true, stage: "gateway_decision", result: recorded, routed, next_action: "draft reply-back" });
    }
    if (typeof task.reply_back_hash !== "string" || typeof task.reply_back_length !== "number") {
      const replyText = buildReplyBackText(input.taskId, task);
      const replyHash = hashText(replyText);
      const drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId: String(task.target_id), draftText: replyText, allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: input.timeoutMs });
      if (drafted.ok !== true) return textResult({ ok: false, stage: "reply_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", drafted });
      const recorded = await recordEngineReplyBackDraft(paths, input.taskId, { ...drafted, reply_back_text: replyText, reply_back_hash: replyHash, reply_back_length: replyText.length });
      return textResult({ ok: recorded.ok === true, stage: "reply_draft", result: recorded, next_action: "submit reply-back" });
    }
    if (typeof task.reply_back_sent_at !== "string") {
      const dispatched = await submitBrowserSession({ ports: input.ports, expectedTargetId: String(task.target_id), expectedDraftHash: String(task.reply_back_hash), expectedDraftLength: Number(task.reply_back_length), confirmSubmit: true, timeoutMs: input.timeoutMs });
      if (dispatched.ok !== true) return textResult({ ok: false, stage: "reply_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", dispatched });
      const recorded = await recordEngineReplyBackDispatch(paths, input.taskId, dispatched);
      return textResult({ ok: recorded.ok === true, stage: "reply_submit", result: recorded, next_action: "cycle complete; capture next answer when ready" });
    }
    return textResult({ ok: true, stage: "complete", status: "ENGINE_CYCLE_COMPLETE", task_id: input.taskId, next_action: "no missing stage" });
  });

  server.registerTool("console.write.engine.cycle.run", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Run a bounded sequence of engine cycle stages for one task. It is synchronous, finite, and never starts a daemon.",
    inputSchema: cycleRunSchema,
  }, async (input) => {
    const authorizationPaths = enginePathFor(policy, baseDir);
    const autoAuthorized = await isEngineTaskExecutionAuthorized(authorizationPaths, input.taskId);
    if (!input.confirmRun && !autoAuthorized) return textResult({ ok: false, status: "CONFIRM_ENGINE_CYCLE_RUN_REQUIRED", task_id: input.taskId, max_steps: input.maxSteps, starts_daemon: false });
    const { maxSteps, stopOnBlocked, stopOnNotReady, stopOnComplete, confirmRun: _confirmRun, ...stepInput } = input;
    const timeline: Record<string, unknown>[] = [];
    let stopReason = "max_steps";
    for (let index = 0; index < maxSteps; index += 1) {
      const result = await executeEngineCycleStep(policy, baseDir, { ...stepInput, confirmStep: true });
      const item = { index, stage: result.stage ?? "unknown", ok: result.ok === true, status: result.status ?? null, next_action: result.next_action ?? null };
      timeline.push(item);
      if (stopOnComplete && result.stage === "complete") { stopReason = "complete"; break; }
      if (stopOnBlocked && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_BLOCKED") { stopReason = "blocked"; break; }
      if (stopOnNotReady && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_NOT_READY") { stopReason = "not_ready"; break; }
      if (result.ok !== true && result.status !== "ENGINE_CYCLE_STAGE_NOT_READY" && result.status !== "ENGINE_CYCLE_STAGE_BLOCKED") { stopReason = "error"; break; }
    }
    return textResult({ ok: stopReason !== "error", status: "ENGINE_CYCLE_RUN_COMPLETE", task_id: input.taskId, max_steps: maxSteps, step_count: timeline.length, stop_reason: stopReason, timeline, starts_daemon: false });
  });

  server.registerTool("console.write.engine.cycle.run_n", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Run up to a configurable maxRounds full engine cycles (chat_bind..reply_submit/complete, repeated on the same bound chat/target) for one task. Stops on the round limit, the terminal action marker done, a blocked or not-ready stage, or an orphaned answer. Non-terminal markers such as fix fail and continue keep the budget moving. It is synchronous, finite, and never starts a daemon; it is unrelated to the read-only implementation-run-capture watcher's maxAutoIterations.",
    inputSchema: cycleRunNSchema,
  }, async (input) => {
    const paths = enginePathFor(policy, baseDir);
    const autoAuthorized = await isEngineTaskExecutionAuthorized(paths, input.taskId);
    if (!input.confirmRun && !autoAuthorized) return textResult({ ok: false, status: "CONFIRM_ENGINE_CYCLE_RUN_N_REQUIRED", task_id: input.taskId, max_rounds: input.maxRounds, starts_daemon: false });
    const { maxRounds, maxStepsPerRound, stopOnBlocked, stopOnNotReady, confirmRun: _confirmRun, ...stepInput } = input;
    const result = await runEngineCycleRounds(paths, {
      policy,
      baseDir,
      ports: stepInput.ports,
      url: stepInput.url,
      activate: stepInput.activate,
      allowOverwrite: stepInput.allowOverwrite,
      maxMessages: stepInput.maxMessages,
      timeoutMs: stepInput.timeoutMs,
      readinessProfile: stepInput.readinessProfile,
      maxWaitMs: stepInput.maxWaitMs,
      observationBudgetMs: stepInput.observationBudgetMs,
      pollMs: stepInput.pollMs,
      gatewayModel: stepInput.gatewayModel,
      gatewayMaxOutputTokens: stepInput.gatewayMaxOutputTokens,
      gatewayTemperature: stepInput.gatewayTemperature,
      gatewayTimeoutMs: stepInput.gatewayTimeoutMs,
      gatewayRaw: stepInput.gatewayRaw,
      gatewayConsoleEndpoint: stepInput.gatewayConsoleEndpoint,
    }, { taskId: input.taskId, maxRounds, maxStepsPerRound, stopOnBlocked, stopOnNotReady });
    return textResult(result);
  });

  server.registerTool("console.read_.engine.worker.status", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read current engine worker-facing status from the shared runtime.",
    inputSchema: emptySchema,
  }, async () => textResult(await getEngineStatus(enginePathFor(policy, baseDir))));
}

async function openEngineChatPage(policy: ConsolePolicy, input: { ports: number[]; url: string; activate: boolean; timeoutMs: number }): Promise<Record<string, unknown>> {
  const first = await openChatGptChat(policy, { ports: input.ports, url: input.url, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
  const firstCheck = classifyEngineChatTarget(first);
  if (firstCheck.ok === true) return first;
  if (first.ok !== true) return first;
  const fallback = await openChatGptChat(policy, { ports: input.ports, url: "https://chatgpt.com/", activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
  const fallbackCheck = classifyEngineChatTarget(fallback);
  if (fallbackCheck.ok === true) return { ...fallback, fallback_from_rejected_url: firstCheck.current_url ?? null };
  return { ok: false, status: "ENGINE_CHAT_TARGET_REJECTED", current_url: fallbackCheck.current_url ?? firstCheck.current_url ?? null, first_opened: first, fallback_opened: fallback, next_action: "open a regular https://chatgpt.com/ chat target and retry bind" };
}

function classifyEngineChatTarget(opened: Record<string, unknown>): { ok: true; current_url: string } | { ok: false; current_url: string | null } {
  if (opened.ok !== true) return { ok: false, current_url: null };
  const currentUrl = typeof opened.current_url === "string" ? opened.current_url : "";
  const selected = typeof opened.selected === "object" && opened.selected !== null ? opened.selected as Record<string, unknown> : {};
  const selectedUrl = typeof selected.url === "string" ? selected.url : currentUrl;
  return isEngineChatTargetUrl(selectedUrl) ? { ok: true, current_url: selectedUrl } : { ok: false, current_url: selectedUrl || null };
}

function isEngineChatTargetUrl(value: string): boolean {
  if (!value.startsWith("https://chatgpt.com/")) return false;
  const lower = value.toLowerCase();
  return !ENGINE_CHAT_URL_BLOCKLIST.some((fragment) => lower.includes(fragment));
}

async function executeEngineCycleStep(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof cycleStepSchema>): Promise<Record<string, unknown>> {
  const paths = enginePathFor(policy, baseDir);
  const status = await getEngineTaskStatus(paths, input.taskId);
  if (status.ok !== true) return status;
  const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
  if (typeof task.target_id !== "string") {
    const opened = await openEngineChatPage(policy, { ports: input.ports, url: input.url, activate: input.activate, timeoutMs: input.timeoutMs });
    if (opened.ok !== true) return { ok: false, stage: "chat_bind", status: "ENGINE_CYCLE_STAGE_BLOCKED", opened };
    const bound = await bindEngineChatSession(paths, input.taskId, opened);
    return { ok: bound.ok === true, stage: "chat_bind", result: bound, next_action: "draft phase prompt" };
  }
  if (typeof task.draft_hash !== "string" || typeof task.draft_length !== "number") {
    const built = await buildEnginePhasePrompt(paths, input.taskId);
    if (built.ok !== true) return built;
    const drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId: String(task.target_id), draftText: String(built.prompt), allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: input.timeoutMs });
    if (drafted.ok !== true) return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", drafted };
    const recorded = await recordEnginePromptDraft(paths, input.taskId, { ...drafted, prompt_hash: built.prompt_hash, prompt_path: built.prompt_path });
    return { ok: recorded.ok === true, stage: "prompt_draft", result: recorded, next_action: "submit phase prompt" };
  }
  if (typeof task.submitted_at !== "string") {
    const sent = await submitBrowserSession({ ports: input.ports, expectedTargetId: String(task.target_id), expectedDraftHash: String(task.draft_hash), expectedDraftLength: Number(task.draft_length), confirmSubmit: true, timeoutMs: input.timeoutMs });
    if (sent.ok !== true) return { ok: false, stage: "prompt_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", sent };
    const recorded = await recordEnginePromptSubmit(paths, input.taskId, sent);
    return { ok: recorded.ok === true, stage: "prompt_submit", result: recorded, next_action: "capture assistant answer" };
  }
  if (typeof task.assistant_hash !== "string" || typeof task.assistant_length !== "number") {
    const settled = await runChatGptAnswerSettle({ ports: input.ports, preferredChatId: typeof task.chat_id === "string" ? String(task.chat_id) : undefined, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs, readinessProfile: input.readinessProfile, maxWaitMs: input.maxWaitMs, observationBudgetMs: input.observationBudgetMs, pollMs: input.pollMs, requireComposerSendMode: false });
    if (settled.ok !== true || settled.ready_for_gate !== true) return { ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_STAGE_NOT_READY", settled };
    const recorded = await recordEngineAnswerCapture(paths, input.taskId, settled);
    return { ok: recorded.ok === true, stage: "answer_capture", result: recorded, next_action: "gateway decision" };
  }
  if (typeof task.decision_status !== "string") {
    const routed = classifyActionMarkerFromText(extractLatestAssistantText(Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []));
    const recorded = await recordEngineGatewayDecision(paths, input.taskId, routed as unknown as Record<string, unknown>);
    return { ok: recorded.ok === true, stage: "gateway_decision", result: recorded, routed, next_action: "draft reply-back" };
  }
  if (typeof task.reply_back_hash !== "string" || typeof task.reply_back_length !== "number") {
    const replyText = buildReplyBackText(input.taskId, task);
    const replyHash = hashText(replyText);
    const drafted = await draftBrowserSessionInput({ ports: input.ports, expectedTargetId: String(task.target_id), draftText: replyText, allowOverwrite: input.allowOverwrite, confirmDraft: true, timeoutMs: input.timeoutMs });
    if (drafted.ok !== true) return { ok: false, stage: "reply_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", drafted };
    const recorded = await recordEngineReplyBackDraft(paths, input.taskId, { ...drafted, reply_back_text: replyText, reply_back_hash: replyHash, reply_back_length: replyText.length });
    return { ok: recorded.ok === true, stage: "reply_draft", result: recorded, next_action: "submit reply-back" };
  }
  if (typeof task.reply_back_sent_at !== "string") {
    const dispatched = await submitBrowserSession({ ports: input.ports, expectedTargetId: String(task.target_id), expectedDraftHash: String(task.reply_back_hash), expectedDraftLength: Number(task.reply_back_length), confirmSubmit: true, timeoutMs: input.timeoutMs });
    if (dispatched.ok !== true) return { ok: false, stage: "reply_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", dispatched };
    const recorded = await recordEngineReplyBackDispatch(paths, input.taskId, dispatched);
    return { ok: recorded.ok === true, stage: "reply_submit", result: recorded, next_action: "cycle complete; capture next answer when ready" };
  }
  return { ok: true, stage: "complete", status: "ENGINE_CYCLE_COMPLETE", task_id: input.taskId, next_action: "no missing stage" };
}

function enginePathFor(policy: ConsolePolicy, baseDir: string) {
  return createEnginePaths(assertAllowedRoot(path.resolve(baseDir), policy.allowedRoots));
}

function hashText(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 64);
}

function buildReplyBackText(taskId: string, task: Record<string, unknown>): string {
  const currentIteration = typeof task.auto_iteration_count === "number" ? task.auto_iteration_count : 0;
  const maxAutoIterations = Math.max(3, typeof task.max_auto_iterations === "number" ? task.max_auto_iterations : 3);
  const nextIteration = Math.min(maxAutoIterations, currentIteration + 1);
  const mutationPolicy = task.mutation_policy === "read_only" ? "read_only" : "write_allowed";
  const mandate = resolveEngineIterationMandate(nextIteration, mutationPolicy);
  return [
    `Next iteration: ${nextIteration}/${maxAutoIterations}`,
    `Iteration mandate: ${mandate}`,
    "",
    buildActionMarkerReplyBackText(taskId, task),
  ].join("\n");
}

function extractLatestAssistantText(events: Record<string, unknown>[]): string {
  const latestCapture = [...events].reverse().find((event) => event.event === "executor_answer_captured") ?? null;
  const captureData = typeof latestCapture?.data === "object" && latestCapture.data !== null ? latestCapture.data as Record<string, unknown> : {};
  const latestAssistant = typeof captureData.latest_assistant === "object" && captureData.latest_assistant !== null ? captureData.latest_assistant as Record<string, unknown> : {};
  return typeof latestAssistant.text === "string" ? latestAssistant.text.slice(0, 12000) : "";
}


