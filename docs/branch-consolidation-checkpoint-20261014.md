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

## Operating constraints

Use Windows Console MCP for local repository operations, guarded review branches and signed commits. Do not invoke bare Windows container paths or restart/dispatch manually paused Engine tasks. Review every conflict; avoid broad `ours` resolutions without evidence. Preserve unique commits and clean worktrees. This document is a checkpoint, not a statement that remaining branches are merged.

