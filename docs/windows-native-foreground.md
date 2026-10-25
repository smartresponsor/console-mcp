# Windows native foreground verification

The reproduced blocker was display power: the Windows console and session
reported display state 0 (off), despite a visible/foreground HWND and an unlocked
input desktop. A one-shot OS display-on request changed both to 1; the same
process, targets and native/CDP windows then passed genuine foreground acceptance.
No visibility emulation, browser restart or session reset was involved.

## Reproduced before runtime changes

On Windows 10, Edge PID 29044 / interactive session 7 / CDP port 9223:

| Observation | Existing page | Retained blank fixture |
| --- | --- | --- |
| Native HWND | 524462 | 28575144 |
| Browser CDP window | 682320511 | 682321154 |
| Native/CDP bounds | 0,0,1920,1079 | -8,-8,1936,1096 |
| Window state | fullscreen | maximized |
| Display state (console/session) | 0 / 0 | 0 / 0 |
| Page visibility before display-on | hidden | hidden |
| Baseline verdict | VISIBILITY_UNKNOWN | VISIBILITY_UNKNOWN |

The foreground HWND and its owner PID were measured independently. For the blank
fixture, IsWindowVisible was true, IsIconic false, DWMWA_CLOAKED zero, and native
foreground activation was independently confirmed. A reduced actual screen
capture showed the blank Edge window. Both main and isolated CDP worlds returned
the native hidden getter; no main-world override was observed. `hasFocus()` was
true for the selected blank fixture but did not establish document visibility.

Direct page sockets, flattened browser sessions, Page/Runtime enablement, and
focus-emulation disabling all produced the same hidden result. Target activation
and Page.bringToFront did not resolve it. The process used app/fullscreen launch
switches, with no explicit visibility/background/headless feature switches.
PowerSettingRegisterNotification independently measured both displays off.
SetThreadExecutionState(ES_DISPLAY_REQUIRED), without ES_CONTINUOUS, changed the
native notification values from 0 to 1 and page visibility from hidden to visible.
This isolates the cause without assuming that an active HWND proves display power.

The fixture was temporarily minimized to test the denial boundary, then restored
to its original maximized state via normal -> maximized (CDP rejects a direct
minimized -> maximized transition). A temporary inert document in that fixture
also stayed hidden and was restored to about:blank. Original user pages were not
navigated. No browser process or existing session was restarted or closed.

## Confirmed Console defects and changes

1. A boolean false from the page visibility probe overwrote `window=false`.
   `classifyVisibleSession` then reported VISIBILITY_UNKNOWN, conflating a known
   negative page observation with missing native evidence. Page visibility is now
   separate: known hidden yields SESSION_NOT_VISIBLE and no readiness/success
   states. An invalid/missing CDP result still fails as unknown.
2. Windows proof previously compared only window rectangles. It did not require
   the matched native HWND to be foreground. The native helper now reports
   foreground HWND before/after enumeration, minimization, DWM cloaking, and current
   console/session display state. Input-desktop readiness does not mean display-on.
3. `windows-window-proof.ts` requires a unique valid bounds match, known visible
   native state, known powered current-session display (on/dimmed), stable nonzero
   foreground identity, and that exact HWND for an
   interactive request. Identical bounds in multiple windows remain ambiguous;
   selecting whichever happens to be foreground would not prove target mapping.
4. After a successful page observation, Windows native evidence is sampled again.
   A foreground or process/window identity change cannot authorize interaction.
   Background reads may identify a nonforeground window but still never assert
   visibility_verified or user_interaction_ready.
5. `windowsDiagnostic` keeps native HWND matching and page visibility separate.
   A foreground native window plus a hidden page is an explicit denial, never a
   fallback that manufactures visibility. No focus emulation is enabled. Display
   off is an explicit denial; missing power-state evidence remains unknown. The
   console value is diagnostic, not a substitute for current-session authority.

Process ownership, GUI/session/user identity, locking, browser-instance/target
pins, authorization, approval and pre/post interaction gates remain enforced.
No browser restart, retry or tab-closure repair is added.

## Regression coverage and local commands

`tool/windows-foreground-regression.mjs`, included in `npm test`, covers positive
fixture proof, nonforeground windows, foreground races/unknowns, duplicate
bounds, cloaking/missing DWM data, native/CDP minimization, invalid/DPI-mismatched
bounds, display-off/unknown/dimmed and session-vs-console power states, background
identity semantics, hidden pages despite native focus, visible
pages without native foreground, locking, wrong users and genuine ambiguity.
Positive and negative deterministic fixtures are complemented by real Windows
foreground and background-tab observations described below.

Final local gates PASS on Ubuntu and native Windows at runtime head 7f85518:
- `npm run typecheck`, `npm run build`, `npm run smoke`.
- Complete `npm test`, including the new regression and applicable PowerShell tests.
- `npm run schema:validate` including catalog/capability/admission checks.
- `tool/browser-fixture-validation.ps1 -Check admission`.
- Native live negative check using the candidate build on both retained targets.

Real Windows acceptance passes on both the existing page and blank fixture after
display-on: repeated exact foreground proofs succeed, and background observations
still report visibility_verified=false / user_interaction_ready=false. A new
background tab in that same foreground HWND is denied as SESSION_NOT_VISIBLE with
pageVisibility:hidden. Only that newly created empty test tab was closed; every
pre-existing page and the browser instance remained unchanged.

Windows schema evidence: `2026-10-25T14-34-43-488Z-console_schema_validate-7fda8b03.json`.
Ubuntu schema evidence: `2026-10-25T14-31-01-487Z-console_schema_validate-9a431304.json`.
Both complete npm-test chains and explicit admission checks exit 0.

## Operation and integration

The read-only verifier never wakes a display automatically. For an explicitly
authorized native verification, from the built candidate:

```powershell
powershell -NoProfile -File tool/windows-native-foreground-live.ps1 -TargetId <exact-id>
# Only when display activation is explicitly intended:
powershell -NoProfile -File tool/windows-native-foreground-live.ps1 -TargetId <exact-id> -WakeDisplay
```

The optional action requires native same-user/session, unlocked input desktop and
non-headless browser ownership. It resets the display idle timer once; it does not
unlock a desktop, inject input, keep a continuous power lease, change power policy,
activate another tab or override hidden state. Failed readiness still fails.

This focused change is stacked on PR #81 head 99bcaf1. Native Windows foreground
acceptance is now verified; #81 is deliberately left unmerged for review and
integration of this fix. Deployed Ubuntu authenticated-worker/click acceptance
is a separate release step and is not claimed by the native Windows test.

For browser-behavior context only, Chromium documents that native occlusion can
make a foreground tab behave as background. Its implementation also marks windows
occluded on display-off and recalculates on display-on:
https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_native_window_occlusion_tracking.md
https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/aura/native_window_occlusion_tracker_win.cc
https://learn.microsoft.com/en-us/windows/win32/power/power-setting-guids
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
