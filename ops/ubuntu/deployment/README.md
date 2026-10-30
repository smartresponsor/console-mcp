# Protected Ubuntu release controller

This is the canonical source of the previously host-only `/opt/console-mcp-deploy`
controller. Deployment requires an independently authenticated root session. The
Console MCP service retains `NoNewPrivileges`; it cannot deploy itself or obtain
sudo credentials. Never run these operations through its service account.

The source checkout must be clean at a verified full `origin/master` SHA. Run as
alex, replacing `SHA` with that exact revision:

```sh
repo=/home/alex/smartresponse/mcp/console-mcp-global-validation-20261030
sha=SHA
sudo /usr/bin/python3 -I "$repo/ops/ubuntu/script/prepare-console-release.py" --source "$repo" --sha "$sha" --seal
sudo /usr/bin/python3 -I "/opt/console-mcp-deploy/releases/$sha/ops/ubuntu/deployment/prepare.py" prepare --sha "$sha"
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/prepare.py validate --sha "$sha"
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/deploy.py verify
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/deploy.py apply
```

Sealing exports committed source, installs pinned dependencies and builds as
unprivileged alex. Root verifies and seals the complete inventory. Preparation
derives rollback from the *loaded* production bind mounts and authenticated build,
archives private unit/environment/controller state under `checkpoints/`, refreshes
exact browser/process identities and configures independent loopback probe units.
It never restarts production. Old registries and caller-supplied readiness flags
are not evidence. Unexpected drop-ins, missing native foreground, changing browser
identities and active queued operations fail closed.

Validation actually starts both protected rollback and candidate under production
hardening with independent run/log/transcript/workspace paths and synthetic bearer
credentials. It checks authenticated fingerprints, read-only permissions, platform
diagnostics, native visibility and an inert interaction lease. No click is issued.
The current service and browser identities must remain unchanged. Proof is fresh
for ten minutes; rerun validation when it expires.

Apply uses one POSIX lock, a durable pending journal, atomic systemd publication and
authenticated post-cutover gates. Failure restores the verified old release. After
an interrupted apply, run `sudo /usr/bin/python3 -I
/opt/console-mcp-deploy/deploy.py recover`; explicit rollback uses the same command
with `rollback`. Terminal recovery receipts never repeatedly restart the service.
Keep both sealed trees, their manifests and the private checkpoint until successful
live verification and the retention decision. Do not modify browser profiles,
cookies, production environment bytes or session data.

Run `python3 -I ops/ubuntu/deployment/regression.py` on Linux for transaction,
interruption, cross-process lock, seal, source identity, dynamic browser baseline
and authenticated transport contracts. The fixtures do not touch systemd or actual
production paths. Root mode additionally exercises root-owned seal verification;
unprivileged mode proves that unsealed artifacts are refused.
