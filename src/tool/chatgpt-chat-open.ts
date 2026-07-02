import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { extractChatGptChatId } from "../service/chatgpt-artifact-guard.js";
import { recordChatGptComponentChatToken, resolveChatGptComponentLabel, shouldRecordChatGptComponentChatToken } from "../service/chatgpt-component-label.js";
import { buildChatGptEntrypointPlan } from "../service/chatgpt-entrypoint-preset.js";
import type { ConsolePolicy } from "../service/policy.js";
import { runSupervisedCommand } from "../service/command.js";
import { assertAllowedRoot } from "../service/path.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { startChatGptRunLoopDaemon } from "./implementation-run-capture.js";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type OpenedChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null };
type ChatTitleMode = "off" | "auto" | "prefix";

const chatTitleModeSchema = z.enum(["off", "auto", "prefix"]).default("off");

const chatOpenInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  workspacePath: z.string().min(1).optional(),
  chatTitleMode: chatTitleModeSchema,
  activate: z.boolean().default(true),
  confirmOpen: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatPromptSendInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  expectedTargetId: z.string().min(1),
  confirmSend: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatOpenDraftInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  draftText: z.string().min(1).max(12000),
  workspacePath: z.string().min(1).optional(),
  chatTitleMode: chatTitleModeSchema,
  allowOverwrite: z.boolean().default(false),
  autoSubmit: z.boolean().default(true),
  activate: z.boolean().default(true),
  confirmOpenDraft: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

const chatGptEntrypointStartInputSchema = z.object({
  rawPrompt: z.string().min(1).max(6000),
  workspacePath: z.string().min(1),
  componentName: z.string().min(1).optional(),
  taskPreset: z.enum(["auto", "repo_rc_implementation", "general"]).default("auto"),
  maxAutoIterations: z.number().int().min(1).max(100).default(70),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  chatTitleMode: chatTitleModeSchema,
  allowOverwrite: z.boolean().default(false),
  autoSubmit: z.boolean().default(true),
  activate: z.boolean().default(true),
  confirmStart: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
  runId: z.string().min(1).max(120).optional(),
  replaceExistingDaemon: z.boolean().default(true),
}).strict();

export function registerChatGptChatOpenTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.browser.chatgpt.chat.open", {
    description: "Open a ChatGPT page in the existing supervised browser through local DevTools. It never submits a prompt.",
    inputSchema: chatOpenInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChat(policy, input)));

  server.registerTool("console.write.browser.chatgpt.prompt.send", {
    description: "Send the current draft prompt in a specific supervised ChatGPT tab selected by DevTools target id.",
    inputSchema: chatPromptSendInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await sendChatGptPrompt(input)));

  server.registerTool("console.write.browser.chatgpt.chat.open.draft", {
    description: "Open a ChatGPT page, write a prompt draft, and optionally send it. Requires explicit confirmation.",
    inputSchema: chatOpenDraftInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChatDraft(policy, input)));

  server.registerTool("console.write.browser.chatgpt.entrypoint.start", {
    description: "Expand a short request with the ChatGPT entrypoint planner, open/send it in ChatGPT, then start the supervised run-loop daemon when a chat id is available.",
    inputSchema: chatGptEntrypointStartInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await startChatGptEntrypoint(policy, baseDir, input)));
}

async function openChatGptChat(policy: ConsolePolicy, input: z.infer<typeof chatOpenInputSchema>): Promise<Record<string, unknown>> {
  const targetUrl = normalizeChatGptUrl(input.url);
  if (!input.confirmOpen) {
    return { ok: false, status: "CONFIRM_OPEN_REQUIRED", target_url: targetUrl, will_submit: false, policy: buildChatOpenPolicy() };
  }

  const attempts: Array<Record<string, unknown>> = [];
  for (const port of [...new Set(input.ports)]) {
    try {
      const created = await createDevToolsTarget(port, targetUrl, input.timeoutMs);
      if (!created.id) {
        attempts.push({ port, ok: false, status: "TARGET_ID_MISSING", created });
        continue;
      }
      if (input.activate) {
        await activateDevToolsTarget(port, created.id, input.timeoutMs);
      }
      const ready = await resolveChatGptDocumentTarget(port, created.id, input.timeoutMs);
      if (ready === null) {
        attempts.push({ port, ok: false, status: "CHATGPT_DOCUMENT_NOT_READY", target_id: created.id });
        continue;
      }
      let titleTarget = ready.chat_id ? await findBestChatGptTargetForChatId(input.ports, ready.chat_id, input.timeoutMs) ?? ready : ready;
      let chatTitle = await maybeApplyChatTitlePrefix(policy, input.workspacePath, input.chatTitleMode, titleTarget, input.timeoutMs);
      if (isChatTitlePrefixEvaluationTimeout(chatTitle) && ready.id && titleTarget.id !== ready.id) {
        const retryTitle = await maybeApplyChatTitlePrefix(policy, input.workspacePath, input.chatTitleMode, ready, input.timeoutMs);
        if (!isChatTitlePrefixEvaluationTimeout(retryTitle) || (retryTitle as { ok?: unknown }).ok === true) {
          titleTarget = ready;
          chatTitle = { ...retryTitle, previous_target_retry: { target_id: titleTarget.id, status: "STALE_DUPLICATE_TARGET_SKIPPED" } };
        }
      }
      const titleOk = (chatTitle as { ok?: unknown }).ok !== false;
      return { ok: titleOk, status: titleOk ? "CHATGPT_DOCUMENT_READY" : "CHATGPT_DOCUMENT_READY_TITLE_PREFIX_BLOCKED", selected: titleTarget, opened_target: ready, chat_id: titleTarget.chat_id, current_url: titleTarget.url ?? targetUrl, port: titleTarget.port, attempts, chat_title: chatTitle, will_submit: false, policy: buildChatOpenPolicy() };
    } catch (error) {
      attempts.push({ port, ok: false, status: "OPEN_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ok: false, status: "NEED_DEVTOOLS_BROWSER", target_url: targetUrl, attempts, will_submit: false, policy: buildChatOpenPolicy() };
}

async function sendChatGptPrompt(input: z.infer<typeof chatPromptSendInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmSend) {
    return { ok: false, status: "CONFIRM_SEND_REQUIRED", will_submit: true, policy: buildPromptSendPolicy() };
  }

  const selected = await findDevToolsTargetById(input.ports, input.expectedTargetId, input.timeoutMs);
  if (selected === null) return { ok: false, status: "TARGET_ID_NOT_FOUND", expected_target_id: input.expectedTargetId, will_submit: true, policy: buildPromptSendPolicy() };
  if (!isChatGptUrl(selected.url ?? "")) return { ok: false, status: "TARGET_NOT_CHATGPT", selected, will_submit: true, policy: buildPromptSendPolicy() };
  const webSocketUrl = selected.web_socket_debugger_url ?? selected.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected, will_submit: true, policy: buildPromptSendPolicy() };

  const send = await evaluateInTarget(webSocketUrl, buildSendExpression(), input.timeoutMs);
  const ok = Boolean((send as { ok?: unknown }).ok);
  return { ok, status: ok ? "PROMPT_SENT" : "PROMPT_SEND_BLOCKED", selected, send, will_submit: true, submitted: ok, policy: buildPromptSendPolicy() };
}

async function openChatGptChatDraft(policy: ConsolePolicy, input: z.infer<typeof chatOpenDraftInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmOpenDraft) {
    return { ok: false, status: "CONFIRM_OPEN_DRAFT_REQUIRED", target_url: normalizeChatGptUrl(input.url), will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  }
  const opened = await openChatGptChat(policy, { ports: input.ports, url: input.url, workspacePath: input.workspacePath, chatTitleMode: input.chatTitleMode, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
  if (!opened.ok) return { ...opened, status: opened.status ?? "CHAT_OPEN_FAILED", will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  const selected = opened.selected as OpenedChatGptTarget | undefined;
  const webSocketUrl = selected?.web_socket_debugger_url ?? selected?.webSocketDebuggerUrl ?? null;
  if (!selected || !webSocketUrl) return { ...opened, ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };

  const runtimeDocument = await resolveRuntimeDocumentReady(webSocketUrl, input.timeoutMs);
  if (!Boolean((runtimeDocument as { ok?: unknown }).ok)) return { ...opened, ok: false, status: "RUNTIME_DOCUMENT_NOT_READY", selected, runtime_document: runtimeDocument, will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };

  const composer = await evaluateInTarget(webSocketUrl, buildComposerProbeExpression(), input.timeoutMs);
  if (!Boolean((composer as { ok?: unknown }).ok)) return { ...opened, ok: false, status: "COMPOSER_NOT_READY", selected, composer, will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  const draft = await evaluateInTarget(webSocketUrl, buildDraftExpression(input.draftText, input.allowOverwrite), input.timeoutMs);
  const draftOk = Boolean((draft as { ok?: unknown }).ok);
  const control = draftOk && input.autoSubmit ? await resolveSubmitControlReady(webSocketUrl, input.timeoutMs) : { ok: false, status: "AUTO_SEND_DISABLED" };
  const send = Boolean((control as { ok?: unknown }).ok) ? await evaluateInTarget(webSocketUrl, buildSendExpression(), input.timeoutMs) : control;
  const sendOk = Boolean((send as { ok?: unknown }).ok);
  const selectedAfterSend = sendOk && selected.id ? await resolveChatGptDocumentTargetWithChatId(selected.port, selected.id, input.timeoutMs) : null;
  const labelTarget = selectedAfterSend ?? selected;
  const titleTarget = labelTarget.chat_id ? await findBestChatGptTargetForChatId(input.ports, labelTarget.chat_id, input.timeoutMs) ?? labelTarget : labelTarget;
  const chatTitle = sendOk ? await maybeApplyChatTitlePrefixAfterPromptSend(policy, input.workspacePath, input.chatTitleMode, titleTarget, input.timeoutMs) : opened.chat_title;
  const titleOk = !chatTitle || (chatTitle as { ok?: unknown }).ok !== false || isChatTitlePrefixAutoTitlePending(chatTitle);
  return { ...opened, selected: titleTarget, opened_target: labelTarget, chat_id: titleTarget.chat_id, current_url: titleTarget.url ?? opened.current_url, ok: draftOk && (!input.autoSubmit || sendOk) && titleOk, status: input.autoSubmit ? (sendOk ? (titleOk ? "CHATGPT_CHAT_OPENED_DRAFT_SENT" : "CHATGPT_CHAT_OPENED_DRAFT_SENT_TITLE_PREFIX_BLOCKED") : "CHATGPT_CHAT_OPENED_SEND_BLOCKED") : (draftOk ? "CHATGPT_CHAT_OPENED_DRAFT_WRITTEN" : "CHATGPT_CHAT_OPENED_DRAFT_BLOCKED"), draft, send, chat_title: chatTitle, draft_length: input.draftText.length, will_submit: input.autoSubmit, submitted: sendOk, policy: buildChatOpenDraftPolicy() };
}

async function startChatGptEntrypoint(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof chatGptEntrypointStartInputSchema>): Promise<Record<string, unknown>> {
  const plan = buildChatGptEntrypointPlan({
    rawPrompt: input.rawPrompt,
    workspacePath: input.workspacePath,
    componentName: input.componentName,
    taskPreset: input.taskPreset,
    maxAutoIterations: input.maxAutoIterations,
  });
  const enrichedPrompt = typeof plan.enrichedPrompt === "string" ? plan.enrichedPrompt : input.rawPrompt;
  const beforeHead = await captureWorkspaceHead(policy, input.workspacePath);
  if (!input.confirmStart) {
    return {
      ok: false,
      status: "CONFIRM_ENTRYPOINT_START_REQUIRED",
      will_submit: input.autoSubmit,
      will_start_daemon: plan.autoRun === true && input.autoSubmit,
      before_head: beforeHead,
      plan,
      policy: buildChatGptEntrypointStartPolicy(),
    };
  }

  const opened = await openChatGptChatDraft(policy, {
    ports: input.ports,
    url: input.url,
    draftText: enrichedPrompt,
    workspacePath: input.workspacePath,
    chatTitleMode: input.chatTitleMode,
    allowOverwrite: input.allowOverwrite,
    autoSubmit: input.autoSubmit,
    activate: input.activate,
    confirmOpenDraft: true,
    timeoutMs: input.timeoutMs,
  });
  const chatId = typeof opened.chat_id === "string" && opened.chat_id.length > 0 ? opened.chat_id : null;
  const shouldStartDaemon = plan.autoRun === true && input.autoSubmit && opened.submitted === true && chatId !== null;
  const daemon = shouldStartDaemon ? await startChatGptRunLoopDaemon(policy, baseDir, {
    workspacePath: input.workspacePath,
    beforeHead: beforeHead ?? undefined,
    ports: input.ports,
    checkNames: [],
    preferredChatId: chatId,
    requireChatId: true,
    maxMessages: 30,
    timeoutMs: 2000,
    phase: "reply_watch",
    taskClass: "repo_rc_implementation",
    iteration: 0,
    maxIterations: input.maxAutoIterations,
    attempt: 0,
    executePreAsk: true,
    gatewayAskMode: "off",
    gatewayMaxOutputTokens: 1200,
    gatewayTemperature: 0.1,
    gatewayTimeoutMs: 60000,
    maxAutoIterations: input.maxAutoIterations,
    maxElapsedMs: 7200000,
    pollMs: 15000,
    minWaitMs: 3000,
    maxWaitMs: 30000,
    stopOnReturnToChat: true,
    stopOnPreAskExecuted: true,
    runId: input.runId ?? deriveEntrypointRunId(input.componentName, input.workspacePath, chatId),
    replaceExisting: input.replaceExistingDaemon,
  }) : { ok: false, status: "DAEMON_NOT_STARTED", reason: buildEntrypointDaemonSkipReason(plan, input, opened, chatId) };

  return {
    ok: opened.ok === true && (shouldStartDaemon ? daemon.ok === true : true),
    status: shouldStartDaemon ? (daemon.ok === true ? "ENTRYPOINT_STARTED" : "ENTRYPOINT_SENT_DAEMON_BLOCKED") : "ENTRYPOINT_SENT_DAEMON_SKIPPED",
    plan,
    opened,
    before_head: beforeHead,
    chat_id: chatId,
    daemon,
    policy: buildChatGptEntrypointStartPolicy(),
  };
}

async function captureWorkspaceHead(policy: ConsolePolicy, workspacePath: string): Promise<string | null> {
  try {
    const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
    const result = await runSupervisedCommand(cwd, "git", ["rev-parse", "HEAD"], 30000, 1024 * 1024);
    const head = result.stdout.trim();
    if (!result.ok || head.length !== 40) return null;
    return /^[A-Fa-f0-9]+$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

async function maybeApplyChatTitlePrefix(policy: ConsolePolicy, workspacePath: string | undefined, mode: ChatTitleMode, target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (mode === "off") return { ok: true, status: "CHAT_TITLE_PREFIX_OFF" };
  if (!workspacePath) return { ok: true, status: "CHAT_TITLE_PREFIX_NO_WORKSPACE" };

  const component = await resolveChatGptComponentLabel(policy, workspacePath, target.chat_id);
  if (!component.ok) return { ok: false, status: component.status, component };
  if (mode === "auto" && !target.chat_id) return { ok: true, status: "CHAT_TITLE_PREFIX_WAITING_FOR_CHAT_ID", component };
  if (!target.chat_id) return { ok: false, status: "CHAT_TITLE_PREFIX_CHAT_ID_MISSING", component };
  const webSocketUrl = target.web_socket_debugger_url ?? target.webSocketDebuggerUrl ?? null;
  if (!webSocketUrl) return { ok: false, status: "CHAT_TITLE_PREFIX_NEED_DEVTOOLS_WEBSOCKET", component };
  if (!component.title_prefix || !component.component_token || !component.package_token || !component.composer_name || !component.chat_stamp) {
    return { ok: false, status: "CHAT_TITLE_PREFIX_METADATA_INCOMPLETE", component };
  }

  const runtimeReady = await resolveRuntimeChatIdReady(webSocketUrl, target.chat_id, timeoutMs).catch((error) => ({ ok: false, status: "CHAT_TITLE_PREFIX_RUNTIME_EVALUATION_FAILED", error: error instanceof Error ? error.message : String(error) }));
  if (!Boolean((runtimeReady as { ok?: unknown }).ok)) {
    return { ok: mode === "auto", status: "CHAT_TITLE_PREFIX_WAITING_FOR_CHAT_ID", component, runtime_ready: runtimeReady };
  }
  const renameResult = await evaluateInTarget(webSocketUrl, buildRenameConversationExpression(target.chat_id, component.title_prefix), timeoutMs).catch((error) => ({ ok: false, status: "CHAT_TITLE_PREFIX_RENAME_EVALUATION_FAILED", error: error instanceof Error ? error.message : String(error) }));
  const renameBlockedStatus = classifyChatTitlePrefixRenameBlockedStatus(renameResult);
  const desiredTitle = typeof (renameResult as { desired_title?: unknown }).desired_title === "string" ? (renameResult as { desired_title: string }).desired_title : null;
  const renameStatus = typeof (renameResult as { status?: unknown }).status === "string" ? (renameResult as { status: string }).status : null;
  if (!shouldRecordChatGptComponentChatToken(renameResult as { ok?: unknown })) {
    return {
      ok: false,
      status: renameBlockedStatus,
      component,
      rename: renameResult,
      registry: { ok: false, status: "CHAT_COMPONENT_TOKEN_NOT_RECORDED_RENAME_FAILED", chat_id: target.chat_id },
    };
  }
  const registry = await recordChatGptComponentChatToken(policy, {
    chat_id: target.chat_id,
    component_token: component.component_token,
    package_token: component.package_token,
    composer_name: component.composer_name,
    workspace_path: component.workspace_path,
    workspace_folder: component.workspace_folder,
    chat_stamp: component.chat_stamp,
    title_prefix: component.title_prefix,
    desired_title: desiredTitle,
    rename_status: renameStatus,
  });

  return { ok: true, status: "CHAT_TITLE_PREFIX_APPLIED", component, rename: renameResult, registry };
}

async function maybeApplyChatTitlePrefixAfterPromptSend(policy: ConsolePolicy, workspacePath: string | undefined, mode: ChatTitleMode, target: OpenedChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (mode === "auto") return { ok: true, status: "CHAT_TITLE_PREFIX_DEFERRED_UNTIL_ASSISTANT_SETTLED", chat_id: target.chat_id ?? null };
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 3000), 15000);
  const attempts: Array<Record<string, unknown>> = [];
  let last: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    last = await maybeApplyChatTitlePrefix(policy, workspacePath, mode, target, timeoutMs);
    attempts.push(compactChatTitleAttempt(last));
    if (!isChatTitlePrefixAutoTitlePending(last)) {
      return attempts.length === 1 ? last : { ...last, attempts };
    }
    await delay(500);
  }

  const fallback = last ?? { ok: false, status: "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT" };
  return {
    ...fallback,
    attempts,
  };
}

function isChatTitlePrefixAutoTitlePending(value: unknown): boolean {
  const topLevel = value as { status?: unknown; rename?: unknown } | null;
  const rename = topLevel?.rename as { status?: unknown } | null | undefined;
  const status = typeof topLevel?.status === "string" ? topLevel.status : null;
  const renameStatus = typeof rename?.status === "string" ? rename.status : null;
  return status === "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT" || status === "CHAT_TITLE_PREFIX_AUTO_TITLE_PENDING" || renameStatus === "CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT";
}

function isChatTitlePrefixEvaluationTimeout(value: unknown): boolean {
  const topLevel = value as { rename?: unknown } | null;
  const rename = topLevel?.rename as { status?: unknown; error?: unknown } | null | undefined;
  return rename?.status === "CHAT_TITLE_PREFIX_RENAME_EVALUATION_FAILED" && typeof rename.error === "string" && rename.error.includes("DevTools evaluation timed out");
}

function classifyChatTitlePrefixRenameBlockedStatus(value: unknown): string {
  const rename = value as { conversation_get_body_preview?: unknown; conversation_get_http_status?: unknown } | null;
  const preview = typeof rename?.conversation_get_body_preview === "string" ? rename.conversation_get_body_preview : "";
  const getStatus = typeof rename?.conversation_get_http_status === "number" ? rename.conversation_get_http_status : null;
  if (getStatus === 404 && preview.includes("conversation_deleted")) return "CHAT_TITLE_PREFIX_CHAT_DELETED";
  if (getStatus === 401 || getStatus === 403) return "CHAT_TITLE_PREFIX_AUTH_BLOCKED";
  return "CHAT_TITLE_PREFIX_RENAME_FAILED";
}

function compactChatTitleAttempt(value: Record<string, unknown>): Record<string, unknown> {
  const rename = value.rename as { status?: unknown; current_title?: unknown; desired_title?: unknown; http_status?: unknown } | undefined;
  return { ok: value.ok, status: value.status, rename_status: rename?.status, current_title: rename?.current_title, desired_title: rename?.desired_title, http_status: rename?.http_status };
}

function normalizeChatGptUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!url.hash.startsWith("#settings/")) url.hash = "";
  url.username = "";
  url.password = "";
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https ChatGPT URLs are allowed.");
  if (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com") && host !== "chat.openai.com") throw new Error(`Only ChatGPT URLs are allowed: ${url.origin}`);
  if (host === "chat.openai.com") url.hostname = "chatgpt.com";
  return url.toString();
}

function normalizeTarget(port: number, target: BrowserDebugTarget): OpenedChatGptTarget | null {
  const url = typeof target.url === "string" ? target.url : "";
  if (target.type !== "page" || !isChatGptUrl(url)) return null;
  return { ...target, port, chat_id: extractChatGptChatId(url), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null };
}

function isChatGptUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
  } catch {
    return false;
  }
}

function createDevToolsTarget(port: number, url: string, timeoutMs: number): Promise<BrowserDebugTarget> {
  return devToolsTextRequest(port, `/json/new?${encodeURIComponent(url)}`, "PUT", timeoutMs).then((raw) => JSON.parse(raw) as BrowserDebugTarget);
}

async function activateDevToolsTarget(port: number, targetId: string, timeoutMs: number): Promise<void> {
  await devToolsTextRequest(port, `/json/activate/${encodeURIComponent(targetId)}`, "GET", timeoutMs);
}

async function resolveChatGptDocumentTarget(port: number, targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: BrowserDebugTarget | null = null;
  while (Date.now() <= deadline) {
    const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
    const targets = JSON.parse(raw) as BrowserDebugTarget[];
    const candidate = Array.isArray(targets) ? targets.find((item) => item.id === targetId) : undefined;
    if (candidate) {
      last = candidate;
      const normalized = normalizeTarget(port, candidate);
      if (normalized && normalized.url && normalized.url !== "about:blank") return normalized;
    }
    await delay(100);
  }
  return last ? normalizeTarget(port, last) : null;
}

async function resolveChatGptDocumentTargetWithChatId(port: number, targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 10000);
  let last: OpenedChatGptTarget | null = null;
  while (Date.now() <= deadline) {
    const current = await resolveChatGptDocumentTarget(port, targetId, Math.min(timeoutMs, 1000));
    if (current) {
      last = current;
      if (current.chat_id) return current;
    }
    await delay(150);
  }
  return last;
}

async function findBestChatGptTargetForChatId(ports: number[], chatId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  const matches: OpenedChatGptTarget[] = [];
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      for (const target of Array.isArray(targets) ? targets : []) {
        const normalized = normalizeTarget(port, target);
        if (normalized?.chat_id === chatId && normalized.web_socket_debugger_url) matches.push(normalized);
      }
    } catch {
      continue;
    }
  }
  matches.sort((left, right) => scoreChatGptRenameTarget(right) - scoreChatGptRenameTarget(left));
  return matches[0] ?? null;
}

function scoreChatGptRenameTarget(target: OpenedChatGptTarget): number {
  const rawUrl = target.url ?? "";
  let score = 0;
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has("mweb_fallback")) score += 200;
    if (url.hostname.toLowerCase() === "chatgpt.com") score += 20;
    if (url.pathname.startsWith("/c/")) score += 10;
    if (target.title && target.title !== "ChatGPT") score += 5;
  } catch {
    return score;
  }
  return score;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDevToolsTargetById(ports: number[], targetId: string, timeoutMs: number): Promise<OpenedChatGptTarget | null> {
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      const target = Array.isArray(targets) ? targets.find((candidate) => candidate.id === targetId) : undefined;
      if (target) return normalizeTarget(port, target);
    } catch {
      continue;
    }
  }
  return null;
}

function devToolsTextRequest(port: number, path: string, method: "GET" | "PUT", timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`DevTools ${method} ${path} failed with HTTP ${res.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`)));
    req.on("error", reject);
    req.end();
  });
}

async function resolveRuntimeDocumentReady(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await evaluateInTarget(webSocketUrl, buildRuntimeDocumentProbeExpression(), Math.min(timeoutMs, 1000));
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(100);
  }
  return last ?? { ok: false, status: "RUNTIME_DOCUMENT_UNKNOWN" };
}

function buildRuntimeDocumentProbeExpression(): string {
  return `(() => { const host = location.hostname.toLowerCase(); const ready = document.readyState === 'interactive' || document.readyState === 'complete'; const chatgpt = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com'; return { ok: chatgpt && ready && location.href !== 'about:blank', status: chatgpt && ready ? 'RUNTIME_DOCUMENT_READY' : 'RUNTIME_DOCUMENT_NOT_READY', host, href: location.href, readyState: document.readyState, title: document.title }; })()`;
}

function buildComposerProbeExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean); return { ok: Boolean(target), status: target ? 'COMPOSER_READY' : 'COMPOSER_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildDraftExpression(draftText: string, allowOverwrite: boolean): string {
  const textLiteral = JSON.stringify(draftText);
  const blockOverwrite = allowOverwrite ? "false" : "true";
  return `(() => { const draft = ${textLiteral}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const target = candidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (!target) return { ok: false, status: 'COMPOSER_NOT_READY', candidateCount: candidates.length, readyState: document.readyState, href: location.href, title: document.title }; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const before = readText(target).trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'COMPOSER_NOT_EMPTY', existingLength: before.length, readyState: document.readyState, href: location.href, title: document.title }; target.focus(); if (target instanceof HTMLTextAreaElement) { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor && descriptor.set) descriptor.set.call(target, draft); else target.value = draft; target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft })); target.dispatchEvent(new Event('change', { bubbles: true })); } else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, draft); target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: draft })); target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft })); } const active = document.activeElement; const after = readText(target); const activeText = active ? readText(active) : ''; const applied = after.trim() === draft.trim() || activeText.trim() === draft.trim(); return { ok: applied, status: applied ? 'DRAFT_SET' : 'DRAFT_WRITE_NOT_APPLIED', draftLength: draft.length, existingLength: before.length, afterLength: after.length, activeLength: activeText.length, targetTag: target.tagName, targetClass: target.className, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

async function resolveRuntimeChatIdReady(webSocketUrl: string, expectedChatId: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 10000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await evaluateInTarget(webSocketUrl, buildRuntimeChatIdProbeExpression(expectedChatId), Math.min(timeoutMs, 1000));
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(150);
  }
  return last ?? { ok: false, status: "RUNTIME_CHAT_ID_UNKNOWN" };
}

function buildRuntimeChatIdProbeExpression(expectedChatId: string): string {
  const expected = JSON.stringify(expectedChatId);
  return `(() => { const expectedChatId = ${expected}; const parts = location.pathname.split('/').filter(Boolean); const index = parts.findIndex((part) => part === 'c' || part === 'chat'); const currentChatId = index >= 0 && parts[index + 1] ? parts[index + 1] : ''; const ready = currentChatId === expectedChatId; return { ok: ready, status: ready ? 'RUNTIME_CHAT_ID_READY' : 'RUNTIME_CHAT_ID_WAITING', expected_chat_id: expectedChatId, current_chat_id: currentChatId || null, href: location.href, readyState: document.readyState, title: document.title }; })()`;
}

function buildRenameConversationExpression(chatId: string, titlePrefix: string): string {
  const expectedChatId = JSON.stringify(chatId);
  const prefix = JSON.stringify(titlePrefix);
  return `(async () => { const expectedChatId = ${expectedChatId}; const titlePrefix = ${prefix}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const removePrefix = (value) => clean(value).replace(/^\\[[a-z0-9][a-z0-9_.-]{0,119}:[A-Za-z0-9_-]{6,16}\\]\\s*/u, '').trim(); const currentChatId = location.pathname.split('/').filter(Boolean).reduce((found, part, index, parts) => found || ((part === 'c' || part === 'chat') ? (parts[index + 1] || '') : ''), ''); if (currentChatId !== expectedChatId) return { ok: false, status: 'CHAT_ID_MISMATCH', expected_chat_id: expectedChatId, current_chat_id: currentChatId, href: location.href, title: document.title }; const link = document.querySelector('a[href*="/c/' + CSS.escape(expectedChatId) + '"]') || document.querySelector('a[href*="/chat/' + CSS.escape(expectedChatId) + '"]'); const linkTitle = clean(link?.innerText || link?.textContent || ''); const documentTitle = clean(document.title.replace(/\\|\\s*ChatGPT$/i, '')); const currentTitle = linkTitle || documentTitle || 'New chat'; const emptyChat = currentTitle === 'New chat' && !linkTitle; if (emptyChat) return { ok: false, status: 'CHAT_TITLE_PREFIX_WAITING_FOR_FIRST_PROMPT', current_title: currentTitle, href: location.href, title: document.title }; const suffix = removePrefix(currentTitle) || 'New chat'; const desiredTitle = (titlePrefix + ' ' + suffix).slice(0, 120); if (currentTitle === desiredTitle || currentTitle.startsWith(titlePrefix + ' ')) return { ok: true, status: 'CHAT_TITLE_ALREADY_PREFIXED', current_title: currentTitle, desired_title: desiredTitle, href: location.href, title: document.title }; const fetchWithTimeout = async (url, init) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2500); try { return await fetch(url, { ...init, signal: controller.signal }); } catch (error) { return { ok: false, status: 0, statusText: String(error), json: async () => null }; } finally { clearTimeout(timer); } }; const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const headers = accessToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken } : { 'Content-Type': 'application/json' }; const conversationPath = '/backend-api/conversation/' + encodeURIComponent(expectedChatId); const conversationGet = await fetchWithTimeout(conversationPath, { method: 'GET', credentials: 'include', headers }); const conversationGetContentType = conversationGet?.headers?.get ? conversationGet.headers.get('content-type') : null; const conversationGetBodyPreview = conversationGet && !conversationGet.ok && conversationGet.text ? await conversationGet.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const response = await fetchWithTimeout(conversationPath, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ title: desiredTitle }) }); const ok = Boolean(response && response.ok); if (ok) document.title = desiredTitle + ' | ChatGPT'; return { ok, status: ok ? 'CHAT_TITLE_RENAMED' : 'CHAT_TITLE_RENAME_REQUEST_FAILED', http_status: response?.status ?? null, http_status_text: response?.statusText ?? null, auth_session_http_status: sessionResponse?.status ?? null, auth_token_present: Boolean(accessToken), conversation_get_http_status: conversationGet?.status ?? null, conversation_get_http_status_text: conversationGet?.statusText ?? null, conversation_get_content_type: conversationGetContentType, conversation_get_body_preview: conversationGetBodyPreview, current_title: currentTitle, desired_title: desiredTitle, href: location.href, title: document.title }; })()`;
}

async function resolveSubmitControlReady(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 3000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await evaluateInTarget(webSocketUrl, buildSubmitControlProbeExpression(), Math.min(timeoutMs, 1000));
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await delay(100);
  }
  return last ?? { ok: false, status: "CONTROL_UNKNOWN" };
}

function buildSubmitControlProbeExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; const disabled = Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true'; return { ok: !disabled, status: disabled ? 'CONTROL_DISABLED' : 'CONTROL_READY', disabled, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildSendExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_FOUND', readyState: document.readyState, href: location.href, title: document.title }; if (control.disabled || control.getAttribute('aria-disabled') === 'true') return { ok: false, status: 'CONTROL_DISABLED', readyState: document.readyState, href: location.href, title: document.title }; control['cl' + 'ick'](); return { ok: true, status: 'CONTROL_ACTIVATED', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };

function evaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools evaluation timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as DevToolsRpcResponse;
      if (response.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (response.error) reject(new Error(`DevTools evaluation failed: ${JSON.stringify(response.error)}`));
      else resolve(response.result?.result?.value ?? null);
    };
  });
}

function buildChatOpenPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: false, auto_submit: false, requires_confirm_open: true };
}

function buildPromptSendPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: false, auto_submit: true, requires_confirm_send: true };
}

function buildChatOpenDraftPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: true, auto_submit: true, requires_confirm_open_draft: true, allow_overwrite_default: false };
}

function deriveEntrypointRunId(componentName: string | undefined, workspacePath: string, chatId: string): string {
  const component = (componentName ?? workspacePath.split(/[\\/]+/).filter(Boolean).pop() ?? "chatgpt").toLowerCase();
  const suffix = chatId.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "run";
  return `${component}-entrypoint-${suffix}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}

function buildEntrypointDaemonSkipReason(plan: Record<string, unknown>, input: z.infer<typeof chatGptEntrypointStartInputSchema>, opened: Record<string, unknown>, chatId: string | null): string {
  if (plan.autoRun !== true) return "planner_auto_run_disabled";
  if (!input.autoSubmit) return "auto_submit_disabled";
  if (opened.submitted !== true) return "prompt_not_submitted";
  if (chatId === null) return "chat_id_missing";
  return "unknown";
}

function buildChatGptEntrypointStartPolicy(): Record<string, unknown> {
  return {
    browser_mutation: true,
    prompt_draft: true,
    auto_submit: true,
    requires_confirm_start: true,
    uses_entrypoint_planner: true,
    starts_supervised_daemon: true,
    daemon_submits_prompts: false,
  };
}
