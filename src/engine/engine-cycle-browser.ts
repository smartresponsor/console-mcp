import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import { executeAsk } from "../tool/ask.js";
import { applyBrowserSessionTitlePrefix, draftBrowserSessionInput, openChatGptChat, submitBrowserSession } from "../tool/chatgpt-chat-open.js";
import { attachPromptFile, inspectComposerOwnership, resetPersistedComposerDraft, waitForComposerReady } from "../service/browser-session-executor.js";
import { runChatGptAnswerSettle, runChatGptMessageCapture } from "../tool/chatgpt-message-capture.js";
import { bindEngineChatSession, buildEnginePhasePrompt, getEngineTaskStatus, recordEngineAnswerCapture, recordEngineComposerPreflight, recordEngineExecutionOutcome, recordEngineGatewayDecision, recordEnginePromptDraft, recordEnginePromptSubmit, recordEngineReplyBackDispatch, recordEngineReplyBackDraft, resetEngineCycleRoundState, type EnginePaths } from "./engine-core.js";
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
};

const ENGINE_CHAT_URL_BLOCKLIST = ["#settings", "/settings", "/connectors", "connector="];

export function createEngineBrowserCycleExecutor(options: EngineBrowserCycleExecutorOptions): EngineCycleExecutor {
  return {
    async executeStage(stage: EngineCycleStage, context: EngineCycleContext): Promise<Record<string, unknown>> {
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

const ENGINE_CYCLE_CONTINUE_DECISION_STATUSES = new Set(["CONTINUE"]);

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
      if (result.stage === "complete") { roundStopReason = "complete"; break; }
      if (result.status === "ENGINE_CYCLE_ANSWER_ORPHANED") { roundStopReason = "answer_orphaned"; break; }
      if (stopOnBlocked && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_BLOCKED") { roundStopReason = "blocked"; break; }
      if (stopOnNotReady && result.ok !== true && result.status === "ENGINE_CYCLE_STAGE_NOT_READY") { roundStopReason = "not_ready"; break; }
      if (result.ok !== true) { roundStopReason = "error"; break; }
    }
    const status = await getEngineTaskStatus(paths, taskId);
    const task = typeof status.task === "object" && status.task !== null ? status.task as Record<string, unknown> : {};
    const decisionStatus = typeof task.decision_status === "string" ? task.decision_status : null;
    rounds.push({ round_index: roundIndex, timeline, round_stop_reason: roundStopReason, decision_status: decisionStatus });

    if (roundStopReason !== "complete") { stopReason = roundStopReason; break; }
    if (!decisionStatus || !ENGINE_CYCLE_CONTINUE_DECISION_STATUSES.has(decisionStatus.toUpperCase())) {
      stopReason = "decision_terminal:" + (decisionStatus ?? "unknown");
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
  const outcome = await recordEngineExecutionOutcome(paths, taskId, { status: outcomeStatus, stage: typeof lastStep.stage === "string" ? lastStep.stage : null, reason: typeof receipt.inner_status === "string" ? receipt.inner_status : stopReason, nextAction: ok ? "execution complete" : (stopReason === "not_ready" ? "retry bounded cycle after runtime becomes ready" : "inspect blocked stage and recovery receipt") });
  return { ok, status: "ENGINE_CYCLE_RUN_N_COMPLETE", task_id: taskId, max_rounds: maxRounds, round_count: rounds.length, stop_reason: stopReason, rounds, outcome, starts_daemon: false };
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
  const recovery = objectField(executed, "recovery") ?? objectField(result, "recovery");
  const recoveryVerification = objectField(executed, "recovery_verification") ?? objectField(result, "recovery_verification") ?? objectField(recovery, "verification");
  const temporaryChat = objectField(executed, "temporary_chat") ?? objectField(result, "temporary_chat") ?? objectField(source, "temporary_chat");
  const transportState = objectField(attachment, "prompt_transport_state");
  if (!source && !ownership && !attachment) return null;
  return {
    inner_status: source?.status ?? ownership?.status ?? attachment?.status ?? null,
    retryable: source?.retryable === true || ownership?.retryable === true || transportState?.retryable === true,
    attempt_count: source?.readiness_attempt_count ?? ownership?.ownership_attempt_count ?? null,
    elapsed_ms: source?.readiness_elapsed_ms ?? ownership?.ownership_elapsed_ms ?? null,
    target_id: source?.target_id ?? source?.expected_target_id ?? ownership?.target_id ?? null,
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
    temporary_chat_status: temporaryChat?.status ?? null,
    temporary_chat_candidate_count: temporaryChat?.candidate_count ?? null,
    temporary_chat_control_samples: temporaryChat?.control_samples ?? null,
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
    const classification = typeof readiness.classification === "object" && readiness.classification !== null ? readiness.classification as Record<string, unknown> : {};
    return { ok: false, stage: "composer_preflight", status: classification.terminal === true ? "ENGINE_CYCLE_STAGE_BLOCKED" : "ENGINE_CYCLE_STAGE_NOT_READY", readiness, next_action: classification.terminal === true ? "resolve authentication, overlay, or rate-limit block" : "retry after ChatGPT composer hydration" };
  }
  const recorded = await recordEngineComposerPreflight(context.paths, context.taskId, readiness);
  return { ok: recorded.ok === true, stage: "composer_preflight", result: recorded, readiness, next_action: "draft phase prompt" };
}

async function executePromptDraftStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const built = await buildEnginePhasePrompt(context.paths, context.taskId);
  if (built.ok !== true) return built;
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("prompt_draft", context);
  const finalReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 5000, 5000), pollMs: 250, minStableSamples: 1 });
  if (finalReadiness.ok !== true) return { ok: false, stage: "prompt_draft", status: finalReadiness.retryable === true ? "ENGINE_CYCLE_STAGE_NOT_READY" : "ENGINE_CYCLE_STAGE_BLOCKED", readiness: finalReadiness, next_action: "revalidate composer before mutation" };
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
  const recorded = await recordEnginePromptDraft(context.paths, context.taskId, { ...drafted, ownership_before: ownershipBefore, ownership_after: ownershipAfter, recovery, attachment, prompt_transport: built.prompt_transport ?? "INLINE_TEXT", prompt_hash: built.prompt_hash, prompt_path: built.prompt_path });
  return { ok: recorded.ok === true, stage: "prompt_draft", result: recorded, next_action: "submit phase prompt" };
}

async function executePromptSubmitStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const targetId = stringField(context.task, "target_id");
  if (!targetId) return bindingRequired("prompt_submit", context);
  const submitReadiness = await waitForComposerReady({ ports: options.ports, targetId, mode: "submit", timeoutMs: options.timeoutMs, maxWaitMs: Math.min(options.maxWaitMs ?? 15000, 15000), pollMs: options.pollMs ?? 400, minStableSamples: 2 });
  if (submitReadiness.ok !== true) {
    const classification = typeof submitReadiness.classification === "object" && submitReadiness.classification !== null ? submitReadiness.classification as Record<string, unknown> : {};
    return { ok: false, stage: "prompt_submit", status: classification.terminal === true ? "ENGINE_CYCLE_STAGE_BLOCKED" : "ENGINE_CYCLE_STAGE_NOT_READY", readiness: submitReadiness, next_action: classification.terminal === true ? "resolve submit blocker" : "retry after attachment and Send control settle" };
  }
  const beforeSubmit = await runChatGptMessageCapture({ ports: options.ports, preferredChatId: typeof context.task.chat_id === "string" ? String(context.task.chat_id) : undefined, expectedTargetId: targetId, requireChatId: true, maxMessages: options.maxMessages, timeoutMs: options.timeoutMs });
  const latestAssistant = typeof beforeSubmit.latest_assistant === "object" && beforeSubmit.latest_assistant !== null ? beforeSubmit.latest_assistant as Record<string, unknown> : {};
  const baselineAssistantHash = stringField(latestAssistant, "hash");
  const sent = await submitBrowserSession({ ports: options.ports, expectedTargetId: targetId, expectedDraftHash: String(context.task.draft_hash), expectedDraftLength: Number(context.task.draft_length), confirmSubmit: true, timeoutMs: options.timeoutMs });
  if (sent.submitted !== true) return { ok: false, stage: "prompt_submit", status: "ENGINE_CYCLE_STAGE_BLOCKED", sent, recovery: classifySubmitRecovery(sent) };
  const recorded = await recordEnginePromptSubmit(context.paths, context.taskId, { ...sent, baseline_assistant_hash: baselineAssistantHash });
  return { ok: recorded.ok === true, stage: "prompt_submit", result: recorded, next_action: "capture assistant answer" };
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
  const prompt = buildGatewayDecisionPrompt(context.taskId, context.task, context.events);
  const asked = await executeAsk(options.policy, options.baseDir, typeof context.task.workspace_path === "string" ? String(context.task.workspace_path) : options.baseDir, prompt, options.gatewayModel, options.gatewayMaxOutputTokens, options.gatewayTemperature, options.gatewayTimeoutMs, options.gatewayRaw, options.gatewayConsoleEndpoint);
  if (asked.ok !== true) {
    return {
      ok: false,
      stage: "gateway_decision",
      status: "GATEWAY_UNAVAILABLE",
      retryable: true,
      asked,
      decision_recorded: false,
      next_action: "retry gateway_decision",
    };
  }
  const recorded = await recordEngineGatewayDecision(context.paths, context.taskId, asked as unknown as Record<string, unknown>);
  if (recorded.ok !== true || typeof recorded.decision_status !== "string" || recorded.decision_status.length === 0) {
    return {
      ok: false,
      stage: "gateway_decision",
      status: "GATEWAY_DECISION_INVALID",
      retryable: true,
      result: recorded,
      asked,
      next_action: "retry gateway_decision",
    };
  }
  return { ok: true, stage: "gateway_decision", status: "GATEWAY_DECISION_RECORDED", result: recorded, asked, next_action: "draft reply-back" };
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
    const initialReadiness = await waitForComposerReady({ ports: options.ports, targetId: firstTargetId, mode: "draft", timeoutMs: options.timeoutMs, maxWaitMs: 15000, pollMs: 300, minStableSamples: 1 });
    if (initialReadiness.ok !== true) return { ok: false, status: "ENGINE_CHAT_INITIAL_READINESS_BLOCKED", opened: first, readiness: initialReadiness };
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
  const status = String(task.decision_status ?? "CONTINUE");
  const next = String(task.decision_next_action ?? task.next_action ?? "continue with the next safe engine step");
  return [`Engine decision for ${taskId}: ${status}.`, `Next action: ${next}`, "Proceed with the next safe bounded step only. Return concise status, changed files if any, gates run, and next safe action."].join("\n");
}

function buildGatewayDecisionPrompt(taskId: string, task: Record<string, unknown>, events: Record<string, unknown>[]): string {
  const latestCapture = [...events].reverse().find((event) => event.event === "executor_answer_captured") ?? null;
  const captureData = typeof latestCapture?.data === "object" && latestCapture.data !== null ? latestCapture.data as Record<string, unknown> : {};
  const latestAssistant = typeof captureData.latest_assistant === "object" && captureData.latest_assistant !== null ? captureData.latest_assistant as Record<string, unknown> : {};
  const assistantText = typeof latestAssistant.text === "string" ? latestAssistant.text.slice(0, 8000) : "";
  return ["You are the low-cost gateway decision layer for a deterministic local engine.", "Return JSON only.", "Use this exact shape:", "{\"status\":\"GREEN|CONTINUE|BLOCKED|NEEDS_USER\",\"next_action\":\"string\",\"summary\":\"string\",\"risks\":[\"string\"],\"reply_back_required\":false}", "", `Task ID: ${taskId}`, `Component: ${String(task.component_label ?? task.component ?? "unknown")}`, `Workspace: ${String(task.workspace_path ?? "unknown")}`, `Phase: ${String(task.phase_key ?? "unknown")}`, `Engine next action: ${String(task.next_action ?? "unknown")}`, `Assistant hash: ${String(task.assistant_hash ?? "unknown")}`, `Assistant length: ${String(task.assistant_length ?? "unknown")}`, "", "Assistant answer:", assistantText, "", "Classify whether the engine should continue, stop for user, or proceed to deterministic gates. Do not propose browser actions. Do not write a reply-back message yet."].join("\n");
}

