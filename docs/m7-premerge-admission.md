# M7 / M7.2: evidence-only pre-merge admission

This protocol is not production sealing or activation. Production prepare still
requires ancestry in `origin/master`. A pre-merge run ID is not a transaction ID
and cannot be used by validate, activate or rollback. M6 cutover remains disabled.
No privileged controller, policy or unit is installed by these source changes.

## Independent authorization and immutable inputs

The independently reviewed and installed broker must authorize protocol version
3 using a separate `premergeAuthorization` field in root-owned broker-policy.json:
exactly `sha`, `owner` and `expiresAt` (Unix epoch seconds). Do not grant the
corresponding SHA production authorization merely for a proof.

The independently reviewed root operators are
`/opt/console-mcp-deploy/premerge-admission.py` and
`/opt/console-mcp-deploy/premerge-bwrap-launcher.py`. Neither may be executed as
root from a mutable source checkout. The latter is called only by fixed
transient units through the installed admission operator. Root never imports
candidate code.

The separate root-owned premerge-policy.json has exactly these v2 fields:

    {
      "schemaVersion": 2,
      "sha": "<40 lowercase hex characters>",
      "cacheManifestSha256": "<64 lowercase hex characters>",
      "bundleSha256": "<64 lowercase hex characters>",
      "signerFingerprint": "SHA256:<43 base64 characters>",
      "expiresAt": 0
    }

Use independently verified real values and a live expiry not more than 24 hours
ahead. The root-managed `premerge-allowed-signers` must admit the exact signer;
a cryptographically good signature without a matched principal is rejected.

Inputs under `/opt/console-mcp-deploy/premerge-inputs/<sha>/`:

* `source.bundle`: complete Git bundle advertising refs/heads/premerge at the
  authorized commit. Fetch into a fresh bare repository and verify the SSH
  signature, exact SHA and pinned signer fingerprint.
* `npm-cache/`: dedicated, credential-free offline npm cache, provisioned
  independently by the administrator. No symlink, hardlink, special file or
  mutable developer cache is admitted. The complete relative file-to-SHA256
  mapping in `npm-cache.json` is pinned by cacheManifestSha256.
  Cache content must cover the signed lockfile; cache miss fails closed.

Legacy policy schemaVersion 1 remains available for an independently built,
root-provisioned artifact: replace cacheManifestSha256 with
artifactManifestSha256. This does not bypass signature, source, inventory or
runtime proof. The automatic build is v2.

## Automated isolated construction

The trusted operator extracts exact signed Git blobs (no worktree checkout,
candidate hooks, tar extraction, or mutable node_modules), validates the exact
TypeScript build contract and SHA512 integrity for every registry dependency,
and prepares a root-owned source snapshot. It starts a uniquely named transient
root launcher in a separate mount namespace containing a size-limited 1 GiB
tmpfs. The launcher verifies mount type, size and nodev/nosuid/noexec options,
then copies the admitted source and cache into that tmpfs. The candidate build
executes as real UID 993 with no supplementary groups, no capabilities and no
network, using fixed npm ci --offline --ignore-scripts and direct tsc invocation.
No npm lifecycle script is run.

After the Bubblewrap PID-1 process exits, only bounded regular dist outputs
are copied into the root-owned source artifact. Symlinks, hardlinks, special
files, excessive output and cache/inventory drift are rejected. The transient
unit is stopped and its cgroup checked before the operator computes and
reverifies the complete SHA256 inventory, Git source-member equality and dist
fingerprint. The receipt also records root-owned toolchain entrypoint digests
(bwrap, setpriv, node, npm CLI, Python, Git, libseccomp and installed operators),
rechecked after proof. This is not a complete OS image attestation. The evidence
store is NOT the production release store.

## Ubuntu systemd 255 isolation

Bubblewrap >=0.9.0 and libseccomp are required. There is no PrivatePIDs v257
dependency, host upgrade, or fallback to a weaker isolation model. The fixed
root launcher explicitly constructs private PID/mount/net/IPC/UTS/cgroup
namespaces; it does not remap host UIDs in a user namespace. This preserves
SO_PEERCRED semantics. The only privileged command inside the new namespace is
the fixed setpriv drop; candidate execution occurs after actual real/effective/
saved UID/GID, empty supplementary groups, all-zero capability sets,
NoNewPrivileges, seccomp and distinct namespace identities are checked.

The filesystem is an allowlisted, read-only root with system runtime libraries
and executables, minimal /etc, private /proc, /dev and /tmp. Host home, /run,
production /opt, credentials and production sockets are not bound. Seccomp
denies namespace creation/entry, mount operations, cross-process introspection,
keyrings, privileged kernel interfaces, io_uring, non-AF_UNIX sockets and
namespace-bearing clone flags. clone3 returns ENOSYS for ordinary pthread
fallback. Setup capabilities exist only in the reviewed launcher and are
irrevocably dropped before candidate code runs.

For handshake a single transient proof unit contains a bounded 64 MiB fixture
tmpfs and four separate Bubblewrap sandboxes. UID 1000 owns the fixture listener
and can write only that fixture and private temporary files. Engine UID 993 and
the independent wire witness bind the fixture read-only; a separate UID 1000
client must be denied. The actual captureOwnerBaseline entrypoint reads
root-owned config at its real production path inside the sandbox, verifies
release/config pins, and performs the authenticated IPC handshake. The
independent wire witness compares baseline and attestation and verifies
unknown-repository denial. The candidate proof never receives root privileges.
Transient unit resource limits, bounded output, mandatory cleanup and production
registry/runtime snapshot comparisons fail closed.

## Administrative capsule and independent provisioning (M7.3)

The ordinary-user cache preparer copies only exact lockfile tarballs by SHA512
from the current UID's npm content-addressable cache into a fresh dedicated
cache, discarding original metadata/headers. A separate cache copy must pass
actual npm ci --offline --ignore-scripts before the deliverable inventory is
published. No lifecycle script, credential or live node_modules is copied.
The verified cache can be handed to UID 1000 via the existing smartresponse
GID 1001, with group-read-only permissions on this specific generated cache.

The owner finalizer is `tool/m7-owner-finalize.py`. Its `--review` mode computes
an exact digest over the 13 explicitly enumerated source files. With `--commit`,
`--review-sha`, `--cache`, and `--cache-manifest-sha`, UID 1000 verifies that
reviewed source and cache, runs the focused regression, stages only those files,
creates the signed commit and verifies staged/committed file bytes, signature,
parent and lockfile. It fetches the exact integration branch into a private
bare repository to create a complete Git bundle with refs/heads/premerge,
without adding refs to the working repository. It produces a private home
capsule containing source.bundle, npm-cache/, npm-cache.json, capsule.json and
three reviewed operator files. The capsule receipt identifies all exact pins.
No push or root operation is performed by this owner script.

An administrator must independently review the three operators and pin their
SHA256, then transfer only that exact capsule to a protected root-owned
`/opt/console-mcp-deploy/premerge-incoming/<sha>/` via the existing approved
administrative procedure. No mutable checkout may be executed as root. The
admin independently provisions premerge-allowed-signers (do not automatically
trust a key supplied by the capsule) and the reviewed root-owned
`/opt/console-mcp-deploy/premerge-provision.py`. Its arguments are `--sha`,
`--capsule-sha`, `--admission-sha`, `--launcher-sha`, `--provision-sha`,
`--signer`, and a bounded `--lease-seconds`. It verifies the complete capsule,
operator pins, signed Git blobs, lockfile, and every cache entry; it holds the
existing broker lock and does not replace existing policy, inputs, or divergent
operators. A matching installed operator may be reused. It creates only the
separate premerge inputs, policy and evidence directories and independently
reviewed new operator files. The live release broker, production authorization,
registry, deployment transaction and units are not changed. The optional
explicit `--accept` invokes the new isolated operator while retaining the lock
and checking protected production state before and after. Existing partial or
expired provisioning must be reviewed administratively; never overwrite it to
force a retry. This is a separate privileged administrative gate, not an
escalation path available to the MCP runner.

## Acceptance and remaining administrative gates

The operator never calls production deploy, prepare, restart or rollback.
Its receipt under premerge-evidence is evidence-only with
activationEligible=false. No deployment transaction or production checkpoint
is created; the outer broker compares protected production registry/journal
and runtime status before and after and rechecks authorization.

The guarded script tool/m7-premerge-client.ps1 submits only a version-3
exact-SHA confirmed request or queries a v1 run ID. Its client checks root
peer credentials. It is not registered as a new public MCP capability.
The root operator installation, separately authorized input provisioning, and
live root-owned sandbox construction/handshake remain administrative acceptance
gates. Do not run repository scripts as root or modify the live broker merely
to obtain a green receipt.

Run tool/m7-premerge-regression.ps1 for existing broker and M7 regression.
This suite performs real disposable Git SSH signing and source extraction,
validates the actual package lock, tests copy and mount policy, compiles BPF
and installs that filter in a disposable unprivileged process. It does not
install the root launcher, create privileged units, or claim live Bubblewrap
proof. A failed unprivileged namespace probe is not grounds to relax host
isolation.
