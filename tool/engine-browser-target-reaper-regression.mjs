import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const root = process.cwd();
const { reapReadyEngineBrowserTargets } = await import(pathToFileURL(path.join(root, "dist", "service", "engine-browser-target-reaper.js")));
const { bindEngineChatSession, createEnginePaths } = await import(pathToFileURL(path.join(root, "dist", "engine", "engine-core.js")));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cmcp-target-reaper-"));
const taskDir = path.join(tempRoot, "var", "run", "engine", "task");
await mkdir(taskDir, { recursive: true });
const taskId = "engine-target-reaper-regression";
const taskPath = path.join(taskDir, `${taskId}.json`);
const oneShotTaskId = "engine-target-reaper-one-shot";
const oneShotTaskPath = path.join(taskDir, `${oneShotTaskId}.json`);
const ephemeralTaskId = "engine-target-reaper-ephemeral";
const ephemeralTaskPath = path.join(taskDir, `${ephemeralTaskId}.json`);
const preCaptureEphemeralTaskId = "engine-target-reaper-ephemeral-pre-capture";
const preCaptureEphemeralTaskPath = path.join(taskDir, `${preCaptureEphemeralTaskId}.json`);
const abandonedEphemeralTaskId = "engine-target-reaper-ephemeral-title-abandoned";
const abandonedEphemeralTaskPath = path.join(taskDir, `${abandonedEphemeralTaskId}.json`);
await writeFile(taskPath, JSON.stringify({
  task_id: taskId, source: "cli", component: "Regression", component_label: "Regression", workspace_path: tempRoot,
  status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "execution complete", last_event_id: null, ready_to_delete: true, conversation_policy: "standard",
  title_prefixed_at: new Date().toISOString(), chat_id: "WEB:target-reaper-chat", target_id: "missing-target-id",
}), "utf8");
await writeFile(oneShotTaskPath, JSON.stringify({
  task_id: oneShotTaskId, source: "cli", component: "Atlas", component_label: "Atlas", workspace_path: tempRoot,
  status: "evaluating", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "return first answer", last_event_id: null, ready_to_delete: null, conversation_policy: "one_shot", browser_target_policy: "ephemeral",
  title_prefixed_at: new Date().toISOString(), answer_captured_at: new Date().toISOString(), submitted_at: new Date().toISOString(), chat_id: "WEB:one-shot-chat", target_id: "missing-one-shot-target",
}), "utf8");
await writeFile(ephemeralTaskPath, JSON.stringify({
  task_id: ephemeralTaskId, source: "cli", component: "Canon", component_label: "Canon", workspace_path: tempRoot,
  status: "waiting_runtime", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "resume later", last_event_id: null, ready_to_delete: false, conversation_policy: "standard", browser_target_policy: "ephemeral",
  title_prefixed_at: new Date().toISOString(), submitted_at: new Date().toISOString(), answer_captured_at: new Date().toISOString(), chat_id: "WEB:ephemeral-chat", target_id: "missing-ephemeral-target",
}), "utf8");
await writeFile(preCaptureEphemeralTaskPath, JSON.stringify({
  task_id: preCaptureEphemeralTaskId, source: "cli", component: "Canon", component_label: "Canon", workspace_path: tempRoot,
  status: "waiting_runtime", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "wait for first answer", last_event_id: null, ready_to_delete: false, conversation_policy: "standard", browser_target_policy: "ephemeral",
  submitted_at: new Date().toISOString(), chat_id: "WEB:ephemeral-pre-capture-chat", target_id: "missing-ephemeral-pre-capture-target",
}), "utf8");
await writeFile(abandonedEphemeralTaskPath, JSON.stringify({
  task_id: abandonedEphemeralTaskId, source: "cli", component: "Canon", component_label: "Canon", workspace_path: tempRoot,
  status: "waiting_runtime", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "resume later", last_event_id: null, ready_to_delete: false, conversation_policy: "standard", browser_target_policy: "ephemeral",
  title_prefix_status: "ENGINE_CHAT_TITLE_REPAIR_EXPIRED", title_prefix_abandoned_at: new Date().toISOString(), submitted_at: new Date().toISOString(), answer_captured_at: new Date().toISOString(), chat_id: "WEB:ephemeral-abandoned-chat", target_id: "missing-ephemeral-abandoned-target",
}), "utf8");
try {
  const result = await reapReadyEngineBrowserTargets({ root: tempRoot, ports: [65534], timeoutMs: 500, maxClose: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.candidate_count, 4);
  assert.equal(result.closed_count, 4);
  assert.equal(result.conversation_delete_count, 0);
  const updated = JSON.parse(await readFile(taskPath, "utf8"));
  assert.equal(typeof updated.browser_target_closed_at, "string");
  assert.equal(updated.browser_target_close_reason, "ready_to_delete_recovery_reaper");
  assert.equal(updated.ready_to_delete, true);
  assert.equal(updated.chat_id, "WEB:target-reaper-chat");
  const oneShotUpdated = JSON.parse(await readFile(oneShotTaskPath, "utf8"));
  assert.equal(typeof oneShotUpdated.browser_target_closed_at, "string");
  assert.equal(oneShotUpdated.browser_target_close_reason, "one_shot_answer_recovery_reaper");
  assert.equal(oneShotUpdated.conversation_policy, "one_shot");
  assert.equal(oneShotUpdated.chat_id, "WEB:one-shot-chat");
  assert.equal(oneShotUpdated.target_id, null);
  const ephemeralUpdated = JSON.parse(await readFile(ephemeralTaskPath, "utf8"));
  assert.equal(typeof ephemeralUpdated.browser_target_closed_at, "string");
  assert.equal(ephemeralUpdated.browser_target_close_reason, "ephemeral_yield_recovery_reaper");
  assert.equal(ephemeralUpdated.browser_target_policy, "ephemeral");
  assert.equal(ephemeralUpdated.ready_to_delete, false);
  assert.equal(ephemeralUpdated.chat_id, "WEB:ephemeral-chat");
  assert.equal(ephemeralUpdated.target_id, null);
  const preCaptureEphemeralUpdated = JSON.parse(await readFile(preCaptureEphemeralTaskPath, "utf8"));
  assert.equal(preCaptureEphemeralUpdated.browser_target_closed_at ?? null, null);
  assert.equal(preCaptureEphemeralUpdated.target_id, "missing-ephemeral-pre-capture-target");
  const abandonedEphemeralUpdated = JSON.parse(await readFile(abandonedEphemeralTaskPath, "utf8"));
  assert.equal(typeof abandonedEphemeralUpdated.browser_target_closed_at, "string");
  assert.equal(abandonedEphemeralUpdated.browser_target_close_reason, "ephemeral_yield_recovery_reaper");
  assert.equal(typeof abandonedEphemeralUpdated.title_prefix_abandoned_at, "string");
  assert.equal(abandonedEphemeralUpdated.title_prefixed_at ?? null, null);
  const rebound = await bindEngineChatSession(createEnginePaths(tempRoot), ephemeralTaskId, { chat_id: "WEB:ephemeral-chat", target_id: "reopened-ephemeral-target", current_url: "https://chatgpt.com/c/WEB:ephemeral-chat" });
  assert.equal(rebound.ok, true);
  const reboundTask = JSON.parse(await readFile(ephemeralTaskPath, "utf8"));
  assert.equal(reboundTask.chat_id, "WEB:ephemeral-chat");
  assert.equal(reboundTask.target_id, "reopened-ephemeral-target");
  assert.equal(reboundTask.browser_target_closed_at, null);
  assert.equal(reboundTask.browser_target_close_status, null);

  const cycleSource = readFileSync(path.join(root, "src", "engine", "engine-cycle-browser.ts"), "utf8");
  const executorSource = readFileSync(path.join(root, "src", "service", "browser-session-executor.ts"), "utf8");
  const laneSource = readFileSync(path.join(root, "tool", "dev-console.d", "99-engine-browser-target-reaper.ps1"), "utf8");
  const cliSource = readFileSync(path.join(root, "src", "engine", "engine-cli.ts"), "utf8");
  const coreSource = readFileSync(path.join(root, "src", "engine", "engine-core.ts"), "utf8");
  const conversationLifecycleSource = readFileSync(path.join(root, "src", "service", "engine-conversation-lifecycle.ts"), "utf8");
  assert.match(cycleSource, /conversation_policy === "one_shot"[\s\S]*one_shot_answer_captured/);
  const outcomeIndex = cycleSource.indexOf("const outcome = await recordEngineExecutionOutcome");
  const verifiedCloseIndex = cycleSource.indexOf("verified_completion_ready_to_delete");
  assert.ok(outcomeIndex >= 0 && verifiedCloseIndex > outcomeIndex, "standard target close must occur only after durable execution outcome");
  assert.match(cycleSource, /completedTask\.ready_to_delete === true/);
  assert.match(cycleSource, /browser_target_policy === "ephemeral"[\s\S]*answer_captured_at[\s\S]*ephemeral_invocation_yield/);
  const reaperSource = readFileSync(path.join(root, "src", "service", "engine-browser-target-reaper.ts"), "utf8");
  assert.match(reaperSource, /browser_target_policy === "ephemeral"[\s\S]*answer_captured_at/);
  assert.match(reaperSource, /titleLifecycleReady = typeof task\.title_prefixed_at === "string" \|\| typeof task\.title_prefix_abandoned_at === "string"/);
  assert.match(reaperSource, /ephemeralYieldReady[\s\S]*titleLifecycleReady/);
  assert.match(cliSource, /--ephemeral-target/);
  assert.match(cliSource, /browserTargetPolicy: ephemeralTarget \? "ephemeral" : "persistent"/);
  assert.match(coreSource, /task\.target_id = null/);
  assert.match(coreSource, /task\.browser_target_closed_at = null/);
  assert.doesNotMatch(conversationLifecycleSource, /answerRecoveryReady[^\n]*typeof task\.answer_captured_at !== "string"/);
  assert.match(conversationLifecycleSource, /assistantRevisionIsNew/);
  assert.match(conversationLifecycleSource, /assistantHash !== null && assistantHash !== previousAssistantHash/);
  assert.doesNotMatch(conversationLifecycleSource, /openChatGptChat/);
  assert.doesNotMatch(conversationLifecycleSource, /runChatGptMessageCapture/);
  assert.match(conversationLifecycleSource, /applyBrowserSessionTitlePrefix/);
  assert.match(conversationLifecycleSource, /fallback: "existing_exact_target"/);
  assert.match(conversationLifecycleSource, /inventoryTargets\.find\(\(item\) => stringField\(item, "chat_id"\) === chatId\)/);
  assert.match(conversationLifecycleSource, /renameChatGptConversationLifecycle/);
  assert.equal((conversationLifecycleSource.match(/readChatGptConversationLifecycle\(/g) || []).length, 1, "conversation lifecycle must reuse one backend read per candidate");
  assert.match(conversationLifecycleSource, /candidate\.answerRecoveryReady \|\| candidate\.titleRepairReady/);
  assert.match(conversationLifecycleSource, /const conversation = conversationRead \?\? \{\}/);
  assert.match(conversationLifecycleSource, /ENGINE_CHAT_TITLE_BACKEND_NOT_READY/);
  assert.match(conversationLifecycleSource, /titleRepairReady/);
  assert.match(conversationLifecycleSource, /Number\(b\.titleRepairReady\)[\s\S]*Number\(b\.answerRecoveryReady\)/);
  assert.match(conversationLifecycleSource, /title_prefix_attempted_at/);
  assert.match(conversationLifecycleSource, /Date\.now\(\) - titleAttemptedAt >= 30_000/);
  assert.match(conversationLifecycleSource, /Date\.now\(\) - submittedAtMs >= 30 \* 60 \* 1000/);
  assert.match(conversationLifecycleSource, /ENGINE_CHAT_TITLE_REPAIR_EXPIRED/);
  assert.match(conversationLifecycleSource, /title_prefix_abandoned_at/);
  assert.match(coreSource, /task\.title_prefix_attempted_at = recordedAt/);
  assert.match(coreSource, /executor_chat_title_prefix_abandoned/);
  assert.match(coreSource, /task\.title_prefix_abandoned_at = recordedAt/);
  assert.doesNotMatch(cycleSource, /if \(titlePrefix\.ok !== true\) return \{ ok: false, title_prefix: titlePrefix \};/);
  assert.match(cycleSource, /const recorded = await recordEngineChatTitlePrefix\(context\.paths, context\.taskId, titlePrefix\)/);
  assert.doesNotMatch(conversationLifecycleSource, /if \(title\.ok === true\)[\s\S]*recordEngineChatTitlePrefix/);
  assert.doesNotMatch(conversationLifecycleSource, /const deleteReady = task\.status === "completed" && task\.ready_to_delete === true/);
  assert.match(conversationLifecycleSource, /const deleteReady = task\.ready_to_delete === true/);
  assert.match(executorSource, /CHATGPT_TARGET_CLOSE_CHAT_ID_MISMATCH/);
  assert.match(executorSource, /conversation_deleted: false/);
  assert.match(laneSource, /IntervalSeconds \(Get-EngineBrowserTargetReaperIntervalSeconds\)/);
  assert.match(laneSource, /Start-Process/);
  assert.match(laneSource, /return 30/);
  console.log(JSON.stringify({ ok: true, status: "ENGINE_BROWSER_TARGET_REAPER_GREEN", immediate_one_shot: true, verified_completion: true, recovery_reaper: true, conversation_deleted: false }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
