import type { BrowserSessionOptions, ChatGptTarget } from "../../../service/browser-session-executor.js";

type RenameDependencies = {
  defaultChatGptPorts: (ports?: number[]) => number[];
  findDevToolsTargetById: (ports: number[], targetId: string, timeoutMs: number) => Promise<ChatGptTarget | null>;
  inventoryChatGptTargets: (input: BrowserSessionOptions) => Promise<Record<string, unknown>>;
  isChatGptRootUrl: (rawUrl: string) => boolean;
  safeEvaluateInTarget: (webSocketUrl: string, expression: string, timeoutMs: number, failureStatus: string) => Promise<unknown>;
  safeSendDevToolsCommand: (webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, failureStatus: string) => Promise<Record<string, unknown>>;
  traceNetworkInTarget: (webSocketUrl: string, durationMs: number, timeoutMs: number) => Promise<Record<string, unknown>>;
  compactChatGptTarget: (target: ChatGptTarget) => Record<string, unknown>;
  summarizeInventory: (inventory: Record<string, unknown>) => Record<string, unknown>;
  normalizeTimeout: (value: unknown) => number;
  delay: (ms: number) => Promise<void>;
};

export function createChatGptConversationRename(deps: RenameDependencies) {
  async function traceChatGptRenameNetwork(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
    const timeoutMs = deps.normalizeTimeout(input.timeoutMs);
    const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? Math.min(Math.max(Math.trunc(input.durationMs), 1000), 120000) : 30000;
    const inventory = await deps.inventoryChatGptTargets(input);
    const records = uniqueTargetRecords([...asArrayRecords(inventory.chat_targets), ...asArrayRecords(inventory.targets), ...asArrayRecords(inventory.auth_login_settings_targets)]);
    const selectedRecord = input.targetId ? records.find((target) => asString(target.id) === input.targetId) : (input.chatId ? records.find((target) => asString(target.chat_id) === input.chatId) : records.find((target) => Boolean(asString(target.chat_id))));
    const traceRecords = input.targetId || input.chatId ? (selectedRecord ? [selectedRecord] : []) : records;
    if (traceRecords.length === 0) return { ok: false, status: "CHATGPT_RENAME_TRACE_TARGET_NOT_READY", inventory_summary: deps.summarizeInventory(inventory) };
    const targets = (await Promise.all(traceRecords.map(async (record) => {
      const id = asString(record.id);
      if (!id) return null;
      return await deps.findDevToolsTargetById(deps.defaultChatGptPorts(input.ports), id, timeoutMs);
    }))).filter(isChatGptTarget).filter((target) => Boolean(target.web_socket_debugger_url));
    if (targets.length === 0) return { ok: false, status: "CHATGPT_RENAME_TRACE_WEBSOCKET_MISSING", selected_record: selectedRecord ?? null, inventory_summary: deps.summarizeInventory(inventory), trace_target_count: 0 };
    const traces = await Promise.all(targets.map(async (target) => ({ target: deps.compactChatGptTarget(target), trace: await deps.traceNetworkInTarget(target.web_socket_debugger_url ?? "", durationMs, timeoutMs) })));
    const eventCount = traces.reduce((sum, item) => sum + numberOrZero(asRecord(item.trace).event_count), 0);
    const rawEventCount = traces.reduce((sum, item) => sum + numberOrZero(asRecord(item.trace).raw_event_count), 0);
    return { ok: true, status: "CHATGPT_RENAME_NETWORK_TRACE_DONE", selected: selectedRecord ?? null, duration_ms: durationMs, inventory_summary: deps.summarizeInventory(inventory), trace_target_count: targets.length, event_count: eventCount, raw_event_count: rawEventCount, traces };
  }

  async function renameLatestConversation(input: BrowserSessionOptions & { title: string }): Promise<Record<string, unknown>> {
    const timeoutMs = deps.normalizeTimeout(input.timeoutMs);
    const desiredTitle = String(input.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!desiredTitle) return { ok: false, status: "CHATGPT_RENAME_TITLE_REQUIRED" };
    const inventory = await deps.inventoryChatGptTargets(input);
    const records = uniqueTargetRecords([
      ...asArrayRecords(inventory.chat_targets),
      ...asArrayRecords(inventory.root_targets),
      ...asArrayRecords(inventory.targets),
      ...asArrayRecords(inventory.empty_home_targets),
    ]);
    const selectedRecord = records.find((target) => Boolean(asString(target.chat_id))) ?? records.find((target) => deps.isChatGptRootUrl(asString(target.url) ?? "")) ?? records[0] ?? null;
    const selectedId = asString(selectedRecord?.id);
    if (!selectedId) return { ok: false, status: "CHATGPT_RENAME_TARGET_NOT_READY", inventory_summary: deps.summarizeInventory(inventory) };
    const selected = await deps.findDevToolsTargetById(deps.defaultChatGptPorts(input.ports), selectedId, timeoutMs);
    if (!selected) return { ok: false, status: "CHATGPT_RENAME_TARGET_NOT_FOUND", selected_record: selectedRecord, inventory_summary: deps.summarizeInventory(inventory) };
    if (!selected.web_socket_debugger_url) return { ok: false, status: "CHATGPT_RENAME_TARGET_WEBSOCKET_MISSING", selected: deps.compactChatGptTarget(selected), inventory_summary: deps.summarizeInventory(inventory) };
    const result = await deps.safeEvaluateInTarget(selected.web_socket_debugger_url, buildRenameLatestConversationExpression(desiredTitle, asString((selected as unknown as Record<string, unknown>).chat_id)), Math.max(timeoutMs, 60000), "CHATGPT_RENAME_EVALUATION_FAILED");
    const record = asRecord(result);
    const patchConfirmation = record.ok === true ? await confirmChatGptRenamePatch(selected, desiredTitle, Math.min(Math.max(timeoutMs, 3000), 10000)) : null;
    const confirmation = record.ok === true ? await confirmChatGptTitle(selected, desiredTitle, Math.min(Math.max(timeoutMs, 3000), 10000)) : null;
    const backendConfirmation = record.ok === true ? await confirmChatGptBackendTitle(selected, desiredTitle, Math.min(Math.max(timeoutMs, 3000), 10000)) : null;
    const refreshConfirmation = record.ok === true ? await refreshChatGptTitleState(selected, desiredTitle, Math.min(Math.max(timeoutMs, 3000), 15000)) : null;
    const confirmationRecord = asRecord(confirmation);
    const backendRecord = asRecord(backendConfirmation);
    const patchRecord = asRecord(patchConfirmation);
    const refreshRecord = asRecord(refreshConfirmation);
    const refreshAfterRecord = asRecord(refreshRecord.after_confirmation);
    const exactBeforeFallback = confirmationRecord.status === "CHAT_TITLE_CONFIRMED_EXACT" || backendRecord.status === "CHAT_BACKEND_TITLE_CONFIRMED" || refreshAfterRecord.status === "CHAT_TITLE_CONFIRMED_EXACT";
    const uiFallback = record.ok === true && !exactBeforeFallback ? await attemptChatGptSidebarUiRename(selected, desiredTitle, Math.min(Math.max(timeoutMs, 5000), 20000)) : null;
    const uiFallbackRecord = asRecord(uiFallback);
    const uiFallbackRefreshRecord = asRecord(uiFallbackRecord.refresh_confirmation);
    const uiFallbackAfterRecord = asRecord(uiFallbackRefreshRecord.after_confirmation);
    const exactConfirmed = exactBeforeFallback || uiFallbackAfterRecord.status === "CHAT_TITLE_CONFIRMED_EXACT";
    const visibleOnly = confirmationRecord.status === "CHAT_TITLE_CONFIRMED_VISIBLE" || refreshAfterRecord.status === "CHAT_TITLE_CONFIRMED_VISIBLE" || uiFallbackAfterRecord.status === "CHAT_TITLE_CONFIRMED_VISIBLE";
    const patchUnconfirmed = patchRecord.status === "CHAT_TITLE_RENAME_PATCH_FAILED" || patchRecord.status === "CHAT_TITLE_RENAME_PATCH_ABORTED" || patchRecord.status === "CHAT_TITLE_RENAME_PATCH_ERROR";
    const refreshSyncedDifferent = refreshRecord.status === "CHAT_TITLE_REFRESH_SYNCED_DIFFERENT_CANONICAL_TITLE" || uiFallbackRefreshRecord.status === "CHAT_TITLE_REFRESH_SYNCED_DIFFERENT_CANONICAL_TITLE";
    const refreshAttempted = refreshRecord.status === "CHAT_TITLE_REFRESH_SYNC_DONE" || refreshRecord.status === "CHAT_TITLE_REFRESH_SYNC_NOT_CONFIRMED" || refreshSyncedDifferent;
    const uiFallbackAttempted = uiFallbackRecord.status === "CHAT_TITLE_UI_RENAME_CONFIRMED" || uiFallbackRecord.status === "CHAT_TITLE_UI_RENAME_NOT_CONFIRMED";
    return { ok: exactConfirmed, status: exactConfirmed ? "CHATGPT_RENAME_CONFIRMED" : (refreshSyncedDifferent ? "CHATGPT_RENAME_SYNCED_DIFFERENT_CANONICAL_TITLE" : (patchUnconfirmed ? (uiFallbackAttempted ? "CHATGPT_RENAME_PATCH_UNCONFIRMED_AFTER_UI_FALLBACK" : (refreshAttempted ? "CHATGPT_RENAME_PATCH_UNCONFIRMED_AFTER_REFRESH" : "CHATGPT_RENAME_PATCH_UNCONFIRMED")) : (visibleOnly ? "CHATGPT_RENAME_VISIBLE_ONLY" : (record.ok === true ? "CHATGPT_RENAME_UNCONFIRMED" : "CHATGPT_RENAME_FAILED")))), desired_title: desiredTitle, selected: deps.compactChatGptTarget(selected), inventory_summary: deps.summarizeInventory(inventory), rename: result, patch_confirmation: patchConfirmation, confirmation, backend_confirmation: backendConfirmation, refresh_confirmation: refreshConfirmation, ui_fallback: uiFallback };
  }

  async function confirmChatGptRenamePatch(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_RENAME_PATCH_WEBSOCKET_MISSING" };
    const chatId = target.chat_id;
    if (!chatId) return { ok: false, status: "CHAT_TITLE_RENAME_PATCH_CHAT_ID_MISSING" };
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10000);
    let last: Record<string, unknown> | null = null;
    while (Date.now() <= deadline) {
      const value = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildRenamePatchStateExpression(chatId, desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_RENAME_PATCH_EVALUATION_FAILED");
      last = asRecord(value);
      if (last.status === "CHAT_TITLE_RENAME_PATCH_SUCCEEDED" || last.status === "CHAT_TITLE_RENAME_PATCH_FAILED" || last.status === "CHAT_TITLE_RENAME_PATCH_ABORTED" || last.status === "CHAT_TITLE_RENAME_PATCH_ERROR") return last;
      await deps.delay(250);
    }
    return last ?? { ok: false, status: "CHAT_TITLE_RENAME_PATCH_TIMEOUT", chat_id: chatId, desired_title: desiredTitle };
  }

  async function refreshChatGptTitleState(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_REFRESH_SYNC_WEBSOCKET_MISSING" };
    const before = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildTitleConfirmationExpression(desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_REFRESH_BEFORE_EVALUATION_FAILED");
    const reload = await deps.safeSendDevToolsCommand(target.web_socket_debugger_url, "Page.reload", { ignoreCache: true }, Math.min(Math.max(timeoutMs, 3000), 10000), "CHAT_TITLE_REFRESH_RELOAD_FAILED");
    await deps.delay(1500);
    const after = await confirmChatGptTitle(target, desiredTitle, Math.min(Math.max(timeoutMs, 3000), 15000));
    const beforeRecord = asRecord(before);
    const afterRecord = asRecord(after);
    const beforeTitle = extractCanonicalConfirmedTitle(beforeRecord, desiredTitle);
    const afterTitle = extractCanonicalConfirmedTitle(afterRecord, desiredTitle);
    const confirmed = afterRecord.status === "CHAT_TITLE_CONFIRMED_EXACT";
    const canonicalTitleChanged = Boolean(beforeTitle && afterTitle && beforeTitle !== afterTitle);
    const syncedDifferentCanonicalTitle = !confirmed && canonicalTitleChanged;
    return { ok: confirmed, status: confirmed ? "CHAT_TITLE_REFRESH_SYNC_DONE" : (syncedDifferentCanonicalTitle ? "CHAT_TITLE_REFRESH_SYNCED_DIFFERENT_CANONICAL_TITLE" : "CHAT_TITLE_REFRESH_SYNC_NOT_CONFIRMED"), canonical_title_before: beforeTitle, canonical_title_after: afterTitle, canonical_title_changed: canonicalTitleChanged, before_confirmation: before, reload, after_confirmation: after };
  }

  async function attemptChatGptSidebarUiRename(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_UI_RENAME_WEBSOCKET_MISSING" };
    const chatId = target.chat_id;
    if (!chatId) return { ok: false, status: "CHAT_TITLE_UI_RENAME_CHAT_ID_MISSING" };
    const attempt = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildSidebarUiRenameExpression(chatId, desiredTitle), 1500, "CHAT_TITLE_UI_RENAME_START_EVALUATION_FAILED");
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 5000), 15000);
    let uiState: Record<string, unknown> | null = null;
    while (Date.now() <= deadline) {
      const value = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildSidebarUiRenameStateExpression(chatId, desiredTitle), 1000, "CHAT_TITLE_UI_RENAME_STATE_EVALUATION_FAILED");
      uiState = asRecord(value);
      if (String(uiState.status ?? "").startsWith("CHAT_TITLE_UI_RENAME_FINISHED") || String(uiState.status ?? "").startsWith("CHAT_TITLE_UI_RENAME_FAILED")) break;
      await deps.delay(300);
    }
    await deps.delay(1000);
    const refreshConfirmation = await refreshChatGptTitleState(target, desiredTitle, Math.min(Math.max(timeoutMs, 5000), 20000));
    const refreshAfterRecord = asRecord(asRecord(refreshConfirmation).after_confirmation);
    const confirmed = refreshAfterRecord.status === "CHAT_TITLE_CONFIRMED_EXACT";
    return { ok: confirmed, status: confirmed ? "CHAT_TITLE_UI_RENAME_CONFIRMED" : "CHAT_TITLE_UI_RENAME_NOT_CONFIRMED", chat_id: chatId, desired_title: desiredTitle, attempt, ui_state: uiState, refresh_confirmation: refreshConfirmation };
  }

  async function confirmChatGptBackendTitle(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_BACKEND_CONFIRM_WEBSOCKET_MISSING" };
    const chatId = target.chat_id;
    if (!chatId) return { ok: false, status: "CHAT_BACKEND_CONFIRM_CHAT_ID_MISSING" };
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10000);
    let last: Record<string, unknown> | null = null;
    while (Date.now() <= deadline) {
      const value = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildBackendTitleConfirmationExpression(chatId, desiredTitle), Math.min(Math.max(timeoutMs, 3000), 5000), "CHAT_BACKEND_CONFIRM_EVALUATION_FAILED");
      last = asRecord(value);
      if (last.ok === true) return last;
      await deps.delay(500);
    }
    return last ?? { ok: false, status: "CHAT_BACKEND_CONFIRM_TIMEOUT", chat_id: chatId, desired_title: desiredTitle };
  }

  async function confirmChatGptTitle(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_CONFIRM_WEBSOCKET_MISSING" };
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10000);
    let last: Record<string, unknown> | null = null;
    while (Date.now() <= deadline) {
      const value = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, buildTitleConfirmationExpression(desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_CONFIRM_EVALUATION_FAILED");
      const record = asRecord(value);
      last = record;
      if (record.ok === true) return record;
      await deps.delay(250);
    }
    return last ?? { ok: false, status: "CHAT_TITLE_CONFIRM_TIMEOUT", desired_title: desiredTitle };
  }

  return { traceChatGptRenameNetwork, renameLatestConversation };
}

function buildRenameLatestConversationExpression(title: string, knownChatId?: string | null): string {
  const desiredTitle = JSON.stringify(title);
  const directChatId = JSON.stringify(knownChatId ?? "");
  return `(async () => { const desiredTitle = ${desiredTitle}; const directChatId = ${directChatId}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const extractChatId = (href) => { try { const url = new URL(href, location.origin); const parts = url.pathname.split('/').filter(Boolean); for (let index = 0; index < parts.length - 1; index += 1) { if (parts[index] === 'c' || parts[index] === 'chat') return parts[index + 1] || null; } return null; } catch { return null; } }; const fetchWithTimeout = async (url, init) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000); try { return await fetch(url, { ...init, signal: controller.signal }); } catch (error) { return { ok: false, status: 0, statusText: String(error), json: async () => null, text: async () => String(error).slice(0, 300), headers: { get: () => null } }; } finally { clearTimeout(timer); } }; if (directChatId) { const key = directChatId + '::' + desiredTitle; const root = window.__chatgptLifecycleRenamePatch || (window.__chatgptLifecycleRenamePatch = {}); root[key] = { ok: false, status: 'CHAT_TITLE_RENAME_PATCH_STARTED', chat_id: directChatId, desired_title: desiredTitle, started_at: Date.now(), href: location.href, title: document.title }; const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const renameHeaders = accessToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken } : { 'Content-Type': 'application/json' }; const controller = new AbortController(); const abortTimer = setTimeout(() => { try { controller.abort(); } catch (_) {} root[key] = { ok: false, status: 'CHAT_TITLE_RENAME_PATCH_ABORTED', chat_id: directChatId, desired_title: desiredTitle, started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now(), href: location.href, title: document.title }; }, 4000); fetch('/backend-api/conversation/' + encodeURIComponent(directChatId), { method: 'PATCH', credentials: 'include', signal: controller.signal, headers: renameHeaders, body: JSON.stringify({ title: desiredTitle }) }).then(async (response) => { clearTimeout(abortTimer); const text = await response.text().catch(() => ''); if (response.ok) document.title = desiredTitle + ' | ChatGPT'; root[key] = { ok: response.ok, status: response.ok ? 'CHAT_TITLE_RENAME_PATCH_SUCCEEDED' : 'CHAT_TITLE_RENAME_PATCH_FAILED', chat_id: directChatId, desired_title: desiredTitle, http_status: response.status, http_status_text: response.statusText, body_preview: text.slice(0, 300), started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now(), href: location.href, title: document.title }; }).catch((error) => { clearTimeout(abortTimer); root[key] = { ok: false, status: error && error.name === 'AbortError' ? 'CHAT_TITLE_RENAME_PATCH_ABORTED' : 'CHAT_TITLE_RENAME_PATCH_ERROR', chat_id: directChatId, desired_title: desiredTitle, error: String(error && error.message || error), started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now(), href: location.href, title: document.title }; }); return { ok: true, status: 'CHAT_TITLE_RENAME_REQUEST_STARTED', chat_id: directChatId, selected_source: 'selected_target_chat_id', desired_title: desiredTitle, patch_state_key: key, href: location.href, title: document.title }; } const sessionResponse = await fetchWithTimeout('/api/auth/session', { credentials: 'include' }); const session = sessionResponse && sessionResponse.ok ? await sessionResponse.json().catch(() => null) : null; const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : (typeof session?.access_token === 'string' ? session.access_token : null); const headers = accessToken ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken } : { 'Content-Type': 'application/json' }; const currentChatId = extractChatId(location.href); const linkIds = Array.from(document.querySelectorAll('a[href*="/c/"], a[href*="/chat/"]')).map((node) => extractChatId(node.getAttribute('href') || '')).filter(Boolean); const candidateIds = []; if (currentChatId) candidateIds.push({ id: currentChatId, source: 'location' }); for (const id of linkIds) { if (!candidateIds.some((item) => item.id === id)) candidateIds.push({ id, source: 'sidebar_link' }); } const listResponse = await fetchWithTimeout('/backend-api/conversations?offset=0&limit=20&order=updated', { method: 'GET', credentials: 'include', headers }); const listJson = listResponse && listResponse.ok ? await listResponse.json().catch(() => null) : null; const pushConversation = (value, source) => { if (!value || typeof value !== 'object') return; const id = value.id || value.conversation_id || value.conversationId || value.uuid; if (typeof id === 'string' && id.length > 8 && !candidateIds.some((item) => item.id === id)) candidateIds.push({ id, source, title: clean(value.title || value.name || '') || null, update_time: value.update_time || value.updated_at || value.create_time || null }); }; const walk = (value) => { if (Array.isArray(value)) { for (const item of value) walk(item); return; } if (!value || typeof value !== 'object') return; pushConversation(value, 'conversation_list'); for (const key of ['items', 'conversations', 'data']) walk(value[key]); }; walk(listJson); const selected = candidateIds[0] || null; if (!selected) return { ok: false, status: 'CHAT_RENAME_CHAT_ID_NOT_RESOLVED', desired_title: desiredTitle, auth_session_http_status: sessionResponse?.status ?? null, conversation_list_http_status: listResponse?.status ?? null, href: location.href, title: document.title }; const conversationPath = '/backend-api/conversation/' + encodeURIComponent(selected.id); const before = await fetchWithTimeout(conversationPath, { method: 'GET', credentials: 'include', headers }); const beforeJson = before && before.ok ? await before.json().catch(() => null) : null; const beforePreview = before && !before.ok && before.text ? await before.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const response = await fetchWithTimeout(conversationPath, { method: 'PATCH', credentials: 'include', headers, body: JSON.stringify({ title: desiredTitle }) }); const responsePreview = response && !response.ok && response.text ? await response.text().then((text) => text.slice(0, 300)).catch(() => null) : null; const ok = Boolean(response && response.ok); if (ok) document.title = desiredTitle + ' | ChatGPT'; return { ok, status: ok ? 'CHAT_TITLE_RENAMED' : 'CHAT_TITLE_RENAME_REQUEST_FAILED', chat_id: selected.id, selected_source: selected.source, current_title: clean(beforeJson?.title || selected.title || ''), desired_title: desiredTitle, http_status: response?.status ?? null, http_status_text: response?.statusText ?? null, response_body_preview: responsePreview, auth_session_http_status: sessionResponse?.status ?? null, auth_token_present: Boolean(accessToken), conversation_get_http_status: before?.status ?? null, conversation_get_body_preview: beforePreview, conversation_list_http_status: listResponse?.status ?? null, candidate_count: candidateIds.length, href: location.href, title: document.title }; })()`;
}

function buildRenamePatchStateExpression(chatId: string, title: string): string {
  const safeChatId = JSON.stringify(chatId);
  const desiredTitle = JSON.stringify(title);
  return `(() => { const chatId = ${safeChatId}; const desiredTitle = ${desiredTitle}; const key = chatId + '::' + desiredTitle; const root = window.__chatgptLifecycleRenamePatch || {}; const state = root[key] || null; if (state && !state.checked_at && (Date.now() - Number(state.started_at || 0)) > 4500) { root[key] = Object.assign({}, state, { ok: false, status: 'CHAT_TITLE_RENAME_PATCH_ABORTED', checked_at: Date.now() }); return root[key]; } return Object.assign({ ok: false, status: 'CHAT_TITLE_RENAME_PATCH_PENDING', chat_id: chatId, desired_title: desiredTitle }, state || {}); })()`;
}

function buildBackendTitleConfirmationExpression(chatId: string, title: string): string {
  const safeChatId = JSON.stringify(chatId);
  const desiredTitle = JSON.stringify(title);
  return `(() => { const chatId = ${safeChatId}; const desiredTitle = ${desiredTitle}; const key = chatId + '::' + desiredTitle; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const root = window.__chatgptLifecycleBackendConfirm || (window.__chatgptLifecycleBackendConfirm = {}); const current = root[key]; if (!current || (Date.now() - Number(current.started_at || 0)) > 10000) { root[key] = { ok: false, status: 'CHAT_BACKEND_TITLE_PENDING', chat_id: chatId, desired_title: desiredTitle, backend_title: null, started_at: Date.now() }; const controller = new AbortController(); const abortTimer = setTimeout(() => { try { controller.abort(); } catch (_) {} root[key] = { ok: false, status: 'CHAT_BACKEND_CONFIRM_ABORTED', chat_id: chatId, desired_title: desiredTitle, backend_title: null, started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now() }; }, 2500); fetch('/backend-api/conversation/' + encodeURIComponent(chatId), { method: 'GET', credentials: 'include', signal: controller.signal, headers: { accept: 'application/json, text/plain, */*' } }).then(async (response) => { clearTimeout(abortTimer); const text = await response.text(); const contentType = response.headers.get('content-type') || ''; const isJson = contentType.toLowerCase().includes('json') || text.trim().startsWith('{') || text.trim().startsWith('['); let json = {}; if (isJson && text) json = JSON.parse(text); const backendTitle = clean(json && (json.title || (json.conversation && json.conversation.title))); root[key] = { ok: response.ok && backendTitle === desiredTitle, status: response.ok && backendTitle === desiredTitle ? 'CHAT_BACKEND_TITLE_CONFIRMED' : 'CHAT_BACKEND_TITLE_PENDING', chat_id: chatId, desired_title: desiredTitle, backend_title: backendTitle || null, http_status: response.status, http_status_text: response.statusText, content_type: contentType, body_preview: backendTitle ? null : text.slice(0, 300), started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now() }; }).catch((error) => { clearTimeout(abortTimer); root[key] = { ok: false, status: error && error.name === 'AbortError' ? 'CHAT_BACKEND_CONFIRM_ABORTED' : 'CHAT_BACKEND_CONFIRM_REQUEST_FAILED', chat_id: chatId, desired_title: desiredTitle, backend_title: null, error: String(error && error.message || error), started_at: root[key] && root[key].started_at || Date.now(), checked_at: Date.now() }; }); } const state = root[key]; if (state && !state.checked_at && (Date.now() - Number(state.started_at || 0)) > 2500) { root[key] = Object.assign({}, state, { ok: false, status: 'CHAT_BACKEND_CONFIRM_ABORTED', backend_title: state.backend_title || null, checked_at: Date.now() }); } return Object.assign({ ok: false, status: 'CHAT_BACKEND_TITLE_PENDING', chat_id: chatId, desired_title: desiredTitle }, root[key] || {}); })()`;
}

function buildSidebarUiRenameExpression(chatId: string, title: string): string {
  const safeChatId = JSON.stringify(chatId);
  const desiredTitle = JSON.stringify(title);
  return `(() => { const chatId = ${safeChatId}; const desiredTitle = ${desiredTitle}; const key = chatId + '::' + desiredTitle; const root = window.__chatgptLifecycleUiRename || (window.__chatgptLifecycleUiRename = {}); const write = (value) => { root[key] = Object.assign({ chat_id: chatId, desired_title: desiredTitle, href: location.href, title: document.title, checked_at: Date.now() }, value); }; write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_STARTED', started_at: Date.now() }); setTimeout(() => { (async () => { const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const setValue = (node, value) => { node.focus && node.focus(); if (node instanceof HTMLInputElement && node.type === 'file') return false; if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) { const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const descriptor = Object.getOwnPropertyDescriptor(proto, 'value'); if (descriptor && descriptor.set) descriptor.set.call(node, value); else node.value = value; node.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value })); node.dispatchEvent(new Event('change', { bubbles: true, cancelable: true })); return true; } if (node.getAttribute && node.getAttribute('contenteditable') === 'true') { node.textContent = value; node.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value })); return true; } return false; }; const anchor = Array.from(document.querySelectorAll('a[href*=\"/c/\"], a[href*=\"/chat/\"]')).find((node) => String(node.href || node.getAttribute('href') || '').includes(chatId)); if (!anchor) return write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_FAILED_ANCHOR_NOT_FOUND' }); let row = anchor; for (let index = 0; index < 8 && row.parentElement; index += 1) { row = row.parentElement; if (Array.from(row.querySelectorAll('button')).filter(visible).length > 0) break; } anchor.scrollIntoView({ block: 'center' }); const rowButtons = Array.from(row.querySelectorAll('button')).filter(visible); const menuButton = rowButtons.find((node) => /more|menu|options|actions|open/i.test(String(node.getAttribute('aria-label') || node.getAttribute('title') || node.dataset?.testid || ''))) || rowButtons[rowButtons.length - 1] || null; if (!menuButton) return write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_FAILED_MENU_NOT_FOUND', row_text: clean(row.innerText || row.textContent).slice(0, 300) }); menuButton.click(); write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_MENU_OPENED' }); await delay(700); const menuItems = Array.from(document.querySelectorAll('[role=\"menuitem\"], button, [data-radix-collection-item], [cmdk-item], [role=\"option\"]')).filter(visible); const renameItem = menuItems.find((node) => /rename|edit name|edit title/i.test(clean(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''))); if (!renameItem) return write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_FAILED_ACTION_NOT_FOUND', menu_text_sample: menuItems.map((node) => clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '')).filter(Boolean).slice(0, 20) }); renameItem.click(); write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_EDITOR_OPENING' }); await delay(900); const editors = Array.from(document.querySelectorAll('input:not([type=\"file\"]), textarea, [contenteditable=\"true\"]')).filter(visible); const active = document.activeElement && visible(document.activeElement) ? document.activeElement : null; const editor = (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.getAttribute('contenteditable') === 'true') ? active : null) || editors.find((node) => node.closest('[role=\"dialog\"], [role=\"menu\"], [data-radix-popper-content-wrapper]')) || editors[editors.length - 1] || null; if (!editor) return write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_FAILED_EDITOR_NOT_FOUND', editor_count: editors.length }); const applied = setValue(editor, desiredTitle); write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_INPUT_APPLIED', input_applied: applied }); await delay(400); const confirmButtons = Array.from(document.querySelectorAll('button, [role=\"button\"]')).filter(visible); const confirmButton = confirmButtons.find((node) => /save|done|rename|confirm|ok/i.test(clean(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '')) && !/cancel/i.test(clean(node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''))); if (confirmButton) confirmButton.click(); else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); await delay(1000); write({ ok: applied, status: applied ? 'CHAT_TITLE_UI_RENAME_FINISHED_ATTEMPTED' : 'CHAT_TITLE_UI_RENAME_FAILED_INPUT_NOT_APPLIED', confirm_button_used: Boolean(confirmButton) }); })().catch((error) => write({ ok: false, status: 'CHAT_TITLE_UI_RENAME_FAILED_ERROR', error: String(error && error.message || error) })); }, 0); return { ok: true, status: 'CHAT_TITLE_UI_RENAME_STARTED', chat_id: chatId, desired_title: desiredTitle, state_key: key, href: location.href, title: document.title }; })()`;
}

function buildSidebarUiRenameStateExpression(chatId: string, title: string): string {
  const safeChatId = JSON.stringify(chatId);
  const desiredTitle = JSON.stringify(title);
  return `(() => { const chatId = ${safeChatId}; const desiredTitle = ${desiredTitle}; const key = chatId + '::' + desiredTitle; const root = window.__chatgptLifecycleUiRename || {}; const state = root[key] || null; if (!state) return { ok: false, status: 'CHAT_TITLE_UI_RENAME_STATE_PENDING', chat_id: chatId, desired_title: desiredTitle }; return Object.assign({ ok: false, status: 'CHAT_TITLE_UI_RENAME_STATE_PENDING', chat_id: chatId, desired_title: desiredTitle }, state); })()`;
}

function buildTitleConfirmationExpression(title: string): string {
  const desiredTitle = JSON.stringify(title);
  return `(() => { const desiredTitle = ${desiredTitle}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const documentTitle = clean(document.title); const anchors = Array.from(document.querySelectorAll('a[href*=\"/c/\"], a[href*=\"/chat/\"]')).map((node) => clean(node.innerText || node.textContent || '')).filter(Boolean).slice(0, 30); const exact = documentTitle === desiredTitle || anchors.some((value) => value === desiredTitle); const contains = documentTitle.includes(desiredTitle) || anchors.some((value) => value.includes(desiredTitle)); return { ok: exact || contains, status: exact ? 'CHAT_TITLE_CONFIRMED_EXACT' : (contains ? 'CHAT_TITLE_CONFIRMED_VISIBLE' : 'CHAT_TITLE_CONFIRM_PENDING'), desired_title: desiredTitle, document_title: documentTitle, anchor_titles: anchors, href: location.href, readyState: document.readyState }; })()`;
}

function extractCanonicalConfirmedTitle(record: Record<string, unknown>, desiredTitle: string): string | null {
  const anchors = Array.isArray(record.anchor_titles) ? record.anchor_titles.map((value) => asString(value)).filter((value): value is string => Boolean(value)) : [];
  const exactAnchor = anchors.find((value) => value === desiredTitle) ?? null;
  if (exactAnchor) return exactAnchor;
  const documentTitle = asString(record.document_title);
  if (documentTitle && documentTitle.includes(desiredTitle)) return desiredTitle;
  return documentTitle;
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

function isChatGptTarget(value: unknown): value is ChatGptTarget {
  return typeof value === "object" && value !== null && typeof (value as { port?: unknown }).port === "number";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asArrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
