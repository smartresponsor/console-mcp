# M7.5: evidence-only pre-merge admission

This protocol is not production sealing or activation. Production prepare still
requires ancestry in origin/master. A pre-merge run ID is not a deployment
transaction ID and cannot be used to validate, activate or roll back a release.
M6 cutover remains disabled. These source changes do not install or update any
production broker, unit, policy, registry or release.

## Independent authorization and immutable inputs

Three independently reviewed operators are installed only by an authorized
administrator under /opt/console-mcp-deploy:
premerge-provision.py, premerge-admission.py, premerge-bwrap-launcher.py.
Never execute a mutable source checkout as root. The optional installed
broker protocol v3 requires its own exact-SHA authorization lease; the
independent administrative route does not change the production broker policy.

The separate root-owned premerge-policy.json uses schemaVersion 3 and binds:

- sha: exact 40-character candidate commit
- signerFingerprint: explicitly trusted ED25519 signer
- bundleSha256: exact complete Git bundle
- cacheManifestSha256: complete SHA256 cache inventory
- lockfileSha256: exact signed package-lock.json
- operators: exact SHA256 of all three independently approved operators
- expiresAt: bounded administrative lease

The privileged admission entrypoint rejects older policy schemas. A good
cryptographic signature without a matched trusted principal is rejected.
Do not automatically trust a key supplied by a capsule.

An administrator verifies the capsule and independent operator pins, then
transfers it through the approved administrative procedure to protected
root-owned premerge-incoming/<sha>/. No candidate execution occurs during
transfer. The provisioner hashes opaque bundle bytes; it does not parse Git
objects as root. It verifies every cache entry, the capsule manifest, operator
pins, and exact destination inputs before publishing the separate policy.

## Unprivileged source admission and build

A dedicated source transient unit runs the fixed installed parser inside
Bubblewrap, real UID 993, no supplementary groups, no capabilities, no
network. Its only inputs are read-only exact bundle bytes, root-provisioned
allowed-signers and the pinned installed parser. Its work area is a bounded
1 GiB private tmpfs. Git fetch, verify-commit, and extraction of exact signed
blobs run only inside this sandbox. The root Git parsing entrypoints explicitly
refuse UID 0. The fixed Git/SSH executables remain trusted toolchain components.

The launcher copies only bounded regular source snapshot files after PID-1
exit and checks immutable source inventory against the signed lockfile and
approved operator pins. No worktree checkout, candidate hooks, mutable
node_modules, live repository mount or root Git bundle parsing is used.

A separate bounded 1 GiB build tmpfs receives a copy of the admitted source
and pinned cache. The fixed UID 993 build runs npm ci --offline
--ignore-scripts and direct TypeScript compilation. All registry dependencies
must have exact SHA512 integrity pins. Only regular bounded dist outputs are
imported after sandbox PID-1 exit. Symlinks, hardlinks, special files, excessive
output and inventory drift fail closed. The complete artifact and source
inventory are reverified before the receipt. Toolchain entrypoint identities
are recorded and rechecked (including git, ssh-keygen, bwrap, setpriv, node,
npm CLI, Python, libseccomp, and the installed operators). This is not a full
OS image attestation. The evidence store is not a production release store.

## Isolation and independent proof

Bubblewrap >=0.9.0, libseccomp and systemd 255 are supported without a host
upgrade or fallback to weaker isolation. Private PID, mount, net, IPC, UTS and
cgroup namespaces preserve real host UID identities for SO_PEERCRED.
Under systemd UMask=0077, implicit Bubblewrap parent directories may become
0700. Explicitly create only synthetic /usr, /etc, /opt, /home and /run as
0755 before binding approved paths; keep the root read-only and private
fixture/build mounts unchanged. Verify traversal as the dropped UID before
executing a role. No host directory permissions or seccomp rules are relaxed.
The launcher supplies fixed synthetic passwd, group and files-only NSS entries
for root and the two sandbox UIDs. These root-owned files are individually
bound read-only and checked after UID transition. OpenSSH requires getpwuid
for signature verification even with a public key. No host account databases,
shadow files, credentials or supplementary groups are imported. Git failures
retain bounded, escaped stderr without weakening signature verification.
The launcher verifies UID/GID, empty supplementary groups, all-zero
capabilities, NoNewPrivileges, seccomp and distinct namespace identities before
executing a role. Host home, /run, production /opt, credentials and production
sockets are not mounted. Seccomp denies namespace creation/entry, mount
operations, cross-process introspection, keyrings, privileged kernel
interfaces, io_uring, non-AF_UNIX sockets and namespace-bearing clone flags.

The bounded 64 MiB proof fixture uses four isolated roles: owner UID 1000,
Engine UID 993, independent wire witness UID 993, and denied owner UID 1000.
The Engine uses the real production-path configuration resolver inside the
sandbox, checks bundle/config pins and rejects stale pins. Wire checks peer
credentials, response correlation, bundle/config identity and unknown repo
denial. A fixed independent oracle calculates the expected HEAD, statusHash
and preservation-v3 fingerprint from canonical fixture bytes. Both Engine
and wire results must match that oracle, not merely each other. This validates
the tested fixture, not arbitrary behavior of hostile candidate code.

## Durable administrative recovery

The owner finalizer tool/m7-owner-finalize.py uses --review to pin the five
explicit M7.7 synthetic identity and diagnostic remediation files. UID 1000 runs it with --commit, --review-sha,
--cache and --cache-manifest-sha. It verifies the exact cache inventory and
lockfile, focused regression, staged/committed bytes, trusted signature and
parent SHA. It creates a complete private Git bundle advertising
refs/heads/premerge plus a new capsule with three operator files. It does
not modify the earlier capsule or regenerate unchanged offline cache. No push
or root operation is performed by this script.

The provisioner holds the existing broker flock and writes its exact-identity
durable journal before publishing inputs, operators or policy. It accepts
--sha, --capsule-sha, --admission-sha, --launcher-sha, --provision-sha, --signer
and bounded --lease-seconds. --accept explicitly requests isolated admission;
--resume recovers the exact matching journal and input pins. Unrelated existing
policy, divergent operators and mismatched capsule identities are rejected.
A matching installed operator may be reused. Prior incomplete attempts are
reconciled before a new lease is authorized. No previous attempt receipt is
overwritten. A cleanup failure or production identity drift blocks automatic
resume and requires administrative review.

Controller execution uses a separate process group and retains the broker
lock across its lifetime. Timeout terminates the process group before cleanup.
Every transient unit intent is durably recorded before launch. Both cleanup
and continuity checks are attempted even on failure. Protected production
registry, transaction journal, broker/policy bytes, loaded release, boot ID,
PID and process start ticks are compared. Failure and success attempt receipts
are persisted independently of the journal transition. A successful isolated
receipt is evidence-only (activationEligible=false), not a production release.

## Acceptance boundaries

The guarded client is tool/m7-premerge-client.ps1. It requests evidence-only
protocol v3 or reads a run ID; the live broker is not updated by this workflow.
Root provisioning, live source/build/proof namespaces, cleanup and production
continuity require independent administrative authorization. Never run mutable
repository operators as root or bypass the existing broker lock.

tool/m7-premerge-regression.ps1 runs focused regression, including real SSH
signing and unprivileged Git extraction, independent oracle comparison against
real Git, kernel seccomp fixture, cache/inventory negatives, simulated systemd
and controller timeout, durable journal recovery and PID-reuse negatives.
Privileged root-owned Bubblewrap acceptance is not established by these
fixtures. The published candidate must remain draft until live evidence and
full exact-commit regression/CI are available.
