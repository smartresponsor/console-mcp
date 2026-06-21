# Cloudflare Tunnel

The tunnel exposes only the ChatGPT OAuth server on port 3333.

## Preferred binary location

Use this first when present:

`C:\Tools\cloudflared\cloudflared.exe`

Supervisor resolution order:

1. `CONSOLE_MCP_CLOUDFLARED_BIN`
2. `C:\Tools\cloudflared\cloudflared.exe`
3. `cloudflared.exe` from `PATH`
4. fail closed

Do not use `%TEMP%\cloudflared.exe`; it is not a stable runtime location.

If you want to pin a custom path, set `CONSOLE_MCP_CLOUDFLARED_BIN` in your local shell.

## Example config

See `ops/cloudflared/console-mcp.example.yml`.
That file is a template only and uses placeholders.

## Local config files

These stay outside Git:

- `C:\Users\<USER>\.cloudflared\console-mcp.yml`
- `C:\Users\<USER>\.cloudflared\<TUNNEL_ID>.json`

The repo does not store tunnel credential JSON.

## Start

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-tunnel
```

## Smoke

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

## Notes

- The tunnel should forward `console-mcp.smartresponsor.com` to `http://127.0.0.1:3333`.
- Do not point the public tunnel at the Codex bearer server on 3334.
- Do not store tunnel credential contents in the repo.
- If `cloudflared.exe` is missing, run `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-cloudflared`.
