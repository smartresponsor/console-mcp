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
