# Windows release transactions, schema 3

The interactive watchdog remains the only production process controller. Schema 3
adds executable prepare, activate, rollback, recover, validate and status operations.
Shipping `policy/runtime-release-v3.json` keeps production activation disabled.
A ready source checkout or passing isolated test does not enable production.

## Durable authority and receipts

`%LOCALAPPDATA%/ConsoleMcp/release-authority/<control-root-hash>` is outside MCP
repository roots. Its ACL allows only the current user and SYSTEM. Its random
HMAC key is DPAPI-protected for that user. Missing keys with existing state,
unexpected ACLs, reparse points, bad MACs and broken receipt chains fail closed.
No bearer token, environment-file content or browser credential is journaled.
Configuration is represented by keyed hashes. Local administrators and approved
same-user code remain trusted; this is not a boundary against a malicious administrator.

One exclusive OS file lock serializes validation, prepare, activation, rollback,
recovery and status. Receipt and selected-release records use flushed temporary
files and atomic replacement. Every receipt binds transaction ID, actual request
ID, monotonic sequence, previous receipt MAC, prior/next phase, broker generation,
login epoch, observation and timestamp. The signed state is retained outside the
caller-writable queue. Retried transaction IDs are idempotent; conflicting or
archived prepare IDs are refused. Broker module/policy content is fingerprinted
at startup and rechecked before privileged release actions.

The authority key has no automatic rotation. Key loss or corrupt/ambiguous state
requires operator reconciliation with preserved evidence. Do not delete journals,
recreate keys, rename terminal state, or toggle guards to make a transaction pass.
Legacy schema 1/2 journals are preserved and block silent schema migration.

## Switching and recovery

`PREPARED -> STOPPING -> STOPPED -> STARTING -> VERIFYING -> SELECTING -> COMMITTED`.
Failure after intent records `RECOVERY_REQUIRED`, then `ROLLING_BACK -> ROLLED_BACK`.
Rollback failure retains `RECOVERY_REQUIRED`. Startup recovery runs once before
normal watchdog repair. Further ambiguous failures suspend generic lifecycle
repair while leaving the control queue available; there is no endless restart loop.
Explicit recovery can retry after the cause is resolved.

Process identity includes PID, creation time, executable, command line, user SID
and session. A transaction launch marker distinguishes its candidate and rollback
from foreign listeners. Foreign/ambiguous processes are never killed. Interrupted
activation converges to the verified previous payload. If a stop was refused and
the original incumbent remained alive, its original selection is retained.

The runtime keeps its original control cwd, environment/credential resolution,
profiles and data directories. Release-relative admission code stays with the
selected build. Host-loaded policy files remain unchanged: an isolated candidate
probe authenticates MCP health, registry, workspace status and a read-only command
against exact copies of the active host files. The probe uses a high loopback
bearer port, synthetic credentials, its own transcripts, and the `smoke-test`
release-probe guard; it never starts external workspace watchdogs. That guard
rejects production managed tokens, non-loopback hosts and low ports.

Production verification requires all three profile listeners to belong to the
exact new process, authenticated MCP health/build/registry, OAuth/public challenge
checks, unchanged host configuration and unchanged browser/worker identities and
CDP targets. MCP smoke has a hard deadline. Native session/window/foreground
acceptance is required before stop. Compilation or a listening port is insufficient.

## Operator commands

Use a clean canonical master worktree for code and preserve the existing control
root. Commands below are interfaces, not evidence that current production gates pass.

```powershell
pwsh -File CODE/tool/runtime-broker-upgrade.ps1 -ControlRoot CONTROL
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 validate CODE FULL_SHA --submit
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 prepare CODE FULL_SHA EXACT_ROLLBACK
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 activate TRANSACTION_ID --submit
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 status
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 rollback TRANSACTION_ID --submit
pwsh -File CODE/tool/dev-console.ps1 -ControlRoot CONTROL release-v3 recover
```

`--submit` returns a durable correlation ID rather than depending on the runtime
being replaced to keep a caller connection alive. A timed-out/lost reply is unknown;
inspect authenticated state/receipts rather than dispatching another destructive action.
Validation runs typecheck, build, full tests and the host-configuration probe in
the broker context, then signs an exact-content report with a one-hour lifetime.
Prepare captures an exact, separately retained rollback payload and live identity.

The broker-only upgrade uses existing managed task installation/start controls,
retains the control root and starts in observe-only mode before a selected release.
It captures original task XML/bootstrap, hashes and a private DPAPI checkpoint.
`runtime-broker-upgrade.ps1 -ControlRoot CONTROL -Restore` restores that checkpoint.
Existing checkpoints are never overwritten. This does not itself deploy the Node release.

After remaining on-host acceptance is established, enablement must be a reviewed
canonical policy change followed by fresh broker/content validation. Editing a
running broker or flipping a local flag invalidates its code fingerprint. The
shipping disabled policy must not be bypassed with generic start/stop commands.

## Tests

`npm run test:runtime-production` exercises signed state, idempotency, failed
start/health, actual interrupted controller processes, rollback failure/recovery,
stale generations, cross-process locking, authenticated HTTP runtime switching,
preserved fixture data, deadline enforcement and owned fixture cleanup.
The interactive authority test covers DPAPI/ACL and broker identity refusal.
The temporary task-stop probe measures child survival without touching production.
The real broker fixture uses a fresh detached control worktree and temporary
interactive task to exercise queue dispatch and optionally full signed validation.
Its synthetic credential and authority cannot authorize a production control root.
