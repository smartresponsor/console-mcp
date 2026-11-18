# Stage 05 — Exclusive Transaction and Transport facade publication

## Source and isolation
- Source commit `9050b66cd41004ed806d44cf961fe8e297286d5e` (reviewed Stage 04), rooted on master `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec`.
- Isolated worktree `stage05-transaction-transport-20261118`; no dirty checkout edits, production mutations, deployment, restart or merge.

## Ownership
- Five `RELEASE_TRANSACTION_FACADE_TOOL_NAMES` are already available through the connected `Ubuntu_Transaction_MCP` facade.
- One `TRANSPORT_FACADE_TOOL_NAMES` is already available through the connected `Ubuntu_Transport_MCP` facade.
- The primary ChatGPT Console `/mcp` excludes these six names after the existing exclusions: 7 Network + 26 Looping + 8 NET282 Repo.
- All canonical declarations, handlers, Codex/runner admissions, existing release and transport facade routes remain unchanged.
- The existing facade projections are constructed before this new primary-only exclusion, preventing accidental removal from their own endpoints.
- Exclusion applies unconditionally even if optional in-process facade transport flags are disabled; no fallback publication to main.

## Counts
- 323 canonical declared; 306 ChatGPT admitted; 47 exclusively owned by five connected facades: Network 7, Looping 26, Repo 8, Transaction 5, Transport 1.
- Expected primary ChatGPT Console tools/list: 306 - 47 = **259**.
- At least four more capabilities must move to verified public facade ownership to reach **below 256**; do not silently suppress unowned tools.

## Acceptance
- TypeScript build PASS.
- Authenticated HTTP E2E Repo, Looping, Network PASS. Additional assertions reject all 6 Transaction/Transport tools via main tools/list/tools/call and verify positive lists on dedicated in-process endpoints.
- Full npm test PASS exit 0; run ID `2a3ae5be-4d69-4374-9667-a5fcddd73e00`.
- Deployment-preflight and release-v3 regression PASS; `productionChanged: false` in fixture regressions.
- No real production rollout or fresh-session ChatGPT proof performed.

## Next safe gate
- Independent review final diff and signed commit.
- Identify at least four additional exact commands with confirmed live facade ownership before excluding them. Existing Browser facade endpoint in source alone is insufficient evidence of a connected separate ChatGPT app.
- Optionally introduce a sixth independent facade for an unowned family with at least four commands, prove tool list via fresh ChatGPT session first, then exclude from Console.
- Keep executable code in Console MCP and only move public exposure/proxy routing.
