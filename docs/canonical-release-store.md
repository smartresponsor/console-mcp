# Canonical release storage: target contract and migration gate

Status: **TARGET CONTRACT, NOT ACTIVE DEPLOYMENT** (2026-11-02).

The common workspace root on Ubuntu is `/home/alex/smartresponse/mcp/`.

- `.worktrees/`: Git-managed, mutable development/review/release-preparation worktrees.
- `.releases/<full-SHA>/`: independently verified, immutable runtime release artifacts. Must be owned/protected so that the Console MCP service cannot modify them.
- `console-mcp/`: main Git checkout (source), **never** a production deployment artifact.
- `/opt/console-mcp-deploy/`: presently **live administrative controller**, transaction journal and legacy artifact storage. Its existence is not the canonical location for future release artifacts.

The canonical artifacts path is `/home/alex/smartresponse/mcp/.releases/<full-SHA>/`.
No second artifact store or duplicate Git worktree is permitted as an independent production authority.
The selected active and rollback identities reside in a protected registry, and the registry must never be relocated into a service-writable directory.
Controller binaries, root-only policies, socket, checkpoints and transaction journals can remain under protected `/opt/console-mcp-deploy/`: **release artifact placement and controller authority are separate concerns**.

## Live migration: blocking gates

1. Confirm the exact current source SHA, active bind-mount release and rollback from systemd, not just historical registry files.
2. Enumerate old and target stores using `/usr/bin/python3 -I ops/ubuntu/deployment/release-store-audit.py`. Classify non-SHA and manifest-incomplete legacy entries; do not assume they are eligible for migration.
3. Independently verify root ownership, protected ancestors, complete manifests and all payload hashes of both incumbent and rollback before and after transferring into `.releases`.
4. Verify `.releases` is **not** symlinked and is inaccessible for modification to the Console MCP service account; ACLs/parent permissions matter, not only `chmod` on the leaf.
5. Amend deployer/prepare/broker/gates/systemd configuration to load the release-store path from **one root-owned deployment contract**, not from environment variables supplied by MCP or callers. Explicitly test stale-registry, crash, lock, migration interruption and rollback conditions.
6. Perform isolated sandbox admission and verified rollback proof under real production hardening before proposing cutover. Never change both the active and rollback roots in-place.
7. Switch through the existing serialized protected transaction only; preserve `/opt/console-mcp-deploy/releases` as a recovery source until production and rollback verification plus retention approval.
8. Prevent new seals into the legacy root only after the new store has proved equivalent and the protected controller policy has been deployed.

## Stage 2 implementation (policy selector, not deployed)

The protected controller can now use a single `/opt/console-mcp-deploy/release-store.json` contract with exactly these fields: `schemaVersion: 1`, `mode: legacy|canonical`, `artifactRoot`, `migrationAdmitted: boolean`. The allowed canonical root is fixed in reviewed code; no arbitrary path or environment override is accepted. The file, its ancestors, and the canonical artifact directory and ancestors must be root-owned without group/world write permission; symlinks are refused. This parent protection is crucial because a root-owned `.releases` directory below an alex-writable parent can otherwise be renamed or replaced.

When the protected policy does not exist, legacy storage remains selected. The canonical mode refuses to operate unless an administrator has explicitly recorded `migrationAdmitted: true` and installed the protected directory. `deploy.py`, `prepare.py`, `gates.py`, `permissions-check.py` and the sealer resolve the artifact root with this contract. These scripts **must be installed as one reviewed, root-owned controller generation** along with `release-store-selector.py`. Never install just an individual changed script or switch the protected policy while the old controller is running. The existing service's loaded mounts and rollback must still be independently proved before switching the policy.

**Current state:** the live Ubuntu controller still seals and activates from `/opt/console-mcp-deploy/releases/`. This documentation and audit introduce no runtime change, do not create `.releases/`, and do not modify root-owned production.
