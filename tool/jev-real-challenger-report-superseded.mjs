#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { classifyActionMarkerFromText } from "../dist/engine/action-marker-router.js";
import { deriveJevSemanticMarker } from "../dist/engine/jev-shadow-contract.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixture/jev-real-challenger-corpus.json", import.meta.url), "utf8"),
);

const metrics = {
  total: 0,
  resolved: 0,
  pending: 0,
  router_correct: 0,
  router_wrong: 0,
  jev_direct_correct: 0,
  jev_wrong_promoted: 0,
  jev_abstained: 0,
};

const rows = [];

for (const item of fixture.cases) {
  metrics.total += 1;

  const router = classifyActionMarkerFromText(item.text);
  const facts = {
    activeFailure: item.jev.active_failure,
    activeBlocker: item.jev.active_blocker,
    humanDecisionRequired: item.jev.human_decision_required,
    taskCompleteClaimed: item.jev.task_complete_claimed,
    repositoryProgress: item.jev.repository_progress.choice,
    continuationIntent: item.jev.continuation_intent.choice,
  };
  const confidence = {
    repositoryProgress: item.jev.repository_progress.confidence,
    continuationIntent: item.jev.continuation_intent.confidence,
  };
  const jev = deriveJevSemanticMarker(facts, confidence);

  const resolved = item.adjudication_status === "resolved"
    && typeof item.adjudicated_semantic_marker === "string";

  if (resolved) {
    metrics.resolved += 1;
    if (router.marker === item.adjudicated_semantic_marker) metrics.router_correct += 1;
    else metrics.router_wrong += 1;

    if (jev.marker === null) {
      metrics.jev_abstained += 1;
    } else if (jev.marker === item.adjudicated_semantic_marker) {
      metrics.jev_direct_correct += 1;
    } else {
      metrics.jev_wrong_promoted += 1;
    }
  } else {
    metrics.pending += 1;
  }

  rows.push({
    name: item.name,
    task_id: item.task_id,
    adjudication_status: item.adjudication_status,
    expected: item.adjudicated_semantic_marker,
    router_marker: router.marker,
    router_confidence: router.confidence,
    jev_marker: jev.marker,
    jev_abstained: jev.marker === null,
    jev_abstention_reason: jev.reason,
    jev_facts: facts,
    jev_confidence: confidence,
    evidence_summary: item.evidence_summary,
  });
}

const resolvedDenominator = metrics.resolved || 1;
const direct = metrics.jev_direct_correct + metrics.jev_wrong_promoted;
const output = {
  ok: metrics.jev_wrong_promoted === 0,
  status: metrics.jev_wrong_promoted === 0
    ? "JEV_REAL_CHALLENGER_CORPUS_GREEN"
    : "JEV_REAL_CHALLENGER_WRONG_PROMOTED_MARKER",
  metrics: {
    ...metrics,
    router_accuracy_on_resolved: Number((metrics.router_correct / resolvedDenominator).toFixed(4)),
    jev_direct_accuracy_on_resolved: direct === 0
      ? null
      : Number((metrics.jev_direct_correct / direct).toFixed(4)),
    jev_direct_coverage_on_resolved: Number((direct / resolvedDenominator).toFixed(4)),
    jev_abstention_rate_on_resolved: Number((metrics.jev_abstained / resolvedDenominator).toFixed(4)),
  },
  cases: rows,
};

console.log(JSON.stringify(output, null, 2));

if (!output.ok) {
  process.exitCode = 1;
}
