# Ubuntu Web Secret Fill

Secret filling is opt-in through the existing proposal and fill tools. Supply one
or two fields, each `{ "controlId": "…", "secretRef": "local-reference" }`.
For password/confirmation, both fields must use the same reference and be in the
same form. Never supply credentials as values, URLs, environment variables,
approval text or MCP arguments. Only the verified visible session at
127.0.0.1:9224 is supported. No form is submitted.

## Local configuration (operator only)

Set the same absolute `CONSOLE_WEB_SECRET_ROOT` in Console and the visible worker.
Both verify the directory device/inode so quarantine is shared. Use a directory
outside Git, owned by the service UID, mode 0700. Policies and credential files
must be regular single-link files owned by that UID, mode 0600. Symlinks and path
traversal are rejected. The root's canonical path must equal its configured path.
Repository file reads deny this root and symlink aliases even through allowlists.

A pair policy contains exactly `origin`, `controlIds`, and `secretFile`:

```json
{"origin":"https://registration.example.invalid","controlIds":["password-control","confirmation-control"],"secretFile":"credential"}
```

`origin` is an exact HTTPS origin including port. `controlIds` is the complete
inspected field set: subsets, duplicates, extras and mixed references are denied.
The legacy `controlId` policy remains supported for a single field. `secretFile`
is a local filename using letters, digits, underscore or dash. Its contents are
the literal credential without a newline, at most 4096 characters. Provision it
directly on Ubuntu; never retrieve a real credential through ChatGPT or Gmail.

The existing config/secret bootstrap supplies environment credentials. Browser
credentials intentionally remain out of the environment; local-secret ignore
conventions are retained. No real CGA credential is needed for implementation or
acceptance tests.

## One approved operation

1. Bind the exact visible target and inspect both field identities.
2. Preview the complete field array using `browserSession: "visible"` and the
   exact `targetId`. Preview reads the policy, never the credential file.
3. Obtain explicit authorization for the origin, reference and complete field set.
4. Fill with the identical array, `approved: true`, `approvalText: "APPLY"`,
   `approvalReceiptId`, `expectedTargetId`, `expectedPageRevision` and
   `expectedFormRevision` from the preview.

One one-time receipt binds the complete ordered operation, target, revisions,
HTTPS origin, browser instance, native/CDP window, endpoint and session ownership.
Authentication, GUI verification, leases, challenges, quotas and anti-replay
controls remain in force. One pair counts as one form fill and two field writes.
The worker resolves both locators before reading any credential, rechecks GUI
ownership and revisions, and pins the actual DOM elements and form. It validates
both controls before resolution and again immediately before mutation. Frames,
non-password fields, hidden/disabled/read-only controls, cross-origin actions and
pairs in different forms are rejected.

The shared reference resolves once. One synchronous browser evaluation writes and
verifies both values, without events, awaits, clicks or submission. Quarantine is
created once for the operation and does not interrupt its second field. This is
an atomic authorization/execution unit, not a promise of rollback: if a page
setter fails after the first write, the response is opaque and quarantine remains.
Some sites need input events; they remain unsupported. Existing login, CAPTCHA
and MFA guards can still reject filling. Authentication is never bypassed.

## Quarantine and operator cleanup

Before resolution, a durable mode-0600 `quarantine` record stores a random
operation ID, consumed approval receipt ID and pre-fill browser/target identity,
never credentials, value
lengths, value hashes, field contents, page URLs or DOM evidence. Success, partial
failure, secret-read failure and uncertain post-verification all retain quarantine.
Invalid, inaccessible or incorrectly owned private roots also fail closed.
Subsequent worker and Console browser/desktop/engine requests are blocked across
restarts. Successful fills are classified as waiting for local operator action,
not permission to continue automation. Fixed response envelopes suppress exception
messages and browser evidence. DEBUG, PWDEBUG, NODE_OPTIONS, coverage and trace
directory settings prevent resolution. External protocol/memory recording must
remain disabled; the runtime, service UID and authorized origin are trusted.

There is no MCP/HTTP reset endpoint and no automatic unrestricted reset. The
local-only cleanup command does not read the credential file, browser DOM,
history or clipboard. A trusted operator must:

1. Read only the private quarantine metadata locally to identify the operation and
   affected browser. Keep it out of chat and tool arguments except the nonsecret
   operation ID when invoking the local CLI.
2. Resolve any login, CAPTCHA or MFA normally. Never use cleanup to bypass it.
   Review the affected browser locally for credential echoes, history/URL traces,
   clipboard contents, saved form data, downloads, other tabs and recording output.
   Remove any sensitive traces locally without copying them into diagnostics.
3. Stop/detach the relevant worker and its browser watchdog through the approved
   local maintenance procedure. Close the recorded browser instance. Cleanup
   deliberately cannot run while that browser or originating worker PID exists or the pinned 9224
   listener accepts connections. It never stops services or closes browsers itself.
4. After reviewing local traces and closing that instance, invoke locally:

   ```sh
   node ops/ubuntu/script/cleanup-web-secret-fill.mjs --operation-id <operation-id> --acknowledge BROWSER_CLOSED_AND_LOCAL_TRACES_REVIEWED
   ```

   The configured private root must match. The command serializes cleanup,
   requires the exact operation ID and acknowledgement, confirms both processes are
   absent and CDP refuses connections twice, and durably records operator UID,
   timestamp and pre-fill target identity in `cleanup-audit/<operation-id>.json`
   before removing quarantine. No credentials or free-form notes enter the audit.
5. Restart only through the approved deployment/maintenance process when
   authorized. Re-bind, re-inspect and obtain a fresh approval. Cleanup cannot
   revive consumed receipts or authorize a new browser instance.

Unknown/legacy markers, permission errors, live or reused browser/worker PIDs, CDP timeouts,
changed marker identity, existing audit records and interrupted cleanup all fail
closed. Preserve marker/audit/lock files for local investigation; do not delete
those records to force a retry. An audit denotes authorized release, not proof
that local traces were independently inspected. That review is an explicit
operator responsibility. A crash can leave a durable audit with quarantine still
active, requiring local maintenance review. No cleanup is performed during tests
against production.

## Offline staging and acceptance

The Browsing sibling owns the canonical worker. Stage a new isolated candidate:

```sh
python3 ops/ubuntu/script/stage-web-secret-worker.py --source <browsing/playwright-worker> --destination <new-private-directory>
```

Source/dependency hashes are pinned; drift requires security review. Use
`--console-root` to select the reviewed Console build. Staging imports that build
explicitly and does not modify Browsing, profiles, services or Edge. Keep the
candidate opt-in. Unsupported workers fail closed for secret operations.

Before deployment, provision policies and matching private-root configuration,
deploy the reviewed Console and staged worker builds only when authorized, and
perform separately authorized visible-GUI acceptance against a local HTTPS
registration page with synthetic credentials. Verify ownership, both password
fields, partial failure quarantine, post-verification and operator cleanup. The
automated test uses fresh headless Chromium and injected verified-session evidence;
it does not claim live GUI verification. No external registration is needed.

Validation: `npm run typecheck`, `npm run build`,
`node tool/web-secret-fill-regression.mjs`, and
`python3 tool/web-secret-worker-stage-regression.py --source <browsing/playwright-worker>`.
Also run the existing security, visibility, worker and bridge regressions. Set
`CONSOLE_TEST_CHROMIUM_EXECUTABLE` to an installed test Chromium if Playwright's
matching executable is unavailable. Tests never use a production browser profile.
