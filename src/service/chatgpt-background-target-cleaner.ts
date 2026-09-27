import {
  closeChatGptConversationTarget,
  inspectChatGptTargetCloseSafety,
  inventoryChatGptTargets,
} from "./browser-session-executor.js";

export type ChatGptBackgroundTargetCleanupOptions = {
  ports?: number[];
  timeoutMs?: number;
  maxClose?: number;
  protectedTargetIds?: Iterable<string>;
};

type CompactTarget = {
  id?: unknown;
  chat_id?: unknown;
};

export async function cleanupIdleBackgroundChatGptTargets(input: ChatGptBackgroundTargetCleanupOptions = {}): Promise<Record<string, unknown>> {
  const maxClose = Math.min(Math.max(input.maxClose ?? 3, 1), 10);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 3000, 500), 10000);
  const protectedIds = new Set([...(input.protectedTargetIds ?? [])].map((value) => String(value).trim()).filter(Boolean));
  const inventory = await inventoryChatGptTargets({ ports: input.ports, timeoutMs });
  const targets = Array.isArray(inventory.chat_targets)
    ? inventory.chat_targets.filter((value): value is CompactTarget => typeof value === "object" && value !== null)
    : [];

  const inspected: Record<string, unknown>[] = [];
  const closed: Record<string, unknown>[] = [];
  for (const target of targets) {
    if (closed.length >= maxClose) break;
    const targetId = stringField(target, "id");
    const chatId = stringField(target, "chat_id");
    if (!targetId || !chatId) continue;
    if (protectedIds.has(targetId)) {
      inspected.push({ target_id: targetId, chat_id: chatId, status: "ENGINE_TARGET_PROTECTED", safe_to_close: false });
      continue;
    }

    const safety = await inspectChatGptTargetCloseSafety({ ports: input.ports, timeoutMs, targetId, chatId });
    inspected.push({ target_id: targetId, chat_id: chatId, status: safety.status ?? null, safe_to_close: safety.safe_to_close === true });
    if (safety.safe_to_close !== true) continue;

    const result = await closeChatGptConversationTarget({ ports: input.ports, targetId, chatId, timeoutMs });
    closed.push({
      target_id: targetId,
      chat_id: chatId,
      closed: result.closed === true || result.already_closed === true,
      status: result.status ?? null,
      conversation_deleted: false,
    });
  }

  return {
    ok: closed.every((item) => item.closed === true),
    status: "CHATGPT_BACKGROUND_TARGET_HYGIENE_COMPLETE",
    inspected_count: inspected.length,
    closed_count: closed.filter((item) => item.closed === true).length,
    max_close: maxClose,
    protected_target_count: protectedIds.size,
    inspected,
    closed,
    policy: {
      deletes_conversations: false,
      preserves_engine_owned_targets: true,
      preserves_focused_targets: true,
      preserves_unknown_or_nonempty_composer: true,
      preserves_busy_or_streaming_targets: true,
    },
  };
}

function stringField(value: CompactTarget, key: keyof CompactTarget): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}
