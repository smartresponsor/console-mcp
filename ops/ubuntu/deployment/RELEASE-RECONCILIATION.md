# Continuous production delivery: staged implementation

The release observer compares a locally fetched `origin/master` commit to a committed transaction's `sourceSHA`, cross-checking its candidate against the protected registry. A matching committed transaction is `REGISTERED_CURRENT`, **not** proof of live runtime identity. It is read-only. It does not fetch, seal, validate, change broker policy, activate, restart services, or override admission. The operator must not interpret its output as proof of the actual systemd runtime bind mount.

The observer is deliberately **not** a Watchdog lane: Watchdog checks running-service health. Release promotion belongs to the privileged deployment controller, with separate authorization.

The proposed timer and service are **not installed or enabled** by this change. The sample unit expects an independently reviewed, root-owned installation of the observer script under `/opt/console-mcp-deploy`. Never run a mutable repository script as root. The timer is observation only and must not be presented as automatic delivery.

Production delivery still requires:
1. Independently verify installed controller generation, active runtime mount, rollback artifact and browser continuity.
2. Design an authorized release source policy and root-owned reconciler which does not accept arbitrary SHA or paths from the MCP service.
3. Fetch and verify canonical master, create a clean worktree, seal and validate immutable release through the installed broker.
4. Introduce a serialized safe-window activation with durable receipts and automatic rollback, preserving browser sessions.
5. Prove real production cutover (new SHA, PID, fingerprint, tool registry, web diagnostic contract).
6. Only then enable automatic promotion. Do not couple canonical `.releases` migration to the immediate production recovery.
