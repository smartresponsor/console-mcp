# Visible Browser Session Standard

CDP reachability, a page target, and a running browser do not prove that a user can see the browser. Interactive tools succeed only with `VISIBLE_TARGET_BOUND` evidence. No invisible fallback, synthetic target identity, new profile, or independent Browser MCP browser is permitted.

## Ownership and enforcement

Console owns the canonical verifier in `src/service/visible-browser-session.ts`. Console tool registration uses `enforceVisibleBrowserTools` for Web, legacy browser mutations, interactive engine tools and recovery commands. Browser MCP imports that verifier from the deployed Console build and applies an authenticated, serialized request gate to all automation routes. Pre-verification happens before attachment/navigation; post-verification checks the resulting target and the original runtime identity. Existing fill/upload/submit approval receipts and human boundaries remain independent mandatory checks.

Browser MCP is attach-only. Restart, kill and fresh-runtime routes require Console orchestration and do not launch or kill browsers. Read-only health and target inventories remain available, explicitly with unverified visibility. Diagnostic `ok` denotes diagnostic/CDP success, never interaction readiness. Raw CDP target lists may contain sensitive page URLs; telemetry contains session identifiers only, no cookies, tokens, page text or full process arguments.

State observations: `CDP_CONNECTED`, `BROWSER_TARGET_EXISTS`, `BROWSER_PROCESS_RUNNING`, `GUI_SESSION_IDENTIFIED`, `VISIBLE_WINDOW_VERIFIED`, `VISIBLE_TARGET_BOUND`, `USER_INTERACTION_READY`. Blocked operations return `WEB_VISIBLE_SESSION_REQUIRED` plus an explicit reason: unavailable GUI, unknown visibility, headless/nonvisible session, other session, stale browser/target, ambiguity or a busy lease. Observed login/challenge boundaries continue to return `WEB_HUMAN_ACTION_REQUIRED` through the existing capability policy. No authenticated state is inferred from CDP.

## Native verification

Linux: select exactly one active, local logind graphical user session (optionally narrowed by operator-configured `CONSOLE_MCP_INTERACTIVE_USER`). Identify the endpoint's actual listening socket inode and browser PID, UID, process start time and explicit profile. Require membership in that logind session scope; DISPLAY/XAUTHORITY alone are insufficient. Join CDP `Browser.getWindowForTarget` bounds to exactly one X11 mapped window belonging to that PID on the current desktop, excluding hidden/minimized windows and requiring an unlocked session. Frame extents are considered. Missing metadata, denied /proc/X access, unmatched bounds or missing desktop evidence fail closed.

Windows: join the local TCP listener to a native browser PID/profile/start time. Require the same interactive nonzero process session and account, an active WTS connection and access to the WinSta0/Default input desktop, and a visible, non-minimized HWND on the current virtual desktop matching the target's CDP bounds. Linux never reuses Windows target IDs or routes Linux loopback to Windows. No cross-host execution route is introduced.

Wayland without compositor window evidence, remote GUI sessions without a verified access relationship, and restricted service sandboxes are unsupported for positive binding and explicitly fail closed. Strict matching intentionally prefers a truthful block over a guessed visible window. Multiple eligible targets are not silently selected; specify target identity. Evidence is gathered anew for each operation; restart changes browser-instance/start identity and invalidates binding.

## Gold environment and deployment

On gold, the installed browser service runs as console-mcp on Xvfb :99 with an isolated existing profile. The active local logind session belongs to alex. That display has no verified access relationship to alex's desktop and is ineligible. Preserve its cookies/profile; do not relaunch onto a guessed display or grant broad X access.

Build Console before deploying the Browser worker because the worker imports Console's canonical build. Validate both repository test suites and visible-session regressions. Deploy only through the existing controlled maintenance route after inspecting execution/lease pressure; never restart the browser to deploy this contract, reactivate stopped watchdogs, or claim production verification from a test worker. If service authorization is unavailable, report that deployment blocker and leave live workloads untouched. Windows native execution needs validation on an authorized Windows host before cross-platform GREEN.

Native API references: [CDP Browser window binding](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-getWindowForTarget), [Microsoft OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop). OpenInputDesktop alone can succeed in a disconnected session, so WTS connection state is checked separately.
