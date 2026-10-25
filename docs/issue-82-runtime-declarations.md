# Issue #82: runtime declaration validation

## Confirmed cause

Reproduced on master `04ec98aab13a9ce967a09930dec8d744a7e7039e` before edits:
`npm run schema:validate` reported 20 registered tools absent from policy.
They are deliberately staged infrastructure diagnostics, not missing sibling tools.
`src/tool/infrastructure-diagnostics-registration-draft.ts` explicitly forbids
activation before admission; `policy/infrastructure-diagnostics-integration-draft.json`
has `runtimeRegistration: false`. No runtime module imports that registration.

The AST catalog scanner examined every `src/tool/*.ts` file. Capability admission
also counted arbitrary tool-looking string literals across those files. Both
mistook source presence for runtime registration. Catalog generation was current.

## Inventory

Every entry below is in `src/tool/infrastructure-diagnostics-registration-draft.ts`.

| Source line | Tool |
| --- | --- |
| 32 | `read_.network.ipv4.route.list` |
| 35 | `read_.network.tcp.listener.list` |
| 38 | `read_.system.process.list` |
| 41 | `read_.system.memory.status` |
| 44 | `read_.system.process.detail` |
| 47 | `read_.system.service.status` |
| 50 | `read_.system.journal.record.list` |
| 53 | `read_.network.ipv4.interface.list` |
| 56 | `read_.network.ipv4.neighbor.list` |
| 59 | `read_.network.udp.socket.list` |
| 62 | `read_.network.dns.resolver.inspect` |
| 65 | `read_.network.tcp.connection.list` |
| 68 | `read_.system.cpu.load.inspect` |
| 71 | `read_.system.storage.io.status` |
| 74 | `read_.system.service.list` |
| 77 | `read_.network.firewall.chain.list` |
| 80 | `read_.network.firewall.policy.inspect` |
| 83 | `read_.system.process.fd.list` |
| 86 | `read_.system.kernel.oom.record.list` |
| 89 | `read_.system.journal.record.detail` |

## Architecture and safety

A shared TypeScript module resolver follows the conservative runtime import closure
from `src/index.ts`: static imports, re-exports, side effects, and literal dynamic
imports/requires. Explicit type-only imports are excluded. Missing local runtime
imports and parse errors fail closed. Imported registrations remain checked even
if conditionally called; there are no filename or tool-name exemptions.

Both validators use the same registration AST result. Existing declaration,
consumer, lifecycle, annotation, legacy, and projection checks remain enabled.
No tools are admitted or activated, and no generated catalogs change.
Nonliteral dynamic imports are not statically resolved; runtime registry admission
and the exact consumer tools/list smoke assertion provide the complementary check.

Regression fixtures cover unwired/type-only drafts, activating a draft through
four import forms, missing runtime imports, literal/parameterized/loop names,
decoy strings, and unresolved registration names. Existing staged infrastructure
contracts must continue to pass. Smoke now checks exact admission equality and
absence of duplicate tools against an isolated ephemeral MCP test server.

## Local validation (Ubuntu, Node 22.23.3, PowerShell 7.6.4)

- `npm run typecheck`, `npm run build`, `npm run smoke`: PASS.
- `tool/catalog-validation-regression.ps1`: PASS (AST, staged source/manifest,
  admission projection check, admission smoke).
- Catalog: 287 runtime canonical names = 287 policy names = 287 catalog entries.
- Capability admission: PASS, 287 declarations; projection check: PASS.
- Admission diff from origin/master: PASS, no capabilities added or removed.
- `npm run schema:validate`: catalog/admission/schema stages pass, then existing
  `web-domain-bridge-regression.mjs:129` fails: expected
  `WEB_SESSION_ROTATED_REINSPECT_REQUIRED`, actual
  `WEB_BROWSER_WORKER_CONFIGURATION_INVALID`. Fixture and runtime are unchanged
  from master. Transcript: `2026-10-25T02-01-55-100Z-console_schema_validate-aa1ddece.json`.
- `npm test`: documentating, repository isolation, worker isolation, async commands,
  RC async, resilience pass; existing `visible-browser-session-regression.mjs:83`
  fails with “Restoration cannot launch or create a competing profile”. It scans
  the sibling browser worker including its separate managed mode. Unchanged here.
- Remaining npm test suites run separately: PASS (Pester 14/14, console regression,
  cmcp CLI, restart failsafe, browser housekeeping, deployment preflight).
- Do not interpret these unrelated baseline failures as a green full release gate.

Checks use named Console gates or the guarded repository PowerShell runner.
`tool/catalog-validation-regression.ps1 -Full` reproduces the npm test chain;
`-TrustWorktree` explicitly invokes the existing confined safe.directory handler
when a service account runs checks in a user-owned clean worktree. It trusts only
that worktree, never disables ownership verification globally.

## Separate PR #81 release diagnosis

Read-only diagnosis on 2026-10-25 UTC:
- Ubuntu live process remains PID 906020, cwd the original dirty worktree,
  build fingerprint `d8e6fc51b4850443`, healthy. This does not verify deployment of
  PR #81 head `f5d4ea4cfc34bc6bab6bcc6b0d17e12b243ae806`; its live bind/inspect/
  capture/click release verification remains outstanding. No deployment performed.
- GitHub Ubuntu and Windows jobs did not start: job annotations say account locked
  due to billing; Windows runner name is empty and steps are empty. Native Windows
  verification remains outstanding; Ubuntu fixture checks do not substitute for it.
- `gh api repos/smartresponsor/console-mcp/rules/branches/master` returns `[]`;
  legacy branch protection returns 404 “Branch not protected”. No currently active
  signed-commit branch rule is evidenced. PR #81 head verification is `no_user`,
  `verified: false`; local signing and GitHub identity verification are distinct.
  No keys or account settings changed.

The separate original dirty worktree is preserved. No production restarts,
browser/tab closures, session resets, credential changes, or PR merges performed.
