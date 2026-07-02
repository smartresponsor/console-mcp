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
- `console.read_.browser.chatgpt.run.loop.auto.summary`
- `console.write.browser.chatgpt.run.loop.daemon.start`
- `console.read_.browser.chatgpt.run.loop.daemon.status`
- `console.write.browser.chatgpt.run.loop.daemon.stop`
- `console.read_.browser.chatgpt.run.loop.daemon.log.tail`
- `console.read_.browser.chatgpt.run.loop.recover.plan`
- `console.write.browser.chatgpt.run.loop.recover.step`
- `console.write.browser.chatgpt.message.control.click`
- `console.read_.browser.chatgpt.tab.inventory`
- `console.write.browser.chatgpt.tab.cleanup`

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
- `summary.soft_recovery_actions`
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

## Bounded automatic summary contract

`console.read_.browser.chatgpt.run.loop.auto.summary` repeats controlled run-loop steps inside one bounded tool call.

It is automatic, but it is not a daemon. It must stop when any of these conditions is reached:

- `RETURN_TO_CHAT` when `stopOnReturnToChat` is true;
- pre-ASK capture executed when `stopOnPreAskExecuted` is true;
- `STOP_FOR_USER`;
- a non-`WAIT_AND_PROBE` next action;
- `maxAutoIterations`;
- `maxElapsedMs`.

It may sleep only between bounded iterations, and the sleep must be controlled by `pollMs`, `minWaitMs`, `maxWaitMs`, `maxElapsedMs`, and planner timing. It must still never submit a prompt, mutate the browser DOM, draft return material, or run as a background process.

The result must include compact top-level fields and a compact `trace` of iterations. It must not return large nested `watch`, `plan`, or `pre_ask` payloads.

## Supervised daemon contract

The daemon tools provide a supervised in-process watcher mode for longer runs:

- `console.write.browser.chatgpt.run.loop.daemon.start`
- `console.read_.browser.chatgpt.run.loop.daemon.status`
- `console.write.browser.chatgpt.run.loop.daemon.stop`
- `console.read_.browser.chatgpt.run.loop.daemon.log.tail`
- `console.read_.browser.chatgpt.run.loop.recover.plan`
- `console.write.browser.chatgpt.run.loop.recover.step`

The daemon is supervised and bounded. It runs inside the MCP server process, writes compact state/log files under `var/run/chatgpt-run-loop/<runId>/`, and stops on `STOP_FOR_USER`, `RETURN_TO_CHAT`, pre-ASK execution, max iterations, max elapsed time, or explicit stop request.

It must not submit prompts, mutate the browser DOM, draft return material, restart the server, or run as a detached OS background process.

The daemon status must expose `server_pid`, `run_id`, `active`, `active_in_memory`, `stale_state`, `status_effective`, `heartbeat_at`, `completed_at`, `last_error`, `iterations`, `elapsed_ms`, `waited_ms`, `memory`, latest compact summary, state file, log file, and stop file. Logs must be compact JSONL, not nested full payload dumps.

### Durable auto-run recovery

After an MCP server restart, in-memory daemons are gone but a prior durable state can still represent an unfinished auto run. Recovery must not send a blind `continue` prompt. The recovery path is:

1. `console.read_.browser.chatgpt.run.loop.recover.plan` scans `var/run/chatgpt-run-loop/<runId>/state.json` files and reports non-terminal states where `active=true`, `completed_at=null`, and no daemon is active in current server memory.
2. `console.write.browser.chatgpt.run.loop.recover.step` restores `resume_input`, executes one existing controlled `run.loop.step`, writes a new checkpoint, and appends a `recovery_step` event to `daemon.jsonl`.
3. The existing watch → pre-ASK → decision pipeline remains authoritative for the next action.

Recovery must not create a new chat, submit a prompt, draft return material, or mutate the browser DOM. It only re-binds/probes the known ChatGPT thread through the existing pipeline.

Daemon hardening requirements:

- active daemon state must refresh `heartbeat_at` on every step;
- active daemon state must persist `resume_input` so a restarted server can continue from the last observed run-loop context instead of the original prompt context;
- completed daemon state must set `completed_at`;
- fatal daemon state must set `last_error`;
- status must distinguish in-memory active runs from stale persisted state;
- memory snapshots must include compact RSS and heap fields;
- JSONL daemon logs must be bounded by rotation/retention logic.

## Soft recovery controls

The run-loop read tools may surface `soft_recovery_actions` when a watch decision reaches a hard or uncertain stop. These values are recommendations only; the read-loop must not execute them.

Typical values include:

- `COPY_LATEST_ASSISTANT`
- `CAPTURE_CURRENT_ASSISTANT`
- `CLICK_LATEST_RETRY`
- `CLICK_LATEST_RETHINK`
- `CLICK_LATEST_REGENERATE`
- `RE_BIND_CHAT`
- `REFRESH_PAGE`
- `OPEN_FRESH_CHAT`

`console.write.browser.chatgpt.message.control.click` is the confirm-gated execution tool for visible controls under the latest assistant message. It must re-bind the target, require `confirmAction=true`, re-check the latest assistant node, and click only a visible actionable `copy`, `retry`, `regenerate`, or `rethink` control. It must not submit prompts.

## ChatGPT tab hygiene

`console.read_.browser.chatgpt.tab.inventory` is the read-only inventory tool for supervised ChatGPT tabs. It reports all ChatGPT page targets, empty home targets, chat targets, duplicate chat ids, and counts by port.

`console.write.browser.chatgpt.tab.cleanup` is the confirmed cleanup tool for empty ChatGPT home tabs. It defaults to dry-run, requires `confirmCleanup=true` for mutation, never submits prompts, and must not close non-empty chat tabs unless a future explicitly confirmed policy says otherwise.

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
