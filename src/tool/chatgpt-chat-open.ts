import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { extractChatGptChatId } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleMutationToolRegistration, textResult } from "./common.js";

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
type OpenedChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null };
type OpenAttempt = { port: number; ok: boolean; status: string; error?: string };

const chatOpenInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  url: z.string().min(1).max(500).default("https://chatgpt.com/"),
  activate: z.boolean().default(true),
  confirmOpen: z.boolean().default(false),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
}).strict();

export function registerChatGptChatOpenTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.write.browser.chatgpt.chat.open", {
    description: "Open a ChatGPT page in the existing supervised browser through local DevTools. It never submits a prompt.",
    inputSchema: chatOpenInputSchema,
    ...buildConsoleMutationToolRegistration(authConfig),
  }, async (input) => textResult(await openChatGptChat(input)));
}

async function openChatGptChat(input: z.infer<typeof chatOpenInputSchema>): Promise<Record<string, unknown>> {
  const targetUrl = normalizeChatGptUrl(input.url);
  if (!input.confirmOpen) {
    return { ok: false, status: "CONFIRM_OPEN_REQUIRED", target_url: targetUrl, will_submit: false, policy: buildChatOpenPolicy() };
  }

  const attempts: OpenAttempt[] = [];
  for (const port of [...new Set(input.ports)]) {
    try {
      const created = await createDevToolsTarget(port, targetUrl, input.timeoutMs);
      const normalized = normalizeTarget(port, created);
      if (normalized === null) {
        attempts.push({ port, ok: false, status: "NON_CHATGPT_TARGET" });
        continue;
      }
      if (input.activate && normalized.id) {
        await activateDevToolsTarget(port, normalized.id, input.timeoutMs);
      }
      return {
        ok: true,
        status: "CHATGPT_CHAT_OPENED",
        selected: normalized,
        chat_id: normalized.chat_id,
        current_url: normalized.url ?? targetUrl,
        port,
        attempts,
        will_submit: false,
        policy: buildChatOpenPolicy(),
      };
    } catch (error) {
      attempts.push({ port, ok: false, status: "OPEN_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ok: false, status: "NEED_DEVTOOLS_BROWSER", target_url: targetUrl, attempts, will_submit: false, policy: buildChatOpenPolicy() };
}

function normalizeChatGptUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.username = "";
  url.password = "";
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https ChatGPT URLs are allowed.");
  }
  if (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com") && host !== "chat.openai.com") {
    throw new Error(`Only ChatGPT URLs are allowed: ${url.origin}`);
  }
  if (host === "chat.openai.com") {
    url.hostname = "chatgpt.com";
  }
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
  return devToolsJsonRequest(port, `/json/new?${encodeURIComponent(url)}`, "PUT", timeoutMs);
}

async function activateDevToolsTarget(port: number, targetId: string, timeoutMs: number): Promise<void> {
  await devToolsTextRequest(port, `/json/activate/${encodeURIComponent(targetId)}`, "GET", timeoutMs);
}

function devToolsJsonRequest(port: number, path: string, method: "GET" | "PUT", timeoutMs: number): Promise<BrowserDebugTarget> {
  return devToolsTextRequest(port, path, method, timeoutMs).then((raw) => JSON.parse(raw) as BrowserDebugTarget);
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

function buildChatOpenPolicy(): Record<string, unknown> {
  return { browser_mutation: true, chatgpt_host_only: true, prompt_draft: false, auto_submit: false, requires_confirm_open: true };
}
