# Administrative release preparation

The MCP service account cannot acquire administrative privileges: its systemd
unit has `NoNewPrivileges=yes`. Do not disable that boundary, add general sudo
rights, or submit passwords to the MCP script runner. An administrative `alex`
session must exist independently. Tailscale SSH identity checks precede sudo and
cannot be satisfied by a sudo credential.

From Windows, authenticate the pinned SSH host and account:

```powershell
ssh -o StrictHostKeyChecking=yes -o UserKnownHostsFile=C:/Users/Admin/console-mcp-global-20261030/ubuntu-known-hosts alex@100.66.177.19
```

In that session, after the candidate has been fast-forwarded to the recorded
canonical master, set SHA to the exact value in final-status.md:

```sh
sudo -v
repo=/home/alex/smartresponse/mcp/console-mcp-global-validation-20261030
sha=FULL_CANONICAL_SHA
sudo /usr/bin/python3 -I "$repo/ops/ubuntu/script/prepare-console-release.py" --source "$repo" --sha "$sha"
sudo /usr/bin/python3 -I "$repo/ops/ubuntu/script/prepare-console-release.py" --source "$repo" --sha "$sha" --seal
```

The first script invocation is a read-only plan. The second creates a new unique
staging directory under the root-owned deploy root, extracts committed bytes,
installs pinned dependencies and compiles as unprivileged `alex` with a clean
environment and lifecycle hooks disabled, removes development dependencies in
that new staging directory, then seals ownership/modes/hashes. It verifies the
manifest with the existing root deployer's verifier and atomically publishes
`/opt/console-mcp-deploy/releases/FULL_CANONICAL_SHA`. Existing releases are never
overwritten. Failure preserves staging for review. No profile, session, service,
unit, active source tree or deployment registry is changed.

Python isolated mode excludes repository-local import shadowing. Git runs as the
unprivileged source owner, and build commands run as alex; both use no-new-privileges
and a clean environment. Repository Git configuration is never executed as root.

This is preparation, not cutover. Do not run the existing `deploy.py apply` with
its stale registry. Privileged cutover preparation must still capture current
MainPID, exact active sealed rollback, service/drop-in/environment checkpoints,
browser process/window/target baselines and candidate/rollback sandbox proofs.
The existing gates contain historical PID/page-count/target assumptions: review
and refresh their evidence contracts against current reality rather than bypassing
them. Only after those gates pass may the root-owned registry point to the new
full-SHA release and the existing `/usr/bin/python3 /opt/console-mcp-deploy/deploy.py apply`
be used. The corresponding rollback command is `deploy.py rollback` under the
same authorized administrative session and refreshed registry.

The ordinary repository fetch/build/tests and read-only service/seal inspection
do not require root. Root is required for sealing protected releases, updating
protected registry/checkpoint/gate state, writing systemd overrides, daemon reload,
service cutover and rollback. No sudo authorization is inferred from possession
of a password; no escalation is attempted by the preparation helper.
