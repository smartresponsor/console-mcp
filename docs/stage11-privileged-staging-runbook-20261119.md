# Stage 11 privileged staging acceptance — admin handoff (NOT EXECUTED)

## Authority and immutability

Pinned Stage 11 admission helper source SHA256 (read-only checked): **`bda406de73b76161caebda2887350f8f40b3df06b310c09b57ebfc6bff232de3`**. This digest identifies only the isolated helper bytes; it does not authorize installation or imply a verified GPG signature.

The existing Console MCP production PID is **715459** and its systemd service runs as `console-mcp:console-mcp` (UID 993 / GID 988). Existing production build fingerprint is `b85002587421379f`. The old transaction `ac6f051650b54f6bb1b37f272323788d` is `validate_failed` and MUST NOT be replayed.

This document is a proposed independent root approval gate. Stage 11 changes are in an **isolated feature worktree**, not master, and have not been deployed. The three administrative Stage 11 paths below were all **absent** during read-only inspection.

## Reviewed target mode contract

| Object | Owner | Mode | Additional restrictions |
| --- | --- | --- | --- |
| `/opt/console-mcp-deploy` (already present) | root:root | 0755 | Non-writable by service |
| `/opt/console-mcp-deploy/admission-lock.py` (not present) | root:root | 0755 | Pinned SHA256, regular one-link file, root-controlled install only |
| `/opt/console-mcp-deploy/admission.lock` (not present) | root:console-mcp | 0640 | Pinned inode, exclusive creation, no symlink/hardlink/group-write |
| `/opt/console-mcp-deploy/admission-inflight` (not present) | console-mcp:console-mcp | 0700 | Root-controlled parent; service can create only marker children |

The former proposed `/var/lib/console-mcp/run/deployment-admission-inflight` path is **not approved**: its parent is service-owned and would violate the root parent provenance required to protect the marker namespace.

## 0. Read-only baseline — already performed

Run `pwsh -NoProfile -File tool/stage11-admin-boundary-readonly.ps1` in the isolated Stage 11 worktree. Observed:

- `systemctl show console-mcp.service -p User -p Group -p MainPID` confirms system service UID 993/GID 988 and PID 715459
- `id console-mcp` confirms the trusted service principal
- `namei -l` and `stat` confirm the root parent mode and absence of all three new objects
- No `sudo`, root shell, user/group change, restart, activation or root policy write was performed

Repeat immediately before any future approval; abort on ownership, mode, PID, fingerprint or filesystem identity drift.

## 1. Separate root-only provisioning (NOT AUTHORIZED / NOT DONE)

Only after independently reviewing the exact **new Stage 11 Git commit and helper SHA256**, install the helper under a root-owned canonical destination, and create the two missing runtime objects under the existing root-owned parent.

Required safety:

1. Root-only ownership/authentication, original-source SHA256 and installed-copy SHA256 equality. No execution of user-writable Python as root.
2. Fail closed if any of the three destinations already exists. Never overwrite or reset an existing object, even if its filename and size match. Use trusted directory FDs, `O_NOFOLLOW`, `O_EXCL`, `fstat` and `fsync` for new file creation, not a blind `install /dev/null` that truncates existing content.
3. Enforce exact root:console-mcp 0640 lock and service-owned 0700 marker directory beneath root:root 0755 `/opt/console-mcp-deploy`. No world-writable or group-writable inode.
4. Keep production `console-mcp.service`, UID/GID, root broker policy, deployment checkpoints, dirty checkout, remotes and Git global config unchanged.
5. Do **not** enable `CONSOLE_MCP_DEPLOYMENT_ADMISSION=required` yet. The existing production release does not contain the enforcement code and new administrative artifacts do not establish a working release quiet-window.

A separately reviewed root-owned provisioner or explicit administrator approval is required before this phase. Do not try to bypass the boundary through the unprivileged MCP shell.

## 2. Independent privilege and mixed-UID tests (NOT EXECUTED)

After step 1 is proven safe:

1. Run trusted helper using the actual `console-mcp` principal, not `alex`; verify root-owned lock is accessible, `ADMISSION_LOCKED` includes a unique 48-hex nonce and an inode-bound durable marker exists before acknowledgment.
2. Before explicit release, independently verify root exclusive admission is blocked while the service's shared lock exists.
3. After exact `RELEASE <nonce>\n` acknowledgement, require marker directory empty. Test malformed nonce, unexpected EOF, real helper SIGKILL mid-callback; each case must retain marker and block root validation.
4. Keep all negative-test markers in a **disposable isolated staging namespace**; never auto-delete a real orphan marker. Before cleanup require authoritative PID/PGID/process-start-time/inode evidence and independent root approval.
5. Test root and service users against real ACLs using actual effective UID/GID, not chmod-only unprivileged fixtures. Require identical errors on symlink, changed inode, wrong group or mode, missing lock and untrusted parent.
6. Validate authenticated root queue gate and in-flight inventory under the same exclusive lock through the full isolated validation critical section. Existing queue, browser and sealed candidate checks must remain in place.

## 3. Bootstrap / cutover — blocked until a new release

The incumbent process (PID 715459) is not instrumented for Stage 11. A lock cannot stop tasks admitted by the incumbent. A coordinated no-new-job maintenance gate must exist **before** staging the new candidate. Then:

- Build a **new** immutable release candidate from the reviewed Stage 11 code, with complete source/registry/manifest sealing and SHA256 evidence
- Re-run full npm, adversarial and privileged acceptance on that exact immutable candidate
- Prepare a **new** release transaction and independently authorize `prepare` then `validate`, each under exact CAS/lease permissions and checkpoint identity
- Require an entirely separate admin approval for any `activate` or rollback
- Do not resurrect or reuse Stage 10 failed `validate_failed` transaction

## Known residual risks

- Stale-marker reconciliation needs an authoritative, separate root-only, single-use CAS contract binding process identity, start time, task, nonce and verified absence of untracked live children; **no reconciliation command is implemented**.
- Direct `execFile` browser/window diagnostic paths and managed service state outside `/home/alex/smartresponse` require verified isolation or additional gate coverage before declaring a production-wide quiet-window.
- The new admission wrapper conservatively retains an in-flight marker on any rejected mutating callback, including a pre-spawn validation exception. This trades availability for fail-closed safety until recovery workflow is reviewed.
- Explicit installed helper/lock/fence path real ACL acceptance, root-owned trusted source and process start-time anti-PID-reuse tests are still required.

**Decision:** No production deployment, merge, activation, root policy modification or privileged provisioning on the evidence available today.
