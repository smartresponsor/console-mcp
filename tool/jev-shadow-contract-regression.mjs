#!/usr/bin/env node
import assert from "node:assert/strict";

import { classifyActionMarkerFromText } from "../dist/engine/action-marker-router.js";
import {
  assessJevEngineShadowResponse,
  buildJevEngineShadowInput,
} from "../dist/engine/jev-shadow-contract.js";

const report = "composer qa FAIL: phpunit failed. Workspace clean. Commit created: abcdef1.";
const deterministic = classifyActionMarkerFromText(report);
const input = buildJevEngineShadowInput(report, {
  mutation_policy: "write_allowed",
  git_commit_policy: "allowed",
  git_push_policy: "allowed",
});

assert.equal(input.state.authority, "shadow_only");
assert.equal(Object.hasOwn(input.state, "deterministic_marker"), false);
assert.equal(Object.hasOwn(input.state, "deterministic_signals"), false);
assert.equal(input.questions.active_failure.type, "noul");
assert.equal(input.questions.repository_progress.type, "choice");

const direct = assessJevEngineShadowResponse({
  model: "jev-1.13.0",
  answers: {
    active_failure: { type: "noul", noul: 0.99 },
    active_blocker: { type: "noul", noul: 0.03 },
    human_decision_required: { type: "noul", noul: 0.01 },
    task_complete_claimed: { type: "noul", noul: 0.01 },
    repository_progress: {
      type: "choice",
      choice: "commit_created",
      confidence: 0.98,
      probabilities: { none: 0, diff_created: 0.01, commit_created: 0.98, verified_green: 0.01 }
    },
    continuation_intent: {
      type: "choice",
      choice: "continue",
      confidence: 0.99,
      probabilities: { continue: 0.99, next: 0, recheck: 0.01, finish: 0 }
    }
  },
  usage: { input_tokens: 420, output_tokens: 50 }
}, deterministic.marker);

assert.equal(direct.ok, true);
assert.equal(direct.derivedMarker, "fix fail and continue");
assert.equal(direct.parity, true);
assert.equal(direct.usage.inputTokens, 420);

const enveloped = assessJevEngineShadowResponse({
  result: {
    model: "jev-1.13.0",
    answers: {
      active_failure: { type: "noul", noul: 0.01 },
      active_blocker: { type: "noul", noul: 0.01 },
      human_decision_required: { type: "noul", noul: 0.98 },
      task_complete_claimed: { type: "noul", noul: 0.01 },
      repository_progress: { type: "choice", choice: "none" },
      continuation_intent: { type: "choice", choice: "recheck" }
    }
  }
}, "human decision required");

assert.equal(enveloped.ok, true);
assert.equal(enveloped.derivedMarker, "human decision required");
assert.equal(enveloped.parity, true);

const liveCloudflareEnvelope = assessJevEngineShadowResponse({
  result: {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: {
        active_failure: { type: "noul", noul: 0.87 },
        active_blocker: { type: "noul", noul: 0.61 },
        human_decision_required: { type: "noul", noul: 0.4 },
        task_complete_claimed: { type: "noul", noul: 0.01 },
        repository_progress: { type: "choice", choice: "commit_created", confidence: 1, probabilities: { none: 0, verified_green: 0, diff_created: 0, commit_created: 1 } },
        continuation_intent: { type: "choice", choice: "continue", confidence: 0.9, probabilities: { continue: 0.9, next: 0.05, recheck: 0.05, finish: 0 } },
      },
      usage: { input_tokens: 603, output_tokens: 106 },
    },
    gatewayMetadata: { keySource: "Unified" },
  },
  success: true,
  errors: [],
  messages: [],
}, "fix fail and continue");

assert.equal(liveCloudflareEnvelope.ok, true);
assert.equal(liveCloudflareEnvelope.model, "jev-1.13.0");
assert.equal(liveCloudflareEnvelope.derivedMarker, "fix fail and continue");
assert.equal(liveCloudflareEnvelope.parity, true);
assert.equal(liveCloudflareEnvelope.usage.inputTokens, 603);
assert.equal(liveCloudflareEnvelope.usage.outputTokens, 106);

const lowConfidenceContinuation = assessJevEngineShadowResponse({
  model: "jev-1.13.0",
  answers: {
    active_failure: { type: "noul", noul: 0.04 },
    active_blocker: { type: "noul", noul: 0.09 },
    human_decision_required: { type: "noul", noul: 0.37 },
    task_complete_claimed: { type: "noul", noul: 0.23 },
    repository_progress: { type: "choice", choice: "verified_green", confidence: 0.96 },
    continuation_intent: { type: "choice", choice: "next", confidence: 0.36 },
  },
}, "continue");

assert.equal(lowConfidenceContinuation.ok, true);
assert.equal(lowConfidenceContinuation.derivedMarker, null);
assert.equal(lowConfidenceContinuation.parity, null);
assert.equal(lowConfidenceContinuation.abstained, true);
assert.match(lowConfidenceContinuation.abstentionReason ?? "", /0\.75/);
assert.equal(lowConfidenceContinuation.confidence?.continuationIntent, 0.36);

const weakHumanWithActiveFailure = assessJevEngineShadowResponse({
  model: "jev-1.13.0",
  answers: {
    active_failure: { type: "noul", noul: 0.97 },
    active_blocker: { type: "noul", noul: 0.94 },
    human_decision_required: { type: "noul", noul: 0.53 },
    task_complete_claimed: { type: "noul", noul: 0.03 },
    repository_progress: { type: "choice", choice: "none", confidence: 0.92 },
    continuation_intent: { type: "choice", choice: "recheck", confidence: 0.92 },
  },
}, "fix fail and continue");

assert.equal(weakHumanWithActiveFailure.ok, true);
assert.equal(weakHumanWithActiveFailure.derivedMarker, "fix fail and continue");
assert.equal(weakHumanWithActiveFailure.parity, true);
assert.equal(weakHumanWithActiveFailure.abstained, false);

const explicitHumanBoundaryOverride = assessJevEngineShadowResponse({
  model: "jev-1.13.0",
  answers: {
    active_failure: { type: "noul", noul: 0.07 },
    active_blocker: { type: "noul", noul: 0.91 },
    human_decision_required: { type: "noul", noul: 0.52 },
    task_complete_claimed: { type: "noul", noul: 0.03 },
    repository_progress: { type: "choice", choice: "none", confidence: 1 },
    continuation_intent: { type: "choice", choice: "recheck", confidence: 0.85 },
  },
}, "human decision required");

assert.equal(explicitHumanBoundaryOverride.ok, true);
assert.equal(explicitHumanBoundaryOverride.derivedMarker, null);
assert.equal(explicitHumanBoundaryOverride.parity, null);
assert.equal(explicitHumanBoundaryOverride.abstained, true);
assert.match(explicitHumanBoundaryOverride.abstentionReason ?? "", /remains authoritative/);

const blockerWithEquivocalFailure = assessJevEngineShadowResponse({
  model: "jev-1.13.0",
  answers: {
    active_failure: { type: "noul", noul: 0.5 },
    active_blocker: { type: "noul", noul: 0.96 },
    human_decision_required: { type: "noul", noul: 0.32 },
    task_complete_claimed: { type: "noul", noul: 0.04 },
    repository_progress: { type: "choice", choice: "verified_green", confidence: 0.72 },
    continuation_intent: { type: "choice", choice: "continue", confidence: 0.19 },
  },
}, "fix blocker and continue");

assert.equal(blockerWithEquivocalFailure.ok, true);
assert.equal(blockerWithEquivocalFailure.derivedMarker, "fix blocker and continue");
assert.equal(blockerWithEquivocalFailure.parity, true);
assert.equal(blockerWithEquivocalFailure.abstained, false);

const malformed = assessJevEngineShadowResponse({ answers: {} }, "continue");
assert.equal(malformed.ok, false);
assert.equal(malformed.derivedMarker, null);
assert.equal(malformed.parity, null);

console.log("jev-shadow-contract-regression: ok");
