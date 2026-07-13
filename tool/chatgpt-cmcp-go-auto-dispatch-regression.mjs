import assert from "node:assert/strict";
import { resolveCmcpGoAutoDispatch } from "../dist/tool/chatgpt-chat-open.js";
import { runChatGptRunLoopPlan } from "../dist/tool/chatgpt-message-capture.js";

// Isolated smoke test for the M30 "go" auto-dispatch gate: once the phase plan reaches
// done/dispatch-ready for an authorized task, the round-driving logic must be reached with
// maxRounds equal to the task's max_auto_iterations (the N from "M<N>"), with no manual
// console.write.engine.cycle.run_n call required. This test only exercises the pure decision
// function extracted in src/tool/chatgpt-chat-open.ts; it does not touch any repo/task-bank state
// or start a browser/CDP session.

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

process.stdout.write(`${JSON.stringify({
  ok: true,
  authorized_done_dispatches_with_max_rounds: authorizedDecision.dispatch === true && authorizedDecision.maxRounds === 5,
  waiting_user_skipped: waitingUserDecision.dispatch === false,
  done_without_authorization_skipped: doneNotAuthorizedDecision.dispatch === false,
  zero_iterations_skipped: zeroIterationsDecision.dispatch === false,
  missing_iterations_skipped: missingIterationsDecision.dispatch === false,
  stable_capture_dispatches_pre_ask: stableCapturePlan.next_action === "RUN_PRE_ASK_CAPTURE",
})}\n`);
