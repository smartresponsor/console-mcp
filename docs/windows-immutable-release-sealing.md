# Windows immutable release sealing — admission and authority boundary

Status: fail-closed admission implemented; privileged sealing and migration are NOT yet implemented.

## Why a clean Git worktree is not a sealed release

The currently selected Windows production release is a detached Git worktree.
Its descriptor hashes can verify successfully even though NTFS ACL inheritance
allows ordinary developer and sandbox identities to modify the payload.
ReadOnly file attributes do not establish a security boundary. The same-user
interactive watchdog cannot securely seal content against another process
running under that same user identity.

## Required production architecture

1. A dedicated privileged SYSTEM-owned sealing service must materialize a NEW
   release under a protected, non-developer-writable release-store parent.
   It must never overwrite the selected or rollback release in place.
2. The service must authenticate the exact prepared source SHA, verify all
   committed runtime bytes and the signed descriptor before changing ACLs.
3. It must remove non-SYSTEM write grants on the parent, release root,
   all intermediate directories, and runtime payload members. The release
   must remain readable/executable by the runtime account.
4. The service must produce authenticated evidence binding release identity,
   source SHA, file SHA-256 inventory, ACL verification, effective owner,
   sealing-service identity and a monotonic transaction ID.
5. The broker must verify candidate and exact rollback seals before stopping
   the incumbent. Any inherited ACL, non-SYSTEM write grant, reparse point,
   ambiguous owner, changed manifest or unsafe path fails closed.
6. The selected runtime must execute only that exact sealed entrypoint.
   Recovery remains via the existing serialized authenticated broker.
7. If sealing or admission fails, do NOT stop the existing process. Preserve
   the registered rollback and evidence for operator reconciliation.

## What is implemented in this change

`tool/dev-console.d/85-release-v3-sealing.ps1` implements a read-only
`Assert-ReleaseV3SealedStorage` check. The schema-3 broker calls it on both
candidate and rollback in `Assert-ReleaseV3ActivationGates`, before release
activation is permitted. The check intentionally fails for the current
developer-owned worktree layout. It does not change ACLs, release files, the
registry, or the running process.

This is a *pre-activation safety gate*, NOT a complete sealing workflow,
and not evidence that Windows currently runs from immutable storage. The
SYSTEM-owned sealing service, full path-component reparse/effective-access
verification, cross-session and rollback fixtures, and release-store migration
remain required before enabling this gate in production.

