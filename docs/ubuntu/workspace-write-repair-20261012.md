# Ubuntu workspace write repair — 2026-10-12

## Result: activation blocked, not ready

All operations targeted the actual Ubuntu host `alex-HP-Spectre-x360-Convertible-15-df1xxx` and canonical repositories under `/home/alex/smartresponse`. Host shell and connected Ubuntu MCP health both identify service PID `4162404`. No Windows paths, copied repositories, commits, pushes, or production-source write probes were used.

Administrative activation is unavailable: repeated `sudo -n true` and `sudo -n -l` report `sudo: a password is required`. No credentials were requested or exposed. The systemd repair is prepared but **not installed or activated**. The running service still rejects source writes with EROFS and still runs the old Git-inspection code. Cookie-consent implementation is deferred until write access and live Git diagnostics are verified healthy; its subsequent default remains `essential_only` with human approval for ambiguity and legally significant agreements.

## Root cause and effective configuration

`systemctl cat/show` confirms the loaded fragment is `/etc/systemd/system/console-mcp.service`, with no drop-ins. Systemd is version 255. Host `findmnt -T /home/alex/smartresponse` shows ext4 mounted `rw`.

The service's actual `/proc/4162404/mountinfo` shows:

- `/home`: `ro`.
- `/home/alex/smartresponse`: `rw`.
- `/home/alex/smartresponse/mcp`: `ro` — the conflicting nested mount.
- Workspace `var/run`, `var/log`, and `var/transcript`: writable bind mounts from `/var/lib/console-mcp`.
- `/var/lib/console-mcp`: `rw`.
- Root filesystem and `/etc`: `ro` in the service namespace.

| Property | Active before and now | Prepared target |
| --- | --- | --- |
| User / Group | console-mcp / console-mcp | unchanged |
| Supplementary groups | console-mcp, smartresponse | unchanged |
| ProtectSystem | strict | strict |
| ProtectHome | read-only | read-only |
| PrivateTmp | yes | yes |
| ReadOnlyPaths | /home/alex/smartresponse/mcp | empty |
| ReadWritePaths | /var/lib/console-mcp, workspace, three runtime subpaths | /home/alex/smartresponse /var/lib/console-mcp |
| BindPaths | three runtime state/log/transcript binds | unchanged |
| StateDirectory | console-mcp | unchanged |

PrivateTmp does not redirect workspace paths. The bind mounts explain why transcript writes succeed despite source writes failing. No remount was attempted. No hardening outside the workspace was weakened.

## Changes made

On branch `fix/ubuntu-workspace-writes`, created from the prior `fix/ubuntu-artifact-handoff` branch with all existing changes preserved:

- `ops/ubuntu/systemd/console-mcp.service`: remove the conflicting read-only path and simplify the writable exception to the workspace and state directory. Preserve all binds and other hardening.
- `ops/ubuntu/systemd/console-mcp.service.d/50-workspace-write.conf`: deployment-ready override for the currently loaded configuration.
- `src/tool/git-inspection.ts`: required inspection failures return `ok:false`, explicit `GIT_STATUS_UNAVAILABLE` or `GIT_OWNERSHIP_UNSAFE`, stderr, exit codes, and unknown (`null`) dirty/status fields. Normal absent upstream remains supported; unexpected upstream failures fail closed. Sync planning and branch/push verification cannot accept failed inspection. Remote summary propagates failure.
- `tool/git-inspection-fail-closed-regression.mjs`: invalid repo, clean/dirty repo without upstream, partial status failure, unexpected upstream failure, unsafe ownership, missing Git, sync/push guards.
- `ops/ubuntu/script/workspace-diagnostics.py`: bounded read-only operational diagnostic with service namespace mount checks, effective UID/GID/groups, numeric ownership and ACL assessment, sandbox configuration, Git status under the intended execution identity, and explicit classifications.
- `tool/workspace-diagnostics-regression.py`: nested mount precedence and path boundaries, host read-only mounts, unavailable namespace, ACL mask/group permissions, Git ownership and unavailable status.
- `package.json`: `test:ubuntu-workspace` validation command.
- This report: operational evidence, outstanding activation and permanent capability design.

Browser repository metadata was corrected independently: all 7,908 inspected regular-file/directory entries had owner/group `alex:alex`. Group was changed to `smartresponse`, matching the canonical workspace sharing model. Ownership remained `alex`. All regular-file modes, including 84 read-only files, were preserved. All 836 directories now inherit the shared group via setgid. Symlinks were excluded. This changes no file contents or Git history. Metadata rollback inventory is `tmp/browser-workspace-metadata-before-20261012.json`; restore only those recorded entries, after checking for later metadata changes.

Existing changes and untracked files in both repositories were retained. No staging, commit, merge, push, reset, clean or checkout was performed. A normal TypeScript build regenerated ignored runtime output; no generated output was patched directly. Activation will load the current build, which includes the previously existing local source changes; review those before restarting.

## Actual write and Git tests

A disposable fixture in Console MCP's existing `tmp/` directory was created by the host as `alex:smartresponse`, mode `660`, then deleted after testing. No production source file was modified for a probe.

| Running MCP action | Result |
| --- | --- |
| Exact replacement, dryRun=true | ok=true, applicable=true, applied=false |
| Same replacement, dryRun=false | ok=false, applied=false, EROFS |
| Transcript generation | Both calls returned /var/lib/console-mcp/transcript references |
| Browser Git branch status | Incorrectly returned ok=true, null branch/HEAD, isDirty=false on old live code |
| Browser Git log | ok=false, exitCode=128, fatal: detected dubious ownership |
| Browser Git diff | ok=false, exitCode=129, not a git repository |

MCP transcript references:

- `/var/lib/console-mcp/transcript/2026-10-12T10-44-48-688Z-replace-in-file-93ae1549.json`
- `/var/lib/console-mcp/transcript/2026-10-12T10-44-56-921Z-replace-in-file-71a5554b.json`

Transcript references are returned by the running MCP. Direct host reading is denied by the intended runtime permissions. Transcript recording worked during both calls; source writing did not.

Browser repository and `.git` remain owned by UID 1000 (`alex`); Git executes through the service as UID 993 (`console-mcp`), GID 988, supplementary GID 1001. Shared ownership is intentional. Group access is now corrected; Git's separate owner trust still needs the exact repository exception for the service account. `/var/lib/console-mcp/.gitconfig` is owned by console-mcp with mode 600, so its contents cannot be inspected from this unprivileged session. Do not replace it, change repository ownership to the service, or set `safe.directory=*`.

## Validation

Passed: TypeScript typecheck, build, Git fail-closed regressions, five workspace diagnostic regression tests, standalone smoke test, and `git diff --check`. `systemd-analyze verify` accepted the canonical unit and emitted an unrelated existing anydesk legacy PIDFile warning.

The initial regression fixture inherited the surrounding repository. Its assertions failed (exit 1); moving the isolated fixture under the non-repository canonical workspace root fixed test discovery without broadening runtime environment permissions. Final regressions pass.

The read-only operational diagnostic intentionally exits 1: service mount conflicts remain, and running Git as the service via sudo is unavailable. It never substitutes the host user's successful Git status for the service's unknown state. It does not perform writes or prove successful modifications.

Project-required graph rebuild completed: 232 repository code files, 2,295 nodes, 4,544 edges and 228 communities. The initial unrestricted scan included 2,881 files (ignored dependencies/generated outputs) and was stopped after prolonged CPU use; the successful rebuild filtered to non-ignored repository files. Graph generation is not proof of service health.

## Outstanding controlled activation

Recheck the service, configuration, repository locks, child processes and engine pressure immediately before activation. At diagnosis time, the service was active, no direct child repository process or Git lock/merge/rebase marker was found, and the live engine worker reported zero active/queued tasks. User login sessions were present. This snapshot is not a permanent assertion that no later operation is active.

Preserved evidence in the canonical repository `tmp/`:

- `console-mcp-unit-before-20261012.txt`
- `console-mcp-properties-before-20261012.txt`
- `console-mcp-mountinfo-before-20261012.txt`
- `workspace-diagnostics-before.json`
- `workspace-diagnostics-current.json`
- `browser-workspace-metadata-before-20261012.json`

After administrative access is available and fresh idle checks pass, deploy **only** the prepared drop-in to `/etc/systemd/system/console-mcp.service.d/50-workspace-write.conf`, recording any existing file first. Reinspect all drop-ins; the reset is appropriate to the confirmed single conflicting ReadOnlyPaths entry, not to unknown future restrictions. Leave other units unchanged.

Inspect service-account Git trust with `sudo -u console-mcp git config --global --show-origin --get-all safe.directory`. If the exact Browser repository is absent, add only `/home/alex/smartresponse/mcp/looping/browsing` with `sudo -u console-mcp git config --global --add safe.directory /home/alex/smartresponse/mcp/looping/browsing`. Preserve all other configuration. Only add Console repository trust if its own Git inspection demonstrates the same need.

Then run `sudo systemctl daemon-reload` and `sudo systemctl restart console-mcp.service` using the established host control connection. No other MCP services, workers, watchdogs or machine restart is required by the diagnosed conflict.

Verify the new PID is healthy through the actual Ubuntu MCP, inspect its new namespace, and confirm every representative sandbox mount is rw while `/home/alex` and `/etc` retain ro. Repeat disposable fixture create/replace/delete and guarded patch dry-run/actual-apply tests in both repositories through the running MCP; verify hashes and transcript references. Confirm Browser Git now reports its real dirty state, and failed inspection never reports success. Keep outside-workspace negative probes non-destructive and bounded. Do not infer write success from mount flags, host writes, build tests or git apply --check alone.

Rollback the mount repair by restoring the recorded prior drop-in state (currently no drop-in), daemon-reloading and restarting only console-mcp when idle. Preserve unrelated source changes. A source rollback, if necessary, must apply inverse patches only to this task's changes rather than reset the worktree.

## Permanent read-only MCP capability design

Proposed canonical name: `read_.repo.workspace.diagnostics` (consumer alias `read.repo.workspace.diagnostics` if the projection supports it).

Input: a bounded `workspacePath` or existing opaque repository binding. Resolve with existing PathGuard/realpath rules against the canonical allowed root. Do not accept shell strings, arbitrary commands, arbitrary service names, caller-selected PIDs, or paths to configuration/secret files.

Collect in the service itself using its own UID/GID and `/proc/self/mountinfo`; expose canonical root, repository directory and `.git` ownership, ACL write assessment, longest matching mount and its options, fixed sandbox property whitelist, Git availability, actual status, sanitized failure stderr/exit code, request correlation ID and established transcript reference. Optional locks must be disabled during Git status. Do not query environment values, secret files, other users' contents, remote credentials or arbitrary Git config.

Return independent workspace/Git results and statuses `WORKSPACE_READY`, `WORKSPACE_READ_ONLY`, `WORKSPACE_PERMISSION_DENIED`, `WORKSPACE_MOUNT_CONFLICT`, `GIT_OWNERSHIP_UNSAFE`, `GIT_STATUS_UNAVAILABLE`, `WORKSPACE_DIAGNOSTICS_INCOMPLETE`. Unknown namespace/permissions/Git state must prevent an overall successful result. A read-only readiness assessment is distinct from the separately recorded actual write verification. Never classify unknown Git state as Canonical GREEN.

The operational collector and classification regressions are implemented now. **The new MCP capability is designed but not registered or admitted to consumer catalogs in this repair.** Implement its adapter through the existing read-only registration/admission/transcript infrastructure, without adding a general shell-execution capability. The CLI's PID argument is a host diagnostic feature and must not be copied into the MCP contract.

Reproduce operational diagnostics with `python3 -B ops/ubuntu/script/workspace-diagnostics.py` from the canonical Console repository. Reproduce focused regressions with `npm run test:ubuntu-workspace`.


## Activation continuation — administrative boundary

Resumed from this report without repeating the initial investigation. Revalidated the loaded unit against the prepared drop-in: fragment remains `/etc/systemd/system/console-mcp.service`, PID `4162404`, no loaded drop-ins, conflicting `ReadOnlyPaths=/home/alex/smartresponse/mcp`, and the same writable exceptions and three runtime binds. The prepared override remains appropriate to this configuration and leaves all other hardening intact.

Authentication attempts:

- `sudo -n true`: exit 1, `sudo: a password is required`.
- `pkexec --disable-internal-agent /usr/bin/id`: exit 127, `Error executing command as another user: No authentication agent found.` This attempted the external interactive authorization mechanism without enabling a terminal password prompt or collecting credentials in logs. No elevated command executed.

Stopped at the privilege boundary. No deployed configuration, Git configuration, ownership, running service, or production source was changed during this continuation. Existing branch and working-tree changes remain intact. No unrelated service was restarted and no autonomous repository feature work began.

Fresh running Ubuntu MCP evidence:

- Console repository Git log for `src/tool/git-inspection.ts`: `ok=true`, exit code 0, stderr empty. Console repository trust already works; do not add a redundant trust entry.
- Browser repository Git log for `playwright-worker/src/human-boundary.js`: `ok=false`, exit code 128, `fatal: detected dubious ownership in repository at '/home/alex/smartresponse/mcp/looping/browsing'`.
- Both repository roots and `.git` directories remain `alex:smartresponse`, mode 2775. No ownership adjustment was performed.

Actual filesystem write/read/delete verification after activation, new-namespace hardening checks, and post-activation regression/health validation remain pending. Prior passing regression tests and prepared changes do not establish live readiness. **Status remains BLOCKED / NOT READY, not GREEN.**

### Minimal administrator activation commands

Run in an authenticated Ubuntu host terminal after confirming the connector is idle and rechecking that the loaded configuration still matches the snapshot above. Authenticate in that terminal only; do not provide credentials through MCP, chat or logs. The existing drop-in must be absent: if the test fails, stop and inspect/backup that file rather than overwrite it. The base unit is untouched; prior configuration and namespace snapshots are already recorded in `tmp/`.

```bash
set -e
sudo -v
sudo test ! -e /etc/systemd/system/console-mcp.service.d/50-workspace-write.conf
sudo install -D -m 0644 /home/alex/smartresponse/mcp/console-mcp/ops/ubuntu/systemd/console-mcp.service.d/50-workspace-write.conf /etc/systemd/system/console-mcp.service.d/50-workspace-write.conf
sudo -H -u console-mcp git config --global --add safe.directory /home/alex/smartresponse/mcp/looping/browsing
sudo systemd-analyze verify /etc/systemd/system/console-mcp.service
sudo systemctl daemon-reload
sudo systemctl restart console-mcp.service
sudo systemctl is-active console-mcp.service
```

The exact Browser trust exception applies to the service account's own global Git configuration; it neither replaces that file nor trusts other repositories. Do not repeat the addition once successful. Restart only the named service. Configuration validation must succeed before reload/restart.

Administrator activation is only the next step, not completion. Resume this task afterward to perform actual file creation, readback, replacement and deletion through running Ubuntu MCP capabilities in disposable diagnostic paths; verify guarded repository writes and Git inspections in both canonical repositories; inspect the new process namespace and preserved outside-workspace restrictions; run `npm run test:ubuntu-workspace` and operational health checks; append their observed results and transcript references here.


## Interactive authentication attempt and fresh preflight

The user authorized sudo activation. A masked sudo terminal prompt was confirmed, but credentials were not passed in tool arguments or logs. A fixed, mode-700 askpass helper under the canonical repository's `tmp/` launches `/usr/bin/zenity --password` on Ubuntu display `:0`; its output goes directly to sudo, not to the task log. An external desktop authentication dialog titled “Authorize Console MCP workspace repair” was opened. Authentication has not completed, so no elevated activation command has executed. No supplied credential is included in this report or helper.

Fresh preflight: current service is active at PID 4162404; the same conflicting nested read-only path and runtime binds remain loaded; no direct child repository operation or Git operation marker was found; live engine status reports zero active and queued tasks. Prepared unit verification succeeded with the existing unrelated anydesk PIDFile warning. `npm run test:ubuntu-workspace` passed (build, Git fail-closed regressions and five diagnostic tests); output is in `tmp/workspace-regression-activation.log`.

No ownership, service configuration or Git trust was modified, and no service was restarted. Readiness remains unverified until authentication, activation and actual running-MCP writes succeed. Recheck idle status if authentication occurs later.

## Activation completed — 2026-10-12

Installed `50-workspace-write.conf` in `/etc/systemd/system/console-mcp.service.d/`, verified the unit, reloaded systemd and restarted Console MCP. Effective `ReadOnlyPaths` is empty and `ReadWritePaths` is `/home/alex/smartresponse /var/lib/console-mcp`. Service PID after activation: `1947885`; active/running. OAuth endpoint returned expected unauthenticated HTTP 401.

Recursive physical ACL updates grant `console-mcp` `rwX` access to existing workspace entries and default `rwx` ACL inheritance on directories. Symlinks were not followed. Prior ACLs were saved to `/var/lib/console-mcp/workspace-acl-before-20261012.txt`. Actual create/read/replace/delete probes ran as `console-mcp` inside the running service mount namespace. All 86 checks passed, including workspace root, all physical immediate child directories, Console/Browsing repositories, and opening Console `package.json` with `O_RDWR` without modifying content. Results: `/var/lib/console-mcp/workspace-write-verification-20261012.json`.

These results verify filesystem writes under the service identity and namespace; they do not claim end-to-end connector tool calls or resolve the separate Git trust diagnostics discussed above.
