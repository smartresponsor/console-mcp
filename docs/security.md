# Security

`console-mcp` is intentionally read-only.

## Never commit

- bearer tokens
- OAuth access tokens
- client secrets
- authorization codes
- refresh tokens
- raw `Authorization` headers
- tunnel credential JSON contents
- local auth config values

## User/system files outside Git

- `C:\Users\Admin\.codex\config.toml`
- `C:\Users\Admin\.codex\auth.json`
- `C:\Users\Admin\.cloudflared\console-mcp.yml`
- `C:\Users\Admin\.cloudflared\<TUNNEL_ID>.json`
- `C:\Tools\cloudflared\cloudflared.exe`

## Runtime files

- `var/run/`
- `var/log/`
- `var/transcript/http-trace.ndjson`
- `var/transcript/oauth-debug.ndjson`

These paths are local-only and ignored by Git.

## Safe logging

- HTTP traces record request shape and status only.
- OAuth debug logs record only non-sensitive JWT metadata.
- No raw Authorization header is logged.
- No bearer token material is logged.
- No OAuth code or refresh token is logged.

## Restore rule

If a file contains a secret or credential, keep it out of Git and out of exported docs.
