# Desktop Session IPC Contract

The graphical user service owns the desktop verifier. Console and the constrained visible worker are clients. The verifier never launches a browser, accepts executable paths/URLs, changes a form, or exports X11 credentials.

## Authorization

The dedicated `/run/console-mcp-desktop` exchange directory is owned by `alex:console-mcp-desktop`, mode 2710. Its socket `agent.sock` is 0660. Console and the worker receive only the supplemental exchange group. No access is granted to `/run/user/1000`; the worker explicitly hides that directory.

The server checks Linux `SO_PEERCRED` before reading a request and accepts only UID 1000 and the installed `console-mcp` and `console-mcp-visible` UIDs. Root and unknown UIDs are rejected. The bounded Python client checks the server's kernel UID is 1000 before sending a request, and checks the response request ID. A dedicated flock prevents duplicate agents and permits safe stale-socket recovery.

Protocol requests are newline-delimited JSON, maximum 4096 bytes: `version: 1`, `requestId` (1–64 alphanumeric/hyphen characters), `operation: status | verify`, and, for verify, one 32-hex `targetId`. Unknown fields, ports, URLs, paths and commands fail closed. Responses are bounded to 65536 bytes. The endpoint and profile are fixed, never caller-selected.

## Evidence and readiness

`status` identifies exactly one local alex X11 logind session. It correlates GNOME's imported DISPLAY/XAUTHORITY with processes in that session's scope and checks the cookie file owner, without reading or transmitting cookies. Active and unlocked status establishes eligibility only; diagnostic responses always report false visibility/readiness.

`verify` executes the fixed native verifier as alex, for CDP 9224 only. The verifier joins the actual listening socket inode to one Edge PID/UID/executable, checks the persistent profile and process start time, and identifies its user-session or GNOME application scope. Edge clears its environment and rewrites argv after moving to an application scope; this does not remove the requirement for native window proof in the independently authenticated X session.

Native proof requires the active, mapped window's `_NET_WM_PID`, current workspace, nonhidden state, and exact CDP bounds converted with X11's native `Xft.dpi`. The target must be the foreground tab (`document.visibilityState`, measured with focus emulation disabled in the verifier's own CDP session). Login/lock state and expected browser identity are checked on every pre/post operation. Browser instance or start-time changes invalidate old bindings. Wayland remains unavailable until compositor-approved window evidence exists.

CDP connectivity, target existence, process identity, graphical eligibility, visible-window verification and interaction readiness remain separate states. A connection or eligible desktop alone never authorizes an action. Lock, ambiguity, wrong profile/UID/instance, a different active window, or missing evidence fails closed with `WEB_VISIBLE_SESSION_REQUIRED`.

## Lifecycle

GNOME's active `graphical-session.target` owns the enabled Edge monitor and desktop agent. Screen locking leaves both services and Edge running while operation authorization fails closed. Restarting the monitor adopts the same verified browser without closing its tabs. Graphical logout stops the agent and gracefully closes the matched browser; relogin imports a fresh GNOME environment and restores the existing profile/session. The worker has no GUI access and waits for 9224, restarting only its CDP attachment process when the browser instance changes. No Xvfb is used by this runtime; isolated 9223/8791 remains separate.
