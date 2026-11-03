# Stage 3C.3 — Real isolated mount-namespace admission

Status: **BLOCKED BY HOST UNPRIVILEGED USER-NAMESPACE POLICY**.

Live Ubuntu test using `unshare --user --map-root-user --mount --fork` returned
`unshare: unshare failed: Operation not permitted` on 2026-11-02.
This is not an approval to relax production host security settings or escalate
via Docker. The current Console MCP runtime and existing release store are unchanged.

`release-view-namespace-test.py` is a reviewed scratch-only kernel test:
it first requests an isolated mount namespace, creates temporary source and view
directories within that namespace, attempts a bind and read-only remount, checks
mount options and rejected writes, and exercises the view-path rename scenario.
The script refuses a false positive: if namespace creation fails, returns
`KERNEL_NAMESPACE_TEST_BLOCKED` with nonzero exit.

The companion regression tests simulate denied namespace creation, malformed
evidence, and an explicitly successful isolated probe. Those tests validate
admission logic, not kernel mount behavior.

A future independently authorized administrator may run this test in a
properly isolated scratch host or disposable VM with mount namespaces enabled.
Do not treat a root execution in the live host's default mount namespace as an
acceptable replacement. No unshare/sysctl policy change, mounting of real
`.releases`, or production cutover is authorized by Stage 3C.3.
