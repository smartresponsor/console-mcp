# PR #294 — independent root-only CAS acceptance

This is an **offline, explicit administrator procedure**, not an MCP command, sudo bypass, systemd unit, or production release action.

1. On an independently authorized **disposable Linux VM/container with UID 0 at process start** (not privilege escalation inside Console MCP), obtain the exact reviewed PR commit using a trusted Git checkout. Record `git rev-parse HEAD`; require the same SHA as the PR head at the time of testing. Use a scratch filesystem, **never** `/opt/console-mcp-deploy`, `/run/console-mcp-release`, or the live policy/socket.
2. As the already-privileged test process, run `/usr/bin/python3 -B ops/ubuntu/deployment/release-policy-cas-regression.py -v`. Require all root-only cases to run with **zero skips**, zero failures, and exit 0. The tests create disposable root-owned policy files under `tempfile.TemporaryDirectory`, exercise competing writers, CAS conflict, lease ownership, expiry, and symlink rejection.
3. Run `/usr/bin/python3 -B ops/ubuntu/deployment/release-policy-snapshot-regression.py -v` on the same exact SHA. Require exit 0. This covers broker crash recovery, stale rollback generation and long-running lease expiry; review the mocks as **unit-level**, not live-controller E2E evidence.
4. Run `npm run build && npm test` in a clean nonproduction checkout of that **same SHA**. Record exit codes and Git status. Re-fetch the PR head and require the SHA unchanged before merging.
5. Independently review the CAS atomic file replacement, locking, lease-renewal ownership, crash consistency (fsync), rollback authorization and worker recheck. If any test skips or a required integration scenario remains untested, **do not merge**.

The Console MCP execution context has `NoNewPrivs`; it must not call sudo, change process privileges, create privileged services, or reuse production's privileged release broker as a test executor. If an authorized root test context is unavailable, report `ROOT_ONLY_ACCEPTANCE_PENDING` and leave the PR Draft.
