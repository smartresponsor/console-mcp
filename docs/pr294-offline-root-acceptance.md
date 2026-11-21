# PR #294 — unprivileged acceptance and deferred root-specific checks

The default merge acceptance for PR #294 no longer requires an independently provisioned root VM. Portable filesystem and process behavior is tested locally as an unprivileged user in private temporary directories. This is **not** a root receipt and does not claim to prove actual root ownership enforcement.

## Unprivileged acceptance coverage

Run `tool/pr294-isolated-acceptance.ps1` from the isolated Ubuntu Gold worktree. The runner pins temporary files to `/tmp`, verifies the expected checkpoint HEAD and branch, runs `git diff --check`, and executes all three Python regression suites. It fails if either real CAS/broker suite reports skipped tests.

The suites exercise the production CAS implementation through private test-only helpers which inject the current UID for scratch files. The public `inspect()` and `replace_if_generation()` APIs remain root-only and default to UID 0; no caller-selectable ownership override is exposed through those production entrypoints.

Coverage executed without root:
- complete ancestor traversal using `O_DIRECTORY|O_NOFOLLOW` and retained directory FDs;
- acceptance of immutable root-owned system ancestors and the root-owned sticky `/tmp` ancestor, with a private user-owned descendant;
- rejection of group/world-writable non-sticky ancestors, symlink ancestors, and symlink lock files;
- hard-link policy/lock alias rejection;
- dirfd-relative lock creation, file reads, exclusive temporary creation, atomic dirfd-relative replacement, and fsync;
- real independent forked processes contending for one CAS generation (exactly one winner);
- real SIGKILL after atomic rename but before directory fsync, followed by verification that the visible policy is a complete JSON generation;
- real broker run/transaction journal writes in isolated directories, actual child SIGKILL, then real `recover_interrupted()` restart recovery;
- real filesystem same-owner CAS lease renewal during a controlled long-running broker worker/controller callback. The controller boundary and deployment binding are mocked; CAS persistence, policy snapshot reload, and post-controller worker revalidation are exercised.
- root-runner negative security fixtures: fail-closed non-root behavior, ownership/mode/symlink/type checks, and rejection of a simulated skipped-test receipt.

## Deferred root-specific assurance and residual risk

The following checks are not established by the unprivileged suite and remain deferred:
1. Positive execution with effective UID 0 against genuinely root-owned policy, lock, temporary, and ancestor objects.
2. Negative owner-mismatch cases against files/directories owned by a different real UID while the test process itself is root.
3. Actual root-owned sticky-directory and permission/ACL/default-ACL behavior under the target host's filesystem and mount configuration.
4. Production deployment service identity, filesystem ACLs, mount flags, and kernel/filesystem durability behavior.

The unprivileged suite proves the portable dirfd/openat, no-follow, flock, rename, process concurrency, SIGKILL visibility, and broker recovery code paths on the local filesystem. It does not prove root's real DAC/ACL ownership boundary, privileged service integration, power-loss durability, or storage-controller behavior. The default public CAS API remains hard-coded to `trusted_uid=0`; a regression explicitly verifies that it rejects a user-owned temporary path when invoked unprivileged.

These deferred checks are an explicit residual risk, not a hidden acceptance skip. A root acceptance run remains optional supplemental evidence and can be performed later on an independently authorized disposable VM. If executed, use `ops/ubuntu/deployment/pr294-offline-root-acceptance.py` on the exact final PR SHA, require zero skips, and verify the receipt against that SHA.

## Safety boundaries

No sudo, privilege escalation, privileged service installation, production host, production release broker, or GitHub Actions are part of the unprivileged acceptance. Do not merge as part of this task. Keep PR #294 Draft until a separate review explicitly decides whether the documented residual root-specific risk is acceptable.
