# Visible Edge integration runtime evidence

Observed 2026-10-15 17:39 UTC on gold. Result: **BLOCKED**, not deployed.
Checkout before work: `cb6a3e7`, branch `fix/ubuntu-workspace-writes`.
Pre-existing database, browser launcher, download/upload, policy and systemd changes were left untouched and excluded from this commit.

## Runtime evidence

Authenticated worker POST `/browser-cdp-targets` returned HTTP 200 on both workers. Every returned target ID matched the complete corresponding CDP `/json/list` inventory:

| Worker | Edge CDP | Targets | SHA-256 of sorted target IDs |
| --- | --- | --- | --- |
| 8791 | 9223 | 11 | 494ada55b2a5f1733d4779951f9c4a3a41f2d0b56a0da8cd407307d317a2ffa4 |
| 8793 | 9224 | 10 | d0325418c0bcb9806d79f7286ca8f741317b790b619d61c1928c2bdecfecf40e |

Authenticated MCP `tools/list` on localhost bearer port 3334 found no `browserSession` property on `read_.web.browser.targets`, `write.web.browser.bind`, or `read_.web.page.capture`. The running process still uses the earlier schema; source regression success does not establish live deployment.

Two existing GC AI `/application` page targets were found on 9224:
`731F49205E35B4EB7491053FA53AD65A` and `9D681C0F71A6B348C278E7E1200B0E83`.
The canonical native verifier returned `WEB_VISIBLE_SESSION_REQUIRED / VISIBILITY_UNKNOWN` for both. No target was guessed, bound, captured, filled, or submitted. Visibility and ambiguity remain unresolved.

Three engine task files had identical SHA-256 values before/after the final inspection. Live task list: 2 failed, 1 completed, zero active/queued tasks. No task or scheduler mutation was requested. The system watchdog timer was already active at initial inspection and was left unchanged.

## Checks

Passed: TypeScript, build, schema validation (including admission and Web routing), repository isolation, repository worker isolation, Ubuntu runtime parity, browser executor, visible session policy, Linux browser diagnostics, Web domain bridge, and observer safety regressions.
Named-check transcripts are in the service's `var/transcript/2026-10-15T17-36-*` through `17-38-*` files. The guarded PowerShell runner returned exit 0 for browser/observer regression checks; it did not return a transcript path.

## Deployment and rollback

The Ubuntu runbook identifies systemd as runtime owner. `systemctl --no-ask-password restart console-mcp.service` failed with exit 1: `Interactive authentication required`. `sudo -n true` also failed: `a password is required`. No service restart occurred. The generic self-restart tool invokes the Windows PowerShell session relay; it was not used to bypass Ubuntu systemd ownership.

Before building, the existing `dist` was archived to `tmp/visible-edge-integration/dist-before.tar.gz` (SHA-256 `634ff435264e84229406c303dbfc268e273c40f6d4e11b10f368c8eabec46e4b`). The validated candidate was archived as `dist-candidate.tar.gz` in the same directory. After deployment authorization failed, the original archive was restored over `dist`; no browser was restarted. These local archives are intentionally untracked and do not contain browser profiles.

Next maintenance window requires an authorized systemd operator: review the candidate's full working-tree scope, preserve task-state hashes and schedule states, install the reviewed build, and restart only `console-mcp.service`. On failure restore the original `dist` archive and restart only that service. Never restart Edge, enable watchdogs, or resume tasks for this deployment. Then rerun the inspection, require live `browserSession` schema evidence and positive native visibility, resolve the two GC AI targets explicitly, bind the selected target and inspect the screenshot/form without submission.

## Repeatable inspection

Run `tool/visible-edge-integration-inspect.ps1` through the guarded Console repository script runner. It reads the existing service credential files internally, never prints credentials, sends authenticated requests only to fixed loopback endpoints, and reports `integrationReady` independently from successful diagnostic execution. It binds/captures only if exactly one existing GC AI target passes the canonical visibility verifier. `-RunRegressionChecks` runs the browser and observer safety regressions without browser mutation.
