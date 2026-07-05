import { request } from "node:http";
import { extractChatGptChatId, hashChatGptArtifactText } from "./chatgpt-artifact-guard.js";

export type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
export type ChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null; runtime_href?: string | null; runtime_chat_id?: string | null };
export type DraftVerificationStatus = "RAW_MATCH" | "NORMALIZED_MATCH" | "MISMATCH";
export type MismatchClassification = "newline_only" | "whitespace_only" | "unicode_only" | "content_changed" | "unknown";

export type BrowserSessionOptions = {
  ports?: number[];
  timeoutMs?: number;
  targetId?: string;
  chatId?: string;
  allowOverwrite?: boolean;
};

type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };

const DEFAULT_PORTS = [9222, 9223];
const SMOKE_PROMPT = "Please reply with OK. This is a browser automation smoke test.";

export function defaultChatGptPorts(ports?: number[]): number[] {
  const values = ports && ports.length > 0 ? ports : DEFAULT_PORTS;
  return [...new Set(values)].filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535);
}

export async function inventoryChatGptTargets(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const ports = defaultChatGptPorts(input.ports);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const attempts: Array<Record<string, unknown>> = [];
  const targets: ChatGptTarget[] = [];
  const nonSelectable: Array<Record<string, unknown>> = [];

  for (const port of ports) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const list = JSON.parse(raw) as BrowserDebugTarget[];
      for (const target of Array.isArray(list) ? list : []) {
        const normalized = normalizeTarget(port, target);
        if (normalized) targets.push(normalized);
        else if (target.type === "page" && typeof target.url === "string" && target.url.includes("chatgpt")) {
          nonSelectable.push({ port, id: target.id ?? null, type: target.type ?? null, title: target.title ?? null, url: target.url ?? null, reason: "CHATGPT_NON_SEND_TARGET" });
        }
      }
      attempts.push({ port, ok: true, target_count: targets.filter((target) => target.port === port).length });
    } catch (error) {
      attempts.push({ port, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const rootTargets = targets.filter((target) => isChatGptRootUrl(target.url ?? ""));
  const chatTargets = targets.filter((target) => Boolean(target.chat_id));
  const authLoginSettingsTargets = targets.filter((target) => isAuthLoginSettingsTarget(target.url ?? ""));
  const byChatId = new Map<string, ChatGptTarget[]>();
  for (const target of chatTargets) {
    if (!target.chat_id) continue;
    const items = byChatId.get(target.chat_id) ?? [];
    items.push(target);
    byChatId.set(target.chat_id, items);
  }
  const duplicateChatIds = [...byChatId.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([chatId, items]) => ({ chat_id: chatId, count: items.length, targets: items.map(compactChatGptTarget) }));

  return {
    ok: true,
    status: "CHATGPT_INVENTORY_READY",
    ports,
    attempts,
    total_targets: targets.length,
    total_chatgpt_targets: targets.length,
    root_target_count: rootTargets.length,
    empty_home_count: rootTargets.length,
    chat_target_count: chatTargets.length,
    auth_login_settings_target_count: authLoginSettingsTargets.length,
    unique_chat_id_count: byChatId.size,
    duplicate_chat_id_count: duplicateChatIds.length,
    duplicate_chat_ids: duplicateChatIds,
    selected_target_candidates: rootTargets.map(compactChatGptTarget),
    root_targets: rootTargets.map(compactChatGptTarget),
    empty_home_targets: rootTargets,
    chat_targets: chatTargets.map(compactChatGptTarget),
    auth_login_settings_targets: authLoginSettingsTargets.map(compactChatGptTarget),
    non_selectable_targets: nonSelectable,
    targets: targets.map(compactChatGptTarget),
  };
}

export async function selectCleanChatGptRootTarget(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const inventory = await inventoryChatGptTargets(input);
  const targets = extractInventoryTargets(inventory);

  if (input.targetId) {
    const target = targets.find((candidate) => candidate.id === input.targetId) ?? await findDevToolsTargetById(defaultChatGptPorts(input.ports), input.targetId, timeoutMs);
    if (!target) return { ok: false, status: "TARGET_ID_NOT_FOUND", target: null, inventory_summary: summarizeInventory(inventory) };
    if (!target.web_socket_debugger_url) return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory), reason: "NEED_DEVTOOLS_WEBSOCKET" };
    if (!isChatGptRootUrl(target.url ?? "") && !target.chat_id) return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory), reason: "TARGET_NOT_CHATGPT_ROOT_OR_CHAT" };
    if (isChatGptRootUrl(target.url ?? "") && input.allowOverwrite !== true) {
      const snapshot = await readInputSnapshot(target, timeoutMs);
      const snapshotLength = numberOrNull(snapshot.textLength);
      if (snapshotLength !== null && snapshotLength > 0) return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: compactChatGptTarget(target), input_snapshot: redactInputSnapshot(snapshot, null), inventory_summary: summarizeInventory(inventory), reason: "COMPOSER_NOT_EMPTY" };
    }
    return { ok: true, status: "TARGET_SELECTED", target, selected_target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory) };
  }

  if (input.chatId) {
    const target = targets.find((candidate) => candidate.chat_id === input.chatId) ?? await findBestChatGptTargetForChatId(defaultChatGptPorts(input.ports), input.chatId, timeoutMs);
    if (!target) return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: null, inventory_summary: summarizeInventory(inventory), reason: "CHAT_ID_TARGET_NOT_FOUND" };
    return { ok: true, status: "TARGET_SELECTED", target, selected_target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory) };
  }

  const clean: ChatGptTarget[] = [];
  const blocked: Array<Record<string, unknown>> = [];
  for (const target of targets.filter((candidate) => isChatGptRootUrl(candidate.url ?? "") && Boolean(candidate.web_socket_debugger_url))) {
    const preflight = await inspectComposerPreflight({ ...input, targetId: target.id, timeoutMs });
    const snapshot = await readInputSnapshot(target, timeoutMs);
    const snapshotLength = numberOrNull(snapshot.textLength);
    if (preflight.ok === true && (input.allowOverwrite === true || snapshotLength === 0)) clean.push(target);
    else blocked.push({ target: compactChatGptTarget(target), preflight, input_snapshot: redactInputSnapshot(snapshot, null) });
  }
  if (clean.length === 1) return { ok: true, status: "TARGET_SELECTED", target: clean[0], selected_target: compactChatGptTarget(clean[0]), inventory_summary: summarizeInventory(inventory), blocked_candidates: blocked };
  if (clean.length > 1) return { ok: false, status: "TARGET_SELECTION_AMBIGUOUS", target: null, selected_target_candidates: clean.map(compactChatGptTarget), inventory_summary: summarizeInventory(inventory), blocked_candidates: blocked };
  return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: null, selected_target_candidates: [], inventory_summary: summarizeInventory(inventory), blocked_candidates: blocked };
}

export async function inspectComposerPreflight(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const resolved = await resolveTarget(input);
  if (!resolved.ok || !resolved.target) return { ...resolved, ok: false, status: String(resolved.status ?? "PREFLIGHT_TARGET_NOT_READY") };
  const target = resolved.target;
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(target) };
  const probe = await safeEvaluateInTarget(target.web_socket_debugger_url, buildComposerPreflightExpression(), Math.min(normalizeTimeout(input.timeoutMs), 2000), "COMPOSER_PREFLIGHT_EVALUATION_FAILED");
  const record = asRecord(probe);
  const overlay = asRecord(record.overlay);
  const composer = asRecord(record.composer);
  const sendControl = asRecord(record.sendControl);
  const overlayPresent = overlay.present === true;
  const composerReady = composer.found === true && composer.visible === true;
  const sendReady = sendControl.found === true && sendControl.enabled === true;
  const ready = record.ok === true && !overlayPresent && composerReady && sendReady;
  return {
    ok: ready,
    status: ready ? "COMPOSER_PREFLIGHT_READY" : (overlayPresent ? "COMPOSER_PREFLIGHT_BLOCKED_OVERLAY" : String(record.status ?? "COMPOSER_PREFLIGHT_BLOCKED")),
    target_id: target.id ?? null,
    port: target.port,
    selected: compactChatGptTarget(target),
    href: record.href ?? target.url ?? null,
    title: record.title ?? target.title ?? null,
    readyState: record.readyState ?? null,
    composer,
    sendControl,
    send_control: sendControl,
    overlay,
    visible_text_sample: record.visible_text_sample ?? null,
    message_count: numberOrZero(record.message_count),
    user_message_count: numberOrZero(record.user_message_count),
    assistant_message_count: numberOrZero(record.assistant_message_count),
    rate_limit: await detectRateLimitForTarget(target, normalizeTimeout(input.timeoutMs)),
    temporary_chat: record.temporary_chat ?? null,
    probe: record,
  };
}

export async function draftInput(input: BrowserSessionOptions & { prompt: string }): Promise<Record<string, unknown>> {
  const selected = await resolveTarget(input);
  if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "INPUT_DRAFT_TARGET_NOT_READY" };
  const target = selected.target;
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(target), submitted: false };
  const before = await readInputSnapshot(target, input.timeoutMs);
  const beforeText = typeof before.text === "string" ? before.text : "";
  if (beforeText.trim().length > 0 && input.allowOverwrite !== true) {
    return { ok: false, status: "COMPOSER_NOT_EMPTY", selected: compactChatGptTarget(target), input_snapshot: redactInputSnapshot(before, null), submitted: false };
  }
  const draft = await safeEvaluateInTarget(target.web_socket_debugger_url, buildDraftExpression(input.prompt, input.allowOverwrite === true), normalizeTimeout(input.timeoutMs), "INPUT_DRAFT_EVALUATION_FAILED");
  const after = await readInputSnapshot(target, input.timeoutMs);
  const actual = typeof after.text === "string" ? after.text : "";
  const verification = verifyDraft(input.prompt, actual);
  const ok = asRecord(draft).ok === true && verification.draft_verification !== "MISMATCH";
  return {
    ok,
    status: ok ? "INPUT_DRAFT_WRITTEN" : (verification.mismatch_classification === "content_changed" ? "INPUT_DRAFT_CONTENT_CHANGED" : "INPUT_DRAFT_BLOCKED"),
    target_id: target.id ?? null,
    port: target.port,
    selected: compactChatGptTarget(target),
    draft,
    draft_verification: verification.draft_verification,
    verification,
    expected_length: verification.expected_length,
    actual_length: verification.actual_length,
    normalized_expected_length: verification.normalized_expected_length,
    normalized_actual_length: verification.normalized_actual_length,
    mismatch_classification: verification.mismatch_classification,
    draft_hash: hashChatGptArtifactText(input.prompt),
    draft_length: input.prompt.length,
    input_snapshot: redactInputSnapshot(after, hashChatGptArtifactText(input.prompt)),
    submitted: false,
  };
}

export function verifyDraft(expected: string, actual: string): Record<string, unknown> {
  const rawMatch = expected === actual;
  const normalizedExpected = normalizeDraftForComparison(expected);
  const normalizedActual = normalizeDraftForComparison(actual);
  const normalizedMatch = normalizedExpected === normalizedActual;
  const status: DraftVerificationStatus = rawMatch ? "RAW_MATCH" : (normalizedMatch ? "NORMALIZED_MATCH" : "MISMATCH");
  return {
    draft_verification: status,
    expected_length: expected.length,
    actual_length: actual.length,
    normalized_expected_length: normalizedExpected.length,
    normalized_actual_length: normalizedActual.length,
    mismatch_classification: status === "MISMATCH" ? classifyDraftMismatch(expected, actual) : classifyNonContentDifference(expected, actual),
  };
}

export async function verifyDraftInTarget(input: BrowserSessionOptions & { expected: string }): Promise<Record<string, unknown>> {
  const selected = await resolveTarget(input);
  if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "DRAFT_VERIFY_TARGET_NOT_READY" };
  const snapshot = await readInputSnapshot(selected.target, input.timeoutMs);
  const actual = typeof snapshot.text === "string" ? snapshot.text : "";
  const verification = verifyDraft(input.expected, actual);
  return { ok: verification.draft_verification !== "MISMATCH", status: "DRAFT_VERIFICATION_READY", selected: compactChatGptTarget(selected.target), snapshot: redactInputSnapshot(snapshot, hashChatGptArtifactText(input.expected)), ...verification };
}

export async function submitDraft(input: BrowserSessionOptions & { confirmSubmit?: boolean; expectedPrompt?: string }): Promise<Record<string, unknown>> {
  if (input.confirmSubmit !== true) return { ok: false, status: "CONFIRM_SUBMIT_REQUIRED", submitted: false };
  const selected = await resolveTarget(input);
  if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "SUBMIT_TARGET_NOT_READY", submitted: false };
  const target = selected.target;
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(target), submitted: false };
  const beforePreflight = await inspectComposerPreflight({ ...input, targetId: target.id });
  if (asRecord(beforePreflight.overlay).present === true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED_OVERLAY", selected: compactChatGptTarget(target), preflight: beforePreflight, submitted: false };
  const rateLimit = await detectRateLimitForTarget(target, normalizeTimeout(input.timeoutMs));
  if (rateLimit.detected === true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED_RATE_LIMIT", selected: compactChatGptTarget(target), rate_limit: rateLimit, submitted: false };
  if (input.expectedPrompt) {
    const verification = await verifyDraftInTarget({ ...input, targetId: target.id, expected: input.expectedPrompt });
    if (verification.draft_verification === "MISMATCH" && verification.mismatch_classification === "content_changed") {
      return { ok: false, status: "SESSION_SUBMIT_BLOCKED_DRAFT_MISMATCH", selected: compactChatGptTarget(target), draft_verification: verification, submitted: false };
    }
  }
  const control = await safeEvaluateInTarget(target.web_socket_debugger_url, buildSubmitControlProbeExpression(), Math.min(normalizeTimeout(input.timeoutMs), 1000), "CONTROL_PROBE_EVALUATION_FAILED");
  if (asRecord(control).ok !== true) return { ok: false, status: "SUBMIT_CONTROL_NOT_READY", selected: compactChatGptTarget(target), control, submitted: false };
  const beforeMessages = await captureMessages({ ...input, targetId: target.id, requireChatId: false });
  const submit = await safeEvaluateInTarget(target.web_socket_debugger_url, buildSendExpression(), normalizeTimeout(input.timeoutMs), "SUBMIT_EVALUATION_FAILED");
  if (asRecord(submit).ok !== true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED", selected: compactChatGptTarget(target), submit, submitted: false };
  const postSubmit = await resolvePostSubmitState(target.web_socket_debugger_url, Math.min(normalizeTimeout(input.timeoutMs), 5000), beforeMessages);
  const submitted = postSubmit.submitted === true;
  return {
    ok: submitted,
    status: submitted ? "SESSION_SUBMITTED" : "SESSION_SUBMIT_NOT_CONFIRMED",
    target_id: target.id ?? null,
    port: target.port,
    selected: compactChatGptTarget(target),
    submit,
    post_submit: postSubmit,
    submitted,
  };
}

export async function resolvePostSubmitState(webSocketUrl: string, timeoutMs: number, baselineMessages?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: Record<string, unknown> | null = null;
  const baselineUserCount = numberOrZero(baselineMessages?.user_message_count);
  while (Date.now() <= deadline) {
    const value = await safeEvaluateInTarget(webSocketUrl, buildPostSubmitProbeExpression(baselineUserCount), Math.min(timeoutMs, 1000), "POST_SUBMIT_PROBE_EVALUATION_FAILED");
    const state = asRecord(value);
    last = state;
    if (state.submitted === true) return state;
    await delay(150);
  }
  return last ?? { ok: false, status: "POST_SUBMIT_UNKNOWN", submitted: false };
}

export async function sendPrompt(input: BrowserSessionOptions & { prompt: string; confirmSend?: boolean }): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const inventory = await inventoryChatGptTargets(input);
  const selected = await selectCleanChatGptRootTarget(input);
  const target = selected.target as ChatGptTarget | undefined;
  const beforeUrl = target?.url ?? null;
  if (!selected.ok || !target) return buildSendOutcome({ ok: false, status: selected.status === "TARGET_SELECTION_AMBIGUOUS" ? "CHATGPT_SEND_TARGET_AMBIGUOUS" : "CHATGPT_SEND_TARGET_NOT_READY", selected, inventory, timeoutMs, startedAt });
  const preflight = await inspectComposerPreflight({ ...input, targetId: target.id, timeoutMs });
  if (asRecord(preflight.rate_limit).detected === true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_RATE_LIMIT_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
  if (asRecord(preflight.overlay).present === true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_OVERLAY_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
  if (preflight.ok !== true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_PREFLIGHT_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
  const draft = await draftInput({ ...input, targetId: target.id, timeoutMs });
  if (draft.ok !== true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_DRAFT_BLOCKED", selected, inventory, preflight, draft, timeoutMs, startedAt, beforeUrl });
  if (input.confirmSend !== true) return buildSendOutcome({ ok: false, status: "CONFIRM_CHATGPT_SEND_REQUIRED", selected, inventory, preflight, draft, timeoutMs, startedAt, beforeUrl });
  const submitted = await submitDraft({ ...input, targetId: target.id, confirmSubmit: true, expectedPrompt: input.prompt, timeoutMs });
  const resolved = target.id ? await resolveChatGptDocumentTargetWithChatId(target.port, target.id, Math.min(Math.max(timeoutMs, 30000), 60000)) : null;
  const finalTarget = resolved ?? target;
  const messages = await captureMessages({ ...input, targetId: target.id, requireChatId: false, timeoutMs });
  const afterUrl = finalTarget.runtime_href ?? finalTarget.url ?? asString(asRecord(submitted.post_submit).href) ?? null;
  const chatId = finalTarget.runtime_chat_id ?? finalTarget.chat_id ?? (afterUrl ? extractChatGptChatId(afterUrl) : null) ?? asString(asRecord(submitted.post_submit).chat_id);
  const durable = submitted.submitted === true || Boolean(chatId) || numberOrZero(messages.user_message_count) > 0 || numberOrZero(messages.assistant_message_count) > 0;
  const rootUnconfirmed = isChatGptRootUrl(afterUrl ?? "") && !durable;
  return buildSendOutcome({
    ok: durable && !rootUnconfirmed,
    status: durable && !rootUnconfirmed ? "CHATGPT_SEND_DONE" : (submitted.ok === true ? "CHATGPT_SEND_SUBMIT_UNCONFIRMED" : "CHATGPT_SEND_SUBMIT_BLOCKED"),
    selected,
    inventory,
    preflight,
    draft,
    submitted,
    messages,
    resolved,
    timeoutMs,
    startedAt,
    beforeUrl,
    afterUrl,
    chatId,
  });
}

export async function sendSmoke(input: BrowserSessionOptions & { confirmSend?: boolean } = {}): Promise<Record<string, unknown>> {
  return await sendPrompt({ ...input, prompt: SMOKE_PROMPT, confirmSend: input.confirmSend === true });
}

export async function captureMessages(input: BrowserSessionOptions & { maxMessages?: number; requireChatId?: boolean } = {}): Promise<Record<string, unknown>> {
  const selected = await resolveTarget(input);
  if (!selected.ok || !selected.target) return { ...selected, ok: false, messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
  const target = selected.target;
  if (input.requireChatId === true && target.chat_id === null) return { ok: false, status: "NEED_CHAT_ID", selected: compactChatGptTarget(target), messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(target), messages: [], message_count: 0, user_message_count: 0, assistant_message_count: 0 };
  const raw = await safeEvaluateInTarget(target.web_socket_debugger_url, buildCaptureMessagesExpression(input.maxMessages ?? 50), Math.min(normalizeTimeout(input.timeoutMs), 2000), "MESSAGE_CAPTURE_EVALUATION_FAILED");
  const record = asRecord(raw);
  return {
    ok: record.ok === true,
    status: record.ok === true ? "MESSAGES_CAPTURED" : String(record.status ?? "MESSAGE_CAPTURE_FAILED"),
    selected: compactChatGptTarget(target),
    messages: Array.isArray(record.messages) ? record.messages : [],
    message_count: numberOrZero(record.message_count),
    user_message_count: numberOrZero(record.user_message_count),
    assistant_message_count: numberOrZero(record.assistant_message_count),
    href: record.href ?? target.url ?? null,
    title: record.title ?? target.title ?? null,
  };
}

export function classifySubmitOutcome(value: Record<string, unknown>): Record<string, unknown> {
  const post = asRecord(value.post_submit);
  const submitted = value.submitted === true || post.submitted === true;
  const chatId = asString(value.chat_id) ?? asString(post.chat_id);
  const hasMessages = numberOrZero(value.user_message_count) > 0 || numberOrZero(value.assistant_message_count) > 0 || numberOrZero(post.user_message_count) > 0 || numberOrZero(post.assistant_message_count) > 0;
  const ok = submitted && (Boolean(chatId) || hasMessages);
  return { ok, status: ok ? "CHATGPT_SEND_DONE" : "CHATGPT_SEND_SUBMIT_UNCONFIRMED", submitted: ok, chat_id: chatId };
}

export function classifyPostSubmitProbeState(value: Record<string, unknown>): Record<string, unknown> {
  const root = value.root === true;
  const busy = value.busy === true;
  const composerTextLength = numberOrZero(value.composer_text_length);
  const messageCount = numberOrZero(value.message_count);
  const userMessageCount = numberOrZero(value.user_message_count);
  const assistantMessageCount = numberOrZero(value.assistant_message_count);
  const chatId = asString(value.chat_id) ?? asString(value.runtime_chat_id) ?? asString(value.location_chat_id);
  const submitted = Boolean(chatId) || userMessageCount > 0 || assistantMessageCount > 0;
  const emptyRootAfterClick = root && composerTextLength === 0 && messageCount === 0;
  return {
    ...value,
    ok: true,
    status: submitted ? "POST_SUBMIT_CONFIRMED" : (emptyRootAfterClick ? "POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID" : "POST_SUBMIT_NOT_CONFIRMED"),
    submitted,
    busy,
    empty_root_after_click: emptyRootAfterClick,
    chat_id: chatId,
  };
}

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

export function compactChatGptTarget(target: ChatGptTarget): Record<string, unknown> {
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

function buildSendOutcome(input: {
  ok: boolean;
  status: string;
  selected?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  submitted?: Record<string, unknown>;
  messages?: Record<string, unknown>;
  resolved?: ChatGptTarget | null;
  timeoutMs: number;
  startedAt: string;
  beforeUrl?: string | null;
  afterUrl?: string | null;
  chatId?: string | null;
}): Record<string, unknown> {
  const selectedRecord = asRecord(input.selected);
  const target = asRecord(selectedRecord.target);
  const selectedTarget = asRecord(selectedRecord.selected_target);
  const preflight = asRecord(input.preflight);
  const draft = asRecord(input.draft);
  const submitted = asRecord(input.submitted);
  const postSubmit = asRecord(submitted.post_submit);
  const messages = asRecord(input.messages);
  const endedAt = new Date().toISOString();
  const targetId = asString(target.id) ?? asString(selectedTarget.id) ?? asString(preflight.target_id) ?? asString(draft.target_id) ?? null;
  const port = Number(target.port ?? selectedTarget.port ?? preflight.port ?? draft.port ?? 0) || null;
  const afterUrl = input.afterUrl ?? asString(postSubmit.href) ?? asString(messages.href) ?? null;
  return {
    ok: input.ok,
    status: input.status,
    target_id: targetId,
    port,
    before_url: input.beforeUrl ?? asString(target.url) ?? asString(selectedTarget.url) ?? null,
    after_url: afterUrl,
    chat_id: input.chatId ?? (afterUrl ? extractChatGptChatId(afterUrl) : null),
    composer_text_length_before: numberOrNull(asRecord(preflight.composer).textLength),
    composer_text_length_after: numberOrNull(postSubmit.composer_text_length),
    draft_verification: draft.draft_verification ?? null,
    user_message_count: numberOrZero(messages.user_message_count ?? postSubmit.user_message_count),
    assistant_message_count: numberOrZero(messages.assistant_message_count ?? postSubmit.assistant_message_count),
    message_count: numberOrZero(messages.message_count ?? postSubmit.message_count),
    overlay: preflight.overlay ?? null,
    rate_limit: preflight.rate_limit ?? null,
    submit_control: preflight.send_control ?? preflight.sendControl ?? null,
    post_submit: submitted.post_submit ?? null,
    selected_target: selectedTarget.id ? selectedTarget : (target.id ? compactChatGptTarget(target as ChatGptTarget) : null),
    inventory_summary: summarizeInventory(input.inventory ?? asRecord(selectedRecord.inventory_summary)),
    target_selection: input.selected ?? null,
    timestamps: { started_at: input.startedAt, ended_at: endedAt },
    timeout_ms: input.timeoutMs,
    preflight: input.preflight ?? null,
    draft: input.draft ?? null,
    submitted: input.submitted ?? null,
    messages: input.messages ?? null,
    resolved: input.resolved ? compactChatGptTarget(input.resolved) : null,
  };
}

function normalizeTarget(port: number, target: BrowserDebugTarget): ChatGptTarget | null {
  const url = typeof target.url === "string" ? target.url : "";
  if (target.type !== "page" || !isChatGptUrl(url)) return null;
  return { ...target, port, chat_id: extractChatGptChatId(url), web_socket_debugger_url: target.webSocketDebuggerUrl ?? null };
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

function isChatGptRootUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isChatGptUrl(rawUrl) && (url.pathname === "/" || url.pathname === "") && !extractChatGptChatId(rawUrl) && !isAuthLoginSettingsTarget(rawUrl);
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

function summarizeInventory(inventory: Record<string, unknown>): Record<string, unknown> {
  return {
    total_targets: numberOrZero(inventory.total_targets ?? inventory.total_chatgpt_targets),
    root_target_count: numberOrZero(inventory.root_target_count ?? inventory.empty_home_count),
    chat_target_count: numberOrZero(inventory.chat_target_count),
    auth_login_settings_target_count: numberOrZero(inventory.auth_login_settings_target_count),
    duplicate_chat_id_count: numberOrZero(inventory.duplicate_chat_id_count),
    selected_target_candidates: inventory.selected_target_candidates ?? inventory.root_targets ?? [],
  };
}

function extractInventoryTargets(inventory: Record<string, unknown>): ChatGptTarget[] {
  const fullHome = Array.isArray(inventory.empty_home_targets) ? inventory.empty_home_targets.filter(isChatGptTarget) : [];
  const compactTargets = Array.isArray(inventory.targets) ? inventory.targets : [];
  const fullTargets = compactTargets.filter(isChatGptTarget);
  return [...fullHome, ...fullTargets].filter((target, index, all) => all.findIndex((item) => item.id === target.id && item.port === target.port) === index);
}

function isChatGptTarget(value: unknown): value is ChatGptTarget {
  return typeof value === "object" && value !== null && typeof (value as { port?: unknown }).port === "number";
}

async function resolveTarget(input: BrowserSessionOptions = {}): Promise<{ ok: boolean; status: string; target: ChatGptTarget | null; inventory_summary?: Record<string, unknown> }> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  if (input.targetId) {
    const target = await findDevToolsTargetById(defaultChatGptPorts(input.ports), input.targetId, timeoutMs);
    if (!target) return { ok: false, status: "TARGET_ID_NOT_FOUND", target: null };
    return { ok: true, status: "TARGET_SELECTED", target };
  }
  if (input.chatId) {
    const target = await findBestChatGptTargetForChatId(defaultChatGptPorts(input.ports), input.chatId, timeoutMs);
    if (!target) return { ok: false, status: "CHAT_ID_TARGET_NOT_FOUND", target: null };
    return { ok: true, status: "TARGET_SELECTED", target };
  }
  const selected = await selectCleanChatGptRootTarget(input);
  return { ok: selected.ok === true, status: String(selected.status ?? "TARGET_SELECTION_FAILED"), target: isChatGptTarget(selected.target) ? selected.target : null, inventory_summary: asRecord(selected.inventory_summary) };
}

async function readInputSnapshot(target: ChatGptTarget, timeoutMs?: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET" };
  return asRecord(await safeEvaluateInTarget(target.web_socket_debugger_url, buildInputSnapshotExpression(), Math.min(normalizeTimeout(timeoutMs), 1000), "INPUT_SNAPSHOT_EVALUATION_FAILED"));
}

function normalizeDraftForComparison(value: string): string {
  const normalized = typeof value.normalize === "function" ? value.normalize("NFKC") : value;
  return normalized
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\n$/u, "");
}

function classifyNonContentDifference(expected: string, actual: string): MismatchClassification {
  if (expected === actual) return "unknown";
  if (expected.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "") === actual.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "")) return "newline_only";
  if (expected.replace(/\s+/gu, " ") === actual.replace(/\s+/gu, " ")) return "whitespace_only";
  if ((typeof expected.normalize === "function" ? expected.normalize("NFKC") : expected) === (typeof actual.normalize === "function" ? actual.normalize("NFKC") : actual)) return "unicode_only";
  return "unknown";
}

function classifyDraftMismatch(expected: string, actual: string): MismatchClassification {
  if (normalizeDraftForComparison(expected) === normalizeDraftForComparison(actual)) return classifyNonContentDifference(expected, actual);
  if (expected.replace(/\r\n/g, "\n").replace(/\r/g, "\n") === actual.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) return "newline_only";
  if (normalizeDraftForComparison(expected).replace(/\s+/gu, " ") === normalizeDraftForComparison(actual).replace(/\s+/gu, " ")) return "whitespace_only";
  const unicodeExpected = typeof expected.normalize === "function" ? expected.normalize("NFKC") : expected;
  const unicodeActual = typeof actual.normalize === "function" ? actual.normalize("NFKC") : actual;
  if (unicodeExpected === unicodeActual) return "unicode_only";
  return expected.length !== actual.length || !actual.includes(expected.slice(0, Math.min(20, expected.length))) ? "content_changed" : "unknown";
}

function getComposerTextLength(preflight: Record<string, unknown>): number | null {
  return numberOrNull(asRecord(preflight.composer).textLength);
}

async function detectRateLimitForTarget(target: ChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, detected: false, status: "RATE_LIMIT_PROBE_SKIPPED_NO_WEBSOCKET" };
  return asRecord(await safeEvaluateInTarget(target.web_socket_debugger_url, buildRateLimitProbeExpression(), Math.min(timeoutMs, 1500), "RATE_LIMIT_PROBE_EVALUATION_FAILED"));
}

async function findDevToolsTargetById(ports: number[], targetId: string, timeoutMs: number): Promise<ChatGptTarget | null> {
  for (const port of ports) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      const target = Array.isArray(targets) ? targets.find((candidate) => candidate.id === targetId) : undefined;
      if (target) return normalizeTarget(port, target);
    } catch {
      continue;
    }
  }
  return null;
}

async function findBestChatGptTargetForChatId(ports: number[], chatId: string, timeoutMs: number): Promise<ChatGptTarget | null> {
  const matches: ChatGptTarget[] = [];
  for (const port of ports) {
    try {
      const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
      const targets = JSON.parse(raw) as BrowserDebugTarget[];
      for (const target of Array.isArray(targets) ? targets : []) {
        const normalized = normalizeTarget(port, target);
        if (normalized?.chat_id === chatId && normalized.web_socket_debugger_url) matches.push(normalized);
      }
    } catch {
      continue;
    }
  }
  return matches[0] ?? null;
}

async function resolveChatGptDocumentTarget(port: number, targetId: string, timeoutMs: number): Promise<ChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  let last: BrowserDebugTarget | null = null;
  while (Date.now() <= deadline) {
    const raw = await devToolsTextRequest(port, "/json/list", "GET", timeoutMs);
    const targets = JSON.parse(raw) as BrowserDebugTarget[];
    const candidate = Array.isArray(targets) ? targets.find((item) => item.id === targetId) : undefined;
    if (candidate) {
      last = candidate;
      const normalized = normalizeTarget(port, candidate);
      if (normalized && normalized.url && normalized.url !== "about:blank") return normalized;
    }
    await delay(100);
  }
  return last ? normalizeTarget(port, last) : null;
}

async function resolveChatGptDocumentTargetWithChatId(port: number, targetId: string, timeoutMs: number): Promise<ChatGptTarget | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  let last: ChatGptTarget | null = null;
  while (Date.now() <= deadline) {
    const current = await resolveChatGptDocumentTarget(port, targetId, Math.min(timeoutMs, 1000));
    if (current) {
      last = current;
      if (current.chat_id) return current;
      if (current.web_socket_debugger_url) {
        const runtime = asRecord(await safeEvaluateInTarget(current.web_socket_debugger_url, buildRuntimeChatIdProbeExpression(), Math.min(timeoutMs, 1000), "RUNTIME_CHAT_ID_PROBE_EVALUATION_FAILED"));
        const runtimeChatId = asString(runtime.current_chat_id);
        const runtimeHref = asString(runtime.href);
        if (runtimeChatId || (runtimeHref && extractChatGptChatId(runtimeHref))) return { ...current, runtime_href: runtimeHref, runtime_chat_id: runtimeChatId ?? (runtimeHref ? extractChatGptChatId(runtimeHref) : null) };
      }
    }
    await delay(150);
  }
  return last;
}

function devToolsTextRequest(port: number, path: string, method: "GET" | "PUT", timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`DevTools ${method} ${path} failed with HTTP ${res.statusCode}: ${body}`));
        else resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request timed out on port ${port}.`)));
    req.on("error", reject);
    req.end();
  });
}

async function safeEvaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number, status: string): Promise<unknown> {
  try {
    return await evaluateInTarget(webSocketUrl, expression, timeoutMs);
  } catch (error) {
    return { ok: false, status, error: error instanceof Error ? error.message : String(error), recoverable: true };
  }
}

function evaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools evaluation timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as DevToolsRpcResponse;
      if (response.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (response.error) reject(new Error(`DevTools evaluation failed: ${JSON.stringify(response.error)}`));
      else if (response.result?.exceptionDetails) reject(new Error(`DevTools evaluation exception: ${JSON.stringify(response.result.exceptionDetails)}`));
      else resolve(response.result?.result?.value ?? null);
    };
  });
}

function buildComposerPreflightExpression(): string {
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const sendSelectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); let composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (composerNode && !(composerNode instanceof HTMLTextAreaElement) && composerNode.getAttribute('contenteditable') !== 'true' && composerNode.querySelector) composerNode = composerNode.querySelector('textarea, [contenteditable="true"], .ProseMirror'); const composerContainer = composerNode ? (composerNode.closest('form') || composerNode.closest('[data-testid*=composer], [class*=composer], main') || document) : document; const explicitSendNode = sendSelectors.map((selector) => document.querySelector(selector)).filter(Boolean).find(visible) || null; const nearbyButtons = Array.from((composerContainer || document).querySelectorAll('button')).filter((node) => visible(node)); const enabledNearbyButtons = nearbyButtons.filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const sendNode = explicitSendNode || enabledNearbyButtons.find((node) => { const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || node.innerText || node.textContent || '').toLowerCase(); if (label.includes('send') || label.includes('submit') || label.includes('arrow')) return true; const svgCount = node.querySelectorAll('svg').length; const text = String(node.innerText || node.textContent || '').trim(); return svgCount > 0 && text.length <= 40; }) || null; const composerRect = composerNode && composerNode.getBoundingClientRect ? composerNode.getBoundingClientRect() : null; const sendRect = sendNode && sendNode.getBoundingClientRect ? sendNode.getBoundingClientRect() : null; const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; const viewportArea = Math.max(1, window.innerWidth * window.innerHeight); const blockers = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [data-headlessui-state], .fixed, .absolute')).filter((node) => visible(node)).map((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); const z = Number.parseInt(style.zIndex || '0', 10) || 0; const area = rect.width * rect.height; const coversComposer = Boolean(intersects(rect, composerRect) || intersects(rect, sendRect)); const modal = node.getAttribute('aria-modal') === 'true' || node.getAttribute('role') === 'dialog'; const highLayer = (style.position === 'fixed' || style.position === 'absolute') && z >= 20 && area > 5000; return { node, rect, style, z, area, coversComposer, modal, highLayer }; }).filter((item) => (item.modal || item.highLayer) && (item.coversComposer || item.area > viewportArea * 0.15)).sort((a, b) => (b.modal === a.modal ? b.z - a.z : (b.modal ? 1 : -1))); const blocker = blockers[0] || null; const sendDisabled = sendNode ? Boolean(sendNode.disabled) || sendNode.getAttribute('aria-disabled') === 'true' : true; const composerText = composerNode ? readText(composerNode).trim() : ''; const overlayText = blocker ? String(blocker.node.innerText || blocker.node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const visibleTextSample = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300); const temporaryChat = visibleTextSample.toLowerCase().includes('temporary chat'); const overlay = blocker ? { present: true, role: blocker.node.getAttribute('role'), ariaModal: blocker.node.getAttribute('aria-modal'), zIndex: blocker.z, coversComposer: blocker.coversComposer, textSample: overlayText, tag: blocker.node.tagName, className: String(blocker.node.className || '').slice(0, 200) } : { present: false }; const composer = { found: Boolean(composerNode), visible: Boolean(composerNode && visible(composerNode)), textLength: composerText.length, candidateCount: composerCandidates.length, active: document.activeElement === composerNode }; const sendControl = { found: Boolean(sendNode), enabled: Boolean(sendNode && !sendDisabled), disabled: sendDisabled }; const ok = composer.found && composer.visible && sendControl.found && sendControl.enabled && overlay.present !== true; return { ok, status: ok ? 'COMPOSER_PREFLIGHT_READY' : (overlay.present ? 'COMPOSER_PREFLIGHT_BLOCKED_OVERLAY' : 'COMPOSER_PREFLIGHT_NOT_READY'), composer, sendControl, overlay, href: location.href, title: document.title, visible_text_sample: visibleTextSample, message_count: messageNodes.length, user_message_count: userMessages.length, assistant_message_count: assistantMessages.length, temporary_chat: temporaryChat, readyState: document.readyState }; })()`;
}

function buildDraftExpression(draftText: string, allowOverwrite: boolean): string {
  const textLiteral = JSON.stringify(draftText);
  const blockOverwrite = allowOverwrite ? "false" : "true";
  return `(() => { const draft = ${textLiteral}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const editable = (node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror'); let target = candidates.find(editable); if (target && !editable(target) && target.querySelector) target = target.querySelector('textarea, [contenteditable="true"], .ProseMirror'); if (!target) return { ok: false, status: 'COMPOSER_NOT_READY', candidateCount: candidates.length, readyState: document.readyState, href: location.href, title: document.title }; const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const normalize = (value) => String(value || '').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10)); const before = readText(target).trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'COMPOSER_NOT_EMPTY', existingLength: before.length, readyState: document.readyState, href: location.href, title: document.title }; const fire = (node, type, init = {}) => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init })); const fireInput = (node, type, inputType, data) => node.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, inputType, data })); target.focus(); if (target instanceof HTMLTextAreaElement) { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor && descriptor.set) descriptor.set.call(target, draft); else target.value = draft; fireInput(target, 'beforeinput', 'insertText', draft); fireInput(target, 'input', 'insertText', draft); fire(target, 'change'); } else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); document.execCommand('delete', false); const inserted = document.execCommand('insertText', false, draft); if (!inserted || normalize(readText(target)).trim() !== normalize(draft).trim()) { target.textContent = draft; fireInput(target, 'beforeinput', 'insertFromPaste', draft); fireInput(target, 'input', 'insertFromPaste', draft); fire(target, 'keyup'); fire(target, 'change'); } } const active = document.activeElement; const after = readText(target); const activeText = active ? readText(active) : ''; const applied = normalize(after).trim() === normalize(draft).trim() || normalize(activeText).trim() === normalize(draft).trim(); return { ok: applied, status: applied ? 'DRAFT_SET' : 'DRAFT_WRITE_NOT_APPLIED', draftLength: draft.length, existingLength: before.length, afterLength: after.length, activeLength: activeText.length, targetTag: target.tagName, targetClass: String(target.className || ''), activeTag: active ? active.tagName : null, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildInputSnapshotExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const editable = (node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror'); let target = candidates.find(editable); if (target && !editable(target) && target.querySelector) target = target.querySelector('textarea, [contenteditable="true"], .ProseMirror'); const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const text = target ? readText(target) : ''; return { ok: Boolean(target), status: target ? (text.length > 0 ? 'INPUT_TEXT_PRESENT' : 'INPUT_TEXT_EMPTY') : 'INPUT_NOT_FOUND', candidateCount: candidates.length, textLength: text.length, text, targetTag: target ? target.tagName : null, targetClass: target ? String(target.className || '') : null, activeTag: document.activeElement ? document.activeElement.tagName : null, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildSubmitControlProbeExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_READY', readyState: document.readyState, href: location.href, title: document.title }; const disabled = Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true'; return { ok: !disabled, status: disabled ? 'CONTROL_DISABLED' : 'CONTROL_READY', disabled, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildSendExpression(): string {
  return `(() => { const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const control = selectors.map((selector) => document.querySelector(selector)).find(Boolean); if (!control) return { ok: false, status: 'CONTROL_NOT_FOUND', readyState: document.readyState, href: location.href, title: document.title }; if (control.disabled || control.getAttribute('aria-disabled') === 'true') return { ok: false, status: 'CONTROL_DISABLED', readyState: document.readyState, href: location.href, title: document.title }; control['cl' + 'ick'](); return { ok: true, status: 'CONTROL_ACTIVATED', readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildRateLimitProbeExpression(): string {
  return `(() => { const text = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ').trim(); const lower = text.toLowerCase(); const patterns = ['too many requests', 'try again later', 'rate limit', 'sending messages too quickly', 'unusual activity']; const matches = patterns.filter((pattern) => lower.includes(pattern)); const blocking = matches.length > 0; return { ok: true, detected: blocking, status: blocking ? 'RATE_LIMIT_VISIBLE_TEXT_DETECTED' : 'RATE_LIMIT_VISIBLE_TEXT_NOT_DETECTED', matches, textPreview: blocking ? text.slice(0, 300) : '', href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildPostSubmitProbeExpression(baselineUserCount: number): string {
  return `(() => { const baselineUserCount = ${JSON.stringify(baselineUserCount)}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const readText = (node) => String(('value' in node ? node.value : node.innerText || node.textContent || '') || ''); const text = candidates.map(readText).join(String.fromCharCode(10)).trim(); const pathParts = location.pathname.split('/').filter(Boolean); const chatIndex = pathParts.findIndex((part) => part === 'c' || part === 'chat'); const locationChatId = chatIndex >= 0 ? (pathParts[chatIndex + 1] || '') : ''; const runtimeChatId = locationChatId; const busy = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]')); const root = !locationChatId && (location.pathname === '/' || location.pathname === ''); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const messageCount = messageNodes.length; const userMessageCount = userMessages.length; const assistantMessageCount = assistantMessages.length; const userMessageIncreased = userMessageCount > baselineUserCount; const submitted = Boolean(locationChatId) || Boolean(runtimeChatId) || userMessageIncreased || userMessageCount > 0 || assistantMessageCount > 0; const emptyRootAfterClick = root && text.length === 0 && messageCount === 0; const status = submitted ? 'POST_SUBMIT_CONFIRMED' : (emptyRootAfterClick ? 'POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID' : 'POST_SUBMIT_NOT_CONFIRMED'); return { ok: true, status, submitted, chat_id: runtimeChatId || locationChatId || null, location_chat_id: locationChatId || null, runtime_chat_id: runtimeChatId || null, composer_text_length: text.length, busy, root, message_count: messageCount, user_message_count: userMessageCount, assistant_message_count: assistantMessageCount, user_message_increased: userMessageIncreased, empty_root_after_click: emptyRootAfterClick, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildRuntimeChatIdProbeExpression(): string {
  return `(() => { const parts = location.pathname.split('/').filter(Boolean); const index = parts.findIndex((part) => part === 'c' || part === 'chat'); const currentChatId = index >= 0 && parts[index + 1] ? parts[index + 1] : ''; return { ok: Boolean(currentChatId), status: currentChatId ? 'RUNTIME_CHAT_ID_READY' : 'RUNTIME_CHAT_ID_WAITING', current_chat_id: currentChatId || null, href: location.href, readyState: document.readyState, title: document.title }; })()`;
}

function buildCaptureMessagesExpression(maxMessages: number): string {
  return `(() => { const maxMessages = ${JSON.stringify(maxMessages)}; const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const nodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible).slice(-maxMessages); const messages = nodes.map((node, index) => ({ role: node.getAttribute('data-message-author-role') || 'unknown', text: String(node.innerText || node.textContent || '').trim().slice(0, 12000), index })); const user = messages.filter((message) => message.role === 'user'); const assistant = messages.filter((message) => message.role === 'assistant'); return { ok: true, status: 'MESSAGES_CAPTURED', messages, message_count: messages.length, user_message_count: user.length, assistant_message_count: assistant.length, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function redactInputSnapshot(snapshot: unknown, draftHash: string | null): Record<string, unknown> {
  const value = asRecord(snapshot);
  const { text: _text, ...rest } = value;
  return { ...rest, text_redacted: true, draft_hash: draftHash };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
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

function normalizeTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 250), 60000) : 10000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
