# Stage 3C.2: Root-managed optional read-only .releases view

Status: **IMPLEMENTED AS REVIEWABLE UNIT / READ-ONLY PLAN. NOT INSTALLED OR ENABLED**.

The optional `home-alex-smartresponse-mcp-.releases.mount` systemd unit describes
a bind mount with `ro,nosuid,nodev,noexec` from the existing protected physical
artifact store to the sibling `.releases` view. It is **not** a source of truth.
No production service depends on the unit. No runtime activation or rollback
may resolve source bytes through the view.

The filename was confirmed using `systemd-escape --path --suffix=mount` on Ubuntu.
`release-view-mount-plan.py` is read-only and explicitly reports both
`installAuthorized: false` and `runtimeCutoverAuthorized: false`.

## Threat simulation

`release-view-mount-regression.py` simulates a writable parent directory whose
child `.releases` is renamed and replaced with a symlink. It confirms that the
view pathname loses trusted identity. It also rejects weaker mount options.
This test does **not** represent a real kernel mount-namespace attack test.

Because `/home/alex` and workspace ancestors are mutable by `alex`, the
view is inherently replaceable. A bind mount cannot make its *pathname*
sufficient evidence for trusted production storage. Thus the unit is kept
disabled pending review of its optional convenience/DoS tradeoffs, and no
automatic root-side mount installation is supplied at this stage.

## Required before any root installation

- Verify the administrator's expectations for non-authoritative view availability,
  namespace exposure and denial-of-service implications of mutable parents.
- Independently validate mount source device/inode and exact mount ID in the
  target service namespace if a view is installed; an ordinary user-shell
  `/proc/self/mountinfo` result is insufficient.
- Explicitly prohibit release broker and deployment controller from accepting
  `.releases` paths as candidate/rollback values.
- Require real isolated mount tests and rollback proof before activating any
  deployment-generation changes.
- Preserve physical sealed bytes, registry, systemd service, and rollback.
