$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $script = @'
import assert from "node:assert/strict";
import { classifyIrrecoverableDeletedAnswerCaptureTask } from "../../dist/service/engine-deleted-answer-reconciler.js";

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
  status: "evaluating",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: "2026-09-26T23:59:00.000Z",
  decision_status: null,
  ready_to_delete: false
}).terminal, false);
assert.deepEqual(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "blocked",
  execution_blocked_stage: "chat_bind",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: "2026-09-26T23:59:00.000Z",
  decision_status: "continue",
  ready_to_delete: false
}), { terminal: true, reason: "CONVERSATION_DELETED_BEFORE_CONTINUATION" });
assert.deepEqual(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "blocked",
  execution_blocked_stage: "chat_bind",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: "2026-09-26T23:59:00.000Z",
  decision_status: "fix fail and continue",
  ready_to_delete: false
}), { terminal: true, reason: "CONVERSATION_DELETED_BEFORE_CONTINUATION" });
assert.equal(classifyIrrecoverableDeletedAnswerCaptureTask({
  status: "blocked",
  execution_blocked_stage: "chat_bind",
  conversation_deleted_at: "2026-09-27T00:00:00.000Z",
  answer_captured_at: "2026-09-26T23:59:00.000Z",
  decision_status: "done",
  ready_to_delete: true
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
    $tempScript = Join-Path $root "var\run\engine-deleted-answer-reconciler-regression.mjs"
    $tempDir = Split-Path -Parent $tempScript
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    Set-Content -LiteralPath $tempScript -Value $script -Encoding UTF8
    try {
        & node $tempScript
        if ($LASTEXITCODE -ne 0) { throw "Node regression failed with exit code $LASTEXITCODE" }
    } finally {
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
