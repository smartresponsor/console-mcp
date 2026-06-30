import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import {
  buildChatGptArtifactCorrectionComment,
  createChatGptArtifactCursor,
  createChatGptSessionBinding,
  hashChatGptArtifactText,
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

  server.registerTool("console.read_.browser.chatgpt.prompt.comment", {
    description: "Build a draft-only ChatGPT prompt comment after revalidating the bound chat id and assistant artifact hash.",
    inputSchema: promptCommentInputSchema,
    ...buildConsoleToolRegistration(authConfig),
  }, async (input) => textResult(buildPromptCommentDraft(input)));
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
  const findings = findDeterministicCanonRisks(input.artifactText);
  return {
    ok: true,
    verdict: findings.length === 0 ? "GREEN" : "RED",
    artifact_hash: input.artifactHash ?? hashChatGptArtifactText(input.artifactText),
    canonizing_connected: false,
    canonizing_workspace_path: input.canonizingWorkspacePath ?? null,
    semantic_llm_connected: false,
    review_scope: "deterministic_preliminary_guard",
    findings,
    correction_comment: findings.length === 0 ? null : buildCorrectionComment(findings),
    policy: buildArtifactGuardPolicy(),
  };
}

function findDeterministicCanonRisks(text: string): Array<Record<string, string>> {
  const lower = text.toLowerCase();
  const findings: Array<Record<string, string>> = [];
  if (lower.includes("runtime/standalone") || lower.includes("runtime\\standalone")) {
    findings.push({ code: "non_symfony_runtime_standalone", severity: "red", message: "The artifact mentions runtime/standalone structure instead of Symfony-native structure." });
  }
  if (lower.includes("crud route") || lower.includes("crud controller")) {
    findings.push({ code: "component_crud_route_risk", severity: "red", message: "The artifact mentions CRUD route/controller creation; component CRUD must stay in the existing CRUD mechanism." });
  }
  if (lower.includes("smartresponse") || lower.includes("smartresponsor as public root")) {
    findings.push({ code: "non_console_public_root", severity: "red", message: "The artifact risks using SmartResponse/SmartResponsor as MCP public root instead of console." });
  }
  if (lower.includes("migration-first") || lower.includes("migration first")) {
    findings.push({ code: "migration_first_risk", severity: "red", message: "The artifact mentions migration-first flow; entity-first is the canonical source of truth." });
  }
  return findings;
}

function buildCorrectionComment(findings: Array<Record<string, string>>): string {
  const lines = findings.map((finding, index) => `${index + 1}. ${finding.message}`);
  return ["Do not execute yet.", "The latest assistant artifact has canonical risks:", ...lines, "Rewrite the artifact before execution approval."].join("\n");
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

function buildArtifactGuardPolicy(): Record<string, unknown> {
  return { default_injection_policy: "draft_only", user_messages_guarded: false, assistant_artifacts_guarded: true, auto_submit: false };
}
