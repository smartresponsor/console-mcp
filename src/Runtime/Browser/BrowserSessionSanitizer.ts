const REDACTED_OUTPUT = "[redacted]";
const SENSITIVE_OUTPUT_KEY = /^(accessToken|sessionToken|id_token|refresh_token|authorization|cookie|set-cookie)$/i;
const DEVTOOLS_OUTPUT_URL_KEY = /^(webSocketDebuggerUrl|web_socket_debugger_url|devtoolsFrontendUrl|devtools_frontend_url)$/i;
const DOM_OUTPUT_KEY = /^(domSnapshot|dom_snapshot|rawDom|raw_dom|outerHTML|innerHTML|documentHTML|document_html)$/i;
const CHAT_ID_MIN_LENGTH = 6;
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function sanitizeForOutput(value: unknown): unknown {
  return sanitizeForOutputInner(value, [], null);
}

function sanitizeForOutputInner(value: unknown, ancestors: object[], key: string | null): unknown {
  if (typeof value === "string") {
    if (key && (SENSITIVE_OUTPUT_KEY.test(key) || DEVTOOLS_OUTPUT_URL_KEY.test(key))) return REDACTED_OUTPUT;
    if (value.includes("client-bootstrap")) return REDACTED_OUTPUT;
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.includes(value)) return "[circular]";
  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => sanitizeForOutputInner(item, nextAncestors, null));

  const record = value as Record<string, unknown>;
  if (isTargetLikeRecord(record)) return compactOutputTarget(record);
  if (isCdpCommandRecord(record)) return compactCdpCommandResult(record);

  const output: Record<string, unknown> = {};
  const nodeName = asString(record.nodeName)?.toUpperCase();
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (SENSITIVE_OUTPUT_KEY.test(entryKey) || DEVTOOLS_OUTPUT_URL_KEY.test(entryKey)) {
      output[entryKey] = REDACTED_OUTPUT;
    } else if (DOM_OUTPUT_KEY.test(entryKey) || (nodeName === "SCRIPT" && entryKey === "nodeValue")) {
      output[entryKey] = REDACTED_OUTPUT;
    } else {
      output[entryKey] = sanitizeForOutputInner(entryValue, nextAncestors, entryKey);
    }
  }
  return output;
}

function isTargetLikeRecord(value: Record<string, unknown>): boolean {
  return (typeof value.id === "string" || typeof value.targetId === "string")
    && (typeof value.type === "string" || typeof value.url === "string")
    && ("webSocketDebuggerUrl" in value || "web_socket_debugger_url" in value || "devtoolsFrontendUrl" in value || "devtools_frontend_url" in value || "chat_id" in value);
}

function compactOutputTarget(value: Record<string, unknown>): Record<string, unknown> {
  const rawUrl = asString(value.url);
  return {
    port: numberOrNull(value.port),
    id: asString(value.id) ?? asString(value.targetId),
    type: asString(value.type),
    title: asString(value.title),
    url: rawUrl,
    chat_id: asString(value.chat_id) ?? (rawUrl ? extractChatGptChatId(rawUrl) : null),
    has_web_socket_debugger_url: value.has_web_socket_debugger_url === true || Boolean(value.webSocketDebuggerUrl ?? value.web_socket_debugger_url ?? value.devtoolsFrontendUrl ?? value.devtools_frontend_url),
  };
}

function isCdpCommandRecord(value: Record<string, unknown>): boolean {
  return typeof value.method === "string" && ("result" in value || "error" in value || typeof value.status === "string");
}

function compactCdpCommandResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(value.result);
  const output: Record<string, unknown> = {
    ok: value.ok === true,
    status: asString(value.status),
    method: asString(value.method),
    error: typeof value.error === "undefined" ? null : sanitizeForOutputInner(value.error, [], "error"),
    recoverable: value.recoverable === true,
  };
  const nodeId = numberOrNull(result.nodeId ?? result.node_id);
  const backendNodeId = numberOrNull(result.backendNodeId ?? result.backend_node_id);
  const searchId = asString(result.searchId ?? result.search_id);
  const resultCount = numberOrNull(result.resultCount ?? result.result_count);
  const nodeIds = Array.isArray(result.nodeIds) ? result.nodeIds.map(numberOrNull).filter((item): item is number => item !== null) : null;
  if (nodeId !== null) output.node_id = nodeId;
  if (backendNodeId !== null) output.backend_node_id = backendNodeId;
  if (nodeIds && nodeIds.length > 0) output.node_ids = nodeIds;
  if (searchId !== null) output.search_id = searchId;
  if (resultCount !== null) output.result_count = resultCount;
  for (const source of [value, result]) {
    for (const [entryKey, entryValue] of Object.entries(source)) {
      if (/(_count|Count)$/.test(entryKey) && numberOrNull(entryValue) !== null) output[toSnakeCase(entryKey)] = numberOrNull(entryValue);
    }
  }
  copyDiagnosticField(output, value, result, "target_id");
  copyDiagnosticField(output, value, result, "selectors");
  copyDiagnosticField(output, value, result, "selector");
  copyDiagnosticField(output, value, result, "retryable");
  copyDiagnosticField(output, value, result, "next_action");
  return output;
}

function copyDiagnosticField(output: Record<string, unknown>, value: Record<string, unknown>, result: Record<string, unknown>, key: string): void {
  const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const candidate = value[key] ?? value[camel] ?? result[key] ?? result[camel];
  if (typeof candidate !== "undefined") output[key] = sanitizeForOutputInner(candidate, [], key);
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
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
