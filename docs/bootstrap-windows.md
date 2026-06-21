# Bootstrap Windows

This is the portable bootstrap path for `console-mcp` on a new Windows machine.

## What lives in Git

- server source code
- `tool/dev-console.ps1`
- docs
- ops templates
- package scripts

## What lives outside Git

- `C:\Users\<USER>\.codex\config.toml`
- `C:\Users\<USER>\.codex\auth.json`
- `C:\Users\<USER>\.codex\cloudflare-pilot.config.toml`
- `C:\Users\<USER>\.cloudflared\console-mcp.yml`
- `C:\Users\<USER>\.cloudflared\<TUNNEL_ID>.json`
- `CONSOLE_MCP_BEARER_TOKEN`
- Auth0 tenant credentials
- ChatGPT connector consent state

## Stable cloudflared locations

Use one of these approaches:

1. `C:\Tools\cloudflared\cloudflared.exe`
2. `cloudflared.exe` on `PATH`
3. `CONSOLE_MCP_CLOUDFLARED_BIN=<absolute path to cloudflared.exe>`

Do not rely on `%TEMP%\cloudflared.exe`.
Do not commit `cloudflared.exe`.
Do not commit tunnel credential JSON.

## Workspace root

Default workspace root used by the supervisor:

- `D:\PhpstormProjects\www`

Optional override:

- `CONSOLE_MCP_WORKSPACE_ROOT=<absolute workspace path>`

## Bootstrap order

1. Install Node.js, PowerShell 7, Git, and cloudflared.
2. Clone the repo.
3. Run `npm install`.
4. Run `npm run build`.
5. Set up Auth0 for the ChatGPT OAuth profile.
6. Set up the local Codex bearer profile.
7. Place tunnel config under `C:\Users\<USER>\.cloudflared\`.
8. Run the supervisor doctor.
9. Start the local stack.
10. Run local and public smoke checks.

## Helpful commands

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-cloudflared
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 status
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

## Recovery

If `smoke-public` fails:

- check `var/log/cloudflared-console-mcp.log`
- check `var/log/console-mcp-chatgpt-oauth.log`
- check `var/transcript/http-trace.ndjson`
- check `var/transcript/oauth-debug.ndjson`
- run `doctor-json`
