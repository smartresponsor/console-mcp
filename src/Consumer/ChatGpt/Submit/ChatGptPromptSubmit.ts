import { extractChatGptChatId } from "../../../service/chatgpt-artifact-guard.js";
import type { BrowserSessionOptions, ChatGptTarget } from "../../../service/browser-session-executor.js";

type PromptSubmitDependencies = {
  inventoryChatGptTargets: (input: BrowserSessionOptions) => Promise<Record<string, unknown>>;
  selectCleanChatGptRootTarget: (input: BrowserSessionOptions) => Promise<Record<string, unknown>>;
  resolveTarget: (input: BrowserSessionOptions) => Promise<{ ok: boolean; status: string; target: ChatGptTarget | null; inventory_summary?: Record<string, unknown>; candidate_rejections?: unknown; selected_target_candidates?: unknown }>;
  inspectComposerPreflight: (input: BrowserSessionOptions) => Promise<Record<string, unknown>>;
  inspectAuthStatus: (input: BrowserSessionOptions) => Promise<Record<string, unknown>>;
  detectRateLimitForTarget: (target: ChatGptTarget, timeoutMs: number) => Promise<Record<string, unknown>>;
  draftInput: (input: BrowserSessionOptions & { prompt: string }) => Promise<Record<string, unknown>>;
  verifyDraftInTarget: (input: BrowserSessionOptions & { expected: string }) => Promise<Record<string, unknown>>;
  captureMessages: (input: BrowserSessionOptions & { maxMessages?: number; requireChatId?: boolean }) => Promise<Record<string, unknown>>;
  resolveChatGptDocumentTargetWithChatId: (port: number, targetId: string, timeoutMs: number) => Promise<ChatGptTarget | null>;
  safeEvaluateInTarget: (webSocketUrl: string, expression: string, timeoutMs: number, failureStatus: string) => Promise<unknown>;
  safeSendDevToolsCommand: (webSocketUrl: string, method: string, params: Record<string, unknown>, timeoutMs: number, failureStatus: string) => Promise<Record<string, unknown>>;
  buildSubmitControlProbeExpression: () => string;
  buildSendExpression: () => string;
  buildPostSubmitProbeExpression: (baselineUserCount: number) => string;
  buildSendOutcome: (input: {
    ok: boolean;
    status: string;
    selected?: Record<string, unknown>;
    inventory?: Record<string, unknown>;
    preflight?: Record<string, unknown>;
    authStatus?: Record<string, unknown>;
    draft?: Record<string, unknown>;
    submitted?: Record<string, unknown>;
    messages?: Record<string, unknown>;
    resolved?: ChatGptTarget | null;
    timeoutMs: number;
    startedAt: string;
    beforeUrl?: string | null;
    afterUrl?: string | null;
    chatId?: string | null;
    submittedFlag?: boolean;
    nextAction?: string | null;
    retrySafe?: boolean;
  }) => Record<string, unknown>;
  compactChatGptTarget: (target: ChatGptTarget) => Record<string, unknown>;
  isChatGptRootUrl: (rawUrl: string) => boolean;
  normalizeTimeout: (value: unknown) => number;
  delay: (ms: number) => Promise<void>;
  smokePrompt: string;
};

export function createChatGptPromptSubmit(deps: PromptSubmitDependencies) {
  async function submitDraft(input: BrowserSessionOptions & { confirmSubmit?: boolean; expectedPrompt?: string }): Promise<Record<string, unknown>> {
    if (input.confirmSubmit !== true) return { ok: false, status: "CONFIRM_SUBMIT_REQUIRED", submitted: false, retry_safe: true };
    const selected = await deps.resolveTarget(input);
    if (!selected.ok || !selected.target) return { ...selected, ok: false, status: "SUBMIT_TARGET_NOT_READY", submitted: false, retry_safe: true };
    const target = selected.target;
    if (!target.web_socket_debugger_url) return { ok: false, status: "NEED_DEVTOOLS_WEBSOCKET", selected: deps.compactChatGptTarget(target), submitted: false, retry_safe: true };
    let beforePreflight = await deps.inspectComposerPreflight({ ...input, targetId: target.id });
    const initialOverlay = asRecord(beforePreflight.overlay);
    const overlayText = String(initialOverlay.textSample ?? "").toLowerCase();
    const staleSearchOverlay = initialOverlay.present === true
      && initialOverlay.coversComposer === true
      && (overlayText.includes("no results") || overlayText.includes("search chats"));
    if (staleSearchOverlay) {
      const recovery = await deps.safeEvaluateInTarget(
        target.web_socket_debugger_url,
        `(() => { const visible = (node) => { if (!node || !(node instanceof Element)) return false; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; }; const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase(); const surfaces = Array.from(document.querySelectorAll('.fixed.inset-0, [role="dialog"], [aria-modal="true"]')).filter(visible); const searchSurface = surfaces.find((node) => { const text = clean(node.innerText || node.textContent || ''); return text.includes('no results') || text.includes('search chats') || Boolean(node.querySelector('input[placeholder*="search" i], input[aria-label*="search" i]')); }) || null; if (!searchSurface) return { ok: true, status: 'STALE_SEARCH_OVERLAY_NOT_PRESENT' }; const controls = Array.from(searchSurface.querySelectorAll('button, [role="button"]')).filter(visible); const close = controls.find((node) => { const label = clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || ''); return label === 'close' || label === 'cancel' || label.includes('close search'); }) || null; if (close) close.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return { ok: true, status: 'STALE_SEARCH_OVERLAY_DISMISS_ATTEMPTED', close_control_used: Boolean(close) }; })()`,
        Math.min(deps.normalizeTimeout(input.timeoutMs), 2000),
        "STALE_SEARCH_OVERLAY_DISMISS_FAILED",
      );
      await deps.delay(200);
      beforePreflight = await deps.inspectComposerPreflight({ ...input, targetId: target.id });
      if (asRecord(beforePreflight.overlay).present === true) {
        return { ok: false, status: "SESSION_SUBMIT_BLOCKED_OVERLAY", selected: deps.compactChatGptTarget(target), preflight: beforePreflight, overlay_recovery: recovery, submitted: false, retry_safe: true };
      }
    }
    if (asRecord(beforePreflight.overlay).present === true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED_OVERLAY", selected: deps.compactChatGptTarget(target), preflight: beforePreflight, submitted: false, retry_safe: true };
    const rateLimit = await deps.detectRateLimitForTarget(target, deps.normalizeTimeout(input.timeoutMs));
    if (rateLimit.detected === true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED_RATE_LIMIT", selected: deps.compactChatGptTarget(target), rate_limit: rateLimit, submitted: false, retry_safe: true };
    if (input.expectedPrompt) {
      const verification = await deps.verifyDraftInTarget({ ...input, targetId: target.id, expected: input.expectedPrompt });
      if (verification.draft_verification === "MISMATCH" && verification.mismatch_classification === "content_changed") {
        return { ok: false, status: "SESSION_SUBMIT_BLOCKED_DRAFT_MISMATCH", selected: deps.compactChatGptTarget(target), draft_verification: verification, submitted: false, retry_safe: true };
      }
    }
    const control = await deps.safeEvaluateInTarget(target.web_socket_debugger_url, deps.buildSubmitControlProbeExpression(), Math.min(deps.normalizeTimeout(input.timeoutMs), 1000), "CONTROL_PROBE_EVALUATION_FAILED");
    const controlRecord = asRecord(control);
    if (controlRecord.ok !== true) return { ok: false, status: "SUBMIT_CONTROL_NOT_READY", selected: deps.compactChatGptTarget(target), control, submitted: false, retry_safe: true };
    const beforeMessages = await deps.captureMessages({ ...input, targetId: target.id, requireChatId: false });
    const centerX = typeof controlRecord.control_center_x === "number" ? controlRecord.control_center_x : null;
    const centerY = typeof controlRecord.control_center_y === "number" ? controlRecord.control_center_y : null;
    const mouseDown = centerX !== null && centerY !== null
      ? await deps.safeSendDevToolsCommand(target.web_socket_debugger_url, "Input.dispatchMouseEvent", { type: "mousePressed", x: centerX, y: centerY, button: "left", clickCount: 1 }, deps.normalizeTimeout(input.timeoutMs), "SUBMIT_MOUSE_DOWN_FAILED")
      : { ok: false, status: "SUBMIT_MOUSE_DOWN_SKIPPED_COORDINATES_MISSING" };
    const mouseUp = mouseDown.ok === true && centerX !== null && centerY !== null
      ? await deps.safeSendDevToolsCommand(target.web_socket_debugger_url, "Input.dispatchMouseEvent", { type: "mouseReleased", x: centerX, y: centerY, button: "left", clickCount: 1 }, deps.normalizeTimeout(input.timeoutMs), "SUBMIT_MOUSE_UP_FAILED")
      : { ok: false, status: "SUBMIT_MOUSE_UP_SKIPPED_MOUSE_DOWN_FAILED" };
    const submit = mouseDown.ok === true && mouseUp.ok === true
      ? { ok: true, status: "CDP_SEND_CONTROL_CLICKED", control: controlRecord, mouse_down: mouseDown, mouse_up: mouseUp }
      : asRecord(await deps.safeEvaluateInTarget(target.web_socket_debugger_url, deps.buildSendExpression(), deps.normalizeTimeout(input.timeoutMs), "SUBMIT_EVALUATION_FAILED"));
    // ALREADY_SUBMITTED_COMPOSER_EMPTY (see buildSendExpression) means the composer was found empty
    // right before we would have clicked - i.e. a PRIOR call already fired the real submit action and
    // this call correctly did NOT click again. This is the one outcome that must never be reported the
    // same way as a genuine click failure: retry_safe=false here, unconditionally, regardless of
    // whether we can also confirm the message landed - a caller retrying on "not confirmed" is exactly
    // the double-send this guard exists to prevent.
    if (submit.status === "ALREADY_SUBMITTED_COMPOSER_EMPTY") {
      const postSubmit = await resolvePostSubmitState(target.web_socket_debugger_url, Math.min(deps.normalizeTimeout(input.timeoutMs), 5000), beforeMessages);
      const submitted = postSubmit.submitted === true;
      return {
        ok: submitted,
        status: "SESSION_ALREADY_SUBMITTED",
        target_id: target.id ?? null,
        port: target.port,
        selected: deps.compactChatGptTarget(target),
        submit,
        post_submit: postSubmit,
        submitted,
        retry_safe: false,
      };
    }
    if (submit.ok !== true) return { ok: false, status: "SESSION_SUBMIT_BLOCKED", selected: deps.compactChatGptTarget(target), submit, submitted: false, retry_safe: true };
    const postSubmit = await resolvePostSubmitState(target.web_socket_debugger_url, Math.min(deps.normalizeTimeout(input.timeoutMs), 5000), beforeMessages);
    const submitted = postSubmit.submitted === true;
    return {
      ok: submitted,
      status: submitted ? "SESSION_SUBMITTED" : "SESSION_SUBMIT_NOT_CONFIRMED",
      target_id: target.id ?? null,
      port: target.port,
      selected: deps.compactChatGptTarget(target),
      submit,
      post_submit: postSubmit,
      submitted,
      // The click/requestSubmit() ITSELF already executed successfully (submit.ok === true) by this
      // point, whether or not we could confirm the effect within the post-submit poll window. That
      // action is irreversible, so this is never retry-safe - a caller that retries sendPrompt because
      // it saw ok:false here (SESSION_SUBMIT_NOT_CONFIRMED, a confirmation timeout, not a click failure)
      // would click Send a second time on an already-submitted message. Only the early-return paths
      // above, where the click never happened at all, are safe to retry.
      retry_safe: false,
    };
  }

  async function resolvePostSubmitState(webSocketUrl: string, timeoutMs: number, baselineMessages?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deadline = Date.now() + Math.min(timeoutMs, 5000);
    let last: Record<string, unknown> | null = null;
    const baselineUserCount = numberOrZero(baselineMessages?.user_message_count);
    while (Date.now() <= deadline) {
      const value = await deps.safeEvaluateInTarget(webSocketUrl, deps.buildPostSubmitProbeExpression(baselineUserCount), Math.min(timeoutMs, 1000), "POST_SUBMIT_PROBE_EVALUATION_FAILED");
      const state = asRecord(value);
      last = state;
      if (state.submitted === true) return state;
      await deps.delay(150);
    }
    return last ?? { ok: false, status: "POST_SUBMIT_UNKNOWN", submitted: false };
  }

  async function sendPrompt(input: BrowserSessionOptions & { prompt: string; confirmSend?: boolean }): Promise<Record<string, unknown>> {
    const startedAt = new Date().toISOString();
    const timeoutMs = deps.normalizeTimeout(input.timeoutMs);
    const inventory = await deps.inventoryChatGptTargets(input);
    const selected = await deps.selectCleanChatGptRootTarget(input);
    const target = selected.target as ChatGptTarget | undefined;
    const beforeUrl = target?.url ?? null;
    if (!selected.ok || !target) return deps.buildSendOutcome({ ok: false, status: selected.status === "TARGET_SELECTION_AMBIGUOUS" ? "CHATGPT_SEND_TARGET_AMBIGUOUS" : "CHATGPT_SEND_TARGET_NOT_READY", selected, inventory, timeoutMs, startedAt });
    const preflight = await deps.inspectComposerPreflight({ ...input, targetId: target.id, timeoutMs });
    const authStatus = await deps.inspectAuthStatus({ ...input, targetId: target.id, timeoutMs });
    const authState = asRecord(authStatus.auth_state);
    if (authState.login_required === true && input.allowGuestRootSession !== true) {
      return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_AUTH_REQUIRED", selected, inventory, preflight, authStatus, timeoutMs, startedAt, beforeUrl, submittedFlag: false, nextAction: "login in the supervised browser profile or rerun with explicit AllowGuestRootSession" });
    }
    if (asRecord(preflight.rate_limit).detected === true) return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_RATE_LIMIT_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
    if (asRecord(preflight.overlay).present === true) return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_OVERLAY_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
    if (preflight.ok !== true) return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_PREFLIGHT_BLOCKED", selected, inventory, preflight, timeoutMs, startedAt, beforeUrl });
    const draft = await deps.draftInput({ ...input, targetId: target.id, timeoutMs });
    if (draft.ok !== true) return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_DRAFT_BLOCKED", selected, inventory, preflight, draft, timeoutMs, startedAt, beforeUrl });
    if (draft.draft_verification === "MISMATCH" && draft.mismatch_classification === "content_changed") return deps.buildSendOutcome({ ok: false, status: "CHATGPT_SEND_DRAFT_CONTENT_CHANGED", selected, inventory, preflight, draft, timeoutMs, startedAt, beforeUrl, submittedFlag: false, nextAction: "do not submit; regenerate or shrink the prompt and verify draft again" });
    if (input.confirmSend !== true) return deps.buildSendOutcome({ ok: false, status: "CONFIRM_CHATGPT_SEND_REQUIRED", selected, inventory, preflight, draft, timeoutMs, startedAt, beforeUrl });
    const submitted = await submitDraft({ ...input, targetId: target.id, confirmSubmit: true, timeoutMs });
    const resolved = target.id ? await deps.resolveChatGptDocumentTargetWithChatId(target.port, target.id, Math.min(Math.max(timeoutMs, 30000), 60000)) : null;
    const finalTarget = resolved ?? target;
    const messages = await deps.captureMessages({ ...input, targetId: target.id, requireChatId: false, timeoutMs });
    const afterUrl = finalTarget.runtime_href ?? finalTarget.url ?? asString(asRecord(submitted.post_submit).href) ?? null;
    const chatId = finalTarget.runtime_chat_id ?? finalTarget.chat_id ?? (afterUrl ? extractChatGptChatId(afterUrl) : null) ?? asString(asRecord(submitted.post_submit).chat_id);
    const durable = submitted.submitted === true || Boolean(chatId) || numberOrZero(messages.user_message_count) > 0 || numberOrZero(messages.assistant_message_count) > 0;
    const rootUnconfirmed = deps.isChatGptRootUrl(afterUrl ?? "") && !durable;
    const authenticated = authState.authenticated === true;
    const guestDone = input.allowGuestRootSession === true && authState.guest_mode === true && durable;
    const persistentDone = authenticated && Boolean(chatId) && durable;
    // submitted.retry_safe comes straight from submitDraft: false means the actual click/submit action
    // already fired (or a prior call's click was detected via the empty-composer guard) and calling
    // sendPrompt again with the same prompt would re-click Send on an already-submitted message. Only
    // pass retrySafe=true through when submitDraft itself says it never reached the click at all.
    const retrySafe = persistentDone || guestDone ? false : submitted.retry_safe !== false;
    return deps.buildSendOutcome({
      ok: persistentDone || guestDone,
      status: persistentDone ? "CHATGPT_SEND_DONE" : (guestDone ? "CHATGPT_SEND_GUEST_DONE" : (submitted.status === "SESSION_ALREADY_SUBMITTED" ? "CHATGPT_SEND_ALREADY_SUBMITTED" : (submitted.ok === true && !rootUnconfirmed ? "CHATGPT_SEND_SUBMIT_UNCONFIRMED" : "CHATGPT_SEND_SUBMIT_BLOCKED"))),
      selected,
      inventory,
      preflight,
      authStatus,
      draft,
      submitted,
      messages,
      resolved,
      timeoutMs,
      startedAt,
      beforeUrl,
      afterUrl,
      chatId,
      retrySafe,
    });
  }

  async function sendSmoke(input: BrowserSessionOptions & { confirmSend?: boolean } = {}): Promise<Record<string, unknown>> {
    return await sendPrompt({ ...input, prompt: deps.smokePrompt, confirmSend: input.confirmSend === true });
  }

  return { submitDraft, resolvePostSubmitState, sendPrompt, sendSmoke };
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
