# Console MCP Change Journal

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
