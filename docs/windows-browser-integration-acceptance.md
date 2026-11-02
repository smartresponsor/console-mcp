# Windows browser integration and acceptance, 28 October 2026

Historical candidate evidence. SHAs, paths and validation results below describe
the 28 October candidate, not the current deployed release.

## Release state

Integration baseline: `be32037` (committed baseline of the existing Windows deployment checkout). Dedicated branch: `integration/windows-browser-acceptance-20261028`. The worktree was relocated to `C:/Users/Admin/console-mcp-browser-integration-20261028` after dependency installation on D: failed for lack of space. Production's dirty source files were not incorporated or edited.

This is a validated release candidate, not a deployed or operationally accepted release. Previous candidate dist fingerprint (before the readiness policy revision below): `1dbbda44073f7f6f`; historical live Console fingerprint: `bcdd0500df9701cd`. Rebuild fingerprints must be recorded again if executable contents change. Generated dist, dependencies, private logs and session evidence are not committed.

## Existing implementations reused

| Commits | Responsibility |
| --- | --- |
| `843203a`, `7f85518` | Foreground HWND identity/stability, cloaking/minimization, powered session display |
| `dc4c43a`, `f36d16b` | Native PID/SID/profile/start identity, CDP browser PID and window/target continuity, window diagnostics, deterministic and attended acceptance tools |
| `9abec6e`, `7bf4b71` | Actionable native denial reasons and corrected fixtures |
| `9bfe18f` | Explicit active-session scheduled launch helper and inert scheduler regression |
| `f5a0b3e` | Behavioral ownership/attachment contract against the real Browsing worker |
| `683a824`, `d867aa8`, `900501f`, `afa236c` | Existing exact-target/form routing prerequisites, without unrelated grants integration |
| `cef2a9c`, `42d417d`, `de22381`, `f5d4ea4` | Authenticated stateless identity pins, ambiguity resolution and binding/window continuity tests |

The HWND-only backport `51d7c14`/`ee5f5db` is not substituted for the complete verifier. Its helper/window changes are already represented by the full native work. Browsing remains unchanged; its existing ownership and external-CDP profile protections are retained.

New integration glue is limited to passive status/deadline handling, tests and compatibility adjustments. `inspectWindowsNative` retains its default 12-second budget and accepts a smaller explicit budget. Passive status uses the remaining request budget and never runs an undefined-port probe. HTTP requests also have an absolute deadline, so trickled response bytes cannot extend execution indefinitely.

`NOT_PROBED` means no ready endpoint, invalid endpoint, or exhausted budget before native execution. `WINDOWS_NATIVE_PROBE_UNAVAILABLE` means an attempted native operation failed, timed out or produced incomplete evidence. A completed snapshot returns desktop eligibility/ineligibility with a specific reason and exact endpoint. Desktop eligibility is not foreground/display/target authorization: passive readiness flags always remain false.

The readiness policy revision below supersedes the original foreground/display admission policy for CDP operations. Statements about display/foreground denial in the original validation matrix describe native GUI admission, not universal browser admission.

Existing stateless binding pins are keyed by authenticated profile/token hash, never raw credentials. They retain identity, not visibility or approval. Every operation rechecks shared process/session/endpoint identity and its capability-specific proof; CDP observation cannot clear the CDP window pin or confer native GUI readiness.

## Validation matrix

All lifecycle changes below operated on disposable fixtures, random loopback ports and owned child processes. No production restart, scheduled-task launch, browser navigation, focus/display change, profile modification or CanonScanning activation was performed.

| Gate | Result | Evidence |
| --- | --- | --- |
| Build and typecheck | PASS | `var/validation/build.log`, `typecheck.log` |
| Full npm test suite, including 14 Pester tests | PASS | `var/validation/full-test-final.log` |
| Schema, registration and capability admission | PASS | `var/validation/schema.log` |
| Admission projection and consumer smoke | PASS | `admission.log`, `admission-smoke.log` |
| Authenticated disposable Console smoke | PASS | `smoke.log` |
| Native foreground/session boundaries | PASS | `windows-foreground-regression.log`, `windows-native-session-regression.log` |
| Missing evidence, wrong account/session, display off, minimized/cloaked, stale target, duplicate HWND and identity change | PASS | Native deterministic regressions; no live desktop changes |
| Passive NOT_PROBED/unavailable/denial, undefined port, deadline and no readiness | PASS | `windows-passive-status-regression.log`; includes real streaming HTTP fixture |
| Real Console/Browsing ownership contract and unsafe-guard negative controls | PASS | `visible-browser-session-regression.log`; real worker path required |
| Actual Browser HTTP middleware with this candidate's canonical verifier | PASS | `browser-http-integration.log`: 12 automation routes deny invisible fixtures, 3 lifecycle routes cannot launch, authentication/diagnostics preserved |
| External-CDP attachment and target binding | PASS | `web-external-cdp-attach-regression.log`, `web-target-binding-regression.log` |
| Stateless authenticated target/window pin continuity | PASS | `visible-binding-continuity-regression.log`, `visible-target-routing-regression.log` |
| Watchdog session-launch contract, wrong principal and session zero | PASS | `watchdog-session-launch-regression.log`; fake scheduler only |
| Broker identity/recovery, restart failsafe and incident grouping | PASS | `broker-matrix.json`; fixtures only |
| Disposable native-contained start/stop, authenticated health and rollback | PASS | `runtime-lifecycle-final-evidence.json`: 16 scenarios, cleanup and all allocated ports released |
| Live watchdog heartbeat and scheduled-task last result | FAIL | Broker PID absent after disk-full heartbeat failure; task result 0x800710E0 |
| Live scheduled recovery / attended interaction / production cutover | BLOCKED | Not authorized by this workflow; live conditions below also prevent acceptance |

The first broad run exposed stale expected denial names and a fixture relying on obsolete rediscovery. Fixtures now require the reused actionable reasons and identity-pin behavior. On C:, the generic RC test also needs a process-local extra allowed root; no production policy was changed. The source validator interpreted a tool-name prefix literal as an admitted tool, so the equivalent prefix condition uses a regular expression rather than introducing a fake tool declaration.

## Reproduce isolated validation

Install dependencies only on a volume with adequate free space. Do not run build/install in the production worktree. The real Browsing checkout must be discoverable as a sibling (or set the explicit worker path below); the local C: validation used a junction to the existing Browsing checkout, without editing it.

```powershell
$env:CONSOLE_MCP_EXTRA_ALLOWED_ROOTS = (Get-Location).Path
$env:CONSOLE_MCP_BROWSER_WORKER_SOURCE = 'D:\PhpstormProjects\www\mcp\Browsing\playwright-worker\src\worker.js'
$env:CONSOLE_MCP_REQUIRE_BROWSER_WORKER_CONTRACT = '1'
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run schema:validate
npm run admission:check
npm run smoke:admission
npm test
node tool/smoke-test.mjs
node tool/windows-passive-status-regression.mjs
node tool/windows-native-session-regression.mjs
node tool/visible-binding-continuity-regression.mjs
node tool/visible-target-routing-regression.mjs
pwsh -NoProfile -File tool/watchdog-session-launch-regression.ps1
pwsh -NoProfile -File tool/ssh-control-broker-regression.ps1
```

Disposable process/rollback validation reused the existing tooling at `a587a11` in `console-mcp-version-aware-20261028`. Its `runtime-*.mjs` modules and `windows-contained-process.*` were copied to the ignored `var/lifecycle-harness/tool` directory. The harness root held copies of this candidate's dist/policy/package files, a node_modules junction, and a separate copy of the deployed dist/policy/package as the previous version. No live configuration/secrets were copied. Set `RUNTIME_PREVIOUS_ROOT` to that previous fixture and `RUNTIME_VERSION_EVIDENCE` to a C: evidence path, then run `node var/lifecycle-harness/tool/runtime-version-transaction-regression.mjs`.

The upstream harness embeds the historical label `ee5f5db`; that label is not the tested candidate's provenance. The candidate/harness dist fingerprints were independently compared and equal (`1dbbda44073f7f6f`). Harness provenance, actual integration tree and build fingerprints must accompany its scenario results. The harness tests isolated side-by-side rollback, not production fixed-port/OAuth handoff or successful interactive broker activation.

The real Browser HTTP regression was also run from an isolated C: fixture containing copies of the unchanged worker source and its existing `web-visible-session-regression.mjs`. A sibling `console-mcp` junction resolved its import to this candidate's dist. Its dependency junction was read-only in use; no live Browser worker or actual browser target was used. The mock CDP and worker listened on dynamically allocated ports and the test cleaned up only those owned processes.

## Live read-only evidence and incident

Console PID 20940, Browser worker PID 16444 and Edge PID 25464 remained in session 7. Console retained loopback 3333/3334/3335, Browser worker 8791, and Edge 9223. Edge's explicit profile remained `D:/PhpstormProjects/www/mcp/browser/profile`; CDP browser PID matched listener ownership. The page target was `0E7E086B5FEF0195BE41A7C4F7B51582`, CDP window 682321302, fullscreen bounds 0,0,1920x1079.

A read-only invocation of the existing committed native helper through the live Console process produced actual session-7 evidence: same account/session, WTS/input desktop ready, Edge HWND 19072428 with matching PID/thread/class/bounds, visible, non-minimized and uncloaked. Display state was 0 (off); foreground HWND was 65934, not Edge. The helper SHA256 matched the integrated helper. Feeding that snapshot and read-only CDP bounds to the pure proof function returned `session-display-off` / `SESSION_NOT_VISIBLE`. Samples are timestamped observations, not an atomic live interaction lease. No Session 0 failure was used as a Session 7 denial.

Production still returns the old hardcoded status because it has not loaded this candidate. Shared registry metadata is historical and cannot establish current ownership/readiness.

**A storage incident occurred during this workflow.** The first dependency installation exhausted D:. The watchdog's last record at 14:18:15 CDT reports insufficient disk space while writing a broker heartbeat; PID 30820 subsequently disappeared. The installation was moved to C: and succeeded there; D: later had only 18,841,600 bytes free. Storage capacity should have been checked before installation. The surviving Console/Browser/Edge processes were not restarted or killed. No watchdog repair was attempted under the no-restart/no-task-launch constraint. Current recovery readiness is BLOCKED, not CADENCE_HEALTHY. Evidence: `watchdog-storage-incident.json` and final live topology.

The scheduled watchdog task remains configured as enabled Interactive/Admin, Limited, five-minute repetition, IgnoreNew, no restart retries. Its last result is 2147946720 / 0x800710E0. No fresh bootstrap receipt establishes a successful launch. TaskScheduler Operational logging is disabled; the exact current scheduler refusal cause remains unproven. The explicit-session helper fixes generic invocation but does not prove periodic-trigger recovery.

## Production mutation boundary and rollback

The next actions require a separately approved maintenance window: restore sufficient D: headroom; recover the session-bound watchdog through its managed control path; demonstrate a fresh matching receipt/broker/session/generation/advancing heartbeat; validate the scheduler path; deploy the immutable Console artifact and, only if required for imported-module compatibility, reload the Browser worker. No scheduled task definition change is included or currently justified.

Existing versioned-release commits `04c5017`, `f1ce27f`, `a587a11` are a separate deployment dependency, not an activated part of this candidate. The live launcher still targets fixed `$Root/dist/index.js`; pointer changes alone cannot activate or roll back the running process. Disposable tests do not prove fixed-port, OAuth or broker handoff. Do not copy dist over the dirty production checkout.

Before an approved cutover, retain immutable previous Console and worker artifacts/configuration, provenance hashes, entrypoint/cwd/environment, process creation/session/account identities, broker generation, endpoint/authentication baseline, and Edge PID/start/profile/target/window identities. Do not overwrite the last-known-good artifact or copy browser profiles/cookies.

On failed bounded post-cutover health, the managed broker must stop only the exact candidate process tree, restore the previous entrypoint/cwd/environment (and worker artifact if changed), and launch the previous artifact. Require expected previous fingerprint, loopback ownership, authenticated MCP initialize/tools-list/health, public metadata 200 and public unauthenticated MCP OAuth 401, plus fresh broker heartbeat. Do not route public OAuth through 3334. Recheck Edge identity and targets; invalidate old bindings after any process change. Leave failed rollback blocked for operator recovery rather than relaunching browsers or retrying mutations blindly.

Attended browser acceptance additionally requires a powered/unlocked session and foreground Edge, fresh exact-target proof, and a separately approved harmless interaction with before/after continuity. Waking/focusing the desktop, performing that interaction, launching the scheduled task, restarting workers or switching production were not authorized here and were not performed. Production operational acceptance remains BLOCKED.

## Capability-specific readiness revision

The canonical verifier now separates `cdp` and `native-gui` admission while sharing listener/process/account/session/profile/start-time identity verification. Windows CDP consumers default to `cdp`; native consumers explicitly select `native-gui`. Linux retains its previous default and desktop-agent protocol.

| Evidence / state | CDP operations | Native GUI operations |
| --- | --- | --- |
| Display off; background Edge; minimized/cloaked window | Admissible with valid shared identity and exact target | Denied without required desktop/window proof |
| Browser PID differs from CDP browser PID; wrong SID/session; missing profile/start identity | Denied | Denied |
| Endpoint/instance/target or CDP window replacement | Denied | Denied |
| Native HWND changes without a CDP window change | Not a CDP identity change | Existing HWND pin remains mandatory |
| Locked Windows session (WTS SessionFlags = LOCK) | Denied | Denied |
| Input Desktop unavailable while WTS reports UNLOCKED | Admissible for CDP/Playwright when browser identity and target are verified | Denied for native input operations |
| WTS lock state unavailable | Report `SESSION_STATE_UNKNOWN`; never mislabel it as `SESSION_LOCKED` | Denied pending reliable session evidence |

The canonical verifier reads the WTS session lock flag independently from `OpenInputDesktop`. `inputReady` is retained only as native GUI/input evidence; it is not a CDP/Playwright prerequisite and must never be translated into `SESSION_LOCKED`. Display power, lid state, minimized/cloaked window state, foreground ownership and page visibility do not gate CDP admission. Native GUI diagnostics retain window visibility, minimized/cloaked and foreground checks for operations that actually send native input.

Consumer review:

- `visible-browser-tools.ts` selects CDP admission for an explicit list of web capture, bind, navigation, click, form review/fill/submit operations. File upload and unclassified engine/native/lifecycle tools conservatively retain desktop admission. Existing tool approval, security, leases and authenticated binding scopes remain in force; caller input cannot choose capability.
- The unchanged Browsing worker imports the canonical verifier for its CDP/Playwright routes. Its default Windows probes now use CDP admission. The worker retains external-CDP ownership, token authentication, exact-target attachment, no fallback browser launch, and pre/post checks. It never obtains native readiness from a successful CDP proof.
- Direct browser open/close consumers use CDP admission; their confirmation, profile, ownership and terminal-close checks remain unchanged. Native desktop verify/focus CLIs explicitly request native admission.
- Passive status separately emits `cdpReadiness` and `nativeGuiReadiness`. It can report session eligibility without display power, but both `ready` fields remain false until exact-target operation verification. Native diagnostics identify display-off independently.

CDP verification resamples native process identity and endpoint/target/window metadata before returning. Advertised browser/page WebSockets must use the verified loopback port. A CDP window identity is mandatory. Bounds, foreground, HWND availability and page visibility do not substitute for identity and are not CDP admission requirements. A successful CDP verdict emits `CDP_TARGET_BOUND`, `cdp_ready=true`, `native_gui_ready=false`, `visibility_verified=false`, and `user_interaction_ready=false`.

Authenticated stateless pins still deny process/profile/start-time/session/instance/target/CDP-window changes. Native admission additionally preserves HWND continuity. State-changing handlers retain pre/post verification; failed post-verification reports an unknown outcome and forbids automatic retry. Approval remains a separate handler decision.

### Revised isolated evidence

Evidence directory: `var/validation/readiness-policy/` (ignored local transcripts). Revised dist inventory SHA256: `b1d1fbc1f42cfb6f5e599531cb629466c4070c8e6cabb33ddec6c2d3a2aaf814` (SHA256 of compact JSON sorted path/content-SHA256 inventory; full inventory in `artifact-inventory.json`). This is a complete artifact inventory digest, not the historical supervisor fingerprint above.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | PASS |
| `node tool/windows-cdp-readiness-regression.mjs` | PASS: display off/background/minimized/cloaked CDP; native denial; locked/disconnected denial; wrong owner/session/PID; stale target/window/instance; changed process/profile/start identity; wrong socket port; missing CDP window; approval and post-operation failure |
| `npm test` | PASS: complete suite including the new regression, native foreground/session, passive status, authenticated binding continuity, ownership contract, Pester, and disposable lifecycle/preflight fixtures |
| `npm run schema:validate`, `npm run admission:check`, `npm run smoke:admission` | PASS |
| `node tool/smoke-test.mjs` | PASS: disposable authenticated Console transport |
| Existing isolated real Browsing HTTP middleware fixture | PASS: 12 unsupported/incomplete-evidence routes denied before mutation, 3 lifecycle routes cannot launch, token authentication and diagnostics preserved |

The new verifier regression replaces OS/CDP boundaries with inert fixtures and executes actual Console admission before invoking a harmless handler. Native regressions explicitly request native capability. Authenticated binding regressions retain CDP-window denial and separately exercise native HWND denial. The worker ownership contract verifies exact-target reuse, failed-attach refusal, and absence of profile creation/kill/launch in verified external-CDP mode. No real browser target/profile, focus, display state, session, production artifact, service, or task was changed. These results establish isolated policy behavior, not live desktop acceptance or deployment readiness.

Production deployment remains blocked. This revision does not repair the previously recorded watchdog/storage incident or activate a candidate. Live locked/disconnected operation support requires separate operation-specific evidence before any admission expansion.
