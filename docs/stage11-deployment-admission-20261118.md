# Stage 11 — deployment admission lock protocol (isolated prototype)

## Problem and confirmed evidence
- Stage10 v2 transaction `ac6f051650b54f6bb1b37f272323788d` failed validation with `task queue not empty: 1`; production remained on PID 715459.
- Independent async `npm test` runs `c43eb3a0...`, `dc80c42c...`, `6ce2ceb5...` continuously repopulated the queue.
- `ops/ubuntu/deployment/gates.py::queue()` scans task state but has **no atomic exclusion** with new task admissions.
- `src/Infrastructure/Process/AsyncCommandRun.ts::startAsyncCommandRun` and `src/engine/engine-core.ts::{enqueueTask,workerTick}` are distinct producers. There are further async launch paths requiring inventory.

## Prototype
- `ops/ubuntu/deployment/admission-lock.py` implements inherited-kernel POSIX shared/exclusive `flock` over one trusted, pre-provisioned root-owned regular inode. Missing, symlinked, world-writable or replaced inode fails closed. No automatic lock-file deletion or creation, and process exit releases the lock.
- Shared admission: acquire **before** any process spawn or active-state publication; hold until state is durably recorded. This atomically serializes against the release-exclusive acquisition. Reusing an already active task must not be marked newly admitted.
- Exclusive validation: acquire **before** checking that the queue is empty, and hold until isolated candidate/rollback validation has terminated and durable controller result is saved. This prevents a new admission slipping in after queue scan.
- **Never hold a shared admission only after spawn**; doing so leaves a race between the queue scan and process start.
- A lock alone does not finish already running tasks. Under exclusive lock, still run the existing complete queue + browser/rollback gate checks (never remove or weaken them).
- A dedicated root-owned `/opt/console-mcp-deploy/admission.lock` must be securely provisioned and accessible for shared locking by every producer UID. The released helper refuses to create or repair it.
- POSIX read-only `flock` requires readable lock inode, not write permission. Root directory and inode provenance must be independently validated.
- On Linux, a shared helper can report `ADMISSION_LOCKED` over stdout then hold the lock until its parent closes stdin. The parent must treat early helper exit or an expired TTL as abort/unknown; never continue as if lock still held.
- Root controller should use direct `admission('exclusive')` context to avoid expiry mid-critical section; its entire validation must stay within context.
- This Stage11 code is a **prototype**, not a deployed barrier. Its CLI must not be installed or invoked as an authority until all admission paths are wired and root-owned provisioning is reviewed.

## Integration gates to complete before any quiet-window claim
1. Inventory **all** Linux producers: async command/powershell/npm, Engine CLI enqueue/workerTick, release-candidate runs, direct process/spawn flows, and other facades sharing the root runtime. Do not assume guarding only `startAsyncCommandRun` covers every task.
2. Add an auditable shared-lock adapter to each process/state admission critical section. Do not fork background subprocesses before admission. Preserve existing capacity/dedupe and cleanup semantics.
3. Bind root `prepare.py::validate` (and, as separately reviewed, `deploy.py::apply` pre-gates/cutover) to exclusive lock covering queue scan through finished validation. Guard root policy/transaction provenance separately; this lock is **not** permission to activate.
4. Extend `gates.py` diagnostics to distinguish active processes from queued records; never silently clear stale records.
5. Add adversarial end-to-end tests: parallel shared starts vs exclusive validation, child exit during state write, PID reuse, lock inode replacement, parent crash, lease expiry, held lock while daemon restarts, burst of active tasks, and concurrent independent processes. Include actual npm and Engine admission paths, not only locking primitives.
6. Bootstrap sequencing: running incumbent release `df90d470...` lacks this protocol, and sealed candidate `eb5e062...` is immutable. A future SHA containing the fully integrated protocol must be built/tested separately. An admission lock cannot protect against the **currently deployed uninstrumented** producers. Coordinate a manual no-new-job maintenance window for initial cutover; do not claim atomicity beforehand.
7. Do not regenerate the old `validate_failed` transaction. After a real quiet-window exists, create fresh v2 prepare and validate with separate root CAS approvals and a newly bound checkpoint. No production cutover without distinct approval.

## Tested now (only in an isolated worktree)
- `tool/stage11-admission-lock-fixture.py` used OS child processes and temporary fixture inode only.
- Independent shared/shared acquisition, exclusive-blocked-by-shared, shared-blocked-by-exclusive, recovery after release, lock symlink denial, missing lock fail-closed, world-writable lock denial: **PASS**.
- Full production-wide admission integration, root privileges, mixed UID, PID-reuse and deployment E2E: **NOT YET TESTED**.
- Never modify production, root policy, master, the main dirty checkout, or running jobs as part of this prototype.
