# Stage 11 — deployment admission lock integration (isolated release candidate worktree)

## Problem and confirmed evidence
- Stage10 v2 transaction `ac6f051650b54f6bb1b37f272323788d` failed validation with `task queue not empty: 1`; production remained on PID 715459.
- Independent async `npm test` runs `c43eb3a0...`, `dc80c42c...`, `6ce2ceb5...` continuously repopulated the queue.
- `ops/ubuntu/deployment/gates.py::queue()` scans task state but has **no atomic exclusion** with new task admissions.
- `src/Infrastructure/Process/AsyncCommandRun.ts::startAsyncCommandRun` and `src/engine/engine-core.ts::{enqueueTask,workerTick}` are distinct producers. There are further async launch paths requiring inventory.

## Implemented in isolated worktree
- `ops/ubuntu/deployment/admission-lock.py` implements inherited-kernel POSIX shared/exclusive `flock` over one trusted, pre-provisioned root-owned regular inode. Missing, symlinked, world-writable or replaced inode fails closed. No automatic lock-file deletion or creation, and process exit releases the lock.
- Shared admission: acquire **before** any process spawn or active-state publication; hold until state is durably recorded. This atomically serializes against the release-exclusive acquisition. Reusing an already active task must not be marked newly admitted.
- Exclusive validation: acquire **before** checking that the queue is empty, and hold until isolated candidate/rollback validation has terminated and durable controller result is saved. This prevents a new admission slipping in after queue scan.
- **Never hold a shared admission only after spawn**; doing so leaves a race between the queue scan and process start.
- A lock alone does not finish already running tasks. Under exclusive lock, still run the existing complete queue + browser/rollback gate checks (never remove or weaken them).
- A dedicated root-owned `/opt/console-mcp-deploy/admission.lock` must be securely provisioned and accessible for shared locking by every producer UID. The released helper refuses to create or repair it.
- POSIX read-only `flock` requires readable lock inode, not write permission. Root directory and inode provenance must be independently validated.
- On Linux, a shared helper can report `ADMISSION_LOCKED` over stdout then hold the lock until its parent closes stdin. The parent must treat early helper exit or an expired TTL as abort/unknown; never continue as if lock still held.
- Root controller should use direct `admission('exclusive')` context to avoid expiry mid-critical section; its entire validation must stay within context.
- TypeScript `withDeploymentSharedAdmission()` is opt-in. The deployed service must explicitly set `CONSOLE_MCP_DEPLOYMENT_ADMISSION=required` only after a reviewed root-owned `/opt/console-mcp-deploy/admission-lock.py` and fixed-inode lock file are securely provisioned; otherwise the bridge is disabled and does **not** provide a barrier. An invalid configured value fails closed.
- Shared coverage added: `startAsyncCommandRun`, `enqueueTask`, `workerTick`, synchronous PowerShell for entire command duration, and async PowerShell through durable run-state publication. Restricted repository workers inherit `CONSOLE_MCP_DEPLOYMENT_ADMISSION` through `buildSafeEnv`.
- Root exclusive coverage added to `prepare.py::main()` around the full `validate()` call. `admission-lock.py` is added to the protected operator hash inventory. `gates.py` scans PowerShell async run-state as well as existing queue entries.
- Root-owned helper must be **readable** by the service UID (root:root mode 0755 is an example), not the 0700 mode of the separate admin-only Stage10 authorization helpers. The lock inode should be root-owned, unreadable to unrelated UIDs (e.g. root:runtime-group 0640, after verifying actual worker group membership). A shared read lock does not require write access. Do not provision from the MCP UID.
- The current release `df90d470...` does not run the opt-in code; this worktree does not enforce production admission. Initial bootstrap still requires an independently controlled stop-new-jobs window and a reviewed installation/deployment.

## Integration gates to complete before any quiet-window claim
1. Inventory **all** Linux producers: async command/powershell/npm, Engine CLI enqueue/workerTick, release-candidate runs, direct process/spawn flows, and other facades sharing the root runtime. Do not assume guarding only `startAsyncCommandRun` covers every task.
2. Add an auditable shared-lock adapter to each process/state admission critical section. Do not fork background subprocesses before admission. Preserve existing capacity/dedupe and cleanup semantics.
3. Bind root `prepare.py::validate` (and, as separately reviewed, `deploy.py::apply` pre-gates/cutover) to exclusive lock covering queue scan through finished validation. Guard root policy/transaction provenance separately; this lock is **not** permission to activate.
4. Extend `gates.py` diagnostics to distinguish active processes from queued records; never silently clear stale records.
5. Add adversarial end-to-end tests: parallel shared starts vs exclusive validation, child exit during state write, PID reuse, lock inode replacement, parent crash, lease expiry, held lock while daemon restarts, burst of active tasks, and concurrent independent processes. Include actual npm and Engine admission paths, not only locking primitives.
6. Bootstrap sequencing: running incumbent release `df90d470...` lacks this protocol, and sealed candidate `eb5e062...` is immutable. A future SHA containing the fully integrated protocol must be built/tested separately. An admission lock cannot protect against the **currently deployed uninstrumented** producers. Coordinate a manual no-new-job maintenance window for initial cutover; do not claim atomicity beforehand.
7. Do not regenerate the old `validate_failed` transaction. After a real quiet-window exists, create fresh v2 prepare and validate with separate root CAS approvals and a newly bound checkpoint. No production cutover without distinct approval.

## Test evidence (isolated worktree only)
- `tool/stage11-admission-lock-fixture.py` used OS child processes and temporary fixture inode only.
- Independent shared/shared acquisition, exclusive-blocked-by-shared, shared-blocked-by-exclusive, recovery after release, lock symlink denial, missing lock fail-closed, world-writable lock denial: **PASS**.
- `npm test` durable PowerShell run ID `039c1b60-e18f-4a4a-a12a-17b25b231481`: **succeeded**, exit code 0, finished `2026-11-19T00:51:36.021Z`. Used only process-local `safe.directory` for this exact isolated worktree; global Git config not touched.
- `npm run build`, `test:async-command-run`, Node fail-closed (including repository-worker environment preservation), root exclusive AST assertion: **PASS**.
- First full test attempt run `92a37bca-73fb-4cfd-89a8-2ca8ffdd8527` exited 1 due Git `dubious ownership` in this isolated worktree; corrected with process-local Git config, not by changing global Git settings.
- Full production-wide admission integration, root privileges, mixed UID, PID-reuse, untracked direct process producers and privileged deployment E2E: **NOT YET TESTED**.
- Critical review blockers: durable state publication failure after a child spawned must not release admission with an untracked live child; test process-group termination/reaping. Audit all other process admission entry points and ensure bootstrapped environment is authoritative; root-only provisioned helper and group mode must be authenticated. Shared timeout 2700 seconds is a recovery backstop, not a safe substitute for explicit critical-section lifecycle.
- Never modify production, root policy, master, the main dirty checkout, or running jobs as part of this prototype.
