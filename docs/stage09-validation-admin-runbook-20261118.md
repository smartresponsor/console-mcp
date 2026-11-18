# Stage 09 — authorization strictly for validate (not yet applied)

## Exact evidence
- Candidate SHA: `eb5e062023cb40341fc75b56ce26524a9a529f16`; Git tree: `df029f570d423a11ff8465ff3a4d8e13b9614fd8`.
- Candidate source: `/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-immutable-eb5e-20261118` (clean).
- Protected rollback SHA: `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec`.
- Protected checkpoint: `20261118T220646Z-bde7303509364deaacbf1ed94d5c793e`.
- Exact incumbent production MainPID: `715459`, loaded release remains `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec`.
- Root-only validator helper: `ops/ubuntu/deployment/stage09-authorize-validate.py`, **SHA256 `bb9fbeae4f8b33889bbac5e4791580399ee61ce8ab20b9a46957356d528a3f91`**.
- Local unprivileged adversarial fixture: PASS, not a privileged integration or policy mutation.

## Authorization scope and safety
- This is a root-only **separate SSH session** operation: install reviewed helper as a root-owned file; never execute the user-owned checkout script directly with sudo.
- `--inspect` is read-only: checks exact source SHA/tree, root-owned registry and checkpoint, sealed candidate/rollback SHA256 file inventories through installed verifier, production PID and bound release, and current root policy digest.
- `--apply --expected-generation <digest>`: inside an exclusive trusted lock, rechecks policy generation, exact deployment binding and source; refuses an unexpired foreign lease, symlink/ACL anomaly and unexpected schema keys; saves original-byte root-only mode 0600 backup; publishes updated root-owned policy atomically.
- New `enabledOperations` is **exactly `["validate"]`**. All previous operation grants are dropped (not inherited); `prepare`, `activate`, and `rollback` remain disabled.
- Authorization lease: 1800 seconds (30 minutes), owner `stage09-exact-sha-validate`. The broker checks that the lease is active at the request admission gate.
- Do not bypass an ACTIVE_FOREIGN_LEASE from Stage 08 or other owner. Wait until that lease expires, then repeat `--inspect` and explicitly approve new generation.
- `validate` is **not pure read-only**. It may start/restart *isolated validation* systemd units and create root-owned candidate/rollback sandbox evidence. It must not restart `console-mcp.service` or change production.

## Step 1 — separate authorized SSH admin, INSTALL + READ-ONLY INSPECT

```sh
set -eu
src=/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage09-validate-auth-20261118/ops/ubuntu/deployment/stage09-authorize-validate.py
installed=/opt/console-mcp-deploy/stage09-authorize-validate.py
expected=bb9fbeae4f8b33889bbac5e4791580399ee61ce8ab20b9a46957356d528a3f91
printf '%s  %s\n' "$expected" "$src" | sha256sum -c -
# Independently inspect the privileged helper source before trusting it.
sudo -v
sudo install -o root -g root -m 0700 "$src" "$installed"
printf '%s  %s\n' "$expected" "$installed" | sudo sha256sum -c -
sudo stat -c '%U:%G %a %n' "$installed"
sudo /usr/bin/python3 -I "$installed" --inspect
```

Check `status=READ_ONLY`, exact `binding.candidate.sha`, `binding.rollback.sha`, `binding.checkpoint`, `binding.oldPid`, and `source.sha`/`tree`. Read `policyGeneration`, `lease` and `currentOperations`. STOP on any exception, missing evidence or active foreign lease.

## Step 2 — separately approved policy update

```sh
# Replace only with exact 64-hex policyGeneration copied from your latest inspect.
generation=PASTE_LATEST_POLICY_GENERATION
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/stage09-authorize-validate.py --apply --expected-generation "$generation"
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/stage09-authorize-validate.py --inspect
```

Require `status=VALIDATE_ONLY_AUTHORIZED`, root-owned mode-0600 original policy backup present, `currentAuthorizedSha=eb5e062...`, `currentOperations=["validate"]`, exact source/binding, live lease. STOP if policy generation changed or lease was held; do not retry blindly.

## After verified authorization (separate MCP action, no activate)
- Invoke exactly one **v1 runtime-broker** `requestReleaseBroker('validate', sha)` through the already connected Console runtime client; **do not** call transaction v2 `write.release.transaction.validate` unless an exact successfully prepared transactionId exists for this SHA.
- Read only status of its returned durable runId until terminal; never submit duplicate validate for an uncertain run.
- Require `succeeded` and sealed candidate/rollback proof. Independently inspect both sandbox result receipts through admin-authorized read-only verifier; check exact SHA, pass flags, timestamp, registry fingerprint, checkpoint, current PID and browser/target identity.
- Recheck production PID and loaded release, protected registry candidate/rollback and immutable manifests before declaring validation PASS.
- `activate`, `rollback`, actual Console cutover, service restart and tunnels are outside scope; do not enable them.

## Stop conditions
- Current policy changed/stale CAS, any active foreign lease, untrusted root file, missing/incomplete checkpoint, registry drift, PID/mount drift, dirty source, source SHA/tree mismatch, manifest hash failure, or isolated sandbox error.
- Do not modify the main dirty checkout, production, master, global Git config, external Actions or systemd services manually.
