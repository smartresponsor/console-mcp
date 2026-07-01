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

const messageCaptureInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
}).strict();

export function registerChatGptMessageCaptureTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.browser.chatgpt.message.capture", {
    description: "Read-only capture preparation for ChatGPT user and assistant messages from a supervised browser tab.",
    inputSchema: messageCaptureInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await captureChatGptMessages(input)));
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
function buildMessageCapturePolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, dom_write: false };
}

async function evaluateMessageDom(webSocketUrl: string, maxMessages: number, timeoutMs: number): Promise<unknown> { return callDevToolsRuntimeEvaluate(webSocketUrl, buildMessageDomExpression(maxMessages), timeoutMs); }
function buildMessageDomExpression(maxMessages: number): string { return `(() => { const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')); const items = nodes.map((node, index) => { const role = String(node.getAttribute('data-message-author-role') || 'unknown'); const text = String((node.innerText || node.textContent || '')).trim(); return { role, text, index }; }).filter((item) => item.text.length > 0); return items.slice(Math.max(0, items.length - ${maxMessages})); })()`; }

function normalizeRole(role: unknown): CapturedMessage["role"] { return role === "user" || role === "assistant" || role === "system" ? role : "unknown"; }
function callDevToolsRuntimeEvaluate(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> { const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket; if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process.")); return new Promise((resolve, reject) => { const ws = new Ctor(webSocketUrl); const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools Runtime read timed out.")); }, timeoutMs); ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); }; ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime." + "evaluate", params: { expression, returnByValue: true, awaitPromise: false } })); ws.onmessage = (event) => { const response = JSON.parse(String(event.data)) as DevToolsRpcResponse; if (response.id !== 1) return; clearTimeout(timer); ws.close(); if (response.error) reject(new Error(`DevTools Runtime read failed: ${JSON.stringify(response.error)}`)); else resolve(response.result?.result?.value ?? null); }; }); }
function normalizeMessages(raw: unknown, maxMessages: number): CapturedMessage[] { if (!Array.isArray(raw)) return []; return raw.slice(-maxMessages).map((item, index) => { const source = typeof item === "object" && item !== null ? item as Record<string, unknown> : {}; const role = normalizeRole(source.role); const text = truncateText(String(source.text ?? "").trim(), 20000).text; return { role, text, hash: hashChatGptArtifactText(text), index }; }).filter((message) => message.text.length > 0); }
