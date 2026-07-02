# Security

`console-mcp` is intentionally read-mostly. Mutating operations are exposed only through guarded write tools and canonical `console.write.*` aliases.

Legacy public tool names are no longer part of the active runtime surface. Tools use the fixed canonical `console.<risk>...` form, where the second token is always `read_` or `write`.

Read aliases are expected to use read-only registration. A small number of existing read aliases are temporarily marked in policy with `allowMutationRegistration=true` when they still share a legacy guarded registration path.

The catalog validator checks policy fragments, registered canonical aliases, `src/tool/catalog.ts`, and read/write registration boundaries during regression.

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

- Patch writes go through `console.write.repo.patch.apply`.
- Text replacement writes go through `console.write.repo.file.replace.text`.
- Signed commits go through `console.write.repo.git.commit.signed`; the git path uses `git commit -S` and no unsigned fallback is provided.
- Symfony maintenance writes go through guarded cache/var maintenance aliases.
- Package and runtime restart writes are allowlisted and registered as mutation tools.
- RC repair writes go through `console.write.release.rc.repair` and preserve the explicit `repairApplyApproved=true` approval gate before apply.
- Patch tools only accept unified diff input and perform a `git apply --check` pass before any write.
- Patch tools enforce workspace-root and denied-path boundaries.
- Write tools do not expose unbounded command passthrough.
- Commit, push, and PR policies remain disabled unless explicitly enabled by the caller.

## Restore rule

If a file contains a secret or credential, keep it out of Git and out of exported docs.
