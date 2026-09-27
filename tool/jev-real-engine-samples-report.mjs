#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { classifyActionMarkerFromText } from "../dist/engine/action-marker-router.js";
import { assessJevEngineShadowResponse } from "../dist/engine/jev-shadow-contract.js";

const fixture = JSON.parse(await readFile(new URL("./fixture/jev-real-engine-samples.json", import.meta.url), "utf8"));

const rows = fixture.cases.map((item) => {
  const deterministic = classifyActionMarkerFromText(item.text);
  const j = item.jev;
  const assessment = assessJevEngineShadowResponse({
    model: fixture.model,
    answers: {
      active_failure: { type: "noul", noul: j.active_failure },
      active_blocker: { type: "noul", noul: j.active_blocker },
      human_decision_required: { type: "noul", noul: j.human_decision_required },
      task_complete_claimed: { type: "noul", noul: j.task_complete_claimed },
      repository_progress: { type: "choice", choice: j.repository_progress.choice, confidence: j.repository_progress.confidence },
      continuation_intent: { type: "choice", choice: j.continuation_intent.choice, confidence: j.continuation_intent.confidence },
    },
  }, deterministic.marker);

  return {
    name: item.name,
    task_id: item.task_id,
    ready_to_delete: item.ready_to_delete,
    deterministic_marker: deterministic.marker,
    deterministic_confidence: deterministic.confidence,
    deterministic_signals: deterministic.signals,
    jev_derived_marker: assessment.derivedMarker,
    jev_abstained: assessment.abstained,
    jev_parity_with_router: assessment.parity,
    jev_confidence: assessment.confidence,
    jev_facts: assessment.facts,
  };
});

console.log(JSON.stringify({ ok: true, status: "JEV_REAL_ENGINE_SAMPLE_REPORT", cases: rows }, null, 2));
