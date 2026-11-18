# Stage 07 — release publication readiness (2026-11-18)

## Exact provenance
- Remote `smartresponsor/console-mcp` master at inspection: `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec` (PR #298).
- Stage 04 local signed commit: `9050b66cd41004ed806d44cf961fe8e297286d5e`.
- Stage 05 local signed commit: `ce467dae6f011865208682dd3a4eff822450b9d6`.
- Stage 06 local signed commit: `28b527e47f0a3dbe939c480738e03aca75bf8c46`.
- Stage 06 Git tree: `2feda4f8d0cf0a5be5fc7df8202dd9f5fc9efbdd`.
- Git signature check returned `U` (signature valid but trust not established by local Git); this is not an attestation of trusted signer.
- Main checkout `/home/alex/smartresponse/mcp/console-mcp` remains on `abe0c699063b444b6cdf7830e15c95cfb413baac`, dirty count 418. No checkout reset or editing was performed.

## Production evidence (read-only)
- Actual `read_.system.console.health`: PID 715459, build fingerprint `b85002587421379f`, canonical registry fingerprint `ae1c71fbc164d650`.
- Actual production consumers: ChatGPT projection 273, Codex 306, runner 319.
- `console-mcp.service` active/enabled, `Restart=on-failure`, `RestartUSec=5s`, NRestarts=0.
- `repo-mcp.service` active/enabled, `Restart=always`, `RestartUSec=5s`, NRestarts=0.
- `openai-repo-tunnel.service` active/enabled, `Restart=always`, `RestartUSec=5s`, NRestarts=0.
- Current ChatGPT connector observation has 256 Console commands, a client-side visibility cap; do not conflate it with the server-side production 273.

## Candidate behavior already accepted in isolated tests
- Canonical 323 registry unchanged; core executable handlers remain under Console MCP.
- Stage 04: Repo NET282 eight command exclusivity; Stage 05: Transaction five + Transport one exclusivity (Network seven and Looping 26 already on master).
- Stage 05 candidate main projection: 259 tools.
- Stage 06 publication preview `CONSOLE_MCP_RELEASE_FACADE_EXTENDED=1`: Release facade lists ten commands while main stays at 259.
- Stage 06 main cutover `CONSOLE_MCP_RELEASE_EXTENDED_MAIN_CUTOVER=1`: Release facade ten, primary Console 254; both flags and `CONSOLE_MCP_RELEASE_TRANSACTION_FACADE_ENABLED=1` required.
- Stage 06 three-mode authenticated HTTP `tools/list`/`tools/call`, TypeScript build, Repo/Network/Looping E2E and full npm test: PASS exit 0.
- Do not enable cutover based on local smoke tests; independent new-session ChatGPT app listing and schema parity are mandatory.

## Verified hard blocker (cannot be bypassed)
- The protected release preparation script `ops/ubuntu/script/prepare-console-release.py` checks source exact clean SHA and requires SHA to be an ancestor of `origin/master`.
- Stage 06 candidate includes master, but is **not reachable from master**.
- Invoked Python 3 isolated mode with exact Stage 06 SHA and no `--seal`: it exited 1 at `git merge-base --is-ancestor 28b527e... origin/master`, as intended.
- No release seal, broker transaction, root action, deployment registry write or process restart occurred.
- Preparing a protected release from this SHA before approved PR/merge would violate the existing immutable provenance gate.

## Ordered release procedure requiring separate authorization
1. Independent review and GitHub PR for the exact Stage 04→05→06 chain; verify commit signatures, CI and current master mergeability. Do not alter local dirty checkout.
2. After separately approved merge, resolve the canonical new master SHA; rerun all acceptance on that exact SHA in clean isolated worktree.
3. Invoke protected release preparation only through existing authorized broker/admin flow; capture trusted rollback release and process/binding checkpoints.
4. Publish Release facade expansion first, with `CONSOLE_MCP_RELEASE_FACADE_EXTENDED=1` and main cutover flag **OFF**. Verify current Console capabilities are not lost.
5. Start a NEW ChatGPT session, verify all ten exact Transaction/Release facade commands, matching JSON input/output schemas and authorized read-only status call.
6. Only after that proof and separate permission, activate main cutover. Verify 254 actual Console `tools/list`, rejected direct `tools/call` for delegated names, and unchanged Codex/Runner.
7. Verify systemd recovery, tunnel routing, rollback validity, and final audit receipt.

## Scope boundaries
- No master/production/tunnel/UID/GID/global Git config/dirty checkout mutations, no push/merge/deploy/restart.
- The release-preview phase is NOT equivalent to publication verified by ChatGPT.
