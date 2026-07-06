export function classifySubmitOutcome(value: Record<string, unknown>): Record<string, unknown> {
  const post = asRecord(value.post_submit);
  const submitted = value.submitted === true || post.submitted === true;
  const chatId = asString(value.chat_id) ?? asString(post.chat_id);
  const hasMessages = numberOrZero(value.user_message_count) > 0 || numberOrZero(value.assistant_message_count) > 0 || numberOrZero(post.user_message_count) > 0 || numberOrZero(post.assistant_message_count) > 0;
  const ok = submitted && (Boolean(chatId) || hasMessages);
  return { ok, status: ok ? "CHATGPT_SEND_DONE" : "CHATGPT_SEND_SUBMIT_UNCONFIRMED", submitted: ok, chat_id: chatId };
}

export function classifyChatGptAuthState(input: { visibleText?: string | null; url?: string | null; chatId?: string | null; authLoginTargetCount?: number }): Record<string, unknown> {
  const signals: string[] = [];
  const text = String(input.visibleText ?? "").toLowerCase();
  const url = String(input.url ?? "").toLowerCase();
  if (text.includes("log in to get answers based on saved chats")) signals.push("visible_text_saved_chats_login_prompt");
  if (/\blog in\b/u.test(text)) signals.push("visible_text_log_in");
  if (text.includes("sign up for free")) signals.push("visible_text_sign_up_for_free");
  if (url.includes("/auth/") || url.includes("login") || url.includes("oauth")) signals.push("auth_or_login_url");
  if ((input.authLoginTargetCount ?? 0) > 0) signals.push("auth_login_targets_present");
  if (input.chatId) signals.push("chat_id_present");
  const historyVisible = text.includes("chat history") || text.includes("library") || /\bchats\b/u.test(text);
  if (historyVisible) signals.push("visible_authenticated_history");
  const blockingLoginRequired = signals.some((signal) => signal !== "chat_id_present" && signal !== "visible_authenticated_history" && !(historyVisible && signal === "auth_login_targets_present"));
  const authenticated = blockingLoginRequired ? false : (input.chatId || historyVisible ? true : "unknown");
  return {
    authenticated,
    guest_mode: blockingLoginRequired,
    login_required: blockingLoginRequired,
    signals,
  };
}

export function classifyChatGptSendAuthOutcome(input: { authState: Record<string, unknown>; allowGuestRootSession?: boolean; durable?: boolean; chatId?: string | null }): Record<string, unknown> {
  if (input.authState.login_required === true && input.allowGuestRootSession !== true) {
    return { ok: false, status: "CHATGPT_SEND_AUTH_REQUIRED", submitted: false };
  }
  if (input.allowGuestRootSession === true && input.authState.guest_mode === true && input.durable === true) {
    return { ok: true, status: "CHATGPT_SEND_GUEST_DONE", submitted: true };
  }
  if (input.authState.authenticated === true && Boolean(input.chatId) && input.durable === true) {
    return { ok: true, status: "CHATGPT_SEND_DONE", submitted: true };
  }
  return { ok: false, status: "CHATGPT_SEND_SUBMIT_UNCONFIRMED", submitted: false };
}

export function classifySessionWarmth(input: {
  profileDir?: string | null;
  profileSource?: string | null;
  inventory: Record<string, unknown>;
  authState: Record<string, unknown>;
  selected?: Record<string, unknown>;
  selectedTarget?: Record<string, unknown> | null;
  visibleTextSample?: string;
  preflight?: Record<string, unknown>;
  stateFile?: string;
}): Record<string, unknown> {
  const inventory = input.inventory;
  const authState = input.authState;
  const preflight = asRecord(input.preflight);
  const rootTargetCount = numberOrZero(inventory.root_target_count ?? inventory.empty_home_count);
  const chatTargetCount = numberOrZero(inventory.chat_target_count);
  const authLoginSettingsTargetCount = numberOrZero(inventory.auth_login_settings_target_count);
  const duplicateChatIdCount = numberOrZero(inventory.duplicate_chat_id_count);
  const cdpOk = Array.isArray(inventory.attempts) && inventory.attempts.some((attempt) => asRecord(attempt).ok === true);
  const reasons: string[] = [];
  if (!cdpOk) reasons.push("cdp_not_ready");
  if (authState.login_required === true) reasons.push("login_required");
  if (authState.guest_mode === true) reasons.push("guest_mode");
  const authenticatedChatTargetReady = authState.authenticated === true && chatTargetCount === 1;
  if (authLoginSettingsTargetCount > 0 && !authenticatedChatTargetReady) reasons.push("auth_login_settings_targets_present");
  if (rootTargetCount > 1) reasons.push("ambiguous_root_targets");
  if (duplicateChatIdCount > 0) reasons.push("duplicate_chat_ids_present");
  if (asRecord(preflight.overlay).present === true) reasons.push("overlay_present");
  if (asRecord(preflight.rate_limit).detected === true) reasons.push("rate_limit_detected");
  const hasOneCleanRoot = rootTargetCount === 1 && input.selectedTarget !== null && asRecord(input.selected).ok === true;
  const hasOneChatTarget = chatTargetCount === 1;
  if (!hasOneCleanRoot && !hasOneChatTarget) reasons.push("no_single_clean_root_or_chat_target");

  let status = "CHATGPT_SESSION_WARM";
  let nextAction = "none";
  if (rootTargetCount > 1) {
    status = "CHATGPT_SESSION_WARMTH_AMBIGUOUS_ROOT_TARGET";
    nextAction = "prune duplicate root targets";
  } else if (authState.login_required === true) {
    status = "CHATGPT_SESSION_WARMTH_AUTH_REQUIRED";
    nextAction = "login in supervised Edge profile";
  } else if (authState.guest_mode === true) {
    status = "CHATGPT_SESSION_WARMTH_GUEST_MODE";
    nextAction = "login in supervised Edge profile";
  } else if (authLoginSettingsTargetCount > 0 && !authenticatedChatTargetReady) {
    status = "CHATGPT_SESSION_WARMTH_AUTH_TARGETS_PRESENT";
    nextAction = "close auth/login/settings targets after login is complete";
  } else if (!cdpOk) {
    status = "CHATGPT_SESSION_WARMTH_CDP_NOT_READY";
    nextAction = "start supervised browser with remote debugging";
  } else if (asRecord(preflight.overlay).present === true) {
    status = "CHATGPT_SESSION_WARMTH_OVERLAY_BLOCKED";
    nextAction = "clear browser overlay";
  } else if (asRecord(preflight.rate_limit).detected === true) {
    status = "CHATGPT_SESSION_WARMTH_RATE_LIMIT_BLOCKED";
    nextAction = "wait for rate limit to clear";
  } else if (!hasOneCleanRoot && !hasOneChatTarget) {
    status = "CHATGPT_SESSION_WARMTH_TARGET_NOT_READY";
    nextAction = "open exactly one clean ChatGPT root target or one chat target";
  }
  const ok = status === "CHATGPT_SESSION_WARM";
  return {
    ok,
    status,
    profile_dir: input.profileDir ?? null,
    profile_source: input.profileSource ?? null,
    cdp_ok: cdpOk,
    authenticated: authState.authenticated === true,
    guest_mode: authState.guest_mode === true,
    login_required: authState.login_required === true,
    root_target_count: rootTargetCount,
    chat_target_count: chatTargetCount,
    auth_login_settings_target_count: authLoginSettingsTargetCount,
    duplicate_chat_id_count: duplicateChatIdCount,
    selected_target: input.selectedTarget ?? null,
    visible_text_sample: input.visibleTextSample ?? "",
    reasons,
    next_action: nextAction,
    state_file: input.stateFile ?? null,
    auth_state: authState,
    inventory_summary: summarizeInventory(inventory),
  };
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

export function classifyWarmthRepairEligibility(warmth: Record<string, unknown>): Record<string, unknown> {
  if (warmth.status === "CHATGPT_SESSION_WARM") return { ok: true, status: "CHATGPT_SESSION_WARMTH_REPAIR_NOOP", repair_action: "none" };
  if (warmth.status !== "CHATGPT_SESSION_WARMTH_AMBIGUOUS_ROOT_TARGET") return { ok: false, status: "CHATGPT_SESSION_WARMTH_REPAIR_NOT_APPLICABLE", repair_action: "none" };
  const authState = asRecord(warmth.auth_state);
  if (warmth.login_required === true || authState.login_required === true) {
    return { ok: false, status: "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_LOGIN_REQUIRED", repair_action: "skip", repair_skip_reason: "login_required" };
  }
  if (warmth.guest_mode === true || authState.guest_mode === true) {
    return { ok: false, status: "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_GUEST_MODE", repair_action: "skip", repair_skip_reason: "guest_mode" };
  }
  if (warmth.authenticated !== true || authState.authenticated !== true) {
    return { ok: false, status: "CHATGPT_SESSION_WARMTH_REPAIR_SKIPPED_AUTH_UNKNOWN", repair_action: "skip", repair_skip_reason: "authenticated_state_unknown" };
  }
  return { ok: true, status: "CHATGPT_SESSION_WARMTH_REPAIR_APPLICABLE", repair_action: "prune_duplicate_root_targets" };
}

export function chooseWarmthRepairKeepTargetId(inventory: Record<string, unknown>, warmth: Record<string, unknown> = {}): Record<string, unknown> {
  const targets = extractPruneCandidateRecords(inventory);
  const chatTargets = stableSortTargets(targets.filter((target) => Boolean(asString(target.chat_id)) && Boolean(asString(target.id))));
  if (chatTargets.length > 0) return { keep_target_id: asString(chatTargets[0].id), keep_reason: "chat_target_present" };

  const roots = stableSortTargets(targets.filter(isExactRootTargetRecord));
  const rootIds = new Set(roots.map((target) => asString(target.id)).filter((id): id is string => Boolean(id)));
  const selectedId = asString(asRecord(warmth.selected_target).id)
    ?? asString(asRecord(warmth.selected).id)
    ?? asString(asRecord(asRecord(warmth.selected).selected_target).id);
  if (selectedId && rootIds.has(selectedId)) return { keep_target_id: selectedId, keep_reason: "selected_root_target" };

  const active = roots.find((target) => target.active === true || target.selected === true || target.attached === true);
  if (active) return { keep_target_id: asString(active.id), keep_reason: "active_root_target" };
  return { keep_target_id: asString(roots[0]?.id), keep_reason: roots.length > 0 ? "stable_root_target" : "no_root_target" };
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

function isExactRootTargetRecord(value: Record<string, unknown>): boolean {
  return value.type === "page"
    && asString(value.url) === "https://chatgpt.com/"
    && (value.chat_id === null || typeof value.chat_id === "undefined")
    && (typeof value.id === "string" && value.id.length > 0);
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
