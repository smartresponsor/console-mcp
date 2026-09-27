# Jev J2 Historical Evaluation Checkpoint - 2026-09-26

Status: active; promotion to authoritative/canary routing is BLOCKED pending larger real-history evaluation.

## Canonical runtime

- Console MCP: `D:\PhpstormProjects\www\mcp\console-mcp`
- AI Gateway: `D:\PhpstormProjects\www\mcp\aigateway`
- Model: `typesafe/jev`
- Semantic contract: independent shadow v2

## Important methodology rule

Jev must not receive the deterministic marker or deterministic router signals as model input.

The model sees bounded executor evidence plus non-answer policy metadata only. Deterministic routing is used after inference for parity comparison and remains production-authoritative.

This avoids target leakage in shadow evaluation.

## Historical data availability

The canonical Engine event log currently contains:

- 16,070+ durable events;
- 189 paired `executor_answer_captured -> engine_decision_recorded` historical decisions;
- zero JSONL parse errors in extraction;
- average captured-answer length about 1,289 characters.

Historical normalized marker distribution:

- continue: 23
- human decision required: 3
- fix fail and continue: 41
- recheck and continue: 57
- fix blocker and continue: 40
- next: 10
- commit and continue: 6
- fix fail, commit and continue: 8
- done: 1

Current-router replay distribution on the same historical answers:

- recheck and continue: 58
- continue: 23
- fix fail and continue: 35
- fix blocker and continue: 40
- next: 17
- commit and continue: 6
- fix fail, commit and continue: 8
- done: 2

Historical marker vs current-router replay drift:

- 23 / 189
- 12.17%

Therefore old historical markers are evidence, not present-day ground truth. J2 evaluation uses the current router replay as the current production baseline while preserving the original marker for drift analysis.

## Executable infrastructure

Implemented:

- `tool/jev-shadow-history-extract.mjs`
- `tool/jev-shadow-history-extract.ps1`
- named gate `console_jev_shadow_history_extract`
- compact `--summary-only` mode
- balanced `--sample-per-marker` sampling
- `--only-marker`
- `--prioritize`
- optional ledger exclusion
- current-router replay
- legacy marker normalization
- historical drift metrics

The extraction gate validates the complete historical JSONL through the read-only repository gate.

## Jev evaluation tools

Implemented:

- `console.read_.ai.gateway.jev.evaluate`
- `console.read_.ai.gateway.jev.evaluate_batch` (up to 20 cases, bounded concurrency 1-4)
- `console.read_.engine.jev.history.evaluate`

The history evaluator:

1. reads canonical Engine event history;
2. pairs captured answers with decisions;
3. replays the current deterministic router;
4. selects balanced semantic-marker samples;
5. sends independent semantic state to Jev;
6. applies semantic-contract v2;
7. reports parity, mismatch, abstention, failure, direct coverage, direct accuracy, p50/p95 latency, and token totals;
8. never mutates Engine task state.

## Synthetic / executable corpus

Current fixed corpus:

- 11 cases
- direct Jev decisions: 6
- abstentions: 5
- incorrect promoted markers: 0
- direct coverage: 54.55%
- gate: `console_jev_shadow_corpus` PASS

The reduction from earlier 63.64% coverage is intentional: semantic-contract v2 tightened failure semantics and increased safe abstention.

## Real-history observations

Small manually replayed real-history samples showed:

- current-router `next` -> Jev `next`: direct parity;
- current-router `continue` -> Jev abstain because continuation confidence was 0.41;
- current-router `done` -> Jev abstain because continuation confidence was 0.60;
- some current-router fail/blocker/recheck historical cases produced non-parity Jev semantic classifications.

These non-parity cases are the reason promotion remains blocked.

They must not be “fixed” by feeding the router answer back to Jev.

## Semantic-policy separation

A concrete real Retailing case demonstrates why the semantic layer and orchestration policy are not identical:

- current deterministic orchestration marker: `fix fail and continue`;
- semantic-contract v2 interpretation: `fix blocker and continue`;
- reason: execution was prevented by an infrastructure/runtime blocker before a trustworthy Symfony check actually ran.

The fixed corpus records both:

- `expected_marker`: current deterministic orchestration policy;
- `semantic_expected_marker`: semantic truth expected from Jev.

This prevents false parity requirements when policy intentionally folds semantic categories together.

## Current provisional shadow thresholds

Evaluation-only:

- human-decision Noul >= 0.60
- active-failure Noul >= 0.60
- active-blocker Noul >= 0.50
- continuation choice confidence >= 0.75, otherwise abstain

These are not production promotion thresholds.

## Promotion contract

Do not promote Jev to authoritative routing until at least:

1. 100 representative real historical or live-shadow decisions have been evaluated under independent semantic-contract v2;
2. zero safety-critical false-negative promoted markers;
3. zero false-completion promoted markers;
4. mismatches are classified into model error vs semantic/policy category difference;
5. direct coverage and abstention rate are reported separately;
6. p50/p95 end-to-end latency and token usage are measured;
7. human-decision threshold has multiple real positive cases;
8. deterministic fallback remains immediate on abstain, timeout, malformed response, or provider failure;
9. final completion verification, mutation policy, Git policy, and explicit authorization remain deterministic;
10. promotion remains reversible by one configuration change.

## Current green gates

- console_typecheck
- console_build
- console_schema_validate
- console_jev_shadow_contract
- console_jev_shadow_corpus
- console_jev_shadow_history_extract
- git_diff_check

## Exact next step

After the next connector schema refresh, invoke:

`console.read_.engine.jev.history.evaluate`

Start with:

- samplePerMarker: 3
- maxCases: 20
- concurrency: 2
- timeoutMs: 20000

Then expand toward 100 cases only after inspecting the mismatch taxonomy from that first automated historical batch.

Do not enable authoritative or ambiguous-zone canary routing yet.
