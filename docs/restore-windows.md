# Restore on Windows

This is the minimal restore path for a new Windows machine.

## 1. Install prerequisites

- Node.js 20+ or current LTS
- PowerShell 7
- Git
- `cloudflared`

Prefer a stable `cloudflared` install:

1. `C:\Tools\cloudflared\cloudflared.exe`
2. `cloudflared.exe` on `PATH`
3. `CONSOLE_MCP_CLOUDFLARED_BIN=<absolute path to cloudflared.exe>`

Do not use `%TEMP%\cloudflared.exe`.

## 2. Clone the repo

```powershell
git clone <repo-url> D:\PhpstormProjects\www\console-mcp
cd D:\PhpstormProjects\www\console-mcp
```

## 3. Install and build

```powershell
npm install
npm run build
```

## 4. Prepare local env templates

Copy the examples from `ops/env/` and fill them locally.

If you want a short bootstrap checklist, use `ops/windows/bootstrap-checklist.md`.

## 5. Configure Auth0

See `docs/chatgpt-oauth-auth0.md` and `ops/auth0/checklist.md`.

## 6. Configure ChatGPT OAuth profile

Use the ChatGPT connector / custom MCP app with:

- public origin: `https://console-mcp.smartresponsor.com`
- resource metadata URL: `https://console-mcp.smartresponsor.com/.well-known/oauth-protected-resource`
- issuer: `https://dev-zdyugcgamq4bca8f.us.auth0.com/`
- audience: `https://console-mcp.smartresponsor.com`
- scope: `console:read`

## 7. Configure the local Codex bearer profile

Add this to `C:\Users\Admin\.codex\config.toml`:

```toml
[mcp_servers.console-mcp]
url = "http://127.0.0.1:3334/mcp"
bearer_token_env_var = "CONSOLE_MCP_BEARER_TOKEN"
```

Set `CONSOLE_MCP_BEARER_TOKEN` in the shell before using the local bearer profile.

Default workspace root:

- `D:\PhpstormProjects\www`

Optional override:

- `CONSOLE_MCP_WORKSPACE_ROOT=<absolute workspace path>`

## 8. Configure Cloudflare Tunnel

See `docs/cloudflared-tunnel.md` and `ops/cloudflared/console-mcp.example.yml`.
Tunnel credentials stay under `C:\Users\<USER>\.cloudflared\`.

## 9. Start services

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-chatgpt-oauth
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-codex-bearer
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-tunnel
```

If you want the local stack to come up automatically when you log in, install the startup task:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 install-startup-task
```

If you want Start Menu shortcuts for common actions, generate them after the repo is restored:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 create-shortcuts
```

Before or after starting services, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 check-cloudflared
```

## 10. Smoke-test

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-chatgpt
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-codex
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

## 11. Restore signals

If `smoke-public` fails:

- check `var/log/cloudflared-console-mcp.log`
- check `var/log/console-mcp-chatgpt-oauth.log`
- inspect `var/transcript/http-trace.ndjson`
- inspect `var/transcript/oauth-debug.ndjson`
- run `doctor-json`

## 12. Remove local automation

To remove the startup task:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 uninstall-startup-task
```

To remove the shortcuts:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 remove-shortcuts
```

## 13. Recreate on another machine

Copy only the repo and the documented user-level configs. Do not copy secrets into Git.

See also `docs/bootstrap-windows.md`.
