# ChatGPT Browser Product Loop

This document defines the responsibility boundary for a ChatGPT conversation that is already running inside an outer browser execution loop.

It is not a step-by-step prompt recipe. It does not prescribe a fixed sequence of actions. The model owns its planning strategy, context-window usage, and execution shape.

## Boundary

The outer runner owns browser orchestration, chat creation, composer drafting, submission, answer watching, and loop scheduling.

The target ChatGPT conversation owns product reasoning and repository work inside the requested workspace boundary.

The target conversation must not start another copy of the same browser orchestration loop.

## Hard exclusion

Do not call `console.write.browser.session.cmcp.go` from inside the target conversation.

That tool is the outer orchestration entrypoint. Calling it from the target conversation creates recursive orchestration and is outside this responsibility boundary.

The target conversation also should not use browser transport tools for normal product work. Browser transport is owned by the outer runner.

## Operating intent

Use available console MCP capabilities directly for repository inspection, implementation, verification, and transaction-quality commits when the task requires it.

Prefer concrete progress over purely advisory reports when safe, local evidence supports action.

Safe work may include reading repository context, classifying dirty state, applying small fixes, materializing missing documentation or tests, normalizing code to canon, running relevant checks, and creating signed commits for coherent completed changes.

The model may choose the appropriate granularity. It is not required to pause after every small discovery when a safe next action is clear.

## Workspace responsibility

Work only inside the requested workspace unless the user or repository evidence explicitly expands the edit scope.

Read adjacent repositories only as context when they are relevant to the requested workspace, dependency graph, or documented architecture boundary.

Do not make application or component repositories aware of console-mcp, browser-loop, or tool-plane internals unless the target repository itself is MCP infrastructure.

## Existing work preservation

Before modifying files, understand the existing repository state enough to avoid overwriting user work.

Dirty state is not automatically bad. It may contain valuable partial implementation, unrelated user work, generated noise, or broken leftovers. Preserve valuable work and avoid destructive cleanup.

Do not force reset, force clean, or discard user changes.

## Implementation permissions

When evidence supports it, the target conversation may perform safe implementation work through available console MCP write capabilities.

Safe implementation work includes small patches, exact replacements, focused documentation updates, focused tests, local normalization, and signed commits after inspecting the resulting diff and relevant checks.

Pushing remote branches is outside the default responsibility boundary unless explicitly requested.

## Verification intent

Prefer repository-local checks and existing scripts over ad hoc commands.

Use checks to increase confidence, not as ritual. When a check cannot run, report the exact blocker and keep the repository state clear.

## Completion intent

A useful product-loop answer should make the current state easier to act on.

Good outcomes include a committed safe fix, a precise no-op decision, a verified blocker, a narrowed next implementation target, or a clean preservation baseline.

## Output preference

Prefer structured, compact reporting with status, summary, actions taken, files changed, checks run, commits created, risks, and next action.

The structure is a communication preference, not a restriction on reasoning or tool use.

## Engine-cycle N-round driver

The outer browser execution loop referenced above is, concretely, the engine-cycle system in `src/engine/engine-core.ts`, `src/engine/engine-cycle.ts`, `src/engine/engine-cycle-browser.ts`, and `src/tool/engine.ts`. One full round is the fixed stage sequence `chat_bind → prompt_draft → prompt_submit → answer_capture → gateway_decision → reply_draft → reply_submit → complete`. A round is complete only once `reply_back_sent_at` is recorded and `console.write.engine.cycle.step` reports stage `complete`.

- `console.write.engine.cycle.step` executes exactly one missing stage.
- `console.write.engine.cycle.run` executes a bounded sequence of stages (`maxSteps`) for at most one round.
- `console.write.engine.cycle.run_n` drives a configurable number of full rounds, `maxRounds` (default 70, not a hardcoded constant), reusing the same bound chat/target across rounds. Between rounds it resets only the round-scoped task fields (draft/submit/answer/decision/reply-back) via `resetEngineCycleRoundState`; the chat binding (`chat_id`, `target_id`) is preserved so later rounds skip `chat_bind`.

`console.write.engine.cycle.run_n` stops before reaching `maxRounds` when:

- the deterministic decision router returns `human decision required`; product, architecture, policy, or explicit-approval boundaries stop before any automatic reply-back is submitted;
- the gateway decision returns explicit completion. Completion is only a candidate until the engine independently verifies the repository identity and final Git worktree state against the run baseline; a textual `done` claim is not sufficient by itself;
- three consecutive completed rounds produce the same semantic decision fingerprint, which is classified as `stalled_no_semantic_progress` instead of silently consuming the remaining budget;
- a stage reports `ENGINE_CYCLE_STAGE_BLOCKED`, `ENGINE_CYCLE_STAGE_NOT_READY`, or `ENGINE_CYCLE_ANSWER_ORPHANED` (the orphan-detection added for zero-assistant-message timeouts) — the driver stops immediately with an explicit `stop_reason` rather than silently burning the remaining rounds.

Each new engine execution specification also materializes a machine-readable `cmcp-go-run-spec-v1` record containing the task/workspace identity, initial Git baseline, strong worktree fingerprint, execution-specification hash, and fail-closed constraints. The Markdown attachment remains the authoritative model-facing specification; the RunSpec is the engine-facing identity contract.

Semantic progress is checkpointed into the durable engine task after every round. The last progress fingerprint, repeat count, round index, stop reason, and checkpoint timestamp survive a separate `run_n` call or server restart, so the stall detector does not forget prior no-progress rounds. Transport/not-ready rounds with no gateway decision do not increment semantic stall counters.

Only one `run_n`/CMCP Go browser executor may own a task at a time. A per-task exclusive cycle lease rejects concurrent runners with `ENGINE_CYCLE_ALREADY_RUNNING`; a dead process owner is recoverable on the next acquisition. Durable task JSON is replaced through a same-directory temporary file and atomic rename so process interruption cannot leave a partially overwritten task record. A successful round reset also clears stale execution-blocked receipts and restores the canonical `waiting_assistant` continuation state.

Final success is fail-closed: only a `decision_done_verified:*` stop reason may persist `completed`. Reaching `max_rounds`, an unresolved decision, a human boundary, a transport stop, or any other non-verified termination is non-completion. Exhausting the bounded iteration budget returns the durable checkpoint for review or explicit continuation rather than silently converting budget exhaustion into success.

Completion verification is engine-owned. It re-fingerprints tracked diffs plus untracked file content, requires `git diff --check`, verifies HEAD, and then discovers repository-local deterministic gates from `package.json` / `composer.json`. Available `typecheck`, `test`, `build`, Composer validation, and Composer `qa`/`test`/`phpstan` gates run through the Console MCP allowed-check policy. Any failed deterministic gate keeps a textual completion claim from becoming a completed engine task.

Each round's stage-by-stage timeline and stop reason is returned in the tool result (`rounds[]`), so the full round-trip lifecycle is auditable from one call.

Every non-completion reply-back instructs the target conversation to preserve useful work with a checkpoint commit before risky corrections when needed, complete one coherent bounded step, run relevant verification, create a commit, and continue without requesting another approval. `GO` is the execution-session approval; policy and canon findings are corrective navigation inputs.

This driver is unrelated to the read-only run-loop watcher's `maxAutoIterations` documented in `docs/chatgpt-run-loop-orchestration.md`. That watcher only observes and never submits or replies; `console.write.engine.cycle.run_n` is the tool that actually performs the submit → answer → decide → reply round trips, N times.

## Automatic end-to-end dispatch after `go`

`go <component> M<N>` (engine-backed `executorMode: "engine"` path of `console.write.browser.session.cmcp.go`, implemented as `executeEngineBackedCmcpGo` in `src/tool/chatgpt-chat-open.ts`) authorizes the task (`execution_authorized=true`, `max_auto_iterations=N`) and then drives `workerTick` through the local 7-phase `REPO_RC_PHASE_PLAN` (reconnaissance → workspace_state → boundary_policy → implementation_plan → patch_materialization → gate_execution → status_report — this phase plan is local bookkeeping in `src/engine/engine-core.ts` and issues no browser calls). Once the plan reaches its last phase with `execution_authorized=true`, `workerTick` sets task status to `done` and emits `task_phase_plan_complete_dispatch_ready`.

Previously the pipeline stopped there: the task sat in `done` with a `next_action` pointing at `console.write.engine.cycle.run_n`, and a separate manual tool call was required to actually run the ChatGPT round trips. `go` now dispatches automatically: after the phase plan reaches `done`/dispatch-ready, `executeEngineBackedCmcpGo` calls `runEngineCycleRounds` (exported from `src/engine/engine-cycle-browser.ts`) directly — the same function `console.write.engine.cycle.run_n`'s tool handler calls internally — with `maxRounds` set to the task's `max_auto_iterations` (the `N` from `M<N>`). This is a plain in-process function call, not a nested MCP tool invocation, and it reuses the same round-loop implementation, so `ENGINE_CYCLE_ANSWER_ORPHANED` orphan-detection and stage-blocked/not-ready stopping apply identically on the automatic path.

End-to-end result for `go <component> M<N>`: authorization → phase plan (workerTick) → automatic `run_n` dispatch with `maxRounds=N`, in one call. The dispatch result is reported back under `engine.run_n` in the `go` response; a `null` value there means the phase plan did not reach dispatch-ready (e.g. workspace missing), and `{ok:false, status:"ENGINE_CYCLE_RUN_N_DISPATCH_SKIPPED", ...}` means it reached done but a precondition (authorization or `max_auto_iterations`) wasn't met.

This automatic dispatch is gated by the `manageLoop` input (default `true`) on `console.write.browser.session.cmcp.go`. Setting `manageLoop: false` authorizes and advances the phase plan but skips the automatic `run_n` call, leaving the task at `done`/dispatch-ready for a manual `console.write.engine.cycle.run_n` call — this is the escape hatch for callers that want to inspect the phase plan output before letting the browser round trips start.

The `adopt`-authorized path (`console.write.browser.chatgpt.chat.adopt_into_task_bank`, `authorized_by: "adopt"`) is unaffected: it still returns `next_tool: "console.write.engine.cycle.run"` and requires an explicit follow-up call. Likewise, preparing a task without `go` (e.g. `cmcp prepare`, or calling `console.write.engine.worker.tick` directly without authorizing execution first) still stops at `waiting_user` once the phase plan completes, since `workerTick` only reaches the `done`/dispatch-ready branch when `execution_authorized=true`.

## Repeat adoption of an existing chat

`cmcp adopt <component> M<N> <existing-location>` creates a fresh bounded engine task while preserving the same ChatGPT conversation binding. The previous terminal task remains available for audit, but terminal statuses are excluded from the active task set. A second adoption is blocked only when the same `chat_id`, normalized component, and workspace path are already bound to a non-terminal task.

`existing-location` is one unified input concept. Supported forms include `@token`, a bare title token, `component:token`, `[component:token]`, a full ChatGPT conversation URL, and a full conversation UUID. Resolution order is: existing title-token registry, ChatGPT global title search, then existing message/body search. Exact component registry matches are preferred. Any genuine multi-chat match returns `CHAT_LOCATION_AMBIGUOUS` with candidate metadata instead of selecting a chat arbitrarily.

After a body-discovered chat is opened, the existing title-prefix mechanism records the chat token in the registry, making later repeat adoption a registry fast path.
