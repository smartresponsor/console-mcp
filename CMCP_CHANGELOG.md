# Console MCP Change Journal

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
