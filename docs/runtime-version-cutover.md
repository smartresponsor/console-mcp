# Version-aware launcher and isolated transaction validation

Status: **BLOCKED for production activation**. The branch includes an opt-in
Watchdog validation action and a selector-driven stateless bearer router. They
operate only on isolated ports. The running Silver runtime and Watchdog are not
reconfigured or restarted by these changes.

## Version contract

Both versions use explicit references, with no implicit runtime entry:

```json
{"manifest":"C:/immutable-release/version.json","sha256":"<manifest SHA-256>"}
```

The manifest has `schema: 1`, a 40-character source `commit`, an `entry` relative
to the manifest directory, and `files: [{path, sha256}]`. The entry must be one of
the verified files. Each file is hashed before launch and again before selection.
Traversal, duplicate files, missing entries and escaping symlinks are rejected.
Schema 2 additionally verifies an exact runtime/dependency inventory, the pinned
Node version, lockfile hash, and fresh `npm ci --omit=dev --ignore-scripts` install.
Registry integrity values and installed package versions must match the lockfile.
Unlisted dependency files are rejected. The runtime's mutable `var/` logs are
excluded explicitly; they are not dependency or executable release content.
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
controller's IPC lease terminates that candidate. On Windows, a native host uses
`PROC_THREAD_ATTRIBUTE_JOB_LIST` to assign a kill-on-close Job at process creation,
then resumes the suspended child. Only stdin/stdout/stderr handles are inherited.
Host death kills descendants in the kernel, including the pre-resume boundary.
Recovery waits for runtime, guardian and native host exit and never kills a PID
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

Additional regressions:

```powershell
npm run test:runtime-memory
npm run test:runtime-routing
pwsh -NoProfile -File tool/runtime-memory-telemetry.ps1 -OutputFile C:/evidence/memory.json
```

See [memory incident evidence and containment](runtime-memory-pressure.md) for
the confirmed trigger, supported mitigation, calibration and recovery policy.

## Watchdog and routing integration

`85-session-relay.ps1` exposes `validate-runtime-version` only when the broker's
`RunDir/runtime-version-validation.json` exists. Its handler requires the actual
active nonzero Windows console session and the configured session ID to agree.
It resolves both schema-2 releases and invokes `runtime-watchdog-validation.mjs`.
That helper authenticates the previous route, selects the candidate transaction,
authenticates the routed candidate PID, rolls back, authenticates the previous
routed PID, and closes all temporary listeners. The broker queue retains its
generation/login-epoch checks and writes its normal durable receipt.

The configuration extends the isolated launcher example with `expectedSessionId`,
`routerPort`, `maxRequests` and `maxBodyBytes`. Inject the front-router token as
`RUNTIME_ROUTER_BEARER_TOKEN`, alongside the previous backend token. Do not place
tokens in the JSON configuration. The router streams requests with backpressure,
has a fixed two-version table, bounds concurrent requests and request sizes, and
never retries a possibly executed request. A selector change affects subsequent
requests. Stateful MCP sessions are refused; this runtime uses stateless HTTP.

No validation configuration was installed in the production RunDir. The existing
production launch path stays unchanged. The session-0 broker refusal and the
separate real Node routing/rollback path are tested; a successful invocation by
an isolated interactive Watchdog broker is still required.

## Production acceptance gates still required

- Complete successful interactive broker validation, production process discovery
  and freshness checks using the selected release. The dormant validation action
  is implemented, but the legacy production start path still uses its fixed entry.
- Validate actual OAuth issuer/metadata behavior, canonical listener handoff,
  outstanding requests, proxy ownership and rollback on 3333/3334/3335 in an
  isolated replica. Bearer routing tests do not prove production OAuth handoff.
- Certify release filesystem ACL immutability, build/source attestation and
  storage power-loss durability. Dependency SRI, exact file hashes and abrupt
  guardian/host/descendant containment are now tested.
- Run actual HWND cross-session denial tests with a second interactive Windows
  session. One console session cannot prove this boundary.
- Keep legacy automatic indexing disabled. Calibrate and activate the bounded
  gateway against representative real projects and long-running workloads;
  the 1,000-file/100-query pilot is not full-platform capacity certification.
- Obtain explicit production cutover authorization. Keep master unchanged and
  submit the isolated branch as a draft PR; do not merge or restart production.

No canonical GREEN or production READY claim follows from these isolated tests.
