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
await writeFile(taskPath, JSON.stringify({
  task_id: taskId, source: "cli", component: "Regression", component_label: "Regression", workspace_path: tempRoot,
  status: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "execution complete", last_event_id: null, ready_to_delete: true, conversation_policy: "standard",
  chat_id: "WEB:target-reaper-chat", target_id: "missing-target-id",
}), "utf8");
await writeFile(oneShotTaskPath, JSON.stringify({
  task_id: oneShotTaskId, source: "cli", component: "Atlas", component_label: "Atlas", workspace_path: tempRoot,
  status: "evaluating", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "return first answer", last_event_id: null, ready_to_delete: null, conversation_policy: "one_shot", browser_target_policy: "ephemeral",
  answer_captured_at: new Date().toISOString(), submitted_at: new Date().toISOString(), chat_id: "WEB:one-shot-chat", target_id: "missing-one-shot-target",
}), "utf8");
await writeFile(ephemeralTaskPath, JSON.stringify({
  task_id: ephemeralTaskId, source: "cli", component: "Canon", component_label: "Canon", workspace_path: tempRoot,
  status: "waiting_runtime", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), attempt: 1, dry_run: false,
  next_action: "resume later", last_event_id: null, ready_to_delete: false, conversation_policy: "standard", browser_target_policy: "ephemeral",
  submitted_at: new Date().toISOString(), chat_id: "WEB:ephemeral-chat", target_id: "missing-ephemeral-target",
}), "utf8");
try {
  const result = await reapReadyEngineBrowserTargets({ root: tempRoot, ports: [65534], timeoutMs: 500, maxClose: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.candidate_count, 3);
  assert.equal(result.closed_count, 3);
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
  assert.match(cycleSource, /conversation_policy === "one_shot"[\s\S]*one_shot_answer_captured/);
  const outcomeIndex = cycleSource.indexOf("const outcome = await recordEngineExecutionOutcome");
  const verifiedCloseIndex = cycleSource.indexOf("verified_completion_ready_to_delete");
  assert.ok(outcomeIndex >= 0 && verifiedCloseIndex > outcomeIndex, "standard target close must occur only after durable execution outcome");
  assert.match(cycleSource, /completedTask\.ready_to_delete === true/);
  assert.match(cycleSource, /browser_target_policy === "ephemeral"[\s\S]*ephemeral_invocation_yield/);
  assert.match(cliSource, /--ephemeral-target/);
  assert.match(cliSource, /browserTargetPolicy: ephemeralTarget \? "ephemeral" : "persistent"/);
  assert.match(coreSource, /task\.target_id = null/);
  assert.match(coreSource, /task\.browser_target_closed_at = null/);
  assert.match(executorSource, /CHATGPT_TARGET_CLOSE_CHAT_ID_MISMATCH/);
  assert.match(executorSource, /conversation_deleted: false/);
  assert.match(laneSource, /IntervalSeconds \(Get-EngineBrowserTargetReaperIntervalSeconds\)/);
  assert.match(laneSource, /Start-Process/);
  assert.match(laneSource, /return 30/);
  console.log(JSON.stringify({ ok: true, status: "ENGINE_BROWSER_TARGET_REAPER_GREEN", immediate_one_shot: true, verified_completion: true, recovery_reaper: true, conversation_deleted: false }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
