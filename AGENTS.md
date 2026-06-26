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

## Windows execution checks

- This project runs primarily on Windows and PowerShell.
- Allowed command execution must go through `console.run_check` and `policy/allowed-check.json`; do not add unrestricted shell execution.
- When adding checks for npm scripts, remember that Windows resolves npm to `npm.cmd`; executor behavior must handle `.cmd` / `.bat` safely.
- After changing TypeScript runtime source, rebuild locally and restart the running connector before expecting the live MCP server to use the new code.

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
