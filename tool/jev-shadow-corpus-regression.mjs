#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { classifyActionMarkerFromText } from "../dist/engine/action-marker-router.js";
import { assessJevEngineShadowResponse } from "../dist/engine/jev-shadow-contract.js";

const corpusUrl = new URL("./fixture/jev-shadow-corpus.json", import.meta.url);
const corpus = JSON.parse(await readFile(corpusUrl, "utf8"));

let direct = 0;
let abstained = 0;
let wrong = 0;

for (const item of corpus.cases) {
  const deterministic = classifyActionMarkerFromText(item.text);
  assert.equal(
    deterministic.marker,
    item.expected_marker,
    `${item.name}: deterministic baseline drifted`,
  );

  const semanticExpected = item.semantic_expected_marker ?? item.expected_marker;
  const observed = item.jev;
  const response = {
    model: corpus.model,
    answers: {
      active_failure: { type: "noul", noul: observed.active_failure },
      active_blocker: { type: "noul", noul: observed.active_blocker },
      human_decision_required: { type: "noul", noul: observed.human_decision_required },
      task_complete_claimed: { type: "noul", noul: observed.task_complete_claimed },
      repository_progress: {
        type: "choice",
        choice: observed.repository_progress.choice,
        confidence: observed.repository_progress.confidence,
      },
      continuation_intent: {
        type: "choice",
        choice: observed.continuation_intent.choice,
        confidence: observed.continuation_intent.confidence,
      },
    },
  };

  const assessment = assessJevEngineShadowResponse(response, semanticExpected);
  assert.equal(assessment.ok, true, `${item.name}: Jev fixture did not parse`);

  if (assessment.abstained) {
    abstained += 1;
    assert.equal(assessment.derivedMarker, null, `${item.name}: abstention must not expose a marker`);
    assert.equal(assessment.parity, null, `${item.name}: abstention parity must be null`);
    continue;
  }

  direct += 1;
  if (assessment.derivedMarker !== semanticExpected) {
    wrong += 1;
  }
  assert.equal(
    assessment.derivedMarker,
    semanticExpected,
    `${item.name}: Jev promoted an incorrect shadow marker`,
  );
  assert.equal(assessment.parity, true, `${item.name}: direct Jev fixture must have parity`);
}

assert.equal(wrong, 0, "Corpus must contain zero incorrect promoted Jev markers.");
assert.ok(direct > 0, "Corpus must contain direct Jev decisions.");
assert.ok(abstained > 0, "Corpus must exercise Jev abstention.");

console.log(JSON.stringify({
  ok: true,
  status: "JEV_SHADOW_CORPUS_GREEN",
  cases: corpus.cases.length,
  direct,
  abstained,
  wrong_promoted: wrong,
  coverage: Number((direct / corpus.cases.length).toFixed(4)),
}));
