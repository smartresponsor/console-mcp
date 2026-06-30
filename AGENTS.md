# console-mcp Agent Rules

This repository is the implementation of the local `console-mcp` connector. Treat it as infrastructure code: keep changes small, reviewable, and policy-driven.

## Patch discipline

- Use `console.apply_patch` only after explicit user approval such as `go`, `apply`, `do it`, or an equivalent direct instruction.
- Always send a real unified diff with `diff --git` headers.
- Do not send `*** Begin Patch` / `*** End Patch` format to `console.apply_patch`; this connector rejects that format.
- Prefer `dryRun=true` first for non-trivial patches. Apply with `dryRun=false` only after the dry run reports `ok=true` and `applicable=true`.
- Every hunk must have a valid header and correct line counts, for example `@@ -12,7 +12,9 @@`.
- Do not guess hunk ranges. Read the target file first when possible, then build the diff from the current content.
- Keep each patch focused. Use `expectedChangedFiles` and list only the files that must change.
- Do not patch generated or policy-forbidden output such as `dist/` unless the repository policy explicitly allows it.
- Avoid thick diffs. A normal patch should touch one conceptual change, at most 1-2 files, and stay under roughly 120 changed lines.
- Split larger work into separate dry-run/apply cycles by concern: documentation, policy, runtime source, tests, and fixtures.
- If a patch corrupts or fails because of hunk size/context drift, stop retrying the same large diff. Re-read the target file and send a smaller patch.
- Do not combine unrelated repo cleanup, runtime source changes, and evidence/test fixture changes in one diff.

## Branch and runtime stability

- Port authority is fixed: `3333` is ChatGPT OAuth/public tunnel, `3334` is localhost-only Codex bearer.
- Do not use `3334` for ChatGPT connector diagnostics, public tunnel checks, public smoke, or OAuth debugging.
- Do not treat a running `3334` process as drift; treat public exposure or ChatGPT use of `3334` as drift.
- Do not develop directly on `master`; use a scoped branch such as `dev/<topic>`, `feature/<topic>`, or `fix/<topic>`.
- Do not restart the live ChatGPT-facing connector after every diff or commit. This repository is developed through the same runtime it hosts.
- For TypeScript source changes, batch the scope first, then run `typecheck`, `build`, and tests. Restart the connector only once when live MCP behavior must use the rebuilt `dist/`.
- Documentation, tests, fixtures, and policy-only changes must not trigger a connector restart unless the user explicitly asks for a live reload.
- Treat `dev:restart-all` as an integration boundary, not as a default post-patch validation step.
- Merge back to `master` only after the scoped branch is green and the user explicitly approves the merge/commit flow.

## Windows execution checks

- This project runs primarily on Windows and PowerShell.
- Allowed command execution must go through `console.run_check` and `policy/allowed-check.json`; do not add unrestricted shell execution.
- When adding checks for npm scripts, remember that Windows resolves npm to `npm.cmd`; executor behavior must handle `.cmd` / `.bat` safely.
- After changing TypeScript runtime source, rebuild locally and restart the running connector before expecting the live MCP server to use the new code.
- Interpret the previous line as a live-behavior boundary only, not as a default post-patch restart rule.

## Validation loop

- After a patch, check `git_diff_stat` or `console_git_diff_stat` when available.
- For this project, prefer these checks when policy exposes them:
  - `console_typecheck`
  - `console_build`
  - `console_smoke`
  - `console_doctor_json`
  - `console_status`
- If a new allowed check returns `Unknown check name`, restart the connector so it reloads `policy/allowed-check.json`.
- If a check fails, report the exact `stdout`, `stderr`, `exit_code`, and `transcript_path` before proposing the next patch.
