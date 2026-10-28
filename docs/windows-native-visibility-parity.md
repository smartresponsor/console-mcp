# Windows native visibility parity

Historical implementation and acceptance evidence from 25 October 2026 follows. Its PIDs, HWNDs and deployment/PR state are not current runtime claims. See `windows-browser-integration-acceptance.md` for the consolidated 28 October integration, current evidence and remaining production gates.

This change is stacked on PR 86 (`e86ae2d`), which is stacked on PR 81.
The worktree was created from the fetched `origin/master` (`e95d178`) and
fast-forwarded to that existing implementation before adding this focused delta.
Neither pull request was merged or deployed by this work.

## Root cause and diagnostic boundaries

Live native evidence on 2026-10-25 reproduced session/console display state 0,
while the input desktop was unlocked, the Edge window was foreground and CDP
was connected. A read-only verifier correctly denied `SESSION_NOT_VISIBLE` at
`session-display-off`. PR 86's explicit one-shot display request changed state
to 1; the same process, targets and HWND then passed. No visibility emulation,
browser restart, session reset or browser tab closure was used.

`desktop-preflight` is an availability diagnostic: its ready branch requires
an interactive control process, a detected Edge window, CDP and a ChatGPT target.
It does not prove foreground ownership, active CDP tab or powered display.
Consequently `interactive_desktop_ready` cannot authorize browser interaction.

The live checkout also contains an unconditional Windows
`WINDOWS_NATIVE_VISIBILITY_PROBE_REQUIRED` status placeholder; it is not evidence
of a missing native dependency. The original window tools explicitly returned
`WINDOW_PLATFORM_UNSUPPORTED` outside Linux. Candidate status now invokes the
same native helper as the verifier and separates unavailable probes from
ineligible desktops. Status always leaves interaction/visibility flags false.
The staged status handler returned `WINDOWS_NATIVE_DESKTOP_ELIGIBLE` in session 7.
No production worker was replaced, so old deployed diagnostics may persist.

The heartbeat file is dated `2026-07-20T03:54:06.6488458Z`, session 2. It is
written by the optional desktop heartbeat loop, not consumed by Windows
`inspectVisibleTarget`. Neither native browser verification nor window inventory
depends on it. Its lifecycle was therefore left untouched.

## Identity trace and semantics

1. Fetch loopback CDP version and the exact page target; retain browser WebSocket
   instance and target WebSocket identity.
2. Resolve the target's opaque CDP window ID and bounds via
   `Browser.getWindowForTarget`. Independently require the CDP browser PID from
   `SystemInfo.getProcessInfo` to equal the TCP listener owner.
3. Resolve the unique listening PID with `Get-NetTCPConnection`, then process
   creation time, token-owner SID, user, profile and Windows session. Require
   the probe process and browser to have the same SID and positive session.
   Require active WTS connection and input/thread desktop `WinSta0/Default`.
4. Enumerate current-virtual-desktop top-level windows. Read HWND, owning
   PID/thread with `GetWindowThreadProcessId`, native window class, visibility,
   rectangle, `IsIconic` and DWM cloaking. Recheck `IsWindow` and PID/thread;
   reject stale enumeration entries. Restrict browser candidates to the exact
   listener PID and `Chrome_WidgetWin_1`. Recheck listener owner and creation time
   after enumeration. Hidden/minimized candidates are retained as evidence.
5. Require a unique bounds candidate, matching PID, live thread and expected
   browser class. Duplicate bounds remain ambiguous even with a foreground HWND.
   Require unminimized, uncloaked, visible state, powered current-session display
   and an identical foreground HWND before/after the native snapshot.
6. Independently require the exact CDP page to report visible, without enabling
   focus emulation. Resample native proof after CDP. A failed second probe cannot
   retain the first probe's authorization. Re-read browser instance, target and
   CDP window/bounds before success. Rebinding is required for changed expected
   HWND, CDP window or target, as well as process/SID/session changes.
7. PR 81's authenticated request identity store keeps the identity pin across
   bind/inspect/capture/click requests. Every operation rechecks native evidence
   before and after dispatch; failed postconditions prohibit automatic retries.

CDP does not expose HWND in this contract; its window ID must never be cast to
an HWND. Initial association still requires a unique geometry join *within the
verified process*. Geometry cannot prove foreground, user/session ownership or
active tab. Later operations additionally require the pinned native/CDP tuple.
These are sampled observations, not an atomic OS input lease; instantaneous
changes between samples cannot be eliminated by polling. Ambiguous/missing
evidence, target replacement and observed changes fail closed.

Background identity probes can identify a nonforeground window without proving
an active tab. They keep `visibility_verified=false` and
`user_interaction_ready=false`. A hidden page, minimized/cloaked native window,
locked/disconnected desktop or wrong user/session cannot authorize interaction.

## Window API compatibility

The existing inventory/inspect/focus tool names and schemas are unchanged.
Windows uses the same helper, with bounded hexadecimal HWNDs and the existing
`WINDOW_INVENTORY_READY`, `WINDOW_INSPECTED`, `WINDOW_FOCUS_INSPECTED` and
`WINDOW_NOT_LISTED` status shapes. Fields retain `windowId`, `pid`, `wmClass`,
`desktop`, active/focused/visible/minimized flags and geometry. Windows adds SID,
session and process creation time. Titles are deliberately null. Inventory is
bounded to 128 candidates and confined to the current user/session/virtual
desktop; hidden browser windows remain available for diagnosis. It is diagnostic
evidence and does not establish target visibility or interaction readiness.
Windows activation remains explicitly `WINDOW_ACTIVATION_UNSUPPORTED`; adding
an activation mechanism was unnecessary to verify foreground browser evidence.
Linux IPC and X11 execution are unchanged.

## Validation and live evidence

`windows-native-session-regression.mjs` executes the production verifier with
deterministic OS/CDP boundaries, including SID/session mismatches, locked/off
desktop, multiple processes/windows, identical geometry, foreground changes,
stale HWND, PID reuse, failed second probe, hidden/minimized windows, browser
instance/target/window replacement and background identity. It runs in `npm test`
alongside PR 86's foreground/display matrix and PR 81's continuity suite.

Before/after on the PR 86 proof: a supplied HWND row owned by PID 99 while the
snapshot listener owner was PID 42, with identical geometry and foreground,
was accepted (`reason:null`). The candidate rejects it as
`window-owner-unavailable` / `VISIBILITY_UNKNOWN`. The native helper now exports
and independently rechecks row PID/thread/class instead of leaving that identity
implicit in enumeration filtering.

The staged native acceptance ran in the existing interactive session 7:

```powershell
pwsh -NoProfile -File tool/windows-native-parity-live.ps1 -ApproveHarmlessPage
```

It creates one owned `data:text/html` page with a non-submitting local counter
button. It uses the actual Console guard and existing CDP diagnostic command
function for bind -> inspect -> PNG capture -> actual mouse click. No new browser
control service or worker is launched. Each request has a fresh MCP registration
and the same authenticated test scope. The counter changed exactly 0 -> 1.
Before/after proof retained Edge PID 29044, creation time
`2026-10-21T14:03:52.9558797Z`, session 7, HWND `28575144` (`0x1b405a8`), CDP
window `682321154`, instance `/devtools/browser/78f684e8-3a5b-4c05-b872-32059e835469`.
The retained fixture target is `A2DEF246B89A83FB11D23E5E8066A446`. All original
targets remained present. Inventory returned 15 current-session windows, and
inspect/focus agreed on that HWND. PNG SHA-256:
`ee45f7b89b0d10347cc6a8508aa28957f9e8fbd1183af4254c112f6f780e83d9`.
Local artifacts live under ignored `var/validation/`; raw transcripts and
screenshots are not committed.

This proves staged native guard and real fixture interaction, **not deployed
authenticated-worker authorization or production click success**. The fixture
is retained and the helper never closes any tab. Re-running creates another
owned fixture; it is an explicit acceptance tool, not part of automated tests.

## Integration order and remaining gates

Review/integrate PR 81, then PR 86, then this focused parity delta. Revalidate the
exact resulting master before any managed deployment. No merge, deployment,
browser restart or force push is part of this change. GitHub Actions billing
prevents hosted CI, so the local test/schema/admission/smoke results are the
acceptance evidence. Production authenticated-worker bind/inspect/capture/click
and managed post-deployment verification remain release gates. A session-0
executor correctly fails native desktop proof; it must not be treated as an
interactive-session substitute or repaired by weakening ownership checks.

Win32 API contracts: [GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid),
[CDP Browser](https://chromedevtools.github.io/devtools-protocol/tot/Browser/),
[CDP SystemInfo](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/).
