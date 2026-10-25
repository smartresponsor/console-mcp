# Release switching contract (Windows Console MCP)

## Safety boundary

The deployment controller MUST run outside the managed Node.js runtime. The
existing interactive-session watchdog broker is the sole process authorized to
stop or start that runtime. Remote SSH/ChatGPT callers may only enqueue a
durable, correlated request. No direct Start-Process from an SSH session.

## State machine

PREPARED -> SWITCH_REQUESTED -> STOP_CONFIRMED -> START_REQUESTED ->
HEALTH_VERIFYING -> COMMITTED

On failure after STOP_CONFIRMED:
ROLLBACK_REQUESTED -> OLD_RUNTIME_RESTORED -> ROLLED_BACK

On ambiguous broker receipts:
RECOVERY_REQUIRED (do not enqueue a duplicate destructive request).

## Prepare

- Pin a full 40-character Git SHA; use a separate, clean worktree.
- Require build, tests, deployment preflight, and complete dependency tree.
- Persist the old runtime identity (PID, executable, working directory, SHA,
  ports, session, watchdog generation) and candidate manifest.
- Reject if the watchdog is unhealthy, an existing switch is incomplete, or
  the old runtime's actual entrypoint cannot be identified.
- Never mutate the active checkout or browser profile.

## Commit

- Use a single-flight durable transaction ID and atomic journal writes.
- Validate broker generation and interactive Windows session before dispatch.
- The existing Start-UnifiedConsoleRuntime currently hardcodes
  `$Root/dist/index.js`. Implement an explicit, validated release entrypoint
  parameter in the watchdog-owned launcher before enabling commit.
- Change the selected release only inside the watchdog broker. The caller
  must not stop its own server.
- Stop the old PID with confirmation; start the candidate; verify ports 3333,
  3334 and runner port, authenticated smoke, tool schema, and browser session.
- A port-open check alone is not sufficient.
- Keep the previous release and manifest until explicit retention cleanup.

## Rollback and recovery

- On failed health checks, use the watchdog to stop the candidate and start
  the exact previous entrypoint, then re-verify all endpoints.
- If the watchdog dies mid-transaction, its next generation must reconcile
  journal + observed process identity before attempting recovery.
- If the result is ambiguous, stop automatic mutation and report
  RECOVERY_REQUIRED. Never claim success from a timed-out request.
- A crash between stop and restart may cause downtime; the release switch is
  transactional with rollback, not zero-downtime or a single atomic OS process
  replacement.

## Isolation

- Do not delete, reset, stash, or update dirty Windows/Ubuntu worktrees.
- Do not start CanonScanning. Preserve dispatch-stop.json unchanged.
- No live runtime switch without explicit operator authorization.
- Tests must exercise failure after stop, candidate launch failure, failed
  health check, broker restart, duplicate requests, and rollback failure.
