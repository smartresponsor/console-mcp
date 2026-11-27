# Workspace Ownership Contract — Ubuntu

Use a narrow write boundary, not recursive chmod/chown across `/home/alex/smartresponse`.

## Identity and isolation

- Developer: `alex`; Console runtime: `console-mcp`; browser worker remains isolated.
- Console and browser workers intentionally use `UMask=0077` for private state and secrets. Do not weaken their unit isolation.
- Shared writable root is `/home/alex/smartresponse/workspaces` (created with group `smartresponse`, setgid and default named-user ACL). Place new multi-writer workspace artifacts there, not in private service state.
- Existing `mcp/console-mcp/dist` is an explicitly approved exception: repair named-user ACL in that generated directory only so builds under the developer account work.
- Existing source trees, `.git`, `.env`, `/etc/console-mcp`, service profiles, `/var/lib/console-mcp-browser`, and other runtime state are out of scope. In particular, the script does not recursively grant access to the entire platform workspace root.

## Procedure

Run the script's `audit` mode from a terminal; it does not require sudo and does not change files:

```bash
bash /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/workspace-ownership.sh audit
```

Review ownership/ACL output, then apply with an authorized root session:

```bash
sudo bash /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/workspace-ownership.sh apply
```

Prerequisites: `acl` package, existing `smartresponse` group and users `alex`, `console-mcp`. The apply operation refuses symlinks in `dist`, does not elevate itself and is safe to rerun.

The current apply path is a single durable transaction across exactly the two approved targets: workspaces and generated dist. It snapshots every regular file and directory (UID, GID, mode, access ACL and default ACL), rejects symlinks/special files/mount boundaries and hard-linked files inside either target, detects concurrent tree changes, and writes a root-only journal outside both targets, then applies named-user ACLs and directory default ACLs. It does not run chown or chmod.

Recovery uses the same target order and the durable journal:

```bash
sudo bash /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/script/workspace-ownership.sh recover
```

If apply is interrupted or rollback fails, do not remove the journal or retry apply. Run recover after verifying both approved target paths; it restores the full pre-transaction ACL snapshot and verifies UID/GID/mode/inode identity before deleting the journal. If concurrent tree changes are detected, the transaction preserves its journal rather than claiming a complete rollback; reconcile the added/removed/moved entry first, then run recover. The journal directory is /var/lib/console-mcp-ownership (root:root, mode 0700); an existing directory with different metadata is rejected. Both target directories must already exist; this script does not create either target.

Then validate npm run build, npm run typecheck, npm test inside mcp/console-mcp. Service restart and browser smoke testing are separate reviewed deployment operations.

## Scale-up rule

New consumer workspaces use shared root and inherited ACL when multi-writer access is needed. Generated build outputs should normally be created by the developer or an isolated build runner, and only promoted read-only to production services. A production MCP service must never recursively change ownership of source repositories. Add a dedicated path and access review for every newly introduced service identity.
