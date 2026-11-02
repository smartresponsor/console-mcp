# Source worktrees and immutable runtime releases

Status: architecture contract, based on the canonical master at
`9816aa8636aec61312714ab358227aa9f0a7f6be` (2026-11-01).

## Core rule

`master` is the protected, integrated source of truth. A worktree is a mutable
Git development workspace. A release is a separately materialized, verified,
immutable runtime artifact. Production MUST execute a registered release, never
the mutable `master` checkout or a development worktree.

These are different lifecycle objects and must not be collapsed into one folder.

## Responsibilities

### Git worktrees

Git worktrees are used for feature work, integration, review, validation and
release preparation. They are ordinary Git working directories attached to
specific branches/commits and share Git object storage with their common Git
repository. Their source files are mutable; builds and tests may create local
outputs. A worktree is disposable only after its branch/commits and any local
changes have been preserved and reviewed.

The `.worktrees/` directory is a workspace-placement convention, not a runtime
artifact store and not a source of production authority. Git's worktree metadata
is maintained by Git; do not manually edit `.git/worktrees` or infer worktree
existence from directory names alone. Worktrees must be registered/unregistered
with Git worktree commands/tooling.

### Releases

A release is produced from an exact full 40-character commit SHA already
reachable from canonical `origin/master`. Its payload is materialized from
committed Git bytes, built with pinned dependencies, verified, and sealed.
It has a `release.json` containing at least the source commit, build fingerprint
and file inventory/hashes. A release is never edited in place or overwritten.
Any change creates a new release identity. The active and exact rollback
releases are retained until an independently reviewed retention operation.

The release registry is deployment authority, not Git history. It selects the
candidate and rollback release IDs and must be updated only through the
privileged, serialized deployment transaction. A directory existing on disk
does not make it active or eligible to run.

## Current platform-specific layout

### Ubuntu

The implementation in `ops/ubuntu/script/prepare-console-release.py` and
`ops/ubuntu/deployment/deploy.py` currently uses the protected deployment root:

```text
/opt/console-mcp-deploy/
  releases/<full-commit-sha>/
    release.json
    dist/
    node_modules/
    ...runtime payload...
  registry.json
  transaction.json
```

`prepare-console-release.py` requires a clean source checkout at the exact SHA,
requires that SHA to be an ancestor of `origin/master`, extracts committed bytes
with `git archive`, builds in a new staging directory and verifies/seals the
result. Its documented preparation path does not update the registry or restart
the service. The root-owned `deploy.py` verifies the sealed candidate and
rollback, applies the systemd bind-mount override and performs the guarded
transaction. The live source-shaped path is `/home/alex/smartresponse/mcp/console-mcp`;
the deployment override bind-mounts release payload directories over that path.
Therefore the visible service path alone is not proof of the underlying release:
the bind-mount source, registry, manifest and running process identity must agree.

### Windows

Windows has a separate schema-3 release broker and a durable release authority
outside the repository under `%LOCALAPPDATA%/ConsoleMcp/release-authority/`.
The interactive watchdog broker is the only production process controller.
It validates the candidate, authenticates transaction receipts, binds the
selected payload to the full source SHA and performs activation/rollback only
after all required gates. The release authority/journal is not a worktree and
must not be placed inside a caller-writable repository checkout.

The exact Windows payload root is owned by the release broker/control-root
configuration. Do not assume it is `.releases/` or create a second release tree
until the broker's configured root and selected-release record have been read
from the live machine. The Windows and Ubuntu physical directory layouts need
not be identical; their release identity, source SHA and verified payload
fingerprint must be consistent when they represent the same build.

## Do not duplicate the repository

Do not copy an entire `.worktrees/<name>` directory into a release. Do not keep
an additional `.releases/` tree inside the Git repository when the platform's
protected release root already exists. Materialize only the runtime payload
required by the release builder, plus its manifest and verification metadata.
The release must be independently runnable and must not depend on the continued
existence of its source worktree or its `.git` metadata.

Expected duplication is limited to the intentional build artifact: source files
and build output in a worktree versus the sealed runtime payload in the release
store. This is not a second development checkout.

## Lifecycle and invariants

1. Develop in a feature/integration worktree.
2. Review and merge through PR into protected canonical `master`.
3. Fetch the exact canonical SHA into a clean release-preparation worktree.
4. Validate, build and materialize committed bytes into a unique staging area.
5. Verify file inventory, dependency lock and build fingerprint; seal and publish
   a new immutable release directory.
6. Register candidate and exact rollback through the platform deployment
   authority. Never edit registry state by hand to bypass a gate.
7. Activate through the platform's serialized controller only after fresh
   acceptance gates. Verify process identity, actual mounted/selected release,
   authenticated health and browser/session continuity.
8. Retain the previous release for rollback. Garbage-collect only unreferenced
   releases after retention and backup checks.

## Operational safety

- A Git merge does not deploy or activate a release.
- A successful build does not prove the running process uses that build.
- A healthy runtime does not prove which release it executes.
- Never restart a healthy production process merely to discover its source.
- Determine live source read-only from process identity, systemd bind mounts or
  Windows selected-release authority, registry, manifest and payload hashes.
- Never reset/clean a dirty worktree to make it match `master`; inspect and
  preserve local changes first.
- Never restore diagnostic stashes wholesale into canonical `master`.
- Keep source consolidation, release preparation and production activation as
  three separately evidenced operations.

## Central provenance capability

The single read-only command is `runtime-release-provenance`, exposed as
`read_.runtime.release.provenance`. Its implementation is centralized in
`tool/dev-console.d/97-runtime-release-provenance.ps1`; it does not add checks
to individual capabilities and never activates, restarts, repairs, or mutates
deployment authority.

On Ubuntu it reads the systemd MainPID, process executable/CWD/argv entrypoint,
`BindReadOnlyPaths`, the protected registry and transaction journal, then
compares the mounted release identity with `release.json` and its complete
SHA-256 inventory. Raw process command lines are not persisted. On Windows it
uses the existing DPAPI-authenticated selected-release record, descriptor
verification and the live listener process identity.

## Current implementation status at this checkpoint

- Ubuntu live provenance was read successfully on 2026-11-02. PID `47820`
  executes `/home/alex/smartresponse/mcp/console-mcp/dist/index.js`, while
  systemd binds 11 runtime paths from
  `/opt/console-mcp-deploy/releases/a6909e7b117340755717877f5d73ce8be3ab91ea/`.
  The registry candidate and source SHA both equal
  `a6909e7b117340755717877f5d73ce8be3ab91ea`; the release manifest and full
  file inventory verified, with build fingerprint `98c72365561a666a`.
  The registered rollback release is `6e0ac15c52a8153cc625252976fad59b6087985f`.
  This proves Ubuntu is executing a sealed release, not files from the mutable
  checkout. It is an older release than canonical master `9816aa8`; no claim
  is made that production is running the latest master.
- Windows schema-3 transaction design and broker authority are implemented in
  source, but live selected payload, DPAPI authority and process binding remain
  unverified. The current Windows CLI did not expose `release-v3 status` in
  its active ValidateSet, so no alternate mutation route was attempted.
- The provenance capability is implemented and registered in this checkpoint
  branch. Its Ubuntu path was executed successfully against the live service.
  The Windows path still requires validation in the appropriate interactive
  broker context; no restart is required for that read-only inspection.
- `.releases/` is not the current Ubuntu deployment path. The canonical
  implementation uses `/opt/console-mcp-deploy/releases/`. No duplicate
  in-repository `.releases/` directory should be introduced by convention alone.
- This capability and document change no runtime, registry, systemd unit,
  Windows task, release selector, production process or deployment state.
