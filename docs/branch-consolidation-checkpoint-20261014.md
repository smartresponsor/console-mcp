# Console MCP branch consolidation checkpoint — 2026-10-14

Repo: `D:\PhpstormProjects\www\mcp\console-mcp`
Master at audit: `7e3f0874920684f14ddf419881e259c899d1cb89`

## Integrated into master

- PR #25 — Windows database isolation, Engine dedupe and management safeguards, runtime helpers, signed commits (`fix/database-admission-recovery-20261013`).
- PR #27 — Ubuntu workspace writes and runtime recovery, conflict resolved on `review/ubuntu-workspace-writes-20261014`.
- PR #30 — Ubuntu staging ingress and canonical Web/browser safety, seven conflicts reviewed on `review/ubuntu-staging-ingress-20261014`; isolated full `npm test` succeeded. External Browsing worker source was unavailable, so its cross-repo assertion was explicitly not checked.
- PR #31 — legacy admission restart-plan alias integrated by preserving the current canonical `read_.system.console.restart.plan` definition.

GitHub CI checks on several merged PRs failed or were unknown. Local isolated tests are not a substitute for the missing CI signal. No stopped Engine/watchdog workloads were resumed.

## References with commits not ancestral to master

Counts come from `git rev-list --count master..ref`, and **do not prove the changes are still valuable or missing**. Duplicate SHAs represent aliases, not independent content. Do not delete or force-merge them until semantic comparison is complete.

| Ref | SHA | Unique commits |
|---|---|---:|
| `checkpoint/local-master-before-final-realign-20260927` | `8da238b80f2b` | 3 |
| `checkpoint/local-master-before-pr20-20260927` | `8da238b80f2b` | 3 |
| `checkpoint/master-pre-housekeeping-20260718` | `ed0d6eb40f51` | 10 |
| `checkpoint/pre-rebase-20260718-4420bf8` | `4420bf8ba7e4` | 9 |
| `chore/google-mcp-cleanup` | `a2a67961bf67` | 1 |
| `fix/chatgpt-deleted-tab-housekeeping` | `b72082c55c4a` | 3 |
| `fix/runtime-stabilization-cold-validation` | `6ef56e9ff5c6` | 4 |
| `fix/solid-chatgpt-read-rename-wave4` | `9bc2939cadfd` | 1 |
| `fix/solid-consumer-adapter-tree-wave2` | `7161b8312c55` | 1 |
| `pr-security-hardening-rebased` | `fb2687d7fcd7` | 19 |
| `pr-write-tools` | `06b39594e1c3` | 5 |
| `pr-write-tools-publish` | `fb2687d7fcd7` | 19 |
| `security-fleet-publisher` | `4304ce42c8c5` | 2 |
| `security-fleet-rollout` | `4304ce42c8c5` | 2 |
| `security-fleet-scan-hardening` | `76b38a26cc2e` | 1 |
| `security-fleet-scan-hardening-v2` | `76b38a26cc2e` | 1 |
| `security-gitleaks-ci-baseline` | `788e2cf6e6c1` | 1 |
| `security-gitleaks-ci-baseline-v2` | `788e2cf6e6c1` | 1 |
| `security-semgrep-fleet-triage` | `3ff3550d84b6` | 2 |
| `security-semgrep-fleet-triage-v2` | `3ff3550d84b6` | 2 |
| `security-semgrep-targeted-triage` | `560ab46eb811` | 1 |
| `security-semgrep-targeted-triage-v2` | `4dd6d9816d00` | 2 |
| `security-surface-hardening` | `e659769ee5f9` | 4 |
| `origin/feat/npm-ci-local-build` | `4f271d240565` | 10 |
| `origin/fix/runtime-stabilization-cold-validation` | `6ef56e9ff5c6` | 4 |
| `origin/pr-security-hardening-rebased` | `fb2687d7fcd7` | 19 |
| `origin/pr-write-tools-publish` | `f8f4a1292b81` | 22 |
| `origin/security-surface-hardening` | `e659769ee5f9` | 4 |

## Next integration order

1. Review `pr-security-hardening-rebased` / `pr-write-tools-publish` (same local SHA), `origin/pr-write-tools-publish` (different remote SHA) and `pr-write-tools` without resurrecting obsolete security/auth contracts.
2. Review current-vs-legacy security branches as one semantic family: `security-surface-hardening`, fleet scans, Semgrep and Gitleaks; integrate only nonduplicated, safe corrections.
3. Review `fix/runtime-stabilization-cold-validation`, `fix/chatgpt-deleted-tab-housekeeping`, SOLID branch deltas and `origin/feat/npm-ci-local-build`.
4. Last, reconcile historical checkpoint-only refs; retain checkpoints as recovery anchors unless their unique content is demonstrably needed.
5. Rerun isolated full tests and verify CI/Ubuntu parity; only declare Canonical GREEN after checking all local and remote unmerged commits and a clean worktree.

## Additional reviewed integrations (same day)

- PR #38 MERGED — `origin/feat/npm-ci-local-build` ancestry integrated via `review/npm-ci-local-build-20261014`; canonical npm tool names retained; isolated full npm test GREEN.
- PR #39 MERGED — security fleet rollout/publisher (duplicate SHA) and Gitleaks baseline/v2 (duplicate SHA) integrated via `review/merge-feasibility-20261014`; isolated full npm test GREEN. The branch inventory helper now accepts `-Mergeability` using read-only `git merge-tree --write-tree` checks, and reports full SHA.
- As of master `59c8d7b6de48c2b942fa1a5d781687175840dab0`, the repeat mergeability sweep found **zero** additional conflict-free unique refs. Remaining refs need semantic conflict review.
- Draft PRs #33–37 represent conflicting legacy branches: npm (ancestry now integrated via PR #38), runtime cold validation, security surface hardening, security PR rebase, and historical write tools. Do not merge them unreviewed.
- Attempted `chore/google-mcp-cleanup` in disposable `review/google-mcp-cleanup-20261014`; merge was ABORTED because it deletes current `src/tool/google-ads-editor.ts` and conflicts in admission/catalog files. Do not resurrect the obsolete deletion.
- CI remains non-GREEN / failing for some merged PRs. Do not claim repository Canonical GREEN merely from local isolated tests. No paused Engine tasks were resumed.

## Current isolated security ancestry review

- At origin/master `53a26f03665d34b2238103c9b366ffd1867a8360`, reviewed `origin/pr-security-hardening-rebased` (`fb2687d7fcd7`): 26 conflicting files; 19 unique historical commits. No merge applied.
- Reviewed `origin/pr-write-tools-publish` (`f8f4a1292b81`): 34 conflicting files; 22 unique historical commits. No merge applied. Most conflicts overlap the security rebase, with additional runtime diagnostics, connector refresh, and Web/Composer catalogs.
- Both reviews used disposable Git worktrees. The live MCP checkout stayed on `runtime/naming-restored-20261014`; do not switch it to older commits.
- Next: compare the *unique delta* of the remote published write-tools branch to `pr-security-hardening-rebased`, prioritizing the small independent changes, then review canonical admission before any cherry-pick or merge. Preserve protected modern tool names and security defaults.

## Write Tools Publish — targeted file reconciliation

- Compared `origin/pr-write-tools-publish` with `origin/master` on 2026-10-14, using exact Git file contents, without switching the live MCP checkout.
- `tool/engine-task-json-diagnostics.ps1` and `tool/dev-console.d/57-aws-secrets-diagnostics.ps1` are identical; no transfer required.
- `src/tool/local-php-server.ts` and `src/tool/doctrine-migrations.ts` become *byte-identical* after removing the obsolete `console.` tool-name prefixes (two and three legacy names respectively). Do **not** restore those prefixes; this would recreate the connector-name failure.
- `src/tool/github-pull-request.ts`, `src/tool/mobile-edge-server.ts`, `src/tool/dev-console-command.ts`, and `src/service/chatgpt-entrypoint-preset.ts` have differences beyond tool-name prefixes; these remain subject to semantic review.
- `tool/console-mcp-correlation-tail.ps1` and `src/Infrastructure/Diagnostics/RuntimeDiagnostics.ts` are materially expanded on master. Do not overwrite with historical versions.
- No historical code was merged on this pass. Preserve `origin/pr-write-tools-publish` as source evidence and compare non-prefix functional differences before selective transfer.

## Additional Write Tools Publish semantic comparison

Compared `origin/pr-write-tools-publish` with `origin/master` after PR #44 (read-only Git show, no live checkout switch):

- Exactly identical: `tool/engine-task-json-diagnostics.ps1`, `tool/dev-console.d/57-aws-secrets-diagnostics.ps1`. Already integrated; do not cherry-pick.
- `src/tool/local-php-server.ts` differs only in prefixed vs canonical tool names; **preserve master**.
- `src/tool/dev-console-command.ts` has obsolete prefixed command in legacy and a newer runtime environment status command on master; **preserve master**.
- `src/tool/mobile-edge-server.ts`: legacy uses prefixed tool names plus PowerShell-wrapped npm invocation, while master uses canonical names and direct npm spawn; **preserve master**.
- `tool/console-mcp-correlation-tail.ps1`, `src/Infrastructure/Diagnostics/RuntimeDiagnostics.ts` and `tool/dev-console.d/60-connector-refresh.ps1`: master has additional code; no broad replacement warranted.
- `src/Infrastructure/Process/ProcessRuntime.ts`, `src/Infrastructure/Process/SupervisedCommand.ts`, `src/Security/Auth/ConsoleAuth.ts`, and runtime PowerShell modules differ; review only specific absent security invariants before any cherry-pick.
- Full historical branch merge still conflicts widely. No changes from legacy branch applied in this review. Engine state unchanged.

## Security invariant comparison — ProcessRuntime / SupervisedCommand / ConsoleAuth

- Compared full file content of `origin/pr-write-tools-publish` against `origin/master` (2026-10-14).
- `ProcessRuntime.ts`: historical branch reintroduces shell-backed Windows command scripts and unsanitized check-name transcript paths. Current master explicitly refuses shell-backed scripts, safely handles Composer via PHP, sanitizes transcript filenames, and records execution telemetry. **Retain master.**
- `SupervisedCommand.ts`: historical lines only differ in return-object syntax and exit-code variable; master adds validated Gradle wrapper confinement/argument checks and execution telemetry. **Retain master.**
- `ConsoleAuth.ts`: no historical-only substantive lines; master additionally requires HTTPS except loopback hostnames. **Retain master.**
- No beneficial security invariant is missing from current master in these three files. Do not cherry-pick historical versions. Review remaining unrelated features separately.

## Browser Session Executor verification

- Rechecked all seven initially suspected missing functions using exact source-text search in the live clean checkout: `enableTemporaryChat`, `classifyComposerReadiness`, `waitForComposerReady`, `dismissChatGptStorageQuotaDialog`, `inspectAuthStatus`, `inspectSessionWarmth`, and `pruneRootTargets`.
- All seven exist in `src/service/browser-session-executor.ts` at lines 432, 456, 482, 519, 533, 556, and 581 respectively. Previous `git file show` response had been truncated at 30,000 characters, causing a false absence inference.
- Do not transplant old browser executor implementations. Continue review of feature deltas using nontruncated source inspections.

## Tool catalog semantic delta (Write Tools Publish)

- Compared complete `src/tool/catalog.ts` from `origin/pr-write-tools-publish` and `origin/master` after canonical normalization of the historical `console.` prefix and underscore-to-dot token migrations.
- Of 176 historical catalog names, 168 have corresponding canonical names in master. Eight do not match by mechanical normalization: `read_.network.browser.status`, `read_.network.browser.inventory`, `read_.network.capability.contract`, `write.network.browser.open`, `write.browser.chatgpt.chat.adopt_into_task_bank`, `read_.browser.chatgpt.implementation.pre_ask.capture`, `write.engine.cycle.run_n`, `write.engine.answer.resubmit_orphaned`.
- These eight are **review candidates**, not established missing capabilities. Do not restore obsolete names or aliases without checking their replacements, admission rules and existing implementations.
- Master source of `src/tool/catalog.ts` is complete (not truncated); larger engine source reads can truncate at 30,000 characters. Compare those via bounded searches.

## Eight historical catalog names — verified successors

- `read_.network.browser.status` -> `read_.web.browser.status`; `read_.network.browser.inventory` -> `read_.web.browser.inventory`; `read_.network.capability.contract` -> `read_.web.capability.contract`; `write.network.browser.open` -> `write.web.browser.open` (Web domain canonicalization; catalog and bridge registration verified).
- `write.browser.chatgpt.chat.adopt_into_task_bank` -> `write.engine.chat.adopt` / `write.browser.chatgpt.chat.adopt_go` (separate adoption and optional execution authorization).
- `read_.browser.chatgpt.implementation.pre_ask.capture` -> `read_.browser.chatgpt.implementation.ask.preflight.capture` (current implementation-run capture).
- `write.engine.cycle.run_n` -> `write.engine.cycle.rounds.run` (bounded multiround driver).
- `write.engine.answer.resubmit_orphaned` -> `write.engine.prompt.orphan.resubmit` (revalidates orphan state before resubmit).
- All eight are replaced by explicitly documented current capabilities, not missing features. Keep modern canonical names; do not restore legacy aliases or merge historical catalog.

## Short-branch review against origin/master (2026-10-14)

- Disposable worktree merge checks: `fix/solid-chatgpt-read-rename-wave4` conflicts in 1 file; `fix/solid-consumer-adapter-tree-wave2` in 8; `security-fleet-scan-hardening` in 1; `security-semgrep-targeted-triage` in 1; `chore/google-mcp-cleanup` in 4.
- Fleet and Semgrep triage changes target `tool/security-scan-workspace.ps1`. Modern master is longer and already includes bounded process/rule timeouts, target/include filtering, and fleet guards. Historical scripts are not safe whole-file replacements.
- Google cleanup proposes removal of existing Google Ads code and conflicts in tool catalogs; prior reviewed merge was aborted. Do not restore obsolete deletions.
- No historical branch merged in this pass. Analyze any residual unique security semantics individually before integrating.

## Semgrep short-branch semantic closure

- Compared `security-fleet-scan-hardening` and `security-semgrep-targeted-triage` against current `origin/master` `tool/security-scan-workspace.ps1`.
- Modern master already implements Semgrep progress reporting, configurable bounded process and rule timeouts, target path confinement, include filtering, deterministic sequential scanning, and cleanup of temporary output files.
- Fleet branch uses parallel asynchronous process output collection with a hardcoded 50-second timeout; targeted triage uses `Start-Process` as master already does. These are historical execution variants, not security invariants missing from master. Do not restore them wholesale.
- No code merge necessary for these two historical Semgrep scan implementations. Other branch-specific changes require separate review.

## ChatGPT SOLID historical branches — focused review

- `fix/solid-chatgpt-read-rename-wave4`: isolated merge conflicts in `src/service/browser-session-executor.ts`; historical `src/Consumer/ChatGpt/Rename/ChatGptConversationRename.ts` and `src/Consumer/ChatGpt/Message/ChatGptMessageCapture.ts` exist on the old branch but not at those paths in current master. Functionality is not necessarily missing: current `src/tool/chatgpt-chat-open.ts` implements `renameChatGptConversationLifecycle`, while `src/tool/chatgpt-message-capture.ts` handles message capture. Do not copy old classes without comparing contracts and call sites.
- `fix/solid-consumer-adapter-tree-wave2`: isolated merge conflicts in 8 files. Historical `src/tool/chatgpt-prompt-draft.ts` is a large implementation, while the current master file explicitly marks it dead/unregistered and routes live CDP typing through `src/Consumer/ChatGpt/Draft/ChatGptPromptDraft.ts`, imported in `browser-session-executor.ts`. Retain current active path.
- Next: inspect remaining SOLID rename/adaptor changes on a per-behavior basis; do not wholesale merge old module trees or revive unused code. No Engine resume/restart.

## SOLID ChatGPT factory wiring follow-up

- Historical `fix/solid-chatgpt-read-rename-wave4` exports `createCaptureMessages` and `createChatGptConversationRename` in old `src/Consumer/ChatGpt/...` modules. Neither factory name is referenced by current tracked sources.
- Modern execution instead calls `runChatGptMessageCapture` from `src/tool/chatgpt-message-capture.ts`, and `renameChatGptConversationLifecycle` from `src/tool/chatgpt-chat-open.ts` via engine conversation lifecycle. These are confirmed *functional paths*, not proof that all historical edge-case semantics match.
- Do not transplant the historical factories without comparing rename/capture edge-case contracts and tests; no implementation merge in this review.

## Capture and runtime checkpoint

- The historical `createCaptureMessages` implementation includes fail-closed `NEED_CHAT_ID` and `NEED_DEVTOOLS_WEBSOCKET` statuses and visible-message filtering. Modern `captureChatGptMessages` includes the corresponding binding/websocket checks, plus deleted-conversation placeholder detection and session controls. Full edge-case equivalence beyond these checks is not proven.
- Re-ran isolated merge of `origin/fix/runtime-stabilization-cold-validation` (`6ef56e9`) against `origin/master` (`f73a8e3`): still nine conflicts (three catalog policy files, browser engine, catalog, chat-open, git-inspection, CMCP regression and dev-console). No historical code merged.
- Review old runtime delta by individual semantic changes and protect canonical tool naming. Do not checkout the July source in the live server workspace.

## Runtime Stabilization — safe semantic delta review

- Compared old `fix/runtime-stabilization-cold-validation` with current `origin/master` for `src/index.ts`, `src/engine/engine-cycle-browser.ts`, `src/tool/git-inspection.ts`, and `tool/dev-console.d/80-runtime.ps1`.
- Historical tool registrations in `git-inspection.ts` still use forbidden `console.` prefixes; do not transplant. Current browser engine additionally blocks `temporary-chat=true` URLs; old version does not.
- Historical `src/index.ts` uses `CONSOLE_MCP_RUNTIME_PROFILE` and two runtime profile candidates, whereas current master selects profile using the canonical explicit auth mode. Do not restore old profile selection without reviewing OAuth/session consequences.
- Historical `80-runtime.ps1` injects bearer token through a child-environment map. Modern runtime implementation differs; require a separate security review before considering these changes.
- No runtime implementation changes applied. This is targeted semantic triage, not complete equivalence proof.

## Runtime CMCP Go and catalog follow-up

- Historical runtime branch `src/tool/chatgpt-chat-open.ts` still uses `console.`-prefixed MCP tools and `maxAutoIterations` default 70. Do not restore old registration or default wholesale.
- Checked current tracked `src/tool/chatgpt-chat-open.ts` and `tool/chatgpt-cmcp-go-auto-dispatch-regression.mjs`: `resolveCmcpGoAutoDispatch` is implemented and tested; `classifyEngineDraftRetry`, `summarizeEngineCycleStageReceipt` and `classifyComposerOwnership` are likewise implemented and tested in current master.
- Historical `src/tool/catalog.ts` is substantially smaller and uses old names. Modern catalog is canonical; do not merge historical catalog without feature-by-feature evidence.
- This closes the listed runtime dispatch/test primitives as already present, not the entire runtime branch. Current browser and policy conflict review remains open. No runtime code copied.

## Runtime Stabilization catalog conflict closure

- Compared all three conflicting historical policy catalog JSON files with current `origin/master` at tool-entry level (not truncated).
- `policy/console-tool-catalog-write-repo.json`: all 9 historical entries already map to current canonical names after removing obsolete `console.` prefix. Master provides 30 entries; retain master.
- `policy/console-tool-catalog-chatgpt-browser.json`: 29 historical vs 38 current entries. Most differ only by deprecated `console.` prefixes. Remaining old session-open/draft/submit and adopt-into-task-bank names require semantic mapping to modern browser and engine tools; do not create aliases.
- `policy/console-tool-catalog.json`: 17 historical vs 23 current entries. Legacy commit/branch/push/patch entries are already present in modern write-repo catalog, rather than root catalog. Retain current fragmented catalog structure.
- No missing capability or policy safety improvement established from these catalogs. Preserve current canonical naming and tool registration.

## Runtime browser tool migration verified

- All four previously unresolved historical Browser tool names have live modern equivalents registered and admitted: `write.browser.session.open`, `write.browser.session.input.draft`, `write.browser.session.submit` (moved from the old Browser fragment into `policy/console-tool-catalog-chatgpt-draft.json`), and `write.engine.chat.adopt` / `write.browser.chatgpt.chat.adopt_go` for adoption.
- Verified against `src/tool/chatgpt-chat-open.ts`, `src/tool/catalog.ts`, `policy/console-tool-admission.json` and the corresponding catalog fragments. No old `console.` aliases or code restoration needed.
- This closes the three Runtime Stabilization policy catalog conflicts at the tool-registration equivalence level; other runtime implementation conflicts remain for separate review.

## Legacy dev-console conflict decision

- Historical Runtime Stabilization `tool/dev-console.ps1` is a monolithic command implementation; current `origin/master` uses a module loader for `tool/dev-console.d/*.ps1` and dispatches through `99-command-dispatch.ps1`.
- Current source documents intentional removal of direct OAuth/Bearer start-stop and stale-runtime replacement commands because they could relocate the live server into an SSH session. Modern start/stop uses Task Scheduler watchdog relay (`85-session-relay.ps1`).
- Do not replace or merge the historical monolithic dev-console script. Preserve module boundaries and session-safe lifecycle semantics. This closes the `tool/dev-console.ps1` conflict as an obsolete architecture rather than a missing functionality claim.

## Operating constraints

Use Windows Console MCP for local repository operations, guarded review branches and signed commits. Do not invoke bare Windows container paths or restart/dispatch manually paused Engine tasks. Review every conflict; avoid broad `ours` resolutions without evidence. Preserve unique commits and clean worktrees. This document is a checkpoint, not a statement that remaining branches are merged.

