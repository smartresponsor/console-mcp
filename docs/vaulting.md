# console-mcp Vaulting Integration

console-mcp declares sensitive runtime values by reference only.

## Declaration files

```text
config/secret/secret.required.json
config/secret/secret.map.example.json
```

These files do not contain resolved values.

## Vaulting owner

Vaulting owns value resolution and child-process runtime delivery.

console-mcp owns only the list of sensitive runtime references it consumes.

## Runtime boundary

console-mcp reads environment variables at process start. Vaulting injects resolved values into the child process only.

```text
Vaulting secret-run.ps1
  -> temporary child-process environment variables
  -> console-mcp runtime
```

## Required reference

```text
CONSOLE_MCP_BEARER_TOKEN=/secret/dev/console-mcp/bearer-token
```

The bearer token protects the local Codex bearer profile and must not be committed, logged, pasted into chat, or placed in docs.

## Optional reference

```text
CLOUDFLARE_API_TOKEN=/secret/dev/cloudflare/api-token
```

This reference is required only for paths that call Cloudflare AI Gateway through the ask tool.

## Non-secret runtime configuration

The following values are runtime configuration and are not declared as secrets in the first Vaulting pass:

```text
CONSOLE_MCP_AUTH_MODE
CONSOLE_MCP_PUBLIC_ORIGIN
CONSOLE_MCP_OAUTH_ISSUER
CONSOLE_MCP_OAUTH_AUDIENCE
CONSOLE_MCP_OAUTH_READ_SCOPE
CONSOLE_MCP_OAUTH_WRITE_SCOPE
CONSOLE_MCP_OAUTH_JWKS_URI
CONSOLE_MCP_HOST
CONSOLE_MCP_PORT
CONSOLE_MCP_WORKSPACE_ROOT
CONSOLE_MCP_EXTRA_ALLOWED_ROOTS
CONSOLE_ASK_ENDPOINT
CLOUDFLARE_ACCOUNT_ID
```
