import { request } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import {
  buildChatGptArtifactCorrectionComment,
  createChatGptArtifactCursor,
  createChatGptSessionBinding,
  findChatGptDeterministicCanonRisks,
  hashChatGptArtifactText,
  isChatGptExecutionApproval,
  extractChatGptChatId,
  selectNextAssistantArtifact,
  verifyChatGptInjectionTarget,
  type ChatGptArtifactRole,
  type ChatGptSessionMode,
} from "../service/chatgpt-artifact-guard.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";

const sessionModeSchema = z.enum(["default_webui", "manual_agent_prompt"]);
const messageRoleSchema = z.enum(["user", "assistant", "system", "unknown"]);

const sessionStatusInputSchema = z.object({
  currentUrl: z.string().min(1),
  baselineAssistantText: z.string().optional(),
  baselineAssistantHash: z.string().min(1).optional(),
  mode: sessionModeSchema.default("default_webui"),
}).strict();

const artifactCaptureInputSchema = z.object({
  currentUrl: z.string().min(1),
  baselineAssistantText: z.string().optional(),
  baselineAssistantHash: z.string().min(1).optional(),
  lastGuardedAssistantHash: z.string().min(1).optional(),
  mode: sessionModeSchema.default("default_webui"),
  messages: z.array(z.object({
    role: messageRoleSchema,
    text: z.string(),
    hash: z.string().min(1).optional(),
  }).strict()).max(200),
}).strict();

const artifactGuardInputSchema = z.object({
  artifactText: z.string().min(1),
  artifactHash: z.string().min(1).optional(),
  canonizingWorkspacePath: z.string().min(1).optional(),
}).strict();

const semanticExecutionGateInputSchema = artifactCaptureInputSchema.extend({
  approvalText: z.string().optional(),
  canonizingWorkspacePath: z.string().min(1).optional(),
});

const promptCommentInputSchema = z.object({
  boundUrl: z.string().min(1),
  currentUrl: z.string().min(1),
  expectedAssistantHash: z.string().min(1),
  currentLatestAssistantText: z.string().optional(),
  currentLatestAssistantHash: z.string().min(1).optional(),
  promptAvailable: z.boolean().default(false),
  verdict: z.enum(["GREEN", "AMBER", "RED", "OPS_REQUIRED", "NEED_BINDING", "STALE"]),
  correctionComment: z.string().optional(),
  approvalComment: z.string().default("Go. Execute approved plan only."),
}).strict();

const tabBindInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([3333, 3334, 9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  timeoutMs: z.number().int().min(250).max(10000).default(1500),
}).strict();

type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };

export function registerChatGptArtifactGuardTools(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.browser.chatgpt.session.status", {
    description: "Build a read-only ChatGPT Web session binding from a supervised browser URL.",
    inputSchema: sessionStatusInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(buildSessionStatus(input)));

  server.registerTool("console.read_.browser.chatgpt.artifact.capture", {
    description: "Select the next guardable ChatGPT assistant artifact from supplied browser message state.",
    inputSchema: artifactCaptureInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(captureAssistantArtifact(input)));

  server.registerTool("console.read_.policy.artifact.guard", {
    description: "Run a read-only deterministic preliminary guard over a captured assistant artifact.",
    inputSchema: artifactGuardInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(guardAssistantArtifact(input)));

  server.registerTool("console.read_.policy.semantic.execution.gate", {
    description: "Evaluate whether an execution approval may proceed for the latest guardable ChatGPT assistant artifact.",
    inputSchema: semanticExecutionGateInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(evaluateSemanticExecutionGate(input)));

  server.registerTool("console.read_.browser.chatgpt.prompt.comment", {
    description: "Build a draft-only ChatGPT prompt comment after revalidating the bound chat id and assistant artifact hash.",
    inputSchema: promptCommentInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(buildPromptCommentDraft(input)));

  server.registerTool("console.read_.browser.chatgpt.tab.bind", {
    description: "Read-only discovery of a supervised ChatGPT browser tab through local Chromium DevTools target list.",
    inputSchema: tabBindInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await bindChatGptBrowserTab(input)));
}

function buildSessionStatus(input: z.infer<typeof sessionStatusInputSchema>): Record<string, unknown> {
  try {
    const binding = createChatGptSessionBinding({
      url: input.currentUrl,
      boundAt: new Date().toISOString(),
      mode: input.mode as ChatGptSessionMode,
      baselineAssistantText: input.baselineAssistantText ?? null,
      baselineAssistantHash: input.baselineAssistantHash ?? null,
    });
    return { ok: true, status: "bound", binding, cursor: createChatGptArtifactCursor(binding), policy: buildArtifactGuardPolicy() };
  } catch (error) {
    return { ok: false, status: "NEED_BINDING", error: error instanceof Error ? error.message : String(error), policy: buildArtifactGuardPolicy() };
  }
}

function captureAssistantArtifact(input: z.infer<typeof artifactCaptureInputSchema>): Record<string, unknown> {
  const session = buildSessionStatus(input);
  if (!session.ok) return session;

  const binding = session.binding as ReturnType<typeof createChatGptSessionBinding>;
  const cursor = createChatGptArtifactCursor(binding);
  if (input.lastGuardedAssistantHash) cursor.lastGuardedAssistantHash = input.lastGuardedAssistantHash;

  const artifact = selectNextAssistantArtifact(input.messages.map((message) => ({
    role: message.role as ChatGptArtifactRole,
    text: message.text,
    hash: message.hash,
  })), cursor);

  return {
    ok: true,
    status: artifact === null ? "WAITING_FOR_ASSISTANT" : "ASSISTANT_ARTIFACT_READY",
    binding,
    cursor,
    artifact,
    policy: buildArtifactGuardPolicy(),
  };
}

function guardAssistantArtifact(input: z.infer<typeof artifactGuardInputSchema>): Record<string, unknown> {
  const findings = findChatGptDeterministicCanonRisks(input.artifactText);
  return {
    ok: true,
    verdict: findings.length === 0 ? "GREEN" : "RED",
    artifact_hash: input.artifactHash ?? hashChatGptArtifactText(input.artifactText),
    canonizing_connected: false,
    canonizing_workspace_path: input.canonizingWorkspacePath ?? null,
    semantic_llm_connected: false,
    review_scope: "deterministic_preliminary_guard",
    findings,
    correction_comment: findings.length === 0 ? null : buildChatGptArtifactCorrectionComment(findings),
    policy: buildArtifactGuardPolicy(),
  };
}

function evaluateSemanticExecutionGate(input: z.infer<typeof semanticExecutionGateInputSchema>): Record<string, unknown> {
  const approvalDetected = isChatGptExecutionApproval(input.approvalText);
  const captured = captureAssistantArtifact(input);
  if (!captured.ok) {
    return { ...captured, allow_execution: false, approval_detected: approvalDetected };
  }

  if (!approvalDetected) {
    return {
      ...captured,
      status: "WAITING_FOR_APPROVAL",
      verdict: "NEED_APPROVAL",
      allow_execution: false,
      approval_detected: false,
    };
  }

  if (captured.status !== "ASSISTANT_ARTIFACT_READY" || captured.artifact === null) {
    return {
      ...captured,
      verdict: "NEED_ASSISTANT_ARTIFACT",
      allow_execution: false,
      approval_detected: true,
    };
  }

  const artifact = captured.artifact as { text: string; hash: string };
  const findings = findChatGptDeterministicCanonRisks(artifact.text);
  const allowExecution = findings.length === 0;
  return {
    ...captured,
    status: allowExecution ? "EXECUTION_ALLOWED" : "EXECUTION_BLOCKED",
    verdict: allowExecution ? "GREEN" : "RED",
    allow_execution: allowExecution,
    approval_detected: true,
    artifact_hash: artifact.hash,
    canonizing_connected: false,
    canonizing_workspace_path: input.canonizingWorkspacePath ?? null,
    semantic_llm_connected: false,
    review_scope: "deterministic_preliminary_guard",
    findings,
    correction_comment: allowExecution ? null : buildChatGptArtifactCorrectionComment(findings),
    policy: buildArtifactGuardPolicy(),
  };
}

function buildPromptCommentDraft(input: z.infer<typeof promptCommentInputSchema>): Record<string, unknown> {
  const session = buildSessionStatus({ currentUrl: input.boundUrl, mode: "default_webui" });
  if (!session.ok) {
    return {
      ok: false,
      status: "NEED_BINDING",
      injection_policy: "draft_only",
      will_submit: false,
      draft_comment: null,
      check: null,
      error: session.error,
      policy: buildArtifactGuardPolicy(),
    };
  }

  const binding = session.binding as ReturnType<typeof createChatGptSessionBinding>;
  const check = verifyChatGptInjectionTarget({
    binding,
    currentUrl: input.currentUrl,
    expectedAssistantHash: input.expectedAssistantHash,
    currentLatestAssistantText: input.currentLatestAssistantText ?? null,
    currentLatestAssistantHash: input.currentLatestAssistantHash ?? null,
    promptAvailable: input.promptAvailable,
  });
  const comment = selectPromptCommentDraft(input);

  return {
    ok: check.ok,
    status: check.ok ? "DRAFT_READY" : "STALE",
    injection_policy: "draft_only",
    will_submit: false,
    check,
    draft_comment: check.ok ? comment : null,
    blocked_comment: check.ok ? null : comment,
    policy: buildArtifactGuardPolicy(),
  };
}

function selectPromptCommentDraft(input: z.infer<typeof promptCommentInputSchema>): string {
  if (input.verdict === "GREEN") return input.approvalComment;
  if (input.correctionComment && input.correctionComment.trim().length > 0) return input.correctionComment.trim();
  if (input.verdict === "OPS_REQUIRED") return "Do not execute yet. Browser, runtime, or manual preparation is required before continuing.";
  return "Do not execute yet. The latest assistant artifact must be corrected before execution approval.";
}

async function bindChatGptBrowserTab(input: z.infer<typeof tabBindInputSchema>): Promise<Record<string, unknown>> {
  const ports = [...new Set(input.ports)];
  const scans = [];
  const candidates = [];
  for (const port of ports) {
    try {
      const targets = await readDevToolsTargetList(port, input.timeoutMs);
      scans.push({ port, ok: true, target_count: targets.length });
      for (const target of targets) {
        const tab = normalizeChatGptTarget(port, target);
        if (tab !== null) candidates.push(tab);
      }
    } catch (error) {
      scans.push({ port, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const filtered = input.preferredChatId ? candidates.filter((candidate) => candidate.chat_id === input.preferredChatId) : candidates;
  const selected = filtered.find((candidate) => candidate.chat_id !== null) ?? filtered[0] ?? null;
  if (selected === null) {
    return { ok: false, status: "NEED_BINDING", selected: null, candidates, scans, policy: buildArtifactGuardPolicy() };
  }
  if (input.requireChatId && selected.chat_id === null) {
    return { ok: false, status: "NEED_CHAT_ID", selected, candidates, scans, policy: buildArtifactGuardPolicy() };
  }

  const binding = selected.chat_id === null ? null : createChatGptSessionBinding({ url: String(selected.url), boundAt: new Date().toISOString() });
  return {
    ok: true,
    status: binding === null ? "BOUND_WITHOUT_CHAT_ID" : "BOUND",
    selected,
    candidates,
    scans,
    binding,
    cursor: binding === null ? null : createChatGptArtifactCursor(binding),
    policy: buildArtifactGuardPolicy(),
  };
}

function normalizeChatGptTarget(port: number, target: BrowserDebugTarget): Record<string, unknown> | null {
  const url = typeof target.url === "string" ? target.url : "";
  if (!isChatGptUrl(url) || target.type !== "page") return null;
  return {
    port,
    target_id: target.id ?? null,
    type: target.type,
    title: target.title ?? null,
    url,
    chat_id: extractChatGptChatId(url),
    devtools_attached: false,
    dom_captured: false,
  };
}

function isChatGptUrl(rawUrl: string): boolean { try { const url = new URL(rawUrl); const host = url.hostname.toLowerCase(); return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com"; } catch { return false; } }
async function readDevToolsTargetList(port: number, timeoutMs: number): Promise<BrowserDebugTarget[]> { const raw = await readLoopbackText(port, "/json/list", timeoutMs); const parsed = JSON.parse(raw) as unknown; if (!Array.isArray(parsed)) throw new Error("DevTools target list did not return an array."); return parsed as BrowserDebugTarget[]; }

function readLoopbackText(port: number, path: string, timeoutMs: number): Promise<string> { return new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => { const chunks: Buffer[] = []; res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`))); req.on("error", reject); req.end(); }); }
function buildArtifactGuardPolicy(): Record<string, unknown> {
  return { default_injection_policy: "draft_only", user_messages_guarded: false, assistant_artifacts_guarded: true, auto_submit: false };
}
