# Stage 04 — Exclusive Repo Facade publication

## Provenance
- Source repository: `smartresponsor/console-mcp`.
- Pinned GitHub master merge: `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec` (PR #298).
- Isolated feature branch: `feature/stage04-main-projection-df90-20261118`.
- Never apply patches to the 416-file dirty checkout; no production deployment, merge, restart, or tunnel change performed.

## Canonical ownership
- This baseline already excludes seven `read_.network.*` names from the primary ChatGPT `/mcp` endpoint using `buildExclusiveNetworkProjections`.
- This baseline already excludes 26 Looping engine names from main `/mcp` using `excludeLoopingFromMainChatGpt`.
- Stage 04 adds eight names from `REPO_FACADE_TOOL_NAMES` after Network and Looping exclusions, regardless of `CONSOLE_MCP_REPO_FACADE_ENABLED`.
- The canonical registry, admission manifest, handlers, Codex and runner consumers, and dedicated `/repo/mcp` endpoint remain unchanged.
- A main ChatGPT `tools/call` to any excluded Repo name fails because the tool is not registered on the main consumer-filtered MCP server.
- Do not infer this code change affected production: it exists only in the isolated worktree.

## Expected count
- Canonical admission declarations: 323.
- ChatGPT-admitted canonical tools: 306.
- Main ChatGPT projection: 306 - 7 Network - 26 Looping - 8 Repo = 265.
- 265 still exceeds the desired 256 cap by nine; future facade ownership work is required.

## Acceptance (isolated worktree)
- Node 22.23.3; npm 10.9.9; `npm ci --prefer-offline --ignore-scripts --no-audit --no-fund` succeeded.
- `npm run build`: PASS.
- `node tool/mcp-facade-http-regression.mjs repo`: PASS; validates all eight absent on main `/mcp`, direct `tools/call` denied, and eight present on enabled `/repo/mcp`.
- `node tool/mcp-facade-http-regression.mjs looping`: PASS; Looping 26 preserved.
- `node tool/mcp-facade-http-regression.mjs network`: PASS; Network seven preserved and exclusive.
- Full `npm test`: PASS, exit 0, run `5cac85d3-680d-4e1b-80a2-7f76773dda3f`.
- First full test run failed on Git ownership validation in a nested fixture. Fixed only the test runner process environment with `GIT_CONFIG_COUNT/KEY_0/VALUE_0=safe.directory` set to this exact worktree; no persistent global Git configuration changed.
- Process-local `git diff --check`: PASS (prior to full test).
- The release regression reports `productionChanged: false`; no live cutover was attempted.

## Remaining release gates
- Independent review of final diff and exact commit SHA.
- Stage 05 facade split to reduce primary ChatGPT catalog from 265 to at most 256 with headroom.
- CI and fresh-ChatGPT-session verification after a separately approved deployment.
