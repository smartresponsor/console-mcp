# Shared screenshot browser admission

The current capability remains fail-closed without explicit shared lease
configuration. The proposed activation files in ops/ubuntu/config are not
installed by the normal installer. No production unit is modified here.

## One lease authority

Use the Console-owned visible-browser-process-lock module (adapted from PR
#183). Both services run as console-mcp and use the same protected directory
/run/console-mcp-browser-leases, mode 0700, provisioned by tmpfiles. Never
fall back to PrivateTmp. The worker must load the admitted Console build,
not an unrelated mutable dist. The versioned isolated worker route is
authenticated and the Console-provided directory device/inode must match the
worker's independently inspected directory. This is a namespace consistency
check, not a new credential or authorization scheme.

For direct Screenshot execution the Console holds the exclusive browser
lease. For delegated isolated web routes the executing Worker owns that
lease; the proxy must not acquire it again. HTTP disconnection does not
release the Worker lease. It remains held through handler completion and
postcondition. The fixture demonstrates this with real HTTP and flock,
but uses mock CDP admission rather than a running Express worker.

## Watchdog and CLI rollout

Keep the watchdog timer and observation active. In shared-lease mode,
autonomous restart of Console or Edge is deferred, even when legacy
recovery opt-in is true. This is an explicit rollout restriction, not a
claim that root holds the unprivileged lock. Recovery must use the existing
coordinated release lifecycle. The maintenance script and owner Engine CLI
propagate the fixed lease configuration when the provisioned root exists.
Maintenance must not fall back to root identity during this rollout.

Apply the proposed drop-in to Console, Browsing Worker and Watchdog only as
a coordinated release. Verify other launch paths and existing drop-ins;
no claim of universal CDP exclusion is made.

## Activation blockers

Before installing the proposed drop-in on the participating services:

* Pin and verify both exact signed Console/Browsing release artifacts.
* Verify the worker's import resolves the admitted Console lock module.
* Verify effective unit environment (names/identities only, no secret
  values), UID, common directory inode, and actual write access.
* Validate all direct CDP consumers, including Engine CLI/reaper,
  watchdog/recovery paths, and any worker routes not using the shared
  lease. A cooperating flock does not exclude uncoordinated CDP clients.
* Validate exact worker route dispatch, endpoint and target identity,
  authenticated HTTP routing, and behavior when the worker is down or
  the release versions differ.
* Verify actual shared-message DOM, bounded capture, disposal and PNG
  delivery on the admitted runtime.
* Obtain release-broker and rollback evidence before activation.

Do not install a partial configuration, stop production services to evade
admission, or use a direct standalone screenshot script to bypass the
existing supervisor. This candidate is not approved for live deployment.

## Ubuntu pair inventory and transaction binding

The Console controller's `browsing-pair-admission.py` verifies the exact
sealed Console release from the existing protected store selector and an
exact Browsing release in `/opt/console-mcp-deploy/browsing-releases/<console-sha>/<browsing-sha>`.
The Browsing release manifest is schema 2 and includes its sourceCommit,
full files inventory, both package-lock digests in lockfiles, and a console
binding with sourceCommit, manifestSha256, leaseModuleSha256 and
sessionModuleSha256. A root-only mode 0600 policy at the fixed path
`/opt/console-mcp-deploy/browsing-pair-policy.json` must independently pin
schemaVersion 1, consoleSHA, browsingSHA, consoleManifestSha256 and
browsingManifestSha256. There is no default authorization. The verifier
never creates these artifacts or policy. The separate administrator-operated
`browsing-pair-seal.py` reuses an exact independent Browsing build receipt,
cleanup receipt and inventory, with independently supplied SHA256 pins.
It requires a preexisting sealed Console release in the selected store,
uses the existing broker and deployment locks, copies only verified regular
files, and publishes a pair-specific manifest without granting activation.
It refuses to overwrite an existing pair and revalidates exact reuse.
No rebuild is necessary for an unchanged Browsing artifact. Run
`tool/browsing-pair-seal-regression.ps1` for the isolated sealing fixtures.

For screenshot-capable releases prepare requires the verified pair before
creating a checkpoint. Validate rechecks the same pair before starting any
probe and after the probes, and binds the pair to both sandbox receipts.
The broker's transaction generation includes the pair binding; a changed
pair supersedes the transaction even if the Console SHA is unchanged.
Legacy releases do not require a Browsing pair. Pair verification is not
activation authorization: the existing preservation gate is unchanged,
and the controller explicitly denies paired cutover until the coordinated
switch and rollback implementation is admitted. No broker installation,
artifact sealing, service change or policy grant is performed by these
source changes. The paired cutover state machine in `browsing-pair-cutover.py`
records intent before each effect in the existing transaction journal and
uses an independently admitted, idempotent backend. Before a durable generation
decision, recovery re-quiesces, drains and restores the legacy generation.
After the decision is persisted, recovery only finishes ingress reopening
and journal finalization; it never rolls back potentially accepted work.
The persistent marker survives host reboot. The current legacy runtime has
no handler-drain protocol; a separate bootstrap admission must establish a
safe transition without treating queue or socket idleness as drained.
It is
fixture-tested only and is not wired to a live service adapter. The legacy
controller explicitly rejects paired recovery rather than restarting only
Console. A queue snapshot is not proof of transport ingress exclusion.

The Linux systemd runtime now checks the fixed root-owned
`/var/lib/console-mcp-deployment-quiesce` marker at actual tool-handler admission,
across all TCP and Unix projections. A valid marker contains a single
32-character lowercase hex generation followed by a newline. Invalid or
unreadable markers deny admission. The existing health tool remains available
and reports the marker generation and active non-health handler count. Handler
accounting is not released on transport disconnect. Detached tasks, external
CLI and CDP consumers still require separate quiescence evidence. The installed
incumbent must independently demonstrate protocol support before an operator
uses this gate for cutover; a newer candidate cannot retroactively drain it.
The candidate regression uses linked SDK transports and inert handlers;
F30 separately exercises the real candidate socket/OAuth projection in smoke
mode. Neither result constitutes a live production drain.

`browsing-pair-live-witness.py` adds independent process, mount namespace,
listener, module hash, shared inode and authenticated status checks. Its
HTTP checks only use worker drain status and an unknown delegated route;
they do not send browser actions to a live worker. The separate Express
status regression exercises the actual candidate worker on an isolated
loopback port, with synthetic credentials and drain/resume of that fixture
process only. Actual delegated browser dispatch, privileged namespace
witnesses and safe legacy ingress migration are not established by this test.

The `browsing-pair-publication.py` helper reconciles the six exact environment
and unit drop-in files under the existing journal and deployment lock. It
preflights the entire file set, uses protected directory descriptors,
fsync and Linux renameat2 RENAME_NOREPLACE, and refuses conflicts or links.
Rollback removes only exact expected files; newly created empty drop-in
parent directories are intentionally retained. No daemon reload occurs in
this helper. The fixture suite exercises interruption after every file,
including a real child process exit after atomic publication. It does not
publish live configuration or start/stop services.

The `browsing-pair-lifecycle.py` composition implements explicit forward
and rollback operations and binds each operation to the journal identity.
Its integrated fixture exercises the actual publication helper with a fake
host service adapter; no production systemctl backend is admitted. In
particular the current Browsing worker starts with its in-memory drain
controller open. A post-start drain request alone cannot establish startup
exclusion. Require an independently verified startup barrier (or an admitted
Browsing successor) before starting the worker. The incumbent Console has
no ingress protocol, and Preservation and external-consumer admission remain
separate mandatory prerequisites. A successful fixture is not activation
permission.

Run `pwsh -NoProfile -File tool/browsing-pair-admission-regression.ps1`
for isolated inventory, policy, transaction-binding and legacy broker
regression fixtures. These do not establish independent Browsing build
provenance, runtime dispatch, drain, shared inode or live PNG acceptance.
