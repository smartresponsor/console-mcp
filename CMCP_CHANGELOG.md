# Console MCP Change Journal

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
