# Windows isolated releases

The control directory and session-bound watchdog own process management. The selected
runtime worktree owns source, dependencies and build output. The active Git checkout
may contain staged, unstaged and untracked work; deployment never switches it.

Use the validated supervisor with `-ControlRoot <original-checkout>` for all commands.
`CONSOLE_MCP_CONTROL_ROOT` is passed to the managed runtime for nested supervisor calls.

1. Commit the candidate in its isolated worktree and install locked dependencies.
2. Run `tool/dev-console.ps1 deployment-prepare <candidate> <expected-SHA> -ControlRoot <control>`.
   Preparation checks the commit and clean candidate, runs typecheck/build/schema/admission
   and deployment regressions, and freezes a separate rollback worktree including the
   current built output, dependencies and dirty source. All artifacts are retained.
3. Require the live broker to advertise `deploy-release`. A broker running old code
   cannot hot-load this protocol. Upgrade its session-bound supervisor separately;
   never stop a healthy runtime merely to discover whether broker replacement works.
4. Run `tool/dev-console.ps1 deployment-switch <deployment-id> -ControlRoot <control>`.
   The existing broker checks session, generation, deadline, candidate/rollback hashes
   and the active checkout snapshot before the first runtime mutation.

The broker records switching intent, stops the old runtime, selects and starts the
candidate, checks all three port owners, process/session/cwd identity, authenticated
MCP, public/local OAuth and `write.repo.git.archive.ref.push`. Failure restores the
frozen rollback release and checks its health. Interrupted switching transactions
roll back on broker startup before cadence repair. Receipts cannot be replayed.
The watchdog refuses to rebuild selected isolated releases.

Receipts, validation logs, selected release and the durable transaction journal live
under `<control>/var/run/deployments`. A failed rollback retains its switching intent
and blocks further deployment; inspect the exact error before recovery. Candidate,
rollback worktrees and Git refs are never pruned by this workflow.
