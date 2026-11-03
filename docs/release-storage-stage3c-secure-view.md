# Stage 3C — protected physical store and optional .releases view

Status: **DESIGN + READ-ONLY PROBE. NOT DEPLOYED. NO PRODUCTION CUTOVER.**

## Security decision

User approved variant A. Preserve a root-owned physical release store (currently
`/opt/console-mcp-deploy/releases/`) as the **only production authority**.
The sibling `/home/alex/smartresponse/mcp/.releases/` is a **navigational view**,
not an independently trusted path for activation. Mutable Git worktrees stay in
`/home/alex/smartresponse/mcp/.worktrees/`.

The selected, verified release SHA and rollback remain in the root-owned registry;
sealer, launcher and rollback must resolve physical release bytes via protected
controller configuration. An optional view can be mounted read-only by an independently
authorized root-only setup, but it MUST NOT supply candidate paths to production.

## Threat boundary

The ancestors of `.releases` include user-owned, writable directories. The
user can rename/replace these ancestors. Therefore even a root-owned mountpoint,
read-only bind mount, or symlink below these ancestors **cannot establish stable
pathname authority for production**. No forceful chown of the home directory is allowed.

Read-only `release-view-admission.py` examines an exact mount entry from
`/proc/self/mountinfo`, its read-only mount option, and the mounted directory's
device/inode identity against the trusted physical store. This is only
namespace-local **diagnostic evidence**; a successful result is NOT authorization
for cutover. Mountinfo escaping/namespaces must be accounted for by any future
controller-level integration; this initial probe deliberately fails closed.

The Stage 2 canonical mode is still blocked by its strict ancestor protection
rule; it must NOT be enabled for the mutable `.releases` path. The protected
physical root remains the effective default while logical view functionality
is validated separately.

## Next controlled operations

1. Continue legacy physical store SHA-256 attestation and loaded systemd bind checks.
2. Prepare a reviewed, least-privileged systemd mount unit for the optional view;
   do not mount it automatically or modify production.
3. Validate root-controlled mount source in both broker and production mount namespace
   and test user-initiated ancestor rename against mounting/view path identity.
4. Keep activation bound exclusively to root-owned physical artifacts, validating
   release and rollback before and after any mount-view changes.
5. Only after these gates, expose the optional read-only view; production cutover
   is a **separate** privileged transaction.

No requirement to relocate sealed bytes into an unsafe user-owned tree.
