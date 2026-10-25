# Issue #84: browser fixture drift and integration evidence

## Reproduction and confirmed causes

Clean branch `fix/84-browser-fixtures` starts at origin/master
`04ec98aab13a9ce967a09930dec8d744a7e7039e`. No runtime or fixture changes
were present for baseline reproduction (only a guarded test runner was added).
Build passed, then both original fixture commands failed independently:

| Command | Failing assertion | Expected / actual | Cause |
| --- | --- | --- | --- |
| `node tool/visible-browser-session-regression.mjs` | line 83, `doesNotMatch` | No `chromium.launchPersistentContext` or `cdpBrowser.newContext` anywhere / legitimate managed-mode launch code exists | The fixture conflated managed ownership with Console-verified visible attachment. |
| `node tool/web-domain-bridge-regression.mjs` | line 129, quota recovery status | `WEB_SESSION_ROTATED_REINSPECT_REQUIRED` / `WEB_BROWSER_WORKER_CONFIGURATION_INVALID` | `expectedTargetId` without `browserSession` intentionally routes form writes to visible; visible URLs are pinned to port 8793, so the ephemeral isolated fixture endpoint was never called. |

The baseline runner returned 2 (two failed commands). Full stdout/stderr and exit
status were saved locally to `/tmp/issue84-baseline.json`.

After repairing the first assertion, a second stale assertion in the same visible
fixture surfaced: `/visibleRequest.run(before, next)/` rejected the worker's
`visibleRequest.run({ ...before, preserveActiveTarget }, next)`. This preserves
native proof and adds read-capture behavior; it is not a loss of authorization.
The quota fixture passed on that intermediate run; visible failed, runner exit 1.
Full output: `/tmp/issue84-target-first.json`.

Actual runtime boundaries were inspected in the sibling worker's `ensurePage`
and visible middleware, and Console's `web-domain-bridge.ts` session selection
and pinned URL validation. The failures are fixture drift; no runtime bug or
production repair was established or introduced by this issue.

## Fix and deterministic safety coverage

- `tool/visible-worker-contract.mjs` extracts the real worker attachment function
  with TypeScript's AST and executes it with inert browser/filesystem doubles.
  It verifies ownership rejection before side effects, attach failure with no
  launch fallback, reuse of the exact target, stale-target rejection without a
  replacement tab, and the legitimate separately owned managed launch path.
- The AST also requires exactly one async request-context boundary forwarding
  the complete native proof, with only the optional active-target flag added.
- `tool/visible-browser-session-regression.mjs` invokes that contract and includes
  negative mutations: removing ownership rejection or swallowing attach failure
  must make the contract fail. Recovery-orchestration and approval checks remain.
  The existing optional sibling-mount convention remains unchanged; on this host
  the actual sibling worker source was present and tested.
- `tool/web-domain-bridge-regression.mjs` explicitly selects `isolated` for quota
  recovery. Added assertions preserve implicit visible routing, pinned endpoint
  rejection, and absence of fallback/network requests to either invalid worker.
  Existing no-replay, fresh approval, post-recovery, and non-force checks remain.
- `tool/browser-fixture-validation.ps1` runs fixtures, npm test, or admission
  checks through the guarded runner. `-TrustWorktree` explicitly calls the existing
  confined safe.directory handler for a service-account/user-owned worktree.
  It never grants wildcard trust or disables verification.

## Local gates (Ubuntu, Node 22.23.3, PowerShell 7.6.4)

On this standalone branch:
- PASS: targeted fixtures (runner exit 0), typecheck, build, smoke, admission
  projection and admission smoke, `git diff --check`.
- `npm test` passes the repaired visible fixture and Pester 14/14, then stops at
  the pre-existing catalog validator's 20 staged declarations (PR #83).
- Full schema validation stops at the same pre-existing catalog check, before
  reaching its browser fixtures. No validators are skipped or weakened here.
- Standalone full-run evidence: `/tmp/issue84-standalone-full.json`.
  Named schema transcript: `2026-10-25T02-17-18-111Z-console_schema_validate-6dffbb51.json`.

A separate disposable worktree, `console-mcp-issue84-integration`, rehearses this
fix plus PR #83 commits `09c5238` and `7e5c9d6` using `cherry-pick --no-commit`.
The existing PR #83 worktree and the focused #84 branch do not contain this overlay.
- PASS: complete `npm test`, including console regression, cmcp CLI, restart
  failsafe, housekeeping, deployment preflight, and applicable PowerShell tests.
- PASS: typecheck, build, exact consumer tools/list smoke, full schema chain,
  catalog/capability admission and staged contracts.
- The first detached-head schema rehearsal skipped admission diff; this was
  corrected with an explicit local rehearsal branch/upstream and a full rerun.
  No skipped admission check is used as final integration evidence. Final schema
  exit 0, stderr empty, `ADMISSION_DIFF_GREEN`, transcript
  `2026-10-25T02-21-37-377Z-console_schema_validate-d39eedd0.json`.
  Typecheck: `2026-10-25T02-22-14-246Z-console_typecheck-a6ba8a74.json`;
  smoke: `2026-10-25T02-22-14-385Z-console_smoke-b8d50935.json`.

## Graphify and safe integration proposal

PR #83's previous refresh finished: its `graphify-out/GRAPH_REPORT.md` and
`graph.json` exist, and its process is no longer running. The report contains
25,985 nodes / 68,776 edges / 1,266 communities. No process was terminated.
A separate required refresh was started for this new worktree.

Proposed sequence, subject to review and explicit merge/deployment authorization:
1. Review #83 and this PR together, rerun the combined local gates, then integrate
   #83 followed by this fixture PR so neither set of known baseline failures is
   mistaken for a new regression. Neither PR is merged by this task.
2. Rebase/reconcile #81 on that reviewed base. `git merge-tree` identifies one
   conflict in `tool/visible-browser-session-regression.mjs`; the quota fixture
   merges automatically. Retain this behavioral worker contract and #81's native
   identity/continuity scenarios; do not restore obsolete whole-file assertions.
3. Run the complete test/schema/typecheck/build/smoke/admission gates again.
   Perform native Windows verification of multiple windows/tabs, focus changes,
   stale targets and sequential operations. Linux fixture results do not establish
   native Windows behavior. GitHub Actions is blocked by its account billing lock.
4. Only after review and deployment authorization, use the normal deployment
   procedure and verify the actual Ubuntu live bind -> inspect -> capture -> click
   against one exact existing Edge target, including PID/health and genuine
   ambiguity rejection. Do not restart browsers, reset sessions or close tabs.

Original Ubuntu worktree: 227 dirty/untracked entries preserved. PR #81's two
pre-existing untracked entries and PR #83's clean state are preserved. No runtime
restart, deployment, browser interaction, PR merge, key or credential changes.
