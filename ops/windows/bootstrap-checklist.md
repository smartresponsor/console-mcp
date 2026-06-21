# Bootstrap Checklist

Use this when preparing `console-mcp` on a new Windows machine.

## Prerequisites

- Node.js 20+ or current LTS
- PowerShell 7
- Git
- `cloudflared`

## Stable Cloudflared options

Preferred install location:

- `C:\Tools\cloudflared\cloudflared.exe`

Alternative:

- add `cloudflared.exe` to `PATH`

Fallback:

- set `CONSOLE_MCP_CLOUDFLARED_BIN=<absolute path to cloudflared.exe>`

Do not use `%TEMP%\cloudflared.exe` as a runtime location.

## Local-only files

- `C:\Users\<USER>\.codex\config.toml`
- `C:\Users\<USER>\.codex\auth.json`
- `C:\Users\<USER>\.cloudflared\console-mcp.yml`
- `C:\Users\<USER>\.cloudflared\<TUNNEL_ID>.json`

Do not commit those files.

## Tasks

1. Clone the repo.
2. Run `npm install`.
3. Run `npm run build`.
4. Confirm the workspace root:
   - default: `D:\PhpstormProjects\www`
   - override: `CONSOLE_MCP_WORKSPACE_ROOT=<absolute workspace path>`
5. Configure Auth0 and ChatGPT OAuth if using the public MCP connector.
6. Configure the Codex bearer profile if using local Codex.
7. Install or locate `cloudflared`.
8. Run `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor`.
9. Run `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 status`.
