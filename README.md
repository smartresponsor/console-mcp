# console-mcp

Portable Windows MCP toolkit for controlled workspace access.

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

## Port authority

- `3333` is the legal ChatGPT OAuth port and the only port for the public Cloudflare Tunnel.
- `3334` is the legal local Codex bearer port.
- `3334` is not a temporary drift port, but it is forbidden for ChatGPT connector diagnostics and public exposure.
- ChatGPT connector issues must be diagnosed through the `3333` OAuth/public path.
- ChatGPT browser capture uses DevTools HTTP ports such as `9222` or `9223`, never `3333` or `3334`.
- Codex CLI issues must be diagnosed through the `3334` bearer path.

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
- Mutating tools are registered with write-scope metadata and guarded handlers.
- Read/write canonical aliases are checked by `tool/validate-console-tool-catalog.mjs` during regression.

## Available tools

Legacy public names remain active for connector compatibility. Canonical aliases are registered beside legacy names and follow the fixed `console.<risk>...` form.

The runtime catalog is generated in `src/tool/catalog.ts`. Policy fragments under `policy/console-tool-catalog-*.json` define the canonical names, legacy names, risk class, domain, technology, and any temporary registration exceptions.

`npm run test` runs `tool/validate-console-tool-catalog.mjs`, which checks that every policy canonical name is registered, every registered canonical name exists in policy, and write aliases use mutation registration.

- `console.describe`
- `console.health`
- `console.workspace_status`
- `console.capture_context`
- `console.read_file`
- `console.search_text`
- `console.run_check`
- `console.apply_patch`

## Controlled write workflow

Mutation tools are guarded and allowlisted. `console.apply_patch` and `console.write.repo.patch.apply` accept a unified diff, enforce workspace-root and path safety checks, and reject unbounded command passthrough.

In OAuth mode, the connector advertises `console:read` for read-only tools and `console:write` for mutation tools.
The first OAuth challenge now asks for both scopes so ChatGPT can see write tools in the same session.

Recommended workflow:

1. AI analyzes the issue using the read-only tools.
2. AI proposes the exact fix in chat.
3. User explicitly approves the fix.
4. AI calls `console.apply_patch` with `dryRun=true` and the unified diff.
5. If the dry run is applicable, AI calls `console.apply_patch` again with `dryRun=false`.
6. AI runs `console.run_check` with safe checks such as cache clear, `git diff --stat`, or test commands already allowed in policy.

For RC repair, actual apply remains blocked unless `repairApplyApproved=true` is explicitly provided. Commit, push, and PR policies remain disabled unless explicitly enabled.

`console.apply_patch` refuses absolute paths, traversal, binary patches, deletes in the MVP implementation, and changes outside the selected workspace.
If you change API scopes in Auth0, revoke the user's authorized application or refresh token and reconnect so ChatGPT receives a fresh grant.

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
