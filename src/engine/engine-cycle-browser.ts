import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { applyBrowserSessionTitlePrefix, detectChatGptRateLimit, dismissChatGptRateLimit, draftBrowserSessionInput, openChatGptChat, submitBrowserSession } from "../tool/chatgpt-chat-open.js";
import { attachPromptFile, dismissChatGptStorageQuotaDialog, enforceChatGptReasoning, inspectComposerOwnership, resetPersistedComposerDraft, waitForComposerReady, type ChatGptReasoningEnforcement } from "../service/browser-session-executor.js";
import { runChatGptAnswerSettle, runChatGptMessageCapture } from "../tool/chatgpt-message-capture.js";
import { buildActionMarkerReplyBackText, classifyActionMarkerFromText, isContinuingActionMarker, isTerminalActionMarker, normalizeActionMarker } from "./action-marker-router.js";
import { bindEngineChatSession, buildEnginePhasePrompt, clearEngineRateLimitCooldown, getEngineTaskStatus, recordEngineAnswerCapture, recordEngineComposerPreflight, recordEngineExecutionOutcome, recordEngineGatewayDecision, recordEnginePromptDraft, recordEnginePromptSubmit, recordEngineRateLimitCooldown, recordEngineReplyBackDispatch, recordEngineReplyBackDraft, resetEngineCycleRoundState, type EnginePaths } from "./engine-core.js";
import { runEngineCycleStep, type EngineCycleContext, type EngineCycleExecutor, type EngineCycleStage } from "./engine-cycle.js";

export type EngineBrowserCycleExecutorOptions = {
  policy: ConsolePolicy;
  baseDir: string;
  ports: number[];
  url: string;
  activate: boolean;
  allowOverwrite: boolean;
  recoverComposer?: boolean;
  maxMessages: number;
  timeoutMs: number;
  readinessProfile: "quick_probe" | "rc_gate" | "long_run";
  maxWaitMs?: number;
  observationBudgetMs?: number;
  pollMs?: number;
  gatewayModel?: string;
  gatewayMaxOutputTokens: number;
  gatewayTemperature: number;
  gatewayTimeoutMs: number;
  gatewayRaw: boolean;
  gatewayConsoleEndpoint?: string;
  initialReasoningModel?: "gpt-5.5";
  continuationReasoningModel?: "gpt-5.5";
  initialReasoningEffort?: "medium" | "high";
  continuationReasoningEffort?: "medium" | "high";
  reasoningEnforcement?: ChatGptReasoningEnforcement;
};

const ENGINE_CHAT_URL_BLOCKLIST = ["#settings", "/settings", "/connectors", "connector=", "temporary-chat=true"];

export function createEngineBrowserCycleExecutor(options: EngineBrowserCycleExecutorOptions): EngineCycleExecutor {
  return {
    async executeStage(stage: EngineCycleStage, context: EngineCycleContext): Promise<Record<string, unknown>> {
      const cooldown = inspectEngineRateLimitCooldown(context.task);
      if (cooldown.active && stage !== "answer_capture" && stage !== "gateway_decision" && stage !== "complete") {
        return { ok: false, stage, status: "ENGINE_CYCLE_STAGE_NOT_READY", rate_limit_cooldown: cooldown, next_action: "wait for durable rate-limit cooldown; then resume the same task" };
      }
      switch (stage) {
        case "chat_bind": return await executeChatBindStage(options, context);
        case "composer_preflight": return await executeComposerPreflightStage(options, context);
        case "prompt_draft": return await executePromptDraftStage(options, context);
        case "prompt_submit": return await executePromptSubmitStage(options, context);
        case "answer_capture": return await executeAnswerCaptureStage(options, context);
        case "gateway_decision": return await executeGatewayDecisionStage(options, context);
        case "reply_draft": return await executeReplyDraftStage(options, context);
        case "reply_submit": return await executeReplySubmitStage(options, context);
        case "complete": return { ok: true, stage, status: "ENGINE_CYCLE_COMPLETE", task_id: context.taskId, next_action: "no missing stage" };
      }
    },
  };
}

export type EngineCycleRoundOptions = {
  taskId: string;
  maxRounds: number;
  maxStepsPerRound: number;
  stopOnBlocked: boolean;
  stopOnNotReady: boolean;
};

// Shared by console.write.engine.cycle.run_n and the automatic post-authorization dispatch from
// the "go" cmcp flow, so orphan-detection (ENGINE_CYCLE_ANSWER_ORPHANED) and stage blocking stay
// in effect on both the manual and automatic paths.
export async function runEngineCycleRounds(paths: EnginePaths, executorOptions: EngineBrowserCycleExecutorOptions, roundOptions: EngineCycleRoundOptions): Promise<Record<string, unknown>> {
  const executor = createEngineBrowserCycleExecutor(executorOptions);
  const { taskId, maxRounds, maxStepsPerRound, stopOnBlocked, stopOnNotReady } = roundOptions;
  const rounds: Record<string, unknown>[] = [];
  let stopReason = "max_rounds";
  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
    const timeline: Record<string, unknown>[] = [];
    let roundStopReason = "max_steps";
    for (let stepIndex = 0; stepIndex < maxStepsPerRound; stepIndex += 1) {
      const result = await runEngineCycleStep(paths, { taskId, mode: "execute" }, executor);
      timeline.push({ stepIndex, stage: result.stage ?? "unknown", ok: result.ok === true, status: result.status ?? null, next_action: result.next_action ?? null, receipt: summarizeEngineCycleStageReceipt(result) });
      const rateLimitRecovery = extractRateLimitRecovery(result);
      if (rateLimitRecovery.detected && rateLimitRecovery.dismissed) {
        const waitMs = Math.min(rateLimitRecovery.remainingMs ?? rateLimitRecovery.retryAfterMs ?? 90000, 120000);
        timeline.push({
          stepIndex,
          stage: "rate_limit_recovery",
          ok: true,
          status: "ENGINE_RATE_LIMIT_DISMISSED_WAITING_TO_RESUME",
          next_action: "resume the same task after cooldown",
          receipt: { ...rateLimitRecovery, wait_ms: waitMs },
        });
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (result.stage === "complete") { roundStopReason = "complete"; break; }
      if (result.status === "ENGINE_CYCLE_ANSWER_ORPHANED") { roundStopReason = "answer_orphaned"; break; }
      if (stopOnBlocked && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_BLOCKED") { roundStopReason = "blocked"; break; }
      if (stopOnNotReady && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_NOT_READY") { roundStopReason = "not_ready"; break; }
      if (result.ok !== true) { roundStopReason = "error"; break; }
    }
    const status = await getEngineTaskStatus(paths, taskId);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const decisionStatus = typeof task.decision_status === "string" ? task.decision_status : null;
    const decisionMarker = normalizeActionMarker(decisionStatus);
    const decisionDiagnostics = buildDecisionDiagnostics(task);
    rounds.push({ round_index: roundIndex, timeline, round_stop_reason: roundStopReason, decision_status: decisionStatus, action_marker: decisionMarker, decision_diagnostics: decisionDiagnostics });

    if (roundStopReason !== "complete") { stopReason = roundStopReason; break; }
    if (isTerminalActionMarker(decisionMarker)) {
      stopReason = "decision_done:" + decisionMarker;
      break;
    }
    if (!isContinuingActionMarker(decisionMarker)) {
      stopReason = "decision_recheck_required:" + (decisionStatus ?? "unknown");
      break;
    }
    if (roundIndex + 1 >= maxRounds) { stopReason = "max_rounds"; break; }
    const reset = await resetEngineCycleRoundState(paths, taskId);
    if (reset.ok !== true) { stopReason = "reset_failed"; break; }
  }
  const ok = !["blocked", "not_ready", "answer_orphaned", "error", "reset_failed"].includes(stopReason);
  const lastRound = rounds[rounds.length - 1] ?? {};
  const lastTimeline = Array.isArray(lastRound.timeline) ? lastRound.timeline as Record<string, unknown>[] : [];
  const lastStep = lastTimeline[lastTimeline.length - 1] ?? {};
  const receipt = typeof lastStep.receipt === "object" && lastStep.receipt !== null ? lastStep.receipt as Record<string, unknown> : {};
  const outcomeStatus = ok ? "completed" : (stopReason === "not_ready" ? "waiting_runtime" : (stopReason === "error" || stopReason === "reset_failed" ? "failed" : "blocked"));
  const outcomeReason = typeof receipt.inner_status === "string" ? receipt.inner_status : stopReason;
  const outcome = await recordEngineExecutionOutcome(paths, taskId, { status: outcomeStatus, stage: typeof lastStep.stage === "string" ? lastStep.stage : null, reason: outcomeReason, nextAction: buildEngineCycleOutcomeNextAction(ok, stopReason, receipt), receipt });
  return { ok, status: "ENGINE_CYCLE_RUN_N_COMPLETE", task_id: taskId, max_rounds: maxRounds, round_count: rounds.length, stop_reason: stopReason, rounds, outcome, starts_daemon: false };
}

function buildEngineCycleOutcomeNextAction(ok: boolean, stopReason: string, receipt: Record<string, unknown>): string {
  if (ok) return "execution complete";
  if (stopReason === "not_ready") return "retry bounded cycle after runtime becomes ready";
  const innerStatus = typeof receipt.inner_status === "string" ? receipt.inner_status : null;
  if (innerStatus?.startsWith("CHATGPT_REASONING_")) return "inspect ChatGPT reasoning selector state before retrying cmcp go";
  return "inspect blocked stage and recovery receipt";
}

function buildDecisionDiagnostics(task: Record<string, unknown>): Record<string, unknown> {
  return {
    source: task.decision_source ?? null,
    confidence: task.decision_confidence ?? null,
    summary: task.decision_summary ?? null,
    signals: task.decision_signals ?? null,
    praise: task.decision_praise ?? null,
    correction: task.decision_correction ?? null,
    matched: task.decision_matched ?? null,
  };
}

const TRANSIENT_DRAFT_STATUSES = new Set([
  "COMPOSER_NOT_READY",
  "INPUT_NOT_FOUND",
  "COMPOSER_PREFLIGHT_NOT_READY",
  "COMPOSER_FOCUS_NOT_ACQUIRED",
  "INPUT_FOCUS_BLOCKED",
  "INPUT_DRAFT_TARGET_NOT_READY",
  "TARGET_ID_NOT_FOUND",
  "NEED_DEVTOOLS_WEBSOCKET",
]);

export function classifyEngineDraftRetry(result: Record<string, unknown>): { retryable: boolean; status: string | null } {
  const status = typeof result.status === "string" ? result.status : null;
  return { retryable: status !== null && TRANSIENT_DRAFT_STATUSES.has(status), status };
}

async function waitForComposerOwnership(options: EngineBrowserCycleExecutorOptions, targetId: string, expectedText: string): Promise<Record<string, unknown>> {
  const attempts: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  const maxAttempts = 8;
  const intervalMs = 400;
  const emptySettleMs = 2400;
  let lastOwnership: Record<string, unknown> | null = null;
  let consecutiveEmpty = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ownership = await inspectComposerOwnership({ ports: options.ports, targetId, expectedText, timeoutMs: options.timeoutMs });
    lastOwnership = ownership;
    const classification = stringField(ownership, "ownership_classification");
    consecutiveEmpty = classification === "EMPTY" ? consecutiveEmpty + 1 : 0;
    const elapsedMs = Date.now() - startedAt;
    attempts.push({ attempt, ok: ownership.ok === true, status: ownership.status ?? null, ownership_classification: classification, composer_text_length: ownership.composer_text_length ?? null, safe_to_attach: ownership.safe_to_attach === true, consecutive_empty: consecutiveEmpty, elapsed_ms: elapsedMs });
    if (ownership.ok === true && classification === "EXACT_EXPECTED") {
      return { ...ownership, ownership_attempts: attempts, ownership_attempt_count: attempt, ownership_elapsed_ms: elapsedMs };
    }
    if (ownership.ok === true && classification === "EMPTY" && consecutiveEmpty >= 3 && elapsedMs >= emptySettleMs) {
      return { ...ownership, ownership_attempts: attempts, ownership_attempt_count: attempt, ownership_elapsed_ms: elapsedMs };
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ...(lastOwnership ?? {}),
    ok: false,
    status: "COMPOSER_OWNERSHIP_NOT_READY",
    safe_to_attach: false,
    retryable: true,
    ownership_attempts: attempts,
    ownership_attempt_count: attempts.length,
    ownership_elapsed_ms: Date.now() - startedAt,
  };
}

async function draftEngineInputWhenReady(options: EngineBrowserCycleExecutorOptions, targetId: string, draftText: string): Promise<Record<string, unknown>> {
  const maxAttempts = 5;
  const intervalMs = 400;
  const attempts: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const drafted = await draftBrowserSessionInput({ ports: options.ports, expectedTargetId: targetId, draftText, allowOverwrite: options.allowOverwrite, confirmDraft: true, timeoutMs: options.timeoutMs });
    const classification = classifyEngineDraftRetry(drafted);
    attempts.push({ attempt, ok: drafted.ok === true, status: classification.status, retryable: classification.retryable });
    if (drafted.ok === true) return { ...drafted, readiness_attempts: attempts, readiness_attempt_count: attempt, readiness_elapsed_ms: Date.now() - startedAt };
    if (!classification.retryable || attempt >= maxAttempts) return { ...drafted, retryable: classification.retryable, readiness_attempts: attempts, readiness_attempt_count: attempt, readiness_elapsed_ms: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, status: "ENGINE_DRAFT_RETRY_EXHAUSTED", retryable: false, readiness_attempts: attempts, readiness_attempt_count: attempts.length, readiness_elapsed_ms: Date.now() - startedAt };
}

export function summarizeEngineCycleStageReceipt(result: Record<string, unknown>): Record<string, unknown> | null {
  const executed = typeof result.result === "object" && result.result !== null ? result.result as Record<string, unknown> : {};
  const source = objectField(executed, "drafted")
    ?? objectField(executed, "sent")
    ?? objectField(executed, "settled")
    ?? objectField(executed, "opened")
    ?? objectField(executed, "dispatched")
    ?? objectField(result, "drafted")
    ?? objectField(result, "sent")
    ?? objectField(result, "settled")
    ?? objectField(result, "opened")
    ?? objectField(result, "dispatched")
    ?? objectField(result, "ownership")
    ?? objectField(result, "attachment");
  const ownership = objectField(executed, "ownership")
    ?? objectField(result, "ownership")
    ?? objectField(executed, "ownership_after")
    ?? objectField(executed, "ownership_before");
  const attachment = objectField(executed, "attachment") ?? objectField(result, "attachment");
  const reasoning = objectField(executed, "reasoning") ?? objectField(result, "reasoning");
  const reasoningBefore = objectField(reasoning, "before");
  const reasoningAfter = objectField(reasoning, "after");
  const reasoningMutation = objectField(reasoning, "mutation");
  const readiness = objectField(executed, "readiness") ?? objectField(result, "readiness") ?? objectField(source, "readiness");
  const readinessClassification = objectField(readiness, "classification");
  const readinessPreflight = objectField(readiness, "preflight");
  const recovery = objectField(executed, "recovery") ?? objectField(result, "recovery");
  const recoveryVerification = objectField(executed, "recovery_verification") ?? objectField(result, "recovery_verification") ?? objectField(recovery, "verification");
  const temporaryChat = objectField(executed, "temporary_chat") ?? objectField(result, "temporary_chat") ?? objectField(source, "temporary_chat");
  const rateLimit = objectField(executed, "rate_limit") ?? objectField(result, "rate_limit");
  const rateLimitCooldown = objectField(rateLimit, "cooldown") ?? objectField(result, "rate_limit_cooldown");
  const transportState = objectField(attachment, "prompt_transport_state");
  if (!source && !ownership && !attachment && !reasoning && !rateLimit && !rateLimitCooldown) return null;
  return {
    inner_status: source?.status ?? ownership?.status ?? attachment?.status ?? reasoning?.status ?? null,
    retryable: source?.retryable === true || ownership?.retryable === true || transportState?.retryable === true || reasoning?.retryable === true,
    attempt_count: source?.readiness_attempt_count ?? ownership?.ownership_attempt_count ?? null,
    elapsed_ms: source?.readiness_elapsed_ms ?? ownership?.ownership_elapsed_ms ?? null,
    target_id: source?.target_id ?? source?.expected_target_id ?? ownership?.target_id ?? readiness?.target_id ?? null,
    readiness_status: readiness?.status ?? null,
    readiness_retryable: readiness?.retryable === true,
    readiness_attempt_count: readiness?.attempt_count ?? null,
    readiness_elapsed_ms: readiness?.elapsed_ms ?? null,
    readiness_classification_status: readinessClassification?.status ?? null,
    readiness_classification_reason: readinessClassification?.reason ?? null,
    readiness_href: readinessPreflight?.href ?? null,
    readiness_temporary_chat: readinessPreflight?.temporary_chat ?? null,
    draft_verification: source?.draft_verification ?? null,
    mismatch_classification: source?.mismatch_classification ?? null,
    reason: source?.reason ?? source?.error ?? null,
    ownership_classification: ownership?.ownership_classification ?? null,
    composer_text_length: ownership?.composer_text_length ?? null,
    composer_text_hash: ownership?.composer_text_hash ?? null,
    expected_envelope_hash: ownership?.expected_text_hash ?? null,
    attachment_present: transportState?.attached === true,
    attachment_confirmed: transportState?.confirmed === true,
    attachment_hash: transportState?.sha256 ?? null,
    attachment_filename: transportState?.file_name ?? null,
    recovery_status: recovery?.status ?? null,
    recovery_ok: recovery?.ok === true,
    recovery_expected_existing_hash: recovery?.expected_existing_hash ?? null,
    recovery_current_existing_hash: recovery?.current_existing_hash ?? null,
    recovery_verification_classification: recoveryVerification?.ownership_classification ?? null,
    recovery_verification_hash: recoveryVerification?.composer_text_hash ?? null,
    reasoning_status: reasoning?.status ?? null,
    reasoning_ok: reasoning?.ok === true,
    reasoning_mutation_attempted: reasoning?.mutation_attempted === true,
    reasoning_before_status: reasoningBefore?.status ?? null,
    reasoning_after_status: reasoningAfter?.status ?? null,
    reasoning_mutation_status: reasoningMutation?.status ?? null,
    reasoning_mutation_picker_label: reasoningMutation?.picker_label ?? null,
    reasoning_mutation_control_sample: reasoningMutation?.control_sample ?? null,
    reasoning_observed_mode: reasoningAfter?.observed_mode ?? reasoningBefore?.observed_mode ?? null,
    reasoning_observed_effort: reasoningAfter?.observed_effort ?? reasoningBefore?.observed_effort ?? null,
    reasoning_observed_model_label: reasoningAfter?.observed_model_label ?? reasoningBefore?.observed_model_label ?? null,
    temporary_chat_status: temporaryChat?.status ?? null,
    temporary_chat_candidate_count: temporaryChat?.candidate_count ?? null,
    temporary_chat_control_samples: temporaryChat?.control_samples ?? null,
    rate_limit_status: rateLimit?.status ?? (rateLimitCooldown ? "ENGINE_RATE_LIMIT_COOLDOWN_ACTIVE" : null),
    rate_limit_detected: rateLimit?.detected === true || rateLimitCooldown !== null,
    rate_limit_attempt: rateLimitCooldown?.attempt ?? null,
    rate_limit_retry_after_ms: rateLimitCooldown?.retry_after_ms ?? null,
    rate_limit_cooldown_until: rateLimitCooldown?.cooldown_until ?? null,
    rate_limit_remaining_ms: rateLimitCooldown?.remaining_ms ?? null,
    rate_limit_dismissed: rateLimitCooldown?.dismissed === true,
  };
}

function objectField(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const value = source?.[key];
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

async function executeChatBindStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const opened = await openEngineChatPage(options);
  if (opened.ok !== true) return { ok: false, stage: "chat_bind", status: "ENGINE_CYCLE_STAGE_BLOCKED", opened };
  const bound = await bindEngineChatSession(context.paths, context.taskId, opened);
  return { ok: bound.ok === true, stage: "chat_bind", result: bound, next_action: "wait for stable composer readiness" };
}

async function executeComposerPreflightStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  let targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("composer_preflight", context);
  let readiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: options.maxWaitMs ?? 15000, pollMs: options.pollMs ?? 400, minStableSamples: 2 });
  if (readiness.ok !== true && readiness.retryable === true) {
    const reopened = await openEngineChatPage(options);
    if (reopened.ok === true) {
      const rebound = await bindEngineChatSession(context.paths, context.taskId, reopened);
      targetId = stringField(rebound, "target_id") ?? targetId;
      readiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: options.maxWaitMs ?? 15000, pollMs: options.pollMs ?? 400, minStableSamples: 2 });
    }
  }
  if (readiness.ok !== true) {
    const rateLimit = await handleEngineRateLimit(options, context, targetId);
    if (rateLimit.detected === true) return { ok: false, stage: "composer_preflight", status: "ENGINE_CYCLE_STAGE_NOT_READY", readiness, rate_limit: rateLimit, next_action: "wait for durable rate-limit cooldown; then resume the same task" };
    const classification = typeof readiness.classification === "object" && readiness.classification !== null ? readiness.classification as Record<string, unknown> : {};
    return { ok: false, stage: "composer_preflight", status: classification.terminal === true ? "ENGINE_CYCLE_STAGE_BLOCKED" : "ENGINE_CYCLE_STAGE_NOT_READY", readiness, next_action: classification.terminal === true ? "resolve authentication or non-rate-limit overlay" : "retry after ChatGPT composer hydration" };
  }
  await clearEngineRateLimitCooldown(context.paths, context.taskId);
  const recorded = await recordEngineComposerPreflight(context.paths, context.taskId, readiness);
  return { ok: recorded.ok === true, stage: "composer_preflight", result: recorded, readiness, next_action: "draft phase prompt" };
}

async function executePromptDraftStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const built = await buildEnginePhasePrompt(context.paths, context.taskId);
  if (built.ok !== true) return built;
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("prompt_draft", context);
  const initialPrompt = stringField(context.task, "chat_id") === null;
  const finalReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 5000, 5000), pollMs: 250, minStableSamples: 1 });
  if (finalReadiness.ok !== true) {
    const rateLimit = await handleEngineRateLimit(options, context, targetId);
    if (rateLimit.detected === true) return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_NOT_READY", readiness: finalReadiness, rate_limit: rateLimit, next_action: "wait for durable rate-limit cooldown; preserve current draft state" };
    return { ok: false, stage: "prompt_draft", status: finalReadiness.retryable === true ? "ENGINE_CYCLE_STAGE_NOT_READY" : "ENGINE_CYCLE_STAGE_BLOCKED", readiness: finalReadiness, next_action: "revalidate composer before mutation" };
  }
  const envelope = String(built.prompt);
  const ownershipBefore = await waitForComposerOwnership(options, targetId, envelope);
  let recovery: Record<string, unknown> | null = null;
  if (ownershipBefore.ok !== true || ownershipBefore.safe_to_attach !== true) {
    const recoverableHash = stringField(ownershipBefore, "composer_text_hash");
    const recoverableClass = stringField(ownershipBefore, "ownership_classification");
    const readinessPreflight = objectField(finalReadiness, "preflight") ?? {};
    const targetInactive = readinessPreflight.has_focus === false
      || readinessPreflight.hidden === true
      || (typeof readinessPreflight.visibility_state === "string" && readinessPreflight.visibility_state !== "visible");
    const recoverableOwnership = recoverableClass === "FOREIGN_TEXT" || recoverableClass === "OWN_PARTIAL_PREFIX";
    const currentTaskUrl = stringField(context.task, "current_url");
    const freshEngineRootTarget = stringField(context.task, "chat_id") === null
      && currentTaskUrl !== null
      && currentTaskUrl.startsWith("https://chatgpt.com/")
      && numberField(readinessPreflight, "message_count") === 0;
    const recoveryAllowed = recoverableHash !== null
      && recoverableOwnership
      && (options.recoverComposer === true || targetInactive || freshEngineRootTarget);
    if (!recoveryAllowed) {
      return {
        ok: false,
        stage: "prompt_draft",
        status: "ENGINE_CYCLE_STAGE_BLOCKED",
        ownership: ownershipBefore,
        target_inactive: targetInactive,
        next_action: "preserve focused composer; retry with --recover-composer for hash-guarded compare-and-replace",
      };
    }
    recovery = await draftBrowserSessionInput({ ports: options.ports, expectedTargetId: targetId, draftText: envelope, allowOverwrite: true, expectedExistingHash: recoverableHash, confirmDraft: true, timeoutMs: options.timeoutMs });
    if (recovery.ok !== true) {
      const recoveryVerification = await waitForComposerOwnership(options, targetId, envelope);
      if (recoveryVerification.ok !== true || recoveryVerification.ownership_classification !== "EXACT_EXPECTED") {
        return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", ownership: ownershipBefore, recovery, recovery_verification: recoveryVerification, next_action: "composer recovery remained unverified; inspect recovery receipt before retry" };
      }
      recovery = { ...recovery, ok: true, status: "COMPOSER_RECOVERY_VERIFIED_AFTER_AMBIGUOUS_WRITE", verification: recoveryVerification };
    }
  }
  const drafted = ownershipBefore.draft_already_present === true
    ? {
        ok: true,
        status: "ENGINE_DRAFT_ALREADY_PRESENT",
        retryable: false,
        draft_verification: "MATCH",
        draft_hash: ownershipBefore.expected_text_hash,
        draft_length: ownershipBefore.expected_text_length,
        target_id: targetId,
        readiness_attempt_count: 0,
        readiness_elapsed_ms: 0,
      }
    : await draftEngineInputWhenReady(options, targetId, envelope);
  if (drafted.ok !== true) return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", ownership: ownershipBefore, drafted, next_action: "draft phase prompt before attaching execution specification" };
  const attachmentPath = stringField(built, "prompt_attachment_path");
  const attachment = attachmentPath
    ? await attachPromptFile({ ports: options.ports, targetId, filePath: attachmentPath, fileSha256: stringField(built, "execution_specification_hash") ?? undefined, fileSizeBytes: numberField(built, "execution_specification_length") ?? undefined, timeoutMs: options.timeoutMs })
    : null;
  if (attachmentPath && attachment?.ok !== true) return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", ownership: ownershipBefore, drafted, attachment };
  const ownershipAfter = await waitForComposerOwnership(options, targetId, envelope);
  if (ownershipAfter.ok !== true || ownershipAfter.ownership_classification !== "EXACT_EXPECTED") {
    return { ok: false, stage: "prompt_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", ownership: ownershipAfter, drafted, attachment, next_action: "preserve drafted envelope and confirmed attachment; inspect post-attachment composer mutation" };
  }
  const reasoning = await enforceChatGptReasoning({
    ports: options.ports,
    targetId,
    timeoutMs: options.timeoutMs,
    requirement: {
      mode: "thinking",
      model: initialPrompt ? (options.initialReasoningModel ?? "gpt-5.5") : (options.continuationReasoningModel ?? "gpt-5.5"),
      minimumEffort: initialPrompt ? (options.initialReasoningEffort ?? "medium") : (options.continuationReasoningEffort ?? "medium"),
      enforcement: options.reasoningEnforcement ?? "set_and_require",
    },
  });
  const recorded = await recordEnginePromptDraft(context.paths, context.taskId, { ...drafted, ownership_before: ownershipBefore, ownership_after: ownershipAfter, recovery, attachment, reasoning, reasoning_warning: reasoning.ok === true ? null : reasoning.status ?? "CHATGPT_REASONING_UNVERIFIED_BEFORE_SUBMIT", prompt_transport: built.prompt_transport ?? "INLINE_TEXT", prompt_hash: built.prompt_hash, prompt_path: built.prompt_path });
  return { ok: recorded.ok === true, stage: "prompt_draft", result: recorded, next_action: "submit phase prompt" };
}

async function executePromptSubmitStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("prompt_submit", context);
  let submitReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "submit", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 15000, 15000), pollMs: options.pollMs ?? 400, minStableSamples: 2 });
  let storageQuotaRecovery: Record<string, unknown> | null = null;
  if (submitReadiness.ok !== true) {
    storageQuotaRecovery = await dismissChatGptStorageQuotaDialog({ ports: options.ports, targetId, timeoutMs: Math.min(options.timeoutMs, 10000) });
    if (storageQuotaRecovery.dismissed === true) {
      submitReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "submit", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 15000, 15000), pollMs: options.pollMs ?? 400, minStableSamples: 2 });
    }
  }
  if (submitReadiness.ok !== true) {
    const rateLimit = await handleEngineRateLimit(options, context, targetId);
    if (rateLimit.detected === true) return { ok: false, stage: "prompt_submit", status: "ENGINE_CYCLE_STAGE_NOT_READY", readiness: submitReadiness, rate_limit: rateLimit, next_action: "wait for durable rate-limit cooldown; do not redraft or resubmit" };
    const classification = typeof submitReadiness.classification === "object" && submitReadiness.classification !== null ? submitReadiness.classification as Record<string, unknown> : {};
    return { ok: false, stage: "prompt_submit", status: classification.terminal === true ? "ENGINE_CYCLE_STAGE_BLOCKED" : "ENGINE_CYCLE_STAGE_NOT_READY", readiness: submitReadiness, next_action: classification.terminal === true ? "resolve submit blocker" : "retry after attachment and Send control settle" };
  }
  const beforeSubmit = await runChatGptMessageCapture({ ports: options.ports, preferredChatId: typeof context.task.chat_id === "string" ? String(context.task.chat_id) : undefined, expectedTargetId: targetId, requireChatId: true, maxMessages: options.maxMessages, timeoutMs: options.timeoutMs });
  const latestAssistant = typeof beforeSubmit.latest_assistant === "object" && beforeSubmit.latest_assistant !== null ? beforeSubmit.latest_assistant as Record<string, unknown> : {};
  const baselineAssistantHash = stringField(latestAssistant, "hash");
  const sent = await submitBrowserSession({ ports: options.ports, expectedTargetId: targetId, expectedDraftHash: String(context.task.draft_hash), expectedDraftLength: Number(context.task.draft_length), confirmSubmit: true, timeoutMs: options.timeoutMs });
  if (sent.submitted !== true) return { ok: false, stage: "prompt_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", sent, recovery: classifySubmitRecovery(sent) };
  const workspacePath = stringField(context.task, "workspace_path");
  const titlePrefix = workspacePath
    ? await applyBrowserSessionTitlePrefix(options.policy, {
        ports: options.ports,
        expectedTargetId: targetId,
        workspacePath,
        chatTitleMode: "auto",
        waitForChatId: true,
        confirmTitlePrefix: true,
        timeoutMs: Math.min(Math.max(options.timeoutMs, 10000), 30000),
      }).catch((error) => ({ ok: false, status: "ENGINE_CHAT_TITLE_PREFIX_EXCEPTION", error: error instanceof Error ? error.message : String(error) }))
    : { ok: false, status: "ENGINE_CHAT_TITLE_PREFIX_WORKSPACE_MISSING" };
  const selectedAfterSubmit = objectField(titlePrefix, "selected");
  const recorded = await recordEnginePromptSubmit(context.paths, context.taskId, { ...sent, baseline_assistant_hash: baselineAssistantHash, title_prefix: titlePrefix, selected_after_submit: selectedAfterSubmit });
  return { ok: recorded.ok === true, stage: "prompt_submit", result: recorded, title_prefix: titlePrefix, next_action: "capture assistant answer" };
}

async function executeAnswerCaptureStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const baselineAssistantHash = stringField(context.task, "baseline_assistant_hash") ?? undefined;
  const chatId = stringField(context.task, "chat_id") ?? undefined;
  const targetId = stringField(context.task, "target_id") ?? undefined;
  const settled = await runChatGptAnswerSettle({ ports: options.ports, preferredChatId: chatId, expectedTargetId: targetId, expectedTaskId: context.taskId, requireChatId: chatId !== undefined, maxMessages: options.maxMessages, timeoutMs: options.timeoutMs, readinessProfile: options.readinessProfile, maxWaitMs: options.maxWaitMs, observationBudgetMs: options.observationBudgetMs, pollMs: options.pollMs, requireComposerSendMode: false, baselineAssistantHash, lastGuardedAssistantHash: baselineAssistantHash });
  if (settled.ok !== true || settled.settled !== true || settled.ready_for_gate !== true) {
    if (isEngineAnswerOrphaned(context.task, settled)) {
      return { ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_ANSWER_ORPHANED", settled, next_action: "confirm console.write.engine.answer.resubmit_orphaned to resend the same prompt" };
    }
    return { ok: false, stage: "answer_capture", status: "ENGINE_CYCLE_STAGE_NOT_READY", settled };
  }
  const selected = objectField(settled, "selected") ?? {};
  const capturedChatId = stringField(selected, "chat_id") ?? stringField(settled, "chat_id") ?? chatId ?? null;
  const capturedTargetId = stringField(selected, "id") ?? targetId ?? null;
  const workspacePath = stringField(context.task, "workspace_path");
  const titlePrefix = capturedChatId && capturedTargetId && workspacePath
    ? await applyBrowserSessionTitlePrefix(options.policy, {
        ports: options.ports,
        expectedTargetId: capturedTargetId,
        expectedChatId: capturedChatId,
        workspacePath,
        chatTitleMode: "auto",
        waitForChatId: false,
        confirmTitlePrefix: true,
        timeoutMs: Math.min(Math.max(options.timeoutMs, 3000), 10000),
      }).catch((error) => ({ ok: false, status: "ENGINE_CHAT_TITLE_PREFIX_EXCEPTION", error: error instanceof Error ? error.message : String(error) }))
    : { ok: false, status: "ENGINE_CHAT_TITLE_PREFIX_BINDING_INCOMPLETE", chat_id: capturedChatId, target_id: capturedTargetId, workspace_path: workspacePath };
  const recorded = await recordEngineAnswerCapture(context.paths, context.taskId, { ...settled, title_prefix: titlePrefix });
  return { ok: recorded.ok === true, stage: "answer_capture", result: recorded, title_prefix: titlePrefix, next_action: "gateway decision" };
}

// Zero assistant messages past the settle timeout won't resolve on their own, unlike normal NOT_READY (still streaming).
export function isEngineAnswerOrphaned(task: Record<string, unknown>, settled: Record<string, unknown>): boolean {
  if (settled.latest_assistant !== null && settled.latest_assistant !== undefined) return false;
  const submittedAt = stringField(task, "submitted_at");
  if (!submittedAt) return false;
  const submittedAtMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedAtMs)) return false;
  const stability = typeof settled.stability === "object" && settled.stability !== null ? settled.stability as Record<string, unknown> : {};
  const maxWaitMs = typeof stability.max_wait_ms === "number" ? stability.max_wait_ms : null;
  if (maxWaitMs === null) return false;
  return Date.now() - submittedAtMs >= maxWaitMs;
}

async function executeGatewayDecisionStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  void options;
  const routed = classifyActionMarkerFromText(extractLatestAssistantText(context.events));
  const recorded = await recordEngineGatewayDecision(context.paths, context.taskId, routed as unknown as Record<string, unknown>);
  if (recorded.ok !== true || typeof recorded.decision_status !== "string" || recorded.decision_status.length === 0) {
    return {
      ok: false,
      stage: "gateway_decision",
      status: "ACTION_MARKER_DECISION_INVALID",
      retryable: true,
      result: recorded,
      routed,
      next_action: "retry gateway_decision",
    };
  }
  return { ok: true, stage: "gateway_decision", status: "ACTION_MARKER_DECISION_RECORDED", result: recorded, routed, next_action: "draft reply-back" };
}

async function executeReplyDraftStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const replyText = buildReplyBackText(context.taskId, context.task);
  const replyHash = hashText(replyText);
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("reply_draft", context);
  const finalReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 5000, 5000), pollMs: 250, minStableSamples: 1 });
  if (finalReadiness.ok !== true) return { ok: false, stage: "reply_draft", status: finalReadiness.retryable === true ? "ENGINE_CYCLE_STAGE_NOT_READY" : "ENGINE_CYCLE_STAGE_BLOCKED", readiness: finalReadiness, next_action: "revalidate composer before reply mutation" };
  const drafted = await draftEngineInputWhenReady(options, targetId, replyText);
  if (drafted.ok !== true) return { ok: false, stage: "reply_draft", status: "ENGINE_CYCLE_STAGE_BLOCKED", drafted };
  const recorded = await recordEngineReplyBackDraft(context.paths, context.taskId, { ...drafted, reply_back_text: replyText, reply_back_hash: replyHash, reply_back_length: replyText.length });
  return { ok: recorded.ok === true, stage: "reply_draft", result: recorded, next_action: "submit reply-back" };
}

async function executeReplySubmitStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("reply_submit", context);
  const dispatched = await submitBrowserSession({ ports: options.ports, expectedTargetId: targetId, expectedDraftHash: String(context.task.reply_back_hash), expectedDraftLength: Number(context.task.reply_back_length), confirmSubmit: true, timeoutMs: options.timeoutMs });
  if (dispatched.submitted !== true) return { ok: false, stage: "reply_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", dispatched };
  const recorded = await recordEngineReplyBackDispatch(context.paths, context.taskId, dispatched);
  return { ok: recorded.ok === true, stage: "reply_submit", result: recorded, next_action: "cycle complete; capture next answer when ready" };
}

async function openEngineChatPage(options: EngineBrowserCycleExecutorOptions): Promise<Record<string, unknown>> {
  const first = await openChatGptChat(
    options.policy,
    { ports: options.ports, url: options.url, activate: options.activate, confirmOpen: true, timeoutMs: options.timeoutMs },
    { forceNewTarget: true },
  );
  const firstCheck = classifyEngineChatTarget(first);
  if (firstCheck.ok === true) {
    const firstSelected = objectField(first, "selected") ?? {};
    const firstTargetId = stringField(firstSelected, "id");
    if (!firstTargetId) return { ok: false, status: "ENGINE_CHAT_TARGET_ID_MISSING", opened: first };
    const initialReadiness = await waitForComposerReady({ ports: options.ports, targetId: firstTargetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: 30000, pollMs: 300, minStableSamples: 2 });
    if (initialReadiness.ok !== true) return { ok: false, status: "ENGINE_CHAT_INITIAL_READINESS_BLOCKED", opened: first, readiness: initialReadiness, next_action: initialReadiness.retryable === true ? "retry chat_bind after ChatGPT root composer hydration" : "inspect chat_bind readiness receipt" };
    const composerPersistence = await resetPersistedComposerDraft({ ports: options.ports, targetId: firstTargetId, timeoutMs: options.timeoutMs });
    if (composerPersistence.ok !== true) return { ok: false, status: "ENGINE_COMPOSER_PERSISTENCE_RESET_BLOCKED", opened: first, composer_persistence: composerPersistence };
    const temporaryChat = { ok: true, status: "ENGINE_TEMPORARY_CHAT_DISABLED_DURABLE_SESSION_REQUIRED", enabled: false };
    const postToggleComposerReset = { ok: true, status: "ENGINE_POST_TOGGLE_COMPOSER_RESET_NOT_REQUIRED" };
    return { ...first, composer_persistence: composerPersistence, temporary_chat: temporaryChat, durable_chat_required: true, post_toggle_composer_reset: postToggleComposerReset };
  }
  if (first.ok !== true) return first;
  const fallback = await openChatGptChat(
    options.policy,
    { ports: options.ports, url: "https://chatgpt.com/", activate: options.activate, confirmOpen: true, timeoutMs: options.timeoutMs },
    { forceNewTarget: true },
  );
  const fallbackCheck = classifyEngineChatTarget(fallback);
  if (fallbackCheck.ok === true) return { ...fallback, fallback_from_rejected_url: firstCheck.current_url ?? null };
  return { ok: false, status: "ENGINE_CHAT_TARGET_REJECTED", current_url: fallbackCheck.current_url ?? firstCheck.current_url ?? null, first_opened: first, fallback_opened: fallback, next_action: "open a regular https://chatgpt.com/ chat target and retry bind" };
}

function classifySubmitRecovery(sent: Record<string, unknown>): Record<string, unknown> | null {
  const status = typeof sent.status === "string" ? sent.status : null;
  if (status === "INPUT_DRAFT_HASH_MISMATCH" || status === "INPUT_DRAFT_LENGTH_MISMATCH") {
    return {
      status: "ENGINE_PROMPT_REDRAFT_REQUIRED",
      reason: "persisted_draft_guard_mismatch",
      next_action: "clear persisted draft metadata or run prompt_draft again before submit",
      expected_hash: sent.expected_draft_hash ?? null,
      current_hash: sent.current_draft_hash ?? null,
      expected_length: sent.expected_draft_length ?? null,
      current_length: sent.current_draft_length ?? null,
      input_snapshot: sent.input_snapshot ?? null,
    };
  }
  return null;
}

function bindingRequired(stage: EngineCycleStage, context: EngineCycleContext): Record<string, unknown> {
  return {
    ok: false,
    stage,
    status: "ENGINE_CYCLE_BINDING_REQUIRED",
    task_id: context.taskId,
    target_id: null,
    current_url: stringField(context.task, "current_url"),
    next_action: "run chat_bind before browser draft/submit stage",
  };
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inspectEngineRateLimitCooldown(task: Record<string, unknown>): Record<string, unknown> & { active: boolean } {
  const cooldownUntil = stringField(task, "rate_limit_cooldown_until");
  const untilMs = cooldownUntil ? Date.parse(cooldownUntil) : Number.NaN;
  const remainingMs = Number.isFinite(untilMs) ? Math.max(0, untilMs - Date.now()) : 0;
  return {
    active: remainingMs > 0,
    attempt: numberField(task, "rate_limit_attempt") ?? 0,
    detected_at: stringField(task, "rate_limit_detected_at"),
    dismissed_at: stringField(task, "rate_limit_dismissed_at"),
    cooldown_until: cooldownUntil,
    remaining_ms: remainingMs,
    target_id: stringField(task, "rate_limit_target_id") ?? stringField(task, "target_id"),
  };
}

async function handleEngineRateLimit(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext, targetId: string): Promise<Record<string, unknown>> {
  const detection = await detectChatGptRateLimit({ ports: options.ports, maxInspect: 20, timeoutMs: Math.min(options.timeoutMs, 10000) });
  if (detection.detected !== true) return { ok: true, detected: false, status: "ENGINE_RATE_LIMIT_NOT_DETECTED", detection };
  const dismissals = await dismissDetectedRateLimitTargets(options, detection, targetId);
  const dismissal = dismissals.find((item) => stringField(objectField(item, "selected") ?? {}, "id") === targetId)
    ?? dismissals.find((item) => item.dismissed === true)
    ?? { ok: false, dismissed: false, status: "ENGINE_RATE_LIMIT_DISMISS_NOT_APPLIED" };
  const signal = Array.isArray(detection.signals) && detection.signals.length > 0 && typeof detection.signals[0] === "object" && detection.signals[0] !== null ? detection.signals[0] as Record<string, unknown> : {};
  const probe = objectField(signal, "probe") ?? {};
  const retryAfterMs = numberField(dismissal, "retry_after_ms") ?? numberField(probe, "retryAfterMs");
  const dismissedCount = dismissals.filter((item) => item.dismissed === true).length;
  const cooldown = await recordEngineRateLimitCooldown(context.paths, context.taskId, { targetId, retryAfterMs, dismissed: dismissedCount > 0, detection, dismissal: { primary: dismissal, all: dismissals } });
  return { ok: cooldown.ok === true, detected: true, dismissed: dismissedCount > 0, dismissed_count: dismissedCount, status: "ENGINE_RATE_LIMIT_COOLDOWN_RECORDED", detection, dismissal, dismissals, cooldown };
}

async function dismissDetectedRateLimitTargets(options: EngineBrowserCycleExecutorOptions, detection: Record<string, unknown>, fallbackTargetId: string): Promise<Record<string, unknown>[]> {
  const targetIds = new Set<string>();
  const signals = Array.isArray(detection.signals) ? detection.signals : [];
  for (const item of signals) {
    if (typeof item !== "object" || item === null) continue;
    const target = objectField(item as Record<string, unknown>, "target") ?? {};
    const id = stringField(target, "id");
    if (id) targetIds.add(id);
  }
  if (targetIds.size === 0) targetIds.add(fallbackTargetId);
  const dismissals: Record<string, unknown>[] = [];
  for (const expectedTargetId of targetIds) {
    dismissals.push(await dismissChatGptRateLimit({ ports: options.ports, expectedTargetId, confirmDismiss: true, timeoutMs: Math.min(options.timeoutMs, 10000) }));
  }
  return dismissals;
}

function extractRateLimitRecovery(result: Record<string, unknown>): { detected: boolean; dismissed: boolean; retryAfterMs: number | null; remainingMs: number | null; dismissedCount: number } {
  const rateLimit = objectField(result, "rate_limit") ?? objectField(objectField(result, "result") ?? {}, "rate_limit") ?? {};
  const cooldown = objectField(rateLimit, "cooldown") ?? objectField(result, "rate_limit_cooldown") ?? {};
  return {
    detected: rateLimit.detected === true || numberField(cooldown, "remaining_ms") !== null,
    dismissed: rateLimit.dismissed === true || cooldown.dismissed === true,
    retryAfterMs: numberField(cooldown, "retry_after_ms") ?? numberField(rateLimit, "retry_after_ms"),
    remainingMs: numberField(cooldown, "remaining_ms"),
    dismissedCount: numberField(rateLimit, "dismissed_count") ?? 0,
  };
}

function classifyEngineChatTarget(opened: Record<string, unknown>): { ok: true; current_url: string } | { ok: false; current_url: string | null } {
  if (opened.ok !== true) return { ok: false, current_url: null };
  const currentUrl = typeof opened.current_url === "string" ? opened.current_url : "";
  const selected = typeof opened.selected === "object" && opened.selected !== null ? opened.selected as Record<string, unknown> : {};
  const selectedUrl = typeof selected.url === "string" ? selected.url : currentUrl;
  return isEngineChatTargetUrl(selectedUrl) ? { ok: true, current_url: selectedUrl } : { ok: false, current_url: selectedUrl || null };
}

function isEngineChatTargetUrl(value: string): boolean {
  if (!value.startsWith("https://chatgpt.com/")) return false;
  const lower = value.toLowerCase();
  return !ENGINE_CHAT_URL_BLOCKLIST.some((fragment) => lower.includes(fragment));
}

function hashText(value: string): string {
  return Buffer.from(value).toString("base64url").slice(0, 64);
}

function buildReplyBackText(taskId: string, task: Record<string, unknown>): string {
  return buildActionMarkerReplyBackText(taskId, task);
}

function extractLatestAssistantText(events: Record<string, unknown>[]): string {
  const latestCapture = [...events].reverse().find((event) => event.event === "executor_answer_captured") ?? null;
  const captureData = typeof latestCapture?.data === "object" && latestCapture.data !== null ? latestCapture.data as Record<string, unknown> : {};
  const latestAssistant = typeof captureData.latest_assistant === "object" && captureData.latest_assistant !== null ? captureData.latest_assistant as Record<string, unknown> : {};
  return typeof latestAssistant.text === "string" ? latestAssistant.text.slice(0, 12000) : "";
}

