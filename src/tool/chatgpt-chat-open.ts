import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { extractChatGptChatId } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type OpenedChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null };

const chatOpenInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
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
  allowOverwrite: z.boolean().default(false),
  autoSubmit: z.boolean().default(true),
  activate: z.boolean().default(true),
  confirmOpenDraft: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(3000),
}).strict();

export function registerChatGptChatOpenTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.browser.chatgpt.chat.open", {
    description: "Open a ChatGPT page in the existing supervised browser through local DevTools. It never submits a prompt.",
    inputSchema: chatOpenInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChat(input)));

  server.registerTool("console.write.browser.chatgpt.prompt.send", {
    description: "Send the current draft prompt in a specific supervised ChatGPT tab selected by DevTools target id.",
    inputSchema: chatPromptSendInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await sendChatGptPrompt(input)));

  server.registerTool("console.write.browser.chatgpt.chat.open.draft", {
    description: "Open a ChatGPT page, write a prompt draft, and optionally send it. Requires explicit confirmation.",
    inputSchema: chatOpenDraftInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChatDraft(input)));
}

async function openChatGptChat(input: z.infer<typeof chatOpenInputSchema>): Promise<Record<string, unknown>> {
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
      return { ok: true, status: "CHATGPT_DOCUMENT_READY", selected: ready, chat_id: ready.chat_id, current_url: ready.url ?? targetUrl, port, attempts, will_submit: false, policy: buildChatOpenPolicy() };
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

async function openChatGptChatDraft(input: z.infer<typeof chatOpenDraftInputSchema>): Promise<Record<string, unknown>> {
  if (!input.confirmOpenDraft) {
    return { ok: false, status: "CONFIRM_OPEN_DRAFT_REQUIRED", target_url: normalizeChatGptUrl(input.url), will_submit: input.autoSubmit, policy: buildChatOpenDraftPolicy() };
  }
  const opened = await openChatGptChat({ ports: input.ports, url: input.url, activate: input.activate, confirmOpen: true, timeoutMs: input.timeoutMs });
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
  return { ...opened, ok: draftOk && (!input.autoSubmit || sendOk), status: input.autoSubmit ? (sendOk ? "CHATGPT_CHAT_OPENED_DRAFT_SENT" : "CHATGPT_CHAT_OPENED_SEND_BLOCKED") : (draftOk ? "CHATGPT_CHAT_OPENED_DRAFT_WRITTEN" : "CHATGPT_CHAT_OPENED_DRAFT_BLOCKED"), draft, send, draft_length: input.draftText.length, will_submit: input.autoSubmit, submitted: sendOk, policy: buildChatOpenDraftPolicy() };
}

function normalizeChatGptUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
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
