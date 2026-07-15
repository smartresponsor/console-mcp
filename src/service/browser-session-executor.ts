import { request } from "node:http";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractChatGptChatId, hashChatGptArtifactText } from "./chatgpt-artifact-guard.js";
import { createChatGptPromptDraft } from "../Consumer/ChatGpt/Draft/ChatGptPromptDraft.js";
import { verifyDraft } from "../Consumer/ChatGpt/Draft/ChatGptDraftVerifier.js";
import { createChatGptPromptSubmit } from "../Consumer/ChatGpt/Submit/ChatGptPromptSubmit.js";
import { classifyChatGptAuthState, classifyChatGptSendAuthOutcome, classifyPostSubmitProbeState, classifySessionWarmth, classifySubmitOutcome, classifyWarmthRepairEligibility, chooseWarmthRepairKeepTargetId } from "../Consumer/ChatGpt/Session/ChatGptSessionClassifier.js";
import { classifyTargetSelectionSnapshot, compactChatGptTarget, planRootTargetPrune } from "../Consumer/ChatGpt/Target/ChatGptTargetPlanner.js";
import { sanitizeForOutput } from "../Runtime/Browser/BrowserSessionSanitizer.js";

export type BrowserDebugTarget = { id?: string; type?: string; title?: string; url?: string; webSocketDebuggerUrl?: string };
export type ChatGptTarget = BrowserDebugTarget & { port: number; chat_id: string | null; web_socket_debugger_url: string | null; runtime_href?: string | null; runtime_chat_id?: string | null };
export type PromptTransport = "INLINE_TEXT" | "FILE_ATTACHMENT";
export type { DraftVerificationStatus, MismatchClassification } from "../Consumer/ChatGpt/Draft/ChatGptDraftVerifier.js";
export { verifyDraft } from "../Consumer/ChatGpt/Draft/ChatGptDraftVerifier.js";
export { classifyChatGptAuthState, classifyChatGptSendAuthOutcome, classifyPostSubmitProbeState, classifySessionWarmth, classifySubmitOutcome, classifyWarmthRepairEligibility, chooseWarmthRepairKeepTargetId } from "../Consumer/ChatGpt/Session/ChatGptSessionClassifier.js";
export { classifyTargetSelectionSnapshot, compactChatGptTarget, planRootTargetPrune } from "../Consumer/ChatGpt/Target/ChatGptTargetPlanner.js";
export { sanitizeForOutput } from "../Runtime/Browser/BrowserSessionSanitizer.js";

export type BrowserSessionOptions = {
  ports?: number[];
  timeoutMs?: number;
  durationMs?: number;
  targetId?: string;
  chatId?: string;
  title?: string;
  allowOverwrite?: boolean;
  expectedExistingHash?: string;
  allowGuestRootSession?: boolean;
  profileDir?: string;
  keepTargetId?: string;
  confirmCleanup?: boolean;
  confirmRepair?: boolean;
  dryRun?: boolean;
};

type DevToolsWebSocket = { onopen: null | (() => void); onerror: null | ((event: unknown) => void); onmessage: null | ((event: { data: unknown }) => void); close: () => void; send: (data: string) => void };
type DevToolsWebSocketConstructor = new (url: string) => DevToolsWebSocket;
type DevToolsRpcResponse = { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };

const DEFAULT_PORTS = [9222, 9223];
const SMOKE_PROMPT = "Please reply with OK. This is a browser automation smoke test.";
const FILE_ATTACHMENT_INSTRUCTION = "Please read the attached prompt artifact and follow its instructions.";
const PROMPT_TRANSPORT_DIR = path.join("var", "run", "chatgpt-prompt-transport");
const FILE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const FILE_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);

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
    if (!target.web_socket_debugger_url) {
      const rejection = buildCandidateRejection(target, {}, {}, "NEED_DEVTOOLS_WEBSOCKET");
      return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory), reason: "NEED_DEVTOOLS_WEBSOCKET", candidate_rejections: [rejection] };
    }
    if (!isChatGptRootUrl(target.url ?? "") && !target.chat_id) {
      const rejection = buildCandidateRejection(target, {}, {}, "TARGET_NOT_CHATGPT_ROOT_OR_CHAT");
      return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory), reason: "TARGET_NOT_CHATGPT_ROOT_OR_CHAT", candidate_rejections: [rejection] };
    }
    if (isChatGptRootUrl(target.url ?? "") && input.allowOverwrite !== true) {
      const snapshot = await readInputSnapshot(target, timeoutMs);
      const snapshotLength = numberOrNull(snapshot.textLength);
      if (snapshotLength !== null && snapshotLength > 0) {
        const preflight = await inspectComposerPreflightForTarget(target, timeoutMs);
        const rejection = buildCandidateRejection(target, preflight, snapshot, "COMPOSER_NOT_EMPTY");
        return { ok: false, status: "TARGET_SELECTION_REJECTED_COMPOSER_NOT_EMPTY", target: compactChatGptTarget(target), input_snapshot: redactInputSnapshot(snapshot, null), inventory_summary: summarizeInventory(inventory), reason: "COMPOSER_NOT_EMPTY", candidate_rejections: [rejection] };
      }
    }
    return { ok: true, status: "TARGET_SELECTED", target, selected_target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory) };
  }

  if (input.chatId) {
    const target = targets.find((candidate) => candidate.chat_id === input.chatId) ?? await findBestChatGptTargetForChatId(defaultChatGptPorts(input.ports), input.chatId, timeoutMs);
    if (!target) return { ok: false, status: "TARGET_SELECTION_NOT_READY", target: null, inventory_summary: summarizeInventory(inventory), reason: "CHAT_ID_TARGET_NOT_FOUND" };
    return { ok: true, status: "TARGET_SELECTED", target, selected_target: compactChatGptTarget(target), inventory_summary: summarizeInventory(inventory) };
  }

  const clean: ChatGptTarget[] = [];
  const candidateRejections: Array<Record<string, unknown>> = [];
  for (const target of targets.filter((candidate) => isChatGptRootUrl(candidate.url ?? "") && Boolean(candidate.web_socket_debugger_url))) {
    const preflight = await inspectComposerPreflightForTarget(target, timeoutMs);
    const snapshot = await readInputSnapshot(target, timeoutMs);
    const snapshotLength = numberOrNull(snapshot.textLength);
    if (preflight.ok === true && (input.allowOverwrite === true || snapshotLength === 0)) clean.push(target);
    else candidateRejections.push(buildCandidateRejection(target, preflight, snapshot, classifyCandidateRejection(preflight, snapshot, input.allowOverwrite === true)));
  }
  const rejectedComposerNotEmpty = candidateRejections.length === 1 && candidateRejections[0]?.rejection_status === "TARGET_SELECTION_REJECTED_COMPOSER_NOT_EMPTY";
  if (clean.length === 1) return { ok: true, status: "TARGET_SELECTED", target: clean[0], selected_target: compactChatGptTarget(clean[0]), inventory_summary: summarizeInventory(inventory), candidate_rejections: candidateRejections, blocked_candidates: candidateRejections };
  if (clean.length > 1) return { ok: false, status: "TARGET_SELECTION_AMBIGUOUS", target: null, selected_target_candidates: clean.map(compactChatGptTarget), inventory_summary: summarizeInventory(inventory), candidate_rejections: candidateRejections, blocked_candidates: candidateRejections };
  return { ok: false, status: rejectedComposerNotEmpty ? "TARGET_SELECTION_REJECTED_COMPOSER_NOT_EMPTY" : "TARGET_SELECTION_NOT_READY", target: null, selected_target_candidates: [], inventory_summary: summarizeInventory(inventory), candidate_rejections: candidateRejections, blocked_candidates: candidateRejections };
}

export async function inspectComposerPreflight(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  if (input.targetId || input.chatId) {
    const resolvedDirect = await resolveTargetForInspection(input);
    if (!resolvedDirect.ok || !resolvedDirect.target) return { ...resolvedDirect, ok: false, status: String(resolvedDirect.status ?? "PREFLIGHT_TARGET_NOT_READY") };
    return await inspectComposerPreflightForTarget(resolvedDirect.target, normalizeTimeout(input.timeoutMs));
  }
  const resolved = await resolveTarget(input);
  if (!resolved.ok || !resolved.target) return { ...resolved, ok: false, status: String(resolved.status ?? "PREFLIGHT_TARGET_NOT_READY") };
  return await inspectComposerPreflightForTarget(resolved.target, normalizeTimeout(input.timeoutMs));
}

export type ComposerReadinessMode = "draft" | "submit";

export function classifyComposerReadiness(preflight: Record<string, unknown>, mode: ComposerReadinessMode = "draft"): Record<string, unknown> {
  const composer = asRecord(preflight.composer);
  const sendControl = asRecord(preflight.sendControl ?? preflight.send_control);
  const overlay = asRecord(preflight.overlay);
  const rateLimit = asRecord(preflight.rate_limit);
  const authState = asRecord(preflight.auth_state);
  const href = asString(preflight.href);
  const readyState = asString(preflight.readyState);
  const documentReady = readyState === "interactive" || readyState === "complete";
  const chatGptSurface = Boolean(href && href !== "about:blank" && isChatGptUrl(href));
  const retryable = (status: string, reason: string) => ({ ok: false, ready: false, terminal: false, retryable: true, status, reason, mode });
  const terminal = (status: string, reason: string) => ({ ok: false, ready: false, terminal: true, retryable: false, status, reason, mode });

  if (authState.login_required === true) return terminal("COMPOSER_READINESS_AUTH_REQUIRED", "authentication_required");
  if (rateLimit.detected === true) return terminal("COMPOSER_READINESS_RATE_LIMITED", "rate_limit_detected");
  if (overlay.present === true) return terminal("COMPOSER_READINESS_OVERLAY_BLOCKED", "overlay_present");
  if (!chatGptSurface) return retryable("COMPOSER_READINESS_WRONG_SURFACE", href === "about:blank" ? "about_blank" : "chatgpt_surface_not_ready");
  if (!documentReady) return retryable("COMPOSER_READINESS_PAGE_LOADING", "document_not_ready");
  if (composer.found !== true) return retryable("COMPOSER_READINESS_NOT_MOUNTED", "composer_not_found");
  if (composer.visible !== true) return retryable("COMPOSER_READINESS_HIDDEN", "composer_not_visible");
  if (mode === "submit" && sendControl.found !== true) return retryable("COMPOSER_READINESS_SEND_CONTROL_NOT_MOUNTED", "send_control_not_found");
  if (mode === "submit" && sendControl.enabled !== true) return retryable("COMPOSER_READINESS_SEND_CONTROL_DISABLED", "send_control_disabled");

  return { ok: true, ready: true, terminal: false, retryable: false, status: "COMPOSER_READINESS_READY", reason: null, mode };
}

export async function waitForComposerReady(input: BrowserSessionOptions & {
  targetId: string;
  mode?: ComposerReadinessMode;
  maxWaitMs?: number;
  pollMs?: number;
  minStableSamples?: number;
}): Promise<Record<string, unknown>> {
  const mode = input.mode ?? "draft";
  const maxWaitMs = Math.min(Math.max(input.maxWaitMs ?? 15000, 1000), 60000);
  const pollMs = Math.min(Math.max(input.pollMs ?? 400, 100), 5000);
  const minStableSamples = Math.min(Math.max(input.minStableSamples ?? 2, 1), 10);
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  const attempts: Record<string, unknown>[] = [];
  let stableSamples = 0;
  let lastPreflight: Record<string, unknown> = {};
  let lastClassification: Record<string, unknown> = { ok: false, status: "COMPOSER_READINESS_NOT_PROBED" };

  while (Date.now() <= deadline) {
    lastPreflight = await inspectComposerPreflight({ ports: input.ports, targetId: input.targetId, timeoutMs: input.timeoutMs });
    lastClassification = classifyComposerReadiness(lastPreflight, mode);
    const composer = asRecord(lastPreflight.composer);
    const sendControl = asRecord(lastPreflight.sendControl ?? lastPreflight.send_control);
    attempts.push({ attempt: attempts.length + 1, status: lastClassification.status ?? null, reason: lastClassification.reason ?? null, href: lastPreflight.href ?? null, title: lastPreflight.title ?? null, ready_state: lastPreflight.readyState ?? null, composer_found: composer.found === true, composer_visible: composer.visible === true, send_control_found: sendControl.found === true, send_control_enabled: sendControl.enabled === true });
    if (lastClassification.ready === true) {
      stableSamples += 1;
      if (stableSamples >= minStableSamples) return { ok: true, ready: true, status: "COMPOSER_READINESS_READY", mode, target_id: input.targetId, stable_samples: stableSamples, attempt_count: attempts.length, elapsed_ms: Date.now() - startedAt, attempts, classification: lastClassification, preflight: lastPreflight };
    } else {
      stableSamples = 0;
      if (lastClassification.terminal === true) break;
    }
    if (Date.now() < deadline) await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }

  return { ok: false, ready: false, status: lastClassification.terminal === true ? String(lastClassification.status ?? "COMPOSER_READINESS_BLOCKED") : "COMPOSER_READINESS_TIMEOUT", mode, target_id: input.targetId, stable_samples: stableSamples, attempt_count: attempts.length, elapsed_ms: Date.now() - startedAt, attempts, classification: lastClassification, preflight: lastPreflight, retryable: lastClassification.retryable === true };
}

export async function inspectAuthStatus(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const inventory = await inventoryChatGptTargets(input);
  const target = await resolveAuthProbeTarget(input, inventory, timeoutMs);
  if (!target) {
    const authState = buildAuthState({ inventory });
    return { ok: false, status: "CHATGPT_AUTH_TARGET_NOT_READY", auth_state: authState, selected: null, inventory_summary: summarizeInventory(inventory), visible_text_sample: "" };
  }
  const preflight = target.web_socket_debugger_url ? await inspectComposerPreflightForTarget(target, timeoutMs) : {};
  const authState = buildAuthState({ target, preflight, inventory });
  return {
    ok: true,
    status: "CHATGPT_AUTH_STATUS_READY",
    auth_state: authState,
    selected: compactChatGptTarget(target),
    inventory_summary: summarizeInventory(inventory),
    visible_text_sample: asString(preflight.visible_text_sample) ?? "",
    href: preflight.href ?? target.url ?? null,
    title: preflight.title ?? target.title ?? null,
    readyState: preflight.readyState ?? null,
  };
}

export async function inspectSessionWarmth(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const profile = resolveProfileDir(input.profileDir);
  const stateFile = path.join(process.cwd(), "var", "run", "chatgpt-session-warmth.json");
  const inventory = await inventoryChatGptTargets(input);
  const authStatus = await inspectAuthStatus(input);
  const selected = await selectCleanChatGptRootTarget(input);
  const selectedTarget = isChatGptTarget(selected.target) ? selected.target : null;
  const preflight = selectedTarget ? await inspectComposerPreflightForTarget(selectedTarget, timeoutMs) : {};
  const authState = asRecord(authStatus.auth_state);
  const result = classifySessionWarmth({
    profileDir: profile.profile_dir,
    profileSource: profile.profile_source,
    inventory,
    authState,
    selected,
    selectedTarget: selectedTarget ? compactChatGptTarget(selectedTarget) : null,
    visibleTextSample: asString(authStatus.visible_text_sample) ?? asString(preflight.visible_text_sample) ?? "",
    preflight,
    stateFile,
  });
  await persistJson(stateFile, result);
  return result;
}

export async function pruneRootTargets(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const before = await inventoryChatGptTargets(input);
  const plan = planRootTargetPrune(extractPruneCandidateRecords(before), input.keepTargetId, input.confirmCleanup === true, input.dryRun === true);
  if (plan.ok !== true || plan.dry_run === true || asArrayRecords(plan.selected_for_close).length === 0) {
    return { ...plan, before_inventory_summary: summarizeInventory(before), after_inventory_summary: null, closed: [], errors: [], next_action: plan.next_action ?? "chatgpt-session-warmth" };
  }
  const closed: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  for (const item of asArrayRecords(plan.selected_for_close)) {
    const port = numberOrNull(item.port);
    const targetId = asString(item.id);
    if (port === null || targetId === null) {
      errors.push({ target: item, error: "INVALID_TARGET_CLOSE_REQUEST" });
      continue;
    }
    try {
      const body = await closeDevToolsTarget(port, targetId, timeoutMs);
      closed.push({ ok: true, target_id: targetId, port, body });
    } catch (error) {
      errors.push({ target_id: targetId, port, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const after = await inventoryChatGptTargets(input);
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "CHATGPT_ROOT_PRUNE_DONE" : "CHATGPT_ROOT_PRUNE_FAILED",
    dry_run: false,
    keep_target_id: input.keepTargetId ?? null,
    before_inventory_summary: summarizeInventory(before),
    selected_for_close: plan.selected_for_close,
    closed,
    after_inventory_summary: summarizeInventory(after),
    errors,
    next_action: "chatgpt-session-warmth",
  };
}

export async function repairSessionWarmth(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const beforeWarmth = await inspectSessionWarmth(input);
  const eligibility = classifyWarmthRepairEligibility(beforeWarmth);
  if (eligibility.status === "CHATGPT_SESSION_WARMTH_REPAIR_NOOP") {
    return {
      ok: true,
      status: "CHATGPT_SESSION_WARMTH_REPAIR_NOOP",
      before_warmth: beforeWarmth,
      repair_action: "none",
      keep_target_id: null,
      prune_result: null,
      after_warmth: beforeWarmth,
    };
  }
  if (eligibility.status === "CHATGPT_SESSION_WARMTH_REPAIR_NOT_APPLICABLE") {
    return {
      ok: beforeWarmth.ok === true,
      status: "CHATGPT_SESSION_WARMTH_REPAIR_NOT_APPLICABLE",
      before_warmth: beforeWarmth,
      repair_action: "none",
      keep_target_id: null,
      prune_result: null,
      after_warmth: beforeWarmth,
    };
  }
  if (eligibility.ok !== true) {
    return buildWarmthRepairSkipped(String(eligibility.status), beforeWarmth, String(eligibility.repair_skip_reason ?? "not_eligible"));
  }

  const inventory = await inventoryChatGptTargets(input);
  const keep = chooseWarmthRepairKeepTargetId(inventory, beforeWarmth);
  const keepTargetId = asString(keep.keep_target_id);
  if (!keepTargetId) {
    return buildWarmthRepairSkipped("CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_KEEP_TARGET_UNRESOLVED", beforeWarmth, "keep_target_unresolved");
  }
  const confirmed = input.confirmRepair === true;
  const pruneResult = await pruneRootTargets({
    ...input,
    keepTargetId,
    confirmCleanup: confirmed,
    dryRun: input.dryRun === true || !confirmed,
  });
  const afterWarmth = confirmed && pruneResult.dry_run !== true ? await inspectSessionWarmth(input) : beforeWarmth;
  return {
    ok: afterWarmth.ok === true,
    status: afterWarmth.ok === true ? "CHATGPT_SESSION_WARMTH_REPAIR_DONE" : (confirmed ? "CHATGPT_SESSION_WARMTH_REPAIR_ATTEMPTED" : "CHATGPT_SESSION_WARMTH_REPAIR_DRY_RUN"),
    before_warmth: beforeWarmth,
    repair_action: "prune_duplicate_root_targets",
    keep_target_id: keepTargetId,
    keep_reason: keep.keep_reason,
    prune_result: pruneResult,
    after_warmth: afterWarmth,
  };
}

async function inspectComposerPreflightForTarget(target: ChatGptTarget, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: compactChatGptTarget(target) };
  const probe = await safeEvaluateInTarget(target.web_socket_debugger_url, buildComposerPreflightExpression(), Math.min(timeoutMs, 2000), "COMPOSER_PREFLIGHT_EVALUATION_FAILED");
  const record = asRecord(probe);
  const overlay = asRecord(record.overlay);
  const composer = asRecord(record.composer);
  const sendControl = asRecord(record.sendControl);
  const rateLimit = await detectRateLimitForTarget(target, timeoutMs);
  const overlayPresent = overlay.present === true;
  const composerReady = composer.found === true && composer.visible === true;
  const sendReady = sendControl.found === true && sendControl.enabled === true;
  const rateLimited = rateLimit.detected === true;
  const ready = record.ok === true && !overlayPresent && composerReady && sendReady && !rateLimited;
  const result = {
    ok: ready,
    status: ready ? "COMPOSER_PREFLIGHT_READY" : (rateLimited ? "COMPOSER_PREFLIGHT_BLOCKED_RATE_LIMIT" : (overlayPresent ? "COMPOSER_PREFLIGHT_BLOCKED_OVERLAY" : String(record.status ?? "COMPOSER_PREFLIGHT_BLOCKED"))),
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
    rate_limit: rateLimit,
    temporary_chat: record.temporary_chat ?? null,
    probe: record,
  };
  return { ...result, auth_state: buildAuthState({ target, preflight: result }) };
}

const chatGptPromptDraft = createChatGptPromptDraft({
  resolveTarget,
  readInputSnapshot,
  safeEvaluateInTarget,
  safeSendDevToolsCommand,
  buildComposerFocusExpression,
  compactChatGptTarget,
  redactInputSnapshot,
  normalizeTimeout,
});

export const draftInput = chatGptPromptDraft.draftInput;
export const verifyDraftInTarget = chatGptPromptDraft.verifyDraftInTarget;

export type ComposerOwnershipClassification = "EMPTY" | "EXACT_EXPECTED" | "OWN_PARTIAL_PREFIX" | "FOREIGN_TEXT";

export function normalizeComposerOwnershipText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function hashComposerOwnershipText(value: string): string | null {
  const normalized = normalizeComposerOwnershipText(value);
  return normalized.length > 0 ? hashChatGptArtifactText(normalized) : null;
}

export function classifyComposerOwnership(currentText: string, expectedText: string): Record<string, unknown> {
  const normalize = normalizeComposerOwnershipText;
  const current = normalize(currentText);
  const expected = normalize(expectedText);
  const classification: ComposerOwnershipClassification = current.length === 0
    ? "EMPTY"
    : (current === expected
      ? "EXACT_EXPECTED"
      : (current.length >= 16 && expected.startsWith(current) ? "OWN_PARTIAL_PREFIX" : "FOREIGN_TEXT"));
  return {
    ok: true,
    status: "COMPOSER_OWNERSHIP_CLASSIFIED",
    ownership_classification: classification,
    safe_to_attach: classification === "EMPTY" || classification === "EXACT_EXPECTED",
    draft_required: classification === "EMPTY",
    draft_already_present: classification === "EXACT_EXPECTED",
    composer_text_length: current.length,
    composer_text_hash: current.length > 0 ? hashChatGptArtifactText(current) : null,
    expected_text_length: expected.length,
    expected_text_hash: expected.length > 0 ? hashChatGptArtifactText(expected) : null,
    retryable: false,
  };
}

export async function inspectComposerOwnership(input: BrowserSessionOptions & { expectedText: string }): Promise<Record<string, unknown>> {
  const selected = await resolveTargetForInspection(input);
  if (!selected.ok || !selected.target) {
    return { ok: false, status: selected.status, ownership_classification: null, safe_to_attach: false, retryable: true };
  }
  const snapshot = await readInputSnapshot(selected.target, normalizeTimeout(input.timeoutMs));
  if (snapshot.ok !== true) {
    return { ...snapshot, ok: false, ownership_classification: null, safe_to_attach: false, retryable: true, selected: compactChatGptTarget(selected.target) };
  }
  const text = asString(snapshot.text) ?? "";
  const classified = classifyComposerOwnership(text, input.expectedText);
  return {
    ...classified,
    selected: compactChatGptTarget(selected.target),
    target_id: selected.target.id ?? null,
    port: selected.target.port,
    target_fingerprint: snapshot.targetFingerprint ?? null,
    candidate_count: snapshot.candidateCount ?? null,
    visible_candidate_count: snapshot.visibleCandidateCount ?? null,
    non_empty_visible_candidate_count: snapshot.nonEmptyVisibleCandidateCount ?? null,
    href: snapshot.href ?? selected.target.url ?? null,
    ready_state: snapshot.readyState ?? null,
  };
}

function verifyAttachmentInstructionDraft(draftResult: Record<string, unknown>, expected: string): Record<string, unknown> {
  // draftResult.ok / draftResult.draft_verification come from a REAL DOM read inside draftInput()
  // (readInputSnapshot -> verifyDraft). The nested draftResult.draft.activeText/afterText fields
  // are only an echo of the *requested* text (set equal to input.prompt by construction whenever
  // typing was attempted at all), so comparing against them can never actually detect a typing
  // failure or DOM mismatch - it can only tell us draftInput() reached the typing step. Trust the
  // real, DOM-sourced verification first; only fall back to "not attempted" when draftInput()
  // bailed out before typing (no nested .draft object at all).
  const reachedTyping = draftResult && typeof draftResult === "object" && "draft" in draftResult;
  if (reachedTyping) {
    const draftVerification = String(draftResult.draft_verification ?? "");
    const ok = draftResult.ok === true && draftVerification !== "MISMATCH";
    return {
      ok,
      status: ok ? "ATTACHMENT_INSTRUCTION_CONFIRMED" : "ATTACHMENT_INSTRUCTION_MISMATCH",
      expected_length: expected.length,
      draft_ok: draftResult.ok === true,
      draft_verification: draftVerification || null,
      mismatch_classification: draftResult.mismatch_classification ?? null,
      verified_via: "dom_read",
    };
  }
  return {
    ok: false,
    status: "ATTACHMENT_INSTRUCTION_NOT_ATTEMPTED",
    expected_length: expected.length,
    draft_ok: false,
    draft_verification: null,
    mismatch_classification: null,
    verified_via: "pretype_guard",
    pretype_status: String(draftResult.status ?? "UNKNOWN"),
  };
}

const ATTACHMENT_INSTRUCTION_RETRY_STATUSES = new Set([
  "COMPOSER_NOT_READY",
  "COMPOSER_NOT_EMPTY",
  "NEED_DEVTOOLS_WEBSOCKET",
  "INPUT_FOCUS_BLOCKED",
  "INPUT_DRAFT_TARGET_NOT_READY",
]);

// The composer DOM node can be transiently unmounted/remounted right after the attachment chip
// appears (React re-renders the composer form once the file-attached state lands). draftInput()
// landing in that window sees zero matching selectors and bails with a pre-typing guard status -
// this is exactly the "sometimes CMCP_GO_DRAFT_BLOCKED" flakiness. Retry a few times with a short
// settle delay before giving up, but only for statuses that are plausibly a timing race; anything
// else (e.g. an actual DOM mismatch reported by draftInput itself) fails immediately.
async function draftInputWithSettleRetry(
  args: BrowserSessionOptions & { prompt: string },
  attempts = 4,
  intervalMs = 350,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = { ok: false, status: "ATTACHMENT_INSTRUCTION_DRAFT_NOT_ATTEMPTED" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await draftInput(args);
    if (last.ok === true) return { ...last, settle_attempts: attempt };
    const status = String(last.status ?? "");
    if (!ATTACHMENT_INSTRUCTION_RETRY_STATUSES.has(status)) return { ...last, settle_attempts: attempt };
    if (attempt < attempts) await delay(intervalMs);
  }
  return { ...last, settle_attempts: attempts };
}

async function waitForSubmitControlReady(webSocketUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  const waitMs = Math.min(Math.max(timeoutMs, 30000), 120000);
  const deadline = started + waitMs;
  let attempts = 0;
  let finalControl: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    attempts++;
    const control = await safeEvaluateInTarget(webSocketUrl, buildSubmitControlProbeExpression(), Math.min(waitMs, 1000), "CONTROL_PROBE_EVALUATION_FAILED");
    finalControl = asRecord(control);
    const found = finalControl.found === true;
    const enabled = finalControl.enabled === true;
    const disabled = finalControl.disabled === true;
    if (found && enabled && !disabled) {
      return {
        ok: true,
        status: "SUBMIT_CONTROL_READY",
        attempts,
        elapsed_ms: Date.now() - started,
        final_control: finalControl,
      };
    }
    await delay(500);
  }
  return {
    ok: false,
    status: "SUBMIT_CONTROL_WAIT_TIMEOUT",
    attempts,
    elapsed_ms: Date.now() - started,
    final_control: finalControl ?? null,
  };
}

const chatGptPromptSubmit = createChatGptPromptSubmit({
  inventoryChatGptTargets,
  selectCleanChatGptRootTarget,
  resolveTarget,
  inspectComposerPreflight,
  inspectAuthStatus,
  detectRateLimitForTarget,
  draftInput,
  verifyDraftInTarget,
  captureMessages,
  resolveChatGptDocumentTargetWithChatId,
  safeEvaluateInTarget,
  safeSendDevToolsCommand,
  buildSubmitControlProbeExpression,
  buildComposerEmptyProbeExpression,
  buildSendExpression,
  buildPostSubmitProbeExpression,
  buildSendOutcome,
  compactChatGptTarget,
  isChatGptRootUrl,
  normalizeTimeout,
  delay,
  smokePrompt: SMOKE_PROMPT,
});

export const submitDraft = chatGptPromptSubmit.submitDraft;
export const resolvePostSubmitState = chatGptPromptSubmit.resolvePostSubmitState;
export const sendPrompt = chatGptPromptSubmit.sendPrompt;
export const sendSmoke = chatGptPromptSubmit.sendSmoke;

function compactTransportState(input: {
  status: string;
  filePath?: string | null;
  fileName?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  attached?: boolean;
  confirmed?: boolean;
  retryable?: boolean;
  nextAction?: string | null;
  cleanup?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    transport_mode: "FILE_ATTACHMENT",
    status: input.status,
    file_path: input.filePath ?? null,
    file_name: input.fileName ?? null,
    sha256: input.sha256 ?? null,
    size_bytes: input.sizeBytes ?? null,
    attached: input.attached === true,
    confirmed: input.confirmed === true,
    retryable: input.retryable === true,
    next_action: input.nextAction ?? null,
  };
  if (input.cleanup) state.cleanup = input.cleanup;
  return state;
}

async function preparePromptAttachmentArtifact(sourceFilePath: string): Promise<Record<string, unknown>> {
  const sourcePath = path.resolve(sourceFilePath);
  const ext = path.extname(sourcePath).toLowerCase();
  if (!FILE_ATTACHMENT_EXTENSIONS.has(ext)) {
    return compactTransportState({ status: "FILE_ATTACHMENT_UNSUPPORTED_TYPE", filePath: sourcePath, fileName: path.basename(sourcePath), retryable: false, nextAction: "use a .txt, .md, or .markdown prompt file" });
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(sourcePath);
  } catch {
    return compactTransportState({ status: "FILE_ATTACHMENT_MISSING", filePath: sourcePath, fileName: path.basename(sourcePath), retryable: true, nextAction: "provide an existing prompt file" });
  }
  if (!fileStat.isFile()) return compactTransportState({ status: "FILE_ATTACHMENT_NOT_FILE", filePath: sourcePath, fileName: path.basename(sourcePath), retryable: false, nextAction: "provide a regular prompt file" });
  if (fileStat.size <= 0) return compactTransportState({ status: "FILE_ATTACHMENT_EMPTY", filePath: sourcePath, fileName: path.basename(sourcePath), sizeBytes: fileStat.size, retryable: true, nextAction: "write prompt content before sending" });
  if (fileStat.size > FILE_ATTACHMENT_MAX_BYTES) return compactTransportState({ status: "FILE_ATTACHMENT_TOO_LARGE", filePath: sourcePath, fileName: path.basename(sourcePath), sizeBytes: fileStat.size, retryable: false, nextAction: `keep prompt artifact at or below ${FILE_ATTACHMENT_MAX_BYTES} bytes` });

  const bytes = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const fileName = `prompt-${sha256}${ext}`;
  const artifactDir = path.resolve(process.cwd(), PROMPT_TRANSPORT_DIR);
  const artifactPath = path.join(artifactDir, fileName);
  await mkdir(artifactDir, { recursive: true });
  if (path.normalize(sourcePath).toLowerCase() !== path.normalize(artifactPath).toLowerCase()) {
    await copyFile(sourcePath, artifactPath);
  }
  return compactTransportState({ status: "FILE_ATTACHMENT_READY", filePath: artifactPath, fileName, sha256, sizeBytes: bytes.length, retryable: false, nextAction: "attach prompt artifact" });
}

export async function sendPromptFileAttachment(input: BrowserSessionOptions & { promptArtifactFilePath: string; instruction?: string; confirmSend?: boolean }): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const preparedTransport = await preparePromptAttachmentArtifact(input.promptArtifactFilePath);
  if (preparedTransport.status !== "FILE_ATTACHMENT_READY") {
    return {
      ok: false,
      status: "CHATGPT_PROMPT_TRANSPORT_REJECTED",
      submitted: false,
      prompt_transport: "FILE_ATTACHMENT",
      transport_mode: "FILE_ATTACHMENT",
      prompt_transport_state: preparedTransport,
      nextAction: preparedTransport.next_action ?? null,
      timestamps: { started_at: startedAt, ended_at: new Date().toISOString() },
      timeout_ms: timeoutMs,
    };
  }
  const inventory = await inventoryChatGptTargets(input);
  const selected = await selectCleanChatGptRootTarget(input);
  const target = selected.target as ChatGptTarget | undefined;
  const beforeUrl = target?.url ?? null;
  if (!selected.ok || !target) return buildSendOutcome({ ok: false, status: selected.status === "TARGET_SELECTION_AMBIGUOUS" ? "CHATGPT_SEND_TARGET_AMBIGUOUS" : "CHATGPT_SEND_TARGET_NOT_READY", selected, inventory, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: preparedTransport });
  const preflight = await inspectComposerPreflight({ ...input, targetId: target.id, timeoutMs });
  const authStatus = await inspectAuthStatus({ ...input, targetId: target.id, timeoutMs });
  const authState = asRecord(authStatus.auth_state);
  if (authState.login_required === true && input.allowGuestRootSession !== true) {
    return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_AUTH_REQUIRED", selected, inventory, preflight, authStatus, timeoutMs, startedAt, beforeUrl, submittedFlag: false, nextAction: "login in the supervised browser profile or rerun with explicit AllowGuestRootSession", promptTransport: "FILE_ATTACHMENT", promptTransportState: preparedTransport });
  }
  if (asRecord(preflight.rate_limit).detected === true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_RATE_LIMIT_BLOCKED", selected, inventory, preflight, authStatus, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: preparedTransport });
  if (asRecord(preflight.overlay).present === true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_OVERLAY_BLOCKED", selected, inventory, preflight, authStatus, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: preparedTransport });
  if (preflight.ok !== true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_PREFLIGHT_BLOCKED", selected, inventory, preflight, authStatus, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: preparedTransport });

  const artifactPath = String(preparedTransport.file_path ?? "");
  const attachment = await attachPromptFile({ ...input, targetId: target.id, filePath: artifactPath, fileSha256: String(preparedTransport.sha256 ?? ""), fileSizeBytes: numberOrNull(preparedTransport.size_bytes) ?? undefined, timeoutMs });
  const attachmentTransportState = asRecord(attachment.prompt_transport_state);
  const transportState = attachmentTransportState.status ? attachmentTransportState : preparedTransport;
  if (transportState.status !== "FILE_ATTACHMENT_CONFIRMED") return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_ATTACHMENT_BLOCKED", selected, inventory, preflight, authStatus, attachment, timeoutMs, startedAt, beforeUrl, submittedFlag: false, promptTransport: "FILE_ATTACHMENT", promptTransportState: transportState });

  const instruction = String(input.instruction || FILE_ATTACHMENT_INSTRUCTION).trim() || FILE_ATTACHMENT_INSTRUCTION;
  const draft = await draftInputWithSettleRetry({ ...input, targetId: target.id, prompt: instruction, timeoutMs });
  const attachmentInstructionVerification = verifyAttachmentInstructionDraft(draft, instruction);
  const attachmentDraft = {
    ...draft,
    ok: attachmentInstructionVerification.ok === true,
    status: attachmentInstructionVerification.ok === true ? "INPUT_DRAFT_WRITTEN" : "INPUT_DRAFT_BLOCKED",
    draft_verification: attachmentInstructionVerification.status,
    attachment_instruction_verification: attachmentInstructionVerification,
    inline_verification: draft.verification ?? null,
  };
  if (attachmentInstructionVerification.ok !== true) return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_DRAFT_BLOCKED", selected, inventory, preflight, authStatus, draft: attachmentDraft, attachment, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: transportState });
  if (input.confirmSend !== true) return buildSendOutcome({ ok: false, status: "CONFIRM_CHATGPT_SEND_REQUIRED", selected, inventory, preflight, authStatus, draft: attachmentDraft, attachment, timeoutMs, startedAt, beforeUrl, promptTransport: "FILE_ATTACHMENT", promptTransportState: transportState });

  const submitControlWait = target.web_socket_debugger_url
    ? await waitForSubmitControlReady(target.web_socket_debugger_url, timeoutMs)
    : { ok: false, status: "SUBMIT_CONTROL_WAIT_WEBSOCKET_MISSING", attempts: 0, elapsed_ms: 0, final_control: null };
  if (asRecord(submitControlWait).ok !== true) {
    const submitted: Record<string, unknown> = { ok: false, status: "SUBMIT_CONTROL_NOT_READY", submitted: false, submit_control_wait: submitControlWait };
    return buildSendOutcome({ ok: false, status: "CHATGPT_SEND_SUBMIT_CONTROL_TIMEOUT", selected, inventory, preflight, authStatus, draft: attachmentDraft, attachment, submitted, timeoutMs, startedAt, beforeUrl, submittedFlag: false, nextAction: "wait for ChatGPT submit control to become enabled or inspect upload/indexing state", promptTransport: "FILE_ATTACHMENT", promptTransportState: transportState });
  }

  const submittedResult = await submitDraft({ ...input, targetId: target.id, confirmSubmit: true, timeoutMs });
  const submitted: Record<string, unknown> = { ...submittedResult, submit_control_wait: submitControlWait };
  const resolved = target.id ? await resolveChatGptDocumentTargetWithChatId(target.port, target.id, Math.min(Math.max(timeoutMs, 30000), 60000)) : null;
  const finalTarget = resolved ?? target;
  const messages = await captureMessages({ ...input, targetId: target.id, requireChatId: false, timeoutMs });
  const afterUrl = finalTarget.runtime_href ?? finalTarget.url ?? asString(asRecord(submitted.post_submit).href) ?? null;
  const chatId = finalTarget.runtime_chat_id ?? finalTarget.chat_id ?? (afterUrl ? extractChatGptChatId(afterUrl) : null) ?? asString(asRecord(submitted.post_submit).chat_id);
  const durable = submitted.submitted === true || Boolean(chatId) || numberOrZero(messages.user_message_count) > 0 || numberOrZero(messages.assistant_message_count) > 0;
  const rootUnconfirmed = isChatGptRootUrl(afterUrl ?? "") && !durable;
  const authenticated = authState.authenticated === true;
  const guestDone = input.allowGuestRootSession === true && authState.guest_mode === true && durable;
  const persistentDone = authenticated && Boolean(chatId) && durable;
  return buildSendOutcome({
    ok: persistentDone || guestDone,
    status: persistentDone ? "CHATGPT_SEND_DONE" : (guestDone ? "CHATGPT_SEND_GUEST_DONE" : (submitted.ok === true && !rootUnconfirmed ? "CHATGPT_SEND_SUBMIT_UNCONFIRMED" : "CHATGPT_SEND_SUBMIT_BLOCKED")),
    selected, inventory, preflight, authStatus, draft: attachmentDraft, attachment, submitted, messages, resolved, timeoutMs, startedAt, beforeUrl, afterUrl, chatId, promptTransport: "FILE_ATTACHMENT", promptTransportState: transportState,
  });
}

export async function attachPromptFile(input: BrowserSessionOptions & { filePath: string; fileSha256?: string; fileSizeBytes?: number }): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const selected = await resolveTarget(input);
  const absolutePath = path.resolve(input.filePath);
  const fileName = path.basename(absolutePath);
  const baseState = { filePath: absolutePath, fileName, sha256: input.fileSha256 ?? null, sizeBytes: input.fileSizeBytes ?? null };
  if (!selected.ok || !selected.target) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_TARGET_NOT_READY", retryable: true, nextAction: "open a clean ChatGPT root target" });
    return { ...selected, ok: false, status: "CHATGPT_ATTACHMENT_TARGET_NOT_READY", prompt_transport_state: state };
  }
  const target = selected.target;
  if (!target.web_socket_debugger_url) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_WEBSOCKET_MISSING", retryable: true, nextAction: "select a ChatGPT target with a DevTools websocket" });
    return { ok: false, status: "CHATGPT_ATTACHMENT_WEBSOCKET_MISSING", selected: compactChatGptTarget(target), prompt_transport_state: state };
  }

  const cleanup = await cleanupStalePromptAttachments(target.web_socket_debugger_url, fileName, Math.min(timeoutMs, 2500));
  const cleanupRecord = asRecord(cleanup);
  if (cleanupRecord.status === "FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_PARTIAL" || cleanupRecord.status === "FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_FAILED") {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE", attached: false, confirmed: false, retryable: true, nextAction: "open a fresh ChatGPT root or manually remove stale prompt attachment chips", cleanup: cleanupRecord });
    return { ok: false, status: "CHATGPT_PROMPT_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE", selected: compactChatGptTarget(target), cleanup: cleanupRecord, input_discovery: { cleanup: cleanupRecord }, prompt_transport_state: state };
  }

  const duplicate = await safeEvaluateInTarget(target.web_socket_debugger_url, buildAttachmentComposerStateExpression(fileName, input.fileSha256 ?? null), Math.min(timeoutMs, 1000), "CHATGPT_ATTACHMENT_DUPLICATE_PROBE_FAILED");
  const duplicateRecord = asRecord(duplicate);
  if (duplicateRecord.multiple_prompt_files_visible === true) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE", attached: true, confirmed: false, retryable: true, nextAction: "open a fresh ChatGPT root or manually remove stale prompt attachment chips", cleanup: cleanupRecord });
    return { ok: false, status: "CHATGPT_PROMPT_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE", selected: compactChatGptTarget(target), cleanup: cleanupRecord, input_discovery: { cleanup: cleanupRecord }, prompt_transport_state: state, duplicate_probe: duplicate };
  }
  if (duplicateRecord.duplicate === true) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_CONFIRMED", attached: true, confirmed: true, retryable: false, nextAction: "submit prompt", cleanup: cleanupRecord });
    return { ok: true, status: "CHATGPT_PROMPT_ATTACHMENT_ALREADY_CONFIRMED", selected: compactChatGptTarget(target), cleanup: cleanupRecord, prompt_transport_state: state, duplicate_probe: duplicate };
  }
  if (duplicateRecord.upload_error === true) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_UPLOAD_ERROR_VISIBLE", retryable: true, nextAction: "clear visible upload error and retry", cleanup: cleanupRecord });
    return { ok: false, status: "CHATGPT_ATTACHMENT_UPLOAD_ERROR_VISIBLE", selected: compactChatGptTarget(target), cleanup: cleanupRecord, prompt_transport_state: state, duplicate_probe: duplicate };
  }

  const probe = await safeEvaluateInTarget(target.web_socket_debugger_url, buildFileInputProbeExpression(), Math.min(timeoutMs, 2000), "CHATGPT_ATTACHMENT_INPUT_PROBE_FAILED");
  const inputSession = await setFileInputFilesInDomSession(target.web_socket_debugger_url, absolutePath, timeoutMs);
  const inputDiscovery = { probe, cleanup: cleanupRecord, ...asRecord(inputSession.input_discovery) };
  if (inputSession.status === "CHATGPT_ATTACHMENT_DOM_ENABLE_FAILED") {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_INPUT_NOT_READY", retryable: true, nextAction: "retry after DOM domain is enabled" });
    return { ok: false, status: "CHATGPT_ATTACHMENT_INPUT_NOT_READY", selected: compactChatGptTarget(target), input_discovery: inputDiscovery, prompt_transport_state: state };
  }
  if (inputSession.status === "CHATGPT_ATTACHMENT_INPUT_OBJECT_ID_MISSING") {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_INPUT_NOT_READY", retryable: true, nextAction: "retry after file input is available" });
    return { ok: false, status: "CHATGPT_ATTACHMENT_INPUT_OBJECT_ID_MISSING", selected: compactChatGptTarget(target), file_path: absolutePath, input_discovery: inputDiscovery, prompt_transport_state: state };
  }
  const setFiles = asRecord(inputSession.set_files);
  if (setFiles.ok !== true) {
    const state = compactTransportState({ ...baseState, status: "FILE_ATTACHMENT_SET_FILES_FAILED", retryable: true, nextAction: "retry DOM.setFileInputFiles" });
    return { ok: false, status: "CHATGPT_ATTACHMENT_SET_FILES_FAILED", selected: compactChatGptTarget(target), file_path: absolutePath, file_name: fileName, input_discovery: inputDiscovery, set_files: setFiles, prompt_transport_state: state };
  }
  const confirmation = await waitForAttachmentConfirmation(target.web_socket_debugger_url, fileName, input.fileSha256 ?? null, Math.min(Math.max(timeoutMs, 3000), 15000));
  const confirmed = asRecord(confirmation).ok === true;
  const uploadError = asRecord(confirmation).upload_error === true;
  const multiplePromptFiles = asRecord(confirmation).multiple_prompt_files_visible === true;
  const state = compactTransportState({
    ...baseState,
    status: multiplePromptFiles ? "FILE_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE" : (confirmed ? "FILE_ATTACHMENT_CONFIRMED" : (uploadError ? "FILE_ATTACHMENT_UPLOAD_ERROR_VISIBLE" : "FILE_ATTACHMENT_NOT_CONFIRMED")),
    attached: true,
    confirmed: confirmed && !multiplePromptFiles,
    retryable: multiplePromptFiles || !confirmed,
    nextAction: multiplePromptFiles ? "cleanup dirty root before attaching prompt file" : (confirmed ? "submit prompt" : (uploadError ? "clear visible upload error and retry" : "retry attachment or inspect ChatGPT DOM")),
    cleanup: cleanupRecord,
  });
  return { ok: confirmed && !multiplePromptFiles, status: multiplePromptFiles ? "CHATGPT_PROMPT_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE" : (confirmed ? "CHATGPT_PROMPT_ATTACHMENT_READY" : (uploadError ? "CHATGPT_PROMPT_ATTACHMENT_UPLOAD_ERROR" : "CHATGPT_PROMPT_ATTACHMENT_NOT_CONFIRMED")), selected: compactChatGptTarget(target), file_path: absolutePath, file_name: fileName, cleanup: cleanupRecord, input_discovery: inputDiscovery, set_files: setFiles, confirmation, prompt_transport_state: state };
}

export async function traceChatGptRenameNetwork(input: BrowserSessionOptions = {}): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) ? Math.min(Math.max(Math.trunc(input.durationMs), 1000), 120000) : 30000;
  const inventory = await inventoryChatGptTargets(input);
  const records = uniqueTargetRecords([...asArrayRecords(inventory.chat_targets), ...asArrayRecords(inventory.targets), ...asArrayRecords(inventory.auth_login_settings_targets)]);
  const selectedRecord = input.targetId ? records.find((target) => asString(target.id) === input.targetId) : (input.chatId ? records.find((target) => asString(target.chat_id) === input.chatId) : records.find((target) => Boolean(asString(target.chat_id))));
  const traceRecords = input.targetId || input.chatId ? (selectedRecord ? [selectedRecord] : []) : records;
  if (traceRecords.length === 0) return { ok: false, status: "CHATGPT_RENAME_TRACE_TARGET_NOT_READY", inventory_summary: summarizeInventory(inventory) };
  const targets = (await Promise.all(traceRecords.map(async (record) => {
    const id = asString(record.id);
    if (!id) return null;
    return await findDevToolsTargetById(defaultChatGptPorts(input.ports), id, timeoutMs);
  }))).filter(isChatGptTarget).filter((target) => Boolean(target.web_socket_debugger_url));
  if (targets.length === 0) return { ok: false, status: "CHATGPT_RENAME_TRACE_WEBSOCKET_MISSING", selected_record: selectedRecord ?? null, inventory_summary: summarizeInventory(inventory), trace_target_count: 0 };
  const traces = await Promise.all(targets.map(async (target) => ({ target: compactChatGptTarget(target), trace: await traceNetworkInTarget(target.web_socket_debugger_url ?? "", durationMs, timeoutMs) })));
  const eventCount = traces.reduce((sum, item) => sum + numberOrZero(asRecord(item.trace).event_count), 0);
  const rawEventCount = traces.reduce((sum, item) => sum + numberOrZero(asRecord(item.trace).raw_event_count), 0);
  return { ok: true, status: "CHATGPT_RENAME_NETWORK_TRACE_DONE", selected: selectedRecord ?? null, duration_ms: durationMs, inventory_summary: summarizeInventory(inventory), trace_target_count: targets.length, event_count: eventCount, raw_event_count: rawEventCount, traces };
}

export async function renameLatestConversation(input: BrowserSessionOptions & { title: string }): Promise<Record<string, unknown>> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const desiredTitle = String(input.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!desiredTitle) return { ok: false, status: "CHATGPT_RENAME_TITLE_REQUIRED" };
  const inventory = await inventoryChatGptTargets(input);
  const records = uniqueTargetRecords([
    ...asArrayRecords(inventory.chat_targets),
    ...asArrayRecords(inventory.root_targets),
    ...asArrayRecords(inventory.targets),
    ...asArrayRecords(inventory.empty_home_targets),
  ]);
  const selectedRecord = records.find((target) => Boolean(asString(target.chat_id))) ?? records.find((target) => isChatGptRootUrl(asString(target.url) ?? "")) ?? records[0] ?? null;
  const selectedId = asString(selectedRecord?.id);
  if (!selectedId) return { ok: false, status: "CHATGPT_RENAME_TARGET_NOT_READY", inventory_summary: summarizeInventory(inventory) };
  const selected = await findDevToolsTargetById(defaultChatGptPorts(input.ports), selectedId, timeoutMs);
  if (!selected) return { ok: false, status: "CHATGPT_RENAME_TARGET_NOT_FOUND", selected_record: selectedRecord, inventory_summary: summarizeInventory(inventory) };
  if (!selected.web_socket_debugger_url) return { ok: false, status: "CHATGPT_RENAME_TARGET_WEBSOCKET_MISSING", selected: compactChatGptTarget(selected), inventory_summary: summarizeInventory(inventory) };
  const result = await safeEvaluateInTarget(selected.web_socket_debugger_url, buildRenameLatestConversationExpression(desiredTitle, asString((selected as unknown as Record<string, unknown>).chat_id)), Math.max(timeoutMs, 60000), "CHATGPT_RENAME_EVALUATION_FAILED");
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
  return { ok: exactConfirmed, status: exactConfirmed ? "CHATGPT_RENAME_CONFIRMED" : (refreshSyncedDifferent ? "CHATGPT_RENAME_SYNCED_DIFFERENT_CANONICAL_TITLE" : (patchUnconfirmed ? (uiFallbackAttempted ? "CHATGPT_RENAME_PATCH_UNCONFIRMED_AFTER_UI_FALLBACK" : (refreshAttempted ? "CHATGPT_RENAME_PATCH_UNCONFIRMED_AFTER_REFRESH" : "CHATGPT_RENAME_PATCH_UNCONFIRMED")) : (visibleOnly ? "CHATGPT_RENAME_VISIBLE_ONLY" : (record.ok === true ? "CHATGPT_RENAME_UNCONFIRMED" : "CHATGPT_RENAME_FAILED")))), desired_title: desiredTitle, selected: compactChatGptTarget(selected), inventory_summary: summarizeInventory(inventory), rename: result, patch_confirmation: patchConfirmation, confirmation, backend_confirmation: backendConfirmation, refresh_confirmation: refreshConfirmation, ui_fallback: uiFallback };
}

async function confirmChatGptRenamePatch(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_RENAME_PATCH_WEBSOCKET_MISSING" };
  const chatId = target.chat_id;
  if (!chatId) return { ok: false, status: "CHAT_TITLE_RENAME_PATCH_CHAT_ID_MISSING" };
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10000);
  let last: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    const value = await safeEvaluateInTarget(target.web_socket_debugger_url, buildRenamePatchStateExpression(chatId, desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_RENAME_PATCH_EVALUATION_FAILED");
    last = asRecord(value);
    if (last.status === "CHAT_TITLE_RENAME_PATCH_SUCCEEDED" || last.status === "CHAT_TITLE_RENAME_PATCH_FAILED" || last.status === "CHAT_TITLE_RENAME_PATCH_ABORTED" || last.status === "CHAT_TITLE_RENAME_PATCH_ERROR") return last;
    await delay(250);
  }
  return last ?? { ok: false, status: "CHAT_TITLE_RENAME_PATCH_TIMEOUT", chat_id: chatId, desired_title: desiredTitle };
}

async function refreshChatGptTitleState(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_REFRESH_SYNC_WEBSOCKET_MISSING" };
  const before = await safeEvaluateInTarget(target.web_socket_debugger_url, buildTitleConfirmationExpression(desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_REFRESH_BEFORE_EVALUATION_FAILED");
  const reload = await safeSendDevToolsCommand(target.web_socket_debugger_url, "Page.reload", { ignoreCache: true }, Math.min(Math.max(timeoutMs, 3000), 10000), "CHAT_TITLE_REFRESH_RELOAD_FAILED");
  await delay(1500);
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
  const attempt = await safeEvaluateInTarget(target.web_socket_debugger_url, buildSidebarUiRenameExpression(chatId, desiredTitle), 1500, "CHAT_TITLE_UI_RENAME_START_EVALUATION_FAILED");
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 5000), 15000);
  let uiState: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    const value = await safeEvaluateInTarget(target.web_socket_debugger_url, buildSidebarUiRenameStateExpression(chatId, desiredTitle), 1000, "CHAT_TITLE_UI_RENAME_STATE_EVALUATION_FAILED");
    uiState = asRecord(value);
    if (String(uiState.status ?? "").startsWith("CHAT_TITLE_UI_RENAME_FINISHED") || String(uiState.status ?? "").startsWith("CHAT_TITLE_UI_RENAME_FAILED")) break;
    await delay(300);
  }
  await delay(1000);
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
    const value = await safeEvaluateInTarget(target.web_socket_debugger_url, buildBackendTitleConfirmationExpression(chatId, desiredTitle), Math.min(Math.max(timeoutMs, 3000), 5000), "CHAT_BACKEND_CONFIRM_EVALUATION_FAILED");
    last = asRecord(value);
    if (last.ok === true) return last;
    await delay(500);
  }
  return last ?? { ok: false, status: "CHAT_BACKEND_CONFIRM_TIMEOUT", chat_id: chatId, desired_title: desiredTitle };
}

async function confirmChatGptTitle(target: ChatGptTarget, desiredTitle: string, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "CHAT_TITLE_CONFIRM_WEBSOCKET_MISSING" };
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10000);
  let last: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    const value = await safeEvaluateInTarget(target.web_socket_debugger_url, buildTitleConfirmationExpression(desiredTitle), Math.min(timeoutMs, 1000), "CHAT_TITLE_CONFIRM_EVALUATION_FAILED");
    const record = asRecord(value);
    last = record;
    if (record.ok === true) return record;
    await delay(250);
  }
  return last ?? { ok: false, status: "CHAT_TITLE_CONFIRM_TIMEOUT", desired_title: desiredTitle };
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

function buildWarmthRepairSkipped(status: string, beforeWarmth: Record<string, unknown>, reason: string): Record<string, unknown> {
  return {
    ok: false,
    status,
    before_warmth: beforeWarmth,
    repair_action: "skip",
    repair_skip_reason: reason,
    keep_target_id: null,
    prune_result: null,
    after_warmth: beforeWarmth,
  };
}

function buildSendOutcome(input: {
  ok: boolean;
  status: string;
  selected?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
  authStatus?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  submitted?: Record<string, unknown>;
  messages?: Record<string, unknown>;
  attachment?: Record<string, unknown>;
  promptTransport?: PromptTransport;
  promptTransportState?: Record<string, unknown>;
  resolved?: ChatGptTarget | null;
  timeoutMs: number;
  startedAt: string;
  beforeUrl?: string | null;
  afterUrl?: string | null;
  chatId?: string | null;
  submittedFlag?: boolean;
  nextAction?: string | null;
  retrySafe?: boolean;
}): Record<string, unknown> {
  const selectedRecord = asRecord(input.selected);
  const target = asRecord(selectedRecord.target);
  const selectedTarget = asRecord(selectedRecord.selected_target);
  const preflight = asRecord(input.preflight);
  const authStatus = asRecord(input.authStatus);
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
    prompt_transport: input.promptTransport ?? "INLINE_TEXT",
    transport_mode: input.promptTransport ?? "INLINE_TEXT",
    prompt_transport_state: input.promptTransportState ?? (input.promptTransport === "FILE_ATTACHMENT" ? asRecord(asRecord(input.attachment).prompt_transport_state) : null),
    target_id: targetId,
    port,
    before_url: input.beforeUrl ?? asString(target.url) ?? asString(selectedTarget.url) ?? null,
    after_url: afterUrl,
    chat_id: input.chatId ?? (afterUrl ? extractChatGptChatId(afterUrl) : null),
    submitted: input.submittedFlag ?? (asRecord(input.submitted).submitted === true),
    // Defaults to true (safe to retry) because every early-return path in sendPrompt that reaches
    // buildSendOutcome without passing retrySafe explicitly is, by construction, a path where the
    // actual browser click never happened yet (target not ready, draft blocked, auth required, etc.).
    // Only the final return after submitDraft actually runs passes this explicitly, using
    // submitDraft's own retry_safe verdict - see ChatGptPromptSubmit.ts.
    retry_safe: input.retrySafe ?? true,
    nextAction: input.nextAction ?? null,
    auth_state: authStatus.auth_state ?? null,
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
    candidate_rejections: selectedRecord.candidate_rejections ?? [],
    target_selection: input.selected ?? null,
    timestamps: { started_at: input.startedAt, ended_at: endedAt },
    timeout_ms: input.timeoutMs,
    preflight: input.preflight ?? null,
    auth_status: input.authStatus ?? null,
    draft: input.draft ?? null,
    submit_result: input.submitted ?? null,
    attachment: input.attachment ?? null,
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

function extractPruneCandidateRecords(inventory: Record<string, unknown>): Array<Record<string, unknown>> {
  return uniqueTargetRecords([
    ...asArrayRecords(inventory.empty_home_targets),
    ...asArrayRecords(inventory.root_targets),
    ...asArrayRecords(inventory.chat_targets),
    ...asArrayRecords(inventory.auth_login_settings_targets),
    ...asArrayRecords(inventory.targets),
  ]);
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

function stableSortTargets(targets: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...targets].sort((a, b) => {
    const portDelta = (numberOrNull(a.port) ?? 0) - (numberOrNull(b.port) ?? 0);
    if (portDelta !== 0) return portDelta;
    return String(asString(a.id) ?? "").localeCompare(String(asString(b.id) ?? ""));
  });
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

async function resolveTarget(input: BrowserSessionOptions = {}): Promise<{ ok: boolean; status: string; target: ChatGptTarget | null; inventory_summary?: Record<string, unknown>; candidate_rejections?: unknown; selected_target_candidates?: unknown }> {
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
  return {
    ok: selected.ok === true,
    status: String(selected.status ?? "TARGET_SELECTION_FAILED"),
    target: isChatGptTarget(selected.target) ? selected.target : null,
    inventory_summary: asRecord(selected.inventory_summary),
    candidate_rejections: selected.candidate_rejections,
    selected_target_candidates: selected.selected_target_candidates,
  };
}

async function readInputSnapshot(target: ChatGptTarget, timeoutMs?: number): Promise<Record<string, unknown>> {
  if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET" };
  return asRecord(await safeEvaluateInTarget(target.web_socket_debugger_url, buildInputSnapshotExpression(), Math.min(normalizeTimeout(timeoutMs), 1000), "INPUT_SNAPSHOT_EVALUATION_FAILED"));
}

async function resolveTargetForInspection(input: BrowserSessionOptions = {}): Promise<{ ok: boolean; status: string; target: ChatGptTarget | null }> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  if (input.targetId) {
    const target = await findDevToolsTargetById(defaultChatGptPorts(input.ports), input.targetId, timeoutMs);
    if (!target) return { ok: false, status: "TARGET_ID_NOT_FOUND", target: null };
    return { ok: true, status: "TARGET_SELECTED_FOR_INSPECTION", target };
  }
  if (input.chatId) {
    const target = await findBestChatGptTargetForChatId(defaultChatGptPorts(input.ports), input.chatId, timeoutMs);
    if (!target) return { ok: false, status: "CHAT_ID_TARGET_NOT_FOUND", target: null };
    return { ok: true, status: "TARGET_SELECTED_FOR_INSPECTION", target };
  }
  return { ok: false, status: "TARGET_SELECTOR_REQUIRED", target: null };
}

async function resolveAuthProbeTarget(input: BrowserSessionOptions, inventory: Record<string, unknown>, timeoutMs: number): Promise<ChatGptTarget | null> {
  if (input.targetId) return await findDevToolsTargetById(defaultChatGptPorts(input.ports), input.targetId, timeoutMs);
  if (input.chatId) return await findBestChatGptTargetForChatId(defaultChatGptPorts(input.ports), input.chatId, timeoutMs);
  const roots = Array.isArray(inventory.empty_home_targets) ? inventory.empty_home_targets.filter(isChatGptTarget) : [];
  if (roots[0]) return roots[0];
  const compactChat = asArrayRecords(inventory.chat_targets)[0];
  const compactChatId = asString(compactChat.id);
  if (compactChatId) {
    const hydrated = await findDevToolsTargetById(defaultChatGptPorts(input.ports), compactChatId, timeoutMs);
    if (hydrated) return hydrated;
  }
  const targets = extractInventoryTargets(inventory);
  return targets[0] ?? null;
}

function buildAuthState(input: { target?: ChatGptTarget; preflight?: Record<string, unknown>; inventory?: Record<string, unknown> }): Record<string, unknown> {
  const target = input.target;
  const preflight = asRecord(input.preflight);
  const inventory = asRecord(input.inventory);
  return classifyChatGptAuthState({
    visibleText: asString(preflight.visible_text_sample),
    url: asString(preflight.href) ?? target?.url ?? null,
    chatId: target?.chat_id ?? asString(preflight.chat_id),
    authLoginTargetCount: numberOrZero(inventory.auth_login_settings_target_count),
  });
}

function resolveProfileDir(configured?: string): { profile_dir: string; profile_source: string } {
  if (configured && configured.trim().length > 0) return { profile_dir: path.resolve(configured), profile_source: "input" };
  if (process.env.CONSOLE_MCP_BROWSER_PROFILE_DIR && process.env.CONSOLE_MCP_BROWSER_PROFILE_DIR.trim().length > 0) {
    return { profile_dir: path.resolve(process.env.CONSOLE_MCP_BROWSER_PROFILE_DIR), profile_source: "env" };
  }
  return { profile_dir: path.resolve(process.cwd(), "..", "browser", "profile"), profile_source: "default" };
}

async function persistJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sanitizeForOutput(value), null, 2)}\n`, "utf8");
}

function classifyCandidateRejection(preflight: Record<string, unknown>, snapshot: Record<string, unknown>, allowOverwrite: boolean): string {
  if (numberOrZero(snapshot.textLength) > 0 && !allowOverwrite) return "COMPOSER_NOT_EMPTY";
  const overlay = asRecord(preflight.overlay);
  if (overlay.present === true) return "OVERLAY_PRESENT";
  const composer = asRecord(preflight.composer);
  if (composer.found !== true) return "COMPOSER_NOT_FOUND";
  if (composer.visible !== true) return "COMPOSER_NOT_VISIBLE";
  const sendControl = asRecord(preflight.sendControl ?? preflight.send_control);
  if (sendControl.found !== true) return "SEND_CONTROL_NOT_FOUND";
  if (sendControl.enabled !== true) return "SEND_CONTROL_DISABLED";
  if (preflight.ok !== true) return String(preflight.status ?? "PREFLIGHT_NOT_READY");
  return "UNKNOWN";
}

function buildCandidateRejection(target: ChatGptTarget, preflight: Record<string, unknown>, snapshot: Record<string, unknown>, reason: string): Record<string, unknown> {
  const composer = asRecord(preflight.composer);
  const overlay = asRecord(preflight.overlay);
  const sendControl = asRecord(preflight.sendControl ?? preflight.send_control);
  const text = asString(snapshot.text) ?? "";
  return {
    target_id: target.id ?? null,
    url: target.url ?? null,
    title: target.title ?? null,
    has_web_socket_debugger_url: Boolean(target.web_socket_debugger_url ?? target.webSocketDebuggerUrl),
    rejection_status: reason === "COMPOSER_NOT_EMPTY" ? "TARGET_SELECTION_REJECTED_COMPOSER_NOT_EMPTY" : `TARGET_SELECTION_REJECTED_${reason}`,
    rejection_reason: reason,
    composer_found: composer.found ?? snapshot.ok === true,
    composer_visible: composer.visible ?? null,
    composer_text_length: numberOrNull(snapshot.textLength) ?? numberOrNull(composer.textLength),
    composer_text_sample_redacted_or_preview: text.length > 0 ? text.replace(/\s+/g, " ").slice(0, 120) : "",
    overlay_present: overlay.present ?? false,
    send_control_found: sendControl.found ?? null,
    send_control_enabled: sendControl.enabled ?? null,
    message_count: numberOrZero(preflight.message_count),
    user_message_count: numberOrZero(preflight.user_message_count),
    assistant_message_count: numberOrZero(preflight.assistant_message_count),
    href: preflight.href ?? snapshot.href ?? target.url ?? null,
    readyState: preflight.readyState ?? snapshot.readyState ?? null,
  };
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

function closeDevToolsTarget(port: number, targetId: string, timeoutMs: number): Promise<string> {
  return devToolsTextRequest(port, `/json/close/${encodeURIComponent(targetId)}`, "GET", timeoutMs);
}

async function safeEvaluateInTarget(webSocketUrl: string, expression: string, timeoutMs: number, status: string): Promise<unknown> {
  try {
    return await evaluateInTarget(webSocketUrl, expression, timeoutMs);
  } catch (error) {
    return { ok: false, status, error: error instanceof Error ? error.message : String(error), recoverable: true };
  }
}

async function safeSendDevToolsCommand(webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, status: string): Promise<Record<string, unknown>> {
  try {
    return { ok: true, status: "DEVTOOLS_COMMAND_SENT", method, result: await sendDevToolsCommand(webSocketUrl, method, params, timeoutMs) };
  } catch (error) {
    return { ok: false, status, method, error: error instanceof Error ? error.message : String(error), recoverable: true };
  }
}

function setFileInputFilesInDomSession(webSocketUrl: string, filePath: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return withDevToolsSession(webSocketUrl, timeoutMs, async (send) => {
    const commandTimeoutMs = Math.min(Math.max(timeoutMs, 3000), 15000);
    const domEnable = await send("DOM.enable", {}, Math.min(Math.max(timeoutMs, 1000), 5000), "CHATGPT_ATTACHMENT_DOM_ENABLE_FAILED");
    if (domEnable.ok !== true) {
      return { ok: false, status: "CHATGPT_ATTACHMENT_DOM_ENABLE_FAILED", input_discovery: { dom_enable: domEnable, node_id_found: false }, node_id: null, set_files: null };
    }

    let metadataProbe: Record<string, unknown> = {};
    let runtimeEval: Record<string, unknown> = {};
    let requestNode: Record<string, unknown> = {};
    let nodeId: number | null = null;
    const inputDiscoveryBase = () => ({
      dom_enable: domEnable,
      metadata_probe: compactFileInputMetadataDiscovery(metadataProbe),
      runtime_eval: compactRuntimeEvalDiscovery(runtimeEval),
      request_node: compactRequestNodeDiscovery(requestNode),
      node_id_found: nodeId !== null && nodeId > 0,
    });

    try {
      metadataProbe = await send("Runtime.evaluate", {
        expression: buildFileInputMetadataExpression(),
        returnByValue: true,
        awaitPromise: false,
      }, commandTimeoutMs, "CHATGPT_ATTACHMENT_INPUT_METADATA_FAILED");
      runtimeEval = await send("Runtime.evaluate", {
        expression: buildFileInputHandleExpression(),
        returnByValue: false,
        objectGroup: "chatgpt-attachment",
        awaitPromise: false,
      }, commandTimeoutMs, "CHATGPT_ATTACHMENT_INPUT_EVALUATION_FAILED");
      const objectId = asString(asRecord(asRecord(runtimeEval.result).result).objectId);
      if (runtimeEval.ok !== true || !objectId) {
        return { ok: false, status: "CHATGPT_ATTACHMENT_INPUT_OBJECT_ID_MISSING", input_discovery: inputDiscoveryBase(), node_id: null, set_files: null };
      }

      requestNode = await send("DOM.requestNode", { objectId }, commandTimeoutMs, "CHATGPT_ATTACHMENT_REQUEST_NODE_FAILED");
      nodeId = numberOrNull(asRecord(requestNode.result).nodeId);

      const inputDiscovery = inputDiscoveryBase();
      const setFiles = await send("DOM.setFileInputFiles", { objectId, files: [filePath] }, commandTimeoutMs, "CHATGPT_ATTACHMENT_SET_FILES_FAILED");
      return { ok: setFiles.ok === true, status: setFiles.ok === true ? "CHATGPT_ATTACHMENT_SET_FILES_DONE" : "CHATGPT_ATTACHMENT_SET_FILES_FAILED", input_discovery: inputDiscovery, node_id: nodeId, set_files: setFiles };
    } finally {
      await send("Runtime.releaseObjectGroup", { objectGroup: "chatgpt-attachment" }, Math.min(Math.max(timeoutMs, 1000), 5000), "CHATGPT_ATTACHMENT_RELEASE_OBJECT_GROUP_FAILED");
    }
  });
}

function withDevToolsSession(
  webSocketUrl: string,
  timeoutMs: number,
  callback: (send: (method: string, params: Record<string, unknown>, commandTimeoutMs: number, failureStatus: string) => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) {
    const domEnable = { ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_WEBSOCKET_CLIENT_MISSING", method: "DOM.enable", error: "Runtime WebSocket client is not available in this Node process.", recoverable: true };
    return Promise.resolve({ ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_WEBSOCKET_CLIENT_MISSING", input_discovery: { dom_enable: domEnable, node_id_found: false }, node_id: null, set_files: null });
  }

  type PendingCommand = {
    method: string;
    failureStatus: string;
    resolve: (value: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  return new Promise((resolve) => {
    const ws = new Ctor(webSocketUrl);
    const pending = new Map<number, PendingCommand>();
    let settled = false;
    let nextId = 1;
    const openTimer = setTimeout(() => finish({ ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_OPEN_TIMEOUT", input_discovery: { node_id_found: false }, node_id: null, set_files: null }), Math.min(timeoutMs, 5000));

    const close = () => {
      try { ws.close(); } catch {}
    };
    const finish = (record: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
      close();
      resolve(record);
    };
    const sendCommand = (method: string, params: Record<string, unknown>, commandTimeoutMs: number, failureStatus: string): Promise<Record<string, unknown>> => {
      if (settled) return Promise.resolve({ ok: false, status: failureStatus, method, error: "DevTools session already closed.", recoverable: true });
      return new Promise((commandResolve) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          commandResolve({ ok: false, status: failureStatus, method, error: "DevTools command timed out.", recoverable: true });
        }, commandTimeoutMs);
        pending.set(id, { method, failureStatus, resolve: commandResolve, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          commandResolve({ ok: false, status: failureStatus, method, error: error instanceof Error ? error.message : String(error), recoverable: true });
        }
      });
    };

    ws.onerror = (event) => finish({ ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_WEBSOCKET_ERROR", input_discovery: { error: String(event), node_id_found: false }, node_id: null, set_files: null });
    ws.onmessage = (event) => {
      let response: { id?: number; result?: unknown; error?: unknown };
      try {
        response = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
      } catch (error) {
        finish({ ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_MESSAGE_PARSE_FAILED", input_discovery: { error: error instanceof Error ? error.message : String(error), node_id_found: false }, node_id: null, set_files: null });
        return;
      }
      if (typeof response.id !== "number") return;
      const command = pending.get(response.id);
      if (!command) return;
      pending.delete(response.id);
      clearTimeout(command.timer);
      if (response.error) {
        command.resolve({ ok: false, status: command.failureStatus, method: command.method, error: JSON.stringify(response.error), recoverable: true });
      } else {
        command.resolve({ ok: true, status: "DEVTOOLS_COMMAND_SENT", method: command.method, result: response.result ?? null });
      }
    };
    ws.onopen = () => {
      clearTimeout(openTimer);
      void (async () => {
        try {
          finish(await callback(sendCommand));
        } catch (error) {
          finish({ ok: false, status: "CHATGPT_ATTACHMENT_DOM_SESSION_CALLBACK_FAILED", input_discovery: { error: error instanceof Error ? error.message : String(error), node_id_found: false }, node_id: null, set_files: null });
        }
      })();
    };
  });
}

function buildFileInputMetadataExpression(): string {
  return `(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const enabled = (node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    const visible = (node) => {
      if (!node || !(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width >= 0 && rect.height >= 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const preferred = inputs.find((node) => node.multiple === true && enabled(node))
      || inputs.find((node) => enabled(node))
      || inputs[0]
      || null;
    return {
      count: inputs.length,
      visible: preferred ? visible(preferred) : false,
      accept: preferred ? (preferred.getAttribute('accept') || null) : null,
      multiple: preferred ? preferred.multiple === true : false,
      href: location.href,
      title: document.title,
      readyState: document.readyState,
    };
  })()`;
}

function buildFileInputHandleExpression(): string {
  return `document.querySelector('input[type="file"][multiple]:not(:disabled), input[type="file"]:not(:disabled), input[type="file"]')`;
}

function compactFileInputMetadataDiscovery(value: Record<string, unknown>): Record<string, unknown> {
  const metadata = asRecord(asRecord(asRecord(value.result).result).value);
  return {
    ok: value.ok === true,
    status: value.ok === true ? "CHATGPT_ATTACHMENT_INPUT_METADATA_READY" : asString(value.status),
    method: asString(value.method) ?? "Runtime.evaluate",
    error: typeof value.error === "undefined" ? null : value.error,
    recoverable: value.recoverable === true,
    count: numberOrZero(metadata.count),
    visible: metadata.visible === true,
    accept: asString(metadata.accept),
    multiple: metadata.multiple === true,
    href: asString(metadata.href),
    title: asString(metadata.title),
    readyState: asString(metadata.readyState),
  };
}

function compactRuntimeEvalDiscovery(value: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(asRecord(value.result).result);
  return {
    ok: value.ok === true && typeof result.objectId === "string",
    status: value.ok === true ? (typeof result.objectId === "string" ? "CHATGPT_ATTACHMENT_INPUT_OBJECT_READY" : "CHATGPT_ATTACHMENT_INPUT_OBJECT_ID_MISSING") : asString(value.status),
    method: asString(value.method) ?? "Runtime.evaluate",
    error: typeof value.error === "undefined" ? null : value.error,
    recoverable: value.recoverable === true,
    object_id_found: typeof result.objectId === "string",
    selectors: ["input[type=\"file\"]"],
  };
}

function compactRequestNodeDiscovery(value: Record<string, unknown>): Record<string, unknown> {
  const nodeId = numberOrNull(asRecord(value.result).nodeId);
  return {
    ok: value.ok === true && nodeId !== null && nodeId > 0,
    status: value.ok === true ? (nodeId !== null && nodeId > 0 ? "CHATGPT_ATTACHMENT_INPUT_NODE_READY" : "CHATGPT_ATTACHMENT_INPUT_NODE_ID_MISSING") : asString(value.status),
    method: asString(value.method) ?? "DOM.requestNode",
    error: typeof value.error === "undefined" ? null : value.error,
    recoverable: value.recoverable === true,
    node_id_found: nodeId !== null && nodeId > 0,
    node_id: nodeId,
  };
}

function traceNetworkInTarget(webSocketUrl: string, durationMs: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.resolve({ ok: false, status: "CHATGPT_RENAME_TRACE_WEBSOCKET_CLIENT_MISSING", events: [], raw_events_sample: [] });
  const startedAt = Date.now();
  const requests = new Map<string, Record<string, unknown>>();
  const events: Array<Record<string, unknown>> = [];
  const rawEvents: Array<Record<string, unknown>> = [];
  const interesting = (url: string, method?: string | null) => {
    const lower = url.toLowerCase();
    return lower.includes("conversation") || lower.includes("rename") || lower.includes("title") || ["PATCH", "PUT", "POST"].includes(String(method ?? "").toUpperCase());
  };
  return new Promise((resolve) => {
    const ws = new Ctor(webSocketUrl);
    let settled = false;
    const pushRaw = (value: Record<string, unknown>) => { if (rawEvents.length < 200) rawEvents.push(value); };
    const finish = (status = "CHATGPT_RENAME_NETWORK_TRACE_READY") => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ ok: true, status, duration_ms: Date.now() - startedAt, event_count: events.length, raw_event_count: rawEvents.length, events, raw_events_sample: rawEvents });
    };
    const hardTimer = setTimeout(() => finish("CHATGPT_RENAME_NETWORK_TRACE_DONE"), durationMs);
    const openTimer = setTimeout(() => { clearTimeout(hardTimer); finish("CHATGPT_RENAME_NETWORK_TRACE_OPEN_TIMEOUT"); }, Math.min(timeoutMs, 5000));
    ws.onerror = () => { clearTimeout(openTimer); clearTimeout(hardTimer); finish("CHATGPT_RENAME_NETWORK_TRACE_WEBSOCKET_ERROR"); };
    ws.onopen = () => {
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ id: 1, method: "Network.enable", params: { maxPostDataSize: 4096 } }));
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { method?: string; params?: Record<string, unknown> };
      const method = message.method;
      const params = asRecord(message.params);
      if (method === "Network.requestWillBeSent") {
        const request = asRecord(params.request);
        const requestId = asString(params.requestId) ?? "";
        const url = asString(request.url) ?? "";
        const httpMethod = asString(request.method) ?? "";
        pushRaw({ request_id: requestId, event: "request", method: httpMethod, url: sanitizeNetworkUrl(url), ts_offset_ms: Date.now() - startedAt });
        if (requestId && interesting(url, httpMethod)) {
          const item = { request_id: requestId, event: "request", method: httpMethod, url: sanitizeNetworkUrl(url), headers: sanitizeNetworkHeaders(asRecord(request.headers)), post_data_shape: describePostData(asString(request.postData)), ts_offset_ms: Date.now() - startedAt };
          requests.set(requestId, item);
          events.push(item);
        }
      } else if (method === "Network.responseReceived") {
        const response = asRecord(params.response);
        const requestId = asString(params.requestId) ?? "";
        const prior = requests.get(requestId);
        const url = asString(response.url) ?? asString(prior?.url) ?? "";
        pushRaw({ request_id: requestId, event: "response", url: sanitizeNetworkUrl(url), status_code: numberOrNull(response.status), mime_type: asString(response.mimeType), ts_offset_ms: Date.now() - startedAt });
        if (prior || interesting(url, null)) events.push({ request_id: requestId, event: "response", url: sanitizeNetworkUrl(url), status_code: numberOrNull(response.status), status_text: asString(response.statusText), mime_type: asString(response.mimeType), headers: sanitizeNetworkHeaders(asRecord(response.headers)), ts_offset_ms: Date.now() - startedAt });
      } else if (method === "Network.loadingFailed") {
        const requestId = asString(params.requestId) ?? "";
        pushRaw({ request_id: requestId, event: "failed", error_text: asString(params.errorText), canceled: params.canceled === true, ts_offset_ms: Date.now() - startedAt });
        if (requests.has(requestId)) events.push({ request_id: requestId, event: "failed", error_text: asString(params.errorText), canceled: params.canceled === true, ts_offset_ms: Date.now() - startedAt });
      }
    };
  });
}

function sendDevToolsCommand(webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const Ctor = (globalThis as unknown as { WebSocket?: DevToolsWebSocketConstructor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("Runtime WebSocket client is not available in this Node process."));
  return new Promise((resolve, reject) => {
    const ws = new Ctor(webSocketUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("DevTools command timed out.")); }, timeoutMs);
    ws.onerror = (event) => { clearTimeout(timer); ws.close(); reject(new Error(`DevTools WebSocket error: ${String(event)}`)); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as DevToolsRpcResponse;
      if (response.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (response.error) reject(new Error(`DevTools command failed: ${JSON.stringify(response.error)}`));
      else resolve(response.result ?? null);
    };
  });
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

function buildFileInputProbeExpression(): string {
  return `(() => { const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width >= 0 && rect.height >= 0 && style.display !== 'none' && style.visibility !== 'hidden'; }; const inputs = Array.from(document.querySelectorAll('input[type="file"]')); const preferred = inputs.find((node) => String(node.getAttribute('accept') || '').includes('text') || String(node.getAttribute('accept') || '').includes('pdf') || String(node.getAttribute('multiple') || '') !== '') || inputs[0] || null; if (!preferred) return { ok: false, status: 'CHATGPT_FILE_INPUT_NOT_FOUND', input_count: 0, href: location.href, title: document.title, readyState: document.readyState }; preferred.scrollIntoView && preferred.scrollIntoView({ block: 'center' }); return { ok: true, status: 'CHATGPT_FILE_INPUT_READY', input_count: inputs.length, node_id: null, backend_node_id_needed: true, visible: visible(preferred), accept: preferred.getAttribute('accept') || null, multiple: preferred.hasAttribute('multiple'), href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

async function cleanupStalePromptAttachments(webSocketUrl: string, fileName: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const result = await safeEvaluateInTarget(webSocketUrl, buildStalePromptAttachmentCleanupExpression(fileName), Math.min(Math.max(timeoutMs, 1000), 5000), "FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_FAILED");
  const record = asRecord(result);
  if (
    typeof record.status === "string"
    && record.status.startsWith("FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_")
    && typeof record.before_prompt_file_count === "number"
    && typeof record.after_prompt_file_count === "number"
  ) return record;
  return {
    status: "FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_FAILED",
    before_prompt_file_count: 0,
    after_prompt_file_count: 0,
    removed_prompt_file_count: 0,
    cleanup_clicked_count: 0,
    stale_prompt_file_names: [],
    current_file_name: fileName,
    retryable: true,
    next_action: "open a fresh ChatGPT root before attaching prompt file",
  };
}

function buildStalePromptAttachmentCleanupExpression(fileName: string): string {
  const safeName = JSON.stringify(fileName);
  return `(async () => { const currentFileName = ${safeName}; const promptFilePattern = /prompt-[a-f0-9]{64}\\.(?:txt|md|markdown)\\b/gi; const currentPromptFile = String(currentFileName || '').toLowerCase(); const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; }; const textOf = (node) => clean([node.innerText || node.textContent || '', node.getAttribute && node.getAttribute('aria-label') || '', node.getAttribute && node.getAttribute('title') || ''].join(' ')); const promptNamesFrom = (value) => Array.from(new Set((clean(value).match(promptFilePattern) || []).map((item) => item.toLowerCase()))); const collectPromptNames = () => { const nodes = Array.from(document.querySelectorAll('[data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=file i], [aria-label*=attachment i], [role=alert], [data-testid*=toast], [class*=toast], [class*=banner]')).filter(visible); const joined = clean(nodes.map(textOf).join(' ')); return Array.from(new Set(promptNamesFrom(joined))); }; const beforeNames = collectPromptNames(); const staleNames = beforeNames.filter((name) => name !== currentPromptFile); const finish = (status, afterNames, clickedCount) => ({ status, before_prompt_file_count: staleNames.length, after_prompt_file_count: afterNames.filter((name) => name !== currentPromptFile).length, removed_prompt_file_count: Math.max(0, staleNames.length - afterNames.filter((name) => name !== currentPromptFile).length), cleanup_clicked_count: clickedCount, stale_prompt_file_names: staleNames.slice(0, 10), current_file_name: currentFileName, retryable: status !== 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_DONE' && status !== 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_NOT_NEEDED', next_action: status === 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_NOT_NEEDED' || status === 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_DONE' ? 'continue attach' : 'open a fresh ChatGPT root or manually remove stale prompt attachment chips' }); if (staleNames.length === 0) return finish('FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_NOT_NEEDED', beforeNames, 0); const hasStaleName = (node) => { const text = textOf(node).toLowerCase(); return staleNames.some((name) => text.includes(name)); }; const isRemoveControl = (node) => { const text = textOf(node).toLowerCase(); return text.includes('remove file') || text.includes('remove attachment') || text === 'remove' || text === 'close' || text === 'delete' || text === 'x'; }; const candidateChips = Array.from(document.querySelectorAll('[data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=file i], [aria-label*=attachment i], [role=alert], [data-testid*=toast], [class*=toast], [class*=banner], li, div')).filter((node) => visible(node) && hasStaleName(node)); const controls = []; const addControl = (control) => { if (!control || !(control instanceof Element) || !visible(control)) return; if (!controls.includes(control)) controls.push(control); }; for (const chip of candidateChips) { const directControls = Array.from(chip.querySelectorAll('button, [role=\"button\"], [aria-label*=Remove i], [aria-label*=\"Remove file\" i], [title*=Remove i]')).filter(visible); const removeControls = directControls.filter(isRemoveControl); for (const control of removeControls.length > 0 ? removeControls : directControls) addControl(control); let ancestor = chip.parentElement; for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) { if (!hasStaleName(ancestor)) continue; for (const control of Array.from(ancestor.querySelectorAll('button, [role=\"button\"], [aria-label*=Remove i], [title*=Remove i]')).filter((node) => visible(node) && isRemoveControl(node))) addControl(control); } } const globalRemoveControls = Array.from(document.querySelectorAll('button, [role=\"button\"], [aria-label*=Remove i], [title*=Remove i]')).filter((node) => visible(node) && isRemoveControl(node)); for (const control of globalRemoveControls) { if (hasStaleName(control)) addControl(control); const owner = control.closest('[data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], li, div'); if (owner && hasStaleName(owner)) addControl(control); } let clickedCount = 0; for (const control of controls.slice(0, staleNames.length + 4)) { try { control.click(); clickedCount += 1; } catch (_) {} } await new Promise((resolve) => setTimeout(resolve, clickedCount > 0 ? 500 : 150)); const afterNames = collectPromptNames(); const remaining = afterNames.filter((name) => name !== currentPromptFile).length; if (remaining === 0) return finish('FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_DONE', afterNames, clickedCount); return finish(clickedCount > 0 ? 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_PARTIAL' : 'FILE_ATTACHMENT_STALE_PROMPT_FILES_CLEANUP_FAILED', afterNames, clickedCount); })()`;
}

async function waitForAttachmentConfirmation(webSocketUrl: string, fileName: string, sha256: string | null, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 15000);
  let last: Record<string, unknown> | null = null;
  while (Date.now() <= deadline) {
    const confirmation = await safeEvaluateInTarget(webSocketUrl, buildAttachmentConfirmationExpression(fileName, sha256), Math.min(timeoutMs, 1000), "CHATGPT_ATTACHMENT_CONFIRMATION_FAILED");
    last = asRecord(confirmation);
    if (last.ok === true || last.upload_error === true || last.multiple_prompt_files_visible === true) return last;
    await delay(250);
  }
  return last ?? { ok: false, status: "CHATGPT_ATTACHMENT_CONFIRMATION_TIMEOUT", file_name: fileName };
}

function buildAttachmentComposerStateExpression(fileName: string, sha256: string | null): string {
  const safeName = JSON.stringify(fileName);
  const safeSha = JSON.stringify(sha256 ?? "");
  return `(() => { const fileName = ${safeName}; const sha256 = ${safeSha}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const bodyText = clean(document.body?.innerText || document.documentElement?.innerText || ''); const lower = bodyText.toLowerCase(); const uploadErrorPatterns = ['upload failed', 'error uploading', 'could not upload', "couldn't upload", 'unsupported file', 'file is too large', 'failed to upload', 'something went wrong uploading']; const uploadErrorMatches = uploadErrorPatterns.filter((pattern) => lower.includes(pattern)); const nodes = Array.from(document.querySelectorAll('[data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=file i], [aria-label*=attachment i], [role=alert], [data-testid*=toast], [class*=toast], [class*=banner]')).map((node) => clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '')).filter(Boolean).slice(0, 80); const joined = clean(nodes.join(' ')); const promptFilePattern = /prompt-[a-f0-9]{64}\\.(?:txt|md|markdown)\\b/gi; const promptFileNames = Array.from(new Set((joined.match(promptFilePattern) || []).map((value) => value.toLowerCase()))); const currentPromptFile = String(fileName || '').toLowerCase(); const multiplePromptFilesVisible = promptFileNames.length > 1 || (promptFileNames.length === 1 && promptFileNames[0] !== currentPromptFile); const duplicate = bodyText.includes(fileName) || nodes.some((value) => value.includes(fileName)) || (sha256 && (bodyText.includes(sha256) || joined.includes(sha256) || bodyText.includes(sha256.slice(0, 16)) || joined.includes(sha256.slice(0, 16)))); return { ok: true, status: multiplePromptFilesVisible ? 'FILE_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE' : (duplicate ? 'CHATGPT_ATTACHMENT_DUPLICATE_FOUND' : (uploadErrorMatches.length > 0 ? 'CHATGPT_ATTACHMENT_UPLOAD_ERROR_VISIBLE' : 'CHATGPT_ATTACHMENT_COMPOSER_STATE_READY')), duplicate, upload_error: uploadErrorMatches.length > 0, upload_error_matches: uploadErrorMatches, multiple_prompt_files_visible: multiplePromptFilesVisible, prompt_file_names: promptFileNames, prompt_file_count: promptFileNames.length, file_name: fileName, sha256: sha256 || null, chip_text: nodes, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildAttachmentConfirmationExpression(fileName: string, sha256: string | null): string {
  const safeName = JSON.stringify(fileName);
  const safeSha = JSON.stringify(sha256 ?? "");
  return `(() => { const fileName = ${safeName}; const sha256 = ${safeSha}; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const text = clean(document.body?.innerText || document.documentElement?.innerText || ''); const lower = text.toLowerCase(); const uploadErrorPatterns = ['upload failed', 'error uploading', 'could not upload', "couldn't upload", 'unsupported file', 'file is too large', 'failed to upload', 'something went wrong uploading']; const uploadErrorMatches = uploadErrorPatterns.filter((pattern) => lower.includes(pattern)); const chips = Array.from(document.querySelectorAll('[data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=file i], [aria-label*=attachment i], [role=alert], [data-testid*=toast], [class*=toast], [class*=banner]')).map((node) => clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '')).filter(Boolean).slice(0, 80); const joined = clean(chips.join(' ')); const promptFilePattern = /prompt-[a-f0-9]{64}\\.(?:txt|md|markdown)\\b/gi; const promptFileNames = Array.from(new Set((joined.match(promptFilePattern) || []).map((value) => value.toLowerCase()))); const currentPromptFile = String(fileName || '').toLowerCase(); const multiplePromptFilesVisible = promptFileNames.length > 1 || (promptFileNames.length === 1 && promptFileNames[0] !== currentPromptFile); const found = text.includes(fileName) || chips.some((value) => value.includes(fileName)) || (sha256 && (text.includes(sha256) || joined.includes(sha256) || text.includes(sha256.slice(0, 16)) || joined.includes(sha256.slice(0, 16)))); const ok = found && !multiplePromptFilesVisible; return { ok, status: multiplePromptFilesVisible ? 'FILE_ATTACHMENT_MULTIPLE_PROMPT_FILES_VISIBLE' : (found ? 'CHATGPT_ATTACHMENT_CONFIRMED' : (uploadErrorMatches.length > 0 ? 'CHATGPT_ATTACHMENT_UPLOAD_ERROR_VISIBLE' : 'CHATGPT_ATTACHMENT_PENDING')), upload_error: uploadErrorMatches.length > 0, upload_error_matches: uploadErrorMatches, file_name: fileName, sha256: sha256 || null, chip_text: chips, prompt_file_names: promptFileNames, prompt_file_count: promptFileNames.length, multiple_prompt_files_visible: multiplePromptFilesVisible, body_contains_file_name: text.includes(fileName), href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildComposerPreflightExpression(): string {
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const sendSelectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const readText = (node) => { if (!node) return ''; if ('value' in node) return String(node.value || ''); const clone = node.cloneNode(true); for (const excluded of clone.querySelectorAll?.('[contenteditable="false"], button, input, [data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=attachment i], [aria-label*=file i]') || []) excluded.remove(); return String(clone.textContent || ''); }; const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); let composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (composerNode && !(composerNode instanceof HTMLTextAreaElement) && composerNode.getAttribute('contenteditable') !== 'true' && composerNode.querySelector) composerNode = composerNode.querySelector('textarea, [contenteditable="true"], .ProseMirror'); const composerContainer = composerNode ? (composerNode.closest('form') || composerNode.closest('[data-testid*=composer], [class*=composer], main') || document) : document; const explicitSendNode = sendSelectors.map((selector) => document.querySelector(selector)).filter(Boolean).find(visible) || null; const nearbyButtons = Array.from((composerContainer || document).querySelectorAll('button')).filter((node) => visible(node)); const enabledNearbyButtons = nearbyButtons.filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const sendNode = explicitSendNode || enabledNearbyButtons.find((node) => { const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || node.innerText || node.textContent || '').toLowerCase(); if (label.includes('send') || label.includes('submit') || label.includes('arrow')) return true; const svgCount = node.querySelectorAll('svg').length; const text = String(node.innerText || node.textContent || '').trim(); return svgCount > 0 && text.length <= 40; }) || null; const composerRect = composerNode && composerNode.getBoundingClientRect ? composerNode.getBoundingClientRect() : null; const sendRect = sendNode && sendNode.getBoundingClientRect ? sendNode.getBoundingClientRect() : null; const intersects = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; const viewportArea = Math.max(1, window.innerWidth * window.innerHeight); const blockers = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-radix-popper-content-wrapper], [data-headlessui-state], .fixed, .absolute')).filter((node) => visible(node)).map((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); const z = Number.parseInt(style.zIndex || '0', 10) || 0; const area = rect.width * rect.height; const coversComposer = Boolean(intersects(rect, composerRect) || intersects(rect, sendRect)); const modal = node.getAttribute('aria-modal') === 'true' || node.getAttribute('role') === 'dialog'; const highLayer = (style.position === 'fixed' || style.position === 'absolute') && z >= 20 && area > 5000; return { node, rect, style, z, area, coversComposer, modal, highLayer }; }).filter((item) => (item.modal || item.highLayer) && (item.coversComposer || item.area > viewportArea * 0.15)).sort((a, b) => (b.modal === a.modal ? b.z - a.z : (b.modal ? 1 : -1))); const blocker = blockers[0] || null; const sendDisabled = sendNode ? Boolean(sendNode.disabled) || sendNode.getAttribute('aria-disabled') === 'true' : true; const composerText = composerNode ? readText(composerNode).trim() : ''; const overlayText = blocker ? String(blocker.node.innerText || blocker.node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const visibleTextSample = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300); const temporaryChat = visibleTextSample.toLowerCase().includes('temporary chat'); const overlay = blocker ? { present: true, role: blocker.node.getAttribute('role'), ariaModal: blocker.node.getAttribute('aria-modal'), zIndex: blocker.z, coversComposer: blocker.coversComposer, textSample: overlayText, tag: blocker.node.tagName, className: String(blocker.node.className || '').slice(0, 200) } : { present: false }; const composer = { found: Boolean(composerNode), visible: Boolean(composerNode && visible(composerNode)), textLength: composerText.length, candidateCount: composerCandidates.length, active: document.activeElement === composerNode }; const sendControl = { found: Boolean(sendNode), enabled: Boolean(sendNode && !sendDisabled), disabled: sendDisabled }; const ok = composer.found && composer.visible && sendControl.found && sendControl.enabled && overlay.present !== true; return { ok, status: ok ? 'COMPOSER_PREFLIGHT_READY' : (overlay.present ? 'COMPOSER_PREFLIGHT_BLOCKED_OVERLAY' : 'COMPOSER_PREFLIGHT_NOT_READY'), composer, sendControl, overlay, href: location.href, title: document.title, visible_text_sample: visibleTextSample, message_count: messageNodes.length, user_message_count: userMessages.length, assistant_message_count: assistantMessages.length, temporary_chat: temporaryChat, readyState: document.readyState, visibility_state: document.visibilityState, has_focus: document.hasFocus(), hidden: document.hidden }; })()`;
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

function extractCanonicalConfirmedTitle(record: Record<string, unknown>, desiredTitle: string): string | null {
  const anchors = Array.isArray(record.anchor_titles) ? record.anchor_titles.map((value) => asString(value)).filter((value): value is string => Boolean(value)) : [];
  const exactAnchor = anchors.find((value) => value === desiredTitle) ?? null;
  if (exactAnchor) return exactAnchor;
  const documentTitle = asString(record.document_title);
  if (documentTitle && documentTitle.includes(desiredTitle)) return desiredTitle;
  return documentTitle;
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

function buildComposerFocusExpression(allowOverwrite: boolean): string {
  const blockOverwrite = allowOverwrite ? "false" : "true";
  const selectForOverwrite = allowOverwrite ? "true" : "false";
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const candidates = selectors.map((selector) => document.querySelector(selector)).filter(Boolean); const editable = (node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror'); let target = candidates.find(editable); if (target && !editable(target) && target.querySelector) target = target.querySelector('textarea, [contenteditable="true"], .ProseMirror'); if (!target) return { ok: false, status: 'COMPOSER_NOT_READY', candidateCount: candidates.length, readyState: document.readyState, href: location.href, title: document.title }; const readText = (node) => { if (!node) return ''; if ('value' in node) return String(node.value || ''); const clone = node.cloneNode(true); for (const excluded of clone.querySelectorAll?.('[contenteditable="false"], button, input, [data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=attachment i], [aria-label*=file i]') || []) excluded.remove(); return String(clone.textContent || ''); }; const before = readText(target).trim(); if (before.length > 0 && ${blockOverwrite}) return { ok: false, status: 'COMPOSER_NOT_EMPTY', existingLength: before.length, readyState: document.readyState, href: location.href, title: document.title }; target.focus(); let selectionApplied = false; if (${selectForOverwrite} && before.length > 0) { if (target instanceof HTMLTextAreaElement) { target.select(); selectionApplied = target.selectionStart === 0 && target.selectionEnd === target.value.length; } else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(range); selectionApplied = selection.rangeCount === 1 && !selection.isCollapsed; } } const active = document.activeElement; const focusConfirmed = active === target || Boolean(active && target.contains && target.contains(active)); return { ok: focusConfirmed && (!${selectForOverwrite} || before.length === 0 || selectionApplied), status: !focusConfirmed ? 'COMPOSER_FOCUS_NOT_ACQUIRED' : ((${selectForOverwrite} && before.length > 0 && !selectionApplied) ? 'COMPOSER_SELECTION_NOT_ACQUIRED' : 'COMPOSER_FOCUSED'), existingLength: before.length, selectionApplied, targetTag: target.tagName, targetClass: String(target.className || ''), activeTag: active ? active.tagName : null, activeClass: active ? String(active.className || '') : null, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

// buildDraftExpression (execCommand/native-setter based composer typing) removed as dead code:
// it was never called anywhere in this file. The only live typing path is
// Consumer/ChatGpt/Draft/ChatGptPromptDraft.ts, which types via CDP Input.insertText instead.

function buildInputSnapshotExpression(): string {
  return `(() => { const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const editable = (node) => node instanceof HTMLTextAreaElement || node?.getAttribute?.('contenteditable') === 'true' || node?.classList?.contains('ProseMirror'); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const readText = (node) => { if (!node) return ''; if ('value' in node) return String(node.value || ''); const clone = node.cloneNode(true); for (const excluded of clone.querySelectorAll?.('[contenteditable="false"], button, input, [data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=attachment i], [aria-label*=file i]') || []) excluded.remove(); return String(clone.textContent || ''); }; const rawCandidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(Boolean); const candidates = Array.from(new Set(rawCandidates.map((node) => editable(node) ? node : node.querySelector?.('textarea, [contenteditable="true"], .ProseMirror')).filter((node) => node && editable(node)))); const visibleCandidates = candidates.filter(visible); const active = document.activeElement; const activeEditable = active && editable(active) && visible(active) ? active : null; const nonEmptyVisible = visibleCandidates.filter((node) => readText(node).trim().length > 0); const target = nonEmptyVisible[0] || activeEditable || visibleCandidates[0] || candidates[0] || null; const activeText = activeEditable ? readText(activeEditable) : ''; const targetText = target ? readText(target) : ''; const text = targetText.length > 0 ? targetText : activeText; const fingerprint = target ? [target.tagName, String(target.className || ''), target.getAttribute?.('data-testid') || '', target.getAttribute?.('role') || '', String(visibleCandidates.indexOf(target))].join('|') : null; return { ok: Boolean(target), status: target ? (text.length > 0 ? 'INPUT_TEXT_PRESENT' : 'INPUT_TEXT_EMPTY') : 'INPUT_NOT_FOUND', candidateCount: candidates.length, visibleCandidateCount: visibleCandidates.length, nonEmptyVisibleCandidateCount: nonEmptyVisible.length, textLength: text.length, text, targetTag: target ? target.tagName : null, targetClass: target ? String(target.className || '') : null, targetFingerprint: fingerprint, activeTag: active ? active.tagName : null, activeTextLength: activeText.length, targetTextLength: targetText.length, href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildSubmitControlProbeExpression(): string {
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const uploadBlockers = () => { const text = String(document.body?.innerText || document.documentElement?.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase(); const activePatterns = ['uploading', 'processing', 'reading file', 'reading document', 'indexing', 'attaching']; const failurePatterns = ['file failed', 'upload failed', 'failed to upload', 'unsupported file', 'could not upload', 'couldn\\'t upload']; const active_matches = activePatterns.filter((pattern) => text.includes(pattern)); const failure_matches = failurePatterns.filter((pattern) => text.includes(pattern)); return { uploading: active_matches.some((pattern) => pattern === 'uploading'), processing: active_matches.length > 0, failed: failure_matches.length > 0, unsupported: failure_matches.some((pattern) => pattern.includes('unsupported')), matches: [...active_matches, ...failure_matches].slice(0, 10) }; }; const blockers = uploadBlockers(); const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); let composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); const composerForm = composerNode && composerNode.closest ? composerNode.closest('form') : null; const composerContainer = composerNode ? (composerForm || composerNode.closest('[data-testid*=composer], [class*=composer], main') || document) : document; const explicitCandidates = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible))); const controlScore = (node) => { const testId = String(node.getAttribute('data-testid') || '').toLowerCase(); const aria = String(node.getAttribute('aria-label') || '').toLowerCase(); const type = String(node.getAttribute('type') || '').toLowerCase(); if (testId === 'send-button' || testId === 'composer-submit-button') return 100; if (aria === 'send prompt' || aria === 'send message') return 90; if (testId.includes('send') || testId.includes('submit')) return 80; if (aria.includes('send') || aria.includes('submit')) return 70; if (type === 'submit') return 60; return 0; }; explicitCandidates.sort((left, right) => controlScore(right) - controlScore(left)); const explicit = explicitCandidates.find((node) => controlScore(node) > 0) || null; const nearbyButtons = Array.from((composerContainer || document).querySelectorAll('button')).filter(visible); const enabledNearbyButtons = nearbyButtons.filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const nearbyButtonInventory = nearbyButtons.map((node) => ({ test_id: node.getAttribute('data-testid') || null, aria_label: node.getAttribute('aria-label') || null, title: node.getAttribute('title') || null, type: node.getAttribute('type') || null, disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true', text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) })); const control = explicit; if (!control && composerForm) return { ok: false, status: 'CONTROL_NOT_READY_FORM_PRESENT', found: false, enabled: false, disabled: true, form_present: true, button_count: nearbyButtons.length, nearby_button_inventory: nearbyButtonInventory, upload_blockers: blockers, readyState: document.readyState, href: location.href, title: document.title }; if (!control) return { ok: false, status: 'CONTROL_NOT_READY', found: false, enabled: false, disabled: true, button_count: nearbyButtons.length, nearby_button_inventory: nearbyButtonInventory, upload_blockers: blockers, readyState: document.readyState, href: location.href, title: document.title }; const disabled = Boolean(control.disabled) || control.getAttribute('aria-disabled') === 'true'; const controlRect = control.getBoundingClientRect(); return { ok: !disabled, status: disabled ? 'CONTROL_DISABLED' : 'CONTROL_READY', found: true, enabled: !disabled, disabled, button_count: nearbyButtons.length, control_center_x: controlRect.left + controlRect.width / 2, control_center_y: controlRect.top + controlRect.height / 2, control_test_id: control.getAttribute('data-testid') || null, control_aria_label: control.getAttribute('aria-label') || null, control_type: control.getAttribute('type') || null, upload_blockers: blockers, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildComposerEmptyProbeExpression(): string {
  // Extracted so both submit mechanisms (the real CDP-dispatched mouse click AND the JS-click
  // fallback in buildSendExpression) can check "has a prior call already submitted this?" the same
  // way, before either one fires. Previously this check lived only inside buildSendExpression, so
  // the CDP mouse-click path (added later, now tried first) could re-click Send on an
  // already-submitted message with no guard at all - see ChatGptPromptSubmit.ts submitDraft.
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); const composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); if (!composerNode) return { ok: true, status: 'COMPOSER_NOT_FOUND', composerEmpty: null }; const text = String((composerNode instanceof HTMLTextAreaElement ? composerNode.value : (composerNode.textContent ?? composerNode.innerText)) || '').trim(); return { ok: true, status: text.length === 0 ? 'COMPOSER_EMPTY' : 'COMPOSER_HAS_TEXT', composerEmpty: text.length === 0 }; })()`;
}

function buildSendExpression(): string {
  return `(() => { const composerSelectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', 'textarea', '.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'main form textarea', 'main form [contenteditable="true"]', '[data-testid="prompt-textarea"]']; const selectors = ['button[data-testid="send-button"]', 'button[data-testid="composer-submit-button"]', 'button[data-testid*="send" i]', 'button[data-testid*="submit" i]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[aria-label*="send" i]', 'button[aria-label*="submit" i]', '#composer-submit-button', 'form button[type="submit"]']; const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const composerCandidates = composerSelectors.map((selector) => document.querySelector(selector)).filter(Boolean); let composerNode = composerCandidates.find((node) => node instanceof HTMLTextAreaElement || node.getAttribute('contenteditable') === 'true' || node.classList.contains('ProseMirror')); const composerEmptyText = composerNode ? String((composerNode instanceof HTMLTextAreaElement ? composerNode.value : (composerNode.textContent ?? composerNode.innerText)) || '').trim() : null; if (composerNode && composerEmptyText !== null && composerEmptyText.length === 0) { return { ok: false, status: 'ALREADY_SUBMITTED_COMPOSER_EMPTY', button_count: 0, readyState: document.readyState, href: location.href, title: document.title }; } const composerForm = composerNode && composerNode.closest ? composerNode.closest('form') : null; const composerContainer = composerNode ? (composerForm || composerNode.closest('[data-testid*=composer], [class*=composer], main') || document) : document; const explicitCandidates = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible))); const controlScore = (node) => { const testId = String(node.getAttribute('data-testid') || '').toLowerCase(); const aria = String(node.getAttribute('aria-label') || '').toLowerCase(); const type = String(node.getAttribute('type') || '').toLowerCase(); if (testId === 'send-button' || testId === 'composer-submit-button') return 100; if (aria === 'send prompt' || aria === 'send message') return 90; if (testId.includes('send') || testId.includes('submit')) return 80; if (aria.includes('send') || aria.includes('submit')) return 70; if (type === 'submit') return 60; return 0; }; explicitCandidates.sort((left, right) => controlScore(right) - controlScore(left)); const explicit = explicitCandidates.find((node) => controlScore(node) > 0) || null; const nearbyButtons = Array.from((composerContainer || document).querySelectorAll('button')).filter(visible); const enabledNearbyButtons = nearbyButtons.filter((node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true'); const control = explicit || enabledNearbyButtons.find((node) => { const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || node.innerText || node.textContent || '').toLowerCase(); if (/add files|attach|plus|dictation|voice|model|stop answering|stop generating/.test(label)) return false; if (label.includes('send') || label.includes('submit') || label.includes('arrow')) return true; return String(node.getAttribute('type') || '').toLowerCase() === 'submit'; }) || null; if (control) { if (control.disabled || control.getAttribute('aria-disabled') === 'true') return { ok: false, status: 'CONTROL_DISABLED', button_count: nearbyButtons.length, readyState: document.readyState, href: location.href, title: document.title }; control['cl' + 'ick'](); return { ok: true, status: 'CONTROL_ACTIVATED', button_count: nearbyButtons.length, readyState: document.readyState, href: location.href, title: document.title }; } if (composerForm && typeof composerForm.requestSubmit === 'function') { composerForm.requestSubmit(); return { ok: true, status: 'FORM_REQUEST_SUBMIT_ACTIVATED', button_count: nearbyButtons.length, readyState: document.readyState, href: location.href, title: document.title }; } if (composerForm) { composerForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); return { ok: true, status: 'FORM_SUBMIT_EVENT_DISPATCHED', button_count: nearbyButtons.length, readyState: document.readyState, href: location.href, title: document.title }; } return { ok: false, status: 'CONTROL_NOT_FOUND', button_count: nearbyButtons.length, readyState: document.readyState, href: location.href, title: document.title }; })()`;
}

function buildRateLimitProbeExpression(): string {
  return `(() => { const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; }; const patterns = ['too many requests', 'try again later', 'rate limit', 'sending messages too quickly', 'making requests too quickly', 'temporarily limited access', 'unusual activity']; const surfaces = Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], [aria-modal="true"], [aria-live], [data-testid*=toast], [data-testid*=banner], [class*=toast], [class*=banner]')).filter(visible).map((node) => ({ node, text: clean(node.innerText || node.textContent || node.getAttribute('aria-label') || '') })).filter((item) => item.text.length > 0); const matched = surfaces.find((item) => patterns.some((pattern) => item.text.toLowerCase().includes(pattern))) || null; const text = matched ? matched.text : ''; const lower = text.toLowerCase(); const matches = patterns.filter((pattern) => lower.includes(pattern)); const minuteMatch = lower.match(/(?:try again|retry|available)[^0-9]{0,30}(\\d{1,3})\\s*(?:minute|min)/i); const secondMatch = lower.match(/(?:try again|retry|available)[^0-9]{0,30}(\\d{1,4})\\s*(?:second|sec)/i); const retryAfterMs = minuteMatch ? Number(minuteMatch[1]) * 60000 : (secondMatch ? Number(secondMatch[1]) * 1000 : null); return { ok: true, detected: Boolean(matched), status: matched ? 'RATE_LIMIT_VISIBLE_SURFACE_DETECTED' : 'RATE_LIMIT_VISIBLE_SURFACE_NOT_DETECTED', matches, retryAfterMs, surfaceCount: surfaces.length, surfaceTag: matched ? matched.node.tagName : null, surfaceRole: matched ? matched.node.getAttribute('role') : null, textPreview: text.slice(0, 300), href: location.href, title: document.title, readyState: document.readyState }; })()`;
}

function buildPostSubmitProbeExpression(baselineUserCount: number): string {
  return `(() => { const baselineUserCount = ${JSON.stringify(baselineUserCount)}; const selectors = ['textarea[data-testid="prompt-textarea"]', '#prompt-textarea', '[data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '.ProseMirror', 'main form textarea', 'main form [contenteditable="true"]']; const editable = (node) => node instanceof HTMLTextAreaElement || node?.getAttribute?.('contenteditable') === 'true' || node?.classList?.contains('ProseMirror'); const composerVisible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const readText = (node) => { if (!node) return ''; if ('value' in node) return String(node.value || ''); const clone = node.cloneNode(true); for (const excluded of clone.querySelectorAll?.('[contenteditable="false"], button, input, [data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=attachment i], [aria-label*=file i]') || []) excluded.remove(); return String(clone.textContent || ''); }; const candidates = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).map((node) => editable(node) ? node : node.querySelector?.('textarea, [contenteditable="true"], .ProseMirror')).filter((node) => node && editable(node)))); const visibleCandidates = candidates.filter(composerVisible); const nonEmptyVisible = visibleCandidates.filter((node) => readText(node).trim().length > 0); const composerNode = nonEmptyVisible[0] || visibleCandidates[0] || candidates[0] || null; const text = composerNode ? readText(composerNode).trim() : ''; const pathParts = location.pathname.split('/').filter(Boolean); const chatIndex = pathParts.findIndex((part) => part === 'c' || part === 'chat'); const locationChatId = chatIndex >= 0 ? (pathParts[chatIndex + 1] || '') : ''; const runtimeChatId = locationChatId; const busy = Boolean(document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]')); const root = !locationChatId && (location.pathname === '/' || location.pathname === ''); const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const messageNodes = Array.from(document.querySelectorAll('[data-message-author-role]')).filter(visible); const userMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'user'); const assistantMessages = messageNodes.filter((node) => node.getAttribute('data-message-author-role') === 'assistant'); const messageCount = messageNodes.length; const userMessageCount = userMessages.length; const assistantMessageCount = assistantMessages.length; const userMessageIncreased = userMessageCount > baselineUserCount; const submitted = userMessageIncreased || (text.length === 0 && baselineUserCount > 0 && userMessageCount >= baselineUserCount); const emptyRootAfterClick = root && text.length === 0 && messageCount === 0; const status = submitted ? 'POST_SUBMIT_CONFIRMED' : (emptyRootAfterClick ? 'POST_SUBMIT_ROOT_EMPTY_NO_CHAT_ID' : 'POST_SUBMIT_NOT_CONFIRMED'); return { ok: true, status, submitted, chat_id: runtimeChatId || locationChatId || null, location_chat_id: locationChatId || null, runtime_chat_id: runtimeChatId || null, composer_text_length: text.length, busy, root, message_count: messageCount, user_message_count: userMessageCount, assistant_message_count: assistantMessageCount, user_message_increased: userMessageIncreased, empty_root_after_click: emptyRootAfterClick, href: location.href, title: document.title, readyState: document.readyState }; })()`;
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

function sanitizeNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || "").split("?")[0].slice(0, 500);
  }
}

function sanitizeNetworkHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const sensitive = /authorization|cookie|token|secret|csrf|arkose|session/i;
  for (const [key, value] of Object.entries(headers)) output[key] = sensitive.test(key) ? "[redacted]" : String(value).slice(0, 500);
  return output;
}

function describePostData(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const json = JSON.parse(value) as unknown;
    return { kind: "json", keys: Object.keys(asRecord(json)).sort(), length: value.length };
  } catch {
    return { kind: "text", length: value.length, preview: value.replace(/\s+/g, " ").slice(0, 200) };
  }
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

function normalizeTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 250), 60000) : 10000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
