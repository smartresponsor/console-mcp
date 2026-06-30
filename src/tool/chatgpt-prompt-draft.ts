import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { hashChatGptArtifactText } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";
import { runChatGptMessageCapture } from "./chatgpt-message-capture.js";

type SnapshotMessage = { role?: string; text?: string; hash?: string; index?: number };
type SelectedTarget = { chat_id?: string | null; url?: string; web_socket_debugger_url?: string | null; port?: number; target_id?: string | null };
type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown } }; error?: unknown };

const promptDraftInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([3333, 3334, 9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  expectedChatId: z.string().min(1).optional(),
  expectedAssistantHash: z.string().min(1),
  draftText: z.string().min(1).max(12000),
  allowOverwrite: z.boolean().default(false),
  confirmDraft: z.boolean().default(false),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
}).strict();

export function registerChatGptPromptDraftTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.browser.chatgpt.prompt.draft", {
    description: "Draft-only ChatGPT prompt box writer after chat id and latest assistant hash revalidation. It never submits.",
    inputSchema: promptDraftInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await writeChatGptPromptDraft(input)));
}

async function writeChatGptPromptDraft(input: z.infer<typeof promptDraftInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmDraft) return { ok: false, status: "CONFIRM_DRAFT_REQUIRED", will_submit: false, policy: buildDraftPolicy() };
  const capture = await runChatGptMessageCapture({ ports: input.ports, preferredChatId: input.preferredChatId ?? input.expectedChatId, requireChatId: true, maxMessages: input.maxMessages, timeoutMs: input.timeoutMs });
  if (!capture.ok) return { ok: false, status: capture.status ?? "CAPTURE_FAILED", capture, will_submit: false, policy: buildDraftPolicy() };
  const selected = capture.selected as SelectedTarget | null;
  const latestAssistant = normalizeLatestAssistant(capture.latest_assistant);
  const check = validateDraftTarget(input, selected, latestAssistant);
  if (!check.ok) return { ...check, capture, will_submit: false, policy: buildDraftPolicy() };
  const draft = await writePromptDraftThroughDevTools(String(selected?.web_socket_debugger_url), input.draftText, input.allowOverwrite, input.timeoutMs);
  return finishDraftWrite(input, capture, selected, latestAssistant, draft);
}

function validateDraftTarget(input: z.infer<typeof promptDraftInputSchema>, selected: SelectedTarget | null, latestAssistant: SnapshotMessage | null): Record<string, unknown> & { ok: boolean } {
  const chatId = selected?.chat_id ?? null;
  if (selected === null || !selected.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET" };
  if (input.expectedChatId && chatId !== input.expectedChatId) return { ok: false, status: "CHAT_ID_MISMATCH", expected_chat_id: input.expectedChatId, current_chat_id: chatId };
  if (latestAssistant?.hash !== input.expectedAssistantHash) return { ok: false, status: "ASSISTANT_HASH_MISMATCH", expected_assistant_hash: input.expectedAssistantHash, current_assistant_hash: latestAssistant?.hash ?? null };
  return { ok: true, status: "TARGET_VALIDATED", chat_id: chatId };
}

function finishDraftWrite(input: z.infer<typeof promptDraftInputSchema>, capture: Record<string, unknown>, selected: SelectedTarget | null, latestAssistant: SnapshotMessage | null, draft: unknown): Record<string, unknown> {
  const ok = Boolean((draft as { ok?: unknown }).ok);
  return { ok, status: ok ? "DRAFT_WRITTEN" : "DRAFT_BLOCKED", selected, capture, chat_id: selected?.chat_id ?? null, latest_assistant_hash: latestAssistant?.hash ?? null, draft_hash: hashChatGptArtifactText(input.draftText), draft_length: input.draftText.length, devtools_result: draft, will_submit: false, policy: buildDraftPolicy() };
}

function normalizeLatestAssistant(raw: unknown): SnapshotMessage | null { const source = typeof raw === "object" && raw !== null ? raw as SnapshotMessage : {}; return typeof source.hash === "string" && typeof source.text === "string" ? source : null; }

function buildDraftPolicy(): Record<string, unknown> { return { browser_mutation: true, prompt_draft_only: true, auto_submit: false, requires_confirm_draft: true, allow_overwrite_default: false }; }

async function writePromptDraftThroughDevTools(webSocketUrl: string, draftText: string, allowOverwrite: boolean, timeoutMs: number): Promise<unknown> {
  return callDevToolsRuntimeEvaluate(webSocketUrl, buildDraftExpression(draftText, allowOverwrite), timeoutMs);
}

function buildDraftExpression(draftText: string, allowOverwrite: boolean): string {
  const textLiteral = JSON.stringify(draftText);
  const blockOverwrite = allowOverwrite ? "false" : "true";
  return `(() => { const draft = ${textLiteral}; const selectors = ['textarea[data-testid="prompt-textarea"]', '[data-testid="prompt-textarea"]', 'textarea', 'div[contenteditable="true"]']; const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!target) return { ok: false, status: 'PROMPT_NOT_FOUND' }; const before = String(target.value || target.innerText || target.textContent || '').trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'PROMPT_NOT_EMPTY', existingLength: before.length }; target.focus(); if ('value' in target) { target.value = draft; target.dispatchEvent(new Event('input', { bubbles: true })); } else { target.textContent = draft; target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft })); } const after = String(target.value || target.innerText || target.textContent || ''); return { ok: after.trim() === draft.trim(), status: after.trim() === draft.trim() ? 'DRAFT_SET' : 'DRAFT_SET_UNVERIFIED', draftLength: draft.length, existingLength: before.length }; })()`;
}

function callDevToolsRuntimeEvaluate(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools prompt draft timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime." + "evaluate", params: { expression, returnByValue: true, awaitPromise: false } }));
    ws.onmessage = (event) => { const response = JSON.parse(String(event.data)) as DevToolsRpcResponse; if (response.id !== 1) return; clearTimeout(timer); ws.close(); if (response.error) reject(new Error(`DevTools prompt draft failed: ${JSON.stringify(response.error)}`)); else resolve(response.result?.result?.value ?? null); };
  });
}
