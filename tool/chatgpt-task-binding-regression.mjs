import assert from "node:assert/strict";
import { selectExactTaskBinding } from "../dist/tool/chatgpt-message-capture.js";

const merchandisingTaskId = "engine-20260712043707-merchandising-105ec7";
const accessingTaskId = "engine-20260712034458-accessing-28643a";

const merchandisingTarget = {
  id: "target-merchandising",
  type: "page",
  title: "Merchandising execution",
  url: "https://chatgpt.com/c/merchandising-chat",
  port: 9223,
  chat_id: "merchandising-chat",
  web_socket_debugger_url: "ws://127.0.0.1:9223/devtools/page/target-merchandising",
};

const accessingTarget = {
  id: "target-accessing",
  type: "page",
  title: "Accessing execution",
  url: "https://chatgpt.com/c/accessing-chat",
  port: 9223,
  chat_id: "accessing-chat",
  web_socket_debugger_url: "ws://127.0.0.1:9223/devtools/page/target-accessing",
};

const twoOpenChats = [accessingTarget, merchandisingTarget];
const latestUserTextByTargetId = {
  [accessingTarget.id]: `Engine task execution request.\n\nTask ID: ${accessingTaskId}\nComponent: Accessing`,
  [merchandisingTarget.id]: `Engine task execution request.\n\nTask ID: ${merchandisingTaskId}\nComponent: Merchandising`,
};

const exact = selectExactTaskBinding(twoOpenChats, merchandisingTaskId, latestUserTextByTargetId);
assert.equal(exact.ok, true);
assert.equal(exact.status, "BOUND_BY_TASK_ID");
assert.equal(exact.target?.id, merchandisingTarget.id);
assert.notEqual(exact.target?.id, accessingTarget.id);

const missing = selectExactTaskBinding(twoOpenChats, "engine-missing-task", latestUserTextByTargetId);
assert.equal(missing.ok, false);
assert.equal(missing.status, "TASK_BINDING_NOT_FOUND");
assert.equal(missing.target, null);

const ambiguous = selectExactTaskBinding(
  twoOpenChats,
  merchandisingTaskId,
  {
    [accessingTarget.id]: `Task ID: ${merchandisingTaskId}`,
    [merchandisingTarget.id]: `Task ID: ${merchandisingTaskId}`,
  },
);
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.status, "TASK_BINDING_AMBIGUOUS");
assert.equal(ambiguous.target, null);

process.stdout.write(`${JSON.stringify({
  ok: true,
  exact_target_id: exact.target?.id ?? null,
  wrong_target_rejected: exact.target?.id !== accessingTarget.id,
  missing_status: missing.status,
  ambiguous_status: ambiguous.status,
})}\n`);
