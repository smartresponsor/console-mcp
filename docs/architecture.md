# Architecture

`console-mcp` is a portable Windows execution membrane for read-only MCP access.

It is intentionally small:

- no model providers
- no write or patch tools
- no arbitrary shell execution tool
- no remote process-control tool

## Current contour

### ChatGPT UI path

- Auth mode: `oauth`
- Local bind: `127.0.0.1:3333`
- Public origin: `https://console-mcp.smartresponsor.com`
- Public MCP endpoint: `https://console-mcp.smartresponsor.com/mcp`
- OAuth issuer: `https://dev-zdyugcgamq4bca8f.us.auth0.com/`
- Audience / resource: `https://console-mcp.smartresponsor.com`
- Scope: `console:read`
- Exposure: Cloudflare Tunnel

### Codex CLI path

- Auth mode: `bearer`
- Local bind: `127.0.0.1:3334`
- Exposure: localhost only
- Auth: `CONSOLE_MCP_BEARER_TOKEN`

## What is in Git

- server source under `src/`
- local supervisor under `tool/dev-console.ps1`
- smoke tests under `tool/`
- policy JSON under `policy/`
- docs under `docs/`
- ops templates under `ops/`
- package scripts, TypeScript config, README, and examples

## What stays outside Git

- `C:\Users\Admin\.codex\config.toml`
- `C:\Users\Admin\.codex\auth.json`
- `C:\Users\Admin\.cloudflared\console-mcp.yml`
- `C:\Users\Admin\.cloudflared\<TUNNEL_ID>.json`
- `C:\Tools\cloudflared\cloudflared.exe`
- bearer tokens, OAuth access tokens, client secrets, refresh tokens, codes

## Runtime flow

1. ChatGPT UI connects to the public MCP endpoint.
2. The public endpoint is protected by OAuth resource metadata and JWT validation.
3. Cloudflare Tunnel forwards the public hostname to the local ChatGPT OAuth server on port 3333.
4. Codex CLI connects locally to the bearer server on port 3334.
5. Both servers expose the same read-only tool surface.

## Logs and traces

- `var/run/` contains pid files.
- `var/log/` contains supervisor logs.
- `var/transcript/http-trace.ndjson` contains sanitized HTTP traces.
- `var/transcript/oauth-debug.ndjson` contains sanitized OAuth verification traces.

## Restore boundary

The repo is the portable part. User-level files and tunnel credentials are not committed and must be recreated or copied into the Windows profile on restore.
