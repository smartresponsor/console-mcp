import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsoleAuthConfig } from "../service/auth.js";
import type { ConsolePolicy } from "../service/policy.js";
import { assertAllowedRoot } from "../service/path.js";
import { normalizeRepoPath, runSupervisedCommand, truncateOutput } from "../service/command.js";
import { executeNamedCheck } from "./run-check.js";
import { runChatGptAnswerSettle } from "./chatgpt-message-capture.js";
import { buildConsoleToolRegistration, textResult, truncateText } from "./common.js";

const outputLimit = 30000;

export const implementationRunCaptureInputSchema = z.object({
  workspacePath: z.string().min(1),
  beforeHead: z.string().min(1).optional(),
  assistantMessage: z.string().max(60000).optional(),
  checkNames: z.array(z.string().min(1)).max(20).default([]),
  includeDiff: z.boolean().default(true),
  diffMaxChars: z.number().int().min(1000).max(120000).default(30000),
  maxCommits: z.number().int().min(1).max(100).default(30),
}).strict();

const preAskImplementationCaptureInputSchema = z.object({
  workspacePath: z.string().min(1),
  beforeHead: z.string().min(1),
  checkNames: z.array(z.string().min(1)).max(20).default([]),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([9222, 9223]),
  preferredChatId: z.string().min(1).optional(),
  requireChatId: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(100).default(30),
  timeoutMs: z.number().int().min(250).max(10000).default(2000),
  baselineAssistantHash: z.string().min(1).optional(),
  lastGuardedAssistantHash: z.string().min(1).optional(),
  readinessProfile: z.enum(["quick_probe", "rc_gate", "long_run"]).default("rc_gate"),
  maxWaitMs: z.number().int().min(1000).max(600000).optional(),
  observationBudgetMs: z.number().int().min(1000).max(60000).optional(),
  pollMs: z.number().int().min(250).max(5000).optional(),
  minStableSamples: z.number().int().min(2).max(30).optional(),
  idleQuietMs: z.number().int().min(1000).max(300000).optional(),
  requireComposerSendMode: z.boolean().default(true),
  includeDiff: z.boolean().default(true),
  diffMaxChars: z.number().int().min(1000).max(120000).default(30000),
  maxCommits: z.number().int().min(1).max(100).default(30),
}).strict();

type GitCommandResult = {
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
};

export function registerImplementationRunCaptureTool(server: McpServer, policy: ConsolePolicy, baseDir: string, authConfig: ConsoleAuthConfig): void {
  server.registerTool(
    "console.read_.repo.implementation.run.capture",
    {
      description: "Read-only hybrid capture for a ChatGPT implementation run: compare before/after Git state, collect commits and diffs, and run deterministic gate checks.",
      inputSchema: implementationRunCaptureInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await captureImplementationRun(policy, baseDir, input))
  );

  server.registerTool(
    "console.read_.browser.chatgpt.implementation.pre_ask.capture",
    {
      description: "Read-only pre-ASK chain: settle ChatGPT answer, capture assistant intent, compare Git before/after state, collect diffs, and run deterministic gate checks.",
      inputSchema: preAskImplementationCaptureInputSchema,
      ...buildConsoleToolRegistration(authConfig),
    },
    async (input) => textResult(await capturePreAskImplementationRun(policy, baseDir, input))
  );
}

async function captureImplementationRun(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof implementationRunCaptureInputSchema>): Promise<Record<string, unknown>> {
  const cwd = assertAllowedRoot(input.workspacePath, policy.allowedRoots);
  const currentHeadResult = await gitText(policy, cwd, ["rev-parse", "HEAD"]);
  const currentHead = currentHeadResult.ok ? currentHeadResult.stdout.trim() : null;
  const beforeHead = input.beforeHead ? sanitizeCommitish(input.beforeHead) : currentHead;
  const branchResult = await gitText(policy, cwd, ["branch", "--show-current"]);
  const statusResult = await gitText(policy, cwd, ["status", "--short"]);
  const statusLines = splitLines(statusResult.stdout);
  const repoClean = statusResult.ok && statusLines.length === 0;
  const headChanged = Boolean(beforeHead && currentHead && beforeHead !== currentHead);
  const hasBeforeHead = Boolean(input.beforeHead);

  const commitRange = beforeHead && currentHead && beforeHead !== currentHead ? `${beforeHead}..${currentHead}` : null;
  const commitLogResult = commitRange
    ? await gitText(policy, cwd, ["log", `--max-count=${input.maxCommits}`, "--oneline", "--decorate", commitRange])
    : null;
  const commitList = commitLogResult ? splitLines(commitLogResult.stdout) : [];
  const committedDiffStatResult = commitRange
    ? await gitText(policy, cwd, ["diff", "--stat", commitRange])
    : null;
  const committedDiffResult = commitRange && input.includeDiff
    ? await gitText(policy, cwd, ["diff", commitRange], input.diffMaxChars)
    : null;
  const dirtyDiffStatResult = repoClean ? null : await gitText(policy, cwd, ["diff", "--stat"]);
  const dirtyDiffResult = !repoClean && input.includeDiff
    ? await gitText(policy, cwd, ["diff"], input.diffMaxChars)
    : null;

  const gateResults = [];
  for (const checkName of input.checkNames) {
    const startedAt = Date.now();
    try {
      const result = await executeNamedCheck(policy, baseDir, cwd, checkName);
      gateResults.push({ ...result, duration_wrapper_ms: Date.now() - startedAt });
    } catch (error) {
      gateResults.push({ ok: false, check_name: checkName, error: error instanceof Error ? error.message : String(error), duration_wrapper_ms: Date.now() - startedAt });
    }
  }

  const gateOk = gateResults.length === 0 ? null : gateResults.every((result) => result.ok === true);
  const status = classifyRunCapture({ hasBeforeHead, headChanged, repoClean, gateOk });
  const blockingReasons = buildImplementationBlockingReasons({ hasBeforeHead, headChanged, repoClean, gateOk, statusLines, gateResults });
  const deterministicVerdict = buildDeterministicVerdict({ hasBeforeHead, headChanged, repoClean, gateOk, blockingReasons });
  const assistantSummary = summarizeAssistantMessage(input.assistantMessage ?? "");

  return {
    ok: status === "NO_REPO_CHANGE" || status === "REPO_CHANGED_GATE_GREEN" || status === "REPO_CHANGED_NO_GATE_REQUESTED",
    status,
    deterministic_verdict: deterministicVerdict,
    deterministic_finding_count: blockingReasons.length,
    blocking_reasons: blockingReasons,
    workspace: {
      path: cwd,
      branch: branchResult.ok ? branchResult.stdout.trim() : null,
      branch_read_ok: branchResult.ok,
    },
    git: {
      before_head: beforeHead,
      before_head_supplied: hasBeforeHead,
      current_head: currentHead,
      head_changed: headChanged,
      commit_range: commitRange,
      repo_clean: repoClean,
      status_lines: statusLines,
      status_line_count: statusLines.length,
      current_head_read: currentHeadResult,
      status_read: statusResult,
    },
    commits: {
      count: commitList.length,
      lines: commitList,
      log: commitLogResult,
    },
    diff: {
      committed_stat: committedDiffStatResult,
      committed: committedDiffResult,
      dirty_stat: dirtyDiffStatResult,
      dirty: dirtyDiffResult,
    },
    gate: {
      requested: input.checkNames,
      ok: gateOk,
      results: gateResults,
    },
    assistant: assistantSummary,
    ask_material: buildAskMaterial({
      status,
      beforeHead,
      currentHead,
      branch: branchResult.ok ? branchResult.stdout.trim() : null,
      statusLines,
      commitList,
      committedDiffStat: committedDiffStatResult?.stdout ?? "",
      dirtyDiffStat: dirtyDiffStatResult?.stdout ?? "",
      gateResults,
      assistantMessage: input.assistantMessage ?? "",
      diffText: committedDiffResult?.stdout || dirtyDiffResult?.stdout || "",
      diffMaxChars: input.diffMaxChars,
    }),
  };
}

async function capturePreAskImplementationRun(policy: ConsolePolicy, baseDir: string, input: z.infer<typeof preAskImplementationCaptureInputSchema>): Promise<Record<string, unknown>> {
  const settle = await runChatGptAnswerSettle({
    ports: input.ports,
    preferredChatId: input.preferredChatId,
    requireChatId: input.requireChatId,
    maxMessages: input.maxMessages,
    timeoutMs: input.timeoutMs,
    baselineAssistantHash: input.baselineAssistantHash,
    lastGuardedAssistantHash: input.lastGuardedAssistantHash,
    readinessProfile: input.readinessProfile,
    maxWaitMs: input.maxWaitMs,
    observationBudgetMs: input.observationBudgetMs,
    pollMs: input.pollMs,
    minStableSamples: input.minStableSamples,
    idleQuietMs: input.idleQuietMs,
    requireComposerSendMode: input.requireComposerSendMode,
  });
  const latestAssistant = extractLatestAssistant(settle);
  const implementation = await captureImplementationRun(policy, baseDir, {
    workspacePath: input.workspacePath,
    beforeHead: input.beforeHead,
    assistantMessage: latestAssistant?.text ?? "",
    checkNames: input.checkNames,
    includeDiff: input.includeDiff,
    diffMaxChars: input.diffMaxChars,
    maxCommits: input.maxCommits,
  });
  const settleOk = settle.status === "ANSWER_STABLE" && settle.settled === true && settle.ready_for_gate === true;
  const implementationOk = implementation.ok === true;
  const gate = implementation.gate as { ok?: unknown } | undefined;
  const gateOk = typeof gate?.ok === "boolean" ? gate.ok : null;
  const preAskReady = settleOk && implementationOk && gateOk !== false;
  const blockingReasons = buildPreAskBlockingReasons({ settleOk, implementationOk, gateOk, implementation });
  const admissionInput = buildImplementationAdmissionInput({ settle, implementation, latestAssistant });

  return {
    ok: preAskReady,
    status: preAskReady ? "PRE_ASK_READY" : "PRE_ASK_BLOCKED",
    blocking_reasons: blockingReasons,
    settle_ok: settleOk,
    implementation_ok: implementationOk,
    gate_ok: gateOk,
    implementation_admission_input: admissionInput,
    latest_assistant_hash: latestAssistant?.hash ?? null,
    latest_assistant_index: latestAssistant?.index ?? null,
    settle,
    implementation,
    ask_material: implementation.ask_material,
    policy: {
      browser_mutation: false,
      prompt_injection: false,
      auto_submit: false,
      dom_write: false,
      sends_ask: false,
      runs_deterministic_gates: true,
    },
  };
}

function classifyRunCapture(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null }): string {
  if (!input.hasBeforeHead) {
    return "BASELINE_CAPTURED";
  }

  if (!input.repoClean) {
    return input.headChanged ? "REPO_CHANGED_DIRTY_AFTER_RUN" : "REPO_DIRTY_AFTER_RUN";
  }

  if (!input.headChanged) {
    return "NO_REPO_CHANGE";
  }

  if (input.gateOk === null) {
    return "REPO_CHANGED_NO_GATE_REQUESTED";
  }

  return input.gateOk ? "REPO_CHANGED_GATE_GREEN" : "REPO_CHANGED_GATE_RED";
}

function buildImplementationBlockingReasons(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null; statusLines: string[]; gateResults: Record<string, unknown>[] }): string[] {
  const reasons = [];
  if (!input.hasBeforeHead) {
    reasons.push("baseline_only_no_before_head_supplied");
  }
  if (!input.repoClean) {
    reasons.push("repo_dirty_after_run");
    for (const line of input.statusLines.slice(0, 20)) {
      reasons.push(`dirty:${line}`);
    }
  }
  if (input.gateOk === false) {
    reasons.push("deterministic_gate_failed");
    for (const result of input.gateResults.filter((item) => item.ok !== true).slice(0, 20)) {
      reasons.push(`gate_failed:${String(result.check_name ?? "unknown")}`);
    }
  }
  if (input.hasBeforeHead && !input.headChanged && input.repoClean) {
    reasons.push("no_repo_change_detected");
  }
  return reasons;
}

function buildPreAskBlockingReasons(input: { settleOk: boolean; implementationOk: boolean; gateOk: boolean | null; implementation: Record<string, unknown> }): string[] {
  const reasons = [];
  if (!input.settleOk) {
    reasons.push("answer_not_stable_or_not_ready_for_gate");
  }
  if (!input.implementationOk) {
    reasons.push("implementation_capture_not_green");
    const nested = input.implementation.blocking_reasons;
    if (Array.isArray(nested)) {
      for (const reason of nested.slice(0, 40)) {
        reasons.push(`implementation:${String(reason)}`);
      }
    }
  }
  if (input.gateOk === false) {
    reasons.push("deterministic_gate_failed");
  }
  return reasons;
}

function buildDeterministicVerdict(input: { hasBeforeHead: boolean; headChanged: boolean; repoClean: boolean; gateOk: boolean | null; blockingReasons: string[] }): string {
  if (!input.repoClean || input.gateOk === false) {
    return "RED";
  }
  if (!input.hasBeforeHead) {
    return "NEED_BINDING";
  }
  if (!input.headChanged) {
    return "AMBER";
  }
  return "GREEN";
}

function buildImplementationAdmissionInput(input: { settle: Record<string, unknown>; implementation: Record<string, unknown>; latestAssistant: { text: string; hash: string; index: number } | null }): Record<string, unknown> {
  const selected = typeof input.settle.selected === "object" && input.settle.selected !== null ? input.settle.selected as Record<string, unknown> : {};
  const deterministicVerdict = typeof input.implementation.deterministic_verdict === "string" ? input.implementation.deterministic_verdict : "RED";
  const deterministicFindingCount = typeof input.implementation.deterministic_finding_count === "number" ? input.implementation.deterministic_finding_count : 0;
  const git = typeof input.implementation.git === "object" && input.implementation.git !== null ? input.implementation.git as Record<string, unknown> : {};
  return {
    currentUrl: typeof selected.url === "string" ? selected.url : "",
    expectedChatId: typeof selected.chat_id === "string" ? selected.chat_id : undefined,
    expectedAssistantHash: input.latestAssistant?.hash,
    currentLatestAssistantHash: input.latestAssistant?.hash,
    deterministicVerdict,
    deterministicFindingCount,
    repoClean: typeof git.repo_clean === "boolean" ? git.repo_clean : undefined,
  };
}

async function gitText(policy: ConsolePolicy, workspacePath: string, args: string[], limit = outputLimit): Promise<GitCommandResult> {
  const cwd = assertAllowedRoot(workspacePath, policy.allowedRoots);
  const result = await runSupervisedCommand(cwd, "git", args, 30000, 4 * 1024 * 1024);
  const stdout = truncateOutput(result.stdout, limit);
  const stderr = truncateOutput(result.stderr, limit);
  return { ok: result.ok, command: ["git", ...args].join(" "), cwd, exitCode: result.exitCode, stdout: stdout.text, stdoutTruncated: stdout.truncated, stderr: stderr.text, stderrTruncated: stderr.truncated };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

function summarizeAssistantMessage(message: string): Record<string, unknown> {
  const trimmed = message.trim();
  return { supplied: trimmed.length > 0, length: trimmed.length, preview: truncateText(trimmed, 4000).text };
}

function buildAskMaterial(input: { status: string; beforeHead: string | null; currentHead: string | null; branch: string | null; statusLines: string[]; commitList: string[]; committedDiffStat: string; dirtyDiffStat: string; gateResults: Record<string, unknown>[]; assistantMessage: string; diffText: string; diffMaxChars: number }): string {
  const gateLines = input.gateResults.map((result) => `${String(result.check_name ?? "unknown")}: ${result.ok === true ? "OK" : "FAIL"}`).join("\n");
  const diff = truncateText(input.diffText, input.diffMaxChars).text;
  return [
    "HYBRID IMPLEMENTATION RUN CAPTURE",
    `status: ${input.status}`,
    `branch: ${input.branch ?? "unknown"}`,
    `before_head: ${input.beforeHead ?? "unknown"}`,
    `current_head: ${input.currentHead ?? "unknown"}`,
    "",
    "ASSISTANT MESSAGE / INTENT:",
    truncateText(input.assistantMessage.trim(), 12000).text || "(not supplied)",
    "",
    "NEW COMMITS:",
    input.commitList.length > 0 ? input.commitList.join("\n") : "(none)",
    "",
    "WORKTREE STATUS:",
    input.statusLines.length > 0 ? input.statusLines.join("\n") : "clean",
    "",
    "DIFF STAT:",
    input.committedDiffStat.trim() || input.dirtyDiffStat.trim() || "(none)",
    "",
    "GATE RESULTS:",
    gateLines || "(not requested)",
    "",
    "DIFF:",
    diff || "(none)",
  ].join("\n");
}

function sanitizeCommitish(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._/@{}~^:-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("Commit value contains unsupported characters.");
  }

  return normalized;
}

function extractLatestAssistant(value: Record<string, unknown>): { text: string; hash: string; index: number } | null {
  const latest = value.latest_assistant;
  if (typeof latest !== "object" || latest === null) {
    return null;
  }

  const source = latest as Record<string, unknown>;
  const text = typeof source.text === "string" ? source.text : "";
  const hash = typeof source.hash === "string" ? source.hash : "";
  const index = typeof source.index === "number" ? source.index : -1;
  return text.length > 0 && hash.length > 0 && index >= 0 ? { text, hash, index } : null;
}
