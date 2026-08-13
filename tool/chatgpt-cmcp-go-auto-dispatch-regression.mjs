import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolveCmcpGoAutoDispatch } from "../dist/tool/chatgpt-chat-open.js";
import { runChatGptRunLoopPlan } from "../dist/tool/chatgpt-message-capture.js";
import { bindEngineChatSession, buildEnginePhasePrompt, createEnginePaths, enqueueTask, findActiveEngineTaskByChatBinding, recordEngineExecutionSpecification, resolveEngineWorkspacePath } from "../dist/engine/engine-core.js";
import { normalizeChatGptLocation, resolveRegisteredChatGptLocation } from "../dist/service/chatgpt-component-label.js";
import { buildChatGptEntrypointPlan } from "../dist/service/chatgpt-entrypoint-preset.js";
import { classifyEngineDraftRetry, summarizeEngineCycleStageReceipt } from "../dist/engine/engine-cycle-browser.js";
import { classifyComposerOwnership } from "../dist/service/browser-session-executor.js";
import { createChatGptPromptDraft } from "../dist/Consumer/ChatGpt/Draft/ChatGptPromptDraft.js";
import { hashChatGptArtifactText } from "../dist/service/chatgpt-artifact-guard.js";

// Isolated smoke test for the M30 "go" auto-dispatch gate: once the phase plan reaches
// done/dispatch-ready for an authorized task, the round-driving logic must be reached with the
// authorized task's max_auto_iterations, with no manual console.write.engine.cycle.run_n call
// required. This test only exercises the pure decision
// function extracted in src/tool/chatgpt-chat-open.ts; it does not touch any repo/task-bank state
// or start a browser/CDP session.

const m10EntrypointPlan = buildChatGptEntrypointPlan({
  rawPrompt: "Cmcp go Objecting M10",
  workspacePath: "D:\\PhpstormProjects\\www\\Objecting",
  componentName: "Objecting",
  taskPreset: "repo_rc_implementation",
  maxAutoIterations: 10,
});
assert.equal(m10EntrypointPlan.daemon.maxAutoIterations, 10);
assert.match(m10EntrypointPlan.enrichedPrompt, /Do not skip reconnaissance because the initiating request was short\./);
assert.match(m10EntrypointPlan.enrichedPrompt, /Resolved orchestration preset: repository_implementation\./);
assert.match(m10EntrypointPlan.enrichedPrompt, /Original user request: Objecting/);
assert.doesNotMatch(m10EntrypointPlan.enrichedPrompt, /Original user request: Cmcp go/);
assert.doesNotMatch(m10EntrypointPlan.enrichedPrompt, /\bM10\b|Automatic interaction cycle limit|maxAutoIterations/i);
assert.doesNotMatch(m10EntrypointPlan.enrichedPrompt, /M<number>/i);
assert.equal(/\{\{[^}]+\}\}/.test(m10EntrypointPlan.enrichedPrompt), false, "enriched prompt must not contain unresolved template variables");

const mobilingEntrypointPlan = buildChatGptEntrypointPlan({
  rawPrompt: "Mobiling M70",
  workspacePath: "D:\\PhpstormProjects\\www\\Mobiling",
  componentName: "Mobiling",
  taskPreset: "repo_rc_implementation",
  maxAutoIterations: 70,
});
assert.match(mobilingEntrypointPlan.enrichedPrompt, /Original user request: Mobiling/);
assert.doesNotMatch(mobilingEntrypointPlan.enrichedPrompt, /\bM70\b|maxAutoIterations|Automatic interaction cycle limit/i);

const adoptEntrypointPlan = buildChatGptEntrypointPlan({
  rawPrompt: "Adopt go Objecting M10",
  workspacePath: "D:\\PhpstormProjects\\www\\Objecting",
  componentName: "Objecting",
  taskPreset: "repo_rc_implementation",
  maxAutoIterations: 10,
  executionMode: "adopt",
});
assert.equal(adoptEntrypointPlan.executionMode, "adopt");
assert.match(adoptEntrypointPlan.enrichedPrompt, /Original user request: Adopt go Objecting/);
assert.match(adoptEntrypointPlan.enrichedPrompt, /Resolved orchestration preset: repo_rc_adopt_continuation\./);
assert.match(adoptEntrypointPlan.enrichedPrompt, /Continuation expansion:/);
assert.doesNotMatch(adoptEntrypointPlan.enrichedPrompt, /\bM10\b|Automatic interaction cycle limit|maxAutoIterations/i);
assert.match(adoptEntrypointPlan.enrichedPrompt, /Что достигнуто\? Что осталось до RC\?/i);
assert.doesNotMatch(adoptEntrypointPlan.enrichedPrompt, /Required opening mixin/i);
assert.doesNotMatch(adoptEntrypointPlan.enrichedPrompt, /M<number>/i);
assert.doesNotMatch(adoptEntrypointPlan.enrichedPrompt, /milestone|roadmap item|phase|wave|task number/i);
assert.equal(/\{\{[^}]+\}\}/.test(adoptEntrypointPlan.enrichedPrompt), false, "adopt prompt must not contain unresolved template variables");
assert.notEqual(adoptEntrypointPlan.enrichedPrompt, m10EntrypointPlan.enrichedPrompt, "adopt must use its continuation template instead of the go template");

const authorizedDoneTask = {
  status: "done",
  execution_authorized: true,
  max_auto_iterations: 5,
};
const authorizedDecision = resolveCmcpGoAutoDispatch(authorizedDoneTask);
assert.equal(authorizedDecision.dispatch, true);
assert.equal(authorizedDecision.maxRounds, 5);

const waitingUserTask = {
  status: "waiting_user",
  execution_authorized: false,
  max_auto_iterations: null,
};
const waitingUserDecision = resolveCmcpGoAutoDispatch(waitingUserTask);
assert.equal(waitingUserDecision.dispatch, false);
assert.equal(waitingUserDecision.status, "ENGINE_CYCLE_RUN_N_DISPATCH_SKIPPED");
assert.equal(waitingUserDecision.task_status, "waiting_user");
assert.equal(waitingUserDecision.execution_authorized, false);

const doneNotAuthorizedTask = {
  status: "done",
  execution_authorized: false,
  max_auto_iterations: 3,
};
const doneNotAuthorizedDecision = resolveCmcpGoAutoDispatch(doneNotAuthorizedTask);
assert.equal(doneNotAuthorizedDecision.dispatch, false);
assert.equal(doneNotAuthorizedDecision.execution_authorized, false);

const zeroIterationsTask = {
  status: "done",
  execution_authorized: true,
  max_auto_iterations: 0,
};
const zeroIterationsDecision = resolveCmcpGoAutoDispatch(zeroIterationsTask);
assert.equal(zeroIterationsDecision.dispatch, false);
assert.equal(zeroIterationsDecision.max_auto_iterations, 0);

const missingIterationsTask = {
  status: "done",
  execution_authorized: true,
};
const missingIterationsDecision = resolveCmcpGoAutoDispatch(missingIterationsTask);
assert.equal(missingIterationsDecision.dispatch, false);
assert.equal(missingIterationsDecision.max_auto_iterations, null);

const workspaceRoot = path.resolve("D:\\PhpstormProjects\\www");
const enginePaths = createEnginePaths(path.resolve(workspaceRoot, "mcp", "console-mcp"), workspaceRoot);
const nestedWorkspace = path.resolve(workspaceRoot, "mcp", "console-mcp");
const explicitNested = resolveEngineWorkspacePath(enginePaths, "console-mcp", nestedWorkspace);
assert.equal(explicitNested.ok, true);
assert.equal(explicitNested.workspacePath, nestedWorkspace);
assert.equal(explicitNested.source, "explicit");

const componentFallback = resolveEngineWorkspacePath(enginePaths, "paying");
assert.equal(componentFallback.ok, true);
assert.equal(componentFallback.workspacePath, path.resolve(workspaceRoot, "paying"));
assert.equal(componentFallback.source, "component_mapping");

const nestedMissing = resolveEngineWorkspacePath(enginePaths, "missing", path.resolve(workspaceRoot, "group", "missing"));
assert.equal(nestedMissing.ok, true);
assert.equal(nestedMissing.source, "explicit");

const outsideWorkspace = resolveEngineWorkspacePath(enginePaths, "console-mcp", path.resolve(workspaceRoot, "..", "outside"));
assert.equal(outsideWorkspace.ok, false);
assert.equal(outsideWorkspace.withinWorkspaceRoot, false);

assert.equal(classifyEngineDraftRetry({ status: "COMPOSER_NOT_READY" }).retryable, true);
assert.equal(classifyEngineDraftRetry({ status: "INPUT_FOCUS_BLOCKED" }).retryable, true);
assert.equal(classifyEngineDraftRetry({ status: "COMPOSER_NOT_EMPTY" }).retryable, false);
assert.equal(classifyEngineDraftRetry({ status: "DRAFT_MISMATCH" }).retryable, false);

const expectedEnvelope = "Engine task execution request.\nRead the attached authoritative specification.";
const emptyOwnership = classifyComposerOwnership("", expectedEnvelope);
assert.equal(emptyOwnership.ownership_classification, "EMPTY");
assert.equal(emptyOwnership.safe_to_attach, true);
assert.equal(emptyOwnership.draft_required, true);
const exactOwnership = classifyComposerOwnership(expectedEnvelope, expectedEnvelope);
assert.equal(exactOwnership.ownership_classification, "EXACT_EXPECTED");
assert.equal(exactOwnership.safe_to_attach, true);
assert.equal(exactOwnership.draft_already_present, true);
const whitespaceOwnership = classifyComposerOwnership("Engine task execution request.   Read the attached authoritative specification.", expectedEnvelope);
assert.equal(whitespaceOwnership.ownership_classification, "EXACT_EXPECTED");
assert.equal(whitespaceOwnership.safe_to_attach, true);
assert.equal(whitespaceOwnership.whitespace_equivalent, true);
const partialOwnership = classifyComposerOwnership(expectedEnvelope.slice(0, 24), expectedEnvelope);
assert.equal(partialOwnership.ownership_classification, "OWN_PARTIAL_PREFIX");
assert.equal(partialOwnership.safe_to_attach, false);
const foreignOwnership = classifyComposerOwnership("unrelated user draft", expectedEnvelope);
assert.equal(foreignOwnership.ownership_classification, "FOREIGN_TEXT");
assert.equal(foreignOwnership.safe_to_attach, false);

const staleComposerText = "\r\n  stale composer text  \r\n";
const canonicalStaleComposerHash = hashChatGptArtifactText("stale composer text");
let focusCalls = 0;
let snapshotReads = 0;
let commandCalls = 0;
const compareAndReplaceDraft = createChatGptPromptDraft({
  resolveTarget: async () => ({ ok: true, status: "READY", target: { id: "target-recovery", port: 9223, web_socket_debugger_url: "ws://target" } }),
  readInputSnapshot: async () => {
    snapshotReads += 1;
    if (snapshotReads === 1 || snapshotReads === 2) return { ok: true, text: staleComposerText };
    return { ok: true, text: expectedEnvelope };
  },
  safeEvaluateInTarget: async () => { focusCalls += 1; return { ok: true, targetTag: "DIV" }; },
  safeSendDevToolsCommand: async () => { commandCalls += 1; return { ok: true }; },
  buildComposerFocusExpression: () => "focus",
  compactChatGptTarget: (target) => target,
  redactInputSnapshot: (snapshot) => snapshot,
  normalizeTimeout: () => 3000,
});
const rejectedRecovery = await compareAndReplaceDraft.draftInput({ ports: [9223], targetId: "target-recovery", prompt: expectedEnvelope, allowOverwrite: true, expectedExistingHash: "0".repeat(64), timeoutMs: 3000 });
assert.equal(rejectedRecovery.ok, false);
assert.equal(rejectedRecovery.status, "COMPOSER_COMPARE_AND_REPLACE_REJECTED");
assert.equal(focusCalls, 0);
const acceptedRecovery = await compareAndReplaceDraft.draftInput({ ports: [9223], targetId: "target-recovery", prompt: expectedEnvelope, allowOverwrite: true, expectedExistingHash: canonicalStaleComposerHash, timeoutMs: 3000 });
assert.equal(acceptedRecovery.status, "INPUT_DRAFT_WRITTEN");
assert.equal(focusCalls, 1);
assert.equal(commandCalls, 2);

const blockedDraftReceipt = summarizeEngineCycleStageReceipt({
  result: {
    drafted: {
      status: "COMPOSER_NOT_READY",
      retryable: true,
      readiness_attempt_count: 3,
      readiness_elapsed_ms: 1200,
      expected_target_id: "target-1",
    },
  },
});
assert.equal(blockedDraftReceipt.inner_status, "COMPOSER_NOT_READY");
assert.equal(blockedDraftReceipt.retryable, true);
assert.equal(blockedDraftReceipt.attempt_count, 3);
assert.equal(blockedDraftReceipt.target_id, "target-1");

const nestedOwnershipReceipt = summarizeEngineCycleStageReceipt({
  result: {
    ok: false,
    stage: "prompt_draft",
    status: "ENGINE_CYCLE_STAGE_BLOCKED",
    ownership: {
      status: "COMPOSER_OWNERSHIP_CLASSIFIED",
      ownership_classification: "FOREIGN_TEXT",
      composer_text_length: 62,
      composer_text_hash: "foreign-hash",
      expected_text_hash: "expected-hash",
      safe_to_attach: false,
      retryable: false,
      target_id: "target-2",
    },
  },
});
assert.equal(nestedOwnershipReceipt.inner_status, "COMPOSER_OWNERSHIP_CLASSIFIED");
assert.equal(nestedOwnershipReceipt.ownership_classification, "FOREIGN_TEXT");
assert.equal(nestedOwnershipReceipt.composer_text_length, 62);
assert.equal(nestedOwnershipReceipt.attachment_present, false);

const reasoningBlockedReceipt = summarizeEngineCycleStageReceipt({
  reasoning: {
    ok: false,
    status: "CHATGPT_REASONING_REQUIREMENT_UNVERIFIED",
    mutation_attempted: true,
    before: {
      status: "CHATGPT_REASONING_INSPECTED",
      observed_mode: "agent",
      observed_effort: "high",
      observed_model_label: "GPT-5.5 Thinking",
    },
    mutation: {
      status: "CHATGPT_REASONING_MUTATION_OPTION_NOT_FOUND",
    },
    after: {
      status: "CHATGPT_REASONING_INSPECTED",
      observed_mode: "agent",
      observed_effort: "high",
      observed_model_label: "GPT-5.5 Thinking",
    },
  },
});
assert.equal(reasoningBlockedReceipt.inner_status, "CHATGPT_REASONING_REQUIREMENT_UNVERIFIED");
assert.equal(reasoningBlockedReceipt.reasoning_status, "CHATGPT_REASONING_REQUIREMENT_UNVERIFIED");
assert.equal(reasoningBlockedReceipt.reasoning_mutation_attempted, true);
assert.equal(reasoningBlockedReceipt.reasoning_mutation_status, "CHATGPT_REASONING_MUTATION_OPTION_NOT_FOUND");
assert.equal(reasoningBlockedReceipt.reasoning_observed_effort, "high");
assert.equal(reasoningBlockedReceipt.reasoning_observed_model_label, "GPT-5.5 Thinking");

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "console-mcp-engine-spec-"));
try {
  const tempWorkspaceRoot = path.join(tempRoot, "workspace");
  const tempWorkspace = path.join(tempWorkspaceRoot, "nested", "component");
  const tempEngineRoot = path.join(tempRoot, "engine");
  await mkdir(tempWorkspace, { recursive: true });
  const tempPaths = createEnginePaths(tempEngineRoot, tempWorkspaceRoot);
  const enqueued = await enqueueTask(tempPaths, "component", true, "mcp", tempWorkspace);
  const repeated = await enqueueTask(tempPaths, "component", true, "mcp", tempWorkspace);
  assert.equal(enqueued.ok, true);
  assert.equal(repeated.ok, true);
  assert.notEqual(enqueued.task_id, repeated.task_id, "repeat adoption must create a distinct bounded task");
  const chatId = "11111111-1111-1111-1111-111111111111";
  await bindEngineChatSession(tempPaths, enqueued.task_id, { chat_id: chatId, target_id: "target-active", current_url: `https://chatgpt.com/c/${chatId}` });
  const activeMatch = await findActiveEngineTaskByChatBinding(tempPaths, { chatId, component: "component", workspacePath: tempWorkspace });
  assert.equal(activeMatch?.task_id, enqueued.task_id);
  const activeTaskPath = path.join(tempPaths.taskDir, `${enqueued.task_id}.json`);
  const activeTask = JSON.parse(await readFile(activeTaskPath, "utf8"));
  activeTask.status = "completed";
  await writeFile(activeTaskPath, `${JSON.stringify(activeTask, null, 2)}\n`, "utf8");
  const terminalMatch = await findActiveEngineTaskByChatBinding(tempPaths, { chatId, component: "component", workspacePath: tempWorkspace });
  assert.equal(terminalMatch, null, "terminal tasks must be evacuated from the active task set");
  assert.equal(normalizeChatGptLocation("@6A58715C10"), "6a58715c10");
  assert.equal(normalizeChatGptLocation("[viewing:6a58715c10]"), "viewing:6a58715c10");
  const registryPolicy = { transcriptDir: tempRoot };
  await writeFile(path.join(tempRoot, "chatgpt-component-chat-registry.json"), JSON.stringify({ schema: "console-mcp.chatgpt-component-chat-registry.v1", updated_at: new Date().toISOString(), chats: { [chatId]: { provider: "chatgpt-web", chat_id: chatId, component_token: "viewing", package_token: "viewing", composer_name: "viewing/viewing", workspace_path: tempWorkspace, workspace_folder: "viewing", chat_stamp: "6a58715c10", title_prefix: "[viewing:6a58715c10]", desired_title: "[viewing:6a58715c10] Cleaner investigation", rename_status: "CHAT_TITLE_RENAMED", updated_at: new Date().toISOString() } } }, null, 2), "utf8");
  const registryMatch = await resolveRegisteredChatGptLocation(registryPolicy, "@6a58715c10", "viewing");
  assert.equal(registryMatch.length, 1);
  assert.equal(registryMatch[0].chat_id, chatId);
  const specificationText = "Original user request: Cmcp go component M70\n\nRequired reconnaissance before conclusions or patches:\n- Objecting\n- Cruding\n- Canonisating\n- Viewing\n- Interfacing\n- Navigating";
  const specification = await recordEngineExecutionSpecification(tempPaths, enqueued.task_id, { content: specificationText, sourcePrompt: "Cmcp go component M70" });
  assert.equal(specification.ok, true);
  assert.match(specification.specification_path, /prompt-[a-f0-9]{64}\.md$/);
  const firstPrompt = await buildEnginePhasePrompt(tempPaths, enqueued.task_id);
  assert.equal(firstPrompt.prompt_transport, "FILE_ATTACHMENT");
  assert.equal(firstPrompt.prompt_attachment_path, specification.specification_path);
  assert.match(firstPrompt.prompt, /complete authoritative execution specification/i);
  assert.equal(firstPrompt.prompt.includes("Required reconnaissance before conclusions or patches"), false);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const stableCapturePlan = runChatGptRunLoopPlan({
  phase: "reply_watch",
  taskClass: "repo_rc_implementation",
  iteration: 3,
  maxIterations: 70,
  watchStatus: "READY_FOR_STABLE_CAPTURE",
  chatId: "00000000-0000-0000-0000-000000000000",
  workspacePath: "D:\\PhpstormProjects\\www\\Paying",
  beforeHead: "0000000000000000000000000000000000000000",
  attempt: 3,
});
assert.equal(stableCapturePlan.next_action, "RUN_PRE_ASK_CAPTURE");
assert.equal(stableCapturePlan.recommended_call?.tool, "console.read_.browser.chatgpt.implementation.pre_ask.capture");

const attachmentSafeSelector = '[contenteditable="false"], button, input, [data-testid*=attachment], [data-testid*=file], [class*=attachment], [class*=file], [aria-label*=attachment i], [aria-label*=file i]';
const executorSource = await readFile(path.resolve("src/service/browser-session-executor.ts"), "utf8");
const executorDist = await readFile(path.resolve("dist/service/browser-session-executor.js"), "utf8");
const engineCycleSource = await readFile(path.resolve("src/engine/engine-cycle-browser.ts"), "utf8");
const engineCycleDist = await readFile(path.resolve("dist/engine/engine-cycle-browser.js"), "utf8");
const engineToolSource = await readFile(path.resolve("src/tool/engine.ts"), "utf8");
const engineToolDist = await readFile(path.resolve("dist/tool/engine.js"), "utf8");
assert.match(engineCycleSource, /expectedTargetId: targetId, expectedTaskId: context\.taskId, requireChatId: chatId !== undefined/);
assert.match(engineCycleDist, /expectedTargetId: targetId, expectedTaskId: context\.taskId, requireChatId: chatId !== undefined/);
assert.match(engineCycleSource, /applyBrowserSessionTitlePrefix\(options\.policy/);
assert.match(engineCycleSource, /chatTitleMode: "auto"/);
assert.match(engineCycleSource, /reasoning_warning: reasoning\.ok === true \? null : reasoning\.status/);
assert.match(engineCycleSource, /recordEngineAnswerCapture\(context\.paths, context\.taskId, \{ \.\.\.settled, title_prefix: titlePrefix \}\)/);
assert.match(engineCycleDist, /applyBrowserSessionTitlePrefix\(options\.policy/);
assert.match(engineCycleDist, /chatTitleMode: "auto"/);
assert.match(engineToolSource, /expectedTargetId: targetId, expectedTaskId: taskId, requireChatId: chatId !== undefined/);
assert.match(engineToolDist, /expectedTargetId: targetId, expectedTaskId: taskId, requireChatId: chatId !== undefined/);
assert.ok(executorSource.split(attachmentSafeSelector).length - 1 >= 4, "composer source must sanitize attachment UI in snapshot, preflight, focus, and post-submit reads");
assert.ok(executorDist.split(attachmentSafeSelector).length - 1 >= 4, "built composer executor must preserve attachment-safe extraction");

process.stdout.write(`${JSON.stringify({
  ok: true,
  authorized_done_dispatches_with_max_rounds: authorizedDecision.dispatch === true && authorizedDecision.maxRounds === 5,
  waiting_user_skipped: waitingUserDecision.dispatch === false,
  done_without_authorization_skipped: doneNotAuthorizedDecision.dispatch === false,
  zero_iterations_skipped: zeroIterationsDecision.dispatch === false,
  missing_iterations_skipped: missingIterationsDecision.dispatch === false,
  stable_capture_dispatches_pre_ask: stableCapturePlan.next_action === "RUN_PRE_ASK_CAPTURE",
})}\n`);
