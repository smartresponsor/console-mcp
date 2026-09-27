$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $script = @'
import assert from "node:assert/strict";
import { classifyIrrecoverableDeletedAnswerCaptureTask } from "./dist/service/engine-deleted-answer-reconciler.js";

assert.deepEqual(
  classifyIrrecoverableDeletedAnswerCaptureTask({
    status: "waiting_runtime",
    execution_blocked_stage: "answer_capture",
    conversation_deleted_at: "2026-09-27T00:00:00.000Z",
    answer_captured_at: null
  }),
  { terminal: true, reason: "CONVERSATION_DELETED_BEFORE_ANSWER_CAPTURE" }
);
assert.equal(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "waiting_runtime",
  execution_blocked_stage: "answer_capture",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: "2026-09-26T23:59:00.000Z"
}).terminal, false);
assert.equal(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "waiting_runtime",
  execution_blocked_stage: "runtime_capacity",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: null
}).terminal, false);
assert.equal(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "waiting_runtime",
  execution_blocked_stage: "answer_capture",
  conversation_deleted_at: null,
  answer_captured_at: null
}).terminal, false);

console.log(JSON.stringify({ ok: true, status: "ENGINE_DELETED_ANSWER_RECONCILER_REGRESSION_GREEN" }));
'@
    & node --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) { throw "Node regression failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
