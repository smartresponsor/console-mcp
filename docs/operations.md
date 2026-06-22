# Operations

This is the working runbook for the local Windows toolkit.

## Bootstrap and doctor

Run these after cloning or restoring the repo:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor-json
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-prereq
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-config
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-cloudflared
```

These commands only inspect local state. They do not add tools, do not deploy anything, and do not print secrets.

## Start order

1. `start-chatgpt-oauth`
2. `start-codex-bearer`
3. `start-tunnel`

For tunnel startup, the supervisor resolves `cloudflared.exe` in this order:

1. `CONSOLE_MCP_CLOUDFLARED_BIN`
2. `C:\Tools\cloudflared\cloudflared.exe`
3. `cloudflared.exe` from `PATH`
4. fail closed

`%TEMP%\cloudflared.exe` is not a supported runtime location.

## Restart all

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 restart-all
```

## Startup task

Install the per-user Windows Task Scheduler entry that starts the local stack at logon:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 install-startup-task
```

Inspect it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 show-startup-task
```

Remove it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 uninstall-startup-task
```

The task runs without admin by default, triggers at user logon, and executes `restart-all` from the repo root.

## Shortcuts

Create per-user Start Menu shortcuts:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 create-shortcuts
```

Remove them:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 remove-shortcuts
```

The shortcuts are created under `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Console MCP`.

## Status

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 status
```

Status reports:

- process IDs
- port checks
- tunnel check
- public smoke summary

## Smoke checks

Local ChatGPT OAuth:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-chatgpt
```

Local Codex bearer:

```powershell
$env:CONSOLE_MCP_BEARER_TOKEN = "replace-with-a-long-random-token"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-codex
```

Public origin:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

## Controlled write workflow

Use `console.apply_patch` only after the fix is agreed in chat.

Recommended flow:

1. Inspect the workspace with `console.describe`, `console.health`, `console.workspace_status`, `console.capture_context`, `console.read_file`, and `console.search_text`.
2. Draft the exact unified diff in chat.
3. Ask the user for explicit approval.
4. Call `console.apply_patch` with `dryRun=true` first.
5. If the dry run reports `ok=true` and `applicable=true`, call `console.apply_patch` again with `dryRun=false`.
6. Run safe checks through `console.run_check`, for example `app_cache_clear_dev`, `app_cache_clear_prod`, `app_composer_validate`, `app_phpunit`, `app_git_status`, `app_git_diff_stat`, or `app_git_diff`.

Safety notes:

- `console.apply_patch` only accepts unified diff input.
- It refuses arbitrary shell execution.
- It refuses absolute paths, traversal, binary patches, rename/copy patches, and forbidden directories.
- It writes an audit record to `var/transcript/<timestamp>-apply-patch-<random>.json`.

## ChatGPT session availability check

A working public MCP endpoint does not guarantee that every ChatGPT conversation has the connector injected. Each conversation must be checked separately.

The public endpoint can be healthy while a specific ChatGPT session still cannot call `console-mcp` because the connector namespace is not available in that session.

Expected first probe in a new ChatGPT conversation:

- `console.describe`
- `console.health`

If the namespace is not available, reconnect or select the custom ChatGPT app/connector in that conversation.

Interpretation:

- Public smoke `ok=true` means the tunnel, OAuth metadata, and protected MCP endpoint are reachable.
- `console.describe` / `console.health` success means the connector is actually callable in the current ChatGPT session.
- If another chat says `console-mcp` is not exposed, that does not mean the tunnel or local server is down. It means that specific conversation does not have the connector injected.

## Tail logs

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 tail-http-trace
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 tail-oauth-debug
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 tail-server-log
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 tail-tunnel-log
```

## Inspect traces after a connector failure

1. Check `var/transcript/oauth-debug.ndjson`.
2. Check `var/transcript/http-trace.ndjson`.
3. Check `var/log/cloudflared-console-mcp.log`.
4. Check `var/log/console-mcp-chatgpt-oauth.log`.
5. Re-run `smoke-public`.
6. Run `doctor-json` for a sanitized snapshot.

## Restore note

The repo is portable. User-level config stays in `C:\Users\Admin\.codex\config.toml` and Cloudflare files stay under `C:\Users\Admin\.cloudflared\`.

Default workspace root used by the supervisor:

- `D:\PhpstormProjects\www`

Optional override:

- `CONSOLE_MCP_WORKSPACE_ROOT=<absolute workspace path>`

See also `docs/bootstrap-windows.md` and `docs/restore-windows.md`.
