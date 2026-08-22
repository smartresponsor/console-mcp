import type { ConsolePolicy } from "../Policy/ConsolePolicy.js";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { runSupervisedCommand } from "../Infrastructure/Process/SupervisedCommand.js";
import { executeNamedCheck } from "../tool/run-check.js";
import { applyBrowserSessionTitlePrefix, detectChatGptRateLimit, dismissChatGptRateLimit, draftBrowserSessionInput, openChatGptChat, submitBrowserSession } from "../tool/chatgpt-chat-open.js";
import { attachPromptFile, dismissChatGptStorageQuotaDialog, enforceChatGptReasoning, inspectComposerOwnership, resetPersistedComposerDraft, waitForComposerReady, type ChatGptReasoningEnforcement } from "../service/browser-session-executor.js";
import { runChatGptAnswerSettle, runChatGptMessageCapture } from "../tool/chatgpt-message-capture.js";
import { buildActionMarkerReplyBackText, classifyActionMarkerFromText, isContinuingActionMarker, isHumanDecisionActionMarker, isTerminalActionMarker, normalizeActionMarker } from "./action-marker-router.js";
import { bindEngineChatSession, buildEnginePhasePrompt, captureGitWorktreeFingerprint, clearEngineRateLimitCooldown, getEngineTaskStatus, recordEngineAnswerCapture, recordEngineComposerPreflight, recordEngineCycleCheckpoint, recordEngineExecutionOutcome, recordEngineGatewayDecision, recordEnginePromptDraft, recordEnginePromptSubmit, recordEngineRateLimitCooldown, recordEngineReplyBackDispatch, recordEngineReplyBackDraft, resetEngineCycleRoundState, type EnginePaths } from "./engine-core.js";
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

type EngineCycleLease = {
  ok: true;
  leaseId: string;
  lockPath: string;
  taskId: string;
  pid: number;
  acquiredAt: string;
} | {
  ok: false;
  status: "ENGINE_CYCLE_LEASE_ACTIVE" | "ENGINE_CYCLE_LEASE_ACQUIRE_FAILED";
  lockPath: string;
  taskId: string;
  existing?: Record<string, unknown> | null;
  error?: string;
};

type AcquiredEngineCycleLease = Extract<EngineCycleLease, { ok: true }>;

export async function acquireEngineCycleLease(paths: EnginePaths, taskId: string, allowDeadOwnerRecovery = true): Promise<EngineCycleLease> {
  await mkdir(paths.lockDir, { recursive: true });
  const lockPath = path.join(paths.lockDir, `${taskId}.cycle.lock`);
  const leaseId = `cycle-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const acquiredAt = new Date().toISOString();
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify({ lease_id: leaseId, task_id: taskId, pid: process.pid, acquired_at: acquiredAt })}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return { ok: true, leaseId, lockPath, taskId, pid: process.pid, acquiredAt };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (code !== "EEXIST") {
      return { ok: false, status: "ENGINE_CYCLE_LEASE_ACQUIRE_FAILED", lockPath, taskId, error: error instanceof Error ? error.message : String(error) };
    }
    const existing = await readEngineCycleLease(lockPath);
    const ownerPid = typeof existing?.pid === "number" ? existing.pid : null;
    if (allowDeadOwnerRecovery && ownerPid !== null && !isProcessAlive(ownerPid)) {
      await rm(lockPath, { force: true });
      return await acquireEngineCycleLease(paths, taskId, false);
    }
    return { ok: false, status: "ENGINE_CYCLE_LEASE_ACTIVE", lockPath, taskId, existing };
  }
}

export async function releaseEngineCycleLease(lease: EngineCycleLease): Promise<void> {
  if (lease.ok !== true) return;
  const existing = await readEngineCycleLease(lease.lockPath);
  if (existing?.lease_id !== lease.leaseId) return;
  await rm(lease.lockPath, { force: true });
}

async function readEngineCycleLease(lockPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    return code === "EPERM";
  }
}

// Shared by console.write.engine.cycle.run_n and the automatic post-authorization dispatch from
// the "go" cmcp flow, so orphan-detection (ENGINE_CYCLE_ANSWER_ORPHANED) and stage blocking stay
// in effect on both the manual and automatic paths.
export async function runEngineCycleRounds(paths: EnginePaths, executorOptions: EngineBrowserCycleExecutorOptions, roundOptions: EngineCycleRoundOptions): Promise<Record<string, unknown>> {
  const lease = await acquireEngineCycleLease(paths, roundOptions.taskId);
  if (lease.ok !== true) {
    return {
      ok: false,
      status: "ENGINE_CYCLE_ALREADY_RUNNING",
      task_id: roundOptions.taskId,
      max_rounds: roundOptions.maxRounds,
      round_count: 0,
      stop_reason: "cycle_lease_active",
      lease,
      starts_daemon: false,
    };
  }
  try {
    return await runEngineCycleRoundsWithLease(paths, executorOptions, roundOptions, lease);
  } finally {
    await releaseEngineCycleLease(lease);
  }
}

async function runEngineCycleRoundsWithLease(paths: EnginePaths, executorOptions: EngineBrowserCycleExecutorOptions, roundOptions: EngineCycleRoundOptions, lease: AcquiredEngineCycleLease): Promise<Record<string, unknown>> {
  const executor = createEngineBrowserCycleExecutor(executorOptions);
  const { taskId, maxRounds, maxStepsPerRound, stopOnBlocked, stopOnNotReady } = roundOptions;
  const rounds: Record<string, unknown>[] = [];
  let stopReason = "max_rounds";
  const initialStatus = await getEngineTaskStatus(paths, taskId);
  const initialTask = typeof initialStatus.task === "object" && initialStatus.task !== null ? initialStatus.task as Record<string, unknown> : {};
  let previousProgressFingerprint: string | null = stringField(initialTask, "cycle_progress_fingerprint");
  let repeatedProgressFingerprintCount = numberField(initialTask, "cycle_progress_repeat_count") ?? 0;
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
      if (result.status === "ENGINE_CYCLE_HUMAN_DECISION_REQUIRED") { roundStopReason = "human_decision_required"; break; }
      if (result.status === "ENGINE_CYCLE_COMPLETION_CANDIDATE") { roundStopReason = "completion_candidate"; break; }
      if (result.status === "ENGINE_CYCLE_ITERATION_BUDGET_EXHAUSTED") { roundStopReason = "max_rounds"; break; }
      if (result.stage === "gateway_decision" && result.status === "ACTION_MARKER_DECISION_RECORDED") {
        const decisionSnapshot = await getEngineTaskStatus(paths, taskId);
        const decisionTask = typeof decisionSnapshot.task === "object" && decisionSnapshot.task !== null ? decisionSnapshot.task as Record<string, unknown> : {};
        const currentDecisionMarker = normalizeActionMarker(decisionTask.decision_status);
        if (currentDecisionMarker !== null && isContinuingActionMarker(currentDecisionMarker)) {
          const currentFingerprint = buildRoundProgressFingerprint(decisionTask);
          const preReplyStop = resolveEnginePreReplyStopReason({
            currentFingerprint,
            previousFingerprint: previousProgressFingerprint,
            previousRepeatCount: repeatedProgressFingerprintCount,
            autoIterationCount: numberField(decisionTask, "auto_iteration_count") ?? Math.max(1, (numberField(decisionTask, "cycle_round_index") ?? 0) + 1),
            maxAutoIterations: numberField(decisionTask, "max_auto_iterations") ?? maxRounds,
          });
          if (preReplyStop !== null) { roundStopReason = preReplyStop; break; }
        }
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
    const progressFingerprint = decisionMarker === null ? null : buildRoundProgressFingerprint(task);
    if (progressFingerprint !== null) {
      repeatedProgressFingerprintCount = progressFingerprint === previousProgressFingerprint ? repeatedProgressFingerprintCount + 1 : 1;
      previousProgressFingerprint = progressFingerprint;
    }
    const checkpoint = await recordEngineCycleCheckpoint(paths, taskId, {
      progressFingerprint: progressFingerprint ?? previousProgressFingerprint,
      repeatCount: repeatedProgressFingerprintCount,
      roundIndex: numberField(task, "cycle_round_index") ?? roundIndex,
      stopReason: roundStopReason,
    });
    rounds.push({ round_index: roundIndex, timeline, round_stop_reason: roundStopReason, decision_status: decisionStatus, action_marker: decisionMarker, decision_diagnostics: decisionDiagnostics, progress_fingerprint: progressFingerprint, repeated_progress_fingerprint_count: repeatedProgressFingerprintCount, checkpoint });

    if (roundStopReason === "human_decision_required" || isHumanDecisionActionMarker(decisionMarker)) {
      stopReason = "human_decision_required";
      break;
    }
    if (roundStopReason === "completion_candidate" || isTerminalActionMarker(decisionMarker)) {
      const completion = await verifyEngineCompletionCandidate(executorOptions.policy, executorOptions.baseDir, task);
      rounds[rounds.length - 1] = { ...rounds[rounds.length - 1], completion_verification: completion };
      if (completion.ok !== true) {
        stopReason = "completion_verification_failed";
        break;
      }
      stopReason = "decision_done_verified:" + decisionMarker;
      break;
    }
    if (roundStopReason !== "complete") { stopReason = roundStopReason; break; }
    if (repeatedProgressFingerprintCount >= 3) {
      stopReason = "stalled_no_semantic_progress";
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
  const ok = isEngineCycleRunVerifiedComplete(stopReason);
  const lastRound = rounds[rounds.length - 1] ?? {};
  const lastTimeline = Array.isArray(lastRound.timeline) ? lastRound.timeline as Record<string, unknown>[] : [];
  const lastStep = lastTimeline[lastTimeline.length - 1] ?? {};
  const receipt = typeof lastStep.receipt === "object" && lastStep.receipt !== null ? lastStep.receipt as Record<string, unknown> : {};
  const outcomeStatus = ok ? "completed" : (stopReason === "not_ready" ? "waiting_runtime" : (stopReason === "error" || stopReason === "reset_failed" ? "failed" : "blocked"));
  const outcomeReason = typeof receipt.inner_status === "string" ? receipt.inner_status : stopReason;
  const outcome = await recordEngineExecutionOutcome(paths, taskId, { status: outcomeStatus, stage: typeof lastStep.stage === "string" ? lastStep.stage : null, reason: outcomeReason, nextAction: buildEngineCycleOutcomeNextAction(ok, stopReason, receipt), receipt });
  return { ok, status: "ENGINE_CYCLE_RUN_N_COMPLETE", task_id: taskId, max_rounds: maxRounds, round_count: rounds.length, stop_reason: stopReason, rounds, outcome, execution_lease: { lease_id: lease.leaseId, acquired_at: lease.acquiredAt, pid: lease.pid }, starts_daemon: false };
}

export function isEngineCycleRunVerifiedComplete(stopReason: string): boolean {
  return stopReason.startsWith("decision_done_verified:");
}

export function resolveEnginePreReplyStopReason(input: { currentFingerprint: string; previousFingerprint: string | null; previousRepeatCount: number; autoIterationCount: number; maxAutoIterations: number }): "stalled_no_semantic_progress" | "max_rounds" | null {
  const projectedRepeatCount = input.currentFingerprint === input.previousFingerprint ? input.previousRepeatCount + 1 : 1;
  if (projectedRepeatCount >= 3) return "stalled_no_semantic_progress";
  if (input.autoIterationCount >= input.maxAutoIterations) return "max_rounds";
  return null;
}

function buildEngineCycleOutcomeNextAction(ok: boolean, stopReason: string, receipt: Record<string, unknown>): string {
  if (ok) return "execution complete";
  if (stopReason === "max_rounds") return "iteration budget exhausted; return current checkpoint to the user or explicitly authorize another bounded run";
  if (stopReason.startsWith("decision_recheck_required:")) return "inspect the unresolved decision state; do not treat the task as complete";
  if (stopReason === "human_decision_required") return "return the unresolved decision packet to the user; do not continue autonomously";
  if (stopReason === "stalled_no_semantic_progress") return "inspect repeated decision state before authorizing another autonomous round";
  if (stopReason === "completion_verification_failed") return "reconcile claimed completion with factual repository state before retrying";
  if (stopReason === "not_ready") return "retry bounded cycle after runtime becomes ready";
  const innerStatus = typeof receipt.inner_status === "string" ? receipt.inner_status : null;
  if (innerStatus?.startsWith("CHATGPT_REASONING_")) return "inspect ChatGPT reasoning selector state before retrying cmcp go";
  return "inspect blocked stage and recovery receipt";
}

function buildRoundProgressFingerprint(task: Record<string, unknown>): string {
  const payload = JSON.stringify({
    decision: task.decision_status ?? null,
    next_action: task.decision_next_action ?? null,
    summary: task.decision_summary ?? null,
    matched: Array.isArray(task.decision_matched) ? task.decision_matched : [],
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function verifyEngineCompletionCandidate(policy: ConsolePolicy, baseDir: string, task: Record<string, unknown>): Promise<Record<string, unknown>> {
  const workspacePath = stringField(task, "workspace_path");
  const baselineFingerprint = stringField(task, "initial_worktree_fingerprint");
  if (!workspacePath) return { ok: false, status: "ENGINE_COMPLETION_WORKSPACE_MISSING" };
  if (!baselineFingerprint) return { ok: false, status: "ENGINE_COMPLETION_BASELINE_FINGERPRINT_MISSING" };
  try {
    const [worktree, headResult, diffCheck] = await Promise.all([
      captureGitWorktreeFingerprint(workspacePath),
      runSupervisedCommand(workspacePath, "git", ["rev-parse", "HEAD"], 30000, 1024 * 1024),
      runSupervisedCommand(workspacePath, "git", ["diff", "--check"], 30000, 4 * 1024 * 1024),
    ]);
    if (!worktree.fingerprint) {
      return { ok: false, status: "ENGINE_COMPLETION_WORKTREE_FINGERPRINT_UNVERIFIED", untracked_count: worktree.untrackedCount };
    }
    if (worktree.fingerprint !== baselineFingerprint) {
      return { ok: false, status: "ENGINE_COMPLETION_WORKTREE_DRIFT", baseline_worktree_fingerprint: baselineFingerprint, current_worktree_fingerprint: worktree.fingerprint, current_status_hash: worktree.statusHash, untracked_count: worktree.untrackedCount };
    }
    const head = headResult.ok === true ? headResult.stdout.trim() : "";
    if (!/^[a-f0-9]{40}$/i.test(head)) return { ok: false, status: "ENGINE_COMPLETION_HEAD_UNVERIFIED" };
    if (diffCheck.ok !== true || diffCheck.stdout.trim().length > 0 || diffCheck.stderr.trim().length > 0) {
      return { ok: false, status: "ENGINE_COMPLETION_GIT_DIFF_CHECK_FAILED", exit_code: diffCheck.exitCode, stdout: diffCheck.stdout.slice(0, 8000), stderr: diffCheck.stderr.slice(0, 8000) };
    }

    const gateNames = await discoverCompletionGateNames(workspacePath);
    const gateResults: Record<string, unknown>[] = [];
    for (const checkName of gateNames) {
      const startedAt = Date.now();
      try {
        const result = await executeNamedCheck(policy, baseDir, workspacePath, checkName);
        gateResults.push({ ...result, duration_wrapper_ms: Date.now() - startedAt });
      } catch (error) {
        gateResults.push({ ok: false, check_name: checkName, error: error instanceof Error ? error.message : String(error), duration_wrapper_ms: Date.now() - startedAt });
      }
    }
    const failedGates = gateResults.filter((result) => result.ok !== true);
    if (failedGates.length > 0) {
      return { ok: false, status: "ENGINE_COMPLETION_DETERMINISTIC_GATE_FAILED", gate_names: gateNames, failed_gate_names: failedGates.map((result) => String(result.check_name ?? "unknown")), gate_results: gateResults };
    }
    return {
      ok: true,
      status: "ENGINE_COMPLETION_FACTS_AND_GATES_VERIFIED",
      workspace_state_matches_baseline: true,
      baseline_worktree_fingerprint: baselineFingerprint,
      current_worktree_fingerprint: worktree.fingerprint,
      initial_head: task.initial_head ?? null,
      current_head: head,
      git_diff_check: "PASS",
      gate_names: gateNames,
      gate_results: gateResults,
    };
  } catch (error) {
    return { ok: false, status: "ENGINE_COMPLETION_VERIFICATION_EXCEPTION", error: error instanceof Error ? error.message : String(error) };
  }
}

async function discoverCompletionGateNames(workspacePath: string): Promise<string[]> {
  const gates: string[] = [];
  try {
    const packageJson = JSON.parse(await readFile(`${workspacePath}/package.json`, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null ? packageJson.scripts : {};
    if (typeof scripts.typecheck === "string") gates.push("console_typecheck");
    if (typeof scripts.test === "string") gates.push("npm_test");
    if (typeof scripts.build === "string") gates.push("npm_build");
  } catch {}
  try {
    const composerJson = JSON.parse(await readFile(`${workspacePath}/composer.json`, "utf8")) as { scripts?: Record<string, unknown> };
    const scripts = typeof composerJson.scripts === "object" && composerJson.scripts !== null ? composerJson.scripts : {};
    gates.push("composer_validate");
    if ("qa" in scripts) gates.push("console.read_.package.composer.script.qa");
    else if ("test" in scripts) gates.push("console.read_.package.composer.script.test");
    else if ("phpstan" in scripts) gates.push("phpstan");
  } catch {}
  return [...new Set(gates)];
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

async function attachEnginePromptFileWhenReady(options: EngineBrowserCycleExecutorOptions, targetId: string, filePath: string, fileSha256?: string, fileSizeBytes?: number): Promise<Record<string, unknown>> {
  const maxAttempts = 3;
  const attempts: Record<string, unknown>[] = [];
  let last: Record<string, unknown> = { ok: false, status: "ENGINE_ATTACHMENT_NOT_ATTEMPTED" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await attachPromptFile({ ports: options.ports, targetId, filePath, fileSha256, fileSizeBytes, timeoutMs: options.timeoutMs });
    const transportState = objectField(last, "prompt_transport_state") ?? {};
    const retryable = last.retryable === true || transportState.retryable === true;
    attempts.push({
      attempt,
      ok: last.ok === true,
      status: last.status ?? null,
      transport_status: transportState.status ?? null,
      attached: transportState.attached === true,
      confirmed: transportState.confirmed === true,
      retryable,
    });
    if (last.ok === true && transportState.confirmed === true) {
      return { ...last, attachment_attempts: attempts, attachment_attempt_count: attempt };
    }
    if (!retryable || attempt >= maxAttempts) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const transportState = objectField(last, "prompt_transport_state") ?? {};
  return {
    ...last,
    retryable: last.retryable === true || transportState.retryable === true,
    attachment_attempts: attempts,
    attachment_attempt_count: attempts.length,
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
    ? await attachEnginePromptFileWhenReady(options, targetId, attachmentPath, stringField(built, "execution_specification_hash") ?? undefined, numberField(built, "execution_specification_length") ?? undefined)
    : null;
  if (attachmentPath && attachment?.ok !== true) {
    const transportState = objectField(attachment ?? {}, "prompt_transport_state") ?? {};
    const retryable = attachment?.retryable === true || transportState.retryable === true;
    return {
      ok: false,
      stage: "prompt_draft",
      status: retryable ? "ENGINE_CYCLE_STAGE_NOT_READY" : "ENGINE_CYCLE_STAGE_BLOCKED",
      ownership: ownershipBefore,
      drafted,
      attachment,
      next_action: retryable
        ? "retry the same prompt_draft after attachment confirmation settles; preserve the existing envelope and exact attachment identity"
        : "inspect non-retryable prompt attachment failure before continuing",
    };
  }
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
  const settled = await runChatGptAnswerSettle({ ports: options.ports, preferredChatId: chatId, expectedTargetId: targetId, expectedTaskId: context.taskId, requireChatId: chatId !== undefined, maxMessages: options.maxMessages, timeoutMs: options.timeoutMs, readinessProfile: options.readinessProfile, maxWaitMs: options.maxWaitMs, observationBudgetMs: options.observationBudgetMs, pollMs: options.pollMs, requireComposerSendMode: true, baselineAssistantHash, lastGuardedAssistantHash: baselineAssistantHash });
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
  if (isHumanDecisionActionMarker(recorded.decision_status)) {
    return { ok: true, stage: "gateway_decision", status: "ENGINE_CYCLE_HUMAN_DECISION_REQUIRED", result: recorded, routed, next_action: "return decision packet to user; do not reply back automatically" };
  }
  if (isTerminalActionMarker(recorded.decision_status)) {
    return { ok: true, stage: "gateway_decision", status: "ENGINE_CYCLE_COMPLETION_CANDIDATE", result: recorded, routed, next_action: "verify factual repository completion before accepting done" };
  }
  return { ok: true, stage: "gateway_decision", status: "ACTION_MARKER_DECISION_RECORDED", result: recorded, routed, next_action: "draft reply-back" };
}

async function executeReplyDraftStage(options: EngineBrowserCycleExecutorOptions, context: EngineCycleContext): Promise<Record<string, unknown>> {
  const decisionMarker = normalizeActionMarker(context.task.decision_status);
  const autoIterationCount = numberField(context.task, "auto_iteration_count") ?? 0;
  const maxAutoIterations = numberField(context.task, "max_auto_iterations");
  if (decisionMarker !== null && isContinuingActionMarker(decisionMarker) && maxAutoIterations !== null && autoIterationCount >= maxAutoIterations) {
    return {
      ok: false,
      stage: "reply_draft",
      status: "ENGINE_CYCLE_ITERATION_BUDGET_EXHAUSTED",
      task_id: context.taskId,
      auto_iteration_count: autoIterationCount,
      max_auto_iterations: maxAutoIterations,
      next_action: "iteration budget exhausted; preserve the current checkpoint and do not draft or submit another continuation",
    };
  }
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

