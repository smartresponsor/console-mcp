#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const ledger = JSON.parse(await readFile(new URL("./fixture/jev-challenger-adjudicated.json", import.meta.url), "utf8"));
const adjudicated = ledger.cases.filter((item) => item.adjudication_status === "adjudicated" && typeof item.truth_marker === "string");
const taskIds = adjudicated.map((item) => item.task_id);
const uniqueTaskIds = new Set(taskIds.filter((id) => typeof id === "string" && id.length > 0));
const invalidTaskIds = taskIds.length - uniqueTaskIds.size;
const uniqueTaskGateOk = invalidTaskIds === 0;

let routerCorrect = 0;
let jevDirect = 0;
let jevCorrect = 0;
let jevWrong = 0;
let jevAbstained = 0;

const rows = adjudicated.map((item) => {
  const routerParity = item.router_marker === item.truth_marker;
  if (routerParity) routerCorrect += 1;

  let jevVerdict = "abstain";
  if (item.jev_abstained === true || item.jev_marker === null) {
    jevAbstained += 1;
  } else {
    jevDirect += 1;
    if (item.jev_marker === item.truth_marker) {
      jevCorrect += 1;
      jevVerdict = "correct";
    } else {
      jevWrong += 1;
      jevVerdict = "wrong";
    }
  }

  return {
    name: item.name,
    task_id: item.task_id,
    truth_marker: item.truth_marker,
    router_marker: item.router_marker,
    router_correct: routerParity,
    jev_marker: item.jev_marker,
    jev_verdict: jevVerdict,
  };
});

const coverage = adjudicated.length === 0 ? 0 : jevDirect / adjudicated.length;
const gateOk = jevWrong === 0 && uniqueTaskGateOk;
const promotionReady = gateOk && adjudicated.length >= 100 && coverage >= 0.8;
const promotionBlockers = [];
if (adjudicated.length < 100) promotionBlockers.push(`adjudicated cases ${adjudicated.length}/100`);
if (coverage < 0.8) promotionBlockers.push(`direct coverage ${coverage.toFixed(4)} < 0.8000`);
if (jevWrong > 0) promotionBlockers.push(`wrong promoted markers ${jevWrong}`);
if (!uniqueTaskGateOk) promotionBlockers.push(`duplicate or missing adjudicated task IDs ${invalidTaskIds}`);

console.log(JSON.stringify({
  ok: gateOk,
  status: !gateOk
    ? (!uniqueTaskGateOk ? "JEV_CHALLENGER_NON_UNIQUE_TASK_IDS" : "JEV_CHALLENGER_WRONG_PROMOTED_MARKER")
    : promotionReady
      ? "JEV_CHALLENGER_PROMOTION_GATES_SATISFIED"
      : "JEV_CHALLENGER_ADJUDICATION_GREEN_NOT_PROMOTION_READY",
  promotion_ready: promotionReady,
  promotion_blockers: promotionBlockers,
  promotion_requirements: {
    minimum_adjudicated_cases: 100,
    minimum_direct_coverage: 0.8,
    maximum_wrong_promoted_markers: 0,
  },
  semantic_contract_version: ledger.semantic_contract_version,
  adjudicated_cases: adjudicated.length,
  unique_adjudicated_tasks: uniqueTaskIds.size,
  duplicate_or_missing_task_ids: invalidTaskIds,
  pending_cases: ledger.cases.length - adjudicated.length,
  router: {
    correct: routerCorrect,
    wrong: adjudicated.length - routerCorrect,
    accuracy: adjudicated.length === 0 ? null : Number((routerCorrect / adjudicated.length).toFixed(4)),
  },
  jev: {
    direct: jevDirect,
    correct: jevCorrect,
    wrong_promoted: jevWrong,
    abstained: jevAbstained,
    direct_accuracy: jevDirect === 0 ? null : Number((jevCorrect / jevDirect).toFixed(4)),
    coverage: adjudicated.length === 0 ? null : Number((jevDirect / adjudicated.length).toFixed(4)),
  },
  rows,
}, null, 2));

if (!gateOk) process.exitCode = 1;
