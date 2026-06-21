# Codex Local Bearer

This is the local-only Codex profile for `console-mcp`.

## Target

- Local endpoint: `http://127.0.0.1:3334/mcp`
- Auth mode: `bearer`
- Binding: `127.0.0.1` only
- Auth variable: `CONSOLE_MCP_BEARER_TOKEN`

## Codex config

Add this to `C:\Users\Admin\.codex\config.toml`:

```toml
[mcp_servers.console-mcp]
url = "http://127.0.0.1:3334/mcp"
bearer_token_env_var = "CONSOLE_MCP_BEARER_TOKEN"
```

## Environment

Use a long random token and keep it in the shell, not in Git:

```powershell
$env:CONSOLE_MCP_BEARER_TOKEN = "replace-with-a-long-random-token"
```

## Start

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 start-codex-bearer
```

## Smoke

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tool\dev-console.ps1 smoke-local-codex
```

## Security

- Do not expose the bearer server through Cloudflare Tunnel.
- Do not reuse the bearer token in docs, logs, or scripts.
- Do not commit the actual token.
