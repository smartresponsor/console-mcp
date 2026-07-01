import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import { buildChatGptArtifactCorrectionComment, findChatGptDeterministicCanonRisks, verifyChatGptInjectionTarget, type ChatGptSessionBinding } from "../service/chatgpt-artifact-guard.js";
import { buildConsoleToolRegistration, textResult } from "./common.js";
import { runChatGptMessageCapture } from "./chatgpt-message-capture.js";

type SnapshotMessage = { role: "user" | "assistant" | "system" | "unknown"; text: string; hash: string; index: number };

const snapshotInputSchema = z.object({
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
  baselineAssistantHash: z.string().min(1).optional(),
  lastGuardedAssistantHash: z.string().min(1).optional(),
  attachMode: z.enum(["guard_current", "baseline_current"]).default("guard_current"),
  promptAvailable: z.boolean().default(false),
  approvalComment: z.string().default("Go. Review-approved artifact only."),
}).strict();

export function registerChatGptGuardSnapshotTool(server: McpServer, authConfig: ConsoleAuthConfig): void {
  server.registerTool("console.read_.browser.chatgpt.guard.snapshot", {
    description: "Read-only ChatGPT guard snapshot over capture, assistant artifact selection, guard verdict, and prompt preflight.",
    inputSchema: snapshotInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(await buildChatGptGuardSnapshot(input)));
}

async function buildChatGptGuardSnapshot(input: z.infer<typeof snapshotInputSchema>): Promise<Record<string, unknown>> {
  const capture = await runChatGptMessageCapture(input);
  if (!capture.ok) return { ok: false, status: capture.status ?? "CAPTURE_FAILED", capture, policy: buildSnapshotPolicy() };
  return buildSnapshotFromCapture(input, capture);
}

function buildSnapshotFromCapture(input: z.infer<typeof snapshotInputSchema>, capture: Record<string, unknown>): Record<string, unknown> {
  const baseBinding = capture.binding as ChatGptSessionBinding | null;
  if (baseBinding === null) return { ok: false, status: "NEED_BINDING", capture, policy: buildSnapshotPolicy() };
  return finishSnapshot(input, capture, baseBinding);
}

function buildSnapshotPolicy(): Record<string, unknown> {
  return { browser_mutation: false, prompt_injection: false, auto_submit: false, orchestration: "read_only" };
}
function finishSnapshot(input: z.infer<typeof snapshotInputSchema>, capture: Record<string, unknown>, baseBinding: ChatGptSessionBinding): Record<string, unknown> {
  const latestAssistant = normalizeLatestAssistant(capture.latest_assistant);
  const baselineHash = input.attachMode === "baseline_current" ? latestAssistant?.hash ?? null : input.baselineAssistantHash ?? null;
  const lastGuardedHash = input.lastGuardedAssistantHash ?? baselineHash;
  const binding = { ...baseBinding, baselineAssistantHash: baselineHash, lastGuardedAssistantHash: lastGuardedHash };
  const messages = normalizeMessages(capture.messages);
  const artifact = selectLatestGuardableAssistant(messages, binding.baselineAssistantHash, binding.lastGuardedAssistantHash);
  if (artifact === null) return { ok: true, status: "WAITING_FOR_ASSISTANT", capture, binding, messages_count: messages.length, artifact: null, verdict: null, prompt_comment: null, policy: buildSnapshotPolicy() };
  return finishArtifactSnapshot(input, capture, binding, messages, latestAssistant, artifact);
}
function finishArtifactSnapshot(input: z.infer<typeof snapshotInputSchema>, capture: Record<string, unknown>, binding: ChatGptSessionBinding, messages: SnapshotMessage[], latestAssistant: SnapshotMessage | null, artifact: SnapshotMessage): Record<string, unknown> {
  const findings = findChatGptDeterministicCanonRisks(artifact.text);
  const verdict = findings.length === 0 ? "GREEN" : "RED";
  const correction = findings.length === 0 ? null : buildChatGptArtifactCorrectionComment(findings);
  const draft = verdict === "GREEN" ? input.approvalComment : correction;
  const preflight = verifyChatGptInjectionTarget({ binding, currentUrl: binding.url, expectedAssistantHash: artifact.hash, currentLatestAssistantHash: latestAssistant?.hash ?? null, promptAvailable: input.promptAvailable });
  return { ok: true, status: preflight.ok ? "SNAPSHOT_READY" : "SNAPSHOT_BLOCKED", capture, binding, messages_count: messages.length, latest_assistant: latestAssistant, artifact, verdict, findings, correction_comment: correction, prompt_comment: { injection_policy: "draft_only", will_submit: false, draft_comment: preflight.ok ? draft : null, blocked_comment: preflight.ok ? null : draft, preflight }, policy: buildSnapshotPolicy() };
}

function normalizeMessages(raw: unknown): SnapshotMessage[] { if (!Array.isArray(raw)) return []; return raw.map((item, index) => normalizeMessage(item, index)).filter((message): message is SnapshotMessage => message !== null); }
function normalizeLatestAssistant(raw: unknown): SnapshotMessage | null { return normalizeMessage(raw, -1); }
function normalizeMessage(raw: unknown, index: number): SnapshotMessage | null { const source = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {}; const role = source.role === "user" || source.role === "assistant" || source.role === "system" || source.role === "unknown" ? source.role : "unknown"; const text = typeof source.text === "string" ? source.text : ""; const hash = typeof source.hash === "string" ? source.hash : ""; return text.length > 0 && hash.length > 0 ? { role, text, hash, index: typeof source.index === "number" ? source.index : index } : null; }
function selectLatestGuardableAssistant(messages: SnapshotMessage[], baselineHash: string | null, lastGuardedHash: string | null): SnapshotMessage | null { const matches = messages.filter((message) => message.role === "assistant" && message.hash !== baselineHash && message.hash !== lastGuardedHash); return matches.length === 0 ? null : matches[matches.length - 1]; }

