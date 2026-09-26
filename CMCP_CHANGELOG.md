# Console MCP Change Journal

## 2026-09-25 - Exact connector refresh convergence

- Completed the pending connector-refresh wave by making the exact connector id the authoritative navigation key and using the current `/settings/plugins-settings/plugin_<connector-id>` detail route.
- Removed ambiguous generic Settings-target reuse and visible-name discovery from the lightweight refresh path; retries now reassert the exact detail URL instead of cycling through settings surfaces.
- Preserved the title-prefix fallback in `chatgpt-chat-open.ts` so explicit prefix mode can derive a desired title even when the first rename probe cannot return one; auto mode still waits for ChatGPT auto-title readiness.
- Updated connector-refresh regression expectations to the exact-id contract.
- Verification green: `console_schema_validate`, `console_typecheck`, `console_build`, `console_engine_target_reaper`, `console_chatgpt_browser_executor`, and `console_repository_isolation`.

## 2026-09-25 - Backend-only conversation lifecycle sweep

- Removed browser-page fallback from background answer recovery: lifecycle sweeps now read assistant revisions only through the authenticated backend conversation path and never open `/c/<chat_id>` to compensate for a backend miss.
- Moved background title-prefix repair to the existing authenticated backend rename path; missing backend title/read state is reported as retryable lifecycle state without opening a conversation page.
- Added regression guards forbidding `openChatGptChat`, `runChatGptMessageCapture`, and browser title-prefix application inside the conversation lifecycle reaper.
- Verification green: `console_typecheck`, `console_build`, and `console_engine_target_reaper`. `console_schema_validate` is currently blocked by pre-existing dirty `chatgpt-connector-refresh*.mjs` regression drift (`lightweight refresh must discover the connector by visible name`), outside this lifecycle patch.

## 2026-09-25 - Fresh-root draft readiness

- Corrected ChatGPT fresh-root target selection and prompt preflight to distinguish draft readiness from submit readiness. An authenticated empty composer is now draft-ready even though its Send control is necessarily disabled before prompt text exists; submit readiness still requires enabled Send.
- Added `console_chatgpt_browser_executor` as a canonical named check and extended the existing browser executor regression with explicit draft-vs-submit readiness assertions.
- Verification: TypeScript typecheck PASS, build PASS, `console_chatgpt_browser_executor` PASS, and `git diff --check` PASS.
- Live probe reached the next real boundary: the currently supervised ChatGPT profile reports `CHATGPT_GUEST_LOGIN`, so a persistent backend conversation suitable for lifecycle deletion smoke cannot be created until the managed profile is authenticated. Guest mode was not used to fake persistence semantics.
- `console_schema_validate` currently fails in an unrelated concurrent connector-refresh wave because its modified regression still asserts visible-name discovery while the modified refresh source has moved to exact-detail navigation. Those connector-refresh paths are excluded from this commit.

## 2026-09-25 - Multi-turn conversation cleanup after target release

- Kept browser-target lifetime separate from conversation lifetime, but moved standard ephemeral target release below the first durable assistant capture: `submitted_at + chat_id` is no longer sufficient; `answer_captured_at` is required before immediate or recovery target cleanup.
- Standard conversations no longer treat the first captured assistant answer as a permanent latch. The lifecycle reaper keeps polling the backend conversation by durable `chat_id` while cleanup is unresolved and only records a genuinely newer assistant revision by backend id/hash.
- This closes the observed `ready_to_delete:false -> later assistant -> ready_to_delete:true` gap after the original browser target has already been released.
- Conversation deletion authorization now follows the explicit durable `ready_to_delete:true` protocol independently of stale engine execution status; engine completion verification remains a separate fail-closed execution concern.
- Existing backend conversation read/title work was preserved and integrated; retryable title-prefix states remain retryable instead of being falsely persisted as complete.
- Regression coverage now asserts that standard ephemeral targets remain open before the first durable answer capture, are eligible afterward, multi-turn recovery is not gated by absence of `answer_captured_at`, and conversation deletion is not coupled to `task.status === completed`.
- Verification green: TypeScript typecheck/build, `console_engine_target_reaper`, `console_cmcp_go_auto_dispatch`, `console_schema_validate`, and `console_repository_isolation`.
- Live disposable-conversation E2E was attempted but not fabricated: `console.write.browser.chatgpt.chat.create.send` currently rejects a fresh empty root before draft because Send is disabled, and global locator discovery returned `CHAT_ADOPT_LOCATOR_GLOBAL_SEARCH_INPUT_NOT_FOUND`. Those are separate browser-transport defects and were intentionally left out of this lifecycle commit.

## 2026-09-25 - Connector refresh exact-id routing and no-UI fast path

- Root cause of repeated ChatGPT Plugins tabs was traced to watchdog-driven connector refresh attempts: the watchdog repeatedly requested schema propagation after runtime recovery, while the refresh transaction entered the generic Plugins settings surface and frequently completed as `CONNECTOR_REFRESH_NOT_CLICKED`.
- Connector refresh now requires an exact connector ID before browser navigation and uses the exact `#settings/Plugins/plugin_<connector-id>` detail entrypoint. Generic Plugins settings remains compatibility/fallback surface only.
- Both lightweight and full refresh expressions refuse to click any Refresh action until the exact connector identity is visible in the URL or detail content.
- Added a pre-UI schema fingerprint gate: when ChatGPT's last observed `tools/list` fingerprint already matches the current runtime fingerprint, refresh returns `CONNECTOR_SCHEMA_PROPAGATION_ALREADY_CURRENT` with `browser_navigation_performed=false` and never opens settings.
- Watchdog recovery now marks the ChatGPT runtime as restarted only when the managed runtime PID actually changes, preventing transient smoke failures/no-op starts from triggering connector refresh.
- Refresh tracing now records an explicit initiator/reason for watchdog runtime replacement, supervised restart, confirmed server replacement, and manual refresh.
- Live acceptance refreshed the stale 224-tool ChatGPT schema (`4bbd74df81b1e7d6`) to the current 225-tool schema (`0f625a52b97130f5`) through the exact connector detail page; the immediate repeat returned `ALREADY_CURRENT` without browser navigation and created no settings target.
- Watchdog loop was restarted so the long-running control process loaded the new connector-refresh and PID-gating logic.
- Verification green: connector/schema regression, TypeScript typecheck/build, PowerShell unit suite (14/14), and `git diff --check`.

## 2026-09-25 - Engine conversation lifecycle recovery

- Added a bounded engine conversation lifecycle reaper for recent tasks: materialize missing `chat_id` from the bound target, recover a completed assistant answer from the final protocol line, repair missing title prefixes, and delete completed conversations only after durable `ready_to_delete:true`.
- Conversation deletion is now durably recorded on the engine task with attempt/status/receipt metadata; the browser-target reaper delegates conversation lifecycle work instead of reporting a hard-coded zero deletion count.
- Answer capture can materialize the conversation id from the already-bound browser target before settling, so target-bound tasks do not remain artificially blocked on a missing `chat_id`.
- Lifecycle policy loading is anchored to the Console MCP runtime root rather than the mutable engine-state root, preserving temporary/recovery state roots used by regression and supervision.
- Verification green: TypeScript typecheck/build, `console_engine_target_reaper`, `console_cmcp_go_auto_dispatch`, `console_ps_unit`, and `git diff --check`.

## 2026-09-25 - Correlated internal tool failures

- Added centralized tool-handler protection at the consumer-filtered registration boundary so uncaught tool exceptions return a structured `TOOL_INTERNAL_FAILURE` result instead of collapsing into an opaque client-side internal error.
- Failure envelopes now include the active MCP `correlation_id`, `tool_name`, `failure_phase=tool_handler`, and sanitized exception class/message.
- Every Console MCP HTTP response now carries `X-Console-MCP-Correlation-Id`; transport/pre-dispatch JSON-RPC internal errors also include the same ID and failure phase in `error.data`.
- Extended repository-isolation regression to force a synthetic handler exception and assert correlation propagation plus secret sanitization.
- Verification green: TypeScript typecheck, build, schema/catalog validation, and `console_repository_isolation`.

## 2026-09-25 - Ubuntu parity for recent runtime mechanics

- Extended the existing Ubuntu/systemd contour to run the same recent runtime-control semantics as Windows without porting the Windows desktop supervisor itself.
- Added `ubuntu-runtime-maintenance-cli`: it writes the shared watchdog/broker, runtime-environment, runtime-stability and failure-ledger schemas, including age-aware engine pressure and a DEGRADED -> RECOVERING -> NORMAL ramp.
- Ubuntu watchdog maintenance now invokes the shared engine browser-target reaper and plugin/settings cleanup against loopback CDP, so ephemeral Canon/Atlas targets and temporary settings tabs are swept on the same ~30s cadence.
- Added writable systemd bind mounts from `/var/lib/console-mcp/{run,log}` to `/opt/console-mcp/var/{run,log}` so shared engine/semaphore/capacity code keeps one canonical path contract while `/opt/console-mcp` remains otherwise read-only.
- Ubuntu defaults now expose the same 6 ChatGPT slots, 2 heavy slots, 60s broker freshness budget, and 64MB/2-backup diagnostic trace retention.
- `doctor.sh` now verifies the maintenance/reaper/browser CLIs plus writable runtime state/log directories.
- Added `console_ubuntu_runtime_parity` regression: on a temporary Linux-style state tree it verifies runtime failure -> RECOVERING, age-aware stale backlog exclusion, shared capacity admission, append-only failure transitions, and systemd/browser maintenance wiring.
- Added `.github/workflows/ubuntu-runtime-parity.yml` on `ubuntu-latest` to run npm ci, typecheck/build, the parity regression, and `bash -n` for Ubuntu scripts.
- Local acceptance green: typecheck, build, `console_ubuntu_runtime_parity`, and `git diff --check`.
- Actual Linux acceptance also passed in an isolated Debian 13 / Node 22 environment: the built maintenance CLI produced DEGRADED -> RECOVERING state, age-aware backlog counts and failure ledger transitions; all Ubuntu shell scripts passed `bash -n`; and `systemd-analyze verify` accepted all service/timer units once their production executable paths were staged.
- GitHub Actions itself currently fails before runner assignment (`runner_id=0`, no steps/logs) on this repository, so the Ubuntu parity workflow is retained as manual `workflow_dispatch` instead of creating misleading red push checks until hosted-runner access is available.

## 2026-09-25 - Ephemeral browser targets for background CMCP work

- Separated browser-target lifetime from conversation lifetime. Closing a DevTools target never deletes the ChatGPT conversation; durable `chat_id` remains available for the existing deletion workflow and for mobile/history access.
- Added durable `browser_target_policy` (`persistent` / `ephemeral`). Ordinary interactive `cmcp go` remains persistent; `--first-answer-only` implies ephemeral; background callers can request `--ephemeral-target` explicitly.
- Atlas one-shot work closes its exact target immediately after the first durable answer capture. Canon nightly dispatch now passes `--ephemeral-target`; its target is closed whenever a bounded engine invocation yields after a durable submit/chat binding, independent of `ready_to_delete`.
- Confirmed safe resume semantics: after a close, stale `target_id` / composer-bound state is cleared while `chat_id` is preserved; the next invocation returns to `chat_bind` and reopens/rebinds the same conversation by `chat_id`. A new bind resets the previous target-generation closure marker.
- Recovery reaper now also catches yielded ephemeral tasks that missed immediate cleanup after a crash/restart, while excluding actively `executing` / `waiting_assistant` tasks. Default recovery sweep cadence reduced from 60s to 30s and remains external/lock-protected so watchdog heartbeat is not blocked.
- Live reaper acceptance found no eligible stale engine targets and deleted zero conversations. Current non-eligible/manual chat tabs were left untouched.
- Focused acceptance green: typecheck, build, `console_engine_target_reaper`, CMCP Go auto-dispatch, Canon PowerShell parser validation, and `git diff --check`.

## 2026-09-25 - Early browser-target release for completed engine chats

- Separated browser-target lifetime from conversation lifetime. Closing a DevTools page target is now explicitly a resource-management operation and never implies conversation deletion.
- Standard CMCP Go tasks close the exact bound ChatGPT target only after `ready_to_delete:true`, verified `decision_done_verified:*` completion, and durable execution outcome persistence.
- `one_shot` tasks (including Atlas scoring) close their exact target immediately after durable first-answer capture because conversation cleanup is caller-owned and no further browser reply-back is expected.
- Added guarded target close with exact `target_id` + `chat_id` verification. If the target has navigated to another conversation, it is preserved rather than closed.
- Added durable audit fields/events for target-close attempts and success while retaining `chat_id` and `ready_to_delete` for the independent conversation deletion workflow.
- Added an asynchronous 60-second `engine_target_reaper` watchdog lane. It launches an external Node process and returns immediately so CDP cleanup cannot starve watchdog heartbeat.
- Recovery reaper covers both completed `ready_to_delete:true` tasks and `one_shot + answer_captured_at` crash windows. It is locked/idempotent and never deletes conversations.
- Live acceptance: manual recovery pass reported `conversation_delete_count=0`; scheduled lane completed in ~225 ms with zero pending candidates while broker heartbeat continued independently.
- Regression/acceptance green: typecheck, build, `console_engine_target_reaper`, Pester 14/14, CMCP Go auto-dispatch, schema validation, and `git diff --check`.

## 2026-09-25 - Plugins/settings tab lifecycle leak closure

- Root cause confirmed live: 14 accumulated `Plugins` pages were open at `https://chatgpt.com/settings/plugins-settings` while both cleanup predicates only recognized legacy `#settings/Plugins/plugin_*` routes.
- Connector refresh also used the legacy `#settings/Plugins` entrypoint, so ChatGPT redirected each new target to `/settings/plugins-settings`; target reuse then failed and repeated refreshes could create more tabs.
- Updated connector refresh to use the current `/settings/plugins-settings` route, recognize both current path and legacy generic/detail hash routes, and reuse an existing recognized settings target instead of opening another.
- Settings/plugin pages are no longer eligible cleanup keepers; plugin-settings housekeeping no longer preserves a recognized lifecycle target merely because it is focused. `keepTargetId` remains the explicit preservation escape hatch.
- Both success and failure connector-refresh paths retain `after-refresh` cleanup. Live failure-path verification (`CDP_RUNTIME_CONTEXT_FAILED`) still ended with `settings_count=0`, proving cleanup is lifecycle-safe even when refresh itself fails.
- Live cleanup removed the accumulated settings tabs without deleting conversations. Final browser inventory: `plugin_settings_count=0`.
- Regression/acceptance green: typecheck, build, schema validation including connector-refresh lifecycle assertions, and `git diff --check`.

## 2026-09-25 - Overnight admission and watchdog starvation remediation

- Made engine pressure age-aware: non-terminal tasks older than six hours remain observable but are excluded from current capacity pressure, preventing July/old dispatch-ready tasks from blocking nightly Canon work.
- Expanded active-pressure recognition to current `executing`/`waiting_assistant` states so genuinely active daytime work still constrains heavy admission.
- Added a bounded broker-heartbeat freshness budget (`CONSOLE_MCP_WATCHDOG_BROKER_STALE_SECONDS`, default 60s) instead of the previous 15s false-positive threshold.
- Decoupled expensive runtime-environment sampling from the watchdog broker loop by launching a locked external sampler process.
- Decoupled Scheduled Task / autologon / console-session integrity checks the same way; fixed the old lane bug that treated `Show-WatchdogTask` JSON text as an object instead of parsing it.
- Live acceptance: broker ownership remained consistent; task-integrity cadence transitioned to `TASK_AND_SESSION_INTEGRITY_HEALTHY`; runtime stability stayed healthy; stale historical engine tasks no longer appear in `pressure_counts`.
- Focused acceptance green: typecheck/build, runtime-capacity regression, CMCP Go auto-dispatch regression, Pester 14/14, and `git diff --check`.

## 2026-09-25 - ChatGPT submit, materialization, and durable title lifecycle

- Repaired delayed ChatGPT submit handling: an irreversible Send is persisted as dispatched even when immediate confirmation times out, preventing a second Send click.
- Kept submit and conversation identity separate: a new chat is not expected to have a chat id at submit time; the engine acquires and persists the real chat id from answer capture once the conversation materializes during thinking/first response.
- Restored the durable-title invariant introduced by commit `8555024` (`fix(browser): make chat title prefixes durable`), but aligned it with the actual ChatGPT lifecycle: title-prefixing is now an explicit recoverable engine stage after answer capture materializes the stable chat id. Rename retries operate on the same materialized chat and never resubmit the prompt.
- Pre-submit message capture no longer requires a chat id for a new root conversation.
- Extended focused CMCP Go regression coverage for the post-answer title-prefix stage.
- Marked `--first-answer-only` engine runs as `one_shot`: those prompts no longer request the generic `ready_to_delete` control line because cleanup is owned by the caller (for example, Atlassing).

## 2026-09-24 - transport observability follow-up

- Added a bounded durable NDJSON ledger for every Windows public-tunnel watchdog outcome with compact local/public probe, action, verification, and diagnostic-classification fields.
- Ledger growth is capped opportunistically at 2 MiB by retaining the latest 5000 events.
- watchdog-status now treats a fresh green watchdog cadence-loop state as authoritative liveness when the older full-heal state has aged past its 120-second window.
- Full-heal freshness and cadence freshness remain separately exposed so diagnosis can distinguish no recent repair needed from a dead or stale watchdog loop.
- Added focused Pester coverage for both behaviors.

## 2026-09-24 - public tunnel recovery hardening

- Reduced the Windows watchdog public tunnel cadence from 120 seconds to 15 seconds.
- Added a two-probe debounce before tunnel intervention so one transient public failure cannot restart cloudflared.
- Added bounded sanitized cloudflared log-tail capture with coarse transport classification on confirmed public failure.
- Added tunnel-only fast recovery when local ChatGPT MCP remains healthy; local failure still escalates to the existing full watchdog heal.
- Public recovery now requires three consecutive successful public MCP probes after tunnel start/restart before it is considered verified.
- Added focused Pester contract coverage for the transport fast path.

## 2026-09-24 - runtime stability observer slice

### Reconnaissance

- Reused the canonical Windows Scheduled Task -> `watchdog-loop-run` supervisor and `Register-WatchdogCadenceLane`; no second watchdog or scheduler was introduced.
- Kept existing `implementation.admission` responsibility unchanged; runtime-capacity policy is intentionally deferred.
- Confirmed live transport baseline: Console MCP 3333/3334 respond quickly with expected 401 transport-level readiness and CDP 9223 responds 200.
- Confirmed existing runtime-environment telemetry now provides resource-pressure/process-family data suitable for cheap reuse.

### Selected Changes

- Added durable runtime stability state and append-only failure ledger paths.
- Added non-repairing `runtime_stability` watchdog extension lane at 10-second cadence.
- The lane performs only cheap PID/HTTP/CDP probes and reads the latest durable resource snapshot instead of re-running expensive host telemetry.
- Failure ledger records transition events (`failure_started` / `failure_recovered`) rather than one event per sample.
- Added bounded recent-failure aggregation: 5/15/60-minute counts, recent inter-failure intervals, shrinking/expanding/mixed trend, and preliminary NORMAL/DEGRADED/UNSTABLE/CRITICAL classification.

### Read-only Runtime Capacity Slice

- Added `console.read_.policy.runtime.capacity` as a separate policy from artifact/implementation admission.
- Verdicts are `ADMIT`, `ADMIT_LIGHT_ONLY`, `WAIT`, or `DRAIN`; the tool is read-only and does not alter engine dispatch.
- Inputs are durable watchdog freshness, watchdog broker/loop ownership consistency, resource telemetry freshness/pressure, stability classification/current failures, and engine execution pressure.
- Watchdog stale or broker/loop ownership mismatch fails closed to `DRAIN`; engine backlog alone reduces to `ADMIT_LIGHT_ONLY`.
- Added focused deterministic regression `console_runtime_capacity`; typecheck, build, schema/catalog validation, and the focused regression are green. Canonical tool count is now 225.
- Extended the external stability lane so `WATCHDOG_OWNERSHIP_MISMATCH` becomes a transition event in the failure ledger rather than only a transient capacity reason.

### Engine Dispatch Backpressure Slice

- Integrated the canonical runtime-capacity verdict at the shared `runEngineCycleRounds` boundary used by manual `cycle.run_n` and automatic post-authorization CMCP Go dispatch.
- Capacity is checked before acquiring the per-task cycle lease and before browser/chat binding, so `WAIT`/`DRAIN` cannot create a new ChatGPT target.
- `WAIT`/`DRAIN` now persist `waiting_runtime` with stage `runtime_capacity`, the capacity receipt, and a retry-same-task next action; they do not mark the task failed.
- `ADMIT` and `ADMIT_LIGHT_ONLY` continue into the existing cycle path; heavy-work admission remains a later layer.
- Extended the focused runtime-capacity regression to verify dispatch predicate precedence and source ordering before the cycle lease/browser boundary.
- Typecheck, build, focused runtime-capacity regression, and `git diff --check` are green after this integration.

### Watchdog Restart Lifecycle Repair

- Reproduced `restart-watchdog-loop` timeouts independently from Console MCP process failure: the unified Node runtime stayed alive while the supervised PowerShell call remained attached to a long-lived watchdog child.
- Found a real split-ownership defect: duplicate cleanup only matched `pwsh.exe ... watchdog-loop-run`, while canonical instance counting also recognizes Scheduled Task `watchdog-task-bootstrap.ps1` and `powershell.exe`. Duplicate bootstrap-owned loops could therefore survive restart and race on PID/state/broker files.
- Unified duplicate cleanup with the canonical watchdog ownership predicate (`pwsh.exe`/`powershell.exe`, direct `watchdog-loop-run` or Scheduled Task bootstrap).
- Added durable bounded `repair_not_before` cadence state and `Set-WatchdogRepairDeferral`; `restart-watchdog-loop` defers repair for 30 seconds so a newly started loop cannot immediately heal/restart the Console MCP runtime serving the restart request.
- `Restart-WatchdogLoop` now calls `Start-WatchdogLoop -PreferScheduledTask`, ensuring the new infinite watchdog is detached from the supervised caller instead of becoming its child process.
- Expired repair deferral metadata is cleared automatically by the cadence scheduler.
- Added an OS-held single-owner lock (`console-mcp-watchdog-loop.owner.lock`, `FileShare.None`) inside `Invoke-WatchdogLoopRun`; a racing second loop exits as `DUPLICATE_LOOP_REJECTED` before it can write broker/cadence state.
- Fixed a PowerShell `ConvertFrom-Json` timestamp-kind trap: stringifying deserialized UTC `DateTime` values dropped the UTC kind and introduced an artificial five-hour offset. Protocol-smoke age, `repair_not_before`, and `last_repair_at` now preserve `DateTime`/`DateTimeOffset` semantics before falling back to string parsing.
- Live validation reproduced the original dangerous case with `process_started_before_dist_build`: `restart-watchdog-loop` returned successfully, watchdog reported `CADENCE_REPAIR_DEFERRED`, the serving MCP runtime remained available during the response window, and after the 30-second deferral the stale runtime was replaced from PID 7956 to PID 31556.
- Current live ownership is consistent: watchdog writer PID = broker PID = 4740; Console MCP PID 31556 is current; authenticated MCP protocol smoke is fresh with a normal positive age and no active runtime failure classes.
- Post-fix `console_typecheck`, `console_runtime_capacity`, `console_cmcp_go_auto_dispatch`, `console_ps_unit` (12/12), `console_schema_validate`, and `git diff --check` pass. Heavy full-regression execution remains intentionally deferred while the runtime-stability work is being calibrated.

### Recovery Ramp Calibration

- Added `RECOVERING` to the stability classifier: when the last 5 minutes are clean, the 15-minute window contains at most one failure, and older failures remain in the 60-minute window, stability no longer stays `UNSTABLE` for the full hour.
- Runtime capacity maps `RECOVERING` to `ADMIT_LIGHT_ONLY`, allowing cautious forward progress while preserving reduced capacity until historical failures age out.
- Live validation after restart/replacement: watchdog writer PID = broker PID = 32812, Console MCP PID reached 34784 during the validating sample, protocol smoke age = 17.5s, active failure classes were empty, and rolling stability was `RECOVERING` with 0 failures/5m, 1 failure/15m, 30 historical failures/60m.
- Focused runtime-capacity regression, typecheck/build, Pester 12/12, CMCP Go auto-dispatch regression, schema validation, and `git diff --check` are green across the lifecycle/recovery changes.

### Heavy Work Admission Slice

- Moved runtime-capacity evaluation/durable-state reading into shared `src/service/runtime-capacity.ts`; the MCP tool is now a thin adapter/re-export and engine dispatch consumes the same service.
- Repository worker dispatch now treats worker-hosted async starts as heavy by default and consults the shared runtime-capacity policy before worker/process creation. `ADMIT_LIGHT_ONLY`, `WAIT`, and `DRAIN` return `REPOSITORY_WORKER_WAITING_RUNTIME_CAPACITY` with `starts_process=false`.
- Added a global async heavy semaphore with default limit 2 (`CONSOLE_MCP_HEAVY_EXECUTION_SLOTS` override). The lease is acquired before spawn, atomically stored under `var/run/runtime-capacity-heavy`, rebound from worker PID to the actual child PID, and released only at terminal `finalizeRun`.
- Worker loss does not prematurely free a slot while the heavy child is still alive; stale/dead owners are reclaimable by the next acquisition.
- Runtime-capacity status now exposes both `chat_execution_slots` and `heavy_execution_slots` with live/stale occupancy.
- Added deterministic `console_heavy_capacity` regression: two heavy children run concurrently, the third is blocked before spawn, a terminal child releases its slot, and a subsequent heavy child reuses capacity.
- Repository-worker isolation regression explicitly bypasses live capacity/semaphore and remains green; direct AsyncCommandRun compatibility remains green when no capacity marker is supplied.
- Verification green after this slice: typecheck/build, `console_heavy_capacity`, `console_runtime_capacity`, `console_async_command_run`, `console_repository_worker_isolation`, `console_cmcp_go_auto_dispatch`, Pester 12/12, schema validation, and `git diff --check` from the preceding lifecycle acceptance.

### Between-Round Backpressure

- Long `runEngineCycleRounds` executions now re-read runtime capacity at the safe checkpoint between completed rounds, before `resetEngineCycleRoundState` and before another ChatGPT interaction can begin.
- If capacity degrades to `WAIT`/`DRAIN`, the current completed round/checkpoint is preserved, the task records `waiting_runtime` at stage `runtime_capacity`, the capacity receipt is persisted, and the global ChatGPT slot is released by the existing outer `finally`.
- `ADMIT_LIGHT_ONLY` still permits ChatGPT continuation but does not permit repository-worker heavy starts.
- Focused source regression verifies the capacity recheck occurs before round reset and that recovery instructs resuming the same task/checkpoint without opening another ChatGPT target.
- Post-change typecheck/build, runtime-capacity regression, CMCP Go auto-dispatch, heavy-capacity, direct async-command, and repository-worker isolation regressions are green.

### Nightly Scan Resume

- Added `cmcp capacity [--require-new-work|--require-heavy]`, a thin CLI adapter over the same shared runtime-capacity service used by engine and repository-worker admission. External schedulers can now consume the canonical verdict without duplicating thresholds.
- `CanonScanning/bin/canon-scan.ps1` (operational component; not a standalone Git repository) now requires canonical heavy admission before the wide PHP/Gating scan, re-checks new-work admission before CMCP dispatch waves, and limits detached CMCP launcher wrappers to three live processes.
- Canon capacity denial is a controlled defer (`exit 0`) so an unhealthy or recovering host does not turn expected backpressure into a Scheduled Task failure.
- Canon Scheduled Task was reinstalled at the intended nightly `03:00` boundary and is enabled/Ready.
- Atlassing `chatgpt-cli` preflight passed (`SYSTEM_READY`, Console MCP scoring ready), its existing dirty repository work was not modified, and `SmartResponsor Atlassing Quality Atlas` was re-enabled with its existing `04:27:27` schedule.
- Final Scheduled Task snapshot: Canon next run `2026-09-25 03:00 -05:00`; Atlassing next run `2026-09-25 04:27:27 -05:00`.

### Diagnostic Trace Rotation / Retention

- Added process-local serialized rotation for diagnostic NDJSON traces written by `RuntimeDiagnostics`: default active-file cap 64 MB with two rotated backups (`CONSOLE_MCP_DIAGNOSTIC_TRACE_MAX_BYTES` / `CONSOLE_MCP_DIAGNOSTIC_TRACE_KEEP` overrides).
- Rotation happens before append and is serialized per trace path to avoid concurrent writer races.
- Added focused `console_diagnostic_trace_rotation` regression; it verifies bounded active size and a maximum of two retained backups.
- Applied the new policy live: active `mcp-request-trace.ndjson` and `mcp-method-trace.ndjson` rotated automatically after the rebuilt runtime loaded.
- Compacted the pre-existing oversized `.1` backups to their most recent ~32 MB tails, freeing approximately 1.09 GB while preserving recent diagnostic history.

### Risks / Deferred

- Heavy work is currently classified at the canonical repository-worker async boundary; finer sub-classification between cheap and expensive worker-hosted commands can be added later if telemetry shows the boundary is overly conservative.
- Historical failure-window events remain in the rolling stability ledger and currently keep the aggregate classification elevated until they age out; current live failure classes are empty. Recovery/hysteresis and maintenance-event weighting remain follow-up policy work.
- `runtime-environment-status` was changed from synchronous telemetry collection to a cheap read of the durable environment snapshot, with explicit sample age/staleness and a compact summary; the full sample remains in `runtime-environment-last.json`. Live invocation now completes inside a 10-second tool window and returns parseable JSON without truncation.
- Historical Scheduled Task result debt was refreshed without starting heavy night work: Canon ran through its capacity-controlled defer path and returned `0`; Atlassing ran the same Scheduled Task temporarily with `-PreflightOnly`, returned `0`, and its original action was restored. Both tasks remain Enabled/Ready with their nightly schedules unchanged.

### Verification

- Live stability state is updating with current Console MCP PID, healthy 3333/3334/CDP probes, fresh resource telemetry, and no active failure classes.
- Static Pester contract coverage was extended for non-repairing ownership, transition logging, bounded history, interval trend, and classification fields.
- Full regression was intentionally not repeated after a prior long regression invocation exceeded the MCP tool-call window.

## 2026-09-24 - per-repository process isolation milestone

### Reconnaissance

- Confirmed branch `feature/documentating-build-publish` at accepted resilience baseline `61d75c1` with only known unrelated untracked `tool/find-unsubmitted-20260923-once.ps1` and no staged diff.
- Re-read the existing durable async lifecycle in `src/Infrastructure/Process/AsyncCommandRun.ts`, repository identity in `src/service/repository-registry.ts` and `src/service/repository-binding.ts`, heavy command surfaces in `src/tool/qa.ts`, `src/tool/run-check.ts`, and `src/tool/rc.ts`, plus existing repository/async/resilience regressions.
- Code Memory graph lookup was available but stale for several current source terms, so exact source discovery fell back to scoped `rg` and direct file reads.

### Selected Topology

- Keep one public MCP gateway process that owns transport, auth, canonical catalog, registry/binding lookup, health/status fast paths, and durable status/output/stop reads.
- Add a lazy process-level repository worker registry keyed by canonical `scopeId` in `RepositoryWorkerHost`.
- Fork one worker process per active canonical repository scope; each worker has immutable `scopeId`, canonical name, relative path, fixed canonical cwd, and a single repository workspace realpath.
- Retire idle workers after a short idle period; recreate a crashed/retired worker on the next request for that repository.
- Use process isolation instead of worker_threads because the failure/resource boundary needs to keep repository child-process ownership outside the gateway process.

### Gateway-Local vs Worker-Hosted

- Gateway-local: `system.console.health`, describe/catalog, registry/binding resolution, async command status/output/stop, lightweight snapshots, and all durable state reads that can safely use filesystem state directly.
- Worker-hosted first targets: async Composer script/command starts, async Symfony Console starts, async npm script starts, async named gate-check starts, and async RC job starts.
- Not moved in this milestone: simple bounded file reads/searches and synchronous compatibility tools. They remain candidates only if measurements show material gateway interference.

### Selected Changes

- Add `src/Infrastructure/Process/RepositoryWorkerHost.ts` and `src/Infrastructure/Process/repository-worker-entry.ts` for bounded IPC request/response framing, worker crash detection, idle retirement, worker recreation, canonical cwd validation, and worker telemetry returned with start responses.
- Export the existing `AsyncCommandRunStartInput` type without replacing the durable async run lifecycle.
- Route heavy async start call sites through `startRepositoryWorkerCommand` after resolving canonical repository scope. The worker still calls the existing `startAsyncCommandRun`, preserving run IDs, output offsets, stop semantics, timeouts, dedupe leases, repository fingerprints, recent safe-result reuse, stale lease recovery, and atomic durable state.
- Add `tool/repository-worker-isolation-regression.mjs` and `npm run test:repository-worker-isolation`.

### Verification Plan

- Focused gate must cover two active canonical repositories, independent worker PIDs, simultaneous slow operations, gateway-local responsiveness while busy, one worker crash, unrelated repository survival, worker recreation/reuse, cross-scope rejection, correlation observations, and durable status recovery after worker loss.
- Existing regression gates to keep green: repository isolation, async command run, resilience, RC async, typecheck, build, and canonical schema/catalog validation.

### Verification Log

- PASS: TypeScript build and typecheck.
- PASS: repository worker isolation regression after repairing two races exposed by the new coverage:
  - worker reuse telemetry no longer depends on millisecond timestamp equality; reuse is tracked deterministically by dispatch count;
  - gateway status/dedupe reconciliation now waits briefly for the worker-owned close handler to persist a terminal state before declaring `process_not_running`, preventing false failures after normal child completion.
- PASS: repository isolation regression.
- PASS: async command regression.
- PASS: resilience regression, including dedupe/recent-result reuse, fingerprint invalidation, stale-lease recovery, bounded output, bounded search, and `TIME_BUDGET_EXCEEDED`.
- PASS: RC async regression.
- PASS: canonical schema/catalog validation (224 policy / 224 registered).
- PASS: git diff --check.

### Acceptance State

- Per-repository worker process isolation is implemented for heavy async Composer, Symfony Console, npm, named gate-check, and RC start paths.
- Fast durable status/output/stop reads remain gateway-local.
- Worker crash/recreation, cross-scope rejection, unrelated-repository survival, worker reuse, and durable run recovery are regression-covered and green.
- Known unrelated untracked `tool/find-unsubmitted-20260923-once.ps1` remains intentionally untouched.
- No manual runtime restart was required during this implementation pass; active runtime reload behavior remains watchdog-managed.
- Milestone is ready for signed commit.

## 2026-09-23 - resilience milestone: async dedupe, bounded reads, abort telemetry

### Reconnaissance

- Read current Git state through Console MCP: branch `feature/documentating-build-publish`; working tree only had pre-existing untracked `tool/find-unsubmitted-20260923-once.ps1`; staged diff was empty.
- Re-read `src/Infrastructure/Process/AsyncCommandRun.ts`, `src/tool/qa.ts`, `src/tool/run-check.ts`, `src/tool/rc.ts`, `src/Infrastructure/FileSystem/SafeFileSystem.ts`, `src/tool/search-text.ts`, `src/tool/workspace-scope.ts`, `src/index.ts`, `src/Infrastructure/Diagnostics/RuntimeDiagnostics.ts`, `package.json`, and existing async regression coverage.
- Current runtime/tool baseline from the active runtime already includes async Composer script, gate check, and release RC start/status/output/stop APIs. This milestone preserves those names and does not add per-repository physical tool namespaces.

### Selected Changes

- Add durable async command dedupe leases under `.console-mcp/command-run-lease`.
- Add repository execution fingerprints based on canonical workspace path, HEAD, tracked diff, staged diff, untracked inventory, and operation inputs.
- Apply running-job reuse to Composer async commands/scripts, npm async scripts, gate checks, and release RC jobs.
- Apply recent successful result reuse only where semantically safe: gate checks, RC, Composer validate/read-like commands, and read-like npm scripts.
- Bound repository text search with dependency/generated skip directories, binary extension/probe guards, file/result/deadline budgets, and structured statuses including `TIME_BUDGET_EXCEEDED`.
- Extend MCP request trace records with `client_close_before_completion` and `response_aborted`.
- Add resilience regression coverage in `tool/resilience-regression.mjs`.

### Risks

- Repository fingerprinting uses bounded Git subprocesses at async start time; this is acceptable for heavy job starts but should not be moved into fast health/status paths.
- Composer script successful-result reuse is intentionally narrow to avoid reusing potentially mutating scripts.
- Active runtime is not restarted by these source changes. A later controlled restart is required before the live ChatGPT-facing connector exposes the new behavior.

### Verification Log

- PASS: TypeScript build.
- PASS: TypeScript typecheck.
- PASS: canonical catalog/schema validation (224 policy / 224 registered).
- PASS: async command regression; concurrent dispatch remained fast and both runs completed successfully.
- PASS: RC async regression; readiness status remained green.
- PASS: repository isolation regression; durable binding and independent execution remained green.
- PASS: resilience regression after repairing two defects exposed by the new coverage:
  - async run state/lease JSON persistence is now atomic/retry-safe for concurrent readers;
  - bounded text search now reports TIME_BUDGET_EXCEEDED when traversal exits on deadline.
- PASS: git diff --check.
- Full synchronous npm test was attempted but exceeded the MCP tool-call window; the focused constituent regressions above were run independently instead.

### Acceptance State

- Resilience milestone implementation and focused verification are complete.
- Existing unrelated untracked tool/find-unsubmitted-20260923-once.ps1 remains intentionally untouched and excluded from the milestone commit.
- Live runtime was not manually restarted; watchdog-managed reloads occurred automatically while source files changed.
- Ready for signed commit.
