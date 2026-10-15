# Ubuntu Visible Edge runtime

This installation is scoped to alex (UID 1000), Ubuntu GNOME on X11, and `/home/alex/smartresponse/mcp/console-mcp`. Wayland fails closed. GNOME imports DISPLAY, XAUTHORITY and XDG_RUNTIME_DIR into its user manager before activating `graphical-session.target`; no shell/SSH display environment is substituted.

| Unit | Identity | Lifecycle |
| --- | --- | --- |
| `console-mcp-visible-edge.service` (user) | alex | Enabled under graphical-session.target; restores the existing visible profile, adopts matching Edge, detaches on monitor restart, closes on graphical logout |
| `console-mcp-desktop-agent.service` (user) | alex | Enabled under graphical-session.target; authenticated bounded Unix IPC and native window proof |
| `console-mcp-visible-worker.service` (system) | console-mcp-visible | Enabled under multi-user.target; waits for 9224, runs one authenticated loopback worker on 8793, recycles attachment on browser-instance change |
| `console-mcp.service` (system) | console-mcp | Supplemental desktop IPC group only; no X11 cookie/runtime-directory access |

The dedicated worker has a separate primary group and receives only the shared worker token in `/etc/console-mcp/visible-worker.env` (0640). Its home is `/var/lib/console-mcp-visible`; writes are confined there. It cannot read Console credentials or traverse `/run/user/1000`. IPAddressDeny/Allow constrains its network to loopback. Edge performs remote browsing in the actual desktop user context. The IPC exchange group does not provide access to user-session files.

The existing isolated browser unit's explicit `Requires=console-mcp.service` is migrated to `Wants=console-mcp.service`, preserving ordering, other directives and drop-ins. The original unit is retained as `/etc/systemd/system/console-mcp-browser.service.before-visible`. This prevents subsequent Console deployments from restarting isolated Edge and its worker.

## Build and install

Review the intended Git diff first. Preserve unrelated working-tree changes. Build a clean staging checkout of the reviewed commit under `tmp/visible-runtime-20261015`, with the repository's `node_modules` linked and the expected sibling Browsing repository available. Do not build/deploy the unrelated dirty source tree. `tool/visible-runtime-validation.ps1 -Candidate <absolute staging directory>` runs typecheck, build, routing/native policy regressions and desktop agent/client checks through the authorized Console script runner.

Produce `reviewed.sha256` inside staging with SHA-256 entries for every compiled `.js`, the installer, user/system units, tmpfiles configuration, and Python runtime files. Paths may be absolute; verify the manifest before authentication. Run the reviewed `ops/ubuntu/script/install-visible-runtime.sh` with authorized interactive administrator authentication (e.g. `pkexec /bin/bash <absolute installer path>`). It creates identities, grants read-only code access, installs/enables the units, copies only the worker credential, and atomically exchanges the complete dist directory with its rollback copy. It never deletes profiles/task/scheduler data, uses Xvfb for visible mode, or bypasses polkit. A preexisting rollback directory deliberately blocks blind redeployment.

The installed profile is `/home/alex/.config/console-mcp-edge-visible`. Never replace it with the normal desktop profile or isolated `/var/lib/console-mcp-browser/edge-profile`.

## Verification

Use `tool/visible-runtime-acceptance.ps1` through the authorized repository runner. It connects to the real bearer MCP endpoint on loopback 3334, lists live schemas, compares worker/CDP target inventories, checks unauthenticated rejection, presents one existing GC AI tab, binds that exact ID, and captures through MCP. No forms are edited or submitted. Screenshot/form data stays in `/var/lib/console-mcp/run/visible-runtime-capture.json`; only evidence summaries are printed. Reports are `visible-runtime-acceptance.json` and `visible-runtime-locked.json` alongside it. These private runtime artifacts are not Git content.

The three live tools must expose `browserSession: isolated | visible`: `read_.web.browser.targets`, `write.web.browser.bind`, and `read_.web.page.capture`. Capture also accepts an optional exact `targetId`. Visible routing is pinned to 127.0.0.1:8793 and never falls back. Isolated defaults remain 8791/9223.

Run `python3 tool/visible-runtime-security.py` as alex for live IPC envelope checks. The privileged deployment verifier also checks rejection of a root peer, worker inability to read Console credentials or traverse the user runtime, and unchanged isolated PIDs across a Console restart.

For the lock test, lock the actual session with `loginctl lock-session <session ID>`, wait for `LockedHint=yes`, then run acceptance with `-Locked`. Edge and user services must remain alive, and capture must fail with `WEB_VISIBLE_SESSION_REQUIRED` and false interaction readiness. Unlock through normal desktop authentication; never automate a password or force logind's lock flag. Repeat unlocked acceptance afterward.

For monitor restart, snapshot browser PID, browser-instance ID, profile and page IDs; restart only the user Edge monitor and repeat activation. They must remain unchanged and there must be one matching main Edge process. A separate graceful browser restart can verify supervisor reattachment and restoration of page URLs; target IDs and old bindings should change. Full logout/relogin requires an attended desktop session and is separate from a monitor restart.

## Rollback

1. As alex: `systemctl --user disable --now console-mcp-desktop-agent.service console-mcp-visible-edge.service`. While the graphical target remains active, monitor stop deliberately leaves Edge and its tabs open.
2. Through authorized administrator authentication, stop/disable `console-mcp-visible-worker.service`.
3. Atomically exchange `dist` with the original `tmp/visible-runtime-dist-before` rollback directory (Linux `renameat2(..., RENAME_EXCHANGE)`), then restart only `console-mcp.service`. Keep the independent-browser lifetime migration so this does not restart isolated services.
4. Remove `/etc/systemd/system/console-mcp.service.d/60-desktop-ipc.conf` and reload systemd if removing the IPC integration entirely. Preserve the exchange directory/identities until no process uses them. Remove only installed visible user units if desired, then reload the user manager.

Do not remove either browser profile, task files, scheduler state, credentials, or backups as part of rollback. Returning to the previous artifact removes live browserSession support; verify schemas and health again after rollback.
