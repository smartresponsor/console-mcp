# Stage 3: live canonical storage admission (2026-11-02)

Status: **BLOCKED: PARENT_PATH_NOT_PROTECTED**. This document records observed facts; no production migration is authorized.

## Live read-only observations

Command: `/usr/bin/python3 -I ops/ubuntu/deployment/release-store-live-readiness.py`.

- systemd `console-mcp.service` active, MainPID 47820.
- Loaded `BindReadOnlyPaths` entries originate in `/opt/console-mcp-deploy/releases/a6909e7b117340755717877f5d73ce8be3ab91ea/`.
- Registry candidate `a6909e7b117340755717877f5d73ce8be3ab91ea`, rollback `6e0ac15c52a8153cc625252976fad59b6087985f`, transaction previously `committed`.
- Both selected manifests exist with matching `sourceCommit`; candidate has 4514 inventory entries, rollback 4513. These counts **do not constitute full hash attestation**.
- `/home/alex/smartresponse/mcp/.releases` does not exist.
- `/home/alex` is owned by uid 1000, mode 0710; `/home/alex/smartresponse` and `/home/alex/smartresponse/mcp` are uid 1000, mode 0775.

## Security gate

The Stage 2 protected selector demands every ancestor of `.releases` be root-owned and non-group/world-writable. The proposed path fails this requirement. A root-owned leaf beneath a mutable parent is not sufficient: a user with write permission on a parent could rename/replace the leaf. Do **not** `chown -R /home/alex`, remove developer access, weaken the selector, deploy new controls, create a pretend sealed store, or modify incumbent mounts.

## Decision required before artifact migration

The agreed logical names remain `.worktrees` and `.releases`, but the canonical physical path requires a secured mountpoint or other independently proven parent-integrity mechanism. The design must demonstrate that the runtime account, ordinary repository operator and other non-admin users cannot replace the release storage identity. Secure root-only state must remain independent of the mutable workspace. This may require locating the real sealed bytes on a root-owned filesystem and exposing a verified, mount-managed `.releases` view, but **do not treat an ordinary symlink or bind mount under writable ancestors as sufficient without explicit revalidation**.

After resolving the path identity threat: verify all release manifests and all payload hashes on both incumbent and rollback, stage byte-for-byte copies with metadata fidelity, prove rollback against the new store in a sandbox, then install controller bundle and transition the storage policy in an independently reviewed protected transaction. Never clean the legacy store until rollback and retention are approved.
