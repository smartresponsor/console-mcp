# Browser Prompt Supervisor (M1 observation)

This is a centralized, opt-in, read-only diagnostic inside the existing
`read_.browser.edge.session.status` capability. Call with `inspectPrompts: true`.
No new admission checks are added to DOM, DevTools or Playwright operations.

## Signals

- JavaScript `alert`, `confirm`, `prompt`, `beforeunload`: bounded CDP
  `Page.javascriptDialogOpening` observation for up to four exact page targets.
- Windows Edge/Chromium browser chrome: bounded UI Automation scan of windows
  owned by the exact TCP listener PID on CDP port 9223. A localized matching
  label for Restore Pages or Update/Relaunch is `SUSPECTED`, not confirmed.
- A dark monitor, closed lid, minimized browser, or non-foreground window does
  not deny this diagnostic, provided the underlying CDP/session is available.

No observation is **not** evidence that no browser prompt exists. Chrome UI
prompts are not exposed through page DOM/CDP, and inaccessible UIA data remains
`UNOBSERVABLE`. Detection is time-bounded and can miss transient prompts.

## Recovery policy

- No automatic browser restart, tab restore, dialog dismissal, focus change,
  update install, page navigation or form submission.
- A `DETECTED` JavaScript dialog or `SUSPECTED` chrome prompt requires
  independent review and exact session/window identity before recovery.
- Browser prompt recovery must be coordinated with existing browser owner and
  mutation/approval mechanisms; do not duplicate such checks in capabilities.
- Any operation with unknown outcome is never automatically replayed.
- Native UIA inspection is Windows-only. Ubuntu chrome prompt sensing remains
  unimplemented and must not be represented as green.

## Acceptance remaining

Actual Restore Pages / Edge Update / Relaunch incidents, classification under
those incidents, recovery with approval, and post-recovery DOM/Playwright
continuity have not yet been proven in production. The observer does not close
this milestone on its own.
