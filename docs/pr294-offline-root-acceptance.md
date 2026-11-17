# PR #294 — independent root-only CAS acceptance

This is an **offline, explicit administrator procedure**, not an MCP command, sudo bypass, systemd unit, or production release action.

1. On an independently authorized **disposable Linux VM/container with UID 0 at process start** (not privilege escalation inside Console MCP), obtain the exact reviewed PR commit using a trusted Git checkout. Record `git rev-parse HEAD`; require the same SHA as the PR head at the time of testing. Use a scratch filesystem, **never** `/opt/console-mcp-deploy`, `/run/console-mcp-release`, or the live policy/socket.
2. As the already-privileged test process, run `/usr/bin/python3 -B ops/ubuntu/deployment/release-policy-cas-regression.py -v`. Require all root-only cases to run with **zero skips**, zero failures, and exit 0. The tests create disposable root-owned policy files under `tempfile.TemporaryDirectory`, exercise competing writers, CAS conflict, lease ownership, expiry, and symlink rejection.
3. Run `/usr/bin/python3 -B ops/ubuntu/deployment/release-policy-snapshot-regression.py -v` on the same exact SHA. Require exit 0. This covers broker crash recovery, stale rollback generation and long-running lease expiry; review the mocks as **unit-level**, not live-controller E2E evidence.
4. Run `npm run build && npm test` in a clean nonproduction checkout of that **same SHA**. Record exit codes and Git status. Re-fetch the PR head and require the SHA unchanged before merging.
5. Independently review the CAS atomic file replacement, locking, lease-renewal ownership, crash consistency (fsync), rollback authorization and worker recheck. If any test skips or a required integration scenario remains untested, **do not merge**.

The Console MCP execution context has `NoNewPrivs`; it must not call sudo, change process privileges, create privileged services, or reuse production's privileged release broker as a test executor. If an authorized root test context is unavailable, report `ROOT_ONLY_ACCEPTANCE_PENDING` and leave the PR Draft.

## Optional independently approved systemd runner (disposable VM only)

Two reviewed, **inactive repository artifacts** are provided:

- `ops/ubuntu/deployment/pr294-offline-root-acceptance.py` — fixed command set, verifies effective UID 0, root-owned checkout and expected SHA, clean Git tree, then executes only the two named regression files.
- `ops/ubuntu/deployment/pr294-offline-root-acceptance.service` — a sample restricted `Type=oneshot` unit with root identity, `NoNewPrivileges=yes`, private temporary files, read-only host filesystem and network denied.

**Do not install this unit on the production Ubuntu Gold host.** An independently authorized administrator may provision it on a disposable isolated test VM, after reviewing and copying a clean exact-commit checkout to `/opt/pr294-offline-test/source`, ensuring every source component is root-owned and not writable by untrusted users. Place the exact reviewed 40-character SHA in root-owned mode-0644 `/opt/pr294-offline-test/expected-sha`. Keep this source and expected-SHA file outside all production deployment locations.

The administrator, not the MCP worker, installs/starts the unit through an independently authorized root session and captures the full journal, exit status, skip count, and SHA. This repository change **does not create, enable, or execute** any system service. Root-only PASS requires **zero skips**. The Python snapshot suite is unit-level; assess whether additional integration acceptance is necessary before merge.

The expected SHA changes when the PR branch changes; rerun the entire acceptance on the final exact SHA. A successful earlier commit is not sufficient.

## Minimal administrator runbook (disposable VM, explicit approval)

1. Provision a **fresh disposable Linux VM**, not the Ubuntu Gold production host. In an independently authorized root login, check out the **current** PR head to `/opt/pr294-offline-test/source`, and record the exact 40-character commit in `/opt/pr294-offline-test/expected-sha`. All directories/files along the checked paths must be root-owned, with no group/other write permissions; use a clean detached checkout. The expected SHA must match the fetched PR head.
2. Inspect the source and service file before installation. Copy the reviewed `pr294-offline-root-acceptance.service` to `/etc/systemd/system/` **on that disposable VM only**; run `systemctl daemon-reload` and `systemctl start pr294-offline-root-acceptance.service` from that independent root login. The unit is intentionally **not installable/enablable** and must be manually started once. Missing prerequisites cause a failure, not a skipped unit.
3. Capture `systemctl show -p Result -p ExecMainStatus pr294-offline-root-acceptance.service` and `journalctl -u pr294-offline-root-acceptance.service -b --no-pager`. Require `Result=success`, `ExecMainStatus=0`, the `PR294_OFFLINE_ROOT_TESTS_PASS SHA=...` receipt, **zero skipped tests**, and the exact expected SHA.
4. Supply the logs/receipt for independent review. Recheck branch SHA and clean checkout; run remaining local acceptance on that **same** commit. **Do not merge** if SHA changed, root tests skipped, or any result is unavailable.

No production paths, release broker, MCP privilege escalation, sudo under NoNewPrivs, GitHub Actions, or auto-enabled service are involved.

## Additional CAS hardening and acceptance coverage

The CAS implementation now opens every absolute ancestor component-by-component with `O_DIRECTORY|O_NOFOLLOW`, verifies root ownership and permissions using `fstat`, and performs policy/lock/temp-file operations relative to the retained parent dirfd. The only writable-ancestor exception is a **root-owned sticky directory** (such as `/tmp`); descendants remain root-owned and are anchored by dirfd. Policy replacement uses exclusive `openat`, `renameat` via `os.replace(..., src_dir_fd=..., dst_dir_fd=...)`, file fsync, then directory fsync.

Additional root-only tests cover:
- acceptance of root-owned sticky `/tmp` ancestors;
- rejection of a group/world-writable non-sticky ancestor and symlink ancestors;
- rejection of policy/lock hard-link aliases, which could otherwise orphan the flock inode during atomic replacement;
- independent forked processes contending on one generation (exactly one winner);
- SIGTERM/process-kill after atomic rename but before directory fsync, requiring a complete new JSON generation (not a partial file);
- a real filesystem CAS same-owner lease renewal performed by a controlled long-running controller callback inside the broker worker; the worker must accept the renewed lease after the original expiry. The controller boundary is mocked, while policy persistence, generation update and worker revalidation are real.

These tests are deliberately skipped by non-root runs. A local non-root PASS with any root-only skip is **not** root acceptance and must not be represented as such. The process-kill test demonstrates process-level atomic replacement visibility, not power-loss durability or storage-controller behavior.
