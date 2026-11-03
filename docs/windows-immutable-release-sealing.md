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

## Durable replay fixture

The separate `tool/release-sealer-journal-fixture.ps1` exercises durable, signed reservation persistence in a marked temporary test directory. It reuses existing release-v3 atomic writes and exclusive writer locking. Cross-process tests cover restart/readback, duplicate identifiers, lock contention, wrong key, and journal corruption. This is a disposable test only; it does not provision keys, install a service, modify ACLs, or grant production authority. An actual Windows privileged authority and rollback-resistant persistence are still outstanding.

## Replay-journal reservation model (not persisted)

`Assert-ReleaseV3SealReplayJournal` validates the shape of an ordered replay
ledger, rejecting duplicate request IDs, reused release IDs, invalid phases
and nonmonotonic sequence numbers.
`Get-ReleaseV3SealReplayReservation` produces an explicit
`RESERVED` transition proposal and refuses consumed identifiers.
Neither function writes a journal or grants deployment authorization.
A valid result has `journal_authenticated=false`,
`reservation_persisted=false` and `authorization_granted=false`.

The actual SYSTEM-owned sealer must independently authenticate an existing
journal, hold an exclusive interprocess lock, atomically and durably append
the reservation *before* doing any privileged work, reject stale identities,
and preserve receipts across crashes. Reopening a consumed or uncertain
request must never repeat file publication. Shape checks alone cannot
provide replay prevention, durability, or concurrent-writer safety.

## Candidate and rollback pair integrity

`Assert-ReleaseV3SealReceiptPairBinding` rejects unrelated or replayed rollback receipts: candidate `rollback_release_id` must identify the independently sealed rollback, request/release IDs must be distinct, and both descriptors must carry exact 40-character source SHAs matching their receipts. Negative fixtures cover wrong rollback, duplicate request ID and a legacy source marker.

The Draft `prepare` path now reads rollback source SHA from the authenticated selected-release record, verifies that it is a canonical 40-hex SHA, and binds the supplied rollback directory and `dist/index.js` entrypoint to that selected release. No source SHA is guessed from the mutable filesystem or synthesized from a legacy marker. Missing/legacy selected SHA fails closed; a regression checks path, entry and identity mismatches.

**Remaining production blocker:** a selected record authenticated by the existing interactive broker is not itself a privileged sealer receipt. The SYSTEM sealer must independently attest exact rollback contents and SHA and issue the new signed receipt before activation; legacy selected releases without such evidence remain ineligible. No production cutover is authorized by this Draft branch.

## Signed inventory bytes at activation admission

The new `Assert-ReleaseV3ReceiptInventory` rehashes runtime members and checks their lengths, rejects files missing from or added to the release-v3 runtime inventory, and compares the canonical manifest digest with the signed receipt. The broker invokes it separately for candidate and exact rollback after receipt signature verification. The dedicated disposable regression fixture has now passed, including modified bytes, unlisted runtime member and mismatched digest cases. The code remains Draft and unprovisioned; these checks do not eliminate NTFS time-of-check/time-of-use risks.

## Receipt admission in the release broker

The Draft activation gate now requires signed receipts for candidate and rollback before ACL or browser admission. A separately provisioned SYSTEM-owned public trust key is mandatory; missing key, missing receipt or writable trust directory fails closed. This is not yet production-operable: neither sealed receipts nor the protected trust anchor are provisioned, and descriptor migration remains unfinished. No active Windows runtime is changed by this branch.

## Sealer-side receipt issuer (unprovisioned)

The Draft now includes `New-ReleaseV3SealerReceiptPayload` and `New-ReleaseV3SealerReceiptSignature` to produce an exact 12-field RSA-PSS/SHA-256 receipt envelope compatible with the existing broker verifier. `New-ReleaseV3SealerHostReceiptSignature` requires the actual Windows SYSTEM process token and Session 0 before signing. The test uses a transient RSA key to verify end-to-end issuer/verifier compatibility and reject malformed evidence, weak signing keys and unauthorized host environments.

**Security boundary:** the pure signer alone is not trusted authority. It accepts evidence supplied by its caller and must never be exposed to an interactive or untrusted process. Production still requires a protected private-key provider, authenticated broker transport, reserved journal state, independent source/destination inventory checks, immutable NTFS storage, and a correctly isolated service executable. No signing key, service, or production receipt is installed by this code.

## Native Windows NTFS ACL fixture

`tool/release-sealer-windows-acl-fixture.ps1` was executed using the guarded Windows PowerShell runner from a separate, isolated Windows test workspace. It reads the real NTFS owner and ACEs of a uniquely marked temporary directory, confirms that a non-SYSTEM-owned temporary directory cannot pass sealing policy, and requires full-parent-chain admission to refuse the path. The test returned `RELEASE_SEAL_WINDOWS_ACL_FIXTURE_PASS`, `user_temp_rejected=true`, `untrusted_chain_rejected=true`, `examined_ancestor_count=7`, and `production_changed=false`. It does not call `Set-Acl`, install services, alter the main Windows repository or change production releases. The actual tested owner was the Administrators group SID `S-1-5-32-544`, not LocalSystem.

The existing `release-sealer-acl-policy-regression.ps1` also passed on that isolated Windows workspace, covering allowed ReadAndExecute and rejected writable, generic-write, generic-all, inherited, and owner-mismatch ACL evidence.

This is evidence of **negative rejection** with native Windows ACLs, not positive validation of a properly provisioned SYSTEM-owned sealed release. A privileged positive fixture and permissions-preserving production release-store migration remain outstanding.

## Complete Windows ACL chain admission (read-only)

The Draft now contains `Assert-ReleaseV3AclEvidence` for low-level rights classification and `Assert-ReleaseV3WindowsProtectedPath` for checking the full directory ancestor chain, excluding the volume root. The receipt public key trust path and sealed release root use this check. The sealed release gate also applies it to runtime directories and files, detecting inherited grants, non-SYSTEM owners and non-SYSTEM mutation rights, including `DELETE_CHILD`, generic write and generic all. A regression verifies read/execute-only ACEs remain allowed and rejects these mutation rights. Earlier masks incorrectly ORed the composite `Modify`/`FullControl` rights, which overlap legitimate read bits; those were corrected.

These are read-only gates: native Windows NTFS fixtures, volume identity, actual effective-access, secure file-handle verification and TOCTOU protection still require live Windows validation. No permissions are changed and no privileged service is installed by this Draft.

## Independently verifiable signed seal receipt

`Assert-ReleaseV3SignedSealReceipt` verifies an RSA-PSS/SHA-256 signature over exact UTF-8 receipt payload bytes using only a trusted public key (RSA >=3072 bits). The intended privileged sealer alone retains the private signing key outside developer and broker authority. The verifier binds request ID, release ID, source SHA, inventory digest, rollback ID, destination path and parent-path identity to the caller's exact expectations, validates declared SYSTEM identity, file count, ACL policy version and a bounded timestamp. Test-only ephemeral RSA keys exercise valid receipts, wrong public keys, tampered payloads and mismatched expected values.

**This is signature verification, not release activation.** The deployment broker must still securely provision its trusted public key, independently recheck live NTFS ACL/inventory, authenticate the release-store path identity, check replay/transaction state and verify the actual privileged host before stopping any incumbent. The receipt verifier remains isolated from production dispatch, and no SYSTEM signing key has been generated or installed on the Windows host.

## Windows SYSTEM host identity gate

The new `Assert-ReleaseV3SealerHostIdentity` reads the Windows identity
from the **current process access token**, verifies the actual account SID
is `S-1-5-18`, and requires Windows Session 0. Its host-level wrapper
`Assert-ReleaseV3SealerAuthenticatedHostRequest` refuses to accept a
caller-provided `ServiceIdentity` string. On non-Windows hosts it fails
closed, and the regression verifies that behavior.

This is a necessary host precondition, not evidence of an installed service.
For real authority, the privileged binary and module load path must also be
protected against replacement by interactive users; caller identity and
request transport must be verified independently, keys must stay within the
protected SYSTEM boundary, and replay reservation must be durably committed
before any privileged operation. A SYSTEM account alone is **not** enough to
authorize an incoming request. The wrapper therefore still reports
`transport_authenticated=false` and `authorization_granted=false`.

## Authenticated request verification (not deployment authorization)

`Get-ReleaseV3SealRequestCanonicalBytes` serializes the strict v1 sealing
request in a fixed field order using UTF-8 length-prefixed values and a
domain-separation header. `Get-ReleaseV3SealRequestMac` derives HMAC-SHA256
and `Assert-ReleaseV3SealerAuthenticatedRequest` requires SYSTEM identity,
valid expiry and a constant-time MAC match. Tests reject changed commit SHA,
inventory, rollback, request ID, expiry, an incorrect key and a non-SYSTEM
identity.

An authenticated request still returns
`authorization_granted=false` and `replay_checked=false`. The shared
authentication key must be provisioned into a protected, separate SYSTEM
authority; it must never reside in the repo, an interactive-user environment,
or the request itself. A caller cannot grant itself SYSTEM authority merely by
supplying the text `S-1-5-18`: the deployed host must derive identity from
the actual process token and authenticate the broker transport independently.

**Not ready to execute:** request replay journal, sealer installation and
identity isolation, production staging namespace, privileged ACL changes,
independent post-copy verification, atomic protected publication, and a
sealer-authenticated receipt are still required. This branch does not start
or install that service.

## Disposable staging fixture (not a production sealer)

`Invoke-ReleaseV3FixtureStage` exercises the data plane of a future sealing
operation in a uniquely marked directory beneath the OS temporary directory.
It refuses an unmarked parent, an existing target and mutated source bytes.
Every source file is copied (never hardlinked), independently rehashed, and
the staged tree is verified before a rename to an unused fixture destination.
A separate regression covers acceptance, source drift and overwrite refusal.

The result is intentionally `RELEASE_FIXTURE_STAGED_UNSEALED` with
`production_ready=false`, `acl_sealed=false`, and
`broker_authorized=false`. This fixture has no authority to set NTFS
permissions, install SYSTEM services, publish to the canonical release store,
or trigger activation. A real Windows privileged sealer and live ACL tests are
still required. No staging result may substitute for an authenticated
privileged receipt.

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

