#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  buildActionMarkerReplyBackText,
  classifyActionMarkerFromText,
  isContinuingActionMarker,
  isTerminalActionMarker,
  normalizeActionMarker,
} from "../dist/engine/action-marker-router.js";

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

const negatedFailure = classifyActionMarkerFromText("composer qa PASS without failures. No errors. Next action: go next.");
assert.equal(negatedFailure.signals.fail, 0);
assert.equal(negatedFailure.marker, "next");

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
