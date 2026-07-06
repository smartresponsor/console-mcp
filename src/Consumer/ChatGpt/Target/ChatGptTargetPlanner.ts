export type ChatGptTargetLike = {
  port: number;
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  chat_id: string | null;
  web_socket_debugger_url: string | null;
};

const CHAT_ID_MIN_LENGTH = 6;
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function classifyTargetSelectionSnapshot(targets: Array<Record<string, unknown>>, allowOverwrite = false): Record<string, unknown> {
  const clean = targets.filter((target) => {
    const url = asString(target.url);
    if (!url || !isChatGptRootUrl(url)) return false;
    if (target.type !== "page") return false;
    if (target.has_web_socket_debugger_url !== true && typeof target.web_socket_debugger_url !== "string") return false;
    if (allowOverwrite) return target.composer_found !== false;
    return target.composer_found !== false && target.composer_text_length === 0;
  });
  if (clean.length === 1) return { ok: true, status: "TARGET_SELECTED", selected_target: clean[0] };
  if (clean.length > 1) return { ok: false, status: "TARGET_SELECTION_AMBIGUOUS", selected_target_candidates: clean };
  return { ok: false, status: "TARGET_SELECTION_NOT_READY", selected_target_candidates: [] };
}

export function planRootTargetPrune(targets: Array<Record<string, unknown>>, keepTargetId?: string, confirmCleanup = false, dryRun = false): Record<string, unknown> {
  const allTargets = uniqueTargetRecords(targets);
  const rootTargets = allTargets.filter(isExactRootTargetRecord);
  if (rootTargets.length <= 1) {
    return {
      ok: true,
      status: "CHATGPT_ROOT_PRUNE_NOOP",
      dry_run: true,
      keep_target_id: keepTargetId ?? asString(rootTargets[0]?.id),
      selected_for_close: [],
      next_action: "chatgpt-session-warmth",
    };
  }
  if (!keepTargetId) {
    return {
      ok: false,
      status: "CHATGPT_ROOT_PRUNE_KEEP_TARGET_REQUIRED",
      dry_run: true,
      keep_target_id: null,
      selected_for_close: [],
      root_targets: rootTargets.map(compactTargetRecord),
      next_action: "rerun with -KeepTargetId",
    };
  }
  const keep = allTargets.find((target) => asString(target.id) === keepTargetId);
  if (!keep) {
    return {
      ok: false,
      status: "CHATGPT_ROOT_PRUNE_KEEP_TARGET_NOT_FOUND",
      dry_run: true,
      keep_target_id: keepTargetId,
      selected_for_close: [],
      root_targets: rootTargets.map(compactTargetRecord),
      next_action: "choose KeepTargetId from root_targets",
    };
  }
  const selected = rootTargets.filter((target) => asString(target.id) !== keepTargetId).map(compactTargetRecord);
  const shouldDryRun = dryRun || !confirmCleanup;
  return {
    ok: true,
    status: shouldDryRun ? "CHATGPT_ROOT_PRUNE_PLAN_READY" : "CHATGPT_ROOT_PRUNE_DONE",
    dry_run: shouldDryRun,
    keep_target_id: keepTargetId,
    selected_for_close: selected,
    root_targets: rootTargets.map(compactTargetRecord),
    next_action: shouldDryRun ? "rerun with -ConfirmCleanup to close selected root targets" : "chatgpt-session-warmth",
  };
}

export function compactChatGptTarget(target: ChatGptTargetLike): Record<string, unknown> {
  return {
    port: target.port,
    id: target.id ?? null,
    type: target.type ?? null,
    title: target.title ?? null,
    url: target.url ?? null,
    chat_id: target.chat_id ?? null,
    has_web_socket_debugger_url: Boolean(target.web_socket_debugger_url ?? target.webSocketDebuggerUrl),
  };
}

function isChatGptRootUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isChatGptUrl(rawUrl) && (url.pathname === "/" || url.pathname === "") && !extractChatGptChatId(rawUrl) && !isAuthLoginSettingsTarget(rawUrl);
  } catch {
    return false;
  }
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

function isAuthLoginSettingsTarget(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const text = `${url.pathname}${url.hash}`.toLowerCase();
    return text.includes("auth") || text.includes("login") || text.includes("settings") || text.includes("oauth");
  } catch {
    return false;
  }
}

function isExactRootTargetRecord(value: Record<string, unknown>): boolean {
  return value.type === "page"
    && asString(value.url) === "https://chatgpt.com/"
    && (value.chat_id === null || typeof value.chat_id === "undefined")
    && (typeof value.id === "string" && value.id.length > 0);
}

function compactTargetRecord(value: Record<string, unknown>): Record<string, unknown> {
  return {
    port: value.port ?? null,
    id: value.id ?? null,
    type: value.type ?? null,
    title: value.title ?? null,
    url: value.url ?? null,
    chat_id: value.chat_id ?? null,
    has_web_socket_debugger_url: value.has_web_socket_debugger_url ?? Boolean(value.web_socket_debugger_url ?? value.webSocketDebuggerUrl),
  };
}

function uniqueTargetRecords(targets: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const unique: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    const id = asString(target.id);
    const port = numberOrNull(target.port);
    const key = `${port ?? "null"}:${id ?? ""}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractChatGptChatId(rawUrl: string): string | null {
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

function normalizeChatId(candidate: string | null): string | null {
  if (candidate === null) return null;
  const decoded = decodeURIComponent(candidate).trim();
  if (decoded.length < CHAT_ID_MIN_LENGTH || !CHAT_ID_PATTERN.test(decoded)) return null;
  return decoded;
}
