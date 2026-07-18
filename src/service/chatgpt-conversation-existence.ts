export type ChatGptConversationExistenceStatus =
  | "LIVE"
  | "DELETED_CONFIRMED"
  | "NOT_FOUND_UNCLASSIFIED"
  | "AUTH_BLOCKED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "PROBE_INCONCLUSIVE";

export type ChatGptConversationExistenceProbe = {
  ok: boolean;
  status: ChatGptConversationExistenceStatus;
  chat_id: string;
  http_status: number | null;
  body_preview: string | null;
  auth_session_http_status: number | null;
  auth_token_present: boolean;
  error: string | null;
};

export function classifyChatGptConversationExistence(input: {
  chatId: string;
  httpStatus: number | null;
  bodyPreview?: string | null;
  authSessionHttpStatus?: number | null;
  authTokenPresent?: boolean;
  error?: string | null;
}): ChatGptConversationExistenceProbe {
  const bodyPreview = input.bodyPreview ?? null;
  const error = input.error ?? null;
  const common = { chat_id: input.chatId, http_status: input.httpStatus, body_preview: bodyPreview, auth_session_http_status: input.authSessionHttpStatus ?? null, auth_token_present: input.authTokenPresent === true, error };
  if (error) return { ok: false, status: "NETWORK_ERROR", ...common };
  if (input.httpStatus !== null && input.httpStatus >= 200 && input.httpStatus < 300) return { ok: true, status: "LIVE", ...common };
  if (input.httpStatus === 404 && typeof bodyPreview === "string" && bodyPreview.includes("conversation_deleted")) return { ok: true, status: "DELETED_CONFIRMED", ...common };
  if (input.httpStatus === 404) return { ok: false, status: "NOT_FOUND_UNCLASSIFIED", ...common };
  if (input.httpStatus === 401 || input.httpStatus === 403) return { ok: false, status: "AUTH_BLOCKED", ...common };
  if (input.httpStatus === 429) return { ok: false, status: "RATE_LIMITED", ...common };
  if (input.httpStatus !== null && input.httpStatus >= 500) return { ok: false, status: "SERVER_ERROR", ...common };
  return { ok: false, status: "PROBE_INCONCLUSIVE", ...common };
}

export function buildChatGptConversationExistenceProbeExpression(chatId: string): string {
  const expectedChatId = JSON.stringify(chatId);
  return `(async () => { const expectedChatId = ${expectedChatId}; const fetchWithTimeout = async (url, init) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000); try { return await fetch(url, { ...init, signal: controller.signal }); } catch (error) { return { ok: false, status: 0, statusText: String(error), text: async () => String(error).slice(0, 300), headers: { get: () => null }, probeError: String(error) }; } finally { clearTimeout(timer); } }; const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const headers = accessToken ? { Authorization: 'Bearer ' + accessToken } : {}; const response = await fetchWithTimeout('/backend-api/conversation/' + encodeURIComponent(expectedChatId), { method: 'GET', credentials: 'include', headers }); const bodyPreview = response && !response.ok && response.text ? await response.text().then((text) => text.slice(0, 300)).catch(() => null) : null; return { ok: true, chat_id: expectedChatId, http_status: response?.status ?? null, body_preview: bodyPreview, auth_session_http_status: sessionResponse?.status ?? null, auth_token_present: Boolean(accessToken), error: response?.probeError ?? null }; })()`;
}
