# Security

`console-mcp` is intentionally read-mostly. The only write path is the controlled patch tool `console.apply_patch`.

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
- `var/transcript/*-apply-patch-*.json`

These paths are local-only and ignored by Git.

## Safe logging

- HTTP traces record request shape and status only.
- OAuth debug logs record only non-sensitive JWT metadata.
- Patch transcripts record patch metadata, validation results, and git apply outcomes, not shell commands.
- No raw Authorization header is logged.
- No bearer token material is logged.
- No OAuth code or refresh token is logged.

## Controlled write rules

- `console.apply_patch` only accepts unified diff input.
- It rejects absolute paths, `../` traversal, binary patches, rename/copy patches, and writes outside the selected workspace.
- It rejects mutations to `.git/`, `vendor/`, `node_modules/`, `var/cache/`, `var/log/`, `dist/`, `build/`, and `coverage/`.
- The tool performs a `git apply --check` pass before any write.
- The tool never exposes arbitrary shell execution, commit, reset, or command-argument passthrough.

## Restore rule

If a file contains a secret or credential, keep it out of Git and out of exported docs.
