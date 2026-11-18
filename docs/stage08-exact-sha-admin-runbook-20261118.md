# Stage 08 — exact-SHA administrative prepare authorization (NOT YET APPLIED)

## Fixed scope / evidence
- Canonical merged master SHA: `eb5e062023cb40341fc75b56ce26524a9a529f16`.
- Canonical Git tree: `df029f570d423a11ff8465ff3a4d8e13b9614fd8`.
- Verified clean immutable source checkout: `/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-immutable-eb5e-20261118`.
- Admin-helper source checkout: `/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-auth-admin-20261118` (distinct, **not** the release source).
- Helper: `ops/ubuntu/deployment/stage08-authorize-prepare.py`; SHA-256 `31ae95668420f54587ca74c78ced6dd01d803b731c5a490ddba2ddd746dd55e4`.
- Existing broker rejected `prepare` with `RELEASE_SHA_NOT_AUTHORIZED`; protected policy is root-owned, mode 0600.
- Existing registered rollback `266d8486ebebc4c668b6a58500dcd938ed20bf17` passed installed root-owned verifier on 4,712 inventory members.
- Local unprivileged policy fixture and adversarial tests: PASS; no changes to `/opt/console-mcp-deploy`.

## Security policy
- This document does **not** authorize executing the administrative operation. Requires an independently authenticated authorized admin SSH session as `alex` followed by `sudo`.
- The Console MCP service account (UID 993) has no privilege to change `/opt/console-mcp-deploy/broker-policy.json` and must never acquire general sudo. Do NOT change that boundary.
- Only `authorizedSha` (exact), `sourcePath` (exact verified clean worktree), `enabledOperations = ["prepare"]`, and a 900-second authorization lease with fixed owner are permitted.
- No `validate`, `activate`, `rollback`, systemd change, restart, tunnel or release cutover.
- The helper has two commands: root-only `--inspect` (read-only) and `--apply --expected-generation <SHA256>` (exact-CAS mutation). Always inspect first; do not automate extraction-and-apply without independent review.
- The `--apply` path holds a protected root-owned lock; reads and compares the expected generation, refuses foreign active leases/unknown policy keys/symlinks, writes a mode-0600 fsync'd **original-byte backup**, then atomically swaps mode-0600 policy with a dir fsync.
- The helper is not yet an installed root-owned script; **never execute a user-writable checkout script directly with sudo**. Independently inspect its source before installing it.

## In separately authenticated administrator SSH (not from MCP service)

```sh
set -eu
src=/home/alex/smartresponse/mcp/.worktrees/.worktrees/stage08-auth-admin-20261118/ops/ubuntu/deployment/stage08-authorize-prepare.py
installed=/opt/console-mcp-deploy/stage08-authorize-prepare.py
expected=31ae95668420f54587ca74c78ced6dd01d803b731c5a490ddba2ddd746dd55e4
printf '%s  %s\n' "$expected" "$src" | sha256sum -c -
# Independently review source for any unexpected privileged behavior here.
sudo -v
sudo install -o root -g root -m 0700 "$src" "$installed"
printf '%s  %s\n' "$expected" "$installed" | sudo sha256sum -c -
sudo stat -c '%U:%G %a %n' "$installed"
sudo /usr/bin/python3 -I "$installed" --inspect
```

Read `policyGeneration`, currently authorized SHA, enabled operations, current source, and any active authorization lease in the inspection output. If there is a foreign active lease or unknown fields, STOP; do not overwrite.

**Separate explicit admin action, after comparing review evidence and the inspection generation:**

```sh
# Replace only with the 64-hex policyGeneration from the immediately preceding --inspect.
generation=PASTE_EXACT_64_HEX_GENERATION_FROM_INSPECT
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/stage08-authorize-prepare.py --apply --expected-generation "$generation"
sudo /usr/bin/python3 -I /opt/console-mcp-deploy/stage08-authorize-prepare.py --inspect
```

Require output `PREPARE_ONLY_AUTHORIZED`, an existing root-owned mode-0600 backup path, `enabledOperations` containing **only** `prepare`, exact SHA and exact sourcePath, lease not expired. If any post-check fails, STOP; no prepare attempt.

## After separate admin authorization
- ChatGPT may make **one** canonical release-broker `prepare` request for the exact merged SHA, with no `activate` or `rollback` call. The broker returns a durable receipt/runId; inspect its status rather than retrying on uncertain completion.
- Only the installed root-owned preparer/controller may create `/opt/console-mcp-deploy/releases/eb5e062023cb40341fc75b56ce26524a9a529f16`.
- Verify sealed release using root-owned installed `deploy.py` verifier in read-only mode, checking `sourceCommit`, `lockfileSha256`, `buildFingerprint`, file hash inventory, root ownership and modes.
- Re-read broker status: active PID, loadedRelease, rollback and registry should remain unchanged. The `prepare` operation may prepare a candidate generation/registry checkpoint but **must not** activate production.
- Do not enable `CONSOLE_MCP_RELEASE_EXTENDED_MAIN_CUTOVER`; actual Transaction facade 10-tool publication in a fresh ChatGPT session is still a separate gate.
- Once preparation has completed and evidence is saved, revoke prepare authorization by a **separate reviewed CAS** or let the bounded lease expire; never extend rights to activate/rollback.

## Stop conditions
- Missing exact merged SHA, tree mismatch, non-clean source, untrusted helper hash, unexpected policy generation, symlink/root ACL mismatch, foreign lease, schema drift, missing immutable rollback, broker denial, missing receipt, or any change to current PID/loaded release.
- Do not bypass root protection or alter credentials; do not run `sudo` inside an MCP service process.
