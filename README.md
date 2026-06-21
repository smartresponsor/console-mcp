# console-mcp

Portable Windows MCP toolkit for controlled, read-only workspace access.

The server itself remains minimal. This repository now also includes local supervisor scripts, restore notes, and safe auth/runbook documentation for two local profiles:

- ChatGPT UI OAuth profile on `127.0.0.1:3333`
- Codex CLI bearer profile on `127.0.0.1:3334`

## Current transport

- MCP transport: Streamable HTTP
- Local ChatGPT OAuth endpoint: `http://127.0.0.1:3333/mcp`
- Local Codex bearer endpoint: `http://127.0.0.1:3334/mcp`
- Public ChatGPT MCP endpoint: `https://console-mcp.smartresponsor.com/mcp`

## Auth modes

- `oauth` for ChatGPT UI
- `bearer` for Codex CLI

The server code is unchanged. This repo only adds safer local operations, documentation, and restore templates.

## Quick start

```powershell
cd D:\PhpstormProjects\www\console-mcp
npm install
npm run build
```

Start the local ChatGPT OAuth server:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-chatgpt-oauth
```

Start the local Codex bearer server:

```powershell
$env:CONSOLE_MCP_BEARER_TOKEN = "replace-with-a-long-random-token"
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-codex-bearer
```

Start the Cloudflare Tunnel for the public ChatGPT path:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-tunnel
```

Before starting anything, run the doctor:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 doctor
```

## One-command operations

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 status
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 restart-all
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-chatgpt
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-codex
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

Package shortcuts:

```powershell
npm run dev:status
npm run dev:chatgpt
npm run dev:codex
npm run dev:restart-all
npm run smoke:public
npm run smoke:local-chatgpt
npm run smoke:local-codex
npm run dev:task-install
npm run dev:task-uninstall
npm run dev:task-show
npm run dev:shortcuts-create
npm run dev:shortcuts-remove
npm run dev:doctor
npm run dev:doctor-json
npm run dev:check-prereq
npm run dev:check-config
npm run dev:check-cloudflared
```

## Windows automation

- Use `install-startup-task` to register a per-user Task Scheduler entry that runs `restart-all` at logon.
- Use `create-shortcuts` to generate Start Menu shortcuts for ChatGPT OAuth operations.
- Use `show-startup-task` to inspect the current scheduler entry.
- Use `tail-http-trace`, `tail-oauth-debug`, `tail-server-log`, and `tail-tunnel-log` to inspect sanitized traces and logs.
- Use `doctor`, `doctor-json`, `check-prereq`, `check-config`, and `check-cloudflared` for bootstrap diagnostics.

## Codex CLI profile

Add a local MCP server entry to `C:\Users\Admin\.codex\config.toml`:

```toml
[mcp_servers.console-mcp]
url = "http://127.0.0.1:3334/mcp"
bearer_token_env_var = "CONSOLE_MCP_BEARER_TOKEN"
```

## Docs

- [Bootstrap on Windows](docs/bootstrap-windows.md)
- [Architecture](docs/architecture.md)
- [Restore on Windows](docs/restore-windows.md)
- [Security](docs/security.md)
- [ChatGPT OAuth + Auth0](docs/chatgpt-oauth-auth0.md)
- [Codex local bearer](docs/codex-local-bearer.md)
- [Cloudflared tunnel](docs/cloudflared-tunnel.md)
- [Operations](docs/operations.md)

## Security notes

- Never commit secrets, tokens, client secrets, OAuth codes, refresh tokens, or raw `Authorization` headers.
- Runtime traces are sanitized and written to `var/transcript/`.
- Local logs are written to `var/log/`.
- PIDs live under `var/run/`.
- User and system config files stay outside Git.

## Available tools

- `console.describe`
- `console.health`
- `console.workspace_status`
- `console.capture_context`
- `console.read_file`
- `console.search_text`
- `console.run_check`

## Smoke checks

Read-only health checks:

```powershell
npm run smoke
npm run smoke:oauth
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-chatgpt
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-codex
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-public
```

## Cloudflared

Preferred install path:

- `C:\Tools\cloudflared\cloudflared.exe`

Alternatives:

- install `cloudflared.exe` on `PATH`
- set `CONSOLE_MCP_CLOUDFLARED_BIN` to an absolute path

Do not use `%TEMP%\cloudflared.exe`.
The repo does not store cloudflared binaries or tunnel credential JSON.

## Workspace root

Default workspace root used by the supervisor:

- `D:\PhpstormProjects\www`

Optional override:

- `CONSOLE_MCP_WORKSPACE_ROOT=<absolute workspace path>`

## Runtime files

The supervisor uses the following local runtime paths:

- `var/run/`
- `var/log/`
- `var/transcript/http-trace.ndjson`
- `var/transcript/oauth-debug.ndjson`

These files are ignored by Git.
