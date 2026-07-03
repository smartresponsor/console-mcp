import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { bindEngineChatSession, buildEnginePhasePrompt, createEnginePaths, enqueueTask, getEngineStatus, getEngineTaskStatus, recordEngineAnswerCapture, recordEngineGatewayDecision, recordEnginePromptDraft, recordEnginePromptSubmit, recordEngineReplyBackDispatch, recordEngineReplyBackDraft, runWorkerLoop, tailEngineEvent, workerTick } from "../engine/engine-core.js";
import { draftBrowserSessionInput, openChatGptChat, submitBrowserSession } from "./chatgpt-chat-open.js";
import { runChatGptAnswerSettle } from "./chatgpt-message-capture.js";
import { executeAsk } from "./ask.js";
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

const emptySchema = z.object({}).strict();

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
    if (maxTicks && maxTicks > 1) return textResult(await runWorkerLoop(paths, { maxTicks, stopOnIdle, stopOnWaitingUser }));
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
    if (!confirmSend) return textResult({ ok: false, status: "CONFIRM_ENGINE_PROMPT_SEND_REQUIRED", task_id: taskId, will_send_existing_draft: true, will_poll: false });
    const paths = enginePathFor(policy, baseDir);
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
    const settled = await runChatGptAnswerSettle({ ports, preferredChatId: chatId, requireChatId, maxMessages, timeoutMs, readinessProfile, maxWaitMs, observationBudgetMs, pollMs, baselineAssistantHash, requireComposerSendMode: false });
    if (settled.ok !== true || settled.ready_for_gate !== true) return textResult({ ok: false, status: "ENGINE_ANSWER_CAPTURE_NOT_READY", task_id: taskId, settled });
    const recorded = await recordEngineAnswerCapture(paths, taskId, settled);
    return textResult({ ok: recorded.ok === true, status: "ENGINE_ANSWER_CAPTURED", task_id: taskId, settled, recorded, gateway_ran: false, reply_back: false });
  });

  server.registerTool("console.write.engine.gateway.decide", {
    ...buildConsoleMutationToolRegistration(authConfig),
    description: "Ask the local AI gateway to classify the captured engine answer and persist the engine decision. It does not reply back to ChatGPT.",
    inputSchema: gatewayDecisionSchema,
  }, async ({ taskId, model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint, confirmDecision }) => {
    if (!confirmDecision) return textResult({ ok: false, status: "CONFIRM_ENGINE_GATEWAY_DECISION_REQUIRED", task_id: taskId, will_call_gateway: true, will_reply_back: false });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    if (typeof task.assistant_hash !== "string" || typeof task.assistant_length !== "number") return textResult({ ok: false, status: "ENGINE_GATEWAY_DECISION_CAPTURE_REQUIRED", task_id: taskId, has_assistant_hash: typeof task.assistant_hash === "string", has_assistant_length: typeof task.assistant_length === "number" });
    const prompt = buildGatewayDecisionPrompt(taskId, task, Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []);
    const asked = await executeAsk(policy, baseDir, typeof task.workspace_path === "string" ? task.workspace_path : baseDir, prompt, model, maxOutputTokens, temperature, timeoutMs, raw, consoleEndpoint);
    const recorded = await recordEngineGatewayDecision(paths, taskId, asked as unknown as Record<string, unknown>);
    return textResult({ ok: asked.ok === true && recorded.ok === true, status: "ENGINE_GATEWAY_DECISION_RECORDED", task_id: taskId, asked, recorded, reply_back: false });
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
    if (!input.confirmStep) return textResult({ ok: false, status: "CONFIRM_ENGINE_CYCLE_STEP_REQUIRED", task_id: input.taskId, executes_exactly_one_stage: true });
    const paths = enginePathFor(policy, baseDir);
    const status = await getEngineTaskStatus(paths, input.taskId);
    if (status.ok !== true) return textResult(status);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    if (typeof task.target_id !== "string") {
      const opened = await openChatGptChat(policy, { ports: input.ports, url: input.url, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
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
      const settled = await runChatGptAnswerSettle({ ports: input.ports, preferredChatId: typeof task.chat_id === "string" ? task.chat_id : undefined, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs, readinessProfile: input.readinessProfile, maxWaitMs: input.maxWaitMs, observationBudgetMs: input.observationBudgetMs, pollMs: input.pollMs, requireComposerSendMode: false });
      if (settled.ok !== true || settled.ready_for_gate !== true) return textResult({ ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_STAGE_NOT_READY", settled });
      const recorded = await recordEngineAnswerCapture(paths, input.taskId, settled);
      return textResult({ ok: recorded.ok === true, stage: "answer_capture", result: recorded, next_action: "gateway decision" });
    }
    if (typeof task.decision_status !== "string") {
      const prompt = buildGatewayDecisionPrompt(input.taskId, task, Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []);
      const asked = await executeAsk(policy, baseDir, typeof task.workspace_path === "string" ? task.workspace_path : baseDir, prompt, input.gatewayModel, input.gatewayMaxOutputTokens, input.gatewayTemperature, input.gatewayTimeoutMs, input.gatewayRaw, input.gatewayConsoleEndpoint);
      const recorded = await recordEngineGatewayDecision(paths, input.taskId, asked as unknown as Record<string, unknown>);
      return textResult({ ok: asked.ok === true && recorded.ok === true, stage: "gateway_decision", result: recorded, asked, next_action: "draft reply-back" });
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
    if (!input.confirmRun) return textResult({ ok: false, status: "CONFIRM_ENGINE_CYCLE_RUN_REQUIRED", task_id: input.taskId, max_steps: input.maxSteps, starts_daemon: false });
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

  server.registerTool("console.read_.engine.worker.status", {
    ...buildConsoleToolRegistration(authConfig),
    description: "Read current engine worker-facing status from the shared runtime.",
    inputSchema: emptySchema,
  }, async () => textResult(await getEngineStatus(enginePathFor(policy, baseDir))));
}

async function executeEngineCycleStep(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof cycleStepSchema>): Promise<Record<string, unknown>> {
  const paths = enginePathFor(policy, baseDir);
  const status = await getEngineTaskStatus(paths, input.taskId);
  if (status.ok !== true) return status;
  const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
  if (typeof task.target_id !== "string") {
    const opened = await openChatGptChat(policy, { ports: input.ports, url: input.url, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
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
    const settled = await runChatGptAnswerSettle({ ports: input.ports, preferredChatId: typeof task.chat_id === "string" ? task.chat_id : undefined, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs, readinessProfile: input.readinessProfile, maxWaitMs: input.maxWaitMs, observationBudgetMs: input.observationBudgetMs, pollMs: input.pollMs, requireComposerSendMode: false });
    if (settled.ok !== true || settled.ready_for_gate !== true) return { ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_STAGE_NOT_READY", settled };
    const recorded = await recordEngineAnswerCapture(paths, input.taskId, settled);
    return { ok: recorded.ok === true, stage: "answer_capture", result: recorded, next_action: "gateway decision" };
  }
  if (typeof task.decision_status !== "string") {
    const prompt = buildGatewayDecisionPrompt(input.taskId, task, Array.isArray(status.events) ? status.events as Record<string, unknown>[] : []);
    const asked = await executeAsk(policy, baseDir, typeof task.workspace_path === "string" ? task.workspace_path : baseDir, prompt, input.gatewayModel, input.gatewayMaxOutputTokens, input.gatewayTemperature, input.gatewayTimeoutMs, input.gatewayRaw, input.gatewayConsoleEndpoint);
    const recorded = await recordEngineGatewayDecision(paths, input.taskId, asked as unknown as Record<string, unknown>);
    return { ok: asked.ok === true && recorded.ok === true, stage: "gateway_decision", result: recorded, asked, next_action: "draft reply-back" };
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
  const status = String(task.decision_status ?? "CONTINUE");
  const next = String(task.decision_next_action ?? task.next_action ?? "continue with the next safe engine step");
  return [
    `Engine decision for ${taskId}: ${status}.`,
    `Next action: ${next}`,
    "Proceed with the next safe bounded step only. Return concise status, changed files if any, gates run, and next safe action."
  ].join("\n");
}

function buildGatewayDecisionPrompt(taskId: string, task: Record<string, unknown>, events: Record<string, unknown>[]): string {
  const latestCapture = [...events].reverse().find((event) => event.event === "executor_answer_captured") ?? null;
  const captureData = typeof latestCapture?.data === "object" && latestCapture.data !== null ? latestCapture.data as Record<string, unknown> : {};
  const latestAssistant = typeof captureData.latest_assistant === "object" && captureData.latest_assistant !== null ? captureData.latest_assistant as Record<string, unknown> : {};
  const assistantText = typeof latestAssistant.text === "string" ? latestAssistant.text.slice(0, 8000) : "";
  return [
    "You are the low-cost gateway decision layer for a deterministic local engine.",
    "Return JSON only.",
    "Use this exact shape:",
    "{\"status\":\"GREEN|CONTINUE|BLOCKED|NEEDS_USER\",\"next_action\":\"string\",\"summary\":\"string\",\"risks\":[\"string\"],\"reply_back_required\":false}",
    "",
    `Task ID: ${taskId}`,
    `Component: ${String(task.component_label ?? task.component ?? "unknown")}`,
    `Workspace: ${String(task.workspace_path ?? "unknown")}`,
    `Phase: ${String(task.phase_key ?? "unknown")}`,
    `Engine next action: ${String(task.next_action ?? "unknown")}`,
    `Assistant hash: ${String(task.assistant_hash ?? "unknown")}`,
    `Assistant length: ${String(task.assistant_length ?? "unknown")}`,
    "",
    "Assistant answer:",
    assistantText,
    "",
    "Classify whether the engine should continue, stop for user, or proceed to deterministic gates. Do not propose browser actions. Do not write a reply-back message yet."
  ].join("\n");
}

