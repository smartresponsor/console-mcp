# Version-aware launcher and isolated transaction validation

Status: **BLOCKED for production activation**. The controller is an isolated
validation implementation, not a replacement for the production watchdog relay.
It does not transfer production listeners or change the running Silver runtime.

## Version contract

Both versions use explicit references, with no implicit runtime entry:

```json
{"manifest":"C:/immutable-release/version.json","sha256":"<manifest SHA-256>"}
```

The manifest has `schema: 1`, a 40-character source `commit`, an `entry` relative
to the manifest directory, and `files: [{path, sha256}]`. The entry must be one of
the verified files. Each file is hashed before launch and again before selection.
Traversal, duplicate files, missing entries and escaping symlinks are rejected.
The expected manifest hash is the deployment trust anchor: generate it from a
reviewed, clean, built release, and distribute it through the release authority.
Self-declared commit metadata alone does not establish build provenance.

Resolve a selector without starting a process:

```powershell
node tool/runtime-version-launcher.mjs resolve C:/isolated-selector/active.json
```

## Transaction contract

`runtime-version-transaction.mjs` verifies the existing version and authenticates
its MCP process identity before starting anything. It starts the candidate on a
separate loopback port, in a separate workspace, with a newly generated bearer
token and without inherited `CONSOLE_MCP_*` configuration. It requires HTTP 401
without credentials, then authenticated MCP initialize, tools/list and a positive
health response with the expected runtime PID and working directory.

The previous process stays running. Promotion uses a flushed, same-directory
temporary file followed by rename; the destination is never deleted first.
A durable journal records prepare/start/promote/selected phases. The controller
retains its lock while selected, monitors candidate health every three seconds,
and rolls back on health loss. A guardian owns the candidate, and loss of the
controller's IPC lease terminates that candidate. Recovery never kills a PID
read from disk. PID reuse or ambiguous cleanup blocks recovery safely.

Rollback stops the candidate, reauthenticates the previous process, restores the
previous selector atomically and records completion. Repeated rollback/recovery
is safe. A concurrent selector change is preserved and reported as an error.
If rollback cannot revalidate the previous runtime, the journal remains pending;
the controller must report an incomplete rollback instead of claiming recovery.

## Running the isolated launcher

Create `active.json` containing the previous version reference. Configuration:

```json
{
  "mode": "isolated-validation",
  "base": "C:/isolated-selector",
  "previous": {"reference": {"manifest": "C:/previous/version.json", "sha256": "<hash>"}, "pid": 12345, "port": 34001},
  "candidate": {"manifest": "C:/candidate/version.json", "sha256": "<hash>"},
  "port": 34002,
  "workspace": "C:/isolated-candidate-workspace",
  "timeoutMs": 20000
}
```

Inject the previous test runtime token as `RUNTIME_PREVIOUS_BEARER_TOKEN` in the
current process environment; never store it in configuration or commit it.
Run `node tool/runtime-version-launcher.mjs select C:/isolated-config.json`.
Keep the controller alive for the selected candidate's lifetime. SIGINT/SIGTERM
requests rollback; controller termination also causes guardian cleanup. After an
interruption, run `node tool/runtime-version-launcher.mjs recover C:/isolated-config.json`.
Do not manually delete a lock while its controller is alive. Ambiguous locks,
selector conflicts, unreleased ports or an unhealthy previous process need
operator investigation; do not kill arbitrary PIDs to clear them.

## Regression and evidence

```powershell
$env:RUNTIME_PREVIOUS_ROOT = 'D:/isolated-built-master'
node tool/runtime-version-transaction-regression.mjs
pwsh -NoProfile -File tool/runtime-recovery-audit.ps1 -OutputFile C:/evidence/recovery.json
```

The regression copies built runtimes, verifies manifests, uses real Node/MCP
processes and temporary workspaces/ephemeral ports, and writes
`var/runtime-version-evidence.json`. It covers success, startup/health failure,
timeout, candidate termination, automatic rollback after promotion, concurrent
controllers, interrupted promotion on both sides of rename, repeat rollback,
hash tampering and protected-port rejection. Cleanup proves that test listeners
are released. Evidence records hashes and PIDs; tokens stay out of evidence.
The audit script only reads production process, service and event information.
Keep runtime logs and transcripts outside Git.

## Production acceptance gates still required

- Integrate version resolution, working-directory selection, process discovery,
  freshness and rollback into the session-bound watchdog broker as one change.
  `Start-UnifiedConsoleRuntime` still uses its existing hardcoded entry; this PR
  intentionally does not activate an unvalidated production replacement.
- Validate production listener ownership/routing transfer. Isolated selector
  promotion does not redirect clients on 3333/3334/3335.
- Validate Windows Job Object ownership for abrupt guardian termination and
  descendant cleanup. IPC controller-crash cleanup is tested; guardian failure
  and machine power loss are separate boundaries. Same-volume rename is tested;
  storage power-loss durability has not been certified.
- Verify immutable release provenance and the complete dependency closure.
  Runtime JS and policy hashes are tested; shared test `node_modules` is not an
  immutable production dependency bundle.
- Run actual HWND cross-session denial tests with a second interactive Windows
  session. One console session cannot prove this boundary.
- Resolve the measured virtual-memory exhaustion before activation. Windows
  Event 2004 named codebase-memory-mcp.exe PID 14128 at about 66.3 GB around the
  incident; do not infer an SSH-caused shutdown from a coincident connection.
- Obtain explicit production cutover authorization. Keep master unchanged and
  submit the isolated branch as a draft PR; do not merge or restart production.

No canonical GREEN or production READY claim follows from these isolated tests.
