# Desktop Session IPC Contract — staged implementation

## Ownership
Console MCP is the only remote MCP endpoint and owns authorization, task state and browser lifecycle. The desktop agent is an unprivileged, login-bound GUI observer. It MUST NOT expose an HTTP service, start Edge, alter profiles or accept arbitrary shell commands.

## Stage 1 (implemented)
The agent binds a Unix stream socket at `$XDG_RUNTIME_DIR/console-mcp-desktop-agent.sock` with permissions 0600. It accepts only the literal `status` request, responds with one JSON line and never claims `visibility_verified` or `user_interaction_ready`. This socket is intentionally inaccessible to the system service identity `console-mcp`.

## Stage 2 (not implemented)
A dedicated narrowly-authorized intermediary must authenticate the caller using kernel-provided Unix peer credentials (SO_PEERCRED) and allowlisted service identity. Do not grant Console access to `/run/user/<uid>` as a whole, change ownership of the user socket, copy session cookies, or use SSH DISPLAY/XAUTHORITY impersonation. Any communication boundary must have independently testable authorization and explicit rejection of unrecognized calls.

Protocol version 1 request: bounded JSON containing `version: 1`, `operation` (initially `status` only), a unique `requestId`, and no arbitrary executable, filesystem path, URL or CDP WebSocket destination.
Response: bounded JSON with the same `requestId`, a machine-readable status and separately scoped booleans `desktopEligible`, `visibilityVerified`, `userInteractionReady`. An eligible desktop is not a verified window; success must not be promoted across these states.

## Stage 3 (not implemented)
Only after desktop ownership and a specific X11/compositor window can be verified, add `discover`, `attach`, `present` with explicit `runtimeId` and `targetId`. Require an active unlocked local session, browser PID/UID/start time/profile, endpoint identity and a current window proof. Re-check before and after any action. Wayland requires compositor-approved evidence; no automatic fallback to Xvfb.

## Operational invariants
- Existing isolated CDP 9223 and its persistent profile remain intact; desktop discovery 9224 is read-only until the binding is verified.
- Unknown/locked/remote GUI state must fail closed with `WEB_VISIBLE_SESSION_REQUIRED`.
- systemd user unit is opt-in and tied to the graphical session. Deployment and restart are not part of a code commit.
- Socket mode 0600 is *not* a complete peer-authorization design; it is only stage-1 local isolation.
- No live session, profile migration, or service restart is justified by successful unit tests alone.
