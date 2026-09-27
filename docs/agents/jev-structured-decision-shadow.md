# Jev Structured Decision Shadow

Status: implementation started

This document is the Console MCP side of the cross-repository Jev milestone. The model-control-plane milestone is materialized in:

`D:\PhpstormProjects\www\aigateway\docs\ai\AI_JEV_STRUCTURED_DECISION_MILESTONE.md`

## Scope

Console MCP keeps production orchestration authority.

Jev is introduced only as semantic shadow evidence around the existing action-marker decision path:

```text
answer_capture
  -> action-marker-router.ts       authoritative production marker
  -> Jev semantic shadow           advisory structured evidence
  -> parity telemetry
  -> existing completion verifier  authoritative terminal gate
```

No Jev response may directly authorize repository writes, Git actions, completion, or human-boundary bypass.

## Existing baseline

The current deterministic router already recognizes:

- active fail and blocker evidence;
- resolved, historical, and negated failure language;
- dirty/commit/clean/green signals;
- next-step signals;
- genuine human decision boundaries;
- explicit DONE proposals;
- capability restrictions applied during reply-back.

The existing regression corpus in `tool/action-marker-router-regression.mjs` is the seed dataset for shadow parity work.

## Shadow semantic contract

The first model request asks for semantic facts, not a final orchestration command:

- `active_failure` — Noul;
- `active_blocker` — Noul;
- `human_decision_required` — Noul;
- `task_complete_claimed` — Noul;
- `repository_progress` — Choice;
- `continuation_intent` — Choice.

The engine remains responsible for deterministic action policy.

## Runtime rules

1. Shadow mode is disabled by default until an explicit runtime switch exists.
2. Shadow transport failure must be non-blocking.
3. The deterministic router result is always recorded independently.
4. Shadow output must be bounded and persisted without prompt/response payload logging at Cloudflare.
5. Final `done` remains subject to the existing fail-closed repository completion verifier.
6. A Jev human-decision signal cannot weaken an existing deterministic human boundary.
7. Git/mutation capability guards are never delegated to Jev.

## Telemetry target

For each eligible decision, eventually persist:

```text
deterministic_marker
jev.model
jev.answers
jev.confidence / probabilities
jev.derived_shadow_marker
jev.parity
jev.latency_ms
jev.input_tokens
jev.output_tokens
jev.transport_status
```

Do not persist credentials or unrestricted repository payloads.

## Acceptance sequence

### C0 - Contract

- semantic input builder exists;
- response parser is strict;
- malformed or partial Jev output becomes `unavailable`, not an engine failure.

### C1 - Shadow transport

- invocation is behind explicit configuration;
- timeout/failure does not alter production marker;
- telemetry records parity.

### C2 - Corpus

- convert current regression cases into semantic expectations;
- require zero safety-critical false-negative cases before canary.

### C3 - Ambiguous canary

Only ambiguous semantic cases may use Jev preferentially. Explicit evidence and safety boundaries stay deterministic.

## Next implementation

1. Add semantic-contract builder/parser.
2. Compile with Console MCP TypeScript gates.
3. Add a disabled-by-default shadow transport adapter targeting the sibling `aigateway` Jev route.
4. Add event/task persistence for parity metrics.
5. Run bounded live shadow traffic.
