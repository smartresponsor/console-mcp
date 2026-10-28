# Ubuntu Web Secret Fill

Secret filling is opt-in and uses the existing proposal and fill tools with one
field: `{ "controlId": "…", "secretRef": "local-reference" }`. Never supply a
credential as `value`, approval text, URL, environment variable, or MCP argument.
Only `browserSession: "visible"` at 127.0.0.1:9224 is supported. Existing normal
fills retain their current behavior. Unsupported workers fail closed.

## Local configuration (operator only)

Set the same absolute `CONSOLE_WEB_SECRET_ROOT` in the Console and visible worker
environments. Console and worker verify the same directory device/inode before
any preview or resolution so quarantine is shared. Use a dedicated directory outside Git, owned by the service UID,
mode 0700. Each `<reference>.json` policy and credential file must be regular,
single-link files owned by that UID, mode 0600; symlinks and path traversal are
rejected. The directory's canonical path must equal the configured path.

A policy contains exactly `origin`, `controlId`, and `secretFile`. `origin` is an
exact HTTPS origin (including port). `controlId` is the exact inspected semantic
field identity. `secretFile` is a simple local filename using letters, digits,
underscore or dash. Credential files contain the literal credential, without a
newline (at most 4096 characters). Provision credentials directly on Ubuntu;
never fetch them through ChatGPT, Gmail, tool arguments, or command output.
The configured root and symlink aliases are denied by repository file policy,
even when an allowlist would otherwise permit them.
The pre-existing config/secret AWS bootstrap supplies environment credentials;
it is intentionally not used to export browser credentials into the environment.
The existing ignored local-secret convention is retained for optional local files.

## Review and fill

1. Bind the exact visible target. Inspect the field without revealing values.
2. Call `write.web.form.proposal.preview` with `browserSession: "visible"`, exact
   `targetId`, and the reference field. The preview never reads the credential.
3. Obtain explicit authorization for that origin, field, and local reference.
4. Call `write.web.form.fill` with the same field, `approved: true`,
   `approvalText: "APPLY"`, the preview's `approvalReceiptId`, exact
   `expectedTargetId`, `expectedPageRevision`, and `expectedFormRevision`.

The canonical worker authentication, GUI verification, operation lease, challenge
checks, quotas, and atomic one-time receipt consumption remain in place. Secret
receipts additionally hash browser instance, native/CDP window, endpoint, origin,
and reference. No revision drift is permitted. The reference resolves only after
receipt consumption. Only a visible, enabled top-level password input is accepted;
frames, non-password controls and cross-origin form actions are rejected. This
path sets the native input value without emitting events, clicking or submitting.
Some sites require input events; those sites are deliberately unsupported.
Existing login, CAPTCHA and MFA guards remain unchanged and can reject a fill.

## Quarantine and diagnostics

Before reading a credential the worker atomically creates `quarantine` in the
private root. Subsequent worker requests and Console browser/desktop/engine tools
are denied, including after runtime recreation. The fill response is a fixed
allowlist, including when post-operation verification fails. No values, hashes of
values, lengths, Playwright evidence or exception messages are returned. DEBUG,
PWDEBUG, NODE_OPTIONS, coverage and Playwright trace directory settings prevent
resolution. Do not enable external protocol recording or process-memory capture
in a credential runtime; the runtime and service UID are trusted.

An operator must close the affected page and verify that browser history, URLs,
clipboard, other pages, and any site-produced echoes contain no credential before
removing `quarantine` locally. There is no MCP reset endpoint. Restarting does not
clear quarantine. This conservative restriction prevents later captures from
revealing a credential echoed by the authorized page. The destination origin is
necessarily trusted with its input value. Other same-UID processes are trusted.

## Offline staging and deployment boundary

`python3 ops/ubuntu/script/stage-web-secret-worker.py --source <browsing/playwright-worker>
--destination <new-private-candidate-directory>` copies a supported worker into an
isolated candidate and adds the trusted module. It does not modify Browsing,
browser profiles, services, or Edge. The worker source and dependency SHA-256 hashes are pinned; changes
require reviewing authentication, visibility, receipt, quota and response hooks.
Use `--console-root` to select the reviewed Console build; relocated candidates
import that build explicitly. Run `node --check <candidate>/src/worker.js` before deployment. Keep this staged
worker opt-in; do not point a running service at it during implementation.

Before production use, deploy this Console build and the reviewed worker candidate
with matching private-root configuration, provision exact local policies, and
perform a separately authorized visible-GUI acceptance test. The automated HTTPS
regression uses a fresh headless Chromium, a synthetic runtime-only credential,
real one-time receipt storage, and injected verified-session evidence. It tests
the trusted route and actual DOM write; it does not claim live GUI verification.
Existing visible-session regressions cover the independent GUI gate.

Run `npm run typecheck`, `npm run build`, `node tool/web-secret-fill-regression.mjs`,
`node tool/web-domain-bridge-regression.mjs`, and
`node tool/visible-browser-session-regression.mjs`. If Playwright's matching browser
is unavailable, set `CONSOLE_TEST_CHROMIUM_EXECUTABLE` to a test Chromium executable.
No production browser or profile is used, and no form is submitted.

Staging regression: `python3 tool/web-secret-worker-stage-regression.py --source <browsing/playwright-worker>`. This also exercises output filtering and persistent quarantine middleware.
