# PR #102 review follow-up validation

The original implementation required exactly one field in normalization, policy
matching, and quota accounting. A second request was then blocked by the first
request's persistent quarantine. The fix authorizes the complete one/two-field
set once, resolves the shared reference once, and writes pinned elements in one
synchronous browser evaluation. Quarantine surrounds the operation; it is not
re-entered between fields. Partial failure is not reported as successful rollback.

The local HTTPS registration fixture contains password and confirmation controls.
It uses a runtime-generated synthetic secret and a fresh headless test Chromium,
with injected verified-session evidence. It never accesses the real CGA
credential, existing browser profiles or an external registration form.

Validated on Ubuntu with Node 22.22.2:

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | Pass |
| `web-secret-fill-regression.mjs` | Pass, 230 assertions |
| `web-secret-worker-stage-regression.py` | Pass, staging hashes/gates, two-field quotas, quarantine and response filtering |
| `visible-binding-regression.ps1` | Pass: binding continuity, visible session, Linux diagnostics, domain bridge, exact-target routing, desktop session client |
| `web-capability-bridge-regression.mjs` | Pass |
| `web-outcome-policy-regression.mjs` | Pass, including human action required after secret filling |
| `repository-worker-isolation-regression.mjs` | Pass |
| `windows-native-session-regression.mjs` / `windows-foreground-regression.mjs` | Pass |
| `browser-upload-path-regression.mjs` / `console-registration-ast-regression.mjs` | Pass |
| `system-ready-browser-visible-regression.ps1` | Pass |
| `chatgpt-delete-security-regression.ps1` | Pass, 3 Pester tests |
| `infrastructure-security-observations-regression.mjs` | Existing failure at line 10: journal cursor `--since=all` is accepted, while the test expects an exception |
| `ubuntu-worker-path-regression.mjs` | Existing failure at line 24: rendered worker path does not match the expected unescaped path |
| `grants-bridge-routing-regression.mjs` | Blocked: `EADDRINUSE` on fixed fixture port 8797; test refuses to replace an active listener |

Both existing assertion failures reproduce after building an untouched archive of
`02020ef`, before these review fixes. Their implementation/test files were not
changed. The Grants fixture fails before dispatching tool requests; the occupied
listener was neither accessed nor stopped. The Windows-only isolated-worktree
runner's repository-worker suite was run directly on Linux; its junction-creation
wrapper was not used.

The secret regression checks full-pair filling, correct quota units, rejection of
subsets/duplicates/mixed references/wrong fields, target/origin/revision and
session-owner binding, late identity changes, disabled/cross-origin/different-form
controls, missing credential files, replay, partial setter failure, persistent
quarantine and local cleanup auditing, including private-root permission failures. Responses and captured console/error logs
are checked for the synthetic value and its digest; value/evidence/length fields
are forbidden in responses. Neither registration field is submitted.

Cleanup tests use a synthetic private root and injected closed-process proof for
the success case. The real process probe rejects a live test owner before making
any CDP connection. Production cleanup requires both recorded browser and worker
PIDs absent, pinned CDP connection refusal, explicit operation-specific operator
attestation, and a durable private audit before release. It does not inspect
credentials or bypass login, CAPTCHA or MFA.

The configured trusted SSH signing public key is unavailable locally. Existing
local public keys do not match the repository's allowed-signers entry. No signing
keys, allowed-signers entries or Git signing policy were changed. The follow-up
commit must remain unsigned unless that trusted signer becomes available.

PR #102 remains draft. Before deployment: resolve or independently disposition the
existing regression failures, run the Grants fixture in an isolated environment,
perform separately authorized live visible-GUI acceptance using only synthetic
credentials on a local HTTPS registration page, review partial/uncertain cleanup,
and provision matching private roots/policies in the reviewed Console and staged
worker builds. No merge or production deployment was performed.

The repository graph refresh completed successfully after excluding generated output and dependencies from its inputs; only the isolated feature worktree was affected.
