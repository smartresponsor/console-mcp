# console-mcp

Minimal standalone MCP server for controlled PowerShell-backed workspace access.

It does not integrate with model providers. It only exposes a small execution membrane over MCP.

## Transport

The server uses **Streamable HTTP** and listens on `http://127.0.0.1:3333/mcp` by default.

## Authentication modes

The server supports two auth modes controlled by `CONSOLE_MCP_AUTH_MODE`:

- `bearer` - default, Codex CLI-compatible static bearer token
- `oauth` - protected resource mode for ChatGPT UI OAuth discovery and JWT validation

Bearer mode requires `CONSOLE_MCP_BEARER_TOKEN`.

OAuth mode requires:

- `CONSOLE_MCP_PUBLIC_ORIGIN`
- `CONSOLE_MCP_OAUTH_ISSUER`
- `CONSOLE_MCP_OAUTH_AUDIENCE`

Optional OAuth settings:

- `CONSOLE_MCP_OAUTH_REQUIRED_SCOPE` - defaults to `console:read`
- `CONSOLE_MCP_OAUTH_JWKS_URI` - override JWKS discovery when needed

Diagnostics:

- `CONSOLE_MCP_TRACE=1` writes sanitized HTTP request traces to `var/transcript/http-trace.ndjson`
- `CONSOLE_MCP_OAUTH_DEBUG=1` writes sanitized OAuth verification traces to `var/transcript/oauth-debug.ndjson`

## Start

```powershell
cd D:\PhpstormProjects\www\console-mcp
npm install
npm run build
$env:CONSOLE_MCP_BEARER_TOKEN = "replace-with-a-long-random-token"
npm run start
```

If `CONSOLE_MCP_BEARER_TOKEN` is missing, the server refuses to start.

You can override the host and port:

```powershell
$env:CONSOLE_MCP_HOST = "127.0.0.1"
$env:CONSOLE_MCP_PORT = "3333"
npm run start
```

OAuth mode example:

```powershell
$env:CONSOLE_MCP_AUTH_MODE = "oauth"
$env:CONSOLE_MCP_PUBLIC_ORIGIN = "https://console-mcp.example.com"
$env:CONSOLE_MCP_OAUTH_ISSUER = "https://issuer.example.com"
$env:CONSOLE_MCP_OAUTH_AUDIENCE = "https://console-mcp.example.com"
$env:CONSOLE_MCP_OAUTH_REQUIRED_SCOPE = "console:read"
$env:CONSOLE_MCP_OAUTH_JWKS_URI = "https://issuer.example.com/.well-known/jwks.json"
npm run start
```

In OAuth mode the server exposes:

- `GET /.well-known/oauth-protected-resource`
- `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource", scope="console:read"` on `401`
- the metadata endpoint is public and returns `resource`, `authorization_servers`, `scopes_supported`, and `bearer_methods_supported`

## MCP client configuration for Codex CLI

Add a local MCP server entry to `C:\Users\Admin\.codex\config.toml`:

```toml
[mcp_servers.console-mcp]
url = "http://127.0.0.1:3333/mcp"
bearer_token_env_var = "CONSOLE_MCP_BEARER_TOKEN"
```

With bearer auth enabled, requests without `Authorization: Bearer <token>` return `401`.
Valid requests continue to expose the existing read-only tools only.

## Local verification

```powershell
$env:CONSOLE_MCP_BEARER_TOKEN = "replace-with-a-long-random-token"
npm run build
npm run smoke
```

OAuth verification:

```powershell
npm run smoke:oauth
```

Expected HTTP checks:

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:3333/mcp
curl.exe -sS -o NUL -w "%{http_code}`n" -H "Authorization: Bearer wrong" http://127.0.0.1:3333/mcp
curl.exe -sS -o NUL -w "%{http_code}`n" -H "Authorization: Bearer $env:CONSOLE_MCP_BEARER_TOKEN" http://127.0.0.1:3333/mcp
```

If you later expose the server through HTTPS, prefer putting it behind a tunnel or reverse proxy with explicit authentication.

## Available tools

- `console.describe`
- `console.health`
- `console.workspace_status`
- `console.capture_context`
- `console.read_file`
- `console.search_text`
- `console.run_check`

## Policy

The active allow/deny rules live in:

- `policy/allowed-root.json`
- `policy/allowed-check.json`
- `policy/denied-path.json`

RC1 intentionally allows only readonly tooling plus named checks from policy.

## SDK note

The current MCP SDK supports tool `_meta` passthrough, but does not type a dedicated `securitySchemes` field on `registerTool(...)`.
`console-mcp` emits OAuth tool security metadata through `_meta.securitySchemes` in OAuth mode.
