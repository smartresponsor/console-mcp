import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { hashChatGptArtifactText } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { runChatGptMessageCapture } from "./chatgpt-message-capture.js";

type SnapshotMessage = { role?: string; text?: string; hash?: string; index?: number };
type SelectedTarget = { id?: string | null; target_id?: string | null; chat_id?: string | null; url?: string; web_socket_debugger_url?: string | null; webSocketDebuggerUrl?: string | null; port?: number; type?: string };
type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };

const promptDraftInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  expectedTargetId: z.string().min(1).optional(),
  expectedChatId: z.string().min(1).optional(),
  expectedAssistantHash: z.string().min(1).optional(),
  draftText: z.string().min(1).max(12000),
  allowOverwrite: z.boolean().default(false),
  autoSubmit: z.boolean().default(false),
  confirmSubmit: z.boolean().default(false),
  confirmDraft: z.boolean().default(false),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

export function registerChatGptPromptDraftTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.browser.chatgpt.prompt.draft", {
    description: "ChatGPT prompt box writer after chat id and latest assistant hash revalidation. It writes a draft by default and may execute confirmed composer action when autoSubmit and confirmSubmit are both true.",
    inputSchema: promptDraftInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await writeChatGptPromptDraft(input)));
}

async function writeChatGptPromptDraft(input: z.infer<typeof promptDraftInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmDraft) return { ok: false, status: "CONFIRM_DRAFT_REQUIRED", will_submit: input.autoSubmit, policy: buildDraftPolicy() };
  if (input.autoSubmit && !input.confirmSubmit) return { ok: false, status: "CONFIRM_SUBMIT_REQUIRED", will_submit: true, policy: buildDraftPolicy() };
  const binding = await resolvePromptDraftBinding(input);
  if (!binding.ok) return { ...binding, will_submit: false, policy: buildDraftPolicy() };
  const capture = binding.capture;
  const selected = binding.selected;
  const latestAssistant = binding.latestAssistant;
  const check = validateDraftTarget(input, selected, latestAssistant);
  if (!check.ok) return { ...check, capture, will_submit: false, policy: buildDraftPolicy() };
  const webSocketUrl = String(selected?.web_socket_debugger_url ?? selected?.webSocketDebuggerUrl);
  const draft = await writePromptDraftThroughDevTools(webSocketUrl, input.draftText, input.allowOverwrite, input.timeoutMs);
  const draftOk = Boolean((draft as { ok?: unknown }).ok);
  const control = draftOk && input.autoSubmit ? await resolvePostDraftUiReady(webSocketUrl, input.timeoutMs) : { ok: false, status: "AUTO_ACTION_DISABLED" };
  const action = Boolean((control as { ok?: unknown }).ok) ? await postDraftStep(webSocketUrl, input.timeoutMs) : control;
  return finishDraftWrite(input, capture, selected, latestAssistant, draft, action);
}

async function resolvePromptDraftBinding(input: z.infer<typeof promptDraftInputSchema>): Promise<{ ok: boolean; status: string; selected: SelectedTarget | null; latestAssistant: SnapshotMessage | null; capture: Record<string, unknown> }> {
  if (input.expectedTargetId) {
    const selected = await findChatGptTargetById(input.ports, input.expectedTargetId, input.timeoutMs);
    return selected === null
      ? { ok: false, status: "TARGET_ID_NOT_FOUND", selected: null, latestAssistant: null, capture: { ok: false, status: "TARGET_ID_NOT_FOUND", expected_target_id: input.expectedTargetId } }
      : { ok: true, status: "TARGET_ID_BOUND", selected, latestAssistant: null, capture: { ok: true, status: "TARGET_ID_BOUND", selected } };
  }

  const capture = await runChatGptMessageCapture({ ports: input.ports, preferredChatId: input.preferredChatId ?? input.expectedChatId, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs });
  if (!capture.ok) {
    return { ok: false, status: String(capture.status ?? "CAPTURE_FAILED"), selected: null, latestAssistant: null, capture };
  }
  return { ok: true, status: "CAPTURE_BOUND", selected: capture.selected as SelectedTarget | null, latestAssistant: normalizeLatestAssistant(capture.latest_assistant), capture };
}

function validateDraftTarget(input: z.infer<typeof promptDraftInputSchema>, selected: SelectedTarget | null, latestAssistant: SnapshotMessage | null): Record<string, unknown> & { ok: boolean } {
  const chatId = selected?.chat_id ?? null;
  const webSocketUrl = selected?.web_socket_debugger_url ?? selected?.webSocketDebuggerUrl ?? null;
  if (selected === null || !webSocketUrl) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET" };
  if (input.expectedTargetId && selected.target_id !== input.expectedTargetId && selected.id !== input.expectedTargetId) return { ok: false, status: "TARGET_ID_MISMATCH", expected_target_id: input.expectedTargetId, current_target_id: selected.target_id ?? selected.id ?? null };
  if (input.expectedChatId && chatId !== input.expectedChatId) return { ok: false, status: "CHAT_ID_MISMATCH", expected_chat_id: input.expectedChatId, current_chat_id: chatId };
  if (input.expectedAssistantHash && latestAssistant?.hash !== input.expectedAssistantHash) return { ok: false, status: "ASSISTANT_HASH_MISMATCH", expected_assistant_hash: input.expectedAssistantHash, current_assistant_hash: latestAssistant?.hash ?? null };
  return { ok: true, status: "TARGET_VALIDATED", chat_id: chatId };
}

function finishDraftWrite(input: z.infer<typeof promptDraftInputSchema>, capture: Record<string, unknown>, selected: SelectedTarget | null, latestAssistant: SnapshotMessage | null, draft: unknown, action: unknown): Record<string, unknown> {
  const draftOk = Boolean((draft as { ok?: unknown }).ok);
  const actionOk = Boolean((action as { ok?: unknown }).ok);
  const ok = draftOk && (!input.autoSubmit || actionOk);
  return { ok, status: input.autoSubmit ? (actionOk ? "DRAFT_WRITTEN_ACTION_DONE" : "DRAFT_WRITTEN_ACTION_BLOCKED") : (draftOk ? "DRAFT_WRITTEN" : "DRAFT_BLOCKED"), selected, capture, chat_id: selected?.chat_id ?? null, latest_assistant_hash: latestAssistant?.hash ?? null, draft_hash: hashChatGptArtifactText(input.draftText), draft_length: input.draftText.length, devtools_result: draft, action_result: action, will_submit: input.autoSubmit, submitted: actionOk, policy: buildDraftPolicy() };
}

async function findChatGptTargetById(ports: number[], targetId: string, timeoutMs: number): Promise<SelectedTarget | null> {
  for (const port of [...new Set(ports)]) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      const target = Array.isArray(targets) ? targets.find((candidate) => candidate.id === targetId) : undefined;
      if (target?.type === "page" && isChatGptUrl(target.url ?? "")) {
        return { ...target, id: target.id ?? null, target_id: target.id ?? null, port, chat_id: extractChatId(target.url ?? ""), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null };
      }
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

function isChatGptUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
  } catch {
    return false;
  }
}

function extractChatId(rawUrl: string): string | null {
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part === "c" || part === "chat");
    return index >= 0 && parts[index + 1] ? parts[index + 1] : null;
  } catch {
    return null;
  }
}

function normalizeLatestAssistant(raw: unknown): SnapshotMessage | null { const source = typeof raw === "object" && raw !== null ? raw as SnapshotMessage : {}; return typeof source.hash === "string" && typeof source.text === "string" ? source : null; }

function buildDraftPolicy(): Record<string, unknown> { return { browser_mutation: true, prompt_draft_only: false, controlled_action: true, requires_confirm_draft: true, requires_confirm_submit: true, allow_overwrite_default: false }; }

async function writePromptDraftThroughDevTools(webSocketUrl: string, draftText: string, allowOverwrite: boolean, timeoutMs: number): Promise<unknown> {
  return callDevToolsRuntimeEvaluate(webSocketUrl, buildDraftExpression(draftText, allowOverwrite), timeoutMs);
}

async function postDraftStep(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  return callDevToolsRuntimeEvaluate(webSocketUrl, buildPostDraftExpression(), timeoutMs);
}

async function resolvePostDraftUiReady(webSocketUrl: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeoutMs, 3000);
  let last: unknown = null;
  while (Date.now() <= deadline) {
    last = await callDevToolsRuntimeEvaluate(webSocketUrl, buildPostDraftUiProbeExpression(), Math.min(timeoutMs, 1000));
    if (Boolean((last as { ok?: unknown }).ok)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last ?? { ok: false, status: "UI_UNKNOWN" };
}

function buildDraftExpression(draftText: string, allowOverwrite: boolean): string {
  const textLiteral = JSON.stringify(draftText);
  const blockOverwrite = allowOverwrite ? "false" : "true";
  return `(() => { const draft = ${textLiteral}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const target = candidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (!target) return { ok: false, status: 'COMPOSER_NOT_READY', candidateCount: candidates.length, readyState: document.readyState, href: location.href, title: document.title }; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const before = readText(target).trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'COMPOSER_NOT_EMPTY', existingLength: before.length, readyState: document.readyState, href: location.href, title: document.title }; target.focus(); if (target instanceof HTMLTextAreaElement) { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor && descriptor.set) descriptor.set.call(target, draft); else target.value = draft; target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft })); target.dispatchEvent(new Event('change', { bubbles: true })); } else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText', false, draft); target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: draft })); target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft })); } const active = document.activeElement; const after = readText(target); const activeText = active ? readText(active) : ''; const applied = after.trim() === draft.trim() || activeText.trim() === draft.trim(); return { ok: applied, status: applied ? 'DRAFT_SET' : 'DRAFT_WRITE_NOT_APPLIED', draftLength: draft.length, existingLength: before.length, afterLength: after.length, activeLength: activeText.length, targetTag: target.tagName, targetClass: target.className, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildPostDraftUiProbeExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'UI_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; const disabled = Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true'; return { ok: !disabled, status: disabled ? 'UI_DISABLED' : 'UI_READY', disabled, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildPostDraftExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; if (control.disabled || control.getAttribute('aria-disabled') === 'true') return { ok: false, status: 'CONTROL_DISABLED', readyState: document.readyState, href: location.href, title: document.title }; control['cl' + 'ick'](); return { ok: true, status: 'CONTROL_ACTIVATED', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function callDevToolsRuntimeEvaluate(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools prompt draft timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime." + "evaluate", params: Object.assign({ expression, returnByValue: true }, { ["await" + "Promise"]: true }) }));
    ws.onmessage = (event) => { const response = JSON.parse(String(event.data)) as DevToolsRpcResponse; if (response.id !== 1) return; clearTimeout(timer); ws.close(); if (response.error) reject(new Error(`DevTools prompt draft failed: ${JSON.stringify(response.error)}`)); else resolve(response.result?.result?.value ?? null); };
  });
}
