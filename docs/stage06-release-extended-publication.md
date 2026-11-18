# Stage 06 — staged Release Transaction Facade expansion

## Provenance and safety boundary
- Source: clean signed Stage 05 commit `ce467dae6f011865208682dd3a4eff822450b9d6`, rooted in upstream baseline `df90d4706bf3c476ddcf9ef6ba09f6be039d8fec`.
- Independent isolated worktree branch `feature/stage06-release-extended-20261118`.
- Dirty main checkout, master, tunnel, production processes, ACL and system/global Git configuration are not changed.
- Existing 323 canonical declarations, registered handlers and internal dispatcher remain authoritative in Console MCP.

## Audit
- Canonical admitted `release.*`: 20 tools.
- Existing visible Transaction Facade: exactly five `release.transaction.*` names.
- Stage 06 candidate extension: `read_.release.runtime.status`, `write.release.artifact.prepare`, `write.release.artifact.validate`, `write.release.runtime.activate`, `write.release.runtime.rollback`.
- Do not conflate an in-process `/release/mcp` fixture with a freshly published dedicated ChatGPT Transaction app: current app shows only five.

## Two explicit gates
- `CONSOLE_MCP_RELEASE_FACADE_EXTENDED=1`: in-process `/release/mcp` now lists ten tools, while main `/mcp` still lists the new five. Safe publication-preview phase.
- `CONSOLE_MCP_RELEASE_EXTENDED_MAIN_CUTOVER=1`: only allowed if the facade itself is enabled and extension flag set. Main `/mcp` hides the five newly delegated tools. Intended only AFTER fresh-ChatGPT-session confirmation of ten live commands and matching schemas.
- Default flags disabled: original five-command facade, main count 259 (Stage 05), no accidental new hiding.
- Future cutover: main count 254, below the 256 display cap. No production change performed by this worktree.
- No code movement, no changes to canonical admission of ChatGPT/Codex/Runner; exclusion is only a primary endpoint projection.

## Validation
- Isolated OAuth `tools/list` and `tools/call` E2E covers three modes: 5/259, 10/259, 10/254.
- Rejected main `tools/call` for all five when cutover enabled; facade read-only status invocation exercised.
- Existing Repo/Looping/Network E2E and full npm test included in isolated runner.
- E2E is a local release probe, not evidence that ChatGPT sees the extended public app.

## Release gates (not authorized here)
1. Independent code security review and source/compiled registry schema parity.
2. Create deployment candidate WITHOUT enabling main cutover; review gate and rollback checkpoint.
3. In a NEW ChatGPT session, confirm Transaction Facade actually exposes ten exact names and matches expected schemas.
4. Only then separately authorize main cutover and verify Console `tools/list` count 254 and negative direct calls.
5. No merge, deploy, restart, tunnel mutation or master changes in Stage 06.
