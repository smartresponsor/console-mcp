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

## Privileged sealing protocol (not yet enabled)

The sealing service must run under a distinct local SYSTEM identity, with its
executable and configuration outside the developer-writable repository.
No interactive-user or general-purpose shell invocation is authorized.

The broker may request sealing only through a fixed operation with an explicit
validated, immutable request envelope:

- `schema_version = 1`, `operation = seal_new_release`
- `request_id`: fresh, single-use random identifier
- `source_sha`: exact 40-digit Git commit hash, verified against canonical master
- `payload_inventory_sha256`: digest of the canonical sorted (path, size, hash)
  file inventory; no absolute paths or reparse targets
- `release_id`: content-derived stable identifier; may not alias an existing root
- `rollback_release_id`: existing independently sealed rollback (never `latest`)
- `expires_at`: short bounded UTC deadline
- `authority_mac`: broker-authenticated request binding every field and
  the intended sealing-service identity

The service must accept only the designated staging namespace and create a
new exclusive destination under a SYSTEM-owned release-store parent. It must
reject an existing destination, path traversal, alternate data streams,
reparse points, hard-link surprises, unexpected files and inventory drift.
It must *copy and independently hash* data; never hardlink mutable worktree
members into sealed storage. All writes and ACL updates occur only inside
the not-yet-published destination.

After sealing, the service verifies every path component, release directory,
subdirectory and file ACL (including `DELETE_CHILD` on parent), plus the
complete signed file inventory. Only SYSTEM retains write authority; the
runtime principal receives the minimum ReadAndExecute required. Publish is
atomic under a transaction lock, with no replacement of existing content.

The receipt must be authenticated by the sealing service and include:
`request_id`, `release_id`, `source_sha`, `inventory_sha256`,
`release_path`, `sealer_identity = S-1-5-18`, `sealed_at`,
`verified_file_count`, `acl_policy_version`, and
`parent_path_identity`. Broker admission must verify receipt authenticity,
destination identity and current ACL/inventory again immediately before any
stop. Receipts are evidence, not authorization to bypass live gates.

Failure is terminal for that request: retain the incumbent and exact rollback,
quarantine incomplete staging as evidence, and never retry by deleting or
rewriting the original source, selected payload or authority journal.

## Canonical inventory digest (version 1)

`Get-ReleaseV3InventoryDigest` is a pure helper for the proposed request's
`payload_inventory_sha256`. Inputs are a mapping from relative forward-slash
paths to lowercase SHA-256 and nonnegative decimal byte sizes. Filenames with
traversal, root prefixes, colons/ADS, backslashes, control characters, empty
segments or case-insensitive collisions are refused. The helper sorts names
ordinally, encodes each row as `UTF8_BYTE_LENGTH:PATH:DECIMAL_SIZE:SHA256`,
joins rows using LF, and prepends the domain string
`console-mcp-release-inventory-v1` followed by LF. One terminal LF is included.
SHA-256 of those UTF-8 bytes, rendered lowercase hex, is the canonical digest.

This is **not** a signature. The sealer must independently enumerate and hash
the source and destination bytes, authenticate a fresh request through its own
privileged trust channel, and verify replay protections before publishing.
The new digest helper is not wired into live authority or activation and does
not create or certify immutable storage.

## Read-only source byte evidence

`Get-ReleaseV3SealSourceEvidence` enumerates a candidate tree without
traversing junctions or symbolic links, and compares each relative file
path, exact byte length and SHA-256 against a supplied canonical inventory.
Missing, unexpected, modified or reparse-point members fail closed. The
result is explicitly marked `authenticated=false` and
`mutation_performed=false`. A disposable fixture verifies both acceptance
and negative drift cases on the available test host.

**This attests source bytes only at observation time.** A privileged sealer
must still independently copy and rehash them from a trusted staging source,
protect the destination, prevent time-of-check/time-of-use races and issue an
authenticated receipt. No production sealing operation is enabled here.

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

