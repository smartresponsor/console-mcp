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

## Native SCM service executable skeleton (compiled; not installed)

`ops/windows-sealer-service/` now contains a standalone `net10.0-windows` SCM executable project with direct Windows service dispatch callbacks. It is limited to the fixed `ConsoleMcpReleaseSealerV3` service name, requires an actual LocalSystem token in Session 0, reports service state to SCM, accepts STOP/INTERROGATE controls, and has **no** request listener, private-key loading, file sealing, service installation or production deployment logic. It is a non-operational skeleton that intentionally cannot perform sealing.

Source policy regressions passed on Ubuntu and in the isolated Windows workspace. Read-only SDK discovery confirmed **no .NET SDK on either Ubuntu or Windows**, although Windows has the `dotnet` host. The new service targets .NET 10 LTS because Microsoft ends .NET 8 support on November 10, 2026. The service-local `global.json` pins SDK `10.0.403` (`latestPatch`, no prereleases). `tool/release-sealer-isolated-sdk-build-fixture.ps1` can fetch the official Microsoft Windows x64 ZIP only inside an explicitly named disposable Windows workspace, verify the published SHA-512 (`7a114c318fa7f1d9822991b534b2814d0e78386ceda816b371f5141acefe741d87ccb606ede06cadac8f9ac5070e32b708a67bbd1619ff5e5a7858a27874ef48`) before extraction, and compile a framework-dependent Windows executable without machine-wide installation. It never installs an SDK machine-wide or registers a Windows service. A verified isolated Windows build with SDK `10.0.403` now **passes with zero warnings and zero errors** and produced the framework-dependent `ConsoleMcp.Sealer.Service.exe` (SHA-256 `4ad558cac411bf6088df8f4e30692495d025be8e149601c94133a6bbb1597a7d`). The binary was executed twice under an interactive Windows user: without arguments and with `--install`, both returned access-denied exit code `5` and did not mutate production. Initial self-contained publication failed at NuGet runtime/ILLink package resolution (NU1100) and is not claimed. A real SYSTEM Session 0 SCM registration, live service lifecycle, protected service installation and transport are not yet verified; no SDK or service was installed machine-wide.

## Self-contained Windows x64 build and negative execution proof

The initial self-contained publish failed because the isolated SDK had no configured NuGet sources, and the runtime/ILLink packs were not locally present. A **new** disposable-only script, `tool/release-sealer-self-contained-fixture.ps1`, restores these packs from an explicitly specified official NuGet v3 source, with `NUGET_PACKAGES` and HTTP cache confined to the isolated Windows test workspace. It does not change machine NuGet configuration or production services.

The official SHA-512-verified SDK `10.0.403` successfully published the **self-contained** `win-x64` `ConsoleMcp.Sealer.Service.exe` in `D:\PhpStormProjects\www\sealing-acl-fixture-20261102\ops\windows-sealer-service\bin\Release\net10.0-windows\win-x64\publish\`. Recorded executable SHA-256: `29baee9e3e674a2161fae9ac55041015b6564be4e7ff66a9164ab474f15073e8`.

The binary was executed as an interactive user **without the isolated SDK runtime environment** and denied both normal launch and `--install` launch with exit code `5` (Access denied). The exact binary hash was verified before testing. This is a native Windows negative-execution proof, **not** a positive SYSTEM Session 0 SCM service test. No service was installed or started, and production was unchanged. This build remains an inert service skeleton without privileged sealing, key custody, journal or transport.

## Crash-durable replay claim primitive (pending native Windows regression)

`SealReplayJournal.TryClaim` has been introduced as an **unwired, non-authorizing** primitive using a previously created caller-provided journal directory. It atomically creates a uniquely named `<32-lowercase-hex-request-id>.claim` file with `FileMode.CreateNew`, `FileOptions.WriteThrough` and `Flush(flushToDisk: true)`. Duplicate request IDs are refused, and a partial or corrupt claim is never deleted or retried automatically. There is no request replay-reset or seal authorization path.

A dedicated native Windows regression was authored to check duplicate denial, twelve simultaneous claims with a single winner, truncated pre-existing claims, invalid IDs and absent journal root. **Its execution has not been verified**: the Windows script runner refused the test invocation, so no Windows test PASS, persistence-across-power-loss guarantee or durable authorization claim is made. Existing Ubuntu PowerShell checks are unrelated to the C# journal's runtime behavior.

The journal currently lacks a SYSTEM-only directory/ancestor ACL admission, immutable journal root provenance, authenticated record-to-request binding, forensic recovery rules and integration into the privileged service. It must not be used by any live SYSTEM listener or trusted for release sealing until those controls and native Windows tests are complete. No production files, secrets or services were changed.

## Protected HMAC authority file admission (not provisioned)

`SealAuthorityFileAdmission.Check` adds a read-only, fail-closed native Windows gate for the future fixed authority file `C:\ProgramData\ConsoleMcp\seal-authority\broker-hmac.key`. The function requires the **real** process token SID `S-1-5-18` and Session 0, the exact filename, a regular 32-byte file, no reparse points and SYSTEM ownership with a protected DACL on the key, authority directory **and its managed parent** `C:\ProgramData\ConsoleMcp`. The key file must grant access only to SYSTEM; ancestor directories may grant read-only access to other principals, but no delete, write, owner or DACL modification. The gate does not read the key bytes, create directories, decrypt or distribute secrets, or authorize sealing.

Native Windows .NET10 regression passed the non-SYSTEM/alternate-path negative cases (`RELEASE_SEALER_CSHARP_AUTHORITY_FILE_NEGATIVE_REGRESSION_PASS`) alongside HMAC, framing, peer impersonation, SDDL and applied-pipe-ACL tests. **No real HMAC key was provisioned or read, and positive SYSTEM-owned key admission is not yet demonstrated.** The isolated self-contained service binary was rebuilt (SHA-256 `1f47502bc42068d78ac774b0618b17caec6c41c3d5458c7fcd28ff622b0da2b8`). Its interactive launch denial and actual LocalSystem Session 0 SCM lifecycle passed again (PID `16448`), followed by full test-service and protected-file cleanup. Production Console MCP was not changed.

Future provisioning must independently authenticate the broker SID and key origin, establish a protected writer/key-rotation protocol, verify filesystem ACLs before and after writes, handle crash-safe rotation and durable replay reservations, and bind those gates into the service request flow. The service still has no live listener and cannot seal a release.

## Native Windows pipe creation with applied ACL (fixture only; not a service listener)

`SealPipeNativeFactory.Create` is a new, **unused** production pipe factory. It verifies the **actual** current Windows token has SID `S-1-5-18` and runs in Session 0 before it may create the fixed `ConsoleMcpReleaseSealerV3` named pipe. It uses the independently pinned broker SID to generate and verify the protected SYSTEM-owned SDDL, and passes that `PipeSecurity` to `NamedPipeServerStreamAcl.Create` (single instance, non-inheritable handle, asynchronous byte stream, 4096-byte buffers). It intentionally does **not** use `PipeOptions.CurrentUserOnly`, which would override the intended broker ACL. <Not deployed or invoked by SCM ServiceMain.>

The isolated Windows .NET 10 regression now verifies an actual native pipe whose owner and protected DACL are read back from the object using `PipesAclExtensions.GetAccessControl`, with a successful connection from the allowed SID. The test-only pipe is owned by the interactive test user, **not** SYSTEM. Calling the privileged factory with that user identity is separately rejected. Result: `RELEASE_SEALER_CSHARP_NATIVE_PIPE_ACL_REGRESSION_PASS`, alongside request HMAC, framing, impersonated SID and SDDL-policy passes. This establishes actual Windows ACL application, but **not** a live SYSTEM-owned listener or cross-user broker admission.

The self-contained Windows EXE was rebuilt with the native factory (SHA-256 `1bc3b5dc368b6c64c0702a7151e4676d0479de83a7bc716e20abf97a060c0aeb`), and a new isolated SCM lifecycle passed (PID `26204`, actual SID `S-1-5-18`, Session 0). The service and protected fixtures were removed and production Console MCP remained unchanged. Before enabling the service listener: provision a protected broker SID and authentication key, enforce a durable replay journal, verify the entire signed source/destination and explicitly bind the listener's protocol to the full admission gates.

## LocalSystem-owned named-pipe SDDL policy (pure; listener not enabled)

`SealPipeSecurityPolicy.Build` now produces a fixed, independently verified Windows security descriptor for a future privileged named-pipe listener. Owner and group must be **LocalSystem** (`S-1-5-18`); the DACL must be protected against inheritance and contain **exactly two explicit Allow ACEs**: LocalSystem full control and one independently provisioned broker account SID with a restricted pipe I/O mask (`0x0012019B`). That broker mask intentionally excludes the `0x4` bit (`FILE_CREATE_PIPE_INSTANCE`), and `Verify` rejects unexpected owner/group, inheritance, Everyone ACE, extra rights, invalid broker SID, SYSTEM-as-broker and additional ACEs. The broker SID must never be taken from a caller-controlled request.

The native Windows .NET 10 regression returned `RELEASE_SEALER_CSHARP_SDDL_REGRESSION_PASS`, alongside request HMAC, frame bounds and client-token impersonation passes. This tests the **security descriptor policy**; it does **not** claim that a SYSTEM service has created a pipe with that descriptor or that a broker from another Windows logon SID can connect. There is still no listener in `Program.ServiceMain`, no SDDL applied to a live pipe, and no key-custody or durable replay journal gate.

The service was rebuilt as a self-contained Windows x64 EXE (SHA-256 `c44a4436520bd156061762fcc6fa47c00025908aa306e2cb1d19d0228457ede9`). Negative interactive launch and isolated SYSTEM SCM lifecycle passed again. The real process was LocalSystem SID `S-1-5-18`, Session 0 (observed test PID `28440`), and the test service and protected directories were subsequently removed. Production Console MCP remained unchanged.

## Bounded named-pipe framing and Windows peer SID admission (not yet listening)

The .NET 10 sealer project adds two independently tested primitives:

- `SealPipeFrame.ReadAsync` accepts only a 4-byte little-endian length followed by 1–4096 bytes of payload, with an internal 3-second read deadline. EOF, short frames and oversized lengths are rejected without returning a request. `WriteDeniedAsync` emits only a single refusal byte. There is **no positive acknowledgement**, release operation, or service listener.
- `SealPipePeerIdentity.Matches` uses the Windows named-pipe server's `RunAsClient` and `WindowsIdentity.GetCurrent(ifImpersonating: true)` to require an actual impersonated connecting-client **account SID**. It rejects disconnected pipes, LocalSystem/Anonymous as expected broker identities and mismatched SIDs. Expected broker SID must originate from independently authenticated, SYSTEM-protected configuration; it cannot be supplied by the client.

The native Windows regression harness passed `RELEASE_SEALER_CSHARP_FRAME_REGRESSION_PASS` (valid, truncated, oversized/zero-size frames and refusal response) and `RELEASE_SEALER_CSHARP_PIPE_IDENTITY_REGRESSION_PASS` (actual isolated `CurrentUserOnly` named-pipe connection, correct account SID and rejected wrong/SYSTEM SID). The initial fixture revealed a write/read ordering deadlock, which was corrected by posting the server read before the client write. This does not demonstrate cross-user LocalSystem-to-broker pipe ACL admission: there is no privileged pipe listener, service-owned SDDL or protected broker SID provisioning yet.

The self-contained service was rebuilt with these two modules (SHA-256 `8727fba096a7b98cbefb81f9a945148428e23dab64eb171b92589f654ff7ad7e`). The native Windows negative launch tests and a full LocalSystem SCM lifecycle fixture passed again, observing process SID `S-1-5-18` / Session 0 (PID `20164`); service and protected test directories were removed. These components are deliberately **not invoked** by `Program.ServiceMain`, preventing any privileged request processing before key custody and replay-protection gates exist.

## C# HMAC request admission (pure; no transport or key custody)

The Windows .NET 10 sealer project now includes `SealRequestAdmission.Verify` as an independent, fail-closed request-verification primitive. It accepts at most **4096 UTF-8 bytes**, requires a single strict JSON object with exactly nine known fields, refuses duplicate fields, malformed or uppercase identifiers, alternate operations, self-rollback, expired or more than ten-minute future timestamps, and non-32-byte HMAC keys. It recomputes HMAC-SHA256 over the existing length-prefixed `console-mcp-seal-request-v1` canonical field sequence and uses constant-time MAC comparison. This is **not** a new authorization gate on the running Windows broker: it does not open a pipe, read or provision authority keys, reserve replay IDs, attest source/destination files, sign receipts or authorize releases.

A standalone `ops/windows-sealer-protocol-regression` .NET console harness was compiled and executed on native Windows with pinned, locally isolated SDK `10.0.403`: `RELEASE_SEALER_CSHARP_REQUEST_REGRESSION_PASS` (zero errors/warnings). It covers a valid HMAC vector, altered SHA, malformed identifiers, duplicate and unexpected fields, expired/future deadlines, oversized requests and invalid key length.

The self-contained Windows service binary was rebuilt with this module, yielding SHA-256 `7e9eb3911de8d49ca2136cc99ec1079a1e2ce9c0edf5b20ed2941c2a7da73e60`. All isolated binary/SCM test fixture hashes were updated. Native Windows negative execution returned access denied `5` with and without `--install`; positive SCM lifecycle again passed with real process SID `S-1-5-18`, Session 0, start/stop/delete and full protected fixture cleanup (observed PID `10860`). No production state changed.

**Remaining trust boundaries:** independently authenticated Windows named-pipe client identity/ACL, securely protected and rotated HMAC keys, protected RSA signing keys, replay-resistant durable journaling, source file integrity, NTFS sealed publication and broker admission remain unimplemented. The function's existence alone must not be represented as a secured broker-to-sealer transport.

## Positive native Windows LocalSystem SCM lifecycle fixture

The one-shot `tool/release-sealer-scm-lifecycle-fixture.ps1` has now **passed on Windows** with the independently published and SHA-256-pinned self-contained .NET 10 executable. Admission required an elevated Windows test runner, exact fixture workspace, unused fixed SCM service name, no pre-existing `C:\Program Files\ConsoleMcp` directory and the expected binary hash. It staged only a new `C:\Program Files\ConsoleMcp\SealerV3` tree, applied protected NTFS ACLs granting write authority only to SYSTEM, registered the service initially Disabled/Stopped, temporarily set Manual for the smoke start, then restored Disabled before service deletion.

The Windows SCM reported the running `ConsoleMcpReleaseSealerV3` service, and an independent `Win32_Process.GetOwnerSid` check returned **`S-1-5-18`** with **Session 0** (observed process PID `2280`). The test successfully STOPPED and DELETED the SCM service, then removed the protected fixture binary and directories. Result: `RELEASE_SEAL_SCM_LIFECYCLE_PASS`; `system_service_running=true`, `stopped=true`, `service_removed=true`, `fixture_directory_removed=true`, `sealing_authorized=false`, `production_changed=false`.

The first attempts exposed two fixture-only cleanup/order defects: the parent ACL was sealed before child staging, and an admin with read/execute rights could not delete the protected fixture. Both were corrected, with residual-state read-only inspection after each failure. `tool/release-sealer-scm-protected-cleanup.ps1` now refuses cleanup while the service exists, or if unexpected paths, ACEs, reparse points, SYSTEM ownership drift, or the executable's exact SHA-256 mismatch are present. Only then does it temporarily take ownership and delete **the known fixture tree**. A separate empty-root cleanup helper handles the initial partial fixture. This tool is not a generic service removal mechanism.

**Scope:** the test proves a minimal inert service host can run under genuine LocalSystem/Session 0. It does **not** provide authenticated broker transport, SYSTEM key custody, source attestation, a durable replay-resistant journal, protected production release publication or safe production cutover. The active Console MCP remains unchanged.

## Windows SCM installation contract (service not installed)

The Draft now has `Assert-ReleaseV3SealerServiceRecord` and `Assert-ReleaseV3WindowsSealerServiceInstallation` for the exact dedicated service `ConsoleMcpReleaseSealerV3`. The accepted SCM configuration is a **stopped, disabled** `Own Process` service running as `LocalSystem` with an exact native executable path `C:\\Program Files\\ConsoleMcp\\SealerV3\\ConsoleMcp.Sealer.Service.exe`. PowerShell-based service launchers, parameters, alternate service accounts or start modes are refused; executable and ancestor NTFS ACLs are independently checked. The SCM match is read-only and does not attest the executable's independently signed code manifest, live service token, key custody or transport.

The isolated Windows fixture passed the service contract regression. Its read-only SCM preflight returned `RELEASE_SEAL_SERVICE_NOT_READY` with `RELEASE_SEAL_SERVICE_NOT_INSTALLED`; no service was created or started. Before any installation, a genuine Windows service executable, protected code manifest, isolated SYSTEM identity, key provisioning and authenticated transport must be implemented and reviewed. This does not change incumbent runtime or release selection.

## Protected SYSTEM sealer host code admission (not yet installed)

`Assert-ReleaseV3SealerHostCode` is a read-only guard for a future isolated Windows service executable/module tree. It rejects non-Windows execution, unprotected code roots and ancestors, any reparse file/directory, extra or missing files, malformed expected hashes, and mismatch between expected SHA-256 hashes and actual bytes. It checks the full NTFS path protection for every member. The expected file manifest must originate from a separately authenticated and immutable service installation; passing a developer-supplied expected hash is not proof of provenance or service authorization.

The negative regression passed with the native Windows PowerShell runner in a separately created test workspace: an ordinary developer-owned module directory was **rejected**. The portable non-Windows rejection and PowerShell parse checks also passed. No service was installed, no host code was elevated, and no production release was changed. A positive SYSTEM-owned code tree is still unavailable.

## Native Windows SYSTEM and trust-anchor readiness preflight

`tool/release-sealer-windows-host-preflight.ps1` was executed natively from an isolated Windows fixture workspace without touching production. The process token belonged to an interactive user in Session 7 (`system_host=false`); the protected public trust file under `%ProgramData%/ConsoleMcp/seal-authority/sealer-public.pem` did not exist (`trust_anchor_exists=false`). Result: `RELEASE_SEAL_PREFLIGHT_NOT_READY`, `authorization_granted=false`, `production_changed=false`. The preflight is deliberately read-only and does not create missing keys, elevate identity, install a service or reinterpret an interactive process as SYSTEM. This is the concrete blocker for a positive privileged fixture. A true SYSTEM service-host process, independently provisioned trust anchor, protected private key, authenticated transport and durable request journal remain necessary.

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

