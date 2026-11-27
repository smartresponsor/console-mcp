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
