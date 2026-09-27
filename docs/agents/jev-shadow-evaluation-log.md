# Jev Shadow Evaluation Log

This file records bounded shadow evidence for the Console MCP decision path.

Production decisions remain deterministic unless a later milestone explicitly promotes a bounded Jev canary.

## Sample 001 - synthetic transport canary

Date: 2026-09-26

Input shape:

- explicit current QA failure;
- workspace clean;
- commit explicitly present.

Observed:

- model: `jev-1.13.0`;
- full Ask-wrapper duration: about 5.8 seconds;
- usage: 603 input / 106 output tokens;
- active failure: 0.87;
- active blocker: 0.61;
- human decision required: 0.40;
- repository progress: `commit_created`, confidence 1.0.

Purpose:

- prove live Cloudflare `/ai/run` transport;
- capture actual `result.result` response envelope;
- seed parser regression.

## Sample 002 - real Engine decision: Retailing

Task:

`engine-20260926081214-retailing-31f48e`

Captured answer:

- real executor answer from `executor_answer_captured`;
- approximately 2.5k characters;
- reports unresolved Console MCP execution failure while preserving existing repository work;
- task remains incomplete.

Deterministic baseline:

- marker: `fix fail and continue`;
- confidence: 0.92;
- signals: fail=1, blocker=1, gate=1, green=1.

Jev shadow replay:

- model: `jev-1.13.0`;
- derived marker: `fix fail and continue`;
- parity: TRUE;
- full Ask-wrapper duration: about 8.4 seconds;
- usage: 1835 input / 176 output tokens;
- active failure: 0.96;
- active blocker: 0.96;
- human decision required: 0.29;
- task complete claimed: 0.02;
- repository progress: `diff_created`;
- repository progress confidence: 0.49;
- continuation intent: `recheck`;
- continuation intent confidence: 0.73.

Interpretation:

The production marker matches Jev on the primary safety classification. Lower confidence around repository progress is reasonable because the executor report discusses several repositories and existing commits/dirty paths rather than one simple worktree state.

## Runtime shadow-state evidence

A real `engine_decision_recorded` event after J1 wiring contains:

```json
{
  "jev_shadow": {
    "enabled": false,
    "attempted": false,
    "status": "disabled",
    "error": null
  }
}
```

This confirms the new telemetry field is present while the model call remains disabled by default.

## Corpus expansion target

Prefer real historical Engine decisions with durable captured answers and deterministic markers.

For every sample record:

- task id;
- deterministic marker and confidence;
- Jev model/version;
- Jev semantic answers;
- derived marker;
- parity;
- duration;
- input/output usage;
- disagreement notes.

Do not promote Jev from shadow based on aggregate accuracy alone. Separately track safety-critical false negatives, especially:

- missed active failure;
- missed blocker;
- false completion;
- missed human decision boundary.

## Balanced regression batch - 10 cases

The first balanced Jev replay batch reused texts already present in `tool/action-marker-router-regression.mjs`.

Initial raw result before abstention calibration:

- direct parity: 6 / 10;
- raw mismatches: 4 / 10;
- two mismatches were low-confidence `continue` vs `next` distinctions with continuation confidence 0.36 and 0.34;
- one historical-control-flow case had continuation confidence 0.67;
- one genuine question produced a weak human-decision score of 0.51;
- one active failure produced a weak false-positive human-decision score of 0.53 despite active-failure=0.97 and blocker=0.94.

Shadow-only calibration derived from this batch:

- continuation intent requires confidence >= 0.75 before it may produce a shadow marker;
- otherwise Jev abstains and deterministic routing remains authoritative;
- human-decision Noul threshold is provisionally 0.60 rather than 0.50;
- observed genuine human-boundary fixture scored 0.65;
- the 0.60 and 0.75 values are evaluation thresholds only, not production promotion thresholds.

After applying those shadow rules to the observed batch:

- direct correct markers: 6 / 10;
- abstentions: 4 / 10;
- incorrect promoted shadow markers: 0 / 10;
- direct decision coverage: 60%;
- safety-critical false-negative evidence observed in this small batch: none.

Cases with direct parity included green/next, explicit completion, explicit human decision, negated failure, dirty active failure, and mixed active failure. Low-confidence local-green/resolved/historical/question cases now fall back instead of forcing a Jev marker.

This batch is far too small to justify a canary. It only establishes the initial abstention semantics and provides concrete regression values.

## Semantic contract v2 checkpoint

The executable blocking corpus is now refreshed to semantic contract version `2`.

Current gate result:

- cases: 11;
- direct decisions: 6;
- abstentions: 5;
- incorrect promoted markers: 0;
- direct coverage: 54.55%;
- explicit deterministic terminal boundaries override conflicting Jev classifications by forcing shadow abstention;
- the lower coverage versus the earlier contract is intentional: v2 is stricter about failure vs blocker and avoids forcing ambiguous continuation decisions.

A read-only historical candidate collector now finds 138 Engine tasks with durable captured answers. Current category counts are 28 ready-to-delete, 31 failure, 28 blocker, 16 continue, 9 next, and 26 recheck. This is sufficient source material for the provisional 100-case real challenger target without inventing synthetic data.

The paired-history extractor independently finds 188 capture→decision pairs across 16,033 Engine events. Of those, 23 pairs (12.23%) have a different marker under the current deterministic router than the marker recorded when the decision originally ran. This historical drift is an additional reason to keep router parity as a diagnostic metric only rather than treating it as adjudicated truth.

## Real Engine challenger findings

Three additional real Engine reports were replayed after tightening the semantic questions around executed failures, runtime blockers, and genuine human authority boundaries.

### Merchandising

- deterministic router: `continue`;
- Jev: `done` candidate;
- captured report: explicit Russian-language RC completion, all major gates green, commits pushed, branch synchronized, `ready_to_delete=true`;
- later repository inspection: `master` is synchronized with `origin/master`; the only dirty path is the pre-existing `.gating/README.md` intentionally excluded from the task-owned commits.

Interpretation: this is a strong example where regex parity is not ground truth. The deterministic router does not recognize the Russian completion language, while Jev captures the completion claim. Final completion verification must still remain authoritative.

### Cruding

- deterministic router: `continue`;
- initial Jev contract incorrectly scored active failure at 0.94;
- after refining the failure/blocker distinction: active failure fell to 0.21 and active blocker rose to 0.91;
- Jev derived marker: `fix blocker and continue`;
- captured report explicitly says required heavy checks were not executed because runtime capacity refused them and RC is not complete.

Interpretation: the refined semantic contract is materially better here. A check that could not run because of capacity is a blocker, not a failing gate.

### Attaching

- deterministic router: `fix blocker and continue`;
- Jev: `human decision required` with human-boundary score 0.73;
- captured report says the task-owned fix is green and published, but pre-existing dirty changes require a separate ownership/policy decision before claiming repository-wide closure;
- later repository inspection is clean and synchronized, so the historical boundary was subsequently resolved.

Interpretation: this case requires adjudication. Jev may be correctly identifying an ownership boundary, or it may be over-escalating a technically resolvable pre-existing-work reconciliation problem. Do not use deterministic parity as the answer.

## Evaluation methodology correction

From this point forward, maintain two distinct datasets:

1. **Regression parity corpus** — synthetic/canonical cases where the deterministic router behavior is intentionally part of the contract. This corpus protects known semantics and abstention behavior.
2. **Real challenger corpus** — historical/live Engine cases scored against adjudicated factual outcomes and repository evidence. Deterministic router and Jev are both challengers against that truth; neither is automatically the label.

Promotion metrics must be reported against adjudicated truth for the real challenger corpus. Router parity is a diagnostic metric only.

## Historical re-baseline and adjudicated challenger checkpoint

The historical extraction path now reads the canonical Engine event log, pairs captured answers with decision events, re-baselines every answer through the **current** deterministic router, and can exclude tasks already present in the canonical adjudication ledger.

Observed history:

- paired historical decisions: 187+ (the live log continues growing);
- historical marker drift against the current router is about 12%;
- historical labels are therefore diagnostic metadata, not truth;
- queue sampling is balanced by the current router marker;
- prioritized queue selection favors marker drift, terminal candidates, blocker/failure cases, ready-to-delete evidence, and high-confidence decisions.

Canonical adjudication ledger:

`tool/fixture/jev-challenger-adjudicated.json`

Current blocking adjudication gate:

- adjudicated cases: 9;
- pending cases: 1;
- deterministic router correct: 4/9;
- Jev direct decisions: 8;
- Jev direct correct: 8;
- Jev abstentions: 1;
- Jev wrong promoted markers: 0;
- Jev direct coverage: 88.89%;
- promotion readiness: FALSE;
- current promotion blocker: adjudicated corpus is 9/100.

These are early engineering calibration values only, not a general model-quality claim.

Resolved challenger disagreements now include:

- Russian-language completion reports where regex routing returns `continue` but evidence supports a `done` candidate;
- runtime-capacity cases where required checks did not execute, which are blockers rather than executed gate failures;
- lexical false positives where `blocked` appears only inside documentation of what an audit would report if a condition were absent;
- empty-repository/status-report cases where no gate failed and the correct semantic action is the next initialization phase;
- an older historical `NEEDS_USER` decision whose evidence actually contains a concrete Runtime.evaluate syntax failure and no human authority boundary.

The real challenger gate now distinguishes **gate correctness** from **promotion readiness**. It fails on any wrong promoted Jev marker in resolved cases, while insufficient corpus size is reported as a promotion blocker without making the evaluation gate itself fail.

## Next sample target

Collect a balanced set rather than only failure cases:

1. active failure;
2. active blocker without explicit failure;
3. green/next;
4. completion proposal;
5. human-decision boundary;
6. resolved/historical failure;
7. negated failure.
