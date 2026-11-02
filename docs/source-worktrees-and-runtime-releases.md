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
