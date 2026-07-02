# ChatGPT Run-Loop Orchestration

This document defines the controlled ChatGPT run-loop contract for the console MCP browser orchestration layer.

## Scope

The run-loop tools coordinate observation and pre-ASK readiness checks for a supervised ChatGPT browser tab.

The layer is intentionally controlled, not autonomous. It must never become a hidden daemon or background loop.

## Canonical tools

Use only these canonical tool names for this slice:

- `console.read_.browser.chatgpt.watch.probe`
- `console.read_.browser.chatgpt.watch.next`
- `console.read_.browser.chatgpt.implementation.pre_ask.capture`
- `console.read_.browser.chatgpt.run.loop.plan`
- `console.read_.browser.chatgpt.run.loop.step`
- `console.read_.browser.chatgpt.run.loop.step.summary`

Do not introduce short aliases or informal names for these tools.

## Controlled step contract

`console.read_.browser.chatgpt.run.loop.step` performs exactly one orchestration step.

It may call:

1. `console.read_.browser.chatgpt.watch.probe`
2. `console.read_.browser.chatgpt.run.loop.plan`
3. `console.read_.browser.chatgpt.implementation.pre_ask.capture` only when the plan returns `RUN_PRE_ASK_CAPTURE` and `executePreAsk` is true.

It must not:

- sleep or wait for a future probe window;
- run a recursive or unbounded loop;
- submit a prompt to ChatGPT;
- mutate the browser DOM;
- draft or send return material to ChatGPT;
- run as a background daemon.

The step result must include a compact top-level `summary` before large nested payloads. The summary exists to keep runtime checks readable when connector rendering collapses nested JSON.

The summary must include:

- `summary.tool`
- `summary.status`
- `summary.next_action`
- `summary.watch_status`
- `summary.watch_decision_status`
- `summary.plan_status`
- `summary.plan_next_action`
- `summary.pre_ask_status`
- `summary.executed_watch_probe`
- `summary.executed_pre_ask_capture`
- `summary.prompt_submit`
- `summary.sleep`
- `summary.safe_to_continue`
- `summary.canonical_next_tool`

## Compact summary contract

`console.read_.browser.chatgpt.run.loop.step.summary` performs the same single controlled orchestration step as `console.read_.browser.chatgpt.run.loop.step`, but returns only compact observability fields.

It may call the same internal read-only sequence:

1. `console.read_.browser.chatgpt.watch.probe`
2. `console.read_.browser.chatgpt.run.loop.plan`
3. `console.read_.browser.chatgpt.implementation.pre_ask.capture` only when the plan returns `RUN_PRE_ASK_CAPTURE` and `executePreAsk` is true.

It must not:

- sleep or wait for a future probe window;
- run a recursive or unbounded loop;
- submit a prompt to ChatGPT;
- mutate the browser DOM;
- draft or send return material to ChatGPT;
- run as a background daemon.

The compact result must include only `ok`, `status`, `next_action`, `summary`, and `policy`. It must not include large nested `watch`, `plan`, or `pre_ask` payloads.

## State transitions

### Active answer

When `console.read_.browser.chatgpt.watch.probe` observes an active answer and `console.read_.browser.chatgpt.run.loop.plan` returns `WAIT_AND_PROBE`, the controlled step must return:

- `summary.next_action: WAIT_AND_PROBE`
- `summary.executed_watch_probe: true`
- `summary.executed_pre_ask_capture: false`
- `summary.prompt_submit: false`
- `summary.sleep: false`
- `summary.canonical_next_tool: console.read_.browser.chatgpt.watch.probe`

### Ready for pre-ASK

When the plan returns `RUN_PRE_ASK_CAPTURE`, the controlled step may run `console.read_.browser.chatgpt.implementation.pre_ask.capture` if `executePreAsk` is true and the required repository inputs are present.

The controlled step still must not draft, send, sleep, or loop.

### Ready to return to ChatGPT

`RETURN_TO_CHAT` is only a recommendation. It must not imply automatic prompt draft or prompt submit.

Any future return path must be implemented as a separate confirm-gated browser write tool, not as part of `console.read_.browser.chatgpt.run.loop.step`.

### Stop states

The plan must stop for user or operator action on transport, binding, timeout, hung-stream, or max-iteration conditions. The controlled step must surface these conditions without trying to recover by reloading or submitting browser actions.

## RC regression matrix

Before declaring this slice RC-ready, verify:

| Scenario | Expected result |
| --- | --- |
| Active stream | `console.read_.browser.chatgpt.run.loop.step` returns `WAIT_AND_PROBE`, does not run pre-ASK. |
| Ready for pre-ASK | Step runs `console.read_.browser.chatgpt.implementation.pre_ask.capture` when `executePreAsk` is true. |
| Transport unhealthy | Planner/step stops for user action. |
| Chat binding lost | Planner/step stops for rebind/user action. |
| Max iterations reached | Planner returns `RUN_LOOP_STOPPED` / `STOP_FOR_USER`. |
| Compact observability | `console.read_.browser.chatgpt.run.loop.step.summary` exposes `summary.next_action`, execution flags, and policy without nested payloads. |
