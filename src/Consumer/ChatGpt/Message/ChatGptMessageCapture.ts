import type { BrowserSessionOptions, ChatGptTarget } from "../../../service/browser-session-executor.js";

type CaptureMessagesDependencies = {
  resolveTarget: (input: BrowserSessionOptions) => Promise<{ ok: boolean; status: string; target: ChatGptTarget | null; inventory_summary?: Record<string, unknown>; candidate_rejections?: unknown; selected_target_candidates?: unknown }>;
  safeEvaluateInTarget: (webSocketUrl: string, expression: string, timeoutMs: number, failureStatus: string) => Promise<unknown>;
  compactChatGptTarget: (target: ChatGptTarget) => Record<string, unknown>;
  normalizeTimeout: (value: unknown) => number;
};

export function createCaptureMessages(deps: CaptureMessagesDependencies) {
  return async function captureMessages(input: BrowserSessionOptions & { maxMessages?: number; requireChatId?: boolean } = {}): Promise<Record<string, unknown>> {
    const selected = await deps.resolveTarget(input);
    if (!selected.ok || !selected.target) return { ...selected, ok: false, messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
    const target = selected.target;
    if (input.requireChatId === true && target.chat_id === null) return { ok: false, status: "NEED_CHAT_ID", selected: deps.compactChatGptTarget(target), messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
    if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: deps.compactChatGptTarget(target), messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
    const raw = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildCaptureMessagesExpression(input.maxMessages ?? 50), Math.min(deps.normalizeTimeout(input.timeoutMs), 2000), "MESSAGE_CAPTURE_EVALUATION_FAILED");
    const record = asRecord(raw);
    return {
      ok: record.ok === true,
      status: record.ok === true ? "MESSAGES_CAPTURED" : String(record.status ?? "MESSAGE_CAPTURE_FAILED"),
      selected: deps.compactChatGptTarget(target),
      messages: Array.isArray(record.messages) ? record.messages : [],
      message_count: numberOrZero(record.message_count),
      user_message_count: numberOrZero(record.user_message_count),
      assistant_message_count: numberOrZero(record.assistant_message_count),
      href: record.href ?? target.url ?? null,
      title: record.title ?? target.title ?? null,
    };
  };
}

function buildCaptureMessagesExpression(maxMessages: number): string {
  return `(() => { const maxMessages = ${JSON.stringify(maxMessages)}; const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible).slice(-maxMessages); const messages = nodes.map((node, index) => ({ role: node.getAttribute('data-message-author-role') || 'unknown', text: String(node.innerText || node.textContent || '').trim().slice(0, 12000), index })); const user = messages.filter((message) => message.role === 'user'); const assistant = messages.filter((message) => message.role === 'assistant'); return { ok: true, status: 'MESSAGES_CAPTURED', messages, message_count: messages.length, user_message_count: user.length, assistant_message_count: assistant.length, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
