#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  buildActionMarkerReplyBackText,
  classifyActionMarkerFromText,
  isContinuingActionMarker,
  isHumanDecisionActionMarker,
  isTerminalActionMarker,
  normalizeActionMarker,
} from "../dist/engine/action-marker-router.js";
import { detectEngineMutationPolicy } from "../dist/engine/engine-core.js";

const failReport = [
  "Status RED: useful RC progress committed, but QA gate found blocker.",
  "Commit created: 8f86dcc — Fail closed on incomplete RC evidence",
  "Workspace clean",
  "composer validate PASS",
  "phpstan PASS",
  "composer qa FAIL: phpunit-junit-gate.php reported incomplete or invalid PHPUnit JUnit report",
].join("\n");

const failDecision = classifyActionMarkerFromText(failReport);
assert.equal(failDecision.marker, "fix fail and continue");
assert.equal(failDecision.status, "fix fail and continue");
assert.equal(failDecision.source, "action_marker_router");
assert.equal(failDecision.ask_required, false);
assert.equal(failDecision.reply_back_required, true);
assert.ok(failDecision.confidence >= 0.9);
assert.ok(failDecision.signals.fail > 0);
assert.ok(failDecision.signals.gate > 0);
assert.ok(failDecision.signals.commit > 0);
assert.ok(failDecision.praise.includes("Commit is good."));
assert.ok(failDecision.praise.includes("Workspace clean is good."));
assert.ok(failDecision.praise.includes("Green gates are good."));
assert.equal(failDecision.signals.fail > 0, true);
assert.equal(failDecision.signals.commit > 0, true);
assert.equal(failDecision.signals.green > 0, true);
assert.ok(failDecision.summary.includes("fix fail and continue"));
assert.ok(failDecision.matched.some((line) => line.includes("composer qa FAIL")));
assert.match(failDecision.next_action, /Good:/);
assert.match(failDecision.next_action, /Action:/);
assert.match(failDecision.next_action, /Fix the reported fail/);

const dirtyFail = classifyActionMarkerFromText([
  "composer qa FAIL",
  "Worktree dirty",
  "Changed files were not committed yet",
].join("\n"));
assert.equal(dirtyFail.marker, "fix fail, commit and continue");
assert.ok(dirtyFail.confidence >= 0.9);

const greenNext = classifyActionMarkerFromText([
  "composer qa PASS",
  "phpunit PASS",
  "Workspace clean",
  "Next action: continue with the next bounded RC evidence pass",
].join("\n"));
assert.equal(greenNext.marker, "next");
assert.equal(greenNext.reply_back_required, true);
assert.ok(greenNext.praise.includes("Workspace clean is good."));
assert.ok(greenNext.praise.includes("Green gates are good."));
assert.ok(greenNext.praise.includes("Clear next action is good."));

const localGreen = classifyActionMarkerFromText("composer qa PASS\nphpstan PASS\nWorkspace clean");
assert.equal(localGreen.marker, "continue");
assert.equal(localGreen.reply_back_required, true);
assert.match(localGreen.next_action, /local green is good but is not automatically full task completion/);

const doneReport = classifyActionMarkerFromText([
  "Original specification is complete",
  "All requested scope complete",
  "Commit created: abcdef1",
  "Workspace clean",
  "composer qa PASS",
  "No remaining work",
].join("\n"));
assert.equal(doneReport.marker, "done");
assert.equal(doneReport.reply_back_required, false);
assert.equal(isTerminalActionMarker(doneReport.marker), true);

const questionReport = classifyActionMarkerFromText("Which option should I choose, option 1 or option 2?");
assert.equal(questionReport.marker, "recheck and continue");
assert.equal(questionReport.reply_back_required, true);
assert.ok(questionReport.signals.question > 0);

const humanDecisionReport = classifyActionMarkerFromText("This requires a product decision from the user before I can safely proceed. Which option should I implement?");
assert.equal(humanDecisionReport.marker, "human decision required");
assert.equal(humanDecisionReport.reply_back_required, false);
assert.equal(isHumanDecisionActionMarker(humanDecisionReport.marker), true);
assert.equal(isContinuingActionMarker(humanDecisionReport.marker), false);
assert.ok(humanDecisionReport.signals.human > 0);

const humanReplyBack = buildActionMarkerReplyBackText("task-human", {
  decision_status: humanDecisionReport.marker,
  decision_next_action: humanDecisionReport.next_action,
});
assert.match(humanReplyBack, /Stop autonomous execution/);
assert.doesNotMatch(humanReplyBack, /Continue the original execution specification/);

const retrospectiveMarkerMention = classifyActionMarkerFromText([
  "Round 1: not_ready on answer_capture because Runtime.evaluate failed.",
  "The decision (continue / done / human decision required) is absent because gateway_decision was not reached.",
  "After fixing the technical failure, rerun the same soak until real decisions or an actual human decision required / verified completion boundary is reached.",
].join("\n"));
assert.equal(retrospectiveMarkerMention.signals.human, 0, "mentioning the marker name as a possible outcome must not create a human boundary");
assert.equal(retrospectiveMarkerMention.marker, "fix fail and continue");
assert.equal(retrospectiveMarkerMention.reply_back_required, true);

const retrospectiveDecisionMarker = classifyActionMarkerFromText([
  "First decision round completed: fix fail and continue.",
  "Gates run:",
  "console_typecheck → PASS",
  "Next action: retry the bounded continuation; 2 decision slots remain.",
].join("\n"));
assert.equal(retrospectiveDecisionMarker.signals.fail, 0, "a previously selected fix-fail marker is historical control-flow evidence, not a new active failure");
assert.equal(retrospectiveDecisionMarker.signals.blocker, 0, "historical decision/status lines must not reopen a blocker either");
assert.equal(retrospectiveDecisionMarker.marker, "next");

const explicitHistoricalNoActiveIssue = classifyActionMarkerFromText([
  "Status: GREEN / NEXT.",
  "source hardening excludes retrospective lines like earlier decision fix fail and continue / earlier blocked state from active issue evidence;",
  "Gate: console_typecheck → PASS",
  "Ранее встречавшиеся decision/failure формулировки являются историческим evidence; текущего active fail/blocker evidence нет. Текущее состояние — green.",
  "Next action: continue the same bounded chat.",
].join("\n"));
assert.equal(explicitHistoricalNoActiveIssue.signals.fail, 0, "explicit historical/current-no-fail language must suppress false active failure evidence");
assert.equal(explicitHistoricalNoActiveIssue.signals.blocker, 0, "explicit historical/current-no-blocker language must suppress false blocker evidence");
assert.equal(explicitHistoricalNoActiveIssue.marker, "next");

const positiveFailBlockerHardening = classifyActionMarkerFromText([
  "Status: GREEN / NEXT.",
  "The retrospective/negated fail-blocker hardening is present in the current source and regression coverage.",
  "Historical fix fail/blocked-state wording is removed from active issue evidence before classification.",
  "Current green+next evidence therefore routes to next.",
  "Gate: console_typecheck PASS.",
  "Next action: continue the bounded soak.",
].join("\n"));
assert.equal(positiveFailBlockerHardening.signals.fail, 0, "verified fail-blocker hardening must not itself count as an active fail");
assert.equal(positiveFailBlockerHardening.signals.blocker, 0, "verified fail-blocker hardening must not itself count as an active blocker");
assert.equal(positiveFailBlockerHardening.marker, "next");

const zeroIssueCounters = classifyActionMarkerFromText([
  "Status: GREEN / NEXT.",
  "Durable execution state advanced correctly: auto_iteration_count = 1, max_auto_iterations = 3, and round 1 was classified continue with fail=0, blocker=0, question=0, human=0.",
  "Gate run this round: console_typecheck → PASS.",
  "Next action: continue the same bounded READ_ONLY soak.",
].join("\n"));
assert.equal(zeroIssueCounters.signals.fail, 0, "fail=0 diagnostic counters are absence evidence, not an active fail");
assert.equal(zeroIssueCounters.signals.blocker, 0, "blocker=0 diagnostic counters are absence evidence, not an active blocker");
assert.equal(zeroIssueCounters.marker, "next");

const negatedNonFailingDiagnostic = classifyActionMarkerFromText([
  "Status: GREEN / CONTINUE.",
  "A direct npm-test connector attempt first returned infrastructure HTTP 502; rerunning through the repository gate succeeded, so there is no repository defect from that event.",
  "One non-failing diagnostic remains: Node emitted DEP0190. It did not fail the gate; under this READ_ONLY run it is only an unresolved technical finding.",
  "Next action: continue the next bounded READ_ONLY round while budget remains.",
].join("\n"));
assert.equal(negatedNonFailingDiagnostic.signals.fail, 0, "non-failing and did-not-fail diagnostics must not create active fail signals");
assert.equal(negatedNonFailingDiagnostic.signals.blocker, 0);
assert.equal(negatedNonFailingDiagnostic.marker, "next");

const mixedNegatedAndActiveIssue = classifyActionMarkerFromText([
  "The earlier diagnostic had no errors, but the current build failed with exit code 1.",
  "Historical blocker coverage is green; however current execution is blocked and cannot proceed.",
].join("\n"));
assert.ok(mixedNegatedAndActiveIssue.signals.fail > 0, "local negation must not erase an active failure in another clause");
assert.ok(mixedNegatedAndActiveIssue.signals.blocker > 0, "historical blocker wording must not erase a current blocker in another clause");
assert.equal(mixedNegatedAndActiveIssue.marker, "fix fail and continue");

const resolvedLiveFailure = classifyActionMarkerFromText([
  "Status: reported fail исправлен, verification green, worktree clean.",
  "Runtime.evaluate / answer_capture: fixed and message capture now returns MESSAGES_CAPTURED.",
  "Additional fail-closed settle hardening is complete; false settle eliminated.",
  "console_typecheck — PASS",
  "npm_test — PASS",
  "Next action: continue the remaining bounded soak budget.",
].join("\n"));
assert.equal(resolvedLiveFailure.signals.fail, 0, "resolved/retrospective failures must not remain active fail evidence");
assert.equal(resolvedLiveFailure.marker, "next");

const readOnlyReply = buildActionMarkerReplyBackText("task-read-only", {
  mutation_policy: "read_only",
  decision_status: "fix fail and continue",
  decision_next_action: "Fix the failure and create a coherent commit if files changed.",
});
assert.match(readOnlyReply, /read-only verification/i);
assert.match(readOnlyReply, /Do not modify, stage, commit, reset, clean, delete, rename, or generate repository files/i);
assert.doesNotMatch(readOnlyReply, /create a coherent commit/i);
assert.match(readOnlyReply, /no repository changes, no commit/i);

const proseQuestions = classifyActionMarkerFromText([
  "Что имеем? Stable continuation and green gates.",
  "Что осталось? Capture the next bounded assistant artifact.",
  "Gates: npm run typecheck PASS.",
  "Next action: continue the bounded soak.",
].join("\n"));
assert.equal(proseQuestions.signals.question, 0, "ordinary status-report question punctuation/headings must not become an executor decision question");
assert.equal(proseQuestions.marker, "next");

const genuineQuestion = classifyActionMarkerFromText("The implementation reaches a product fork. Which option should I choose, option 1 or option 2?");
assert.ok(genuineQuestion.signals.question > 0);

const negatedFailure = classifyActionMarkerFromText("composer qa PASS without failures. No errors. Next action: go next.");
assert.equal(negatedFailure.signals.fail, 0);
assert.equal(negatedFailure.marker, "next");

const resolvedFailure = classifyActionMarkerFromText([
  "Reported fail fixed and verification green.",
  "Workspace clean.",
  "console_smoke PASS.",
  "Next action: continue the remaining bounded soak.",
].join("\n"));
assert.equal(resolvedFailure.signals.fail, 0, "resolved failure language must not reopen a fixed fail");
assert.equal(resolvedFailure.marker, "next");

assert.equal(detectEngineMutationPolicy("Live soak only. Do not modify, stage, commit, reset, clean, or delete repository files."), "read_only");
assert.equal(detectEngineMutationPolicy("Implement the fix, run gates, and commit the result."), "write_allowed");
assert.equal(detectEngineMutationPolicy("Normalize the repository structure and edit the required files. Do not commit or push."), "write_allowed", "commit/push restrictions must not collapse a mutating task into global read-only");

const readOnlyReplyBack = buildActionMarkerReplyBackText("task-read-only", {
  mutation_policy: "read_only",
  decision_status: "next",
  decision_next_action: "Commit the next fix.",
});
assert.match(readOnlyReplyBack, /read-only verification/i);
assert.match(readOnlyReplyBack, /Repository mutation remains forbidden/);
assert.doesNotMatch(readOnlyReplyBack, /Commit the next fix/);

assert.equal(normalizeActionMarker("RED"), "fix fail and continue");
assert.equal(normalizeActionMarker("GREEN"), "continue");
assert.equal(normalizeActionMarker("CORRECT_AND_CONTINUE"), "continue");
assert.equal(normalizeActionMarker("DO_FIX"), "fix fail and continue");
assert.equal(isContinuingActionMarker("fix fail and continue"), true);
assert.equal(isContinuingActionMarker("RED"), true);
assert.equal(isTerminalActionMarker("GREEN"), false);

const replyBack = buildActionMarkerReplyBackText("task-1", {
  decision_status: failDecision.marker,
  decision_next_action: failDecision.next_action,
});
assert.match(replyBack, /^Decision: fix fail and continue\./);
assert.match(replyBack, /Commit is good\./);
