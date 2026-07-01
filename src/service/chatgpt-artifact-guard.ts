import { createHash } from "node:crypto";

export type ChatGptArtifactRole = "user" | "assistant" | "system" | "unknown";

export type ChatGptSessionMode = "default_webui" | "manual_agent_prompt";

export type ChatGptBindingStatus = "bound" | "active" | "stale" | "blocked";

export type ChatGptArtifactCursorState = "waiting_for_assistant" | "assistant_artifact_ready" | "stale" | "need_binding";

export type ChatGptMessageArtifact = {
  role: ChatGptArtifactRole;
  text: string;
  hash?: string;
};

export type ChatGptSessionBinding = {
  provider: "chatgpt-web";
  chatId: string;
  url: string;
  boundAt: string;
  mode: ChatGptSessionMode;
  status: ChatGptBindingStatus;
  baselineAssistantHash: string | null;
  lastGuardedAssistantHash: string | null;
};

export type ChatGptArtifactCursor = {
  chatId: string;
  baselineAssistantHash: string | null;
  lastGuardedAssistantHash: string | null;
  state: ChatGptArtifactCursorState;
};

export type ChatGptGuardableArtifact = {
  role: "assistant";
  text: string;
  hash: string;
  index: number;
};

export type ChatGptInjectionCheck = {
  ok: boolean;
  expectedChatId: string;
  currentChatId: string | null;
  expectedAssistantHash: string;
  currentAssistantHash: string | null;
  reasons: string[];
};

export type ChatGptDeterministicCanonFinding = {
  code: string;
  severity: "red";
  message: string;
};

export type ChatGptSemanticReviewVerdict = "GREEN" | "AMBER" | "RED" | "STALE" | "NEED_BINDING" | "OPS_REQUIRED";

export type ChatGptSemanticReviewRequest = {
  kind: "review_only_semantic_guard";
  promptVersion: "chatgpt-semantic-guard.v1";
  outputSchema: Record<string, unknown>;
  prompt: string;
  context: {
    chatId: string | null;
    artifactHash: string;
    artifactText: string;
    deterministicFindings: ChatGptDeterministicCanonFinding[];
    canonizingWorkspacePath: string | null;
    repositoryContext: string | null;
    allowedNextUserReplies: string[];
    forbiddenImplicitActions: string[];
  };
};

export type ChatGptSemanticExecutionGateStatus =
  | "NEED_BINDING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_ASSISTANT"
  | "EXECUTION_ALLOWED"
  | "EXECUTION_BLOCKED";

export type ChatGptSemanticExecutionGateResult = {
  ok: boolean;
  status: ChatGptSemanticExecutionGateStatus;
  allowExecution: boolean;
  approvalDetected: boolean;
  binding: ChatGptSessionBinding | null;
  cursor: ChatGptArtifactCursor | null;
  artifact: ChatGptGuardableArtifact | null;
  artifactHash: string | null;
  findings: ChatGptDeterministicCanonFinding[];
  correctionComment: string | null;
  reviewScope: "deterministic_preliminary_guard";
  canonizingConnected: false;
  semanticLlmConnected: false;
  error?: string;
};

const CHAT_ID_MIN_LENGTH = 6;
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function extractChatGptChatId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const pathParts = url.pathname.split("/").filter((part) => part.length > 0);
  const cIndex = pathParts.findIndex((part) => part === "c" || part === "chat");
  if (cIndex >= 0) {
    return normalizeChatId(pathParts[cIndex + 1] ?? null);
  }

  return normalizeChatId(url.searchParams.get("chatId") ?? url.searchParams.get("conversationId"));
}

export function createChatGptSessionBinding(input: {
  url: string;
  boundAt: string;
  mode?: ChatGptSessionMode;
  baselineAssistantText?: string | null;
  baselineAssistantHash?: string | null;
}): ChatGptSessionBinding {
  const chatId = extractChatGptChatId(input.url);
  if (chatId === null) {
    throw new Error("ChatGPT URL does not contain a supported chat id.");
  }

  const baselineAssistantHash = input.baselineAssistantHash ?? (input.baselineAssistantText === undefined || input.baselineAssistantText === null ? null : hashChatGptArtifactText(input.baselineAssistantText));

  return {
    provider: "chatgpt-web",
    chatId,
    url: input.url,
    boundAt: input.boundAt,
    mode: input.mode ?? "default_webui",
    status: "bound",
    baselineAssistantHash,
    lastGuardedAssistantHash: baselineAssistantHash,
  };
}

export function createChatGptArtifactCursor(binding: ChatGptSessionBinding): ChatGptArtifactCursor {
  return {
    chatId: binding.chatId,
    baselineAssistantHash: binding.baselineAssistantHash,
    lastGuardedAssistantHash: binding.lastGuardedAssistantHash,
    state: "waiting_for_assistant",
  };
}

export function selectNextAssistantArtifact(messages: ChatGptMessageArtifact[], cursor: ChatGptArtifactCursor): ChatGptGuardableArtifact | null {
  const normalized = messages.map((message, index) => ({
    role: message.role,
    text: message.text,
    hash: message.hash ?? hashChatGptArtifactText(message.text),
    index,
  }));

  const boundaryIndex = findCursorBoundaryIndex(normalized, cursor);
  for (let index = boundaryIndex + 1; index < normalized.length; index += 1) {
    const candidate = normalized[index];
    if (candidate.role !== "assistant") {
      continue;
    }
    if (candidate.hash === cursor.baselineAssistantHash || candidate.hash === cursor.lastGuardedAssistantHash) {
      continue;
    }

    return {
      role: "assistant",
      text: candidate.text,
      hash: candidate.hash,
      index: candidate.index,
    };
  }

  return null;
}

export function markAssistantArtifactGuarded(cursor: ChatGptArtifactCursor, artifact: ChatGptGuardableArtifact): ChatGptArtifactCursor {
  return {
    ...cursor,
    lastGuardedAssistantHash: artifact.hash,
    state: "waiting_for_assistant",
  };
}

export function verifyChatGptInjectionTarget(input: {
  binding: ChatGptSessionBinding;
  currentUrl: string;
  expectedAssistantHash: string;
  currentLatestAssistantText?: string | null;
  currentLatestAssistantHash?: string | null;
  promptAvailable: boolean;
}): ChatGptInjectionCheck {
  const currentChatId = extractChatGptChatId(input.currentUrl);
  const currentAssistantHash = input.currentLatestAssistantHash ?? (input.currentLatestAssistantText === undefined || input.currentLatestAssistantText === null ? null : hashChatGptArtifactText(input.currentLatestAssistantText));
  const reasons: string[] = [];

  if (currentChatId !== input.binding.chatId) {
    reasons.push("chat_id_mismatch");
  }

  if (currentAssistantHash !== input.expectedAssistantHash) {
    reasons.push("assistant_artifact_hash_mismatch");
  }

  if (!input.promptAvailable) {
    reasons.push("prompt_unavailable");
  }

  return {
    ok: reasons.length === 0,
    expectedChatId: input.binding.chatId,
    currentChatId,
    expectedAssistantHash: input.expectedAssistantHash,
    currentAssistantHash,
    reasons,
  };
}

export function hashChatGptArtifactText(text: string): string {
  return createHash("sha256").update(normalizeArtifactText(text), "utf8").digest("hex");
}

export function isChatGptExecutionApproval(text?: string | null): boolean {
  if (text === undefined || text === null) {
    return false;
  }

  const normalized = text.toLowerCase().trim();
  return [
    "go",
    "next",
    "do it",
    "execute",
    "run",
    "apply",
    "proceed",
    "ok",
    "ок",
    "делай",
    "давай",
    "поехали",
    "вперед",
    "вперёд",
  ].includes(normalized);
}

export function findChatGptDeterministicCanonRisks(text: string): ChatGptDeterministicCanonFinding[] {
  const lower = text.toLowerCase();
  const findings: ChatGptDeterministicCanonFinding[] = [];
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
  if (lower.includes("auto push") || lower.includes("push automatically") || lower.includes("push on green")) {
    findings.push({ code: "auto_push_risk", severity: "red", message: "The artifact suggests automatic push; push requires explicit separate approval." });
  }
  if (lower.includes("public smoke") && (lower.includes("auto") || lower.includes("without approval") || lower.includes("immediately"))) {
    findings.push({ code: "public_smoke_without_approval", severity: "red", message: "The artifact suggests public smoke without explicit approval." });
  }
  if ((lower.includes("restart") || lower.includes("dev:restart") || lower.includes("dev:restart-all")) && (lower.includes("auto") || lower.includes("without approval") || lower.includes("immediately"))) {
    findings.push({ code: "runtime_restart_without_approval", severity: "red", message: "The artifact suggests runtime restart without explicit approval." });
  }
  if (lower.includes("src/domain") || lower.includes("src\\domain") || lower.includes("src/runtime") || lower.includes("src\\runtime")) {
    findings.push({ code: "non_layer_first_structure", severity: "red", message: "The artifact suggests non-canonical Symfony structure; Layer First Isolation is required." });
  }
  if (lower.includes("port/adapter") || lower.includes("ports and adapters") || lower.includes("hexagonal")) {
    findings.push({ code: "non_canonical_architecture_vocabulary", severity: "red", message: "The artifact suggests non-canonical architecture vocabulary instead of the project canon." });
  }
  if (lower.includes("console.smartresponsor") || lower.includes("console.smartresponse") || lower.includes("public root smartresponsor") || lower.includes("public root smartresponse")) {
    findings.push({ code: "wrong_mcp_public_root", severity: "red", message: "The artifact suggests a non-canonical MCP public root; console remains the public root." });
  }
  if (lower.includes("console.read.") || lower.includes("console.write_.") || lower.includes("console.mutate") || lower.includes("console.run.")) {
    findings.push({ code: "non_canonical_mcp_tool_name", severity: "red", message: "The artifact suggests a non-canonical MCP tool name; risk token must be the second token: console.read_ or console.write." });
  }
  if ((lower.includes("relating") || lower.includes("relationship")) && (lower.includes("crud route") || lower.includes("crud controller") || lower.includes("crud yaml") || lower.includes("apiresource"))) {
    findings.push({ code: "relating_crud_boundary_violation", severity: "red", message: "The artifact risks adding CRUD to Relating/Relationship; only business routes belong there." });
  }
  if ((lower.includes("touch unrelated") || lower.includes("clean all untracked") || lower.includes("remove untracked")) && !lower.includes("explicit")) {
    findings.push({ code: "unrelated_file_touch_risk", severity: "red", message: "The artifact risks touching unrelated or untracked files without explicit approval." });
  }
  return findings;
}

export function buildChatGptArtifactCorrectionComment(findings: ChatGptDeterministicCanonFinding[]): string {
  const lines = findings.map((finding, index) => `${index + 1}. ${finding.message}`);
  return ["Do not execute yet.", "The latest assistant artifact has canonical risks:", ...lines, "Rewrite the artifact before execution approval."].join("\n");
}

export function buildChatGptSemanticReviewRequest(input: {
  artifactText: string;
  artifactHash?: string;
  chatId?: string | null;
  deterministicFindings?: ChatGptDeterministicCanonFinding[];
  canonizingWorkspacePath?: string | null;
  repositoryContext?: string | null;
}): ChatGptSemanticReviewRequest {
  const artifactHash = input.artifactHash ?? hashChatGptArtifactText(input.artifactText);
  const deterministicFindings = input.deterministicFindings ?? findChatGptDeterministicCanonRisks(input.artifactText);
  const allowedNextUserReplies = ["Go", "Next", "Do it", "Done", "Proceed"];
  const forbiddenImplicitActions = [
    "publication",
    "runtime restart",
    "public smoke",
    "secret rotation",
    "unrelated file cleanup",
  ];
  const payload = {
    task: "review_only_semantic_guard",
    chatId: input.chatId ?? null,
    artifactHash,
    artifactText: input.artifactText,
    deterministicFindings,
    canonizingWorkspacePath: input.canonizingWorkspacePath ?? null,
    repositoryContext: input.repositoryContext ?? null,
    allowedNextUserReplies,
    forbiddenImplicitActions,
    rules: [
      "Classify the assistant artifact only; do not propose operational actions.",
      "Use GREEN only when the artifact is consistent with the supplied canon and has no unresolved risk.",
      "Use RED when deterministic findings indicate a direct canon violation.",
      "Use AMBER for unclear or incomplete plans that need a rewrite before work can continue.",
      "Use OPS_REQUIRED when browser, runtime, secret, or environment preparation is needed before review can continue.",
      "Do not treat Go, Next, Do it, Done, or Proceed as permission for publication, runtime restart, public smoke, or secret changes.",
    ],
    outputShape: buildChatGptSemanticReviewOutputSchema(),
  };

  return {
    kind: "review_only_semantic_guard",
    promptVersion: "chatgpt-semantic-guard.v1",
    outputSchema: buildChatGptSemanticReviewOutputSchema(),
    prompt: [
      "Review-only semantic guard.",
      "Return one compact JSON object and no markdown fences.",
      "Do not suggest performing operations; only classify the artifact and explain required corrections.",
      JSON.stringify(payload),
    ].join("\n"),
    context: {
      chatId: input.chatId ?? null,
      artifactHash,
      artifactText: input.artifactText,
      deterministicFindings,
      canonizingWorkspacePath: input.canonizingWorkspacePath ?? null,
      repositoryContext: input.repositoryContext ?? null,
      allowedNextUserReplies,
      forbiddenImplicitActions,
    },
  };
}

export function buildChatGptSemanticReviewOutputSchema(): Record<string, unknown> {
  return {
    verdict: "GREEN|AMBER|RED|STALE|NEED_BINDING|OPS_REQUIRED",
    summary: "string",
    risks: [
      {
        code: "string",
        severity: "low|medium|high|blocker",
        evidence: "string",
        required_fix: "string",
      },
    ],
    allowed_next_user_replies: ["Go", "Next", "Do it", "Done", "Proceed"],
    chatgpt_comment: "string",
    should_draft_back_to_chatgpt: true,
  };
}

function findCursorBoundaryIndex(messages: Array<{ role: ChatGptArtifactRole; hash: string; index: number }>, cursor: ChatGptArtifactCursor): number {
  const boundaryHash = cursor.lastGuardedAssistantHash ?? cursor.baselineAssistantHash;
  if (boundaryHash === null) {
    return -1;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.hash === boundaryHash) {
      return message.index;
    }
  }

  return -1;
}

function normalizeChatId(candidate: string | null): string | null {
  if (candidate === null) {
    return null;
  }

  const decoded = decodeURIComponent(candidate).trim();
  if (decoded.length < CHAT_ID_MIN_LENGTH || !CHAT_ID_PATTERN.test(decoded)) {
    return null;
  }

  return decoded;
}

function normalizeArtifactText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
