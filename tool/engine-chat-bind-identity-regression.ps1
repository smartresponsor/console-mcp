$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $script = @'
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindEngineChatSession, createEnginePaths } from "./dist/engine/engine-core.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cmcp-chat-bind-identity-"));
const taskDir = path.join(tempRoot, "var", "run", "engine", "task");
await mkdir(taskDir, { recursive: true });
const now = new Date().toISOString();
const writeTask = async (taskId, chatId = null) => {
  await writeFile(path.join(taskDir, taskId + ".json"), JSON.stringify({
    task_id: taskId,
    source: "cli",
    component: "regression",
    component_label: "Regression",
    workspace_path: tempRoot,
    status: "executing",
    created_at: now,
    updated_at: now,
    attempt: 1,
    dry_run: false,
    next_action: "bind",
    last_event_id: null,
    chat_id: chatId,
    target_id: null
  }), "utf8");
};
const paths = createEnginePaths(tempRoot, tempRoot);
try {
  await writeTask("existing", "WEB:stable-chat");
  const rejected = await bindEngineChatSession(paths, "existing", {
    selected: { id: "root-target", chat_id: null, url: "https://chatgpt.com/" },
    current_url: "https://chatgpt.com/"
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, "ENGINE_CHAT_BIND_CHAT_ID_MISMATCH");
  assert.equal(rejected.expected_chat_id, "WEB:stable-chat");
  assert.equal(rejected.observed_chat_id, null);
  const afterRejected = JSON.parse(await readFile(path.join(taskDir, "existing.json"), "utf8"));
  assert.equal(afterRejected.chat_id, "WEB:stable-chat");
  assert.equal(afterRejected.target_id, null);

  const rebound = await bindEngineChatSession(paths, "existing", {
    chat_id: "WEB:stable-chat",
    selected: { id: "exact-target", chat_id: "WEB:stable-chat", url: "https://chatgpt.com/c/WEB:stable-chat" },
    current_url: "https://chatgpt.com/c/WEB:stable-chat"
  });
  assert.equal(rebound.ok, true);
  const afterRebound = JSON.parse(await readFile(path.join(taskDir, "existing.json"), "utf8"));
  assert.equal(afterRebound.chat_id, "WEB:stable-chat");
  assert.equal(afterRebound.target_id, "exact-target");

  await writeTask("fresh", null);
  const fresh = await bindEngineChatSession(paths, "fresh", {
    selected: { id: "fresh-root", chat_id: null, url: "https://chatgpt.com/" },
    current_url: "https://chatgpt.com/"
  });
  assert.equal(fresh.ok, true);
  const afterFresh = JSON.parse(await readFile(path.join(taskDir, "fresh.json"), "utf8"));
  assert.equal(afterFresh.chat_id, null);
  assert.equal(afterFresh.target_id, "fresh-root");

  console.log(JSON.stringify({ ok: true, status: "ENGINE_CHAT_BIND_IDENTITY_GREEN" }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
'@
    & node --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) { throw "Node regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
