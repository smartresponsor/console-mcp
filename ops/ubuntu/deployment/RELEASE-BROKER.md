# Release broker: administrative bootstrap

This is a privileged adapter to the **existing** seal/prepare/deploy controllers, not a replacement for their gates.
The Console MCP service does not receive sudo, root credentials, or write access to the protected deployment registry.

Initial installation requires a separately authenticated administrator. Review this source in the merged, signed canonical master and install the vetted `release-broker.py` as root-owned `/opt/console-mcp-deploy/release-broker.py` with mode 0755. Install the existing `prepare-console-release.py` as root-owned `/opt/console-mcp-deploy/release-preparer.py`, mode 0755. Never execute scripts from a mutable checkout with root privileges.
Install the supplied systemd service only after independently validating the root-owned scripts and service configuration. The service creates the root-owned `/run/console-mcp-release` directory and its root:console-mcp socket.

After reviewing the exact source commit, perform this one-time bootstrap in a separately authenticated administrative shell:

```sh
set -eu
sha=FULL_REVIEWED_CANONICAL_SHA
source=/home/alex/smartresponse/mcp/.worktrees/REVIEWED_RELEASE_SOURCE
test "$(git -C "$source" rev-parse HEAD)" = "$sha"
test -z "$(git -C "$source" status --porcelain)"
sudo install -o root -g root -m 0755 "$source/ops/ubuntu/deployment/release-broker.py" /opt/console-mcp-deploy/release-broker.py
sudo install -o root -g root -m 0755 "$source/ops/ubuntu/script/prepare-console-release.py" /opt/console-mcp-deploy/release-preparer.py
sudo install -o root -g root -m 0644 "$source/ops/ubuntu/systemd/console-mcp-release-broker.service" /etc/systemd/system/console-mcp-release-broker.service
sudo test ! -e /opt/console-mcp-deploy/broker-policy.json && sudo install -o root -g root -m 0600 "$source/ops/ubuntu/deployment/broker-policy.example.json" /opt/console-mcp-deploy/broker-policy.json
sudo systemctl daemon-reload
sudo systemctl enable --now console-mcp-release-broker.service
```

Replace placeholders with exact verified values. Do not blindly overwrite an existing installed broker or policy; review it first. The default policy disables all release mutations and enables status only.

The broker requires `/opt/console-mcp-deploy/broker-policy.json` owned by root, mode 0600. Use `broker-policy.example.json` as a template. Explicitly set `authorizedSha` to the full canonical master SHA, `sourcePath` to the already prepared clean worktree, and select `enabledOperations` from `prepare`, `validate`, `activate`, `rollback`. Defaults must remain empty.

Treat enabling `activate` and `rollback` as a privileged administrative approval, not a side effect of Console MCP being installed. Do not enable them until rollback, current runtime identity, browser continuity and fresh independent validation are demonstrated. Changing this policy requires separate root authorization.

Only the Unix peer UID of `console-mcp` is accepted. The client cannot select controller script paths, root paths, deployment registry, arbitrary commands, or arbitrary Git branches. The broker uses the existing controller's sealed release and transaction gates.

Release mutations return a durable `runId` immediately. Check progress through `read_.release.runtime.status({runId})`. The root broker serializes mutations, retains root-only receipts in `/opt/console-mcp-deploy/broker-runs/`, and marks incomplete operations interrupted on restart. Never retry an interrupted cutover without inspecting the underlying deploy transaction and using the established recovery workflow.

Before first production enablement, validate the user/systemd deployment context, timeout and crash recovery with an authorized administrator. Until then leave `enabledOperations` empty.

Physical release storage: `/opt/console-mcp-deploy/releases/<full-sha>/`. The broker socket path is `/run/console-mcp-release/release-broker.sock`; it is not the release store.
