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
