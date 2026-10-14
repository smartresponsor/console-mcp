# Ubuntu runtime recovery acceptance — 2026-10-13

Outcome: GREEN for the controlled Observer recovery and supported regression suite.

## Initial evidence

Repository `/home/alex/smartresponse/mcp/console-mcp`, branch `fix/ubuntu-workspace-writes`, HEAD `f03491b0095cfd8dc4f49b69c6616e958cba8067`. Existing browser, database, catalog and PowerShell modifications and untracked artifacts were preserved.

Console PID `1947885`; browser PID `1947887`; semantic browser worker PID `1947888`. Console health returned `ok:true`, loaded policy and runtime build fingerprint `1e70a04f693a9a7f`. Initial compiled `dist` fingerprint was `3efca76026090b31`, already different from the loaded Console build.

The Observer timer was active, but its oneshot failed with status 126: the hardened root account could not read `watchdog.sh`. Root lacks `CAP_DAC_OVERRIDE`; script permissions excluded it. At `2026-10-13T13:36:42.813Z`, Capacity Gate was `DRAIN`, with `WATCHDOG_STALE` and `RESOURCE_TELEMETRY_STALE`; telemetry age was 225685.8 seconds.

There were three terminal Engine tasks (two failed, one completed), zero active/queued tasks, and no administratively paused Engine tasks in the live task bank. No pending systemd jobs were present. Relevant Console/browser services were active; no paused service was activated.

Host tools: Node v22.22.2 and npm 10.9.7 in the interactive environment; runtime `/usr/bin/node` v22.23.3; Git available; PowerShell 7.6.4; user-scoped Pester 4.10.1 already installed. No dependency installation, Git global author changes, OS upgrades or unrelated package updates were performed.

## Reviewed repair

- Observer defaults to no lifecycle recovery. Inactive services are `ADMINISTRATIVELY_PAUSED`, failed services `CRASHED`, and an active unhealthy service `DEGRADED`.
- Even explicit recovery opt-in cannot start inactive/failed units. It applies only to an already-active degraded service.
- Browser cleanup has its own explicit opt-in, disabled by default.
- Service classification is included in real watchdog telemetry. A responding endpoint cannot make an inactive service healthy.
- No Engine dispatch, resume, task edits or browser cleanup is performed by default.
- Installer grants the hardened root Observer only read/execute ACL access to Ubuntu scripts. Host ACL activation restored access without adding capabilities.
- Interactive `alex` read/write ACLs and default inheritance were repaired within this checkout so service-created files remain accessible to the repository owner.
- The auto-dispatch regression now uses isolated Git fixtures for worktree fingerprints and adoption promotion, rather than assuming a clean live checkout with at most 200 untracked files. Runtime fail-closed limits remain unchanged.

## Effective systemd activation

No unit or drop-in was changed in this recovery. No daemon-reload was needed. Existing workspace-write override remains active: `ReadOnlyPaths=` and `ReadWritePaths=/home/alex/smartresponse /var/lib/console-mcp`. Existing binds, `ProtectHome=read-only`, `ProtectSystem=strict`, namespace restrictions and capability limits remain intact.

The already-active 30-second Observer timer resumed successful cycles after the narrowly scoped script ACL repair. No Console or browser service restart was necessary: the changed runtime code is the maintenance CLI launched afresh by each timer cycle. Unrelated pending Console/browser/database changes were not activated by restarting services.

## Operational acceptance

Real production observations, with no fabricated telemetry or forced gate decisions:

| Observation UTC | Watchdog/resource age | Capacity | Watchdog/broker PID |
| --- | --- | --- | --- |
| 13:40:48.989 | 15.9 s | ADMIT | 1990692 / 1990692 |
| 13:43:36.092 | 18.2 s | ADMIT | 1991960 / 1991960 |
| 13:45:50.863 | 17.8 s | ADMIT | 1993109 / 1993109 |

Each sample reported fresh resources and heartbeat, consistent ownership, normal resource/Engine pressure, and no active runtime failures. Journal entries confirm recurring successful timer invocations.

All files in the actual Engine state tree matched the pre-activation SHA256 inventory at `/var/lib/console-mcp/recovery-engine-before-20261013.sha256`. There was no accidental dispatch or resumed workload. Administrative pause protection is also covered by executable mocked-service tests and an immutable paused-task fixture.

Live connector Git read succeeded on the target checkout. Guarded `write.repo.git.branch.create` succeeded for `checkpoint/green-acceptance` in a disposable service-owned Git repository. Live `write.repo.file.replace_text` applied a fixture replacement and `read_.repo.file.read` returned the changed text. Write transcript: `/var/lib/console-mcp/transcript/2026-10-13T13-43-49-075Z-replace-in-file-0e702479.json`. The disposable repository was removed afterward.

Actual service-identity/service-mount-namespace create/read/replace/delete probes passed all 86 workspace checks, including opening `package.json` with `O_RDWR` without content changes. Results: `/var/lib/console-mcp/workspace-write-recovery-20261013.json`.

Final Console PID remains `1947885` and loaded Console fingerprint remains `1e70a04f693a9a7f`; browser PIDs remain unchanged. Final compiled `dist` fingerprint is `1be34417f5373836`, including preserved pre-existing source work plus the rebuilt maintenance CLI. This is deliberately not represented as the loaded Console fingerprint.

## Validation and delivery

Passed: TypeScript typecheck; build; Node smoke; executable Observer safety regression; Ubuntu runtime parity; runtime capacity; Ubuntu Engine repair; Git inspection fail-closed regression; five workspace-diagnostic tests; schema validation; complete `npm test` (including Pester 14 passed/0 failed, Console lifecycle 32 passed/0 failed, CLI, restart-failsafe and browser housekeeping regressions).

Full-suite failures during investigation were resolved by isolating Git fixtures, not by relaxing runtime assertions or admission policy. Logs are retained under `tmp/recovery-20261013/` and excluded from delivery.

Remote fetched and checked before delivery: `origin/fix/ubuntu-workspace-writes` equals the initial local HEAD. `origin/master` advanced separately to `8ba7cc5`; it was not merged or overwritten. Only reviewed task-owned files are committed and pushed to the repair branch. No force-push, reset, clean, unrelated merge, reboot or browser restart.

No required operational acceptance blocker remains. Pending unrelated source work remains uncommitted and requires its own review and controlled activation.
