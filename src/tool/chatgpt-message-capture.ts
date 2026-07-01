import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { createChatGptArtifactCursor, createChatGptSessionBinding, extractChatGptChatId, hashChatGptArtifactText } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type BoundTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null };
type CapturedMessage = { role: "user" | "assistant" | "system" | "unknown"; text: string; hash: string; index: number };
type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };
type AnswerSettleTiming = { maxWaitMs: number; observationBudgetMs: number; pollMs: number; minStableSamples: number; idleQuietMs: number };

const messageCaptureInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
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
  requireComposerSendMode: z.boolean().default(false),
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
  const deadline = observationStartedAt + timing.observationBudgetMs;
  let stableSamples = 0;
  let previousAssistantHash: string | null = null;
  let previousActivitySignature: string | null = null;
  let idleSince: number | null = null;
  let lastState: NormalizedConversationState | null = null;

  while (Date.now() <= deadline) {
    const rawState = await evaluateConversationState(target.web_socket_debugger_url, input.maxMessages, input.timeoutMs);
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
    previousActivitySignature = state.activitySignature;
    const idleQuiet = idleSince !== null && now - idleSince >= timing.idleQuietMs;

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
      return { ok: true, status: "ANSWER_STABLE", settled: true, ready_for_gate: true, selected: target, scans: tabResult.scans, binding, cursor: binding === null ? null : createChatGptArtifactCursor(binding), messages: state.messages, latest_assistant: latestAssistant, stability: { stable_samples: stableSamples, min_stable_samples: timing.minStableSamples, busy: state.busy, composer_action_mode: state.composerActionMode, composer_control_reason: state.composerControlReason, composer_control_count: state.composerControlCount, visible_composer_control_count: state.visibleComposerControlCount, hidden_composer_control_count: state.hiddenComposerControlCount, require_composer_send_mode: input.requireComposerSendMode, idle_quiet_ms: timing.idleQuietMs, idle_since_ms: idleSince === null ? null : now - idleSince, waited_ms: Date.now() - observationStartedAt, observation_budget_ms: timing.observationBudgetMs, max_wait_ms: timing.maxWaitMs }, policy: buildAnswerSettlePolicy() };
    }

    await delay(timing.pollMs);
  }

  const finalComposerMode = lastState?.composerActionMode ?? null;
  const strictComposerBlocked = input.requireComposerSendMode && finalComposerMode !== "send";
  const finalStatus = strictComposerBlocked ? "ANSWER_IDLE_BUT_COMPOSER_NOT_SEND" : "OBSERVATION_WINDOW_EXPIRED";
  return { ok: false, status: finalStatus, settled: false, ready_for_gate: false, selected: target, scans: tabResult.scans, messages: lastState?.messages ?? [], latest_assistant: lastState?.latestAssistant ?? null, stability: { stable_samples: stableSamples, min_stable_samples: timing.minStableSamples, busy: lastState?.busy ?? null, composer_action_mode: finalComposerMode, composer_control_reason: lastState?.composerControlReason ?? null, composer_control_count: lastState?.composerControlCount ?? null, visible_composer_control_count: lastState?.visibleComposerControlCount ?? null, hidden_composer_control_count: lastState?.hiddenComposerControlCount ?? null, require_composer_send_mode: input.requireComposerSendMode, idle_quiet_ms: timing.idleQuietMs, waited_ms: Date.now() - observationStartedAt, observation_budget_ms: timing.observationBudgetMs, max_wait_ms: timing.maxWaitMs }, policy: buildAnswerSettlePolicy() };
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
  const filtered = input.preferredChatId ? candidates.filter((candidate) => candidate.chat_id === input.preferredChatId) : candidates;
  const target = filtered.find((candidate) => candidate.chat_id !== null) ?? filtered[0] ?? null;
  return { ok: target !== null, status: target === null ? "NEED_BINDING" : "BOUND", target, candidates, scans };
}

function normalizeTarget(port: number, target: BrowserDebugTarget): BoundTarget | null { const url = typeof target.url === "string" ? target.url : ""; if (target.type !== "page" || !isChatGptUrl(url)) return null; return { ...target, port, chat_id: extractChatGptChatId(url), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null }; }
function isChatGptUrl(rawUrl: string): boolean { try { const url = new URL(rawUrl); const host = url.hostname.toLowerCase(); return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com"; } catch { return false; } }
async function readDevToolsTargetList(port: number, timeoutMs: number): Promise<BrowserDebugTarget[]> { const raw = await readLoopbackText(port, "/json/list", timeoutMs); const parsed = JSON.parse(raw) as unknown; if (!Array.isArray(parsed)) throw new Error("DevTools target list did not return an array."); return parsed as BrowserDebugTarget[]; }
function readLoopbackText(port: number, path: string, timeoutMs: number): Promise<string> { return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => { const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`))); req.on("error", reject); req.end(); }); }
function resolveAnswerSettleTiming(input: z.infer<typeof answerSettleInputSchema>): AnswerSettleTiming {
  const profileTiming: Record<z.infer<typeof answerSettleInputSchema>["readinessProfile"], AnswerSettleTiming> = {
    quick_probe: { maxWaitMs: 60000, observationBudgetMs: 12000, pollMs: 750, minStableSamples: 3, idleQuietMs: 10000 },
    rc_gate: { maxWaitMs: 300000, observationBudgetMs: 20000, pollMs: 1000, minStableSamples: 5, idleQuietMs: 30000 },
    long_run: { maxWaitMs: 600000, observationBudgetMs: 30000, pollMs: 1500, minStableSamples: 6, idleQuietMs: 45000 },
  };

  return {
    maxWaitMs: input.maxWaitMs ?? profileTiming[input.readinessProfile].maxWaitMs,
    observationBudgetMs: input.observationBudgetMs ?? profileTiming[input.readinessProfile].observationBudgetMs,
    pollMs: input.pollMs ?? profileTiming[input.readinessProfile].pollMs,
    minStableSamples: input.minStableSamples ?? profileTiming[input.readinessProfile].minStableSamples,
    idleQuietMs: input.idleQuietMs ?? profileTiming[input.readinessProfile].idleQuietMs,
  };
}

function buildMessageCapturePolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false };
}

function buildAnswerSettlePolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false, waits_for_stable_assistant: true, requires_idle_quiet_window: true };
}

async function evaluateMessageDom(webSocketUrl: string, maxMessages: number, timeoutMs: number): Promise<unknown> { return callDevToolsRuntimeEvaluate(webSocketUrl, buildMessageDomExpression(maxMessages), timeoutMs); }
function buildMessageDomExpression(maxMessages: number): string { return `(() => { const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const items = nodes.map((node, index) => { const role = String(node.getAttribute('data-message-author-role') || 'unknown'); const text = String((node.innerText || node.textContent || '')).trim(); return { role, text, index }; }).filter((item) => item.text.length > 0); return items.slice(Math.max(0, items.length - ${maxMessages})); })()`; }

async function evaluateConversationState(webSocketUrl: string, maxMessages: number, timeoutMs: number): Promise<unknown> { return callDevToolsRuntimeEvaluate(webSocketUrl, buildConversationStateExpression(maxMessages), timeoutMs); }
function buildConversationStateExpression(maxMessages: number): string { return `(() => { const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const messages = nodes.map((node, index) => { const role = String(node.getAttribute('data-message-author-role') || 'unknown'); const text = String((node.innerText || node.textContent || '')).trim(); return { role, text, index }; }).filter((item) => item.text.length > 0).slice(-${maxMessages}); const controlSelectors = ['button[data-testid="stop-button"]', 'button[data-testid="composer-stop-button"]', 'button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const controlCandidates = Array.from(new Set(controlSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(Boolean))); const isVisibleActionable = (node) => { if (!(node instanceof HTMLElement)) return false; if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false; const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; const style = window.getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false; return true; }; const controls = controlCandidates.filter(isVisibleActionable); const hiddenControlCount = controlCandidates.length - controls.length; const controlText = controls.map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('data-testid') || '')).join('|').toLowerCase(); const controlHtml = controls.map((node) => String(node.outerHTML || '')).join('|').toLowerCase().slice(0, 4000); const stopMode = controlText.includes('stop') || controlText.includes('останов') || controlHtml.includes('stop-button') || controlHtml.includes('composer-stop-button') || controlHtml.includes('stop generating') || controlHtml.includes('stop streaming'); const primaryControl = controls[0] || null; const submitDisabled = primaryControl ? Boolean(primaryControl.disabled) || primaryControl.getAttribute('aria-disabled') === 'true' : null; const enabledSubmitMode = controls.some((node) => node instanceof HTMLButtonElement && node.matches('form button[type="submit"]') && !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const sendMode = controlText.includes('send') || controlText.includes('отправ') || controlHtml.includes('send-button') || controlHtml.includes('composer-submit-button') || controlHtml.includes('send prompt') || controlHtml.includes('send message') || enabledSubmitMode; const composerActionMode = stopMode ? 'stop' : (sendMode ? (submitDisabled ? 'disabled' : 'send') : 'unknown'); const composerControlReason = controls.length === 0 ? (controlCandidates.length === 0 ? 'no_control_candidates' : 'all_control_candidates_hidden') : (stopMode ? 'visible_stop_control' : (sendMode ? (submitDisabled ? 'visible_send_control_disabled' : 'visible_send_control') : 'visible_control_unknown')); const busySelectors = ['[data-testid*="tool"]', '[aria-label*="tool" i]', '[class*="tool" i]', '[class*="progress" i]', '[class*="spinner" i]']; const busyNodes = busySelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(Boolean); const toolText = busyNodes.map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || '')).join('|').slice(0, 2000); const toolBusy = busyNodes.some((node) => { const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').toLowerCase(); return text.includes('running') || text.includes('working') || text.includes('calling') || text.includes('searching') || text.includes('reading') || text.includes('using') || text.includes('in progress') || text.includes('подожд') || text.includes('выполня'); }); const generating = stopMode || toolBusy; const latestAssistant = [...messages].reverse().find((item) => item.role === 'assistant'); const activitySignature = [messages.length, latestAssistant ? latestAssistant.text.length : 0, latestAssistant ? latestAssistant.text.slice(-200) : '', composerActionMode, composerControlReason, generating, toolText, submitDisabled, controls.length, hiddenControlCount].join('::'); return { messages, generating, toolBusy, toolText, composerActionMode, composerControlReason, composerControlCount: controlCandidates.length, visibleComposerControlCount: controls.length, hiddenComposerControlCount: hiddenControlCount, activitySignature, submitDisabled, readyState: document.readyState, href: location.href, title: document.title }; })()`; }

type NormalizedConversationState = {
  messages: CapturedMessage[];
  latestAssistant: CapturedMessage | null;
  busy: boolean;
  activitySignature: string;
  composerActionMode: string;
  composerControlReason: string;
  composerControlCount: number | null;
  visibleComposerControlCount: number | null;
  hiddenComposerControlCount: number | null;
};

function normalizeConversationState(raw: unknown, maxMessages: number): NormalizedConversationState {
  const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const messages = normalizeMessages(source.messages, maxMessages);
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const composerActionMode = String(source.composerActionMode ?? "unknown");
  const busy = source.generating === true || source.toolBusy === true || composerActionMode === "stop";
  const composerControlReason = String(source.composerControlReason ?? "unknown");
  const composerControlCount = typeof source.composerControlCount === "number" ? source.composerControlCount : null;
  const visibleComposerControlCount = typeof source.visibleComposerControlCount === "number" ? source.visibleComposerControlCount : null;
  const hiddenComposerControlCount = typeof source.hiddenComposerControlCount === "number" ? source.hiddenComposerControlCount : null;
  const activitySignature = String(source.activitySignature ?? `${latestAssistant?.hash ?? "no-assistant"}:${composerActionMode}:${composerControlReason}:${String(source.toolText ?? "")}:${String(source.submitDisabled ?? "")}:${messages.length}`);
  return { messages, latestAssistant, busy, activitySignature, composerActionMode, composerControlReason, composerControlCount, visibleComposerControlCount, hiddenComposerControlCount };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRole(role: unknown): CapturedMessage["role"] { return role === "user" || role === "assistant" || role === "system" ? role : "unknown"; }
function callDevToolsRuntimeEvaluate(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> { const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket; if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process.")); return new Promise((resolve, reject) => { const ws = new Ctor(webSocketUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools Runtime read timed out.")); }, timeoutMs); ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); }; ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime." + "evaluate", params: { expression, returnByValue: true, awaitPromise: false } })); ws.onmessage = (event) => { const response = JSON.parse(String(event.data)) as DevToolsRpcResponse; if (response.id !== 1) return; clearTimeout(timer); ws.close(); if (response.error) reject(new Error(`DevTools Runtime read failed: ${JSON.stringify(response.error)}`)); else resolve(response.result?.result?.value ?? null); }; }); }
function normalizeMessages(raw: unknown, maxMessages: number): CapturedMessage[] { if (!Array.isArray(raw)) return []; return raw.slice(-maxMessages).map((item, index) => { const source = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}; const role = normalizeRole(source.role); const text = truncateText(String(source.text ?? "").trim(), 20000).text; return { role, text, hash: hashChatGptArtifactText(text), index }; }).filter((message) => message.text.length > 0); }
