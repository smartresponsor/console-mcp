import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { createEnginePaths, getEngineStatus } = await import(pathToFileURL(path.join(root, "dist", "engine", "engine-core.js")));
const { reapEngineConversationLifecycle } = await import(pathToFileURL(path.join(root, "dist", "service", "engine-conversation-lifecycle.js")));

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cmcp-manual-delete-"));
const taskDir = path.join(tempRoot, "var", "run", "engine", "task");
await mkdir(taskDir, { recursive: true });

const now = new Date().toISOString();
const taskId = "engine-manual-delete-regression";
await writeFile(path.join(taskDir, `${taskId}.json`), JSON.stringify({
  task_id: taskId,
  source: "cli",
  component: "regression",
  component_label: "Regression",
  workspace_path: tempRoot,
  status: "executing",
  created_at: now,
  updated_at: now,
  attempt: 0,
  dry_run: false,
  next_action: "submit phase prompt",
  last_event_id: null,
  conversation_policy: "standard",
  chat_id: "manual-deleted-chat",
  title_prefixed_at: null,
  title_prefix_status: "ENGINE_CHAT_TITLE_BACKEND_NOT_READY",
  title_prefix_attempted_at: new Date(Date.now() - 60_000).toISOString(),
  ready_to_delete: false,
  conversation_deleted_at: now,
  conversation_delete_status: "CHAT_ALREADY_DELETED"
}, null, 2) + "\n", "utf8");

try {
  const status = await getEngineStatus(createEnginePaths(tempRoot, tempRoot));
  assert.equal(status.pressure_task_count, 0, "manually deleted conversation must not count as live engine pressure");
  assert.deepEqual(status.pressure_tasks, [], "manually deleted conversation must not appear in pressure task inventory");

  const lifecycle = await reapEngineConversationLifecycle({ root: tempRoot, ports: [65534], timeoutMs: 500, maxWork: 10 });
  assert.equal(lifecycle.candidate_count, 0, "manually deleted conversation must not re-enter title repair or deletion lifecycle");
  assert.equal(lifecycle.selected_count, 0);
  assert.equal(lifecycle.delete_attempted_count, 0);

  console.log(JSON.stringify({ ok: true, status: "ENGINE_MANUAL_DELETE_PRESSURE_REGRESSION_GREEN" }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
