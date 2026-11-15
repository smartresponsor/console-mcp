# Isolated repository acceptance runner (Draft)

The canonical Console MCP tool `write.repo.test.isolated` exposes **one fixed test profile** (`mcp-http-efficiency`) and accepts an exact 40-character lowercase commit SHA **only if it equals the reviewed immutable allowlisted SHA** (`2397dd4203b07d8cce770d87862bef037e762faa` for PR #210). Changing this authorization requires a reviewed source update and rebuild; being present on `origin/*` alone never authorizes running npm scripts. It is not a general-purpose shell or test-command executor.

## Invocation

1. Fetch `origin` via the existing approved `write.repo.git.fetch` action.
2. Call `write.repo.test.isolated` with `workspacePath`, `sha`, `profile=mcp-http-efficiency`, and explicit `confirmRun=true`.
3. Read the returned `run_id` with `read_.repo.command.status` and `read_.repo.command.output` using the same `workspacePath`. Terminal status must be `succeeded` and stdout must contain `ISOLATED_TEST_PASS` with `cleanup=complete`; otherwise reject.
4. Never treat GitHub Actions, a different SHA, or a previously successful worktree as equivalent to local acceptance.

The operation validates the commit object and checks it is contained by an existing `origin/*` remote-tracking branch (without fetching or trusting local-only unpushed commits). It uses the existing repository worker and heavy-work capacity gate, then a disposable OS-temp worktree at that exact SHA. It verifies the detached HEAD and initially clean checkout, and runs only:

```text
npm ci --ignore-scripts --no-audit --no-fund --cache .cmcp-test-npm-cache
npm run build
node tool/mcp-efficiency-baseline-regression.mjs
node tool/response-body-measurement-regression.mjs
node tool/mcp-http-response-trace-integration.mjs
```

Outputs are captured by the existing bounded async-command journal. The runner attempts worktree removal and temporary-directory cleanup on ordinary pass/fail; failures of cleanup are failures of acceptance. No production service, watchdog, OpenAI tunnel, Git branch, git index, or release activation is touched. The existing command-run journal inside `.console-mcp/command-run/` is the only ongoing workspace-local execution metadata (plus transient Git worktree bookkeeping); do not treat it as user project changes. Test execution can use CPU, disk, network for npm packages, and available process capacity.

## Acceptance and limitations

After build, run `node tool/isolated-repo-test-contract-regression.mjs` in a **clean detached worktree**: it tests bad SHA rejection, unapproved SHA rejection, rejection of non-remote SHA through a module-only test seam, and cleanup following deliberate `npm ci` failure. Run the fixed profile on Gold and Silver. Confirm tool admission and count/schema projections before declaring availability in ChatGPT.

Only **ordinary completion** has full cleanup confirmation: a forced kill or host power loss can interrupt cleanup. Recovery must inspect `git worktree list --porcelain`, confirm ownership of any stale `cmcp-isolated-test-*` temp worktree, and use an approved cleanup operation; never delete unknown worktrees or run bulk `git worktree prune` blindly. Subprocess trees may need explicit process inspection after an abnormal timeout. Future work: durable owned-worktree lease, auto-reconciliation and expanded fixed test profiles. No production deployment from this PR without separate release review.

**Security gate:** `npm run build` and repository tests execute code from the selected SHA. Therefore, remote-tracking provenance is insufficient; only the explicitly reviewed SHA may run. This first profile is intentionally single-target, not a general release-testing service. Subsequent release candidates require a policy/code review updating the allowlist, or a future signed approval receipt design. Never expose a caller-controlled allowlist override in the MCP tool schema or CLI.
